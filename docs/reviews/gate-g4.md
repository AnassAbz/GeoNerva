# G4 — Historical earthquake ingestion and reconciliation

- **Date:** 2026-09-20
- **Verdict: PASS.** Two independent reviews ran; every CRITICAL and HIGH is fixed with a
  regression test, and the MEDIUMs are fixed or recorded with a reason (§5).
- **Commits:** `a17fd09` → `41e227d` — 15, plus this report
- **Tests:** 501 unit, 238 integration, green across three consecutive full runs.

## 1. The gate criteria, item by item

| Required | Evidence |
|---|---|
| Historical earthquake ingestion works | **Live FDSN**: 2,266 events over June–August 2026 (M ≥ 4.5) in 17.5 s, four windows |
| Backfills resume | A bounded run leaves the rest `PENDING`; the next invocation processes only those. Tested, and the same shape as a crash |
| Overlapping runs do not duplicate facts | **Live**: a Jul–Oct range overlapping Jun–Sep re-ingested 1,555 events as `unchanged` and added 295. **2,561 records, 2,561 versions — one each** |
| Live ↔ FDSN reconciliation works | Both directions tested, plus an event whose preferred id differs between the interfaces (`us7000tiar` → `pr2026261000`) and a revision seen across them |
| Storage policy exists | **ADR-033** — retention by window; a backfill stores the digest without the body |
| Representative storage measurement | **1,865 B/event**, measured from the real backfill (§3) |
| Projected storage acceptable | Only after **ADR-034** narrowed the catalogue. The documented one did not fit (§3) |
| No CRITICAL/HIGH remaining | §5 |
| All tests green | **501 unit, 238 integration** against PostgreSQL 17 / PostGIS 3.4.3 |

## 2. What was built

- **FDSN query layer** (`packages/sources/src/usgs/fdsn.ts`) — typed, validated, closed parameter
  set. No query-string passthrough: a passthrough would turn this into an arbitrary outbound
  request to a host the allowlist has already approved.
- **Deterministic window planner** — half-open windows that tile a range exactly, deterministic
  splitting, an explicit floor rather than an infinite subdivision.
- **Checkpointed backfill** (migration 0012, `packages/pipeline/src/backfill.ts`) — the plan lives
  in the database; the checkpoint is written inside the transaction that commits the window's
  facts.
- **Deletion reconcile** — `includedeleted=only` → tombstone versions.
- **`geonerva-worker backfill`** — resumable by re-running; exits 2 while work remains.

## 3. Storage: measured, and it changed the plan

Measured from the real 2,266-event backfill under ADR-033:

| Table | Per event |
|---|---|
| `observation_versions` | 1,085 B |
| `raw_source_records` | 231 B |
| `source_records` | 199 B |
| `source_record_aliases` | 184 B |
| `source_record_heads` | 166 B |
| **Total** | **1,865 B** |

ADR-033 works: **32 % below P3's 2,735 B**, with the raw table down from 1,269 B/event to 231.

What it did not do is make the *planned* catalogue fit. The FDSN `count` endpoint — asked, not
estimated — says **M ≥ 4.5 since 2000 is 187,173 events = 333 MB**, two-thirds of a 500 MB budget
for one source, before EMSC, fire or places. **ADR-034** narrows the lean v1 catalogue to
**M ≥ 4.5 since 2016** (79,929 events, 142 MB) plus the last 30 days at all magnitudes (11,015,
20 MB), and reserves ~125 MB for EMSC that P5 must measure against.

*Caveat:* 1,865 B/event was measured on a 2,266-row table where index pages are lumpy. At 80,000
rows the per-row cost usually falls, so 142 MB is a conservative ceiling. Re-measure after the
real backfill.

## 4. Bugs found and fixed

Each has a regression test; the ones marked ✓ were proven to fail without the fix.

| # | Found by | What |
|---|---|---|
| 1 | Testing | An empty historical window failed as `EMPTY_SUSPICIOUS`. An empty live `all_day` is a broken feed; a quiet Tuesday in a narrow magnitude band is not |
| 2 | Testing | The post-persist drift re-check read `adapter.descriptor` while parse read the effective one — two copies of one rule disagreeing |
| 3 | Testing | A 400 never reached the orchestrator's catch, because `runIngestion` converts a fetch failure into a committed FAILED run. `RunOutcome` now carries the HTTP status |
| 4 | Testing | Permanent failures (unsplittable window, unparseable shape) were retried three times to rediscover the same answer |
| 5 | Self-review ✓ | **A `LEASE_HELD` outcome left the interval `PENDING`, so the loop claimed it again — forever.** Without the fix the test runs to a 30 s timeout |
| 6 | Self-review | Re-requesting a range with a different `--window-days` added a second, overlapping set of intervals to the same plan |
| 7 | G3 carry-over ✓ | `rebuildHeads` ordered by `ingested_at` before `version_seq`; with an older window arriving after a newer one it picks the wrong head |
| 8 | Reading the data | Codegen was introspecting PostGIS's `tiger` schema — 35 extension tables |

