# Session handoff — 2026-09-21

Written at a clean boundary: G6 has passed, the tree is clean, `pnpm check` exits 0, and both
suites are green. This supersedes the 2026-09-20 handoff, which described P6 part-built.

## 1. Where this is

| | |
|---|---|
| **Last gate passed** | **G6** — deterministic hazard context (`docs/reviews/gate-g6.md`) |
| **Current phase** | **P7 — explainable briefing domain**, not started |
| **Next gate** | G7 (`docs/reviews/gate-g7.md`, not written) |
| **Commits this session** | `97ee8ed` → `0a31af4`, 7 on `main` |
| **Tests** | **837 unit, 338 integration** (19 files), PostgreSQL 17 / PostGIS 3.4.3 |
| **Working tree** | clean |

Read before continuing, in this order:

1. `docs/reviews/gate-g6.md` — especially §4 (what the two adversarial reviews found), §6 (open
   items accepted for G6) and §7 (the observation that is still unresolved).
2. `docs/DECISIONS.md` ADR-036 and ADR-037, both new, and ADR-036's **correction** block: the ADR
   originally asserted two things about its own commit that were false.
3. `docs/reviews/gate-g5.md` §9–§11 for the earlier findings and vacuous tests.

## 2. What P6 delivered

| Area | What exists now |
|---|---|
| `packages/correlation` | Misfit, decision (stages 0–2), hysteresis, calibration, **agreement and the headline value**. `candidateScore` maps a misfit onto the 0–1 column the schema actually has |
| `packages/pipeline` | `correlateEarthquakes` — the runner against the database — and `seedSingleSourceEvents` for GDACS families |
| `packages/db` | `analysis_runs` repository, `derivationsAsOf`, `productCoverageFor`, `newestDetectionIngestAt`, the correlation reads, migration `0014` adding the `SEED` run kind |
| `packages/relevance` | Three new availability axes: **derivation**, **replay horizon**, **unassessed subjects** |
| `packages/briefing` | `buildSnapshot`, canonical serialization + `contentSha256`, family coverage, the replay horizon |

**The calibration stands**: precision 1.0000, recall 0.9891 against the 250-pair labelled set
(`docs/reviews/correlation-calibration.md`). Read §2 and §6 of that report — the uniqueness gap
never binds on this set, and the report says what the calibration does *not* establish.

## 3. What P7 needs, and what it must not do

P7 is the **explainable briefing domain**: deterministic copy and the bounded evidence object the
AI layer is later given. The session plan's own framing is the important part:

> The LLM is **NOT** the source of truth. The database and deterministic hazard-context layer are
> the source of truth.

Contracts that already exist and must be filled rather than redesigned:

- `BriefingCopy` — `headline`, `summary[]`, `byFamily`, `caveats[]`, `templateVersion`
  (`packages/domain/src/read-models/common.ts`).
- `LocationBriefing` — the union of `snapshot`, `changes`, `copy`, optional `ai`, and
  `evidenceManifest` (`packages/domain/src/read-models/location-briefing.ts`).
- `ChangeSection` / `ChangeSignalView` — P7's neighbour; `packages/changes` is still a stub, and
  `diff(buildSnapshot(L, now−Δ), buildSnapshot(L, now))` is the documented shape (ARCHITECTURE §10).
- `EvidenceItem` and its four payload types (`packages/domain/src/read-models/evidence-item.ts`).

Three traps, each of which this phase has already walked into once in a different form:

1. **Do not let copy invent a number.** `Reason.params` exists "so the AI validator can check that
   no number was invented". Every number in a sentence must come from a `params` entry, and the P6
   review found two places where `params` was `{}` while the sentence quoted figures.
2. **Do not let copy render a zero the card refused to claim.** A card that is not `AVAILABLE` has
   no items *and* no count (invariant I11). The copy layer is the last place that can leak one.
3. **Do not build a second relevance or agreement rule.** `packages/relevance` and
   `packages/correlation` decide; the copy layer renders.

## 4. Unresolved, carried forward

**The intermittent 7-test integration failure is still unexplained.** Gate G6 §5 records a
contention probe — three full passes under sustained concurrent load, suite duration 297 s against
~100 s idle, 329/329 each time — which establishes that the suite tolerates real contention and
**does not diagnose the original observation**. No cause is claimed. Do not close it.

A separate intermittent failure *was* diagnosed (G6 §7): `scripts/lint-rules.test.ts` timed out on
its first ESLint call, 2 runs in 15, now 20/20 after warming in a `beforeAll`. Whether the original
shares that mechanism is a hypothesis. **If a test fails intermittently, capture the output on the
first occurrence** — both times it has happened in this project, the first run captured nothing.

## 5. Open items accepted at G6

1. **No lease on `analysis_runs`.** Two overlapping `CORRELATION` runs can each open a canonical
   event for one earthquake. Single-instance worker today; belongs with scheduling in **P10**.
2. **`canonical_event_state` is a non-bitemporal projection of a bitemporal store.** ADR-036
   records the versioned-projection alternative and why P6 did not take it. Revisit before the
   event-detail read model.
3. **`FamilyCard.metrics` is empty.** `packages/baselines` is unbuilt.
4. **Source configuration is not versioned**, so coverage for a past `asOf` uses today's source
   set. `active_from`/`active_to` are honoured, which covers the misleading case.
5. **Fire clusters are read but nothing writes them.** `buildSnapshot` now reads
   `clusterVersionsAsOf` and the derivation axis reports `DERIVATION_NOT_RUN` honestly — which is
   correct behaviour and also means the fire card is `UNAVAILABLE` in practice until clustering is
   built. That is the truthful state, not a regression.

## 6. Architectural context that is easy to get wrong

- **`asOf` is the only fact reader.** `packages/db/src/asof.ts`. `packages/briefing` must import
  **`@geonerva/db/asof`**, never the root barrel — the barrel re-exports every repository, and a
  repository read returns the newest row rather than the row as of `T`. The rule
  `briefing-reads-facts-only-through-asof` now fails the build on any such path, and it was
  verified to fail before being trusted.
- **Independence is decided by contributor identity, never by value agreement** (ADR-030). A
  republication is linked `DERIVED_COPY` — by Stage 1 *and* by Stage 2, which was the review's most
  serious finding.
- **`content_sha256` is the only change detector** (ADR-029), and the snapshot's `contentSha256` is
  taken over a canonical form with `generatedAt` excluded.
- **An absence is never an answer on its own.** Five axes now decide whether GeoNerva may say
  "nothing"; see G6 §2.4 for the table of which lie each one prevents.
- **Mutation controls are standard practice here.** 39 were run this phase and 9 initially
  survived — a fifth of the new tests were not yet evidence of anything. Run them on every rule.

## 7. Next action

Start **P7.1**: the bounded structured evidence object a briefing receives (location, `asOf`,
hazard evidence, source availability, source freshness), then the deterministic templates for
`BriefingCopy`. `buildSnapshot` already returns everything P7.1 needs except the change section.
