# Session handoff — 2026-09-21

Written at a clean boundary: G7 has passed, the tree is clean, `pnpm check` exits 0, and both suites
are green. This supersedes the earlier 2026-09-21 handoff, which described P7 as not started.

## 1. Where this is

| | |
|---|---|
| **Last gate passed** | **G7** — explainable briefing domain (`docs/reviews/gate-g7.md`) |
| **Current phase** | **P8 — API**, not started |
| **Next gate** | G8 per the prompt's numbering (`docs/reviews/gate-g8.md`, not written) |
| **Commits this session** | `97ee8ed` → `217d498`, 16 on `main` |
| **Tests** | **957 unit, 358 integration** (20 files), PostgreSQL 17 / PostGIS 3.4 |
| **Working tree** | clean |

**Two numbering schemes are in play and they diverged at G6.** The continuation prompts number
gates by their own sequence; `docs/IMPLEMENTATION_PLAN.md` §2 numbers them differently — repo-G6 is
"API contract tests; p95 briefing latency < 600 ms", repo-G7 is "E2E green desktop + mobile; axe
clean". `gate-g6.md` and `gate-g7.md` use the prompt's numbering and say so in their own first
lines. **Do not read either as the repository's gate of the same number.** Nothing about E2E,
accessibility or latency has been measured.

Read before continuing, in this order:

1. `docs/reviews/gate-g7.md` — especially §4 (what the two reviews found), §6 (**eleven honest
   limits**, which are the things most likely to be wrongly assumed), and §7 (open items).
2. `docs/reviews/gate-g6.md` §5 and §7 — the contention probe and the unresolved observation.
3. `docs/DECISIONS.md` ADR-012 (runtime AI shape), ADR-015 (ad-hoc locations), ADR-036, ADR-037.

## 2. What P7 delivered

| Package | What exists now |
|---|---|
| `packages/changes` | The snapshot diff (§10): classification, materiality, grouping, importance and prominence, suppression always explained |
| `packages/briefing` | Deterministic copy, the banned-lexicon scanner, `buildBriefing`, the evidence-manifest resolver |
| `packages/ai` | The bounded packet with its privacy gate, structured-output schemas, the deterministic validator (§11.4's eight rules), and the fallback state machine |
| `packages/db` | `evidenceItemsAsOf`, `attributionsFor` |

**`AI_MODE=disabled` is the default and the deterministic copy is the product's language.** A
briefing with `ai: null` is the normal response, not a degraded one.

## 3. What P8 needs

Repo `IMPLEMENTATION_PLAN.md` P8 is "Briefing service & domain API": the `/api/v1` endpoints,
geocoding, rate limiting, problem+json errors, cache headers, worker-side materialization, and an
OpenAPI document generated from Zod. `buildSnapshot` and `buildBriefing` already exist, so the
service half of that phase is done; what remains is the HTTP surface.

Four things to get right, each of which this phase learned the hard way:

1. **`apps/web` currently imports no `@geonerva/*` package.** The moment a route handler imports
   one, the `web-reads-facts-only-through-asof` and `web-is-read-only` rules stop being vacuous.
   Expect them to fire, and fix the import rather than the rule.
2. **The AI path has no caller.** `generateAiBriefing` is complete and tested but nothing schedules
   it. Per ADR-012 it runs **in the worker, for materialized locations only**, keyed by
   `packet.cacheKey` — *not* by the snapshot hash alone, because the packet depends on the window.
   Ad-hoc `c:` locations must never reach it; `buildPacket` refuses them, and that refusal is the
   guard, not a fallback.
3. **Nothing writes `cost_micros`.** `withinBudget` now fails closed, so a caller must assert it.
   Wire the accounting before enabling AI, or it will simply always decline.
4. **`strictManifest` defaults to true and throws.** An endpoint that must return something should
   pass `false` and surface `unresolvedEvidenceIds`, but the strict default is what caught the
   `EV:FDS` defect, so do not flip it globally.

## 4. Unresolved, carried forward

**The intermittent 7-test integration failure is still unexplained.** G6 §5 records a contention
probe that established the suite tolerates real contention and **did not** diagnose it. During this
session's disk migration the suite failed 4 then 9 tests, all in `backfill.int.test.ts`, which then
passed 28/28 alone and 358/358 twice; `dd_setup_*` installer logs in `TEMP` are timestamped inside
those runs, so another installer was competing for C:. Load-correlated, not diagnosed, not closed.

**If a test fails intermittently, capture the output on the first occurrence.** Three times now in
this project the first run captured nothing. The one instance that *was* diagnosed — an ESLint cold
boot exceeding a 5 s `testTimeout` — was only solvable because a capturing loop reproduced it.

## 5. Environment

Docker's WSL2 data distribution now lives on **`D:\DockerData`** and the npm cache on
`D:\npm-cache`; 10.75 GB was reclaimed on C:, which had 144 MB free. The pnpm store stays on C:
deliberately — moving it across drives breaks pnpm's hardlinks into this repo's `node_modules`.
Backups are on `D:\GeoNervaBackup`, including a 2.69 GB pre-migration WSL export that is safe to
delete once you are satisfied. **C: is still ~97 % full from unrelated data**, so headroom is thin.

## 6. Habits that keep finding real defects

- **Mutation controls on every rule.** 46 this phase, 10 initially surviving. One of them showed
  that a control I had written tested the single wording that happened to be in a phrase list —
  confirming the implementation rather than the requirement. When a control survives, suspect the
  test before the code.
- **Float comparison against a threshold.** Twice now: `assessAgreement`, then the change engine's
  materiality, where **170 of 581** magnitude pairs two hundredths apart subtract to less than 0.2.
  Round to the precision the column stores.
- **Read your own exemptions adversarially.** The verbatim-quote carve-out was narrowed twice — once
  by class, once by position — and both narrowings were load-bearing.
- **An absence is never an answer.** Five availability axes, and the P7 reviews still found two
  paths where absence became reassurance: `EVENT_RESOLVED` from a subject leaving a list, and a
  family's new hazards being invisible on recovery.

## 7. Next action

Start **P8**: the `/api/v1` surface over `buildBriefing`, beginning with the contract tests
(Zod ↔ OpenAPI) so the frozen read models are checked at the boundary before any handler exists.
