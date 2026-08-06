/**
 * The shipped transit dataset — the contract between the build pipeline and the app.
 *
 * This is bundled as a single JSON asset. There is deliberately no on-device SQLite: at ~218
 * stations and ~300 edges the whole network fits comfortably in memory, so a database engine
 * would cost ~1.5–2.5 MB of native library to buy indexed queries we do not need.
 *
 * Money is always integer paise. Distances are metres, times are seconds. No floats for fares.
 */

/** Whether a fare figure is trustworthy enough to state plainly. Propagates to the UI. */
export type Confidence = 'verified' | 'estimated';

/**
 * 'suspended' operators stay in the dataset but must never be routed over. The Mumbai Monorail
 * has been suspended since 2025-09-20; users searching its stations should be told that, not
 * handed a route they cannot travel.
 */
export type OperatorStatus = 'operating' | 'suspended';

export type FareRule = 'distance_slab' | 'station_pair_matrix';

export interface Operator {
  id: string;
  name: string;
  shortName: string;
  authority: string;
  fareRule: FareRule;
  status: OperatorStatus;
  statusSince?: string;
  statusNote?: string;
  /** Travel classes with a shippable fare. Classes we could not source are simply absent. */
  classes: string[];
}

export interface Line {
  id: string;
  name: string;
  operatorId: string;
  mode: 'metro' | 'suburban-rail' | 'monorail';
  /** 'fast' services genuinely skip stations, so they are separate lines with shortcut edges. */
  serviceClass: string;
  /** Light-mode stroke. Both modes are stored because dark is selected, not derived. */
  colour: string;
  colourDark: string;
  /** Composite encoding, so line identity never rests on colour alone. */
  dash: 'solid' | 'dashed';
  coverage: string;
}

export interface Station {
  id: number;
  name: string;
  shortName?: string;
  /** Matching key: lowercase, punctuation-free, stop-words removed. Never displayed. */
  norm: string;
  aliases: string[];
  lat: number;
  lon: number;
  operatorId: string;
  lineIds: string[];
}

/** Directed for storage convenience; the build emits both directions of every link. */
export interface Edge {
  from: number;
  to: number;
  lineId: string;
  distM: number;
  timeS: number;
  /** 'measured' along track, or an estimate. Feeds fare confidence. */
  quality: 'measured' | 'measured-snapped' | 'estimated-gap' | 'unlocatable';
}

/** A walk between two DISTINCT stations. Same-station line changes need no edge. */
export interface Interchange {
  a: number;
  b: number;
  walkTimeS: number;
  samePaidArea: boolean;
}

export interface FareSlab {
  /** Inclusive upper bound in km; null means "and beyond". */
  maxKm: number | null;
  farePaise: number;
}

export interface FareTable {
  operatorId: string;
  travelClass: string;
  confidence: Confidence;
  source: string;
  verifiedOn: string;
  slabs: FareSlab[];
}

export interface FareOverrideTable {
  operatorId: string;
  travelClass: string;
  confidence: Confidence;
  source: string;
  verifiedOn: string;
  /** Unordered station pair → exact published fare. Always beats the slab calculation. */
  pairs: { a: number; b: number; farePaise: number }[];
}

export interface DataSource {
  dataset: string;
  url: string;
  licence?: string;
  verifiedOn: string;
}

export interface TransitNetwork {
  version: string;
  builtAt: string;
  /** Shown in the app's About screen — an offline app must be able to state its own vintage. */
  dataSources: DataSource[];
  operators: Operator[];
  lines: Line[];
  stations: Station[];
  edges: Edge[];
  interchanges: Interchange[];
  fareTables: FareTable[];
  fareOverrides: FareOverrideTable[];
  /** Free-text notes surfaced in About, e.g. the Monorail suspension and fare caveats. */
  notices: { id: string; severity: 'info' | 'warning'; text: string }[];
}
