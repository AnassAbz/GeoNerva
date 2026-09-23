# GeoNerva — Testing Strategy

Testing is a product feature: GeoNerva's value is being *right about what it doesn't know*. Tests are deterministic. The clock and network are injected everywhere, and no test depends on a live API except the explicitly separate smoke suite.

## 1. Pyramid

```text
                    ▲  production smoke (post-deploy, ~10 checks)
                   ▲▲  live-API smoke (nightly CI, non-blocking for PRs)
                  ▲▲▲  E2E — Playwright (desktop + mobile viewports, seeded DB)       ~25 flows
                ▲▲▲▲▲  integration — real PostGIS (fixtures → pipeline → DB → API)   ~120 tests
             ▲▲▲▲▲▲▲▲  contract — adapters vs captured provider payloads               ~80 tests
       ▲▲▲▲▲▲▲▲▲▲▲▲▲▲  unit + property — pure engines (geo, correlation, clustering,
                       relevance, baselines, changes, templates, AI validator)        ~600 tests
```

CI order on every PR:
1. `typecheck`
2. `lint` + `depcruise` (architecture rules)
3. `unit`
4. `contract`
5. `integration` (PostGIS service container)
6. `build`
7. `e2e` (against a production build and a seeded DB)

Line coverage is not a gate. **Every rule table (relevance, correlation, change materiality, baseline minimums) must have a boundary test at each threshold on both sides**, and CI checks this by parsing the config files for thresholds.

## 2. Unit tests (pure packages)

| Package | What is tested | Representative edge cases |
|---|---|---|
| `geo` | Geodesic distance, bbox, antimeridian split, coordinate parsing (decimal, DMS, "31.63N 8W"), rounding, grid cells | Distance across ±180°; poles; `(0,0)`; lat 90.0001 rejected; lon 180 → −180; DMS with seconds 60 rejected |
| `sources/*` normalize | Field mapping, UTC parsing, unit conversions, `content_sha256` stability, volatile-field exclusion | GDACS dates without offset; USGS `mag: null`; negative depth (above sea level); EMSC `format=json` fields; FIRMS `acq_time` "5" → 00:05; VIIRS vs MODIS confidence |
| `correlation/earthquake` | Candidate filter, misfit, veto, uniqueness gap, identity refs, same-source rule, hysteresis | Two aftershocks 12 s / 20 km apart (must not merge); GDACS arrives before USGS alias; USGS id change `us…`→`pr…`; ΔM 1.3 veto; ML vs Mw halving; ties |
| `correlation/fire` | Union-find clustering, ID inheritance, merge, determinism under input permutation | Two clusters bridged by a new detection; detection exactly at ε; 48 h boundary; clusters across the antimeridian |
| `relevance/*` | Every rule boundary, modifiers, CRITICAL requires `authoritative_basis`, reasons carry evidence | M4.99 vs M5.0 at 50 km; depth 299 vs 300 km; fire at 10.0 km; flood centroid-only; cyclone forecast vs observed buffer |
| `baselines` | Mid-rank percentile, zero-heavy distributions, Mc (maximum curvature), minimum-sample gates, bands + hysteresis, ratio suppression | All reference windows zero; 51 vs 52 windows; 19 vs 20 events; mean 0.99 vs 1.0; sequence context trigger |
| `changes` | Each signal type, materiality thresholds, grouping, importance, prominence caps and hard rules, suppression reasons | ΔM 0.19 vs 0.2; late report flagged; EQ ages out silently; source stale on an uncovered family (no signal); >3 HEADLINE candidates |
| `briefing/templates` | Every template renders from typed inputs; banned-lexicon scan; no `undefined`/`NaN` in output | Unavailable vs not-covered vs insufficient history; plurals; 0 vs 1 |
| `ai/validator` | Evidence scope, number extraction/equality, echoed levels, lexicon, timestamps, verbatim-alert rule | "7" in text with no packet value; "5.30" vs 5.3; unit mismatch km vs mi; "safe" inside a quote; ID from another snapshot |
| `domain` | Evidence-ID codec round-trip, Zod schemas, invariants | Malformed IDs rejected |

