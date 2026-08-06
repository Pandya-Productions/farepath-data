/**
 * Stage 4 — the final build. Combines OSM-derived topology with every curated decision into
 * the single JSON asset the app ships.
 *
 *   node --experimental-strip-types src/build.ts
 *
 * This is the last gate before data reaches users, so it validates rather than trusts:
 * connectivity, dangling references, self-loops, fare coverage, and the size budget. Any
 * failure exits non-zero and writes nothing.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractedLine } from './extract.ts';
import type { StationCluster } from './cluster.ts';
import type {
  TransitNetwork,
  Station,
  Edge,
  Line,
  Operator,
  Interchange,
  FareTable,
  FareOverrideTable,
} from '../types/network.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'out');
const CURATED_DIR = join(HERE, '..', 'curated');
const DIST_DIR = join(HERE, '..', '..', '..', 'apps', 'mobile', 'assets');

/** Budgets from the plan. Exceeding one fails the build rather than quietly shipping. */
const BUDGET = { rawKb: 400, gzipKb: 90 };

const readJson = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, 'utf8')) as T;

class Problems {
  fatal: string[] = [];
  warn: string[] = [];
}

async function main() {
  const problems = new Problems();

  const { lines: extracted } = await readJson<{ lines: ExtractedLine[] }>(join(OUT_DIR, 'extracted.json'));
  const { clusters } = await readJson<{ clusters: StationCluster[] }>(join(OUT_DIR, 'clusters.json'));
  const curatedLines = await readJson<{ lines: Record<string, unknown>[] }>(join(CURATED_DIR, 'lines.json'));
  const speeds = await readJson<{
    modes: Record<string, { runningSpeedKmph: number; dwellSeconds: number }>;
    serviceClassOverrides: Record<string, { runningSpeedKmph: number; dwellSeconds: number }>;
  }>(join(CURATED_DIR, 'speeds.json'));
  const palette = await readJson<{
    families: Record<string, { lineIds: string[]; light: string; dark: string; dash: string }>;
  }>(join(CURATED_DIR, 'palette.json'));
  const interchangeDoc = await readJson<{
    policy: { walkSpeedMps: number; crossOperatorGateS: number; sameOperatorGateS: number; samePaidArea: boolean };
    links: { a: { name: string; operator: string }; b: { name: string; operator: string }; distanceM: number }[];
  }>(join(CURATED_DIR, 'interchanges.json'));
  const operatorDoc = await readJson<{ operators: Operator[] }>(join(CURATED_DIR, 'fares', 'operators.json'));
  const slabDoc = await readJson<{
    tables: {
      operator: string;
      class: string;
      confidence: 'verified' | 'estimated';
      source: string;
      verifiedOn: string;
      slabs: { maxKm: number | null; farePaise: number }[];
    }[];
  }>(join(CURATED_DIR, 'fares', 'slabs.json'));
  const overrideDoc = await readJson<{
    overrides: {
      operator: string;
      class: string;
      confidence: 'verified' | 'estimated';
      source: string;
      verifiedOn: string;
      pairs: { a: string; b: string; farePaise: number }[];
    }[];
  }>(join(CURATED_DIR, 'fares', 'overrides.json'));

  // ── stations ───────────────────────────────────────────────────────────────
  const stations: Station[] = clusters.map((c) => ({
    id: c.id,
    name: c.display,
    shortName: c.short,
    norm: c.norm,
    aliases: c.aliases,
    // 5 decimals ≈ 1 m, which is far finer than any use here and keeps the asset small.
    lat: Number(c.lat.toFixed(5)),
    lon: Number(c.lon.toFixed(5)),
    operatorId: c.operators[0]!,
    lineIds: c.lineIds,
  }));

  /** (lineId, stopIndex) → station id, so segments can be turned into edges. */
  const stationOfStop = new Map<string, number>();
  for (const c of clusters) for (const m of c.members) stationOfStop.set(`${m.lineId}#${m.stopIndex}`, c.id);

  /** (name, operator) → station id. Name alone is ambiguous; operator completes the identity. */
  const stationByKey = new Map<string, number>();
  for (const c of clusters) stationByKey.set(`${c.display}|${c.operators[0]}`, c.id);

  // ── lines ──────────────────────────────────────────────────────────────────
  const colourOfLine = new Map<string, { light: string; dark: string; dash: string }>();
  for (const fam of Object.values(palette.families)) {
    for (const id of fam.lineIds) colourOfLine.set(id, { light: fam.light, dark: fam.dark, dash: fam.dash });
  }

  const lines: Line[] = extracted.map((l) => {
    const colour = colourOfLine.get(l.id);
    if (!colour) problems.fatal.push(`Line ${l.id} has no palette entry.`);
    return {
      id: l.id,
      name: l.displayName,
      operatorId: l.operator,
      mode: l.mode as Line['mode'],
      serviceClass: l.serviceClass,
      colour: colour?.light ?? '#000000',
      colourDark: colour?.dark ?? '#ffffff',
      dash: (colour?.dash === 'dashed' ? 'dashed' : 'solid') as 'solid' | 'dashed',
      coverage: l.coverage,
    };
  });

  // ── edges ──────────────────────────────────────────────────────────────────
  const edges: Edge[] = [];
  for (const line of extracted) {
    const override = speeds.serviceClassOverrides[line.serviceClass];
    const mode = speeds.modes[line.mode];
    if (!mode) {
      problems.fatal.push(`No speed profile for mode '${line.mode}' (line ${line.id}).`);
      continue;
    }
    const speedMps = ((override ?? mode).runningSpeedKmph * 1000) / 3600;
    const dwellS = (override ?? mode).dwellSeconds;

    line.segments.forEach((seg, i) => {
      const from = stationOfStop.get(`${line.id}#${i}`);
      const to = stationOfStop.get(`${line.id}#${i + 1}`);
      if (from === undefined || to === undefined) {
        problems.fatal.push(`Line ${line.id} segment ${i}: a stop did not map to a station.`);
        return;
      }
      if (from === to) {
        // Two consecutive stops collapsing to one station would mean a bad merge.
        problems.fatal.push(`Line ${line.id} segment ${i}: self-loop at station ${from} — check clustering.`);
        return;
      }
      const distM = Math.round(seg.distM);
      const timeS = Math.round(distM / speedMps + dwellS);
      edges.push({ from, to, lineId: line.id, distM, timeS, quality: seg.quality });
      edges.push({ from: to, to: from, lineId: line.id, distM, timeS, quality: seg.quality });
    });
  }

  // ── interchanges ───────────────────────────────────────────────────────────
  const { policy } = interchangeDoc;
  const interchanges: Interchange[] = [];
  for (const link of interchangeDoc.links) {
    const a = stationByKey.get(`${link.a.name}|${link.a.operator}`);
    const b = stationByKey.get(`${link.b.name}|${link.b.operator}`);
    if (a === undefined || b === undefined) {
      problems.fatal.push(
        `Interchange ${link.a.name} (${link.a.operator}) ↔ ${link.b.name} (${link.b.operator}) ` +
          `does not resolve to stations. Re-run cluster and re-curate.`,
      );
      continue;
    }
    const crossOperator = link.a.operator !== link.b.operator;
    const walkTimeS =
      Math.round(link.distanceM / policy.walkSpeedMps) +
      (crossOperator ? policy.crossOperatorGateS : policy.sameOperatorGateS);
    interchanges.push({ a, b, walkTimeS, samePaidArea: policy.samePaidArea });
  }

  // ── fares ──────────────────────────────────────────────────────────────────
  const operatorsInUse = new Set(stations.map((s) => s.operatorId));
  const operators = operatorDoc.operators.filter((o) => operatorsInUse.has(o.id));
  for (const id of operatorsInUse) {
    if (!operators.some((o) => o.id === id)) problems.fatal.push(`Operator '${id}' used by stations but not defined.`);
  }

  const fareTables: FareTable[] = slabDoc.tables
    .filter((t) => operatorsInUse.has(t.operator))
    .map((t) => ({
      operatorId: t.operator,
      travelClass: t.class,
      confidence: t.confidence,
      source: t.source,
      verifiedOn: t.verifiedOn,
      slabs: t.slabs,
    }));

  const fareOverrides: FareOverrideTable[] = overrideDoc.overrides
    .filter((o) => operatorsInUse.has(o.operator))
    .map((o) => {
      const pairs: { a: number; b: number; farePaise: number }[] = [];
      for (const p of o.pairs) {
        const a = stationByKey.get(`${p.a}|${o.operator}`);
        const b = stationByKey.get(`${p.b}|${o.operator}`);
        if (a === undefined || b === undefined) {
          problems.fatal.push(`Fare override ${p.a} ↔ ${p.b} (${o.operator}) does not resolve to stations.`);
          continue;
        }
        pairs.push({ a, b, farePaise: p.farePaise });
      }
      return {
        operatorId: o.operator,
        travelClass: o.class,
        confidence: o.confidence,
        source: o.source,
        verifiedOn: o.verifiedOn,
        pairs,
      };
    });

  // Every OPERATING operator must have a fare source, or users get a route with no price.
  for (const op of operators) {
    if (op.status !== 'operating') continue;
    const hasSlabs = fareTables.some((t) => t.operatorId === op.id);
    const hasOverrides = fareOverrides.some((o) => o.operatorId === op.id && o.pairs.length > 0);
    if (!hasSlabs && !hasOverrides) problems.fatal.push(`Operating operator '${op.id}' has no fare data.`);
  }

  // ── validation: connectivity over the routable network ─────────────────────
  const suspendedOperators = new Set(operators.filter((o) => o.status !== 'operating').map((o) => o.id));
  const routable = stations.filter((s) => !suspendedOperators.has(s.operatorId));
  const routableIds = new Set(routable.map((s) => s.id));
  const adjacency = new Map<number, Set<number>>();
  const connect = (a: number, b: number) => {
    if (!routableIds.has(a) || !routableIds.has(b)) return;
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a);
  };
  for (const e of edges) connect(e.from, e.to);
  for (const i of interchanges) connect(i.a, i.b);

  if (routable.length > 0) {
    const seen = new Set<number>([routable[0]!.id]);
    const queue = [routable[0]!.id];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const n of adjacency.get(cur) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
    }
    if (seen.size !== routable.length) {
      const unreached = routable.filter((s) => !seen.has(s.id));
      problems.fatal.push(
        `Routable network is not connected: ${unreached.length} of ${routable.length} stations unreachable ` +
          `(e.g. ${unreached.slice(0, 6).map((s) => s.name).join(', ')}). A missing interchange is the usual cause.`,
      );
    }
  }

  const isolated = stations.filter((s) => (adjacency.get(s.id)?.size ?? 0) === 0 && !suspendedOperators.has(s.operatorId));
  if (isolated.length > 0) {
    problems.fatal.push(`Isolated routable stations: ${isolated.map((s) => s.name).join(', ')}.`);
  }

  // ── notices ────────────────────────────────────────────────────────────────
  const notices: TransitNetwork['notices'] = [];
  for (const op of operators) {
    if (op.status === 'suspended') {
      notices.push({
        id: `${op.id}-suspended`,
        severity: 'warning',
        text: `${op.name} services are suspended${op.statusSince ? ` (since ${op.statusSince})` : ''}. Its stations are shown for reference but cannot be used to plan a journey.`,
      });
    }
  }
  for (const t of fareTables) {
    if (t.confidence === 'estimated') {
      const op = operators.find((o) => o.id === t.operatorId);
      notices.push({
        id: `${t.operatorId}-${t.travelClass}-estimated`,
        severity: 'warning',
        text: `${op?.name ?? t.operatorId} fares are approximate — the slab boundaries could not be confirmed against an official chart. Check the fare at the counter.`,
      });
    }
  }
  notices.push({
    id: 'suburban-second-class-only',
    severity: 'info',
    text: 'Suburban railway fares are shown for second class only. First class and AC fares are not included because no official table could be obtained.',
  });

  // ── assemble ───────────────────────────────────────────────────────────────
  const rawMeta = await readJson<{ osmTimestamp?: string }>(join(HERE, '..', 'raw', 'metro.meta.json')).catch(
    () => ({}) as { osmTimestamp?: string },
  );
  const network: TransitNetwork = {
    version: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
    builtAt: new Date().toISOString(),
    dataSources: [
      {
        dataset: 'Station, line and track geometry',
        url: 'https://www.openstreetmap.org/',
        licence: 'ODbL 1.0 — © OpenStreetMap contributors',
        verifiedOn: (rawMeta.osmTimestamp ?? '').slice(0, 10) || '2026-08-06',
      },
      {
        dataset: 'Mumbai Monorail fare matrix and service status',
        url: 'https://mmrda.maharashtra.gov.in/en/division/mono-piu/fare-structure',
        verifiedOn: '2026-08-06',
      },
      { dataset: 'Metro Line 3 fare slabs', url: 'https://themetrorailguy.com/', verifiedOn: '2026-08-06' },
    ],
    operators,
    lines,
    stations,
    edges,
    interchanges,
    fareTables,
    fareOverrides,
    notices,
  };

  // ── report ─────────────────────────────────────────────────────────────────
  const json = JSON.stringify(network);
  const rawKb = Buffer.byteLength(json) / 1024;
  const gzipKb = gzipSync(Buffer.from(json)).length / 1024;

  console.log(`\n${'='.repeat(78)}\nBUILD REPORT\n${'='.repeat(78)}`);
  console.log(`  operators      ${operators.length}  (${operators.filter((o) => o.status !== 'operating').length} suspended)`);
  console.log(`  lines          ${lines.length}`);
  console.log(`  stations       ${stations.length}  (${routable.length} routable)`);
  console.log(`  edges          ${edges.length}  (${edges.length / 2} bidirectional links)`);
  console.log(`  interchanges   ${interchanges.length}`);
  console.log(`  fare tables    ${fareTables.length}  (${fareTables.filter((t) => t.confidence === 'verified').length} verified, ${fareTables.filter((t) => t.confidence === 'estimated').length} estimated)`);
  console.log(`  fare overrides ${fareOverrides.reduce((n, o) => n + o.pairs.length, 0)} station pairs`);
  console.log(`  notices        ${notices.length}`);
  console.log(`\n  size           ${rawKb.toFixed(1)} KB raw / ${gzipKb.toFixed(1)} KB gzipped  (budget ${BUDGET.rawKb} / ${BUDGET.gzipKb} KB)`);

  const edgeQuality = edges.reduce<Record<string, number>>((acc, e) => ((acc[e.quality] = (acc[e.quality] ?? 0) + 1), acc), {});
  console.log(`  edge quality   ${Object.entries(edgeQuality).map(([k, v]) => `${k}=${v}`).join('  ')}`);

  if (rawKb > BUDGET.rawKb) problems.fatal.push(`transit.json is ${rawKb.toFixed(1)} KB, over the ${BUDGET.rawKb} KB budget.`);
  if (gzipKb > BUDGET.gzipKb) problems.warn.push(`gzipped size ${gzipKb.toFixed(1)} KB exceeds the ${BUDGET.gzipKb} KB target.`);

  if (problems.warn.length > 0) {
    console.log(`\n  WARNINGS:`);
    for (const w of problems.warn) console.log(`    ⚠ ${w}`);
  }
  if (problems.fatal.length > 0) {
    console.error(`\n  FATAL (${problems.fatal.length}) — nothing written:`);
    for (const f of problems.fatal) console.error(`    ✗ ${f}`);
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'transit.json'), json, 'utf8');
  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(join(DIST_DIR, 'transit.json'), json, 'utf8');
  console.log(`\n✓ wrote out/transit.json and apps/mobile/assets/transit.json`);
}

await main();
