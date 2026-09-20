# Session handoff — 2026-09-20

Written to hand off mid-phase, deliberately and at a clean boundary, rather than to push on and
leave something half-built. The tree is clean, `pnpm check` exits 0, and both suites are green.

## 1. Where this is

| | |
|---|---|
| **Last gate passed** | **G5** — multi-source hazard ingestion (`docs/reviews/gate-g5.md`) |
| **Current phase** | **P6 — spatial hazard intelligence**, part-built |
| **Next gate** | G6 (`docs/reviews/gate-g6.md`, not yet written) |
| **Commits this session** | `ed39648` → `c985432`, 15 commits on `main` |
| **Tests** | **755 unit, 268 integration**, PostgreSQL 17 / PostGIS 3.4.3 |
| **Working tree** | clean |

Two gates were completed in this session, each with two independent adversarial reviews:
**G4** (`docs/reviews/gate-g4.md`, historical earthquake ingestion) and **G5**
(`docs/reviews/gate-g5.md`, multi-source ingestion). Read both gate reports before continuing —
in particular G5 §9, §10 and §11, which record findings, one unexplained failing test run, and
five tests that turned out to be vacuous.

## 2. What P6 has, and what it does not

The session plan's P6 assumes more than the repository had. `packages/geo`, `packages/correlation`,
`packages/relevance`, `packages/baselines`, `packages/changes` and `packages/briefing` were all
six-line stubs, and the repo's own `IMPLEMENTATION_PLAN.md` splits this work across *its* P5 and
P6. Session P6 therefore = repo P5 (geo, correlation, clustering) + repo P6 (relevance). That
mapping is a re-sequencing, not a conflict with an ADR, which is why it was walked rather than
stopped at — the same call made for P4 and P5 (see `docs/reviews/p4-plan.md`).

### Done

| Plan item | State |
|---|---|
| **P6.1** location model | Already existed: `LocationRef`, `parseLocationKey`, `FamilyCoverage` in `packages/domain/src/value-objects/location.ts`. Nothing added |
| **P6.2** spatial query layer | `packages/db/src/spatial/` already had indexed queries, `ST_Covers` containment, viewport/antimeridian splitting and geodesic tests against Marrakech, Montréal, Suva and Longyearbyen. **New:** `packages/geo` — in-process Vincenty, bearings, and `boundingBoxesForRadius` with the containment property, plus a PostGIS agreement test in `packages/briefing` |
| **P6.3** temporal relevance | **All five documented models built**: earthquake (§9.1), fire (§9.2), flood (§9.3), cyclone (§9.4), volcano (§9.5). Every threshold transcribed from `ARCHITECTURE.md`, every boundary probed from both sides, 115 tests |
| **P6.7** availability semantics | `packages/relevance/src/availability.ts`. Resolved from coverage + health + counts; `mayRenderZero` carries invariant I11 |

### Not done — this is the next work

| Plan item | What it needs |
|---|---|
| **P6.4** hazard synthesis | `buildSnapshot(location, asOf, engineVersion)` → `LocationSnapshotView`. **The shape is already frozen** in `packages/domain/src/read-models/location-briefing.ts` and is far richer than the plan's sketch; the plan says "do not freeze this exact shape without checking existing contracts", and the existing contract wins |
| **P6.5** provenance | `EvidenceItem` / `EvidenceId` already exist (`packages/domain/src/evidence/`). Synthesis must attach them, and invariant I9 requires every id referenced anywhere in a briefing to appear in `evidenceManifest` |
| **P6.6** determinism | Invariant I14: same database state + same `asOf` + same `engineVersion` → same `contentSha256`. Needs a test that builds the same snapshot twice and compares hashes, and one that proves a *changed fact* changes the hash |
| **G6** | Criteria are in the session plan. Two independent reviews, then `docs/reviews/gate-g6.md` |

### Blocked, with the reason

- **Fire relevance has never run against real data.** It takes cluster facts — `state`, `n24h`,
  `overpasses24h`, `frpSum24h` — from `fire_clusters` and `fire_cluster_versions`. Those tables
  exist (migration 0005) and **nothing populates them**: clustering is `packages/correlation`,
  still a stub. The model is tested as the pure function it is, against hand-built facts. The
  module header says so.
- **Cross-source corroboration is not computed.** `resolveDataConfidence` takes `corroborated` as
  an input and `assessEarthquake` takes `agreementLevel`; both come from correlation, which does
  not exist. Until it does, every earthquake will report `SINGLE_SOURCE` even where USGS and EMSC
  both hold it — which is *safe* (it understates confidence) but is not the truth, and the
  independence machinery built in P5 (`derivedFrom`, `contributor`) exists precisely to feed it.
- **GDACS cyclone tracks, wind buffers and volcano cones are not ingested.** `assessCyclone`
  takes `insideWind120` and friends; only flood geometry is fetched today. Deferred in G5 §12
  because forecast geometry needs `valid_at` semantics tied to advisory times.

## 3. Unresolved findings

Nothing CRITICAL or HIGH is open. What is open, and where it is recorded:

- **G5 §10 — one integration run failed 7 of 257 tests and has not reproduced** in five subsequent
  full runs. It started seconds after a 116,503-row live FIRMS ingest against the same PostgreSQL
  instance, so contention is the hypothesis; it is not a diagnosis. **The output was not captured
  before it scrolled.** If it recurs, capture first.
