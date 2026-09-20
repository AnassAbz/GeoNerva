# G5 — Multi-source hazard ingestion

- **Date:** 2026-09-20
- **Verdict: PASS.** Two independent reviews ran and found **10 HIGH** between them. Every one
  is fixed with a regression test; the MEDIUMs are fixed or recorded with a reason (§9).
- **Commits:** `ed39648` → `96980e6` — 8, plus this report
- **Tests:** 621 unit, 257 integration, against PostgreSQL 17 / PostGIS 3.4.3.
  One integration run failed 7 tests and has not reproduced in five since (§10).

## 1. The gate criteria, item by item

| Required | Evidence |
|---|---|
| More than one hazard family is ingested | **Five.** EARTHQUAKE (USGS, EMSC, GDACS), WILDFIRE_EVENT, FLOOD, TROPICAL_CYCLONE (GDACS), THERMAL_ACTIVITY (FIRMS), with VOLCANO and DROUGHT wired and polling (§2) |
| The adapter abstraction survives heterogeneous sources | It survived two of three unchanged and was **extended twice and tightened once** by the third. What bent, and why, is §3 |
| Source-specific semantics remain intact | Six places where a shared rule would have been wrong for one source, each resolved per source rather than by compromise (§4) |
| Credential boundaries are safe | FIRMS is the only credentialed source and puts its key in the URL *path*. Four layers, one integration test asserting the key is absent from the run row after a refused request (§5) |
| Drift detection works | Every captured drift fixture for all three sources behaves as its manifest says, plus two drift classes invented for this phase: silent truncation and field disappearance (§6) |
| Health reporting differentiates failure modes | §7 |
| All tests green | **621 unit, 257 integration** — with one unreproduced failing run recorded in §10 rather than dismissed |
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

### What the health model actually said

Derived from the real database at 2026-09-20T21:28Z, after the session's runs — not reasoned
about, queried:

```
product                      status        lastErrorClass  newestObserved            reason
eccc/weather-alerts          UNAVAILABLE   -               -                         DISABLED
emsc/rts                     DEGRADED      -               2026-09-20T20:24:05Z      POLL_AGEING
firms/VIIRS_NOAA20_NRT       FRESH         -               2026-09-20T18:17:00Z      OK
firms/VIIRS_NOAA21_NRT       FRESH         DB_ERROR        2026-09-20T18:56:00Z      OK
gdacs/EQ                     FRESH         DB_ERROR        2026-09-20T13:55:47Z      OK
gdacs/FL                     FRESH         SCHEMA_DRIFT    2026-09-18T01:00:00Z      OK
gdacs/VO                     FRESH         -               -                         OK
gdacs/DR                     FRESH         -               -                         OK
usgs/comcat                  UNAVAILABLE   -               -                         NEVER_SUCCEEDED
```

Five different things are being said there, and each is the truth:

- **`gdacs/VO` and `gdacs/DR` are `FRESH` with no observation at all.** The poll worked and there
  are no live volcanoes or droughts. That is the *unavailable ≠ empty ≠ unknown* rule visible in
  one row: a source that is working and has nothing to report does not look like a source that is
  down.
- **`emsc/rts` is `DEGRADED / POLL_AGEING`,** 56 minutes after its last poll against a policy that
  expects one every 5 and calls it stale at 60. Ageing, not failed — nothing is wrong yet.
- **`firms/VIIRS_NOAA21_NRT` is `FRESH` while still carrying `lastErrorClass: DB_ERROR`.** It
  failed on the negative FRP and then recovered. The current state and the last fault are
  different facts and are reported as different fields.
- **`eccc/weather-alerts` is `UNAVAILABLE / DISABLED`,** not "broken" — it is switched off in the
  database, which is the documented control surface.
- **`usgs/comcat` is `UNAVAILABLE / NEVER_SUCCEEDED`, and that is correct.** This database holds
  only `BACKFILL` and `RECONCILE` runs for USGS: a 439-record backfill and a deletion sweep both
  succeeded within the last three hours, and neither is evidence that the *live feed* works. This
  is the G4 HIGH finding — *"a backfill made a dead live feed read `FRESH`"* — demonstrably fixed,
  on live data, in the direction that costs us something rather than the direction that flatters.

