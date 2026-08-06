/**
 * Distance measurement along real track geometry.
 *
 * Why this module is not just haversine: on a distance-slab fare system, measured distance
 * IS the fare. Straight-line distance between two stations systematically under-reports on
 * curved alignments — the Harbour Line's Wadala loop and the Western Line's Bandra–Mahim
 * curve especially — and an under-reported distance silently under-charges the user in the
 * app while the counter charges the real amount. So we walk the track.
 *
 * Approach: stitch the route relation's member ways into ordered node chains, locate each
 * stop node within a chain, and sum consecutive-node haversine along the chain between
 * stops. Anything that cannot be measured this way is FLAGGED, never silently estimated.
 */

import { OsmIndex, type OsmNode } from './osm-types.ts';

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius

/** Great-circle distance in metres. Used only between adjacent track nodes (metres apart), where curvature error is negligible. */
export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const lat1 = aLat * toRad;
  const lat2 = bLat * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A contiguous run of track. A well-mapped route yields exactly one chain; more than one
 * means OSM has a gap, which we surface rather than paper over.
 */
export interface Chain {
  nodeIds: number[];
  /** cumulative[i] = metres from chain start to nodeIds[i] */
  cumulative: number[];
}

/**
 * Stitch relation member ways into ordered chains.
 *
 * Route relations are usually stored in travel order, but individual ways may be reversed
 * relative to that order (OSM way direction reflects the physical way, not the service),
 * so all four join orientations are handled.
 */
export function stitchWays(wayIds: number[], index: OsmIndex): Chain[] {
  const chains: Chain[] = [];
  let current: number[] = [];

  const flush = () => {
    if (current.length >= 2) chains.push(withCumulative(current, index));
    current = [];
  };

  for (const wayId of wayIds) {
    const way = index.ways.get(wayId);
    if (!way || way.nodes.length < 2) continue;
    const nodes = way.nodes;

    if (current.length === 0) {
      current = [...nodes];
      continue;
    }

    const chainFirst = current[0]!;
    const chainLast = current[current.length - 1]!;
    const wayFirst = nodes[0]!;
    const wayLast = nodes[nodes.length - 1]!;

    if (wayFirst === chainLast) {
      current.push(...nodes.slice(1));
    } else if (wayLast === chainLast) {
      current.push(...[...nodes].reverse().slice(1));
    } else if (wayLast === chainFirst) {
      current.unshift(...nodes.slice(0, -1));
    } else if (wayFirst === chainFirst) {
      current.unshift(...[...nodes].reverse().slice(0, -1));
    } else {
      // Genuine discontinuity in the OSM data.
      flush();
      current = [...nodes];
    }
  }
  flush();
  return chains;
}

function withCumulative(nodeIds: number[], index: OsmIndex): Chain {
  const cumulative = new Array<number>(nodeIds.length).fill(0);
  let total = 0;
  let prev: OsmNode | undefined = index.nodes.get(nodeIds[0]!);
  for (let i = 1; i < nodeIds.length; i++) {
    const node = index.nodes.get(nodeIds[i]!);
    if (prev && node) total += haversineM(prev.lat, prev.lon, node.lat, node.lon);
    cumulative[i] = total;
    if (node) prev = node;
  }
  return { nodeIds, cumulative };
}

export interface StopLocation {
  chainIndex: number;
  position: number;
  /** How the stop was located: exact chain membership, or snapped to the nearest track node. */
  method: 'on-chain' | 'snapped';
  /** Metres from the stop node to the track node it snapped to (0 when on-chain). */
  snapErrorM: number;
}

const MAX_SNAP_M = 400;

/**
 * Locate a stop node within the stitched chains.
 *
 * `railway=stop` nodes are normally members of the track way, giving an exact hit. When a
 * mapper has placed the stop beside the track instead, we snap to the nearest track node
 * and record the error so the caller can judge whether it is tolerable.
 */
export function locateStop(stopNodeId: number, chains: Chain[], index: OsmIndex): StopLocation | null {
  for (let c = 0; c < chains.length; c++) {
    const position = chains[c]!.nodeIds.indexOf(stopNodeId);
    if (position !== -1) return { chainIndex: c, position, method: 'on-chain', snapErrorM: 0 };
  }

  const stop = index.nodes.get(stopNodeId);
  if (!stop) return null;

  let best: StopLocation | null = null;
  let bestDist = Infinity;
  for (let c = 0; c < chains.length; c++) {
    const chain = chains[c]!;
    for (let i = 0; i < chain.nodeIds.length; i++) {
      const node = index.nodes.get(chain.nodeIds[i]!);
      if (!node) continue;
      const d = haversineM(stop.lat, stop.lon, node.lat, node.lon);
      if (d < bestDist) {
        bestDist = d;
        best = { chainIndex: c, position: i, method: 'snapped', snapErrorM: d };
      }
    }
  }
  return best && bestDist <= MAX_SNAP_M ? best : null;
}

