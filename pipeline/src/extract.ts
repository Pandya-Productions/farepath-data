/**
 * Stage 2: turn raw OSM + curated decisions into a validated per-line model.
 *
 *   node --experimental-strip-types src/extract.ts
 *
 * Everything here is assertion-driven. The pinned relation ids in `curated/lines.json` are
 * checked against their ref, name and stop count, and — where a figure is published —
 * against route length. If OSM changes upstream, this FAILS rather than quietly shipping
 * different distances, because distance is fare.
 *
 * Writes `out/extracted.json` for the clustering stage. Prints a report meant to be read.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCached } from './overpass.ts';
import { OsmIndex, STOP_ROLES, type OsmRelation, type OsmNode } from './osm-types.ts';
import { loadOverrides, resolveName, aliasesFor, type Overrides, type ResolvedName } from './normalize.ts';
import {
  stitchWays,
  measureSegments,
  measureSegmentsAcrossChains,
  orderStopsByGeometry,
  type Segment,
  type SegmentQuality,
} from './geometry.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CURATED_DIR = join(HERE, '..', 'curated');
const OUT_DIR = join(HERE, '..', 'out');

interface CuratedLine {
  id: string;
  dataset: string;
  /** 'curated-order' lines have no OSM route relation; their sequence is hand-curated. */
  source?: 'relation' | 'curated-order';
  relationId?: number;
  assertRef?: string;
  assertNameIncludes?: string;
  /** For curated-order lines: the authoritative station sequence, by OSM name. */
  stationOrder?: string[];
  wayTag?: { key: string; value: string };
  stationTag?: { key: string; value: string };
  assertStops: number;
  /**
   * Official published route length in km, where one exists. Compared as a directional band,
   * not an equality — see the check in extractLine for why.
   */
  publishedRouteLengthKm?: number;
  /** Lower bound as a fraction of published length. Defaults to 0.90. */
  lengthFloorRatio?: number;
  displayName: string;
  operator: string;
  mode: string;
  serviceClass: string;
  coverage: string;
}

export interface ExtractedStop {
  osmNodeId: number;
  display: string;
  short?: string;
  norm: string;
  aliases: string[];
  lat: number;
  lon: number;
  nameSource: ResolvedName['source'];
  rawOsmName?: string;
}

export interface ExtractedLine {
  id: string;
  displayName: string;
  operator: string;
  mode: string;
  serviceClass: string;
  coverage: string;
  osmRelationId: number;
  stops: ExtractedStop[];
  /** segments[i] spans stops[i] → stops[i+1]. */
  segments: Segment[];
  totalM: number;
}

class BuildErrors {
  readonly fatal: string[] = [];
  readonly warnings: string[] = [];
  fail(msg: string) {
    this.fatal.push(msg);
  }
  warn(msg: string) {
    this.warnings.push(msg);
  }
}

/**
 * Extract a line that has no OSM route relation, from a hand-curated station sequence.
 *
 * Used only for the Mumbai Monorail. The curated order is not taken on trust: it must match
 * the set of tagged station nodes exactly — no station missing, none left over — which is
 * what caught a published station list that invented a station and omitted a real one.
 */
