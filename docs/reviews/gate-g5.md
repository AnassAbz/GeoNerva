# G5 — Multi-source hazard ingestion

- **Date:** 2026-09-20
- **Verdict:** *pending the two independent reviews; this section is completed when they report.*
- **Commits:** `ed39648` → `dfc7d29` (5), plus this report
- **Tests:** 596 unit, 253 integration, against PostgreSQL 17 / PostGIS 3.4.3

## 1. The gate criteria, item by item

| Required | Evidence |
|---|---|
| More than one hazard family is ingested | **Five.** EARTHQUAKE (USGS, EMSC, GDACS), WILDFIRE_EVENT, FLOOD, TROPICAL_CYCLONE (GDACS), THERMAL_ACTIVITY (FIRMS), with VOLCANO and DROUGHT wired and polling (§2) |
| The adapter abstraction survives heterogeneous sources | It survived two of three unchanged and was **extended twice and tightened once** by the third. What bent, and why, is §3 |
| Source-specific semantics remain intact | Six places where a shared rule would have been wrong for one source, each resolved per source rather than by compromise (§4) |
| Credential boundaries are safe | FIRMS is the only credentialed source and puts its key in the URL *path*. Four layers, one integration test asserting the key is absent from the run row after a refused request (§5) |
| Drift detection works | Every captured drift fixture for all three sources behaves as its manifest says, plus two drift classes invented for this phase: silent truncation and field disappearance (§6) |
| Health reporting differentiates failure modes | §7 |
| All tests green | **596 unit, 253 integration** |
| No CRITICAL/HIGH remaining | §9 |

## 2. What is ingested, live

Every number here came from a real run against the real provider on 2026-09-20, into a real
PostgreSQL 17 / PostGIS 3.4.3.

| Source | Product | Live result | Repeat |
|---|---|---|---|
| EMSC | `rts` | 8 events in a 15-minute poll; 90 in a 6-hour one | 0 new, 7 unchanged; then `SKIPPED` |
| EMSC | `rts` (backfill) | 2010-01-01…05 **COMPLETED 4/4**, 439 records | 4/4 done, 0 new versions |
| GDACS | `EQ` | 14 | `SKIPPED` |
| GDACS | `TC` | 3 | `SKIPPED` |
| GDACS | `FL` | 4 | `SKIPPED` |
| GDACS | `WF` | 184 | `SKIPPED` |
| GDACS | `VO` / `DR` | 0 — a genuinely quiet day, reported as `SUCCEEDED` | — |
| FIRMS | `VIIRS_NOAA20_NRT` | **114,425** received, 114,422 new, in 6.6 s (9.5 MB) | 0 new, 114,425 already held |
| FIRMS | `VIIRS_NOAA21_NRT` | **121,293** received, 88,289 new | 0 new, 121,293 already held |

**Totals in the database after the session**, queried directly: 3,295 source records — USGS
2,561, EMSC 529, GDACS 205 — against **3,295 observation versions**, one each. By hazard:
EARTHQUAKE 3,104, WILDFIRE_EVENT 184, FLOOD 4, TROPICAL_CYCLONE 3, plus 4 role-tagged flood
geometries and **235,707 thermal detections** across two daily partitions.

Idempotency is the claim that matters and it is proved three ways: a repeated poll writes
nothing, an *overlapping* poll writes only the difference (EMSC's 6-hour window re-ingested 8
events as unchanged and added 82), and a repeated backfill walks no windows.

## 3. What the abstraction had to give

The honest answer to "did the adapter contract survive?" is: **mostly, and where it did not, the
break was informative.**

| Change | Forced by | Why not a workaround |
|---|---|---|
| `FetchResult` gains `NO_DATA` | EMSC answers HTTP 204 for an empty window | "The provider looked and found nothing" is a different fact from "the bytes are unchanged" and from "the body parsed to nothing". Collapsing it into either loses the only one of the three that is a statement about the world |
| `NormalizedRecord` gains `geometries` | GDACS floods | The database has supported role-tagged geometries since 0003 and nothing could reach them. A flood's modelled area is frequently the only thing that changes between episodes |
| `NormalizedRecord` gains `derivedFrom` | GDACS earthquakes | Also already in the schema, also unreachable. Without it, GDACS agreeing with USGS reads as two independent sources corroborating each other, when it is one NEIC solution quoted twice (ADR-030) |
| `severityScheme` tightened from `string` to `SeverityScheme` | A live batch of 79 wildfires refused by a CHECK | Every other database-constrained field on that interface was already a union. This one was the exception, and the exception cost a batch |
| `HistoricalInterface` extracted | EMSC's backfill | The G4 review recorded "the pipeline imports FDSN functions directly" and deliberately deferred it until there was a second implementation. There now is, and the two disagree on the question the backfill loop is built around — see §4 |
| **FIRMS is not a `SourceAdapter` at all** | 235,000 detections/day with no identity | §4 |

