# Gate G8 — the read-only domain API

- **Date:** 2026-09-21
- **Commits:** `e2927f1` → `e21fbc2` — 6, plus this report
- **Verdict: FAIL.** Not because anything built is unsound, but because the gate's own criterion is
  "all P0 `/api/v1` endpoints" and **4 of 11 are served**. §6 lists what is missing and why, and §7
  explains why three of the seven cannot be built without earlier phases' packages existing.

**A naming warning, first.** This gate is the one the P8 continuation prompt defines. The
repository's own acceptance criterion for its phase P8 is **G6**, not G8
(`docs/IMPLEMENTATION_PLAN.md`, "Acceptance criteria: G6"), and the repository's G8 is a different
thing entirely. The two numbering schemes diverged at G6; this file uses the prompt's. The same
warning appears at the top of `gate-g7.md` for the same reason.

## 1. The six questions the checkpoint must answer

| Question | Answer |
|---|---|
| Did any architectural assumption change? | **Yes, three**, all recorded. See §2. |
| Does any endpoint depend on runtime AI? | **No.** Mechanically verified: no path from `apps/web` (excluding tests) reaches `packages/ai`, even transitively. §3.1 |
| Was any production or external provider called? | **No.** No path from `apps/web` reaches `packages/sources`, `packages/pipeline` or `packages/http`. §3.1 |
| Did any live-model call occur? | **No.** Not once, anywhere in this phase. There is no code path from the API to a model client. |
| Does the web process have any write capability? | **Yes, and bounded**: `rate_limit_buckets` only, asserted numerically. §3.2 |
| Do replay/as-of invariants hold through the API boundary? | **Yes**, tested at the endpoint *and* at each read, and mutation-verified. §4 |

## 2. Architectural assumptions that changed

**2.1 ADR-038 is proposed, not accepted.** `ObservationEvidenceDetail` declares `rawExcerpt`,
`rawPayloadSha256` and `rawPayloadPruned`, and ADR-033 names the mechanism: the evidence endpoint
"can still say what was ingested and prove the bytes by digest". Migration 0007, implementing
ADR-008, revokes `SELECT` on `raw_source_records` from `geonerva_web` in the same words as the
opposite intent — "the web role must never be able to reach the raw provider payloads it has no use
for". A query joining that table from the web process does not return a NULL; it raises
`permission denied` on the endpoint whose purpose is making a citation checkable.

Neither decision is wrong: 0007 is right about the *body*, 033 about the *metadata*. The frozen
contract conflates them by grouping three fields. The recommendation is a column-level grant
excluding `payload`, exactly the pattern 0007 already uses for `agent_outputs`. Until it is
decided, the reads avoid the table and the fields report only what GeoNerva can establish —
`rawPayloadPruned` from `observation_versions.raw_record_id`, which the web role can read.

**2.2 `web-reads-facts-only-through-asof` gained a test exclusion.** Its sibling rule,
`briefing-reads-facts-only-through-asof`, already had one with the reasoning written out: "Tests may
reach repositories: they are building the state the read path then reads." The web rule was written
before any endpoint existed and so had never had a test to consider. The exclusion was verified not
to hide a production violation: reintroducing the `@geonerva/db` root-barrel import in
`apps/web/lib/server/db.ts` still produces **99 errors** under the rule.

**2.3 `packages/db` gained two subpaths.** `./client` and `./rate-limit`. The first exists because
the root barrel re-exports the repositories, and importing it from `apps/web` makes all five
reachable — a repository read returns the newest row rather than the row as of `T`, so a replay
would silently show the present. The second exists because `rate_limit_buckets` is a counter rather
than a fact, and the path-based rule cannot tell the difference; putting the counter beside
`asof.ts` rather than under `repositories/` keeps the rule's letter and its intent.

Two things did **not** change and are worth stating because they look like changes. The
`isReplay` flag uses a five-minute threshold (matching `buildSnapshot`) while the immutable-cache
decision uses one hour (matching §13.1); they answer different questions and both numbers are the
documents'. And `/sources/status` is cached for sixty seconds even for a replay, because the
response carries the source *catalogue*, which is reference data updated in place and therefore not
immutable at any knowledge time.

## 3. The claims that are enforced rather than described

### 3.1 No AI, no provider, no outbound network

Verified with dependency-cruiser rules added temporarily and then removed, over the whole graph
(234 modules, 837 dependencies): no path from `apps/web`, excluding its tests, reaches
`packages/ai`, `packages/http`, `packages/sources` or `packages/pipeline`. The last two are the
standing `web-is-read-only` rule; the first two were checked for this report.

So "the API must function with `AI_MODE=disabled`" is not a configuration the API respects — it is
a variable the API cannot read, because nothing it can reach consults it. `ai: null` is asserted on
every briefing response and in the contract test.