## 3. Contract tests (adapters vs real payloads)

- `packages/test-fixtures/sources/<source>/` holds **captured, sanitized** real payloads, with a `MANIFEST.json` for each (URL, capture time, SHA256, notes).
- Each adapter has tests that:
  1. **parse** every fixture with zero unexpected rejects
  2. **normalize** to a committed golden snapshot (`*.golden.json`)
  3. assert the **batch verdict** on drift fixtures
- **Drift fixtures** (hand-derived from real ones): renamed field, type change (string magnitude), missing required field, extra unknown field (must be tolerated), empty collection, truncated body, HTML error page with 200 status, and a 204 (GDACS).
- **Schema pinning:** a nightly job re-downloads GDACS `swagger.json` and the FIRMS/EMSC WADL/OpenAPI docs and diffs them against committed copies. A diff opens an issue labelled `data-quality`.

Required fixture set:

| Source | Fixtures |
|---|---|
| USGS | `all_day` normal; event with `ids` change; `status automatic→reviewed` pair; deleted event via FDSN `includedeleted=only`; `mag null`; `tsunami=1`; PAGER alert; 20k-limit 400 response |
| EMSC | JSON page; update (`lastupdate` changed); delete (websocket sample for P1); the Morocco sample; `format=geojson` 400 |
| GDACS | RSS full; `geteventdata` EQ with `sourceid`; EQ whose sourceid resolves only via USGS `ids`; FL with `Poly_Affected` + `Poly_Global`; FL centroid-only; TC with tracks/buffers/cones; WF; VO; episode change Green→Orange; 204 empty; timeout |
| FIRMS | NOAA-20 and NOAA-21 world CSV slices; empty CSV (must → EMPTY_SUSPICIOUS); invalid MAP_KEY text response; midnight-spanning `DAY_RANGE=2`; `missing_data` response |
| Nominatim | search result; empty; 429 |

## 4. Integration tests (real PostGIS)

Runs against `postgis/postgis` (the same major version as production), with migrations applied from scratch each run. Tests share a truncate-between-tests helper.

Core flows:
1. **Fixture → pipeline → DB → API**: ingest USGS + EMSC + GDACS fixtures, then assert one canonical event with the correct links, agreement and headline source, then `GET /api/v1/events/:id` returns the expected document.
2. **Idempotency:** run each adapter twice on the same fixture and assert zero new versions, identical heads, and a `SKIPPED` or `unchanged` run.
3. **Revision:** ingest USGS v1 then v2 (M5.1→M5.3), assert 2 versions, then assert the briefing diff yields `EVENT_UPDATED` with evidence for both versions.
4. **USGS alias merge:** ingest two records that ComCat later associates, assert one survivor with a `merged_into` history, and assert the canonical links re-pointed with history kept.
5. **Spatial SQL:** radius, KNN, point-in-polygon and bbox (including the antimeridian) on a fixed set of known coordinates, compared with `geo` package results (tolerance 0.1 %).
6. **Health as-of:** synthesize run histories, then assert FRESH/DEGRADED/STALE/UNAVAILABLE at chosen times, and assert that the dashboard family is `UNAVAILABLE` (not empty) when FIRMS is STALE.
7. **Retention:** run the retention job on synthetic partitions, assert the drop, and assert that the replay horizon updates.
8. **As-of equivalence:** for random T and the full fixture corpus, assert `buildSnapshot` via heads/state caches equals `buildSnapshot` via as-of views when T = now.
9. **Migrations:** apply up from empty; apply on a DB seeded at the previous release; and require the `kysely-codegen` output to be clean.

## 5. End-to-end (Playwright)

