# P10 — Deployment & operations: plan

- **Date:** 2026-09-23
- **Gate:** **none.** `IMPLEMENTATION_PLAN.md` §2.4 has no row for P10 — G7 closed P9b and G8 closes
  P11 — so this phase has a prose acceptance criterion instead: *"a 24 h staging soak with ≥ 99 %
  non-provider run success; production smoke green."* The report is `docs/reviews/gate-p10.md`,
  named for the phase and stating that it records an acceptance rather than a gate
  (`docs/reviews/README.md`).
- **Depends on:** P8 (web) and P4 (worker); P9b for the full release. ADR-039 landed between P9 and
  this phase (`ef6e970`), so migrations run to **0021**.
- **Agent owner:** Orchestrator, with the Security Reviewer. Files: `infra/**`,
  `.github/workflows/**`, `docs/DEPLOYMENT.md` (new).
- **Governing spec:** §3's P10 entry, §3a's F-7, F-12, F-15 and S-15b, and `docs/TESTING.md` §10.
- **Scope discipline:** no new product behaviour, no read-model change. Where this phase must touch
  application code — F-2b's crash handlers, a version stamp, web start-up validation — it is to
  make the deployment observable, not to add features.

## 1. What is already frozen, and what that costs this phase

| Frozen thing | Consequence for P10 |
|---|---|
| **ADR-026: no build step.** The worker runs `node src/main.ts` with Node 24 type stripping | The image ships sources, not a bundle — and it must keep the **workspace layout**, because Node will not strip types under `node_modules` and resolves symlinks before deciding. See §4.1: flattening was tried and fails at the first import |
| `apps/web/proxy.ts` is the only place that sets CSP (two headers intersect) | Nothing in the deployment may add a second CSP — not Vercel headers, not a CDN |
| `TRUSTED_PROXY_HOPS = 1`, a compile-time constant (`lib/server/rate-limit.ts:64`) | Putting a CDN in front of the platform silently breaks IP-keyed rate limiting until the constant changes and the app is rebuilt. Deliberate, per its comment; the runbook must say it out loud |
| `app/layout.tsx:29` `force-dynamic` | No HTML is CDN-cacheable, so Vercel Hobby's CPU budget is spent on every request. A cost fact, not a bug |
| `ingestion_runs` is the single source of truth for health, and `error_class` separates provider failures from ours (ADR-032, migration 0011) | The soak metric is a query over this table, not a log scrape |
| The run lease: one `RUNNING` row per `(source_id, product_id)` | A container killed with `SIGKILL` leaves a lease behind. `stop_grace_period` must exceed a poll, and the unit must send `SIGTERM` |
| `sources.policy.polling` lives in the database, read once at start-up | Changing a poll interval is a data change **plus a worker restart**, and a restart over an hour creates a chain gap in backfill continuity. Restart policy is a data-correctness decision |

## 2. Five things block the phase rather than the work

1. **There is no git remote and no `gh` on this machine** (standing item E-1). Every workflow this
   phase writes is unexecuted until the owner creates the remote. Worse, CI's `build-e2e` job runs
   `pnpm test:e2e` with **no Postgres service and no `DATABASE_URL_TEST`** — that job has never run
   on a hosted runner and probably cannot pass as written. **It goes first**, because P10's smoke
   workflows would inherit the same mistake.
2. **No Supabase, Vercel or VM account.** Creating them acts in the owner's name with the owner's
   credentials. This phase produces manifests, settings and the runbook; the owner performs the
   account steps. **This is the long pole** and nothing else waits on it.
3. **The soak metric does not exist, and its definition is genuinely ambiguous.** The only 24 h
   query in the tree (`runTally24hAsOf`, `asof.ts:1592`) counts `PARTIAL` as failure and does not
   split provider from us. Worse, the split runs the *opposite* way from source health:
   `deriveSourceHealth` excludes only `ABORTED` and deliberately counts `CONFIG_ERROR` as a failure
   (`enums.ts:371-378` records an earlier comment that said the opposite and was wrong). P10 must
   write the query and rule on `SKIPPED`, `PARTIAL` and the denominator — §3 does.
4. **Nothing records which build is running.** `worker_heartbeat.version` receives `NODE_ENV`
   (`start.ts:116`) and `ingestion_runs.worker_version` is `NULL` for every scheduled run. A 24 h
   soak that cannot attribute a failure to a build is not evidence.
5. **`docs/TESTING.md` §10 item 2 contradicts the shipped worker.** It wants every P0 source
   ≠ `UNAVAILABLE`, but `SCHEDULED_ADAPTERS` is `[usgsAdapter]` (`start.ts:30`), so the rest read
   `UNAVAILABLE` on day one. Scheduling them turns latent findings live (gate-g8 §6).

**Rulings, mine as orchestrator, recorded rather than left implicit.**

