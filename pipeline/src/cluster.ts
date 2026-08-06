/**
 * Stage 3: decide which line-stops are the SAME station, and which are merely near each other.
 *
 * Two distinct relationships, and conflating them is the single most damaging mistake this
 * pipeline could make:
 *
 *   MERGE      — one physical station complex serving several lines (Dadar's Western and
 *                Central platforms). Becomes ONE graph node. Changing trains is free-ish.
 *   INTERCHANGE— two separate stations close enough to walk between (a suburban station and
 *                a nearby metro station). Stays TWO nodes joined by a walk edge with a time
 *                cost.
 *
 * A false merge silently corrupts every route and fare through that station, so merging
 * requires BOTH a normalised-name match AND geographic proximity. Nothing is merged on name
 * alone — Western Line "Naigaon" and Monorail "Naigaon" are 38 km apart.
 *
 * This stage does not invent interchange links. It emits CANDIDATES for human confirmation,
 * because a walk transfer's existence and duration are real-world facts we cannot derive.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineM } from './geometry.ts';
import type { ExtractedLine, ExtractedStop } from './extract.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'out');
const CURATED_DIR = join(HERE, '..', 'curated');

/**
 * Maximum distance between two same-named stops for them to be one station.
 *
 * 250 m is deliberately tight: it comfortably spans a single station complex (platforms and
 * concourses) while excluding a separate station across a road. Widening this is how you
 * accidentally fuse the network — do not raise it without reviewing the merge report.
 */
const MERGE_RADIUS_M = 250;

/**
 * Distance within which two DIFFERENTLY-named stations are proposed as a walk interchange.
 * Generous on purpose: proposing a candidate is free, and a missed interchange means users
 * are shown a worse route than exists. Every candidate still needs human confirmation.
 */
const INTERCHANGE_CANDIDATE_RADIUS_M = 800;

export interface LineStopRef {
  lineId: string;
  operator: string;
  stopIndex: number;
  stop: ExtractedStop;
}

export interface StationCluster {
  id: number;
  display: string;
  short?: string;
  norm: string;
  lat: number;
  lon: number;
  aliases: string[];
  members: LineStopRef[];
  lineIds: string[];
  operators: string[];
  /** Largest pairwise distance between members — a spread-check on the merge. */
  spreadM: number;
}

/** Simple union-find over line-stop indices. */
class DisjointSet {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

export interface ForceMergeGroup {
  norm: string;
  operator: string;
  maxSpreadM: number;
  reason: string;
}

export function clusterStations(
  lines: ExtractedLine[],
  forceMerge: ForceMergeGroup[] = [],
): {
  clusters: StationCluster[];
  refs: LineStopRef[];
  appliedForceMerges: { group: ForceMergeGroup; unioned: number }[];
} {
  const refs: LineStopRef[] = [];
  for (const line of lines) {
    line.stops.forEach((stop, stopIndex) =>
      refs.push({ lineId: line.id, operator: line.operator, stopIndex, stop }),
    );
  }

  const dsu = new DisjointSet(refs.length);

  // Group by normalised name first, then merge only pairs that are ALSO geographically close
  // AND operated by the same operator.
  const byNorm = new Map<string, number[]>();
  refs.forEach((ref, i) => {
    const list = byNorm.get(ref.stop.norm);
    if (list) list.push(i);
    else byNorm.set(ref.stop.norm, [i]);
  });

  for (const indices of byNorm.values()) {
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const i = indices[a]!;
        const j = indices[b]!;
        // Same name + same place but DIFFERENT operator is not one station. Ghatkopar's metro
        // and suburban stations share a name and sit 79 m apart, but they have separate
        // ticketing: you leave one, walk, and enter the other. Merging them would make that
        // transfer instantaneous and free in the time model, understating every journey that
        // uses it. Those pairs fall through to become interchange candidates instead.
        if (refs[i]!.operator !== refs[j]!.operator) continue;
        const d = haversineM(refs[i]!.stop.lat, refs[i]!.stop.lon, refs[j]!.stop.lat, refs[j]!.stop.lon);
        if (d <= MERGE_RADIUS_M) dsu.union(i, j);
      }
    }
  }

  /**
   * Curated exceptions: named station complexes whose platforms are further apart than the
   * global radius allows. Applied as a second, wider pass restricted to one (norm, operator)
   * group at a time — never as a global loosening, which is how unrelated stations get fused.
   */
  const appliedForceMerges: { group: ForceMergeGroup; unioned: number }[] = [];
  for (const group of forceMerge) {
    const indices = (byNorm.get(group.norm) ?? []).filter((i) => refs[i]!.operator === group.operator);
    let unioned = 0;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const i = indices[a]!;
        const j = indices[b]!;
        const d = haversineM(refs[i]!.stop.lat, refs[i]!.stop.lon, refs[j]!.stop.lat, refs[j]!.stop.lon);
        if (d <= group.maxSpreadM && dsu.find(i) !== dsu.find(j)) {
          dsu.union(i, j);
          unioned++;
        }
      }
    }
    appliedForceMerges.push({ group, unioned });
  }

  // Materialise clusters.
  const groups = new Map<number, number[]>();
  refs.forEach((_, i) => {
    const root = dsu.find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });

  const clusters: StationCluster[] = [];
  let nextId = 0;
  for (const indices of groups.values()) {
    const members = indices.map((i) => refs[i]!);

    // Prefer the longest display name as canonical: OSM's fuller variant is usually the
    // official one, and a curated override has already replaced anything misleading.
    const canonical = members.reduce((best, m) =>
      m.stop.display.length > best.stop.display.length ? m : best,
    );

    let spreadM = 0;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        spreadM = Math.max(
          spreadM,
          haversineM(members[a]!.stop.lat, members[a]!.stop.lon, members[b]!.stop.lat, members[b]!.stop.lon),
        );
      }
    }

    clusters.push({
      id: nextId++,
      display: canonical.stop.display,
      short: members.find((m) => m.stop.short)?.stop.short,
      norm: canonical.stop.norm,
      // Centroid, so a merged complex sits between its platforms.
      lat: members.reduce((s, m) => s + m.stop.lat, 0) / members.length,
      lon: members.reduce((s, m) => s + m.stop.lon, 0) / members.length,
      aliases: [...new Set(members.flatMap((m) => m.stop.aliases))],
      members,
      lineIds: [...new Set(members.map((m) => m.lineId))],
      // Derived here rather than by the caller so the single-operator invariant is testable
      // in isolation. After the same-operator merge rule this should always be length 1.
      operators: [...new Set(members.map((m) => m.operator))],
      spreadM,
    });
  }

  return { clusters, refs, appliedForceMerges };
}