export interface StopOrdering {
  /** Stops in true along-track order. */
  orderedNodeIds: number[];
  /** The single chain all stops lie on, or null if they are spread across chains. */
  chainIndex: number | null;
  direction: 'forward' | 'backward';
  /** Stops whose along-track order disagreed with the relation's member order. */
  reorderings: { nodeId: number; relationIndex: number; geometricIndex: number }[];
  unlocatable: number[];
  snapped: { nodeId: number; errorM: number }[];
  /** Chain indices that actually contain stops — the only ones that matter. */
  chainsWithStops: number[];
}

/**
 * Order stops by their position along the track, NOT by the relation's member order.
 *
 * Why: OSM relation member order is hand-maintained and is sometimes simply wrong. The
 * Harbour Line CSMT→Panvel relation lists Kurla → Chembur → Tilak Nagar → Govandi, but the
 * real and geometric order is Kurla → Tilak Nagar → Chembur → Govandi. Trusting the member
 * order there inflates Kurla→Govandi from 4.23 km to 6.63 km and invents false adjacency —
 * a wrong route and a wrong fare. Track geometry is the authoritative source, so we sort by
 * it and report the disagreement rather than inheriting the defect.
 *
 * This is only safe because rail routes do not double back on themselves; a route that
 * legitimately revisited track would need different handling.
 */
export function orderStopsByGeometry(stopNodeIds: number[], chains: Chain[], index: OsmIndex): StopOrdering {
  const located = stopNodeIds.map((id) => ({ id, loc: locateStop(id, chains, index) }));
  const unlocatable = located.filter((s) => !s.loc).map((s) => s.id);
  const snapped = located
    .filter((s) => s.loc?.method === 'snapped')
    .map((s) => ({ nodeId: s.id, errorM: s.loc!.snapErrorM }));

  const placed = located.filter((s): s is { id: number; loc: StopLocation } => s.loc !== null);
  const chainsWithStops = [...new Set(placed.map((s) => s.loc.chainIndex))].sort((a, b) => a - b);

  // Stops spread across disconnected chains cannot be ordered reliably by geometry.
  if (chainsWithStops.length !== 1) {
    return {
      orderedNodeIds: stopNodeIds,
      chainIndex: null,
      direction: 'forward',
      reorderings: [],
      unlocatable,
      snapped,
      chainsWithStops,
    };
  }

  const chainIndex = chainsWithStops[0]!;
  // Preserve the relation's travel direction so display order stays natural.
  const firstPos = placed[0]!.loc.position;
  const lastPos = placed[placed.length - 1]!.loc.position;
  const direction: 'forward' | 'backward' = lastPos >= firstPos ? 'forward' : 'backward';

  const sorted = [...placed].sort((a, b) =>
    direction === 'forward' ? a.loc.position - b.loc.position : b.loc.position - a.loc.position,
  );

  const reorderings: StopOrdering['reorderings'] = [];
  sorted.forEach((entry, geometricIndex) => {
    const relationIndex = placed.findIndex((p) => p.id === entry.id);
    if (relationIndex !== geometricIndex) reorderings.push({ nodeId: entry.id, relationIndex, geometricIndex });
  });

  return {
    orderedNodeIds: sorted.map((s) => s.id),
    chainIndex,
    direction,
    reorderings,
    unlocatable,
    snapped,
    chainsWithStops,
  };
}

export type SegmentQuality = 'measured' | 'measured-snapped' | 'estimated-gap' | 'unlocatable';

export interface Segment {
  fromNodeId: number;
  toNodeId: number;
  distM: number;
  quality: SegmentQuality;
  note?: string;
}

/**
 * Straight-line fallback multiplier for the case where OSM track geometry has a gap between
 * two consecutive stops. Real track between adjacent suburban stations is only slightly
 * longer than the chord; 1.08 is a deliberately CONSERVATIVE (over-, not under-) estimate,
 * because over-reporting distance shows the user a fare no lower than the true one.
 * Every segment using this is flagged `estimated-gap` and surfaces in the build report.
 */
const GAP_DETOUR_FACTOR = 1.08;

/**
 * Measure a route whose stops are spread across several disconnected chains.
 *
 * Needed for the Mumbai Monorail, which OSM maps as two parallel guideways broken into
 * fragments, so station nodes snap to whichever guideway is nearest and consecutive stations
 * frequently land on different chains. Along-track measurement is used wherever a pair shares
 * a chain; the remainder falls back to straight line.
 *
 * When `calibrateTotalM` is supplied, the fallback segments are then scaled so the line total
 * matches the published route length. This is honest only because it is explicit: the scale
 * factor is returned, every scaled segment is flagged `estimated-gap`, and an implausible
 * factor is reported rather than applied silently. It is a calibrated estimate, not a
 * measurement, and the fare engine treats it as such.
 */
