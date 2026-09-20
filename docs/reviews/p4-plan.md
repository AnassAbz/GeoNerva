# P4 — Historical earthquake ingestion and reconciliation: plan and reconciliation

- **Date:** 2026-09-20
- **Gate:** G4. Depends on G3 (frozen: schema, domain types, read-model contracts, adapter
  contract, ingestion lifecycle).
- **Governing spec:** `docs/geonerva_long_autonomous_session.md`.

## 1. Reconciling the session plan against the repository

The session plan renumbers phases relative to `IMPLEMENTATION_PLAN.md`. The mapping:

| Session plan | Repository plan |
|---|---|
| **P4** historical EQ ingestion + reconciliation | the FDSN/backfill work `gate-g3.md` §5 deferred, plus repo P4's "backfill" task |
| P5 multi-source ingestion foundation | repo **P4** — EMSC ∥ GDACS ∥ FIRMS |
| P6 spatial hazard intelligence | repo **P5** geo/correlation/clustering + **P6** relevance |
| P7 explainable briefing | repo **P7** baselines/change + **P8** briefing |
| P8 API | repo **P8** domain API |
| P9a / P9b frontend | repo **P9** |
| P10 productionization | repo **P10** + **P11** |

**This is re-sequencing, not an architectural conflict**, and it is not treated as one: no ADR,
frozen schema, domain type, read-model contract or identity semantic changes shape because of it.
It also agrees with the repository's own record — `gate-g3.md` §5 already assigned the FDSN
reconciles and `backfill usgs` to "P4". The mapping is recorded in `IMPLEMENTATION_PLAN.md` so the
two documents cannot drift.

**Where the session plan defers to project docs, project docs win.** P5 suggests NOAA/NWS as a
source candidate; the repository's P0 source set is USGS, EMSC, GDACS, FIRMS and **ECCC**, all
verified with captured fixtures in P0. P5 will implement those, not NOAA.

## 2. What is already frozen and must not move

| Frozen thing | Consequence for P4 |
|---|---|
| `SourceAdapter` shape (ARCHITECTURE §4.1) | Historical querying is added as a **separate capability interface**, not by widening `fetch`. `SOURCE_CAPABILITIES` already contains `HISTORICAL_EVENTS` |
| Run lifecycle, 6 steps | A backfill interval is one ordinary run: same lease, same batch stamp, same `finishRun`. `RUN_TRIGGERS` already contains `BACKFILL` and `RECONCILE` |
| Identity is the alias set | This is what makes live ↔ historical reconciliation work at all; P4 proves it rather than changing it |
| Content hash is the only change detector | A backfilled record that matches the live one must produce `unchanged`, not a second version |
| Writes through repositories, reads through `asof.ts` | The orchestrator writes no SQL of its own |
| `observation_versions.raw_record_id` is provenance | A backfill stores the raw **row and hash** with a null body (ADR-033), never no row |

## 3. New schema (additive only)

A resumable backfill cannot keep its cursor in process memory (P4.2), and no table exists for one.
**Migration 0012 adds `backfill_plans` and `backfill_intervals`** — two new tables. Nothing
existing is altered, so no frozen contract is touched.

## 4. Execution order

1. **Retention policy** — ADR-033, then the code that enforces it. First, because P4.6 makes the
   storage measurement a gate condition and the policy determines what the measurement measures.
2. **FDSN adapter** — typed, validated query parameters; no query-string passthrough. Handles the
   20,000-row limit (400), the `count` endpoint answering 200 with an `error` field, and the 503
   "table is full" that P0 observed on an open-ended query.
3. **Window planner** — pure, deterministic subdivision with a minimum interval and explicit
   detection of a window that cannot be completed.
4. **Checkpoint schema + repository** (migration 0012).
5. **Backfill orchestrator** — resumable, crash-safe either side of the checkpoint, idempotent on
   replay and on overlapping ranges.
6. **Deletion reconcile** — `includedeleted=only` sweep producing tombstone versions.
7. **Live ↔ historical reconciliation tests** — both directions, revisions, aliases, duplicates.
8. **Storage measurement** on a representative backfill. Measured, not projected.
9. **G3 carryovers** — feed-scoped payload digest, `rebuildHeads` ordering, the conditional-GET
   decision.
10. **Adversarial review** (correctness/reliability and security/architecture), then G4.

## 5. Assumptions that could invalidate this design

1. **FDSN honours `starttime`/`endtime` as a half-open interval.** If it is inclusive at both ends,
   adjacent windows double-count an event on the boundary. Idempotency makes that harmless, but the
   run counters would lie. *Test:* two adjacent windows over a known event.
2. **`count` is cheap and agrees with `query`.** The planner uses it to decide splits. If it
   disagrees, a window can exceed the limit after passing the check. *Handled:* a 400 on the real
   query re-splits rather than failing the backfill.
3. **A deleted event's id stays resolvable.** `includedeleted=only` returns `status: "deleted"`;
   querying that id directly answers 409 (P0 fixture). The sweep must not need the second call.
4. **Backfilled and live records of the same event produce the same content hash** when the
   catalogue has not changed. If FDSN and the summary feed differ in a field the hash covers, every
   backfilled event would appear revised. *This is the reconciliation test, and the most likely
   place for P4 to find a real defect.*
5. **~52 MB for 260k raw rows without bodies.** Estimated from the P3 per-event figures; §4.6
   replaces it with a measurement.

## 6. Definition of done

- A historical range ingests, resumes after a crash on either side of the checkpoint, and
  re-running it writes nothing new — proven by table digests, not counts.
- An event seen live and then historically (and the reverse) is one logical earthquake.
- Storage measured against ADR-033's policy, and inside the budget or accompanied by a budget ADR.
- Full gate green; adversarial review with no CRITICAL/HIGH open; `docs/reviews/gate-g4.md`.
