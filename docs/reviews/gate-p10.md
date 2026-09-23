# P10 — Deployment & operations: acceptance

**This is not a gate report.** `IMPLEMENTATION_PLAN.md` §2.4 defines no gate for P10 — G7 closed
P9b and G8 closes P11 — so the phase has a prose acceptance criterion instead, and this file
records how far it is met. Named for the phase rather than for a gate number, per
`docs/reviews/README.md`.

- **Date:** 2026-09-23.
- **Commits:** `862acde` → `2b1c421` — ten, plus this report. ADR-039 (`ef6e970`) landed between
  the P9 gate and this phase and is included in the range.
- **Verdict: PARTIAL, and deliberately so.** Everything that can be built and verified from this
  repository is built and verified. The criterion itself — *"a 24 h staging soak with ≥ 99 %
  non-provider run success; production smoke green"* — **cannot be met here**: it needs a Supabase
  project, a Vercel project, a VM and a GitHub remote, none of which exist, and a soak is 24 hours
  of wall clock. What this phase delivers is everything that has to be true *before* that soak can
  start, and the two commands that will judge it.

## 1. What was built

| # | Deliverable | Where |
|---|---|---|
| 1 | Worker container: non-root, read-only root filesystem, digest-pinned base, no package manager in the final layer | `infra/worker/Dockerfile`, `.dockerignore` |
| 2 | F-2b's crash handlers — an unhandled rejection is redacted rather than printed by Node | `apps/worker/src/cli/crash-handlers.ts` |
| 3 | Build identity reaching the heartbeat and `ingestion_runs.worker_version` | `GEONERVA_BUILD`, `packages/config`, `cli/start.ts` |
| 4 | VM unit: `read_only`, all capabilities dropped, no-new-privileges, 512 MB and pid ceilings, rotated logs, 90 s stop grace | `infra/worker/compose.yml` |
| 5 | The soak metric, with its rulings and a floor | `scripts/soak-report.ts` (`pnpm soak`) |
| 6 | The production smoke, TESTING §10's nine checks | `scripts/smoke.ts` (`pnpm smoke`) |
| 7 | F-12's web half: the web process validates and announces itself | `apps/web/instrumentation.ts` |
| 8 | Nightly smoke and manual backfill workflows; CI's E2E job given the database it always needed | `.github/workflows/**` |
| 9 | The runbook | `docs/DEPLOYMENT.md` |

## 2. What was measured

At `2b1c421`, on this machine, serially — this machine cannot run the suites in parallel
(`pnpm -r --parallel typecheck` dies with V8 `Zone Allocation failed`, and vitest workers abort
with 134). Every command below is the real one with its real exit code.

```
tsc -p tsconfig.json          exit 0
pnpm -r typecheck             exit 0    (sequential; --parallel OOMs on this machine)
pnpm lint                     exit 0
pnpm format:check             exit 0
pnpm depcruise                exit 0    456 modules, 0 violations
pnpm test:unit                exit 0    2,011 tests
pnpm test:components          exit 0    173 tests
pnpm test:integration         exit 0    42 files · 805 tests
pnpm test:e2e                 exit 0    81 passed · 0 failed (--workers=1)
tests/adversarial             exit 0    13 passed
pnpm build · build:canary     exit 0    no secret canary in client bundles or prerendered output
```

**Run, not only tested.** The container was built and exercised: `check-config` valid on a
read-only filesystem as uid 1000, a scheduled poll executed, `SIGTERM` stopped it in 0.55 s with
exit 0 and **no `RUNNING` lease left behind**, and `worker_heartbeat.version` carried the build
stamp. `pnpm smoke` was run against a production build with a live worker and database: all nine
checks pass, and checks 2 and 7 were each made to **fail** on purpose — an enabled source reporting
`UNAVAILABLE` exits 2, a heartbeat aged past three minutes exits 7.

## 3. Three of the nine smoke checks could not fail

The adversarial review's finding, and the most important thing in this report.

`scripts/smoke.ts` was written against an imagined API shape rather than against
`packages/domain/src/read-models/schemas.ts`. Check 2 read `source.status` where the contract has
`source.health.status`; check 4 looked for a top-level `items` array that `locationBriefingSchema`
has never had, and matched `EQ:` as a subject ref when refs are `CE|FC|SRC|MET`; check 5 asserted
`id`/`kind` at the top level of an evidence response shaped `{ schemaVersion, item, detail,
attribution }`. Checks 4 and 5 had **never issued a request** — the "quiet world" branch, written
carefully and for good reasons, is what hid it.