- **The soak counts scheduled live polls only** (`isLivePoll`, as source health already does), and a
  run is a **non-provider success** unless its `error_class` is ours. `SKIPPED` counts as success —
  it is the worker correctly declining to poll — and `PARTIAL` does **not**, following
  `runTally24hAsOf` rather than `SUCCESSFUL_RUN_STATUSES`, because a run that rejected records did
  not do its job. The denominator excludes provider-side failures entirely, so a provider outage
  can neither pass nor fail the soak. Written into the script's own docblock, not just here.
- **§10 item 2 is read as "every *scheduled* P0 source"**, with the unscheduled ones listed as the
  "explicit known outage" the item already allows for. Scheduling EMSC/GDACS/FIRMS is P11 work at
  the earliest, and doing it here to satisfy a smoke check would be the tail wagging the dog.
- **The soak runs USGS only**, for the same reason. It measures the deployment, not the source count.
- **The soak needs a floor, not just a rate.** Running the container here, every USGS fetch failed
  with `errorClass=NETWORK` — this machine's antivirus intercepts TLS and the container does not
  trust its CA. `NETWORK` is in `PROVIDER_ERROR_CLASSES`, so a broken egress path *on our side*
  (proxy, DNS, certificate trust) is attributed to the provider and excluded from the denominator.
  A deployment that could not reach a single source would therefore report 100 % non-provider
  success while ingesting nothing. The soak report must state its denominator and fail when there
  are too few non-provider runs to mean anything, and it must show the provider-failure count
  beside the rate rather than hiding it.

## 3. Order of work

Local and verifiable first, so nothing waits on an account that need not.

```text
1  worker image            infra/worker/Dockerfile                    built and run locally
2  F-2b crash handlers     apps/worker/src/main.ts                    + unit test
3  build identity          GEONERVA_BUILD env → heartbeat, runs       + integration test
4  VM bootstrap            infra/worker/compose.yml                   read-only FS, SIGTERM
5  soak metric             scripts/soak-report.ts                     the §2.3 ruling, in code
6  production smoke        scripts/smoke.ts                           TESTING §10's nine checks
7  web start-up validation apps/web/lib/server/config.ts              F-12's web half
8  workflows               .github/workflows/{live-smoke,backfill}.yml pinned like ci.yml
9  runbook                 docs/DEPLOYMENT.md                         everything above, in order
```

1 and 2 are independent of every account. 3 must precede 5, or the soak cannot name a build. 6
needs a URL and so is written against `localhost` first. 8 needs the remote. 9 is last because a
runbook written before the steps have been run is fiction.

## 4. Assumptions that could invalidate this design

1. ~~**`pnpm deploy --prod` produces a tree Node can run without the workspace symlinks.**~~
   **Falsified, 2026-09-23, by building it.** Node refuses to strip types under `node_modules` and
   judges that by the real path after resolving symlinks; `pnpm deploy` copies workspace packages
   *into* `node_modules`, so the image built cleanly and died on its first import
   (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). **ADR-026's no-build-step decision therefore
   requires the deployed artifact to keep the workspace layout.** The image now does a filtered
   production install (`--filter=@geonerva/worker... --prod`) and copies the repository with its
   symlinks intact. Worth knowing before anyone tries the same shortcut for the web app.
2. **The worker writes nothing to disk**, so a read-only root filesystem holds. The survey found no
   `writeFileSync`/`mkdirSync`/`tmpdir` in the worker's reachable packages, and logging is a
   `process.stdout.write`. *Test: run the container with `--read-only` and no tmpfs.*
3. **Supabase's transaction pooler tolerates what Kysely emits.** ADR-008's no-named-prepared-
   statements property holds by construction, but S-15b asks for proof against the real pooler under
   load. *Not testable locally — it stays open with a written procedure.* **This is the most likely
   place for P10 to find a real defect.**
4. **Supabase Free does not pause a project that is being written to every few minutes** (owner
   decision Q2's risk). If it does, the soak's denominator collapses and the metric is meaningless.
5. **`output: 'standalone'` is not needed**, because the target is Vercel. If the owner chooses a
   self-hosted web process instead, standalone plus pnpm symlinks plus `.ts` workspace sources is
   untested ground and becomes its own task.

## 5. Definition of done

- The worker image builds from a digest-pinned base, runs as non-root on a read-only filesystem,
  answers `check-config`, and stops cleanly on `SIGTERM` with no `RUNNING` lease left behind.
- `scripts/soak-report.ts` prints the non-provider success rate and its denominator from
  `ingestion_runs`, with the §2 ruling in its docblock, and `scripts/smoke.ts` implements all nine
  of TESTING §10 against a base URL, exiting non-zero with the check number.
- F-2b is closed: an unhandled rejection is redacted by `describeUnexpectedError`, not by Node's
  default printer. F-12 is closed on the web side as it already is on the worker's.
- Every run carries a build identity, in both the heartbeat and `ingestion_runs.worker_version`.
- `docs/DEPLOYMENT.md` exists and a reader who has never seen the repository can follow it.
- What stays open is written down as open, with its owner: E-1, F-15's two contacts (the addresses
  are the owner's to choose), S-15b's pooler proof, F-7's live verification, the structural-only
  least privilege, and the retention sweep.
- Every gate command passes and the tree is clean.
