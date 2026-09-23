# Gate G9 — the frontend (P9)

**A naming warning first**, as every report since G7 carries. The continuation prompts and
`docs/IMPLEMENTATION_PLAN.md` number gates differently: the plan's acceptance criterion for its
phase P9 is **G7**, and this file uses the prompts' numbering, where the gate after P8 was G8. So
**this file is the plan's G7**.

- **Date:** 2026-09-22
- **Commits:** `ebd6dc3` → `4304465` — 21, plus this report.
- **Verdict: NOT PASSED — one HIGH finding is open, and it needs a decision that is not mine.**
  Everything the gate measures is green; the criterion it cannot meet is "no CRITICAL or HIGH
  open". See §4.

## 1. What the gate asks for

`IMPLEMENTATION_PLAN.md` §2.4: *"E2E green desktop + mobile; axe clean; **QA round 2 (data
integrity)**"*, plus §3a's rule that **a phase gate cannot pass while its items are open**.

## 2. What was built

P9a was already merged. This phase built 9b, and two things §3a had left open since P1.

| Deliverable | Commit |
|---|---|
| The data seam: the pages read the service layer, not fixtures; `?scenario` deleted | `12567bf` |
| The E2E prerequisites: two seeded scenarios and `GEONERVA_FAKE_NOW`, neither of which existed | `d66974f` |
| **F-5**, the strict Content-Security-Policy — an open §3a exit criterion of P9a | `1143d8e` |
| **F-8**, the server-only boundary — likewise, enforced by a scan since the package is unavailable offline | `622a247` |
| `/methodology` rendered from the engines' own constants, with a guard against hard-coded numbers | `a1b3fff` |
| The evidence "Raw record" (ADR-038) and the withheld fire cluster (ADR-039) | `eac75aa` |
| The landing search completed, and `lib/client/api-client.ts` (**R-7**) | `cc49834` |
| Loading and error states, including the retention refusal a boundary cannot classify | `efdea12` |
| The map says which layers it cannot speak for | `fb242d1` |

Fixes to findings are listed in §4.

## 3. What was measured

All four commands at `4304465`, on this machine, with the database healthy:

```
pnpm check              exit 0    1,952 unit · 164 component · depcruise 443 modules, 0 violations
pnpm test:integration   exit 0    40 files · 788 tests
pnpm test:e2e           exit 0    81 passed · 0 failed · 0 did not run
pnpm --filter @geonerva/web build  exit 0
```

End-to-end runs against a production build, the seeded scenario database and the fixed clock, at
**both viewports**, with axe reporting no serious or critical violations on every route, no
horizontal scroll at 320 px, touch targets ≥ 44 px, and one run with WebGL2 disabled. Every flow
in `docs/TESTING.md` §5 that has a feature behind it is covered, including the two that could not
run before this phase: the source-outage scenario and the replay round-trip.

**The E2E suite is part of the gate, not an extra.** That is a lesson from this phase rather than
a formality: I verified lint, unit and component suites before committing the loading states and
not end-to-end, and shipped a regression that made every unknown place answer `200` — and blocked
nine specs, including the only automated coverage of invariant I11.

## 4. Adversarial QA round 2, and why the gate is not claimed

`docs/reviews/qa-round-2.md`, with the orchestrator's dispositions in its §6. **No CRITICAL.** Five
HIGH, four MEDIUM, eight LOW.

Four of the five HIGH are fixed. The fifth, **H-4**, is half fixed and half open:

- The map had exactly one way to show "nothing here", and used it for two opposite facts. A family
  with no source drew the same empty viewport as a genuinely quiet one; under a full fire outage it
  drew an `ACTIVE` cluster of 14 detections beside a headline saying GeoNerva could not report on
  fire activity. The page half is fixed — each layer carries the briefing's own verdict.
- The API half cannot be fixed inside the frozen contract: `MapFeaturesResponse` has no
  availability field, so a client asking `/events` still gets `total: 0` for a family nothing
  covers. That needs an additive field, which the owner reserves to an approved ADR.

**So the gate is not claimed.** `ADR-042` is filed as Proposed with the shape of the extension and
the alternatives. One decision closes the last HIGH.

Two smaller decisions are also waiting, neither blocking:

- **ADR-043** — whether a band may be defined by a quantile its own sample cannot resolve. The
  *sentence* that said "in the top 1 % of comparable periods" over 59 windows is fixed; whether
  `WELL_ABOVE_TYPICAL` may keep a 99th-percentile definition revises §8.1, and changes what the
  product says about real places.
- **ADR-039** remains Proposed, and two findings route around it: the fire page withholds what it
  cannot verify, and a cluster's 24-hour figures are labelled with the moment they were computed
  rather than recomputed per request.

The three adversarial specs that stay red (F-2 ×2, F-4) are the record of those open decisions.
They live in their own vitest project and do not block `pnpm check` — an adversarial round should
not hold the gate command hostage, and a finding nobody can close without the owner should not
look like a broken build.

## 5. Defects this phase found in its own work

Worth listing, because each was invisible to a green suite:

1. **A third wall-clock read in `snapshot.ts`.** `isReplay` was decided from `Date.now()`, so under
   a fixed clock every live page rendered the replay banner with a "Return to the present" link
   that went nowhere. Fixed by shape: the function takes the present and cannot reach for one.
2. **The generated database types were a phase out of date** — three tables missing, one dropped
   table still declared — because `codegen` demanded an environment variable every other database
   script defaults. Now `pnpm db:codegen`, with a drift test.
3. **"Append-only" had no grant behind it.** Migrations 0017 and 0018 granted `SELECT, INSERT`,
   which reads as least privilege, but 0007's default privileges had already granted `UPDATE` and
   `DELETE` at `CREATE TABLE` time. Migration 0019 revokes them.
4. **`GEONERVA_ALLOW_REMOTE_TEST_DB=1` disabled the whole test-database guard**, not just its host
   check, against a harness that truncates.
5. **A precise position reached Nominatim unrounded** — `31.6315, -8`, one decimal number and one
   integer, slipped past a rule that required two.
6. **`placeSlug` could address a different place**: a geocoder key would have been written as a
   slug that reads back as a GeoNames id.

## 6. What P10 inherits

- **ADR-042 and ADR-043 are waiting on the owner.** The first is the last HIGH.
- The `ingestion_runs` retention sweep is no longer blocked by ADR-041's first condition, and its
  second is demonstrated by a test. Read it before enabling the sweep.
- §9.2's `HIGH` fire relevance still reads a 24-hour window from a summary computed earlier, so a
  level can outlive its evidence. Recorded in M-2.
- Eight LOW findings, none a false statement about hazard.
- The worker still schedules only USGS, so every GDACS-family baseline refuses in production, and
  `FIRE_TREND` needs 35 covered days before it can answer at all.
