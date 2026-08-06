/**
 * Stage 1.5: human review of what OSM actually gave us.
 *
 *   node --experimental-strip-types src/inspect.ts            # summary of every dataset
 *   node --experimental-strip-types src/inspect.ts --stops=3   # dump ordered stops for a line ref
 *
 * This script makes no decisions. Its whole job is to surface the raw shape of the data —
 * route relations, stop counts, name anomalies — so that `curated/lines.json` is written
 * from evidence rather than from a blog post. Read its output before curating.
 */

import { readCached } from './overpass.ts';
import { OsmIndex, STOP_ROLES, type OsmRelation } from './osm-types.ts';
import { DATASETS } from './queries.ts';

interface RouteSummary {
  id: number;
  ref: string;
  name: string;
  network: string;
  colour: string;
  from: string;
  to: string;
  stopCount: number;
  resolvedStops: number;
  wayCount: number;
}

function summariseRoute(rel: OsmRelation, index: OsmIndex): RouteSummary {
  const tags = rel.tags ?? {};
  const stopMembers = rel.members.filter((m) => STOP_ROLES.has(m.role));
  const resolved = stopMembers.filter((m) => m.type === 'node' && index.nodes.has(m.ref)).length;
  return {
    id: rel.id,
    ref: tags.ref ?? '—',
    name: tags.name ?? '(unnamed)',
    network: tags.network ?? '(no network)',
    colour: tags.colour ?? tags.color ?? '—',
    from: tags.from ?? '—',
    to: tags.to ?? '—',
    stopCount: stopMembers.length,
    resolvedStops: resolved,
    wayCount: rel.members.filter((m) => m.type === 'way').length,
  };
}

function orderedStopNames(rel: OsmRelation, index: OsmIndex): string[] {
  const names: string[] = [];
  for (const member of rel.members) {
    if (!STOP_ROLES.has(member.role)) continue;
    if (member.type !== 'node') {
      names.push(`<${member.type} ${member.ref} — not a node>`);
      continue;
    }
    const node = index.nodes.get(member.ref);
    names.push(node?.tags?.name ?? `<node ${member.ref} — unnamed>`);
  }
  return names;
}

/** Flags names that will need a normalisation rule before they can be matched or displayed. */
function nameAnomalies(names: string[]): string[] {
  const notes: string[] = [];
  for (const name of names) {
    if (/\((?:Line|line)[^)]*\)/.test(name)) notes.push(`${name}  → strip line-disambiguation suffix`);
    else if (/\b(Metro|Railway Station|Junction)\b$/.test(name)) notes.push(`${name}  → strip trailing mode/type word`);
    else if (name.startsWith('<')) notes.push(`${name}  → UNRESOLVED MEMBER`);
  }
  return notes;
}