export interface InterchangeCandidate {
  aStationId: number;
  bStationId: number;
  aDisplay: string;
  bDisplay: string;
  /** Operator is part of a station's identity: (display, operator) is unique, display alone is not. */
  aOperator: string;
  bOperator: string;
  distanceM: number;
  aLines: string[];
  bLines: string[];
  /** True when the two stations share no line — i.e. a transfer here would actually be useful. */
  connectsDisjointLines: boolean;
}

export function proposeInterchanges(clusters: StationCluster[]): InterchangeCandidate[] {
  const candidates: InterchangeCandidate[] = [];
  for (let a = 0; a < clusters.length; a++) {
    for (let b = a + 1; b < clusters.length; b++) {
      const A = clusters[a]!;
      const B = clusters[b]!;
      const d = haversineM(A.lat, A.lon, B.lat, B.lon);
      if (d > INTERCHANGE_CANDIDATE_RADIUS_M) continue;

      const shared = A.lineIds.some((l) => B.lineIds.includes(l));
      candidates.push({
        aStationId: A.id,
        bStationId: B.id,
        aDisplay: A.display,
        bDisplay: B.display,
        aOperator: A.operators[0]!,
        bOperator: B.operators[0]!,
        distanceM: Math.round(d),
        aLines: A.lineIds,
        bLines: B.lineIds,
        connectsDisjointLines: !shared,
      });
    }
  }
  return candidates.sort((x, y) => x.distanceM - y.distanceM);
}

