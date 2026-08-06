/**
 * Tests for the data pipeline's correctness-critical behaviour.
 *
 * Every case here corresponds to a defect that was actually found in the real Mumbai data,
 * not a hypothetical. They exist so that a future change to the normalisation rules or the
 * clustering radius cannot silently reintroduce a wrong fare.
 *
 *   node --experimental-strip-types --test src/pipeline.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadOverrides, stripDisambiguators, normaliseName, resolveName } from './normalize.ts';
import { haversineM, stitchWays, orderStopsByGeometry } from './geometry.ts';
import { clusterStations } from './cluster.ts';
import { OsmIndex, type OverpassResponse, type OsmNode } from './osm-types.ts';
import type { ExtractedLine, ExtractedStop } from './extract.ts';

const overrides = await loadOverrides();

describe('name normalisation', () => {
  test('strips OSM square-bracket line disambiguators', () => {
    // Dahisar (East) appears as three separate OSM nodes for ONE metro interchange.
    for (const ref of ['[Line 2]', '[Line 7]', '[Line 9]']) {
      assert.equal(stripDisambiguators(`Dahisar (East) ${ref}`, overrides), 'Dahisar (East)');
    }
  });

  test('KEEPS (East) — Dahisar East and Dahisar are different stations', () => {
    const dahisarEast = normaliseName(stripDisambiguators('Dahisar (East) [Line 7]', overrides), overrides);
    const dahisar = normaliseName(stripDisambiguators('Dahisar', overrides), overrides);
    assert.notEqual(
      dahisarEast,
      dahisar,
      'Dahisar (Western Line) must not collapse into Dahisar East (Metro) — they are ~1 km apart',
    );
  });

  test('strips only allowlisted parentheticals, not arbitrary ones', () => {
    assert.equal(stripDisambiguators('Marol Naka (Line 3)', overrides), 'Marol Naka');
    assert.equal(stripDisambiguators('Dadar (Central)', overrides), 'Dadar');
    assert.equal(stripDisambiguators('Dadar (Western)', overrides), 'Dadar');
    // Not on the allowlist: must survive untouched.
    assert.equal(stripDisambiguators('Somewhere (Depot)', overrides), 'Somewhere (Depot)');
  });

  test('strips trailing mode words', () => {
    assert.equal(stripDisambiguators('Jagannath Shankar Sheth Metro', overrides), 'Jagannath Shankar Sheth');
  });

  test('norm drops Junction so Kalyan matches Kalyan Junction', () => {
    assert.equal(normaliseName('Kalyan Junction', overrides), normaliseName('Kalyan', overrides));
  });

  test('norm folds spacing variants (Santa Cruz / Santacruz)', () => {
    assert.equal(normaliseName('Santa Cruz', overrides), normaliseName('Santacruz', overrides));
  });

  test('norm keeps genuinely different names apart', () => {
    assert.notEqual(normaliseName('Matunga', overrides), normaliseName('Matunga Road', overrides));
  });

  test('resolves a node that has NO name tag via curated override', () => {
    // Real defect: OSM node 631525335 is Matunga Road but carries only name:hi and ref=MRU.
    // Without the override the station vanishes and Western Line adjacency breaks.
    const node: OsmNode = {
      type: 'node',
      id: 631525335,
      lat: 19.0281578,
      lon: 72.8467302,
      tags: { ref: 'MRU', railway: 'stop', 'name:hi': 'माटुंगा रोड' },
    };
    const resolved = resolveName(node, overrides);
    assert.equal(resolved?.display, 'Matunga Road');
    assert.equal(resolved?.source, 'curated');
  });

  test('a nameless, un-curated node reports ref-fallback so the build can reject it', () => {
    const node: OsmNode = { type: 'node', id: 999999, lat: 19, lon: 72, tags: { ref: 'XYZ' } };
    assert.equal(resolveName(node, overrides)?.source, 'ref-fallback');
  });
});

describe('geometry', () => {
  test('haversine matches a known distance', () => {
    // Churchgate → Virar, straight line. Real track is ~60 km; chord is shorter.
    const d = haversineM(18.9316, 72.8266, 19.4559, 72.7933) / 1000;
    assert.ok(d > 55 && d < 60, `expected 55–60 km chord, got ${d.toFixed(1)}`);
  });

  test('stitches ways regardless of individual way orientation', () => {
    // Three ways covering 1→2→3→4→5, with the middle one reversed.
    const nodes: OsmNode[] = [1, 2, 3, 4, 5].map((id) => ({
      type: 'node',
      id,
      lat: 19 + id * 0.01,
      lon: 72,
    }));
    const response: OverpassResponse = {
      elements: [
        ...nodes,
        { type: 'way', id: 100, nodes: [1, 2, 3] },
        { type: 'way', id: 101, nodes: [4, 3] }, // reversed relative to travel order
        { type: 'way', id: 102, nodes: [4, 5] },
      ],
    };
    const index = new OsmIndex(response);
    const chains = stitchWays([100, 101, 102], index);
    assert.equal(chains.length, 1, 'reversed ways must still stitch into one chain');
    assert.deepEqual(chains[0]!.nodeIds, [1, 2, 3, 4, 5]);
    assert.ok(chains[0]!.cumulative[4]! > chains[0]!.cumulative[0]!);
  });

  test('orders stops by track geometry, overriding a wrong relation member order', () => {
    // The real Harbour Line defect: the relation lists Chembur BEFORE Tilak Nagar, but the
    // track has Tilak Nagar first. Trusting member order inflated Kurla→Govandi from
    // 4.23 km to 6.63 km and invented false adjacency.
    const ids = [10, 11, 12, 13];
    const nodes: OsmNode[] = ids.map((id, i) => ({
      type: 'node',
      id,
      lat: 19 + i * 0.01,
      lon: 72,
    }));
    const response: OverpassResponse = {
      elements: [...nodes, { type: 'way', id: 200, nodes: ids }],
    };
    const index = new OsmIndex(response);
    const chains = stitchWays([200], index);

    // Feed stops in the WRONG order (12 before 11), as OSM does.
    const ordering = orderStopsByGeometry([10, 12, 11, 13], chains, index);
    assert.deepEqual(ordering.orderedNodeIds, [10, 11, 12, 13], 'geometry must win over member order');
    assert.equal(ordering.reorderings.length, 2, 'the two swapped stops must be reported, not silently fixed');
    assert.equal(ordering.chainIndex, 0);
  });

  test('reports stops spread across disconnected chains rather than guessing', () => {
    const nodes: OsmNode[] = [1, 2, 8, 9].map((id) => ({ type: 'node', id, lat: 19 + id, lon: 72 }));
    const response: OverpassResponse = {
      elements: [
        ...nodes,
        { type: 'way', id: 300, nodes: [1, 2] },
        { type: 'way', id: 301, nodes: [8, 9] }, // disjoint from the first way
      ],
    };
    const index = new OsmIndex(response);
    const chains = stitchWays([300, 301], index);
    assert.equal(chains.length, 2);
    const ordering = orderStopsByGeometry([1, 2, 8, 9], chains, index);
    assert.equal(ordering.chainIndex, null, 'must refuse to order across disconnected chains');
    assert.equal(ordering.chainsWithStops.length, 2);
  });
});

describe('station clustering', () => {
  const stop = (display: string, lat: number, lon: number): ExtractedStop => ({
    osmNodeId: Math.round(lat * 1e6 + lon),
    display,
    norm: normaliseName(display, overrides),
    aliases: [],
    lat,
    lon,
    nameSource: 'osm-name',
  });

  const line = (id: string, operator: string, stops: ExtractedStop[]): ExtractedLine => ({
    id,
    displayName: id,
    operator,
    mode: 'metro',
    serviceClass: 'all-stops',
    coverage: 'complete',
    osmRelationId: 0,
    stops,
    segments: [],
    totalM: 0,
  });

  test('does NOT merge same-named stations of different operators', () => {
    // Ghatkopar metro and suburban stations are 74 m apart but separately ticketed: you exit
    // one, walk, and enter the other. Merging makes that transfer free and instant.
    const { clusters } = clusterStations([
      line('M1', 'mumbai-metro', [stop('Ghatkopar', 19.0858, 72.908)]),
      line('C-SLOW', 'mumbai-suburban', [stop('Ghatkopar', 19.0862, 72.9086)]),
    ]);
    assert.equal(clusters.length, 2, 'cross-operator same-name stations must stay separate');
    for (const c of clusters) assert.equal(c.operators.length, 1);
  });

  test('merges same-named stations of the same operator when close', () => {
    const { clusters } = clusterStations([
      line('W-SLOW', 'mumbai-suburban', [stop('Bandra', 19.0544, 72.8402)]),
      line('H-GOREGAON', 'mumbai-suburban', [stop('Bandra', 19.0546, 72.8404)]),
    ]);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0]!.lineIds.sort(), ['H-GOREGAON', 'W-SLOW']);
  });

  test('never merges same-named stations that are far apart', () => {
    // Western Line Naigaon and Monorail Naigaon: same name, ~38 km apart. Name-only
    // matching would fuse two unrelated networks.
    const { clusters } = clusterStations([
      line('W-SLOW', 'mumbai-suburban', [stop('Naigaon', 19.3521, 72.8449)]),
      line('MONO', 'mumbai-suburban', [stop('Naigaon', 19.00954, 72.84787)]),
    ]);
    assert.equal(clusters.length, 2, 'proximity must gate the merge, not name alone');
  });

  test('forceMerge widens the radius only for the named group', () => {
    const stops = [
      line('W-SLOW', 'mumbai-suburban', [stop('Jogeshwari', 19.1367, 72.8493)]),
      line('H-GOREGAON', 'mumbai-suburban', [stop('Jogeshwari', 19.1417, 72.8503)]),
    ];
    const withoutForce = clusterStations(stops);
    assert.equal(withoutForce.clusters.length, 2, 'default radius should not reach 563 m');

    const withForce = clusterStations(stops, [
      { norm: normaliseName('Jogeshwari', overrides), operator: 'mumbai-suburban', maxSpreadM: 700, reason: 'test' },
    ]);
    assert.equal(withForce.clusters.length, 1);
    assert.equal(withForce.appliedForceMerges[0]!.unioned, 1);
  });

  test('forceMerge does not leak across operators', () => {
    const withForce = clusterStations(
      [
        line('M3', 'mumbai-metro', [stop('Dadar', 19.0234, 72.839)]),
        line('W-SLOW', 'mumbai-suburban', [stop('Dadar', 19.0189, 72.8435)]),
      ],
      [{ norm: normaliseName('Dadar', overrides), operator: 'mumbai-metro', maxSpreadM: 2000, reason: 'test' }],
    );
    assert.equal(withForce.clusters.length, 2, 'a metro-scoped forceMerge must not absorb the suburban station');
  });
});