What did *not* change is more interesting: the six-step lifecycle, the batch verdict, the
all-or-nothing persist rule, the reject taxonomy, the content hash as sole change detector, and
the run row. Three sources with nothing in common at the protocol level share all of it.

## 4. Six places where one rule would have been wrong

This is the section the phase exists for. The plan's instruction was *"do not force every
provider into earthquake semantics"*, and each of these is a case where the tempting shared rule
is wrong for at least one source.

**1. HTTP 204 means opposite things.** For EMSC it is the FDSN standard "nothing matched" and is
ingested as a successful observation of emptiness. For GDACS it is what you get for *omitting
`alertlevel`* — P0 captured it, and it reproduced unchanged on 2026-09-20. One rule would have to
be wrong for one of them.

**2. "Too many rows" is loud for one service and silent for the other.** USGS FDSN refuses an
over-large query with HTTP 400. EMSC answers **HTTP 200 with exactly 20,000 rows and no marker of
any kind** (`limit=25000` → `metadata.count: 20000`). A splitter written against USGS behaviour
marks an over-large EMSC window `DONE` over a hole. `HistoricalInterface.isSizeRefusal` returning
`false` for every status is a real answer meaning "this service never refuses; trust the count".

**3. An empty batch is suspicious for some products and normal for others.** Wildfires and
earthquakes are always in progress somewhere — 258 concurrent GDACS wildfires, 27 earthquakes in
a day, 128,000 FIRMS detections per file — so zero is a broken read. Cyclones, volcanoes, floods
and droughts have genuinely quiet days. `emptyBatchIsSuspicious` is therefore set per product,
not per source.

**4. `severitydata.severity` is a different quantity per hazard.** A magnitude for EQ, km/h for
TC, hectares for WF, and a number that is `0` for every live flood. The *unit* decides which
quantity it is; a flattened "severity" column would put 5.2 and 8,214 side by side as if they
were comparable.

**5. A detection is not an observation.** FIRMS has no identifier, never revises, and produces
235,000 rows a day whose retention model is "drop the partition". Pushing them through
`observation_versions` would mean 235,000 content hashes and alias rows a day, and a
`source_records` table that is 99.9 % thermal pixels. `runFireIngestion` keeps the lifecycle and
replaces the persist step.

**6. A GDACS earthquake is not a second opinion.** 99 of 100 carry `source: NEIC` and a
`sourceid` that *is* the USGS event id. All 14 ingested live carry `derived_from: usgs`.

## 5. The credential boundary

FIRMS is the only source in v1 with a credential, and it puts the MAP_KEY **in the URL path** —
so the ordinary reflex of logging a failing URL would put a working key into a log aggregator.

| Layer | What it does |
|---|---|
| The key never reaches an observable string | `firmsEndpoint()` returns a path with a fixed `{MAP_KEY}` placeholder. Not a prefix: a partial key is a slow leak, and 32 characters of entropy do not need many samples |
| Errors are rebuilt, not rethrown | A `SourceFetchError` out of the client is reconstructed with `host` and `status` only |
| `redactFirmsUrl` | Removes anything matching the key's own alphabet and exact length from text on its way to a log line or a stored `error_message`. Applied in `failRun`, so it does not depend on the caller remembering |
| The key is validated before use | 32 lowercase alphanumerics, FIRMS's own rule. A key with a trailing newline from a copied secret is refused here rather than sent to NASA — and the refusal quotes nothing |

An **integration test** asserts that after a refused request the stored `error_message` contains
neither the key nor its first eight characters, while the HTTP status *does* reach the row,
because which refusal it was is diagnosable and carries nothing secret.

The build runs **keyless**: no `FIRMS_MAP_KEY` is configured, the public 24-hour files are used,
and the mode is part of every result rather than a silent degradation — the keyless files cannot
be backfilled and are not a strict 24 hours.

## 6. Drift detection

Every captured drift fixture for all three sources behaves as its manifest says: an HTML
maintenance page served with 200, a truncated body, a renamed field, a type change, a removed
required field, an emptied collection, and an unknown extra field that must be *tolerated*.

Two drift classes were added because this phase found the cases:

- **Silent truncation** (EMSC). A response arriving at the row cap cannot be distinguished from
  one that was cut off, so it is refused. The backfill sizes windows from `count` first, and this
  fires anyway, because "should never" is not a guarantee.
- **Field disappearance** (FIRMS, EMSC). A column or key that a provider *sometimes* omits cannot
  be required by the schema — EMSC omits `mag` on 2 of 97 bulletin events — so the rule moves to
  the batch: magnitudes vanishing wholesale is drift, a few per cent is the bulletin. ~2 % against
  100 % is a wide gap with no borderline case.

