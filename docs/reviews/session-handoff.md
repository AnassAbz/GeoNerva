# Continuation handoff

- **Written:** 2026-09-22, at the end of the session-numbered P8 (the read-only `/api/v1` domain
  API), after **G8 PASSED** at checkpoint 2.
- **Head:** `d2b8b6c`, plus the commit carrying this file and `docs/reviews/gate-g8.md`. Working
  tree clean.
- **`pnpm check`** exit **0** (**1,610** unit). Integration **699/699**, twice consecutively, on the
  last change (294 s, 349 s).

**The gate-numbering warning every report since G7 carries.** The continuation prompts and
`docs/IMPLEMENTATION_PLAN.md` number gates differently — the plan gives its own P8 the criterion
"G6". State which scheme a report uses.

## Where P8 ended

`docs/reviews/gate-g8.md` checkpoint 2 is the full record. All **11 of 11** P0 endpoints are
served, each against a frozen contract proved equivalent to its TypeScript interface, with a
generated OpenAPI document. The public API contract is **frozen at `d2b8b6c`**. Four review rounds;
no CRITICAL or HIGH finding is open. Representative latency is measured (`pnpm bench:api`):
briefing p95 ≈ 130 ms against G6's 600 ms, `/history` p95 ≈ 195 ms — local, sequential, not
production.

One honest absence to know before building UI on `/history`:

- **`FIRE_TREND` now answers from the daily aggregate** (ADR-040, implemented 2026-09-22). It is
  `OK` only where the aggregate holds covered days on both sides of the comparison, which a fresh
  deployment reaches 35 days after its first FIRMS poll; until then, and for any day GeoNerva did
  not read every hour of, the answer is `INSUFFICIENT_COVERAGE`. The UI must render a direction
  (`trendBand`) with no reference distribution, which is a shape no other metric has.
- **Every GDACS family's baseline refuses in production today**, because the worker schedules only
  USGS (`apps/worker/src/cli/start.ts`, `SCHEDULED_ADAPTERS`). Coverage is per feed; the families
  answer once their GDACS feeds are polled.

## What to pick up first

P9 (frontend) may start: G8 passed. Server components call `apps/web/lib/server/services.ts` with
the same validated requests the routes use — never the API over loopback (the header of that file
says why).

## Decisions waiting on the owner

**ADR-038, ADR-040 and ADR-041 were all accepted by the owner on 2026-09-22 and are implemented**
(migrations 0017 and 0018; `docs/DECISIONS.md` carries an "As built" section for each). What each
one leaves behind:

- **ADR-038** — `/evidence/{id}` states the raw payload's lifecycle; the provider's bytes are not
  part of the public contract and are never served by default.
- **ADR-040** — the daily fire aggregate. Two rules to keep in mind before touching it: a day is
  judged once, when it is final, and a day whose detection partition retention has dropped can
  never be recorded `COVERED`, because its absent rows would read as a quiet day. No writer
  produces a correction row, though the keys allow one.
- **ADR-041** — the coverage ledger. (1) ADR-033's 90-day run retention would erase run history:
  coverage no longer derives from it, so **the sweep is no longer blocked by ADR-041's first
  condition** — but its second, "historical baselines must continue to work after detailed run
  history is pruned", is demonstrated by "a baseline after its run history is pruned" in
  `packages/briefing/src/history.int.test.ts`: the same request answers identically after every
  run row, plan and interval is deleted. That test also drove a fix — the earthquake baseline's
  "was this catalog read?" gate asked `ingestion_runs`, so the sweep would have turned a read
  catalog into an unread one; it asks the ledger now. Read it before enabling the sweep. P10
  inherits this. (2)
  Chains tolerate gaps up to `fetchStaleAfterS`, a health threshold, not what each poll read: any
  worker stop over an hour on this machine cuts earlier backfills off from the present (a refusal,
  live here), while EMSC's 15-minute look-back could lose events in an outage (latent).
- **The page file is 8 GB initial, 24 GB maximum** (owner decision, 2026-09-21). Commit charge ran
  79–82 % through every mutation run this checkpoint; no crash.

## Open findings, none CRITICAL or HIGH

The full list is gate-g8.md checkpoint 2 §6. The ones most likely to bite next:

1. **Scheduling GDACS or EMSC turns several latent findings live** — read §6.7–7c first.
2. **Aliases re-pointed in place by a record merge leak into earlier replays.** Needs alias history.
3. **The horizon check ignores the recency window** — latent until pruning is scheduled.
4. **Least-privilege is enforced by structure, not RLS** (policy-less RLS; checkpoint 1 §9.3).
5. **No Nominatim circuit breaker**; `/history` is computed per request with no LRU (§13.3).
6. **Intermittents, undiagnosed:** `emsc.int.test.ts` (checkpoint 1) and one shape in
   `fire-ingest.int.test.ts` (a FAILED outcome whose stored run row lacked its status). Neither
   recurred in eight full runs, which is not evidence they are fixed.

## Two things about this machine

See `geonerva-machine-constraints` in the session memory.

- **Docker's disk image is on a USB-attached SSD.** Durable 4 KB writes cost ~2.4× those on `C:`;
  `DROP DATABASE`'s forced checkpoint costs 60–95 s under load. The full integration suite now takes
  **290–350 s**. Before treating a slow or flaky integration test as a code defect, check whether it
  is fsync-bound — or whether it straddles an epoch-aligned rate-limit window, which one did.
- **The benchmark uses its own database** (`geonerva_bench_test`), so it never disturbs the
  integration database.

## How this phase was worked, which is worth repeating

- **Review the fixes, not just the code.** Every one of the first three review rounds found a flaw
  in the previous round's fix — the H1 fix reopened H1 through live polling, and that fix reopened
  it through GDACS's six feeds. Round 4 found no HIGH. Stop when a round finds none, not before.
- **Mutation-test every rule, and check the test passes unmutated first.** Twice this checkpoint a
  "kill" came from a new test that failed on its own (once it did not even compile). The runner
  cannot tell; the discipline must.
- **A benchmark that times a refusal is not a measurement.** Print what the endpoint answered
  before timing it, and seed the dataset the way production fills it (90 days of polls changed the
  briefing's p95 by ~40 ms).
- **Survivors are often dead code.** Twice a mutant survived because its target could never run.
  Delete it rather than write a test for the impossible.
