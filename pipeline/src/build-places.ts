/**
 * Build the address / landmark index.
 *
 *   node --experimental-strip-types src/build-places.ts
 *
 * ── Why this is a landmark index and not a street-address geocoder ──
 *
 * Measured against OSM for core Mumbai: 7,552 features carry a house number, for a city of 20
 * million people. House-number geocoding is simply not possible here, and chasing it would produce
 * a search box that fails on almost every real query.
 *
 * That is not really a data gap — it is how the city works. A Mumbai address is a landmark plus an
 * area ("Phoenix Mills, Lower Parel"), not a number plus a street. So the index is built from the
 * three layers that DO exist and that people say out loud:
 *
 *   locality  ~1.1k   suburbs and neighbourhoods — the highest-value layer
 *   landmark  ~28k    malls, hospitals, colleges, offices, stations of life
 *   street    ~16k    named roads, stored as a centroid
 *
 * Each landmark and street is labelled with its nearest locality, because "Central Plaza" is
 * meaningless on its own and "Central Plaza, Andheri East" is an address.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCached } from './overpass.ts';
import { loadOverrides, normaliseName, type Overrides } from './normalize.ts';
import { haversineM } from './geometry.ts';
import type { OsmElement } from './osm-types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'out');
const ASSET_DIR = join(HERE, '..', '..', '..', 'apps', 'mobile', 'assets');

/** locality > landmark > street, when two entries collide. */
export const PLACE_KIND = { locality: 0, landmark: 1, street: 2 } as const;
type Kind = (typeof PLACE_KIND)[keyof typeof PLACE_KIND];

/** Two entries with the same normalised name within this distance are the same place. */
const DEDUPE_RADIUS_M = 200;
/** A landmark further than this from any locality gets no area label rather than a wrong one. */
const LOCALITY_MAX_M = 3000;

interface RawPlace {
  name: string;
  norm: string;
  lat: number;
  lon: number;
  kind: Kind;
}