### 3.2 The write capability, stated numerically

`geonerva_web` may `INSERT`/`UPDATE` exactly `rate_limit_buckets` and `geocode_cache` (migration
0007). The read path uses the first on every request and does not touch the second yet. An
integration test asserts this as a census rather than by inspection: a briefing leaves
`observation_versions`, `source_records`, `canonical_links`, `ingestion_runs`, `analysis_runs`,
`location_snapshots` and `geocode_cache` at exactly their previous row counts, and the counter one
row heavier.

`pruneRateLimitWindowsBefore` exists and nothing calls it. That is deliberate and consistent: it is
a `DELETE`, which the web role cannot perform, and it joins `prunePayloadsBefore` and
`dropDetectionPartitionsBefore` — both also uncalled — in waiting for the retention job that
ADR-033's policy table implies and no phase has yet scheduled. §7.

## 4. Knowledge time through the boundary

Every new read is bounded on the column that actually participates in replay: `ingested_at` for
observation versions, `as_of` for cluster versions, `committed_at` for runs, `linked_at` for
correlation links. Three of those filters were **untested** when first written, and the way that
was discovered is worth recording, because it generalises.

`GET /evidence/{id}` filters the knowledge time twice — once in the detail read and once in the
manifest resolver. Deleting `AND v.ingested_at <= ${asOf}` from `observationEvidenceAsOf` therefore
left the entire API integration suite green: the second filter still produced the 404. The
endpoint behaved correctly for a reason the test could not see, and a read whose own filter is
masked downstream is a read that will lose it silently. Each of the five new reads is now tested at
the read, in `packages/db/src/asof.int.test.ts`, and all three mutations are killed.

One asymmetry is documented rather than fixed. `worker_heartbeat` is a single row updated in place
with no history, so a replay cannot reconstruct what it said at a past knowledge time. The read
withholds a heartbeat stamped after `asOf` — the present must not leak into the past — which means
a replay reports `null`. That is acceptable because worker liveness is an operational signal about
GeoNerva rather than a fact about a hazard, and it never influences hazard availability: a source is
`UNAVAILABLE` because its own runs say so (ADR-022).

## 5. Tests

| | At P8 baseline | Now |
|---|---|---|
| Unit | 957 | **1,370** (+413) |
| Integration | 358 | **489** (+131) |

`pnpm check` exit code **0** (typecheck, eslint, prettier, dependency-cruiser over 234 modules,
unit tests).

The integration suite was run in full **thirteen times** during this phase. Ten were entirely
green; the three failures are recorded here rather than summarized, because two of them are the
subject of §8 and §7.5:

| Run | Result | Duration |
|---|---|---|
| 1 | 450/451 — `partition-repair` hook timeout | 332 s |
| 2 | 451/451 | 136 s |
| 3 | 451/451 | 191 s |
| 4 | 461/462 — `partition-repair` hook timeout | 347 s |
| 5 | 462/462 | 140 s |
| 6 | 489/489 | 233 s |
| 7 | 489/489 | 141 s |
| 8 | 489/489 | 240 s |
| 9 | 489/489 | 183 s |
| 10 | 484/489 — five `emsc.int.test.ts` failures | 214 s |
| 11 | 489/489 | 203 s |
| 12 | 489/489 | 166 s |
| 13 | 489/489 | 229 s |

The test count rises across the table because tests were added as the phase went on. Both
`partition-repair` failures predate the hook budget in §8, and both occurred on runs that took over
330 s — the slowest two in the table, which is what pointed at contention before the cause was
measured. Runs 11–13 are after the final change.

**110 mutation controls** were run against this phase's code:

| Target | Killed |
|---|---|
| `params.ts` | 16 / 16 |
| `source-status.ts` | 20 / 20 |
| `evidence-view.ts` | 20 / 20 |
| the new as-of reads | 13 / 13 (after correcting 2 non-unique anchors) |
| rate limiting | 20 / 21 |
| the contracts and the OpenAPI document | 15 / 15 |

**Eleven controls survived on their first run.** Eight were real gaps in my tests and are fixed;
each is worth naming because each is a different way a test can be vacuous:

1. `unionCapabilities` filters over `SOURCE_CAPABILITIES`, so it drops an unknown value as a side
   effect of how it is built. Asserting only the source-level union could not see a narrowing
   function that stopped narrowing; the *product's* list is where it shows.
2. The heartbeat staleness tests derived their expectations from
   `WORKER_HEARTBEAT_STALE_AFTER_S`, so widening that constant to an hour moved the constant and
   the expectation together. They now assert the requirement — §14's one-minute interval, twice —
   as literals, with the boundary at 119/120/121 seconds.