function extractCuratedOrder(
  line: CuratedLine,
  index: OsmIndex,
  overrides: Overrides,
  errors: BuildErrors,
): ExtractedLine | null {
  const { stationOrder, wayTag, stationTag } = line;
  if (!stationOrder || !wayTag || !stationTag) {
    errors.fail(`${line.id}: source 'curated-order' requires stationOrder, wayTag and stationTag.`);
    return null;
  }

  const stationNodes = new Map<string, OsmNode>();
  for (const node of index.nodes.values()) {
    if (node.tags?.[stationTag.key] === stationTag.value && node.tags.name) {
      stationNodes.set(node.tags.name, node);
    }
  }

  const missing = stationOrder.filter((name) => !stationNodes.has(name));
  const extra = [...stationNodes.keys()].filter((name) => !stationOrder.includes(name));
  if (missing.length > 0) {
    errors.fail(`${line.id}: curated order names ${missing.length} station(s) absent from OSM: ${missing.join(', ')}.`);
  }
  if (extra.length > 0) {
    errors.fail(
      `${line.id}: OSM has ${extra.length} tagged station(s) missing from the curated order: ${extra.join(', ')}. ` +
        `A station may have opened — verify against the operator before adding it.`,
    );
  }
  if (stationOrder.length !== line.assertStops) {
    errors.fail(`${line.id}: curated order has ${stationOrder.length} stations, expected ${line.assertStops}.`);
  }
  if (missing.length > 0 || extra.length > 0) return null;

  const stops: ExtractedStop[] = [];
  for (const name of stationOrder) {
    const node = stationNodes.get(name)!;
    const resolved = resolveName(node, overrides);
    if (!resolved) {
      errors.fail(`${line.id}: station node ${node.id} ('${name}') has no usable name.`);
      continue;
    }
    stops.push({
      osmNodeId: node.id,
      display: resolved.display,
      short: resolved.short,
      norm: resolved.norm,
      aliases: aliasesFor(resolved.display, overrides),
      lat: node.lat,
      lon: node.lon,
      nameSource: resolved.source,
      rawOsmName: resolved.rawOsmName,
    });
  }

  const wayIds = [...index.ways.values()].filter((w) => w.tags?.[wayTag.key] === wayTag.value).map((w) => w.id);
  const chains = stitchWays(wayIds, index);
  const calibrateTotalM = line.publishedRouteLengthKm != null ? line.publishedRouteLengthKm * 1000 : undefined;
  const { segments, scaleFactor, measuredM, estimatedM } = measureSegmentsAcrossChains(
    stops.map((s) => s.osmNodeId),
    chains,
    index,
    calibrateTotalM,
  );

  if (scaleFactor != null) {
    if (scaleFactor <= 1 || scaleFactor > 2) {
      errors.fail(
        `${line.id}: calibration scale factor ${scaleFactor.toFixed(3)} is implausible ` +
          `(measured ${(measuredM / 1000).toFixed(2)} km along guideway, ${(estimatedM / 1000).toFixed(2)} km ` +
          `straight-line, published ${line.publishedRouteLengthKm} km). A factor ≤1 means the straight-line ` +
          `estimate already exceeds the published length. Investigate the geometry.`,
      );
    } else {
      errors.warn(
        `${line.id}: ${segments.filter((s) => s.quality === 'estimated-gap').length}/${segments.length} segments ` +
          `are calibrated straight-line estimates (× ${scaleFactor.toFixed(3)}), because OSM maps the guideways ` +
          `as disconnected fragments. Fares on this line are approximate.`,
      );
    }
  }

  return {
    id: line.id,
    displayName: line.displayName,
    operator: line.operator,
    mode: line.mode,
    serviceClass: line.serviceClass,
    coverage: line.coverage,
    osmRelationId: 0,
    stops,
    segments,
    totalM: segments.reduce((sum, s) => sum + s.distM, 0),
  };
}

function assertRelation(rel: OsmRelation | undefined, line: CuratedLine, errors: BuildErrors): rel is OsmRelation {
  if (!rel) {
    errors.fail(`${line.id}: OSM relation ${line.relationId} not present in dataset '${line.dataset}'. It may have been deleted or renumbered upstream — re-run inspect and re-pin.`);
    return false;
  }
  const tags = rel.tags ?? {};
  if (line.assertRef !== undefined && tags.ref !== line.assertRef) {
    errors.fail(`${line.id}: rel/${line.relationId} ref is '${tags.ref}', expected '${line.assertRef}'.`);
  }
  if (line.assertNameIncludes !== undefined && !(tags.name ?? '').includes(line.assertNameIncludes)) {
    errors.fail(`${line.id}: rel/${line.relationId} name '${tags.name}' does not contain '${line.assertNameIncludes}'.`);
  }
  const stopCount = rel.members.filter((m) => STOP_ROLES.has(m.role)).length;
  if (stopCount !== line.assertStops) {
    errors.fail(
      `${line.id}: rel/${line.relationId} has ${stopCount} stops, expected ${line.assertStops}. ` +
        `A line may have opened or been re-mapped — verify against the operator, then update assertStops.`,
    );
  }
  return true;
}