Runs against a production build with a seeded scenario database (`packages/test-fixtures/scenarios/`), a fixed clock (`GEONERVA_FAKE_NOW`), and the map rendered in a WebGL2-capable browser plus one run with WebGL disabled.

Two clarifications from building it (P9, 2026-09-22), both of which this section originally got wrong:

- **The scenarios are TypeScript, not `*.sql`.** They write every row through the production repositories — content hashing, head pointers, alias resolution, ADR-041's coverage frontier — because raw SQL would need a second implementation of all of it, and a seeded row no ingestion run could have produced proves nothing about the read paths. `pnpm db:seed:scenario <name>` loads one; it truncates first, so it refuses any database whose name does not end in `_test`.
- **"FIRMS stale" means every fire source stale.** The outage flow below reads "FIRMS stale → the card shows unavailable", but `FIRE_ACTIVITY` covers `THERMAL_ACTIVITY` *and* `WILDFIRE_EVENT`, and `resolveAvailability` returns `ALL_SOURCES_UNUSABLE` only when **every** source of a family is unusable — correctly, because a fresh GDACS wildfire feed means GeoNerva can still say something. Staling FIRMS alone leaves the card `AVAILABLE`, so the scenario stales GDACS's `WF` feed with it. The flow is the availability rule, not FIRMS specifically.

| Flow | Viewports |
|---|---|
| Search "Marr" → suggestion → dashboard loads with headline, What Changed, cards | desktop, mobile |
| Coordinate entry `31.63, -8` and "Use my location" (mocked geolocation); URL shows rounded coordinates | desktop, mobile |
| Open event from What Changed → per-source values, agreement, timeline, evidence | desktop, mobile |
| Toggle map layers; keyboard-only operation of toggles | desktop |
| Evidence drawer / bottom sheet opens, links resolve | desktop, mobile |
| Source outage scenario: every fire source stale → card shows "unavailable", never "0" | desktop, mobile |
| Not-covered state (weather) and insufficient-history state | desktop |
| Window selector 6 h / 24 h / 7 d changes the diff | desktop |
| `as_of` URL shows replay banner and hides later data | desktop |
| WebGL disabled → page fully usable via list | desktop |
| Axe accessibility scan on every page (no serious/critical violations) | desktop, mobile |
| Layout: no horizontal scroll at 320 px; touch targets ≥ 44 px | mobile |

## 6. Invariants (property-based, fast-check, run in unit and integration suites)

| # | Invariant |
|---|---|
| I1 | `distance(a,b) ≥ 0`, `distance(a,a) = 0`, `distance(a,b) = distance(b,a)` |
| I2 | **Replay:** for any T, no read path returns a version, link, cluster version, run or snapshot input with `ingested_at`/`as_of` > T |
| I3 | Replay is monotone: a record visible at T1 is visible (possibly as a newer version) at T2 > T1 unless merged/deleted by a version with `ingested_at ≤ T2` |
| I4 | A canonical event never has records of more than one hazard type |
| I5 | A canonical event never has two active records from the same source |
| I6 | A source record has at most one active canonical link |
| I7 | Correlation and clustering results are invariant under input permutation |
| I8 | Ingesting the same batch twice changes nothing |
| I9 | Every evidence ID in a briefing exists in its manifest; every primary evidence ID resolves |
| I10 | Every `CRITICAL` relevance has an `authoritative_basis` |
| I11 | If a family's required source is STALE/UNAVAILABLE, that family's availability is `UNAVAILABLE` and no template for it renders a count of zero |
| I12 | Every AI claim that passes validation references only manifest evidence, and all its numbers match the packet |
| I13 | `observed_at ≤ ingested_at + 5 min` for all stored versions |
| I14 | Snapshot is a pure function: same (location, as_of, engine_version, DB state) → same `content_sha256` |
| I15 | No API response contains coordinates with more than 2 decimals for user-supplied locations |
| I16 | **Replay of derived state:** for any T, a fire cluster's membership is the assignments and merges known by T — changing a cluster after T never changes a replay of T, and an assignment with no knowledge time is in no replay (ADR-039, `packages/db/src/replay-membership.int.test.ts`) |

