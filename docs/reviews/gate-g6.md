# Gate G6 — deterministic hazard context

- **Date:** 2026-09-20
- **Commits:** `97ee8ed` → `fe92564` — 6, plus this report and the intermittent-failure fix
- **Verdict: PASS**, with three open items recorded in §6 and one unresolved observation carried
  forward in §7. None is a CRITICAL or HIGH finding.

Every number below was produced by a command run in this session. Nothing here is estimated.

## 1. The eight criteria

| Criterion | Verdict | Evidence |
|---|---|---|
| Spatial queries are geographically correct | **PASS** | §2.1 |
| Temporal filtering is correct | **PASS** | §2.2 |
| Provenance survives synthesis | **PASS** | §2.3 |
| Availability is explicit | **PASS** | §2.4 |
| Deterministic re-query produces identical context | **PASS** | §2.5 |
| No direct bypass around as-of fact access exists | **PASS**, after a fix | §2.6 |
| All tests green | **PASS** | §3 |
| No CRITICAL/HIGH findings | **PASS**, after 12 fixes | §4 |

## 2. What was proved, and how

### 2.1 Spatial correctness

Every spatial predicate in the new code is `geography(4326)` — `ST_DWithin`, `ST_Intersects` and
`ST_Distance` are all cast — so the antimeridian and the poles are handled by PostGIS rather than
by arithmetic in this repository. Reviewer A checked this specifically and found no defect;
`vincentyDistanceMeters` takes the longitude difference through trigonometry, so wrap is handled
there too.

Radii are stated in kilometres and multiplied by 1,000 at every call site. The P6 geo work
(`packages/geo`, G5) is unchanged and its PostGIS agreement test still passes.

The one spatial *product* defect found was not in the SQL: `FAMILY_SEARCH_RADIUS_KM` looked 1,500 km
for earthquakes with no time bound, so a place 370 km from a 2011 event reported it as current
(§4, ADR-037).

### 2.2 Temporal correctness

- `observationsAsOf`, `linksAsOf`, `clusterVersionsAsOf`, `healthAsOf` and the new
  `derivationsAsOf` all filter on knowledge time. For a derivation the knowledge time is
  **`finished_at`**, not `started_at`: a run in flight has produced nothing a reader can see.
  Proved by `analysis-runs.int.test.ts` — "does not credit a run that had not finished yet at T"
  and "never reports a RUNNING run, whatever the knowledge time".
- A snapshot does not see a fact ingested after its `asOf`, **and its hash does not move** when one
  arrives — a replay that drifted as new data arrived would not be a replay
  (`snapshot.int.test.ts`).
- Correlation is bounded by `asOf` on its work list, and re-running it over unchanged facts
  considers zero records.
- **The replay horizon is now enforced.** It was published in `asOfContext` and never checked, so a
  replay past retention returned an empty result — which ADR-035 forbids in terms: "must be
  reported as *outside the indexed window*, never as an empty result". Fixed and tested.

### 2.3 Provenance

Provenance is by **reference**, not by copying: `EV:OBS:<version_id>` points at the immutable
version row, `EV:COR:<link_id>` at the correlation decision, `EV:FCV`/`EV:FDS` at the cluster
version and its detection set. A test asserts the serialized snapshot contains no provider payload
and stays under 200 KB.

Invariant I9 holds: every evidence ID carried by an item, a fact, a relevance reason or a source
health entry is present in the manifest the build returns, asserted by traversal rather than by
spot check.

Two provenance defects were found and fixed: an agreement claim resting on three links cited only
one of them, and the manifest contained evidence for items the card had deliberately withheld.

### 2.4 Availability

The availability model has five axes now, and each exists because a specific absence would
otherwise read as an observation:

| Axis | The lie it prevents |
|---|---|
| Coverage | "No weather warnings" for a place no weather source covers |
| Source health | "Nothing happened" while the feed is down |
| **Derivation** | "No fire activity" over 235,707 unclustered detections |
| **Replay horizon** | "Nothing happened that day" when retention dropped the day |
| **Unassessed subjects** | "Nothing to report" beside a Red drought alert with no drought model |