FIRMS reads its CSV **by header name**, never positionally, so a column inserted in the middle
does not shift every value one place. That guard was found **vacuous** by negative control and
rewritten — see §10.

## 7. Health reporting

The run row is where all four sources meet, and the distinctions `/data-status` can draw are:

| Situation | Status | Class | What it says |
|---|---|---|---|
| Provider had nothing (EMSC 204) | `SUCCEEDED` | — | We looked; the window is empty. `received = 0` |
| Byte-identical body | `SKIPPED` | — | Nothing new to examine |
| Provider down / slow | `FAILED` | `HTTP_5XX`, `TIMEOUT`, `NETWORK` | Theirs, transient |
| Shape changed | `FAILED` | `SCHEMA_DRIFT` | Nothing written; the batch is not trustworthy |
| Empty where empty is impossible | `FAILED` | `EMPTY_SUSPICIOUS` | A broken read, never "no hazards" |
| Window unreadable in one request | `FAILED` | `TOO_LARGE` | Split it |
| Credential refused / budget spent | `FAILED` | `CONFIG_ERROR` | **Ours**, never self-heals, worker exits 1 |
| Product switched off | `SKIPPED` | — | Deliberate, not a fault |
| Another worker holds it | *(no run row)* | — | A scheduler being early is not an event |

Backfill runs are excluded from live-poll health (the G4 fix), so a long backfill cannot make a
dead live feed read `FRESH`.

## 8. Defects found by running the code against the real world

Four, none of which any test would have caught, and each with a regression test:

| # | Found by | What was wrong |
|---|---|---|
| 1 | Live EMSC backfill | **73 % of a 2010 day rejected.** The GeoJSON z has *no stable sign*: EMSC-RTS publishes `z = -depth`, the EMSC-EMB bulletin publishes `z = +depth`. 78 of 97 records that day were EMB. The check that caught it assumed the RTS convention held everywhere; without any check, 78 depths would have been sign-inverted with every value still plausible |
| 2 | Live EMSC backfill | **EMSC omits the `mag` key** on some bulletin events rather than sending null |
| 3 | Live GDACS poll | **`severity_scheme` must be `GDACS_ALERT`.** A batch of 79 wildfires refused by the column's CHECK after a successful fetch, parse and normalize, because the contract typed the field as `string` |
| 4 | Live FIRMS poll | **One negative FRP killed a 121,293-row batch.** One NOAA-21 pixel at `frp = -0.1` against a `frp >= 0` CHECK. A real detection near the retrieval noise floor |

A fifth is about this code's own usability rather than its correctness: the FIRMS failure path
logged *"the batch could not be stored"* and nothing else, and diagnosing #4 meant rebuilding the
call by hand outside the worker. The SQLSTATE and constraint name are structural, contain nothing
about the connection, and are now kept.

## 9. Review findings

*Completed when the two independent reviews report.*

## 10. A test that was vacuous

Caught by deliberately breaking the code, and worth naming because the fixture invited it.

**FIRMS column-order safety.** The claim was "columns are read by name, so an inserted column
shifts nothing", and the evidence was the captured `drift-extra-column.csv` — which appends
`type` **after** the last column. Nothing shifts, so replacing the header lookup with a fixed
column order passed the test unchanged. The replacement inserts a column *in the middle*, which is
what a provider actually does when it adds a field, and fails without the header lookup: a
positional parser stores `bright_ti5` as `frp` and `frp` as `daynight`, every value still a
plausible number.

## 11. Deliberately not done

| Item | Why | Lands |
|---|---|---|
| GDACS cyclone tracks, wind buffers and volcano ash cones | They need `valid_at` semantics tied to advisory times, which is a temporal-modelling decision rather than an ingestion one. Floods are done because `has_area_geometry` is a *required* field that decides how an event is described | P6 |
| EMSC deletions | The service answers `includedeleted` with HTTP 400. Retractions are websocket-only and need a persistent worker. The seeded product does not claim `DELETIONS` and neither does the adapter | P1+ |
| GDACS RSS as a change trigger | `datemodified` is bulk-restamped, so it is not a change signal; the content hash is. The RSS would add a second parser and a second failure mode to avoid a poll that already costs one request per product | — |
| FIRMS with a MAP_KEY | No key is configured. The Area API path is written and validated, but **it has never been exercised against the live service**, and nothing here claims otherwise | When a key exists |
| A FIRMS retention job | `dropDetectionPartitionsBefore` exists and is tested; scheduling it belongs with the other periodic jobs | P10 |
| GDACS backfill | The event list is windowed and paged, but a 5-year backfill needs the page-skip question answered, and it cannot be answered from this API | P10 |