- **G5 §9 "Recorded, not fixed"** — seven MEDIUM/LOW findings with stated reasons, the two most
  substantial being that `runFireIngestion` names FIRMS directly (waiting for a second detection
  source, exactly as `HistoricalInterface` waited for EMSC) and that unbounded memory on the FIRMS
  path is *bounded* rather than closed (a 64 MB cap and `MAX_CSV_ROWS`, not streaming).
- **G4 §5 "Recorded, not fixed"** — four items, still accurate.
- **EMSC `evtype` is stored verbatim** because the vocabulary is undocumented by the service.
  Observed values are `ke`, `se`, `ue`. Needs confirming with EMSC before a UI renders it.

## 4. Process notes worth carrying forward

Three habits caught real defects this session, and one process failure recurred three times.

**Mutation testing every rule.** Not optional — it found five vacuous tests in P5 and three more
in P6, including one that could not have caught the defect *both* G5 reviewers found from the
outside. The pattern each time: an assertion that could not move the term it claimed to test. The
cheap version is a python script that applies one textual mutation, runs the suite, and reverts;
`scratchpad/eqctl.py`-style files were used throughout.

**Running the code against the real provider.** Four defects in P5 came from live runs and no test
would have found them: EMSC's bulletin inverts the depth sign, EMSC omits the `mag` key, the
`severity_scheme` value was wrong against a CHECK, and one negative FRP in 121,293 rows killed a
batch. The reviews then found ten more that running it had not reached. The two kinds of check are
not substitutes.

**Writing down the measurement, not the recollection.** One test in `packages/geo` asserted a
"published WGS84 geodesic" of 6,152.6 km that had never been computed from anything; the correct
value is ~5,753 km and the implementation was right. The fix was to write the spherical law of
cosines into the test so it can be checked by hand.

**The process failure: committing on a red gate.** Three times — twice in P4, once in P6 — a
commit went in while `pnpm check` was failing, every time because of the same shape:

```sh
pnpm check 2>&1 | tail -3 && git commit …   # exit code is tail's, which is 0
```

Run the gate so its own exit code is the one being read:

```sh
pnpm check > /tmp/check.log 2>&1; echo "exit=$?"
```

## 5. Architectural context the next session needs

- **Repository state and accepted ADRs are authoritative over the session plan.** This was load
  bearing three times: the plan's EMSC deletion sweep does not exist (the service answers HTTP 400
  for `includedeleted`), the plan's availability vocabulary is thinner than the domain's three
  axes, and the plan's P6.4 shape is a sketch of a frozen contract. `docs/DECISIONS.md` has ADRs
  001–035.
- **The layering rules in `.dependency-cruiser.cjs` are enforced on every edge, tests included.**
  `db → geo` is forbidden with no test exception, which is why the geo/PostGIS agreement test
  lives in `packages/briefing` — the layer allowed both. Do not weaken a rule to file a test.
- **`CRITICAL` relevance is structurally gated.** `packages/relevance`'s `Assessment` cannot carry
  an `AuthoritativeBasis`, so a model can only report that the *condition* is met; the caller
  attaches the citation or reduces the level. That is invariant I10 made structural rather than
  conventional, and the synthesis layer must honour it.
- **The headline must fail closed, and the reason is subtle.** `ARCHITECTURE.md` §9.8: under the
  `geonerva_web` role, RLS deny-all means the fact query *and* the health query return exactly what
  a quiet world returns — and health comes back as an **empty array**, not a status of
  `UNAVAILABLE`. A briefing that looked for `status === 'UNAVAILABLE'` to detect blindness would
  render an all-clear. So: **no health row for a family's sources ⇒ `DATA_UNAVAILABLE`.** The
  absence of health evidence, not a particular status, is the signal.
  `packages/pipeline/src/blindness.int.test.ts` proves the trap is real.
- **`asOf` is the only fact reader.** `packages/db/src/asof.ts` is the as-of layer, and G6 asks for
  proof that nothing bypasses it. `nearestObservationVersions` in `spatial/queries.ts` is a raw
  search over all versions and says in its own doc comment that callers should normally use the
  as-of path — worth checking whether that is enforced or merely advised.
- **The live database has real data to test against**, from this session's runs:
  3,295 source records / 3,295 versions (USGS 2,561, EMSC 529, GDACS 205), 4 role-tagged flood
  geometries, and 235,707 thermal detections across two daily partitions. It is a dev database at
  `127.0.0.1:54320`; integration tests create their own.

## 6. Suggested next action

1. Read `docs/reviews/gate-g5.md` §9–§11 and `ARCHITECTURE.md` §9.8 and §5.
2. Build `buildSnapshot` in `packages/briefing` — it is already allowed to depend on `domain`,
   `geo`, `db`, `relevance`, `baselines` and `changes`. Wire the five relevance models to the as-of
   read path, resolve availability per family, and assemble `LocationSnapshotView`.
3. Make the headline fail closed, with the blindness test as the guard.
4. Prove determinism (I14) and provenance (I9) with integration tests against the real database.
5. Two independent reviews, fix every CRITICAL and HIGH, then write `docs/reviews/gate-g6.md`.

`packages/baselines` and `packages/changes` are still stubs and are needed for the full
`LocationBriefing` (P7), but **not** for `LocationSnapshotView` — `FamilyCard.metrics` can be an
empty array with a stated reason, which is the honest state until baselines exist.