**The finding that shaped the phase:** re-reading the P0 deletion capture showed that **55 of 98
deleted events have an empty `id` and null `ids`, `net` and `code`** — USGS purges an event's
metadata when it deletes it. A sweep is therefore ~56 % unidentifiable in normal operation, the
20 % drift threshold cannot apply to it, and the live schema's non-empty `id` is right for the
feed and wrong for this endpoint. Those entries are counted as `MISSING_IDENTITY` rejects; a sweep
in which *nothing* is identifiable does fail, because that means we are blind to deletions.
`DATA_SOURCES.md` §1.4 corrected.

## 5. Review findings

Two independent reviewers: **A** on correctness and reliability, **B** on security and
architecture. Between them **8 HIGH** and **14 MEDIUM/LOW**. All HIGH are fixed. The reviews were
worth more than the implementation that preceded them.

### HIGH — all fixed, all with a regression test

| # | Found by | What was wrong |
|---|---|---|
| 1 | A, B | **`--deleted-only` ran the wrong code.** It routed to `runBackfill`, which sends the `includedeleted=only` body down the ordinary ingest path where `resolveSourceRecord` **creates on a miss** — so a deletion for an event GeoNerva had never ingested produced a new record whose only version said it was deleted, with a magnitude and position taken from the deleted feature. A fact invented from nothing. The reconcile was also unreachable from the worker at all |
| 2 | A, B | **A backfill made a dead live feed read `FRESH`.** A backfill window and a live poll are both successful `usgs/comcat` runs, so a long backfill reset `lastSuccessAt` while the live poll failed throughout. Health now carries the run trigger and counts only `SCHEDULE`/`MANUAL` |
| 3 | B | **The `count` was fetched and then ignored.** FDSN answering 200 with an empty body for a window it had just said held 4,000 events marked the interval `DONE` with `n_received = 0`, and the plan could reach `COMPLETED` over a permanent hole |
| 4 | B | **The sweep never checked the entries were deletions.** Every feature became a tombstone instruction, so a body of *live* earthquakes would have mass-tombstoned every record it touched |
| 5 | A | **A `SKIPPED` window spun forever** — a disabled product writes nothing, so the interval stays `PENDING` and claiming returns the same one |
| 6 | self | **A `LEASE_HELD` outcome spun forever**, same shape. Without the fix the test runs to a 30 s timeout |
| 7 | self | Re-requesting a range with a different `--window-days` merged a second, overlapping interval set into the same plan |
| 8 | G3 | `rebuildHeads` ordered by `ingested_at` before `version_seq` |

### MEDIUM — fixed

- **A 503 was read as "window too large".** P0 did see `table is full` arrive as one, but 503 is
  also the ordinary "provider is busy", and splitting on it halves a healthy window *permanently*
  — the parent stays `SPLIT`, so a transient outage left a distortion resume never repaired.
- **The budget treated a rate as a stock.** ADR-034 listed "all magnitudes, last 30 days — 20 MB"
  as a fixed line. With facts kept forever it is 0.65 MiB/day — **238 MiB/year** — so the EMSC
  reserve was consumed in about six months. **ADR-035** gives small-magnitude facts a replay
  horizon and revises the reserve to ~70 MB. This is the one finding that changed a decision.
- **Error details were bounded in characters, not bytes**, while the CHECK is
  `octet_length <= 1024`. The failure path — the one path that exists to record that something
  went wrong — was where the write broke. Now trimmed by grapheme via `Intl.Segmenter`.
- **Raw driver text could reach `ingestion_runs.error_message` and stdout** from the outer catch
  (SECURITY.md M7). `lastPayloadDigest` is a database call with no inner handler.
- **The sweep's transaction was unwrapped**, so a failure left the run `RUNNING` and the product
  leased for half an hour — six live polls leaving no health evidence.