`mayRenderZero` is carried into the contract through the field that already means it: an
`AVAILABLE` card with nothing to show and no right to claim emptiness is reported `UNAVAILABLE`,
which is what invariant I11 already says. `NOT_COVERED` is left alone, being the more specific
answer.

### 2.5 Determinism

- Two builds of the same knowledge time produce the same `contentSha256`.
- `generatedAt` is excluded from the hash; two builds 90 minutes apart hash identically.
- A changed fact changes the hash; a changed engine version changes the hash.
- Item order does not depend on insertion order, proved with the rows deliberately arranged so the
  database returns them in the *wrong* order.
- Canonical serialization: keys sorted by **code unit** (not locale), one spelling per number,
  `-0` normalized, and `undefined`/`NaN`/`Infinity`/`Date`/`bigint` rejected rather than
  serialized. 16 unit tests.
- Two `localeCompare` calls in `packages/correlation` reached the hash through the headline
  magnitude and were replaced with code-unit comparison — the exact hazard `content-hash.ts`
  documents.

Correlation is deterministic too: it processes in origin-time order with an id tiebreak, proved
with a three-event chain where processing order genuinely changes the grouping.

### 2.6 No as-of bypass

`packages/briefing` imported the `@geonerva/db` **root barrel**, which re-exports
`./repositories/index.ts` — so every repository, including `listVersions` and `linkRecord`, was in
its import surface. The existing `web-reads-facts-only-through-asof` rule is enforced from
`apps/web`, which imports no service yet, so it was **vacuously green**. A repository read returns
the newest row rather than the row as of `T`, so a replay would have shown the present.

Fixed: briefing imports `@geonerva/db/asof`, and a new rule
`briefing-reads-facts-only-through-asof` fails the build on any path from briefing (excluding
tests) to a repository. **The rule was verified to fail** when the old import is reintroduced,
rather than assumed to work.

## 3. Tests

| | Count |
|---|---|
| Unit | **837 passed** |
| Integration (real PostGIS) | **338 passed**, 19 files |
| `pnpm check` (typecheck + eslint + prettier + unit) | **exit 0** |
| `depcruise` | no violations, 190 modules, 662 dependencies |

Mutation controls run this phase: **10** on agreement, **6** on the availability derivation axis,
**6** on `derivationsAsOf`, **8** on the correlation runner, **9** on the snapshot. Of those 39,
**9 initially survived**. One was a genuinely redundant SQL predicate (removed); the other eight
were tests that did not discriminate, and each was rewritten until it did. That ratio is the
argument for running controls at all: a fifth of the tests written this phase were not yet
evidence of anything.

## 4. The adversarial reviews

Two independent reviews, correctness and architecture/security. **Every CRITICAL and HIGH is
fixed**, each with a regression test. The ones worth naming:

1. **A republication was linked as an independent source.** ADR-030 states the required behaviour
   verbatim; `isRepublication` existed and was consulted only by the magnitude veto. The P0 Luzon
   pair was therefore reported as *two independent sources in conflict* when it is one solution
   restated with a stale magnitude — the most expensive available answer.
2. **The fire card could never hold an item**, and its derivation axis was measured against the
   wrong table. The defect the axis was added to prevent, reproduced one layer up, three commits
   later.
3. **A subject no model could assess was silently deleted**, and the resulting emptiness reported
   as "nothing to report".
4. **A seed run vouched for earthquake correlation**, because both wrote the same
   `analysis_runs.kind`.
5. **Every family was permanently `PARTIAL`**, which silenced three other axes and made the
   independent-source count — the thing this phase was built around — unable to change any outcome.
6. **The snapshot had no recency window** (ADR-037) and **the replay horizon was never enforced**.
7. **The as-of bypass** in §2.6.

