# FarePath transit data

The transit dataset used by the **FarePath** Android app, published openly under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/), together with the full
pipeline that produces it.

This repository exists for two reasons. The first is a licence obligation: the dataset is derived
from OpenStreetMap, which makes it a **Derivative Database** under ODbL, and share-alike requires it
be offered to anyone who received it. The second is that a fare app should be auditable — if the app
tells you a journey costs ₹40, you should be able to see where that number came from.

## Attribution

Station, line and track-geometry data **© OpenStreetMap contributors**, licensed under
**ODbL 1.0**. Fare figures are facts sourced from transit operators, cited per table in
`pipeline/curated/fares/`.

FarePath is **not affiliated with or endorsed by** MMRDA, MMRC, MMOPL, MMMOCL, CIDCO, Indian
Railways, or any transit operator.

## What's here

```
data/transit.json     The shipped dataset — 218 stations, 19 services, 6 operators (96 KB)
data/layout.json      Pre-computed schematic map coordinates
data/layout.svg       The schematic map, viewable in any browser
pipeline/             Everything needed to rebuild data/ from scratch
pipeline/curated/     Human decisions, each with a recorded reason
pipeline/raw/         Cached Overpass responses, committed so builds are reproducible
privacy-policy.md     The app's privacy policy
```

## Rebuilding it

Requires **Node 22.6+** and nothing else — no dependencies, no build step. The pipeline runs on
Node's native TypeScript support.

```bash
cd pipeline
node --experimental-strip-types src/fetch.ts      # Overpass → raw/  (only script that uses the network)
node --experimental-strip-types src/inspect.ts    # evidence report for curation
node --experimental-strip-types src/extract.ts    # assertions + along-track distance measurement
node --experimental-strip-types src/cluster.ts    # station identity + interchange candidates
node --experimental-strip-types src/build.ts      # → out/transit.json
node --experimental-strip-types src/layout.ts     # → out/layout.json + layout.svg
node --experimental-strip-types --test src/*.test.ts
```

`fetch.ts` reuses the committed cache unless you pass `--refresh`, so a rebuild is deterministic and
does not depend on OSM being unchanged.

## How the data is put together

**Topology comes from OpenStreetMap, at build time only.** There is no usable GTFS feed for Mumbai —
the old BEST and Metro feeds died with GTFS Data Exchange in 2016. The app never contacts Overpass
or anything else at runtime.

**Distances are measured along real track geometry**, not straight lines. On a distance-slab fare
system the measured distance *is* the fare, and a straight line under-reports on curved alignments,
which would under-charge the user in the app while the counter charges the real amount.

**Nothing is merged or connected automatically.** Two stations become one only if their normalised
names match *and* they are within 250 m *and* they share an operator. Walk interchanges are proposed
by the pipeline and then confirmed by hand, because whether a transfer exists and how long it takes
are real-world facts. Every curated decision in `pipeline/curated/` carries its reason.

**The build fails rather than shipping quietly.** Pinned OSM relations are asserted against their
ref, name, stop count and published route length; the routable network must be fully connected; no
operating operator may lack a fare source; the size budget is enforced.

## Fare data quality — read this before trusting a number

Each fare table in `pipeline/curated/fares/slabs.json` carries a `confidence`, a `source` and a
`verifiedOn` date. `estimated` means the minimum and maximum are sourced but the intermediate slab
boundaries are inferred, and the app labels those fares approximate.

Current state:

| Operator | Confidence | Note |
|---|---|---|
| Metro Line 3 (MMRC) | **verified** | Reproduces the published Aarey→Cuffe Parade ₹60 exactly |
| Monorail (MMRDA) | **verified** | Official 17×17 station-pair matrix. Services suspended since 2025-09-20 |
| Metro Line 1 (MMOPL) | estimated | Range and one station pair sourced; boundaries inferred |
| Metro 2A/2B/7/9 (MMMOCL) | estimated | Only the ₹10 min and ₹50 max are sourced |
| Navi Mumbai Metro | estimated | Sources disagree on the maximum (₹30 vs ₹40) |
| Suburban 2nd class | estimated | **Largest known gap** — see below |

**The suburban second-class table is the one to be sceptical about.** Indian Railways publishes
`Suburban Fare table ST.pdf` and `CT.pdf` at `wr.indianrailways.gov.in`, but those hosts refuse
connections from outside India, so the primary chart could not be retrieved. The shipped slabs are
the standard Railway Board progression and match every data point that could be checked
independently, but they are **not confirmed against the official chart**. First class and AC fares
are omitted entirely rather than guessed.

If you can retrieve those PDFs, a correction is very welcome.

## Contributing corrections

Corrections to fares, station names, missing stations or interchange walk times are welcome — open
an issue or a pull request against `pipeline/curated/`. Please include a source. Corrections with a
primary source will be applied and the relevant `confidence` raised.

The transit operators' posted fares always govern. If this data and a ticket window disagree, the
ticket window is right and this repository has a bug.