- **An ambiguous alias match was resolved by picking one**, leaving the other record `ACTIVE`
  forever; and since row order is not stable, a second sweep could pick the other — so it was not
  even idempotent. Now an explicit `AMBIGUOUS` answer with a reject row.
- **The sweep's counts did not reconcile**: 98 received, 55 accounted for. Deletions for events
  never held now leave reject rows, so `received = tombstoned + already + rejected`.
- **Raw payload storage was order-dependent.** A backfill writing first meant a live body was
  never stored, so ADR-033's 30-day window silently did not apply to those records.
- **`usgsDescriptor` did not declare `HISTORICAL_EVENTS` or `DELETIONS`**, which the seeded
  product has declared since P2 — code and database disagreed precisely about the two things P4
  built. `runBackfill` now checks the capability.
- **`backfill_intervals.error_class` was unconstrained** (migration 0013), **plans were not
  attached to their product**, and **`--window-days` accepted fractions** that the `bigint` column
  rejects with a raw SQLSTATE.

### Recorded, not fixed

| Finding | Why |
|---|---|
| `claimNextInterval`'s `SKIP LOCKED` does not reserve | The row lock ends with the claiming transaction, before any fetch. The per-product ingestion lease is what actually serialises workers; the second gets `LEASE_HELD` and stops. Reserving properly needs a second lease for a case that does not arise while one worker runs a plan. **The misleading comment was corrected** |
| A version can in principle be written with `raw_record_id = NULL` | Needs the head to move between the snapshot and the row lock, which the lease prevents. The lazy re-upsert already covers the reachable case |
| `emptyBatchIsSuspicious` is not tied to `trigger === 'BACKFILL'` | Nothing else passes it; making the rule structural is worth doing when a second caller exists |
| The pipeline imports FDSN functions directly | The capability check closes the safety half. The *interface* belongs with the second historical source, in P5, where there is something to abstract over |

### A flake worth naming

Two full integration runs failed on unrelated tests while every file passed in isolation. The
cause was **not** data interference: vitest's default `hookTimeout` is 10 s, and
`partition-repair.int.test.ts`'s `afterEach` creates databases, runs every migration and drops
them. As the suite grew past 100 s that cleanup began crossing the line, and a timed-out
`afterEach` leaves state behind that fails whichever file runs next — presenting as random,
unrelated failures. Integration hooks now get 120 s; three consecutive full runs are clean.

### Two tests that were vacuous

Caught by deliberately breaking the code:

1. **The window-boundary test.** It placed an event where two adjacent windows could both claim it
   and asserted one record, one version — which holds either way, because if both windows return
   it the content hash makes the second `unchanged`. Removing the -1 ms bridge left the test
   passing. What double-claiming corrupts is the *accounting*, so it now asserts
   `progress.received`, and fails with "expected 2 to be 1" without the bridge.
2. **The `rebuildHeads` test** (G3 carry-over) originally used two versions sharing one
   `ingested_at`, where both orderings agree. It now uses an older window arriving after a newer
   one, which is what a backfill following a live poll actually does.

## 6. G3 carry-overs closed here

| Carry-over | Outcome |
|---|---|
| FDSN reconciles and `backfill usgs` | Built |
| Raw-payload retention decided before any backfill | ADR-033, and enforced in the persist path |
| `rebuildHeads` ordering | Fixed, with a regression test that fails without it |
| `lastPayloadDigest` not scoped by feed | **Closed as accepted.** It can only cost a wasted re-parse, never a wrongful skip — every summary body carries its own feed URL, so two feeds cannot produce identical bytes. Scoping it needs a column on a frozen table to save a re-parse nobody has measured. Documented in ARCHITECTURE §4.1 |
| Conditional GET | Documented as deliberate in ARCHITECTURE §4.1; a 304 now carries the previous digest forward rather than hashing the empty body |

## 7. Deliberately not done

| Item | Why | Lands |
|---|---|---|
| Running the 2016 → now backfill for real | ~80k events against a live public service; the mechanism is proven and the scope is decided, but the run itself is an operational act, not a gate artifact | P10 |
| `includesuperseded` forensic history | Only works with `eventid`; nothing in v1 reads it | Later |
| Tombstoning a deletion stripped of identity | Impossible by construction — the provider published no identifier. Counted and documented, not silently skipped | Needs a websocket feed |
| Scheduling the reconcile | The sweep exists and is tested; wiring it into the scheduler belongs with the other periodic jobs | P5/P10 |