Both reviewers independently found findings 2, 3, 4 and the `localeCompare` and `canonicalJson`
issues. Independent agreement on a finding is not proof, but disagreement would have been a reason
to look harder, and there was none on the serious ones.

ADR-036 asserted two things about its own commit that were false — that the as-of rule was
untouched and that briefing could not write. Both are corrected in the ADR itself, along with the
cost it did not name: the headline magnitude is now chosen in two places.

## 5. Contention probe

The handoff carried an unresolved observation: 7 of 257 integration tests failed during a
concurrent ~116k-row ingest, output not captured, not reproduced in five runs.

A probe was built: a load generator writing ~2 M rows per cycle across 6 connections into a
scratch database on the **same PostgreSQL server**, running continuously while the full integration
suite ran, repeated three times with full output captured.

| | |
|---|---|
| Passes | 3 |
| Suite result each pass | **329/329 passed** |
| Suite duration under load | **297 s** (against ~100 s idle) |

The 3× slowdown says the contention was real and substantial. The suite tolerated it without a
single failure. **This does not diagnose the original observation**, and it is not closed — see §7.

## 6. Open items (MEDIUM and below, accepted for G6)

1. **No lease on `analysis_runs`.** Two overlapping `CORRELATION` runs can each open a canonical
   event for one earthquake before the other's projection lands. The worker is single-instance and
   the scheduler does not overlap runs, so this is latent rather than observed. It belongs with the
   scheduling work in **P10**. The misleading comment that claimed the risk did not exist has been
   corrected.
2. **`canonical_event_state` is a non-bitemporal projection of a bitemporal store.** ADR-036 now
   records the alternative that should be revisited — a versioned projection read by a fifth as-of
   reader — and why it was not done under P6.
3. **Baseline metrics are empty.** `FamilyCard.metrics` is `[]`; baselines are P6's neighbour, not
   its content, and `packages/baselines` is unbuilt.
4. **Source configuration is not versioned**, so coverage for a past `asOf` reflects today's source
   set. `active_from`/`active_to` are now honoured, which covers the case that actually misleads (a
   satellite that was not yet in orbit); the general problem is recorded in `productCoverageFor`.

## 7. Carried forward, unresolved

**The intermittent 7-test integration failure remains unexplained.** The probe in §5 did not
reproduce it. No cause is claimed.

A **separate** intermittent failure was diagnosed this session and is recorded here because it is
the same *class* and because the lesson is the one the handoff already taught:

> `scripts/lint-rules.test.ts` failed twice in fifteen consecutive unit runs. The first run
> captured nothing, repeating the original mistake. A capturing loop reproduced it in two of
> fifteen: the first `ESLint.lintText` call loads the entire flat configuration and exceeded
> vitest's 5 s default `testTimeout`, so whichever `it.each` case ran first failed with a timeout
> message and nothing about lint rules. Warming ESLint in a `beforeAll` — which runs under
> `hookTimeout`, the right bound for setup — gives **20 clean runs out of 20**.

Whether the original 7-test failure shares this mechanism (a timeout under load, presenting as
unrelated tests failing) is a **hypothesis, not a finding**. `vitest.config.ts` already documents a
third instance of the same shape from an earlier phase. The pattern is worth watching; it is not
worth asserting.

## 8. What P6 delivered

- `packages/correlation`: agreement and the headline value, with the independent-source count that
  refuses to treat a copy as corroboration.
- `packages/pipeline`: the correlation runner against the database, and single-source event seeding.
- `packages/db`: `analysis_runs` repository, `derivationsAsOf`, `productCoverageFor`,
  `newestDetectionIngestAt`, and the reads correlation needs.
- `packages/relevance`: the derivation, replay-horizon and unassessed-subject axes.
- `packages/briefing`: `buildSnapshot`, canonical serialization and the content hash, family
  coverage, the replay horizon.
- ADR-036 (briefing may use correlation, with its correction) and ADR-037 (the recency window).
