/**
 * Overpass query definitions.
 *
 * Queries are intentionally BROAD — they pull in more than v1 ships, including
 * under-construction lines. Narrowing happens later against an explicit, human-reviewed
 * allowlist (`curated/lines.json`), not here. Filtering at fetch time would hide from us
 * the fact that, say, a new line has opened.
 */

/**
 * Mumbai metropolitan region: south, west, north, east.
 * Wide enough to include the suburban termini — Dahanu Road (19.98N), Kasara (73.48E),
 * Khopoli, Karjat, Panvel and Uran — which sit well outside Mumbai city proper.
 */
export const MMR_BBOX = '18.60,72.60,20.10,73.70' as const;

export interface DatasetQuery {
  name: string;
  description: string;
  query: string;
}

const q = (body: string, timeout = 180) => `[out:json][timeout:${timeout}];\n${body}\n(._;>>;);\nout body;`;

export const DATASETS: DatasetQuery[] = [
  {
    name: 'metro',
    description:
      'Mumbai Metro + Navi Mumbai Metro route relations. The network regex catches both, ' +
      'since "Navi Mumbai Metro" contains "Mumbai Metro"; they are separated later by tag.',
    query: q(`rel["route"="subway"]["network"~"Mumbai Metro",i](${MMR_BBOX});`),
  },
  {
    name: 'suburban',
    description:
      'Mumbai Suburban Railway route relations (Western, Central, Harbour, Trans-Harbour, ' +
      'Nerul–Uran, Vasai–Diva), including separate slow and fast service variants.',
    query: q(`rel["route"="train"]["network"~"Mumbai Suburban",i](${MMR_BBOX});`, 240),
  },
  {
    name: 'monorail',
    description:
      'Mumbai Monorail. Tagging is unverified — a route=monorail relation may not exist, so ' +
      'this also pulls railway=monorail ways and monorail station nodes as a fallback. ' +
      'Discovery query: inspect the result before trusting it.',
    query: q(
      `(
  rel["route"="monorail"](${MMR_BBOX});
  rel["route"="train"]["name"~"monorail",i](${MMR_BBOX});
  way["railway"="monorail"](${MMR_BBOX});
  node["station"="monorail"](${MMR_BBOX});
);`,
    ),
  },
];
