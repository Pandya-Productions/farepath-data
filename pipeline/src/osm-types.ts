/**
 * Minimal OpenStreetMap / Overpass type surface.
 *
 * Only the fields the pipeline actually reads are declared. Overpass returns plenty more;
 * we deliberately do not model it, so that an upstream schema addition cannot silently
 * change our behaviour.
 */

export type OsmTags = Record<string, string>;

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: OsmTags;
}

export interface OsmWay {
  type: 'way';
  id: number;
  /** Ordered node ids. Present because we request `out body`, not `out skel`. */
  nodes: number[];
  tags?: OsmTags;
}

export interface OsmRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  members: OsmRelationMember[];
  tags?: OsmTags;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OverpassResponse {
  version?: number;
  generator?: string;
  osm3s?: { timestamp_osm_base?: string };
  elements: OsmElement[];
}

export const isNode = (e: OsmElement): e is OsmNode => e.type === 'node';
export const isWay = (e: OsmElement): e is OsmWay => e.type === 'way';
export const isRelation = (e: OsmElement): e is OsmRelation => e.type === 'relation';

/** Roles that mark a relation member as a place a train actually stops. */
export const STOP_ROLES = new Set(['stop', 'stop_entry_only', 'stop_exit_only']);

/**
 * An indexed view over a raw Overpass response, so lookups are O(1) instead of
 * scanning the element array once per member.
 */
export class OsmIndex {
  readonly nodes = new Map<number, OsmNode>();
  readonly ways = new Map<number, OsmWay>();
  readonly relations = new Map<number, OsmRelation>();

  constructor(response: OverpassResponse) {
    for (const el of response.elements) {
      if (isNode(el)) this.nodes.set(el.id, el);
      else if (isWay(el)) this.ways.set(el.id, el);
      else if (isRelation(el)) this.relations.set(el.id, el);
    }
  }

  get counts() {
    return { nodes: this.nodes.size, ways: this.ways.size, relations: this.relations.size };
  }
}