The phase's own acceptance criterion is "production smoke green". A green smoke was not evidence.
All three now read the frozen schemas and were verified live in both directions (§2).

Two lessons worth carrying, because neither is about this script:

- **A check whose only observed outcome is "nothing to see" has not been observed at all.** The
  quiet-world branch now prints a warning with the number of subjects it walked, so the two cases
  cannot look alike again.
- **The gate report is part of the verification, not a record of it.** Writing this section is what
  would have caught the dead checks a day earlier; the review caught them instead.

## 3a. The blocker deploying found, and ADR-044

Deploying the product for real surfaced something no review had: **`correlateEarthquakes` was called
from nothing**. Not from the worker, not from a CLI, not from a cron — only from its own test. The
first live deployment ingested 245 genuine USGS earthquakes and served
*"GeoNerva cannot currently report on earthquakes"* until correlation was run by hand.

The product was **right** about it. `derivationVerdict` returned `UNAVAILABLE` / `DERIVATION_NOT_RUN`
with `mayRenderZero: false`, so no reader was ever told the world was quiet. That is invariant I11
doing exactly its job, and it is why this was a usability disaster rather than a correctness one.

**ADR-044** schedules correlation in the worker: gated on whether anything has been ingested since
the last successful run's *knowledge time*, serialised by a PostgreSQL advisory lock, and unable to
throw past its own boundary. The lock closes `gate-g6.md`'s open item 1 — *"two overlapping
`CORRELATION` runs can each open a canonical event for one earthquake"* — which had been deferred to
this phase. Verified live: an ingestion at 09:58:40 brought one new version, and correlation ran by
itself 37 seconds later.

Still unscheduled, and now written down rather than assumed: `SEED` (floods, cyclones, other) and
`CLUSTERING` (fire activity). Those families report `DERIVATION_NOT_RUN` in production, honestly.

## 4. Defects this phase found in its own work

- **`pnpm deploy` cannot ship this worker.** ADR-026 runs TypeScript directly, and Node refuses to
  strip types under `node_modules`, judged by the real path after resolving symlinks. `pnpm deploy`
  flattens workspace packages into `node_modules`; the image built cleanly and died on its first
  import. The image keeps the workspace instead. Anyone trying the same shortcut for the web app
  should read this first.
- **The lineage walk had to be driven by its target** (ADR-039, found by review with `EXPLAIN`):
  seeded from `fire_clusters`, PostgreSQL cannot push the target filter into the recursive CTE and
  every fire read plans as a sequential scan of the whole 72-hour detection set.
- **The soak's first query dropped every success from its denominator.** `NOT (error_class =
  'ABORTED')` is NULL for a run that succeeded. Found by writing the integration test.
- **Both new workflows interpolated `workflow_dispatch` inputs into `run:` blocks**, with
  production credentials in scope. Found by reading them again before the review did.
- **CI's `build-e2e` job could never have passed**: it ran `pnpm test:e2e`, which seeds a database,
  with no service and no URL. It had never run on a hosted runner to say so (E-1).
- **The first image shipped 4.6 MB of captured provider payloads** and 83 test files.
- **`instrumentation.ts` claimed throwing "fails the deploy"** — true self-hosted, false on Vercel.

## 5. What the owner has to do, and what stays open

Nothing in this list is work this phase declined; each is an action only the owner can take.

1. Create the Supabase, Vercel and VM accounts, and a GitHub remote (**E-1**). `DEPLOYMENT.md` §0.
2. Set the repository variables, secrets and the `production` environment listed in
   `DEPLOYMENT.md` §4.
3. Start the 24 h staging soak and read `pnpm soak`. **This is the acceptance criterion.**
4. **F-15**: choose the fallback security contact and the Code of Conduct contact, and enable
   GitHub private vulnerability reporting. Both files currently point at a GitHub profile.
5. **S-15b**: confirm against the real Supabase pooler, under load, that no prepared-statement
   error appears. It holds by construction and has never been proven against the pooler.
6. **F-7 is verified in code** (a non-loopback URL without `sslmode` is refused, demonstrated by
   running the container) and still wants one confirmation against the real Supabase URL.

Also still open, recorded rather than left to be found: least privilege is structural rather than
enforced; no retention sweep is scheduled; there is no CSP reporting endpoint and no liveness
endpoint; only USGS is scheduled, so §10's check 2 reads the others as declared outages; and the
per-source provider probe described in `TESTING.md` §9 is unbuilt.