export function measureSegmentsAcrossChains(
  orderedNodeIds: number[],
  chains: Chain[],
  index: OsmIndex,
  calibrateTotalM?: number,
): { segments: Segment[]; scaleFactor: number | null; measuredM: number; estimatedM: number } {
  const locations = orderedNodeIds.map((id) => locateStop(id, chains, index));
  const segments: Segment[] = [];

  for (let i = 0; i < orderedNodeIds.length - 1; i++) {
    const fromNodeId = orderedNodeIds[i]!;
    const toNodeId = orderedNodeIds[i + 1]!;
    const a = locations[i];
    const b = locations[i + 1];
    const fromNode = index.nodes.get(fromNodeId);
    const toNode = index.nodes.get(toNodeId);

    if (!fromNode || !toNode) {
      segments.push({ fromNodeId, toNodeId, distM: 0, quality: 'unlocatable' });
      continue;
    }

    if (a && b && a.chainIndex === b.chainIndex) {
      const chain = chains[a.chainIndex]!;
      segments.push({
        fromNodeId,
        toNodeId,
        distM: Math.abs(chain.cumulative[b.position]! - chain.cumulative[a.position]!),
        quality: 'measured',
      });
    } else {
      segments.push({
        fromNodeId,
        toNodeId,
        distM: haversineM(fromNode.lat, fromNode.lon, toNode.lat, toNode.lon),
        quality: 'estimated-gap',
        note: 'Stops lie on different guideway fragments; straight line, calibrated to published route length.',
      });
    }
  }

  const measuredM = segments.filter((s) => s.quality === 'measured').reduce((t, s) => t + s.distM, 0);
  const estimatedM = segments.filter((s) => s.quality === 'estimated-gap').reduce((t, s) => t + s.distM, 0);

  let scaleFactor: number | null = null;
  if (calibrateTotalM != null && estimatedM > 0) {
    scaleFactor = (calibrateTotalM - measuredM) / estimatedM;
    if (scaleFactor > 0) {
      for (const segment of segments) {
        if (segment.quality === 'estimated-gap') {
          segment.distM *= scaleFactor;
          segment.note = `Straight line × ${scaleFactor.toFixed(3)} (calibrated so the line total matches the published route length).`;
        }
      }
    }
  }

  return { segments, scaleFactor, measuredM, estimatedM };
}

/** Measure each consecutive stop pair along the route. */
export function measureSegments(stopNodeIds: number[], chains: Chain[], index: OsmIndex): Segment[] {
  const locations = stopNodeIds.map((id) => locateStop(id, chains, index));
  const segments: Segment[] = [];

  for (let i = 0; i < stopNodeIds.length - 1; i++) {
    const fromNodeId = stopNodeIds[i]!;
    const toNodeId = stopNodeIds[i + 1]!;
    const a = locations[i];
    const b = locations[i + 1];
    const fromNode = index.nodes.get(fromNodeId);
    const toNode = index.nodes.get(toNodeId);

    if (!a || !b || !fromNode || !toNode) {
      segments.push({
        fromNodeId,
        toNodeId,
        distM: fromNode && toNode ? haversineM(fromNode.lat, fromNode.lon, toNode.lat, toNode.lon) : 0,
        quality: 'unlocatable',
        note: 'One or both stops could not be placed on the track geometry.',
      });
      continue;
    }

    if (a.chainIndex === b.chainIndex) {
      const chain = chains[a.chainIndex]!;
      const distM = Math.abs(chain.cumulative[b.position]! - chain.cumulative[a.position]!);
      const snapped = a.method === 'snapped' || b.method === 'snapped';
      segments.push({
        fromNodeId,
        toNodeId,
        distM,
        quality: snapped ? 'measured-snapped' : 'measured',
        note: snapped
          ? `Snapped to track (max error ${Math.round(Math.max(a.snapErrorM, b.snapErrorM))} m).`
          : undefined,
      });
      continue;
    }

    segments.push({
      fromNodeId,
      toNodeId,
      distM: haversineM(fromNode.lat, fromNode.lon, toNode.lat, toNode.lon) * GAP_DETOUR_FACTOR,
      quality: 'estimated-gap',
      note: `OSM track geometry is discontinuous between these stops (chain ${a.chainIndex} → ${b.chainIndex}); straight line × ${GAP_DETOUR_FACTOR}.`,
    });
  }

  return segments;
}