## 8. Defects found by running the code against the real world

Four, none of which any test would have caught, and each with a regression test:

| # | Found by | What was wrong |
|---|---|---|
| 1 | Live EMSC backfill | **73 % of a 2010 day rejected.** The GeoJSON z has *no stable sign*: EMSC-RTS publishes `z = -depth`, the EMSC-EMB bulletin publishes `z = +depth`. 78 of 97 records that day were EMB. The check that caught it assumed the RTS convention held everywhere; without any check, 78 depths would have been sign-inverted with every value still plausible |
| 2 | Live EMSC backfill | **EMSC omits the `mag` key** on some bulletin events rather than sending null |
| 3 | Live GDACS poll | **`severity_scheme` must be `GDACS_ALERT`.** A batch of 79 wildfires refused by the column's CHECK after a successful fetch, parse and normalize, because the contract typed the field as `string` |
| 4 | Live FIRMS poll | **One negative FRP killed a 121,293-row batch.** One NOAA-21 pixel at `frp = -0.1` against a `frp >= 0` CHECK. A real detection near the retrieval noise floor |

Those four came from *running* the code. The two reviews then found ten more that running it had
not reached — §9 — which is the honest summary of what each kind of check is for: the live runs
found what the provider does, and the reviews found what this code does when the provider does
something else.

A fifth live finding is about this code's own usability rather than its correctness: the FIRMS failure path
logged *"the batch could not be stored"* and nothing else, and diagnosing #4 meant rebuilding the
call by hand outside the worker. The SQLSTATE and constraint name are structural, contain nothing
about the connection, and are now kept.

## 9. Review findings

Two independent reviewers: **A** on correctness and reliability, **B** on security, architecture
and honesty of representation. **10 HIGH** between them, and they found the GDACS flood defect
*independently of each other* — which is the strongest signal either of them produced.

Reviewer B also named the structural cause behind five of the ten, and it is worth stating on its
own because it explains the two failures that P5 had already hit live:

> `insertVersionIfChanged` validates exactly three things in application code — the hash length,
> invariant I13, the attributes size — and lets every other constraint be decided by Postgres.
> `run.ts` rescues only `VersionRejectedError` per record, and in Postgres a failed statement
> poisons the whole transaction anyway. **So every unanticipated constraint is batch-fatal.**

That is exactly what `severity_scheme = 'GDACS'` and `frp = -0.1` were: not two unlucky bugs, but
two instances of one gap. The answer taken here is to bound each value in the adapter, where a bad
one is a counted reject with a reason — and to do it for *every* field that lands in a constrained
column, rather than for the two that happened to be found.

### HIGH — all fixed, all with a regression test