function extractLine(
  line: CuratedLine,
  index: OsmIndex,
  overrides: Overrides,
  errors: BuildErrors,
): ExtractedLine | null {
  if (line.relationId === undefined) {
    errors.fail(`${line.id}: relation-sourced line is missing relationId.`);
    return null;
  }
  const rel = index.relations.get(line.relationId);
  if (!assertRelation(rel, line, errors)) return null;

  const stopMembers = rel.members.filter((m) => STOP_ROLES.has(m.role));
  for (const member of stopMembers) {
    if (member.type !== 'node') {
      errors.fail(`${line.id}: stop member is a ${member.type} (${member.ref}), not a node.`);
    }
  }
  const rawStopIds = stopMembers.filter((m) => m.type === 'node').map((m) => m.ref);

  // Stitch geometry FIRST: it decides stop order, because the relation's member order is
  // not trustworthy (see orderStopsByGeometry).
  const wayIds = rel.members.filter((m) => m.type === 'way').map((m) => m.ref);
  const chains = stitchWays(wayIds, index);
  const ordering = orderStopsByGeometry(rawStopIds, chains, index);

  const nameOf = (nodeId: number) => index.nodes.get(nodeId)?.tags?.name ?? `node ${nodeId}`;

  if (ordering.unlocatable.length > 0) {
    errors.fail(
      `${line.id}: ${ordering.unlocatable.length} stop(s) could not be placed on the track geometry ` +
        `(${ordering.unlocatable.map(nameOf).join(', ')}). Distance cannot be measured, and distance is fare.`,
    );
  }
  if (ordering.chainIndex === null && ordering.unlocatable.length === 0) {
    errors.fail(
      `${line.id}: stops span ${ordering.chainsWithStops.length} disconnected track chains ` +
        `(${ordering.chainsWithStops.join(', ')}). Along-track ordering and distance are both unreliable — ` +
        `fix the OSM geometry or drop this line from the allowlist.`,
    );
  }
  if (ordering.snapped.length > 0) {
    const worst = Math.round(Math.max(...ordering.snapped.map((s) => s.errorM)));
    errors.warn(`${line.id}: ${ordering.snapped.length} stop(s) snapped to nearby track (worst ${worst} m).`);
  }
  if (ordering.reorderings.length > 0) {
    errors.warn(
      `${line.id}: OSM relation member order disagrees with track geometry for ` +
        `${ordering.reorderings.length} stop(s) — geometry wins. ` +
        ordering.reorderings
          .map((r) => `${nameOf(r.nodeId)} (member #${r.relationIndex} → track #${r.geometricIndex})`)
          .join('; '),
    );
  }

  const stops: ExtractedStop[] = [];
  for (const nodeId of ordering.orderedNodeIds) {
    const node = index.nodes.get(nodeId);
    if (!node) {
      errors.fail(`${line.id}: stop node ${nodeId} missing from the fetched dataset.`);
      continue;
    }
    const resolved = resolveName(node, overrides);
    if (!resolved) {
      errors.fail(
        `${line.id}: node ${nodeId} has no usable name (no name, name:en, ref, or curated override). ` +
          `Add an entry to curated/name-overrides.json → nodeNames.`,
      );
      continue;
    }
    if (resolved.source === 'ref-fallback') {
      errors.fail(
        `${line.id}: node ${nodeId} resolved only to its ref code '${resolved.display}', which is not a ` +
          `display name. Add a curated nodeNames override.`,
      );
    }
    stops.push({
      osmNodeId: node.id,
      display: resolved.display,
      short: resolved.short,
      norm: resolved.norm,
      aliases: aliasesFor(resolved.display, overrides),
      lat: node.lat,
      lon: node.lon,
      nameSource: resolved.source,
      rawOsmName: resolved.rawOsmName,
    });
  }

  const segments = measureSegments(ordering.orderedNodeIds, chains, index);
  const totalM = segments.reduce((sum, s) => sum + s.distM, 0);

  /**
   * Published route length vs measured station-to-station distance.
   *
   * These are NOT the same quantity and should not be asserted as equal. A published route
   * length is measured along the whole alignment, including tail tracks and depot spurs
   * beyond the terminal platforms; we measure first platform to last. So measured is
   * expected to sit slightly BELOW published, and must never exceed it — exceeding would
   * mean the stitched chain doubled back and inflated distances.
   */
  if (line.publishedRouteLengthKm != null) {
    const measuredKm = totalM / 1000;
    const published = line.publishedRouteLengthKm;
    const floorRatio = line.lengthFloorRatio ?? 0.9;
    const ratio = measuredKm / published;

    if (ratio > 1.02) {
      errors.fail(
        `${line.id}: measured ${measuredKm.toFixed(2)} km EXCEEDS published route length ${published} km ` +
          `(${(ratio * 100).toFixed(1)}%). Station-to-station distance cannot exceed the route length — ` +
          `the stitched chain has almost certainly doubled back.`,
      );
    } else if (ratio < floorRatio) {
      errors.fail(
        `${line.id}: measured ${measuredKm.toFixed(2)} km is only ${(ratio * 100).toFixed(1)}% of the published ` +
          `route length ${published} km (floor ${(floorRatio * 100).toFixed(0)}%). Likely missing geometry or ` +
          `a missing station. Distance drives fare — investigate before shipping.`,
      );
    }
  }

  return {
    id: line.id,
    displayName: line.displayName,
    operator: line.operator,
    mode: line.mode,
    serviceClass: line.serviceClass,
    coverage: line.coverage,
    osmRelationId: line.relationId,
    stops,
    segments,
    totalM,
  };
}

