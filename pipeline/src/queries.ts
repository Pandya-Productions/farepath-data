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

/**
 * Bounding box for the PLACE index. Deliberately tighter than MMR_BBOX: a landmark is only
 * useful if a station is walkable from it, and the far Kasara/Khopoli branches are rural.
 */
export const MUMBAI_URBAN_BBOX = '18.85,72.75,19.35,73.10' as const;

/**
 * Queries for the address/landmark layer.
 *
 * Mumbai has almost no street addresses in OSM — measured, 7,552 features carry a house number
 * for a city of 20 million. That is not a data gap so much as how the city works: people navigate
 * by locality and landmark ("Phoenix Mills, Lower Parel"), not house number. So the index is built
 * from the three layers that DO exist and that people actually say out loud.
 *
 * `out tags center` returns a centroid for ways and relations without their geometry, which keeps
 * the responses small — we only ever need a point per place.
 */
export const PLACE_DATASETS: DatasetQuery[] = [
  {
    name: 'places-localities',
    description:
      'Suburbs, neighbourhoods and villages — the highest-value layer for Mumbai, since an ' +
      'address here is usually an area name plus a landmark.',
    query:
      `[out:json][timeout:180];\n` +
      `nwr["place"~"^(suburb|neighbourhood|locality|quarter|village|town)$"]["name"](${MUMBAI_URBAN_BBOX});\n` +
      `out tags center;`,
  },
  {
    name: 'places-landmarks',
    description: 'Named amenities, shops, offices, malls, hospitals, colleges and notable buildings.',
    query:
      `[out:json][timeout:240];\n` +
      `(\n` +
      `  nwr["amenity"]["name"](${MUMBAI_URBAN_BBOX});\n` +
      `  nwr["shop"]["name"](${MUMBAI_URBAN_BBOX});\n` +
      `  nwr["office"]["name"](${MUMBAI_URBAN_BBOX});\n` +
      `  nwr["tourism"]["name"](${MUMBAI_URBAN_BBOX});\n` +
      `  nwr["leisure"]["name"](${MUMBAI_URBAN_BBOX});\n` +
      `  nwr["healthcare"]["name"](${MUMBAI_URBAN_BBOX});\n` +
      `  nwr["building"]["name"](${MUMBAI_URBAN_BBOX});\n` +
      `);\n` +
      `out tags center;`,
  },
  {
    name: 'places-streets',
    description:
      'Named streets. Stored as a centroid, which is imprecise for a long road — flagged in the ' +
      'data so the UI can say so rather than implying a precise point.',
    query:
      `[out:json][timeout:240];\n` +
      `way["highway"]["name"](${MUMBAI_URBAN_BBOX});\n` +
      `out tags center;`,
  },
];