| # | Found by | What was wrong |
|---|---|---|
| 1 | A | **An empty EMSC backfill window failed permanently.** The service runs the default `nodata=204`, so a quiet historical window returns 204 with no body; the backfill handed it to `parse`, `JSON.parse("")` threw, and the window was recorded `SCHEMA_DRIFT`. Nothing drifted — and resume resets the interval, so it failed identically forever and the plan could never complete. `--min-magnitude 6` over a day is an ordinary way to ask for a quiet window |
| 2 | **A and B, independently** | **A missing GDACS flood geometry killed the whole batch.** The error carried no `reasonCode`, making it batch-fatal, so one timed-out `getgeometry` on one flood out of sixteen took the FL product dark on *every* poll, permanently. Two comments in the code already claimed it was a reject; only the code disagreed |
| 3 | A | **GDACS returned a knowingly-partial list as complete.** A page that is 100/100 duplicates was read as "the sort has looped, so more pages cannot help" — backwards: it is the strongest evidence the unstable sort is also *skipping*. On such a day it committed 100 wildfires as a complete catalogue when there were 258 |
| 4 | A | **FIRMS understated its own counts.** `received` and `n_rejected` came from the bounded reject *sample*, so a drifted 128,000-row file reported 100 received and thousands of rows that became nothing left no trace — against the contract's own rule that nothing is skipped silently |
| 5 | A | **A partial insert reported `n_received = 0`.** A failing chunk leaves earlier rows committed, so 33,000 rows sat under a run whose row said it had received nothing |
| 6 | B | **FIRMS accepted a longitude the column refuses.** `lon <= 180` against `CHECK (lon < 180)` — and `roundCoordinate(179.99996)` *manufactures* exactly 180 from a legal value. VIIRS crosses the antimeridian every orbit |
| 7 | B | **FIRMS accepted any `acq_date` shape**, so `2099-01-01` created a daily partition that retention can never reclaim — it only drops days *older* than its cutoff. One poisoned row per poll would accrete catalogue bloat permanently |
| 8 | B | **GDACS `severity` and EMSC `mag`/`depth` were unbounded** into `numeric(4,2)` and `numeric(6,2)`. The same functions already range-checked the fields whose *Zod* schemas demanded it, and left unchecked the ones a *database* constraint bounds |
| 9 | B | **GeoJSON reached `ST_GeomFromGeoJSON` unvalidated.** Out-of-range coordinates and degenerate rings abort the transaction and lose the batch; a `crs` member is worse, because it does **not** raise — `ST_SetSRID` overwrites the SRID without reprojecting, silently relabelling the coordinates as WGS84 |
| 10 | B | **An unknown geometry class was asserted to be the affected area.** `isAreaFeature` admits any `Poly_` class by design, and the role mapping sent everything that was not `Poly_Global` to `affected_area` — so a cyclone wind buffer or a volcano ash cone would be stored and rendered as a flood's modelled impact zone |

Finding 2 is the one to dwell on. Both reviewers arrived at it from different directions, the
code's own comments asserted the opposite behaviour in two places, and the test that should have
caught it asserted only the error's *message*. A single message assertion is why a defect both
reviewers could see from the outside was invisible from the inside.

### MEDIUM — fixed

- **A refused batch reported only its rejects as `received`.** `ParseResult`'s `REJECTED` variant
  carried no way to say the number, so a batch of 100 good and 30 bad — correctly refused at the
  20 % threshold — was recorded as having received 30. The variant gained `receivedCount`, which
  is a contract change made in the direction of more information rather than less.
- **GDACS could not say "I looked and there is nothing".** A quiet `gdacs:VO` composes an
  identical empty document every poll, so it was `UNCHANGED` → SKIPPED forever — the exact
  collapse the contract argues against, two commits after EMSC got it right. Verified live: VO and
  DR now report SUCCEEDED with zero received.
- **A 204 and an empty 200 were treated alike.** For the four products whose
  `emptyBatchIsSuspicious` is false by design, a truncated 200 from a proxy therefore committed
  SUCCEEDED with zero received — unavailable rendered as empty.
- **`redactFirmsUrl` had three word-boundary bypasses.** `\b` treats `_` as a word character, so
  `MAP_KEY_<key>`, `key=<key>x` and `X<key>` were all invisible to it. A lookbehind fails the same
  cases for the opposite reason. Both were attempts to decide where the key ends; it now redacts
  the whole run of key-alphabet characters, and the literal key as well when the caller has it.
- **SECURITY.md M2 claimed two controls that did not exist**: a gzip ratio cap and a row-count
  cap. The ratio cap is not needed — the byte counter reads the already-decompressed stream, so a
  bomb is bounded by `maxBytes` rather than by its ratio — and M2 now says so. The FIRMS row cap
  genuinely was missing, and is now `MAX_CSV_ROWS`; EMSC and GDACS already had theirs.
- **`derivedFrom` claimed a USGS lineage from an inference.** It was written for any earthquake
  with any `sourceid`, on the evidence of three observed networks. If GDACS ever credits a
  non-ComCat source, correlation would attach a derived copy to a record that does not exist — or
  to the wrong earthquake. The claim now requires an id shaped like a ComCat id; the rest is kept
  as context with no lineage asserted.