async function inspectDataset(name: string) {
  const cached = await readCached(name);
  if (!cached) {
    console.log(`\n### ${name}\n  (not fetched — run: npm run fetch)`);
    return;
  }

  const index = new OsmIndex(cached.response);
  const { nodes, ways, relations } = index.counts;

  console.log(`\n${'='.repeat(100)}`);
  console.log(`### ${name}`);
  console.log(`osm data vintage: ${cached.meta.osmTimestamp ?? 'unknown'}   fetched: ${cached.meta.fetchedAt}`);
  console.log(`elements: ${relations} relations, ${ways} ways, ${nodes} nodes`);
  console.log('='.repeat(100));

  const routes = [...index.relations.values()]
    .filter((r) => r.tags?.route)
    .map((r) => summariseRoute(r, index))
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }) || a.name.localeCompare(b.name));

  if (routes.length === 0) {
    console.log('\n  NO ROUTE RELATIONS FOUND.');
    // Fall back to describing what we did get, so the gap is actionable rather than just absent.
    const stationNodes = [...index.nodes.values()].filter(
      (n) => n.tags && (n.tags.railway === 'station' || n.tags.railway === 'halt' || n.tags.station),
    );
    const namedWays = [...index.ways.values()].filter((w) => w.tags?.name);
    console.log(`  Fallback material: ${stationNodes.length} station/halt nodes, ${namedWays.length} named ways.`);
    if (stationNodes.length > 0) {
      console.log('\n  Station-like nodes found (unordered — OSM gives no sequence without a relation):');
      for (const n of stationNodes.sort((a, b) => (a.tags!.name ?? '').localeCompare(b.tags!.name ?? ''))) {
        const t = n.tags!;
        console.log(
          `    ${(t.name ?? '(unnamed)').padEnd(34)} ${n.lat.toFixed(5)},${n.lon.toFixed(5)}` +
            `  railway=${t.railway ?? '—'} station=${t.station ?? '—'}`,
        );
      }
      console.log(
        '\n  → No route relation means no stop ORDER. This line must be curated by hand\n' +
          '    (ordered station list from an official source) with coordinates taken from these nodes.',
      );
    }
    return;
  }

  console.log(`\n  ${routes.length} route relation(s):\n`);
  console.log(
    `  ${'ref'.padEnd(5)} ${'stops'.padEnd(7)} ${'ways'.padEnd(5)} ${'network'.padEnd(24)} ${'colour'.padEnd(9)} name`,
  );
  console.log(`  ${'-'.repeat(96)}`);
  for (const r of routes) {
    const stops = r.resolvedStops === r.stopCount ? `${r.stopCount}` : `${r.resolvedStops}/${r.stopCount}!`;
    console.log(
      `  ${r.ref.padEnd(5)} ${stops.padEnd(7)} ${String(r.wayCount).padEnd(5)} ` +
        `${r.network.slice(0, 24).padEnd(24)} ${r.colour.padEnd(9)} ${r.name.slice(0, 58)}`,
    );
  }

  const zeroStop = routes.filter((r) => r.stopCount === 0);
  if (zeroStop.length > 0) {
    console.log(`\n  ⚠ ${zeroStop.length} relation(s) have NO stop members — unusable for topology:`);
    for (const r of zeroStop) console.log(`      rel/${r.id}  ${r.name}`);
  }

  const unresolved = routes.filter((r) => r.resolvedStops !== r.stopCount);
  if (unresolved.length > 0) {
    console.log(`\n  ⚠ ${unresolved.length} relation(s) have stop members we could not resolve to nodes:`);
    for (const r of unresolved) console.log(`      rel/${r.id}  ${r.name}  (${r.resolvedStops}/${r.stopCount})`);
  }

  // Name anomalies across the whole dataset, deduped.
  const anomalies = new Set<string>();
  for (const rel of index.relations.values()) {
    if (!rel.tags?.route) continue;
    for (const note of nameAnomalies(orderedStopNames(rel, index))) anomalies.add(note);
  }
  if (anomalies.size > 0) {
    console.log(`\n  Station names needing a normalisation rule (${anomalies.size}):`);
    for (const note of [...anomalies].sort()) console.log(`      ${note}`);
  }
}

async function dumpStops(datasetName: string, ref: string) {
  const cached = await readCached(datasetName);
  if (!cached) return;
  const index = new OsmIndex(cached.response);
  for (const rel of index.relations.values()) {
    if (rel.tags?.ref !== ref) continue;
    console.log(`\n--- ${datasetName} rel/${rel.id}: ${rel.tags.name ?? '(unnamed)'} ---`);
    orderedStopNames(rel, index).forEach((name, i) => {
      console.log(`  ${String(i + 1).padStart(3)}. ${name}`);
    });
  }
}

const stopsArg = process.argv.find((a) => a.startsWith('--stops='))?.slice('--stops='.length);

if (stopsArg) {
  for (const dataset of DATASETS) await dumpStops(dataset.name, stopsArg);
} else {
  for (const dataset of DATASETS) await inspectDataset(dataset.name);
  console.log('\nNext: write curated/lines.json from the evidence above (explicit allowlist).');
}
