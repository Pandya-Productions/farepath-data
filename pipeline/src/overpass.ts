/**
 * Overpass API client.
 *
 * Two rules this module exists to enforce:
 *   1. Overpass is queried at BUILD TIME ONLY. Nothing in the shipped app talks to it.
 *   2. Responses are cached to `raw/` and committed, so a build is reproducible and
 *      auditable months later even if OSM has moved on. Re-fetch is explicit (`--refresh`).
 *
 * Public Overpass instances rate-limit and occasionally return 429/504, so requests
 * rotate across mirrors with backoff rather than failing the build on a transient error.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OverpassResponse } from './osm-types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RAW_DIR = join(HERE, '..', 'raw');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 2_000;

export interface CacheMeta {
  /** The exact query used, so a stale cache can be told apart from a changed query. */
  query: string;
  endpoint: string;
  fetchedAt: string;
  /** OSM's own data timestamp — this, not fetchedAt, is the real data vintage. */
  osmTimestamp?: string;
  counts: { nodes: number; ways: number; relations: number };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function countElements(res: OverpassResponse) {
  let nodes = 0;
  let ways = 0;
  let relations = 0;
  for (const el of res.elements) {
    if (el.type === 'node') nodes++;
    else if (el.type === 'way') ways++;
    else if (el.type === 'relation') relations++;
  }
  return { nodes, ways, relations };
}

async function requestOnce(endpoint: string, query: string, timeoutMs: number): Promise<OverpassResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      headers: {
        // Overpass asks for a descriptive UA so instance operators can identify traffic.
        'User-Agent': 'FarePath-data-pipeline/0.1 (+https://github.com/farepath) build-time only',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    }

    const text = await res.text();
    let parsed: OverpassResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Overpass reports query errors as an HTML page with HTTP 200. Surface that clearly
      // rather than letting a JSON parse error masquerade as a network problem.
      throw new Error(`Non-JSON response (likely an Overpass query error): ${text.slice(0, 300)}`);
    }
    if (!Array.isArray(parsed.elements)) {
      throw new Error('Malformed Overpass response: missing `elements` array');
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a query against the Overpass mirrors, rotating endpoints and backing off on failure.
 * Throws only when every attempt has been exhausted.
 */
export async function runQuery(
  query: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ response: OverpassResponse; endpoint: string }> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const failures: string[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length]!;
    try {
      const response = await requestOnce(endpoint, query, timeoutMs);
      return { response, endpoint };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${endpoint}: ${message}`);
      // A malformed query will fail identically on every mirror — fail fast instead of
      // hammering three public instances six times.
      if (message.includes('Overpass query error')) break;
      if (attempt < MAX_ATTEMPTS - 1) {
        const wait = BASE_BACKOFF_MS * 2 ** attempt;
        console.warn(`  ! attempt ${attempt + 1} failed (${message.slice(0, 120)}); retrying in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }

  throw new Error(`Overpass query failed after ${MAX_ATTEMPTS} attempts:\n  ${failures.join('\n  ')}`);
}

const cachePaths = (name: string) => ({
  data: join(RAW_DIR, `${name}.json`),
  meta: join(RAW_DIR, `${name}.meta.json`),
});

export async function readCached(name: string): Promise<{ response: OverpassResponse; meta: CacheMeta } | null> {
  const { data, meta } = cachePaths(name);
  if (!existsSync(data) || !existsSync(meta)) return null;
  const [rawData, rawMeta] = await Promise.all([readFile(data, 'utf8'), readFile(meta, 'utf8')]);
  return { response: JSON.parse(rawData), meta: JSON.parse(rawMeta) };
}

/**
 * Fetch a named dataset, reusing the committed cache unless `refresh` is set or the
 * query text has changed since the cache was written.
 */
export async function fetchDataset(
  name: string,
  query: string,
  opts: { refresh?: boolean } = {},
): Promise<{ response: OverpassResponse; meta: CacheMeta; fromCache: boolean }> {
  const cached = await readCached(name);

  if (cached && !opts.refresh) {
    if (cached.meta.query.trim() === query.trim()) {
      console.log(`  = ${name}: cache hit (osm data ${cached.meta.osmTimestamp ?? 'unknown'})`);
      return { ...cached, fromCache: true };
    }
    console.log(`  ~ ${name}: query changed since cache was written — refetching`);
  }

  console.log(`  → ${name}: querying Overpass…`);
  const { response, endpoint } = await runQuery(query);
  const counts = countElements(response);
  const meta: CacheMeta = {
    query,
    endpoint,
    fetchedAt: new Date().toISOString(),
    osmTimestamp: response.osm3s?.timestamp_osm_base,
    counts,
  };

  await mkdir(RAW_DIR, { recursive: true });
  const paths = cachePaths(name);
  await writeFile(paths.data, JSON.stringify(response), 'utf8');
  await writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  console.log(
    `  ✓ ${name}: ${counts.relations} relations, ${counts.ways} ways, ${counts.nodes} nodes` +
      ` (osm data ${meta.osmTimestamp ?? 'unknown'})`,
  );
  return { response, meta, fromCache: false };
}