- **`--feed` was silently dropped for FIRMS.** No validator existed, so an operator asking for
  five days after an outage got a normal two-day poll and a `SUCCEEDED` — precisely what that
  file's own rule about unknown flags forbids. It is validated as a `DAY_RANGE`, and refused
  outright in keyless mode, where it cannot mean anything.
- **The composed GDACS fetch reported a status it never received and a duration it never
  measured**: a hardcoded 200 even when the list ended on a 204, and only the list pages' time
  against a count that included up to 200 detail requests — so a run could claim 201 attempts in
  300 ms.
- **The paging overlap evidence was computed and discarded.** `rows - features.length` is the only
  overlap signal this API yields, and given that an unstable sort is GDACS's central risk it is
  the most diagnostic number the adapter produces. It now reaches the log line.
- **`intervalsSplit` counted splits that never happened**, because it was incremented before
  `splitWindow`, which throws at the floor — so the one window an operator was investigating
  reported a split it never got. Splits also now count against `--max-intervals`, which they did
  not, so a deeply splitting range could make far more requests than were asked for.
- **The FIRMS failure path could throw out of its own catch**: `finishRun` refuses a run whose
  lease was taken over, and that refusal became an unhandled rejection with no run row at all.

### Recorded, not fixed

| Finding | Why |
|---|---|
| `runFireIngestion` names FIRMS directly (B11) | The reviewer proposed a `DetectionSourceAdapter` interface and called `HistoricalInterface` the right precedent — which is the argument for waiting: that interface was deferred at G4 precisely until there was a second implementation to abstract *over*, and it earned its shape from the disagreement EMSC turned out to have with USGS. There is no second detection source. The lifecycle in that file is already provider-agnostic; what is not is four imports. Worth doing when FIRMS moves its key to a header or a second sensor family arrives, and not before |
| Keyless FIRMS declares `HISTORICAL_EVENTS` (B13) | The capability is a property of the *product*, which can be backfilled with a key, and it is asserted to match the seeded row. What was genuinely wrong — that an operator could not tell which mode produced a gap — is addressed by refusing `--feed` without a key and by the mode appearing in the outcome and the endpoint. Recording it in `ingestion_runs` needs a column and a migration, which belongs with the retention and scheduling work rather than here |
| Unbounded memory on the FIRMS path (B7) | Real, and bounded now rather than closed: the 64 MB body cap plus `MAX_CSV_ROWS` bound the input, but a large file is still materialised as a string, a detection array and a mapped insert array. Streaming the parse into chunked inserts is the actual fix and is a rewrite of the FIRMS persist path; the caps make the worst case survivable in the meantime |
| `real` columns accept a float4 overflow (B14) | `1e39` into a `real` raises before any CHECK. The same class as finding 8 and the same answer, but it needs a bound per numeric FIRMS column rather than per earthquake field; the parser already refuses the values that occur |
| `seq` is a `smallint` computed with an O(n²) filter (B15) | The filter is gone (a running counter per role), and the overflow needs more than 32,767 shapes of one role, which the 512 KB geometry cap makes unreachable |
| EMSC records `lifecycleStatus: ACTIVE` for 2010 bulletin events (B16) | Sound as far as the adapter goes — EMSC publishes no lifecycle and inventing one would be worse — but `ACTIVE` is not a neutral word and a sixteen-year-old solution reads as ongoing. There is no `UNKNOWN` in `LIFECYCLE_STATUSES`, so this is a domain-vocabulary gap rather than an adapter bug, and widening a frozen enum is not a thing to do inside a source adapter |
| `HttpResponse.url` carries the full FIRMS URL (B6, noted) | Nothing on the FIRMS path reads it, and the reviewer described it accurately as "a loaded gun on the table". Excluding it for a credentialed descriptor is a change to the shared HTTP client for a hazard that does not currently exist |

## 10. A failing run that has not reproduced

One integration run failed **7 of 257** tests. It has not reproduced in **five** subsequent full
runs, all 257/257.

What is known: it started within seconds of a live FIRMS poll that had just read a 116,503-row
file and checked every row against the same PostgreSQL instance the test databases live on. The
five clean runs since were against an idle instance. The most likely cause is contention — the
integration suite creates and drops databases and runs every migration per file, and
`partition-repair` takes an `ACCESS EXCLUSIVE` lock under a lock timeout.