/** Point for a node, or the `center` Overpass computes for a way/relation. */
function pointOf(el: OsmElement & { center?: { lat: number; lon: number } }): { lat: number; lon: number } | null {
  if (el.type === 'node') return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

/**
 * Reject names that would only add noise to search results. OSM's named-building layer in
 * particular is full of entries like "Building No 3" and bare numbers, which are unsearchable
 * and crowd out real landmarks.
 */
function isUsableName(name: string): boolean {
  const t = name.trim();
  if (t.length < 3 || t.length > 60) return false;
  if (!/[A-Za-z]/.test(t)) return false; // purely numeric or symbols
  if (/^(building|bldg|wing|tower|block|plot|shop|gala|room|flat)\s*[-.no#]*\s*\d+[a-z]?$/i.test(t)) return false;
  if (/^[a-z]$/i.test(t)) return false;
  return true;
}

async function collect(dataset: string, kind: Kind, overrides: Overrides): Promise<RawPlace[]> {
  const cached = await readCached(dataset);
  if (!cached) {
    console.warn(`  ⚠ ${dataset} not fetched — run: npm run fetch -- --places`);
    return [];
  }
  const out: RawPlace[] = [];
  let skippedNoPoint = 0;
  let skippedName = 0;

  for (const el of cached.response.elements as (OsmElement & { center?: { lat: number; lon: number } })[]) {
    const name = el.tags?.name;
    if (!name) continue;
    if (!isUsableName(name)) {
      skippedName++;
      continue;
    }
    const point = pointOf(el);
    if (!point) {
      skippedNoPoint++;
      continue;
    }
    out.push({ name: name.trim(), norm: normaliseName(name, overrides), lat: point.lat, lon: point.lon, kind });
  }
  console.log(
    `  ${dataset.padEnd(20)} ${String(out.length).padStart(6)} usable` +
      `   (${skippedName} unusable names, ${skippedNoPoint} without a point)`,
  );
  return out;
}

/**
 * Collapse duplicates.
 *
 * Grouping by normalised name first keeps this linear in practice — a full pairwise pass over
 * 45k places would be two billion comparisons. Within a name group, entries closer than
 * DEDUPE_RADIUS_M are the same place and the highest-priority kind wins.
 */
function dedupe(places: RawPlace[]): RawPlace[] {
  const byNorm = new Map<string, RawPlace[]>();
  for (const p of places) {
    const list = byNorm.get(p.norm);
    if (list) list.push(p);
    else byNorm.set(p.norm, [p]);
  }

  const kept: RawPlace[] = [];
  for (const group of byNorm.values()) {
    const clusters: RawPlace[][] = [];
    for (const p of group) {
      const cluster = clusters.find((c) => c.some((q) => haversineM(p.lat, p.lon, q.lat, q.lon) <= DEDUPE_RADIUS_M));
      if (cluster) cluster.push(p);
      else clusters.push([p]);
    }
    for (const cluster of clusters) {
      // Best kind wins; among equals, the centroid keeps the entry near the whole cluster.
      const best = cluster.reduce((a, b) => (b.kind < a.kind ? b : a));
      kept.push({
        ...best,
        lat: cluster.reduce((s, p) => s + p.lat, 0) / cluster.length,
        lon: cluster.reduce((s, p) => s + p.lon, 0) / cluster.length,
      });
    }
  }
  return kept;
}

async function main() {
  const overrides = await loadOverrides();

  console.log('\nCollecting place layers:');
  const localities = await collect('places-localities', PLACE_KIND.locality, overrides);
  const landmarks = await collect('places-landmarks', PLACE_KIND.landmark, overrides);
  const streets = await collect('places-streets', PLACE_KIND.street, overrides);

  const all = dedupe([...localities, ...landmarks, ...streets]);
  console.log(
    `\n  ${localities.length + landmarks.length + streets.length} collected → ${all.length} after dedupe`,
  );

  // ── label each place with its nearest locality ────────────────────────────
  const localityList = all.filter((p) => p.kind === PLACE_KIND.locality);
  const localityIndex = new Map(localityList.map((l, i) => [l, i]));

  let labelled = 0;
  const areaOf = new Map<RawPlace, number>();
  for (const place of all) {
    if (place.kind === PLACE_KIND.locality) continue;
    let best: RawPlace | null = null;
    let bestD = Infinity;
    for (const loc of localityList) {
      const d = haversineM(place.lat, place.lon, loc.lat, loc.lon);
      if (d < bestD) {
        bestD = d;
        best = loc;
      }
    }
    if (best && bestD <= LOCALITY_MAX_M) {
      areaOf.set(place, localityIndex.get(best)!);
      labelled++;
    }
  }
  console.log(`  ${labelled} of ${all.length - localityList.length} places labelled with a locality`);

  // ── emit ──────────────────────────────────────────────────────────────────
  // Arrays, not objects: repeating five keys across 45k entries costs more than the data.
  const sorted = [...all].sort((a, b) => a.kind - b.kind || a.name.localeCompare(b.name));
  const payload = {
    version: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
    builtAt: new Date().toISOString(),
    kinds: ['locality', 'landmark', 'street'],
    localities: localityList.map((l) => l.name),
    // [name, lat, lon, kind, localityIndex | -1]
    places: sorted.map((p) => [
      p.name,
      Number(p.lat.toFixed(5)),
      Number(p.lon.toFixed(5)),
      p.kind,
      areaOf.get(p) ?? -1,
    ]),
    note:
      'Landmark/locality index for Mumbai. OSM has almost no street addresses here (7,552 features ' +
      'with a house number for 20 million people), so this indexes what the city actually uses: ' +
      'localities and landmarks. Street entries are a centroid and are imprecise for long roads.',
  };

  const json = JSON.stringify(payload);
  const kb = Buffer.byteLength(json) / 1024;
  const { gzipSync } = await import('node:zlib');
  const gzKb = gzipSync(Buffer.from(json)).length / 1024;

  const counts = { locality: 0, landmark: 0, street: 0 };
  for (const p of all) counts[(['locality', 'landmark', 'street'] as const)[p.kind]]++;

  console.log(`\nPLACES INDEX`);
  console.log(`  localities  ${counts.locality}`);
  console.log(`  landmarks   ${counts.landmark}`);
  console.log(`  streets     ${counts.street}`);
  console.log(`  total       ${all.length}`);
  console.log(`  size        ${kb.toFixed(1)} KB raw / ${gzKb.toFixed(1)} KB gzipped`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'places.json'), json, 'utf8');
  const appPresent = existsSync(join(ASSET_DIR, '..', 'package.json'));
  if (appPresent) await writeFile(join(ASSET_DIR, 'places.json'), json, 'utf8');
  console.log(`\n✓ wrote out/places.json${appPresent ? ' and apps/mobile/assets/places.json' : ''}`);
}

await main();