3. The product health lookup key `(sourceId, productId)` type-checks as `sourceId` alone and passes
   every single-product test while giving two products of one source the same status. On this page
   that reports a dead feed as healthy because a sibling feed is fine.
4. `caps an absurd perSource` seeded **one** run and asked for ten thousand, which returns one row
   whether the cap exists or not. A bound can only be tested from above it.
5. The I11 refinement in the response schema was never *exercised*, because no real response had
   ever violated it. A refinement no test tries to break is a comment.
6. The I15 refinement, likewise: every briefing test sent an already-rounded coordinate, so
   removing the rounding changed nothing.
7. The problem-document status was compared only to the HTTP status — which is circular, because
   the HTTP status is built from that field. The frozen `PROBLEM_STATUS` table is the independent
   reference.
8. The 32-byte bucket-key guard had no test at all.

Three survivals were **my own faulty mutations** (a no-op string replace, and two anchors that
matched the first of two occurrences in `asof.ts`, mutating `healthAsOf` and `sourceCutoffsAsOf`
instead of the functions under test). The mutation runner now requires a unique anchor.

Two survivors are recorded as **equivalent mutants**, not gaps:

- Removing `committed_at IS NOT NULL` from `runEvidenceAsOf` changes nothing, because
  `NULL <= asOf` evaluates to NULL and the row is excluded anyway — verified against the server.
  The clause stays because it states the intent.
- Removing the length fast path in `ipPrefix` changes no output: every input it rejects is also
  rejected by the IPv4 pattern or the IPv6 expander, which the suite demonstrated by staying green
  under the mutation.

### 5.1 Contract tests

The read models were frozen at G2 as **TypeScript interfaces**, which vanish at run time, so P8's
"OpenAPI generated from Zod" and "contract tests (Zod ↔ OpenAPI)" were not possible as written.
`packages/domain/src/read-models/schemas.ts` supplies runtime schemas, each carrying a compile-time
proof that its inferred type *is* the frozen interface, in both directions:

```ts
export type SourceStatusMatches = Expect<Exact<z.infer<typeof sourceStatusSchema>, SourceStatus>>;
```

`Expect<T extends true>` fails to compile when `Exact` resolves to `false`, so a field added to
either side is a typecheck failure rather than a drift. The proof earned its keep immediately:
`problemDetailsSchema` declared `traceId: z.string()` while the contract says `string | null`, and
a schema stricter than the contract it describes would have rejected a legitimate response in its
own contract test.

Four refinements encode invariants the type system cannot express — I10 (`CRITICAL` requires an
authoritative basis, and no other level may carry one), I11, I15, and I9/I12 over the assembled
briefing by walking the finished document for citations rather than enumerating the fields that
carry them.

`docs/openapi.json` is generated and committed, with a test that fails when it drifts from the
generator. `reused: 'ref'` is not cosmetic: inlined, the document was **964 KB**, because a
briefing repeats `FamilyCard` once per family and each repeat carries `SubjectSummary` beneath it.

## 6. What is not built

| Endpoint | State | Why |
|---|---|---|
| `GET /briefing` | **served** | |
| `GET /evidence/{id}` | **served** | |
| `GET /sources/status` | **served** | |
| `GET /replay/horizon` | **served** | |
| `GET /events` | not served | The response schema is written; it needs a **bbox** as-of read. `observationsAsOf` and `clusterVersionsAsOf` take a point and a radius, and a viewport needs a box with antimeridian splitting. |
| `GET /events/{publicId}` | not served | `EventDetail` has no runtime schema yet; it is the largest of the frozen contracts. |
| `GET /fire-clusters/{publicId}` | not served | `FireClusterDetail` has no runtime schema yet. |
| `GET /history` | **blocked** | `packages/baselines` is a 6-line stub. There are no baseline metrics to serve. |
| `GET /places/suggest` | **blocked** | `packages/geocoding` is a 7-line stub and the GeoNames import has not been written. |
| `GET /places/search` | **blocked** | As above, plus the Nominatim adapter. |
| `GET /places/reverse` | **blocked** | As above. |

Also not done from the plan's task list: **task 2** (the GeoNames import and the Nominatim adapter,
marked **[P0]** in the plan), **task 4** (worker-side materialization for curated places), and the
**latency benchmark** (p95 < 600 ms on a seeded dataset) — no latency figure is claimed anywhere in
this report, because none was measured.

The rate limits for `places/search` — 10/min per key plus the global 1/s that protects the
Nominatim standing — are **defined and tested** ahead of the endpoint, including the fail-closed
behaviour that distinguishes them from every other limit. That is deliberate: the global ceiling
exists to protect a commitment to someone else, and it should exist before the endpoint that can
break it.

## 7. Open items carried forward

1. **ADR-038 awaits a decision.** Until then `/evidence/{id}` serves `rawExcerpt: null` and
   `rawPayloadSha256: null`.
