# Fixture capture scripts (P0)

Dependency-free Node ESM scripts that capture the real provider payloads under
`packages/test-fixtures/sources/<source>/` and keep a `MANIFEST.json` per source
(`file, url (keys redacted), captured_at, sha256, bytes, http_status, content_type, notes, synthetic, derived_from`).

Requirements: Node ≥ 22 (developed on Node 24). No npm install. Run from the repository root.

## Politeness

All requests go through `lib.mjs#politeFetch`:
- sequential, ≥ 1 s between requests to the same host (1.1 s for `www.seismicportal.eu`, 1.5 s for Nominatim);
- timeouts; identifying User-Agent `GeoNerva-fixture-capture/0.1 (open-source hazard-intelligence project)`;
- no personal data, no API keys (there is no FIRMS MAP_KEY in P0; key-dependent endpoints are called with `INVALIDKEY000`).

Do not run two scripts that hit the same host at the same time.

## Scripts

| Script | What | Requests |
|---|---|---|
| `capture-usgs.mjs main` | all_day, alias query, superseded detail, deleted (list + 409), mag null, tsunami, PAGER, 20k 400, count | ~11 |
| `capture-usgs.mjs revisions` | ≥ 1 h after `main`: second all_day poll, stores changed features as `revision-t0/t1.geojson` | 1 |
| `capture-emsc.mjs main` | JSON page, updatedafter poll (t0), Morocco, late update, geojson 400, 204 | 7 |
| `capture-emsc.mjs revisions` | ≥ 1 h after `main`: updatedafter again, stores real revisions as `revision-t0/t1.json` | 1 |
| `capture-emsc.mjs ws [secs]` | listens to the realtime websocket, stores raw frames | websocket |
| `capture-gdacs.mjs main` (`v2`) | RSS (trimmed), EQ/TC/FL/WF/VO event data + geometry, episodes, 204, `latest` (V2) | ~40 |
| `capture-firms.mjs main` | keyless NOAA-20/21 24 h CSV slices, USA slice, invalid-key responses, missing-data table | 9 (≈ 21 MB download) |
| `capture-nominatim.mjs main` | one search, one empty search (the 429 is synthetic) | 2 |
| `capture-eccc.mjs pair` / `poll <label>` / `analyze <a> <b>` | GeoMet `weather-alerts` polls for V1 | 1 per poll |
| `derive-drift.mjs` | offline: synthetic drift fixtures (renamed/type change/missing/extra/empty/truncated/HTML-200), GDACS alias-only and centroid-only floods, timeout descriptor, Nominatim 429 | 0 |
| `build-eq-pairs.mjs [--review]` | labelled USGS↔EMSC correlation set → `sources/correlation/eq-pairs.json` (uses `eq-pairs-hand-checks.json`) | ≈ 400, cached in `$TMPDIR/geonerva-eq-pairs-cache` |
| `demo-coverage.mjs [--skip-firms]` | demo-place coverage (Q5) → `sources/coverage/demo-coverage.json` | ≈ 200 (≈ 100 MB FIRMS download) |
| `verify-manifests.mjs [--prune]` | re-hashes every fixture, checks manifest fields, parseability (JSON/NDJSON/CSV/XML), secrets, total size ≤ 6 MB | 0 |

Order for a full refresh:

```sh
node scripts/capture-fixtures/capture-usgs.mjs main
node scripts/capture-fixtures/capture-emsc.mjs main
node scripts/capture-fixtures/capture-gdacs.mjs main
node scripts/capture-fixtures/capture-firms.mjs main
node scripts/capture-fixtures/capture-nominatim.mjs main
node scripts/capture-fixtures/capture-eccc.mjs pair
node scripts/capture-fixtures/derive-drift.mjs          # after the captures it derives from
# >= 1 hour later:
node scripts/capture-fixtures/capture-usgs.mjs revisions
node scripts/capture-fixtures/capture-emsc.mjs revisions
node scripts/capture-fixtures/build-eq-pairs.mjs
node scripts/capture-fixtures/demo-coverage.mjs
node scripts/capture-fixtures/verify-manifests.mjs --prune
```

## Rules

- Fixtures are byte-exact provider bodies. Large payloads are trimmed deterministically (whole
  features / CSV lines / RSS items kept verbatim, see `lib.mjs#trimFeatureCollection`) and the trimming
  is described in the manifest `notes`. `packages/test-fixtures/sources/.gitattributes` disables EOL
  normalisation so hashes survive checkout on any OS.
- Anything not served by a provider is `synthetic: true` with `derived_from`.
- Event IDs used by the scripts were chosen from live data on 2026-09-19 and are pinned in the scripts;
  a rerun months later may need new IDs (providers age events out of feeds).
