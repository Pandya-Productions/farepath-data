/**
 * Stage 1 of the pipeline: fetch raw OSM data into the committed `raw/` cache.
 *
 *   node --experimental-strip-types src/fetch.ts            # use cache where valid
 *   node --experimental-strip-types src/fetch.ts --refresh   # force re-query
 *
 * This is the only script in the repo that touches the network.
 */

import { DATASETS, PLACE_DATASETS } from './queries.ts';
import { fetchDataset } from './overpass.ts';

async function main() {
  const refresh = process.argv.includes('--refresh');
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);

  // --places pulls the address/landmark layer, which is large and changes rarely, so it is not
  // fetched by default alongside the transit topology.
  const all = process.argv.includes('--places') ? [...DATASETS, ...PLACE_DATASETS] : DATASETS;
  const datasets = only ? all.filter((d) => d.name === only) : all;
  if (datasets.length === 0) {
    console.error(`No dataset matched --only=${only}. Known: ${[...DATASETS, ...PLACE_DATASETS].map((d) => d.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`Fetching ${datasets.length} dataset(s)${refresh ? ' (forced refresh)' : ''}\n`);

  let failed = 0;
  for (const dataset of datasets) {
    console.log(`${dataset.name} — ${dataset.description}`);
    try {
      // Sequential on purpose: these are shared public Overpass instances and
      // parallel heavy queries are how you get rate-limited.
      await fetchDataset(dataset.name, dataset.query, { refresh });
    } catch (err) {
      failed++;
      console.error(`  ✗ ${dataset.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log('');
  }

  if (failed > 0) {
    console.error(`${failed} dataset(s) failed. Re-run to retry; cached datasets will be reused.`);
    process.exit(1);
  }
  console.log('All datasets present in raw/. Next: npm run inspect');
}

await main();