2. **`dataQuality` is empty**, and empty means "GeoNerva reports no data-quality checks", not "all
   checks pass". `docs/TESTING.md` §7 defines five runtime invariants and places them in the
   worker, which does not compute them and has no table to write them to. Five fabricated
   `status: 'OK'` rows would invert the purpose of the page.
3. **No retention job schedules any sweep.** `prunePayloadsBefore`,
   `dropDetectionPartitionsBefore` and now `pruneRateLimitWindowsBefore` all exist and none is
   called.
4. **`place=p:<id>` resolves to `LOCATION_NOT_FOUND`**, because the `places` table is empty until
   the GeoNames import exists. That is the honest answer: a placeholder label with real coordinates
   would produce a briefing that is correct about a location the user did not name.
5. **The `emsc.int.test.ts` intermittent is still open.** A full run during this phase failed five
   of its tests with "expected 'FAILED' to be 'SKIPPED'" and no further detail. Nine runs in
   isolation and six under synthetic write load did not reproduce it. Its assertions now carry
   `describeOutcome`, so the next occurrence reports the error class and the sanitized detail —
   three phases of failures in this file have never named a cause, because the outcome carries
   `errorClass` and the assertions never looked at it. **Not diagnosed, not closed.**

## 8. Environment work, and one correction

The `partition-repair.int.test.ts` hook timeout **is** diagnosed. Named cleanups printed
`slow cleanup: drop the database gn_repair_west_test took 69029 ms`, which named the step; timing
the statements separately named the cause:

```text
gn_repair_west_test: CHECKPOINT 67414 ms, DROP 62 ms
gn_repair_west_test: CHECKPOINT 62697 ms, DROP 74 ms
```

`DROP DATABASE` issues an immediate forced checkpoint and waits for it, so under a write-heavy
suite the flush is the whole cost.

**A correction.** One commit in this phase claimed that checkpointing before the drop *fixed* the
timeout, on the evidence of a single green run. Two further full runs disproved it: the explicit
`CHECKPOINT` only relocates the cost into a statement where it can be attributed. The commit
`e21fbc2` retracts the claim. The hook now has a 300 s budget against a measured 60–85 s cost —
a budget for known work, not a threshold moved to make a failure go away; nothing the test asserts
changed, and the slow-cleanup line still reports any step over five seconds.

**Why it is slow on this machine, and a decision the owner made.** Docker's disk image lives on a
USB-attached SSD, because the internal NVMe drive has no room for it. Measured on both volumes,
a 4 KB durable write costs **1.043 ms on D: against 0.438 ms on C:** — 2.4× slower. A checkpoint is
exactly that pattern, `shared_buffers` is 128 MB, and the container measures ~3.3 ms per 4 KB
durable write, which puts the arithmetic in the observed range. Offered the choice, the owner
elected to keep Docker on the USB volume and accept the wall-clock cost.

**Disk space.** `C:` reached 0.7 GB free during this phase. 2.06 GB was reclaimed from disposable
tool caches, and the owner chose to cap the system page file at 8 GB — it is allocated 26.9 GB on a
16 GB-RAM machine against a recorded peak of 5.1 GB. **That change requires an elevated shell and
has not been applied**; the command is in the session log and `C:` stands at 2.13 GB until it is run
and the machine restarted.

## 9. The adversarial reviews

*(Recorded below once both independent reviews report. Findings are classified
CRITICAL / HIGH / MEDIUM / LOW; every CRITICAL and HIGH is fixed with a regression test before this
gate is reconsidered.)*

## 10. What P8 delivered

- Four of eleven `/api/v1` endpoints, each filling a contract frozen at G2 rather than designing
  one: `/briefing`, `/evidence/{id}`, `/sources/status`, `/replay/horizon`.
- The API foundation: problem+json against the frozen code list, §13.2 validation, §13.1 cache
  policies, one structured log line per request that cannot carry a coordinate, and a single
  application-service contract that a server component will share with the HTTP adapter.
- §13.4 rate limiting, including the `places/search` pair defined ahead of its endpoint, keyed on
  an HMAC of an IP prefix with a daily-rotated secret and reading the client address from the
  *right* of `X-Forwarded-For`.
- Nine new as-of reads, each tested at the read.
- Runtime schemas for six frozen contracts, proved equivalent to the interfaces at compile time,
  and a generated OpenAPI document.
- ADR-038, proposed.
- 413 unit tests, 131 integration tests, 110 mutation controls.
- Two contract bugs in my own work, caught before they shipped: `/evidence/{id}` returned a
  database row rather than `EvidenceDetail`, and `/replay/horizon` returned the bare horizon rather
  than the frozen `ReplayHorizonResponse` wrapper.
