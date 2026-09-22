# Continuation handoff

- **Written:** 2026-09-21, at the end of the session-numbered P8 (the read-only `/api/v1` domain
  API).
- **Head:** `5948858`. Working tree clean apart from this file and `docs/reviews/gate-g8.md`.
- **`pnpm check`** exit **0**. **Unit 1,406**, **integration 505/505** on the last full run (167 s).

## Where P8 stopped, and why its gate failed

`docs/reviews/gate-g8.md` is the full report. The verdict is **FAIL on coverage**: the gate's
criterion is "all P0 `/api/v1` endpoints" and **4 of 11** are served — `/briefing`,
`/evidence/{id}`, `/sources/status`, `/replay/horizon`. No CRITICAL or HIGH finding remains open;
both adversarial reviews are closed (§9 of the report).

**A gate-numbering warning that every report since G7 carries.** The continuation prompts and
`docs/IMPLEMENTATION_PLAN.md` use different schemes — the plan gives its own phase P8 the
acceptance criterion "G6". State which scheme a report uses.

## What to pick up first

1. **`GET /events`** is the only unserved endpoint not blocked by an empty package. Its response
   schema (`mapFeaturesResponseSchema`) is already written and proved against the frozen interface.
   It needs a **bbox** as-of read with antimeridian splitting; `observationsAsOf` and
   `clusterVersionsAsOf` take a point and a radius. §13.1 says the bbox is quantized, and §13.2
   caps the area at 60° × 60° below zoom 4 — neither is implemented.
2. **`/events/{publicId}` and `/fire-clusters/{publicId}`** need runtime schemas for `EventDetail`
   and `FireClusterDetail`. The other six contracts have them, each with a compile-time proof of
   equivalence (`packages/domain/src/read-models/schemas.ts`) — follow that pattern, and expect the
   proof to catch a mismatch on the first try. It has twice.
3. **`packages/geocoding` is a 7-line stub** and blocks all three `/places/*` endpoints plus
   `?place=p:<id>`. The GeoNames import is marked **[P0]** in the plan and does not exist.
   `cities15000` is 34,146 rows and the type-ahead must index `alternatenames` — the primary name
   is "Marrakesh" and "Marrakech" is only an alternate. The rate limits for `places/search` (10/min
   plus a global 1/s, fail-closed) are already defined and tested ahead of the endpoint.
4. **`packages/baselines` is a 6-line stub** and blocks `/history`.

## Decisions waiting on the owner

- **ADR-038 is Proposed.** ADR-033 expects the evidence endpoint to report raw-payload state;
  migration 0007 revokes the web role's `SELECT` on that table. The recommendation is a
  column-level grant excluding `payload`, the pattern 0007 already uses for `agent_outputs`. Until
  it is decided, `/evidence/{id}` serves `rawExcerpt: null` and `rawPayloadSha256: null`.
- **The page file is 8 GB initial, 24 GB maximum** (owner decision, 2026-09-21). A *fixed* 8 GB
  was tried first and cut the commit limit from ~42.7 GB to 23.9 GB; the machine then idled at
  ~90 % commit and the WSL VM terminated abruptly twice under test load. Size a page file from
  commit charge, not from page-file usage.

## Open findings, none of them CRITICAL or HIGH

1. **The least-privilege claim is unenforced.** RLS is `ENABLE` with **zero policies** and
   `geonerva_web` has no `BYPASSRLS`, so as that role every fact read returns 0 rows
   (`blindness.int.test.ts` measures it); under 0007's documented default the login role owns the
   tables and bypasses policy-less RLS anyway. The read-only property is currently enforced by the
   API layer's structure. Writing policies touches every table — it is its own piece of work.
2. **`errorMessage` is served as `null`** because the write path does not deliver the contract's
   promise. `sanitizeDetail` is a length cap, not a redaction, and
   `SourceFetchError.describe()` puts the provider's host and path in the column. The fix belongs
   at the write path.
3. **`dataQuality: []`**, and empty means "no checks reported". TESTING §7's five runtime
   invariants live in the worker, which does not compute them and has no table to write them to.
4. **No retention job schedules any sweep.** `prunePayloadsBefore`,
   `dropDetectionPartitionsBefore` and `pruneRateLimitWindowsBefore` all exist and none is called.
   The last one matters most: the read path writes one counter row per (prefix × scope × window ×
   day) and nothing removes them.
5. **§13.3's in-process LRU is not built**, and the evidence space is enumerable — together those
   are the strongest argument for building it.
6. **The `emsc.int.test.ts` intermittent is open and undiagnosed.** Five of its tests failed once
   during P8 with "expected 'FAILED' to be 'SKIPPED'" and nothing more; nine isolated runs and six
   under synthetic write load did not reproduce it. Its assertions now carry `describeOutcome`, so
   the next occurrence reports the error class and the sanitized detail. **Not closed.**

## Two things about this machine

Both are measured, and both shape how the local suite behaves — see
`geonerva-machine-constraints` in the session memory.

- **Docker's disk image is on a USB-attached SSD** (the internal NVMe has no room). A 4 KB durable
  write costs 1.043 ms there against 0.438 ms on `C:`. The consequence is a slow Postgres
  **checkpoint**, not slow commits: `DROP DATABASE` waits on a forced checkpoint, so
  `partition-repair.int.test.ts` spends 60–95 s in one `CHECKPOINT` (measured:
  `CHECKPOINT 67414 ms, DROP 62 ms`). That hook has a 300 s budget matched to the measured cost,
  and reports any cleanup step over five seconds. The owner chose to keep Docker where it is.
- **The full integration suite takes 140–240 s.** Before treating a slow or flaky integration test
  here as a code defect, check whether it is fsync-bound.

## How this phase was worked, which is worth repeating

- **Mutation-test every rule, then mutation-test the fixes.** 142 controls this phase. Eleven
  survived on the implementation and eight on the review fixes — nineteen tests that would have
  passed against broken code. Two patterns recurred: an expectation computed from the constant
  under test (so widening it moved both), and a bound tested from below it (one row against a cap
  of ten thousand).
- **Require a unique anchor in a mutation script.** Two controls silently mutated the wrong
  function because the anchor matched the first of two occurrences.
- **Name and time each cleanup step.** That is what turned a three-phase-old "Hook timed out" into
  a measurement.
- **Two independent reviews with different briefs found almost disjoint sets of findings.** Neither
  brief alone would have found both the cache-key leak and the `immutable`-on-a-mutable-row bug.