function qualityCounts(segments: Segment[]): Record<SegmentQuality, number> {
  const counts = { measured: 0, 'measured-snapped': 0, 'estimated-gap': 0, unlocatable: 0 };
  for (const s of segments) counts[s.quality]++;
  return counts;
}

async function main() {
  const curated = JSON.parse(await readFile(join(CURATED_DIR, 'lines.json'), 'utf8')) as {
    lines: CuratedLine[];
  };
  const overrides = await loadOverrides();
  const errors = new BuildErrors();

  // Load each dataset once.
  const datasets = new Map<string, OsmIndex>();
  for (const name of new Set(curated.lines.map((l) => l.dataset))) {
    const cached = await readCached(name);
    if (!cached) {
      errors.fail(`Dataset '${name}' not fetched. Run: npm run fetch`);
      continue;
    }
    datasets.set(name, new OsmIndex(cached.response));
  }

  const lines: ExtractedLine[] = [];
  for (const line of curated.lines) {
    const index = datasets.get(line.dataset);
    if (!index) continue;
    const extracted =
      line.source === 'curated-order'
        ? extractCuratedOrder(line, index, overrides, errors)
        : extractLine(line, index, overrides, errors);
    if (extracted) lines.push(extracted);
  }

  // ---- report ----
  console.log(`\n${'='.repeat(104)}`);
  console.log('EXTRACTION REPORT');
  console.log('='.repeat(104));
  console.log(
    `\n${'line'.padEnd(11)} ${'stops'.padEnd(6)} ${'length'.padEnd(10)} ${'published'.padEnd(10)} ` +
      `${'meas'.padEnd(5)} ${'snap'.padEnd(5)} ${'gap'.padEnd(4)} ${'??'.padEnd(3)} coverage`,
  );
  console.log('-'.repeat(104));

  const byId = new Map(curated.lines.map((l) => [l.id, l]));
  for (const line of lines) {
    const q = qualityCounts(line.segments);
    const published = byId.get(line.id)?.publishedRouteLengthKm;
    console.log(
      `${line.id.padEnd(11)} ${String(line.stops.length).padEnd(6)} ` +
        `${`${(line.totalM / 1000).toFixed(2)} km`.padEnd(10)} ` +
        `${(published != null ? `${published} km` : '—').padEnd(10)} ` +
        `${String(q.measured).padEnd(5)} ${String(q['measured-snapped']).padEnd(5)} ` +
        `${String(q['estimated-gap']).padEnd(4)} ${String(q.unlocatable).padEnd(3)} ${line.coverage}`,
    );
  }

  const allStops = lines.flatMap((l) => l.stops);
  const uniqueNorm = new Set(allStops.map((s) => s.norm));
  console.log(
    `\n${lines.length} lines · ${allStops.length} line-stops · ${uniqueNorm.size} distinct normalised names ` +
      `(pre-clustering; the true station count lands between these two).`,
  );

  const curatedNames = allStops.filter((s) => s.nameSource === 'curated');
  if (curatedNames.length > 0) {
    const unique = [...new Map(curatedNames.map((s) => [s.osmNodeId, s])).values()];
    console.log(`\nNames from curated overrides (${unique.length}) — each must have a recorded reason:`);
    for (const s of unique) {
      console.log(`  ${s.display.padEnd(40)} node ${s.osmNodeId}${s.rawOsmName ? ` (osm: '${s.rawOsmName}')` : ' (osm had NO name)'}`);
    }
  }

  const flagged = lines.flatMap((l) =>
    l.segments
      .filter((s) => s.quality !== 'measured')
      .map((s) => ({ line: l.id, ...s })),
  );
  if (flagged.length > 0) {
    console.log(`\nSegments not cleanly measured (${flagged.length}):`);
    for (const s of flagged.slice(0, 25)) {
      console.log(`  ${s.line.padEnd(11)} ${s.quality.padEnd(17)} ${(s.distM / 1000).toFixed(3)} km  ${s.note ?? ''}`);
    }
    if (flagged.length > 25) console.log(`  … and ${flagged.length - 25} more`);
  }

  if (errors.warnings.length > 0) {
    console.log(`\nWARNINGS (${errors.warnings.length}):`);
    for (const w of errors.warnings) console.log(`  ⚠ ${w}`);
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'extracted.json'), JSON.stringify({ lines }, null, 2), 'utf8');

  if (errors.fatal.length > 0) {
    console.error(`\nFATAL (${errors.fatal.length}) — build must not proceed:`);
    for (const f of errors.fatal) console.error(`  ✗ ${f}`);
    process.exit(1);
  }

  console.log(`\n✓ wrote out/extracted.json — next: interchange clustering`);
}

await main();