async function main() {
  const { lines } = JSON.parse(await readFile(join(OUT_DIR, 'extracted.json'), 'utf8')) as {
    lines: ExtractedLine[];
  };
  const overrides = JSON.parse(await readFile(join(CURATED_DIR, 'name-overrides.json'), 'utf8')) as {
    doNotMerge: { names: { norm: string; maxClusterSpreadM: number; reason: string; note?: string }[] };
    forceMerge?: { groups: ForceMergeGroup[] };
  };

  const forceMerge = overrides.forceMerge?.groups ?? [];
  const { clusters, refs, appliedForceMerges } = clusterStations(lines, forceMerge);
  // `operators` is derived inside clusterStations.

  for (const { group, unioned } of appliedForceMerges) {
    if (unioned === 0) {
      // A curated exception that no longer does anything is stale — it should be removed, or
      // it is silently masking a change in the upstream data.
      console.warn(
        `  ⚠ forceMerge '${group.norm}' (${group.operator}) matched nothing. ` +
          `Either the automatic rule now covers it, or the data changed. Review and remove.`,
      );
    } else {
      console.log(`  · forceMerge '${group.norm}' (${group.operator}): joined ${unioned} pair(s) — ${group.reason}`);
    }
  }

  const multi = clusters.filter((c) => c.lineIds.length > 1).sort((a, b) => b.lineIds.length - a.lineIds.length);

  console.log(`\n${'='.repeat(104)}`);
  console.log('CLUSTERING REPORT');
  console.log('='.repeat(104));
  console.log(
    `\n${refs.length} line-stops → ${clusters.length} stations ` +
      `(merge rule: identical normalised name AND within ${MERGE_RADIUS_M} m)\n`,
  );

  console.log(`MERGED STATIONS — ${multi.length} serve more than one line. EVERY ROW NEEDS HUMAN REVIEW:\n`);
  console.log(`  ${'station'.padEnd(38)} ${'spread'.padEnd(8)} ${'ops'.padEnd(4)} lines`);
  console.log(`  ${'-'.repeat(98)}`);
  for (const c of multi) {
    console.log(
      `  ${c.display.slice(0, 38).padEnd(38)} ${`${Math.round(c.spreadM)} m`.padEnd(8)} ` +
        `${String(c.operators.length).padEnd(4)} ${c.lineIds.join(', ')}`,
    );
  }

  // Invariant, not a warning: after the same-operator rule, no station may span operators.
  const crossOperator = multi.filter((c) => c.operators.length > 1);
  if (crossOperator.length > 0) {
    console.error(`\n✗ INVARIANT BROKEN — ${crossOperator.length} station(s) span multiple operators:`);
    for (const c of crossOperator) {
      console.error(`    ${c.display.padEnd(38)} ${c.operators.join(' + ')}  [${c.lineIds.join(', ')}]`);
    }
    process.exit(1);
  }
  console.log(`\n✓ invariant holds: no station spans multiple operators (${clusters.length} stations checked).`);

  const wide = clusters.filter((c) => c.spreadM > MERGE_RADIUS_M * 0.8);
  if (wide.length > 0) {
    console.log(`\n⚠ Merges close to the ${MERGE_RADIUS_M} m limit (${wide.length}) — verify they are one complex:`);
    for (const c of wide) console.log(`    ${c.display.padEnd(38)} spread ${Math.round(c.spreadM)} m`);
  }

  // doNotMerge: assert that no cluster for a guarded name has fused distant places together.
  console.log('\nDO-NOT-MERGE GUARDS:');
  const violations: string[] = [];
  for (const guard of overrides.doNotMerge.names) {
    const matching = clusters.filter((c) => c.norm === guard.norm);
    const breached = matching.filter((c) => c.spreadM > guard.maxClusterSpreadM);
    for (const c of breached) {
      violations.push(
        `'${guard.norm}' fused into one station with spread ${Math.round(c.spreadM)} m ` +
          `(limit ${guard.maxClusterSpreadM} m). ${guard.reason}`,
      );
    }
    const status = breached.length > 0 ? '✗' : matching.length === 0 ? '·' : '✓';
    console.log(
      `  ${status} ${guard.norm.padEnd(12)} ${matching.length} station(s), ` +
        `max spread ${Math.round(Math.max(0, ...matching.map((c) => c.spreadM)))} m` +
        (guard.note ? `  — ${guard.note}` : ''),
    );
  }
  if (violations.length > 0) {
    console.error(`\n✗ doNotMerge violations:`);
    for (const v of violations) console.error(`    ${v}`);
    process.exit(1);
  }

  const candidates = proposeInterchanges(clusters).filter((c) => c.connectsDisjointLines);
  console.log(
    `\nINTERCHANGE CANDIDATES — ${candidates.length} pairs of DISTINCT stations within ` +
      `${INTERCHANGE_CANDIDATE_RADIUS_M} m that connect otherwise-separate lines.\n` +
      `These are proposals only. A walk transfer's existence and duration are real-world facts,\n` +
      `so none are used until confirmed in curated/interchanges.json.\n`,
  );
  // Same-name pairs are near-certain interchanges (the operator split above created them),
  // so they are listed first and separately from the merely-nearby ones.
  const sameName = candidates.filter((c) => c.aDisplay === c.bDisplay);
  const differentName = candidates.filter((c) => c.aDisplay !== c.bDisplay);

  console.log(`  A. SAME NAME, different operator — near-certain interchanges (${sameName.length}):`);
  console.log(`  ${'dist'.padEnd(7)} ${'station'.padEnd(38)} lines`);
  console.log(`  ${'-'.repeat(98)}`);
  for (const c of sameName) {
    console.log(
      `  ${`${c.distanceM} m`.padEnd(7)} ${c.aDisplay.slice(0, 38).padEnd(38)} ${c.aLines.join('/')} ↔ ${c.bLines.join('/')}`,
    );
  }

  console.log(`\n  B. DIFFERENT NAME, nearby — each needs individual judgement (${differentName.length}):`);
  console.log(`  ${'dist'.padEnd(7)} ${'station A'.padEnd(30)} ${'station B'.padEnd(30)} lines`);
  console.log(`  ${'-'.repeat(98)}`);
  for (const c of differentName.slice(0, 25)) {
    console.log(
      `  ${`${c.distanceM} m`.padEnd(7)} ${c.aDisplay.slice(0, 30).padEnd(30)} ${c.bDisplay.slice(0, 30).padEnd(30)} ` +
        `${c.aLines.join('/')} ↔ ${c.bLines.join('/')}`,
    );
  }
  if (differentName.length > 25) console.log(`  … and ${differentName.length - 25} more`);

  await writeFile(
    join(OUT_DIR, 'clusters.json'),
    JSON.stringify({ mergeRadiusM: MERGE_RADIUS_M, clusters }, null, 2),
    'utf8',
  );
  await writeFile(
    join(OUT_DIR, 'interchange-candidates.json'),
    JSON.stringify({ radiusM: INTERCHANGE_CANDIDATE_RADIUS_M, candidates }, null, 2),
    'utf8',
  );
  console.log(`\n✓ wrote out/clusters.json and out/interchange-candidates.json`);
}

await main();