## 7. Data-quality invariants (runtime, in the worker)

These are checked after each run and reported on `/data-status`. They are not only tests:
- Share of versions with `observed_at` in the future (should be 0)
- USGS events per hour within historical bounds (catches silent feed truncation)
- FIRMS detections per poll > 0 globally (else EMPTY_SUSPICIOUS)
- Correlation: ambiguous rate < 5 %, and GDACS EQ unresolved references after 24 h = 0 (else alarm)
- Canonical events with CONFLICT agreement listed for review

## 8. AI output validation (P1)

- **Evaluation set:** 40+ packets covering quiet places, high-relevance events, conflicts, stale sources, not-covered families, and adversarial provider text ("Ignore previous instructions…" inside a GDACS title).
- **Validator unit tests** (§2) are the gate.
- **Offline eval** before changing prompt or model reports:
  - validator pass rate
  - Skeptic agreement
  - banned-lexicon hits (must be 0 after validation)
  - numeric mismatch rate
  - fallback rate
  - cost per briefing
- **Test with AI disabled:** the full E2E suite runs with `AI_MODE=disabled` (the default) and must be green.
- **Test with the model unavailable:** mock 500/timeout/refusal and assert that the templates render and nothing else changes.

## 9. Live smoke (nightly, `.github/workflows/live-smoke.yml`)

**What the workflow does today** (added in P10): it runs §10's nine post-deploy checks against the
deployment named by the `GEONERVA_SMOKE_URL` repository variable, and reports the 24-hour soak rate
beside them when a database secret is configured. With neither set it skips rather than failing, so
a repository without a deployment does not carry a red nightly cron.

**What is specified here and not built**: a per-source provider reachability check —

1. Fetch a minimal request.
2. Parse with the production adapter.
3. Assert verdict OK and the counts plausible.

— along with the OpenFreeMap style URL, Nominatim with our user agent (1 request), and FIRMS
`mapkey_status`. Failures of that kind would open or refresh an issue and never block PRs, since
provider outages are not our regressions. It is recorded as unbuilt rather than quietly dropped:
nothing in the repository contacts a provider on a schedule outside the worker itself.

## 10. Production smoke (post-deploy)

Implemented by `scripts/smoke.ts` (`pnpm smoke <base-url>`), which exits with the number of the
check that failed. Two checks are deliberately narrower than the wording below, each for a reason
given in its own docblock: check 2 requires only *enabled* sources to be available, because a
source this deployment has switched off is the "explicit known outage" the item allows for; and
check 3 asks by coordinate key rather than by name, so a deployment that has not imported the
gazetteer is not reported as having a broken briefing.

1. `/` 200 in under 2 s.
2. `/api/v1/sources/status`: each P0 source status ≠ UNAVAILABLE (or an explicit known outage).
3. A briefing for 3 curated places returns 200 with a manifest.
4. An event page resolves.
5. Evidence resolves.
6. Response headers: CSP present, HSTS, no `x-powered-by`.
7. Worker heartbeat < 3 min old.
8. `as_of` replay request returns the replay flag.
9. Mobile viewport render check.

## 11. Release gates (v1)

Automated:
- typecheck
- lint + depcruise
- unit
- contract
- integration
- e2e
- production build
- migration smoke

Then:
- live-API smoke
- scheduled-ingestion smoke (worker runs ≥ 24 h in staging with ≥ 99 % run success, excluding provider outages) — measured by `pnpm soak`, which also fails when too few non-provider runs exist for the rate to mean anything
- source-outage drill (block each provider host in staging and verify the UI)
- stale-data drill
- conflict drill (fixture USGS/EMSC CONFLICT)
- replay test
- mobile responsive test
- AI-disabled suite (+ AI-enabled if configured)
- production URL smoke
- three adversarial QA rounds with **no open CRITICAL/HIGH**
