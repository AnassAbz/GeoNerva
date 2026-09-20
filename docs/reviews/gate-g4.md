# G4 — Historical earthquake ingestion and reconciliation

- **Date:** 2026-09-20
- **Verdict:** *pending the two independent reviews; this section is completed when they are.*
- **Commits:** `5f913d1` → `f33e73e` (11)

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
| All tests green | **495 unit, 225 integration** against PostgreSQL 17 / PostGIS 3.4.3 |

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

*Completed when the two independent reviews report.*

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