What is **not** known: which seven tests, because the failure was not captured before the run
scrolled. That is a process failure and it is recorded as one.

This is written here rather than dropped because "five clean runs" is not the same statement as
"the suite is green", and the difference is exactly the kind of thing this project exists to keep
visible. A run that failed once and cannot be explained is an open question, not a non-event. The
G4 gate found a flake of precisely this shape — a `hookTimeout` that only bit once the suite grew
past 100 s — and it presented the same way: unrelated tests failing at random.

Next time it happens the output is captured first.

## 11. Five tests that were vacuous

All five were caught by deliberately breaking the code — four of them because a reviewer said to
look, one before the reviews. A test that cannot fail is worse than no test, because it is counted
as one.

**FIRMS column-order safety.** The claim was "columns are read by name, so an inserted column
shifts nothing", and the evidence was the captured `drift-extra-column.csv` — which appends
`type` **after** the last column. Nothing shifts, so replacing the header lookup with a fixed
column order passed the test unchanged. The replacement inserts a column *in the middle*, which is
what a provider actually does when it adds a field, and fails without the header lookup: a
positional parser stores `bright_ti5` as `frp` and `frp` as `daynight`, every value still a
plausible number.

**The GDACS flood refusal** asserted only the error's message text, so adding a `reasonCode` —
the opposite of the shipped behaviour, and the fix for HIGH #2 — passed it unchanged. It now
asserts `isRecordLevel`, which is the property that decides whether one flood or the whole batch
is lost. This is the test that should have caught a defect both reviewers found from the outside.

**The EMSC small-batch guard** used one missing magnitude out of three: a ratio of 0.33, which is
below the 0.5 threshold *anyway*, so deleting the guard entirely passed it. Its sibling used 40 of
40 — a ratio of 1.0 — so the threshold could be moved anywhere below 1 and still pass. Neither
side was pinned. They now use 2 of 3 (above the threshold, saved only by the floor) and 11 and 9
of 20, which bracket the threshold from both directions.

**Three "is idempotent" tests** parsed the *same bytes* twice through a function with no clock, no
IO and no randomness, and asserted the results matched. No mutation of any parser or normalizer
could fail them. Each is replaced with the property it was reaching for: for EMSC, that the two
serializers the service actually uses produce one hash; for FIRMS, that two spellings of one pixel
collapse to one identity.

**The FIRMS count identity** asserted `received = inserted + duplicates` against a reject-free
fixture — arithmetically unfalsifiable, since `duplicates` is *defined* as
`detections.length - inserted`. The real invariant includes the reject term, and there is now a
fixture with rejects in it to exercise it.

**The GDACS fetch layer had no tests at all** — not page termination, not the refusals, not the
cross-page dedupe, not the geometry cap. Three of the ten HIGH findings lived in that gap. It has
thirteen tests now.

## 12. Deliberately not done

| Item | Why | Lands |
|---|---|---|
| GDACS cyclone tracks, wind buffers and volcano ash cones | They need `valid_at` semantics tied to advisory times, which is a temporal-modelling decision rather than an ingestion one. Floods are done because `has_area_geometry` is a *required* field that decides how an event is described | P6 |
| EMSC deletions | The service answers `includedeleted` with HTTP 400. Retractions are websocket-only and need a persistent worker. The seeded product does not claim `DELETIONS` and neither does the adapter | P1+ |
| GDACS RSS as a change trigger | `datemodified` is bulk-restamped, so it is not a change signal; the content hash is. The RSS would add a second parser and a second failure mode to avoid a poll that already costs one request per product | — |
| FIRMS with a MAP_KEY | No key is configured. The Area API path is written and validated, but **it has never been exercised against the live service**, and nothing here claims otherwise | When a key exists |
| A FIRMS retention job | `dropDetectionPartitionsBefore` exists and is tested; scheduling it belongs with the other periodic jobs | P10 |
| GDACS backfill | The event list is windowed and paged, but a 5-year backfill needs the page-skip question answered, and it cannot be answered from this API | P10 |
