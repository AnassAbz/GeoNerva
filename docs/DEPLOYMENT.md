# Deployment

How to put GeoNerva into the world, and how to tell whether it is telling the truth once it is
there. Written after each step was run rather than before, so the surprises are in it.

The shape (`ARCHITECTURE.md` §2, owner decision Q2): **Supabase Free** for PostgreSQL + PostGIS,
**Vercel** for the read-only web app, and a **free VM** running the worker in a container.
`RETENTION_PROFILE=lean`, which accepts a 72-hour replay horizon for thermal detections.

---

## 0. What you need before you start

| Thing | Why | Who |
|---|---|---|
| A Supabase project | The database, and the only store of record | Owner |
| A Vercel project | The web app; Hobby is non-commercial only (Q3) | Owner |
| A VM with Docker | The worker. Anything with 512 MB free and outbound HTTPS | Owner |
| A GitHub remote | CI, the nightly smoke, the backfill button | Owner |

Everything below is reproducible from this repository. The four rows above are not: they are
accounts, and they are created by the person who owns them.

---

## 1. The database

1. Create the project. Note both connection strings Supabase gives you — they are **not**
   interchangeable:
   - the **transaction pooler** (port 6543) for the **web** app, because a serverless instance
     opens many short-lived connections;
   - the **session or direct** connection for the **worker**, which needs prepared statements, long
     transactions and `COPY`.
2. Add `?sslmode=verify-full` to both. This is not optional: in production
   `packages/db/src/connection-url.ts` refuses a non-loopback URL whose `sslmode` is missing,
   `disable`, `allow` or `prefer`, and the process exits before it connects. The driver always
   verifies the certificate, because libpq's `require` means "encrypt but do not verify".
3. Run the migrations:

   ```sh
   DATABASE_URL_MIGRATE='postgresql://…?sslmode=verify-full' pnpm --filter @geonerva/db migrate
   ```

   `DATABASE_URL_MIGRATE` falls back to `DATABASE_URL_WORKER` when unset. Migrations are
   checksummed: an already-applied file that has been edited is refused rather than re-run.
4. Grant the group roles to your login role. Migration `0007` creates `geonerva_worker` and
   `geonerva_web` as `NOLOGIN` groups so that no credential lives in a migration. **Read the
   caveat**: `apps/web/lib/server/db.ts` records that the read-only property is not actually
   enforced in either deployment shape available today — as `geonerva_web` under deny-all RLS the
   app reads zero rows, and as the owning login role the grants do not bind. Least privilege here
   is structural, not enforced. It is an accepted residual, written down rather than implied.
5. **Import the gazetteer.** Place search and the named `place=` parameter are empty without it:

   ```sh
   DATABASE_URL_WORKER='postgresql://…?sslmode=verify-full'      pnpm geonames:import path/to/cities15000.txt
   ```

   Exit codes are a contract: `0` every line loaded, `2` some lines refused, `1` anything else.

---

## 2. The worker

Built from `infra/worker/Dockerfile` and run by `infra/worker/compose.yml`.

```sh
docker build -f infra/worker/Dockerfile -t geonerva-worker:$(git rev-parse --short HEAD) .
```

On a machine whose outbound HTTPS is intercepted by a local proxy or antivirus, the install inside
the image cannot verify the registry. Pass the interceptor's root certificate for the build only —
it never becomes a layer, and the runtime stage keeps the stock trust store:

```sh
docker build --secret id=extra_ca,src=./corp-root.crt -f infra/worker/Dockerfile .
```

Never `pnpm config set strict-ssl false`. That turns one machine's trust problem into a
supply-chain hole for everyone.

On the VM, write `/etc/geonerva/worker.env`:

```ini
GEONERVA_WORKER_IMAGE=ghcr.io/…/geonerva-worker@sha256:…
GEONERVA_BUILD=<the git sha you built>
DATABASE_URL_WORKER=postgresql://…?sslmode=verify-full   # session mode, not the pooler
RETENTION_PROFILE=lean
# FIRMS_MAP_KEY=            # absent means keyless FIRMS (24 h window)
```

Then:

```sh
node apps/worker/src/main.ts check-config          # or: docker run … check-config
docker compose -f infra/worker/compose.yml --env-file /etc/geonerva/worker.env up -d
docker compose -f infra/worker/compose.yml logs -f
```

`check-config` first, always. It validates the environment and prints a redacted summary — hosts,
never credentials — and it is the difference between a five-second answer and a restart loop.

**`GEONERVA_BUILD` matters more than it looks.** It is written to `worker_heartbeat.version` and to
`ingestion_runs.worker_version`, and it is what lets the soak report say *which build* produced a
failure. Unset, the worker runs and every run is unattributed.

**Do not shorten `stop_grace_period`.** The worker holds one `RUNNING` row per source and releases
it by handling `SIGTERM`. Killed first, it leaves that lease behind and the source will not poll
again until the lease is judged abandoned, half an hour later.

**A worker stopped for more than an hour is a data decision, not just an outage.** The chain-gap
rule in backfill continuity treats a long silence as a break, so plan restarts rather than letting
the container sit down.

Only **USGS** is scheduled (`SCHEDULED_ADAPTERS` in `apps/worker/src/cli/start.ts`). The other
adapters exist and are not polled; `/data-status` says so, and the smoke check treats a disabled
source as a declared outage rather than a fault. **Disable, in the `sources` table, any source this
deployment does not poll** — a source that is advertised as enabled and never polled reads
`UNAVAILABLE`, which is what smoke check 2 is for.

**Correlation runs itself** (ADR-044). `scheduler.started` names both jobs:

```
usgs:comcat every 300s, correlation:earthquakes every 60s
```

and a healthy deployment shows `correlation.run` lines alternating between `SKIPPED` (nothing
ingested since the last run — the normal state) and `SUCCEEDED` with its counters. If you see only
`SKIPPED` while ingestion reports `newVersions` above zero, correlation is not keeping up and the
briefing will say so on its own: the earthquake card degrades to `DERIVATION_STALE` and refuses to
report a zero. Until this job existed the worker ingested forever and produced no events at all,
which is the failure this runbook most wants you not to meet again.

Floods, cyclones and fire activity depend on derivations (`SEED`, `CLUSTERING`) that **nothing
schedules yet**, so those families report "has not finished processing it" in production. That is
accurate rather than broken, and it is the next thing of this shape to fix.

---

## 3. The web app

Vercel, from the repository root, with `apps/web` as the app. Environment variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (Vercel sets it; the manifest is explicit anyway) |
| `DATABASE_URL` | the **transaction pooler** URL, `?sslmode=verify-full` |
| `RATE_LIMIT_SECRET` | ≥ 32 characters, ≥ 12 distinct, no placeholder words |
| `NOMINATIM_CONTACT` | a real contact address; the OSMF usage policy requires it |
| `MAP_STYLE_URL` | optional; must be `https:` |
| `RETENTION_PROFILE` | `lean` |

`apps/web/instrumentation.ts` parses the environment once per process, before the first request.
Be precise about what that buys on each platform: a **self-hosted** `next start` fails to prepare
and the process dies, while on **Vercel** the hook runs at lambda cold start rather than during
`next build` — so the build succeeds, the deployment goes green, and every request to that instance
fails with the reason in the function logs. **Run `pnpm smoke` immediately after a deploy**; check 1
is what turns a poisoned instance into a red light. On success the process writes one line:
`{"event":"web.starting","detail":"NODE_ENV=production retention=lean"}`.

Two things not to do to the web app:

- **Do not add security headers in Vercel.** `apps/web/proxy.ts` is the only place that sets
  `Content-Security-Policy`; two CSP headers are enforced as an intersection, and the second one
  silently narrows the first until the map stops loading.
- **Do not put a CDN or proxy in front of it** without changing `TRUSTED_PROXY_HOPS` in
  `apps/web/lib/server/rate-limit.ts` and rebuilding. It is a compile-time constant on purpose, and
  an extra hop makes every request look like it comes from the proxy, which breaks IP-keyed rate
  limiting silently.

Note for capacity: `app/layout.tsx` sets `force-dynamic`, so no HTML is CDN-cacheable and every
request costs server time. That is deliberate — the CSP nonce cannot reach build-time HTML — and it
is the main thing that consumes a Hobby plan's budget.

---

## 4. Is it telling the truth?

```sh
pnpm smoke https://your-deployment.example          # docs/TESTING.md §10, nine checks
pnpm soak --hours 24                                # needs DATABASE_URL_WORKER
```

`pnpm smoke` exits with the number of the check that failed, so `7` means the worker heartbeat is
stale and `6` means a header is missing. It reads nothing but HTTP responses and writes nothing.

`pnpm soak` is the phase's acceptance criterion: **≥ 99 % non-provider run success over 24 h**. It
counts scheduled live polls, excludes provider-side failures from the denominator entirely, counts
`SKIPPED` as success and `PARTIAL` as failure, and ignores runs we cancelled ourselves. It also
**fails when there are too few judged runs to mean anything** — because `NETWORK` is a
provider-side class, a deployment whose egress is broken would otherwise report 100 % success while
ingesting nothing. Read the provider-failure count beside the rate, always.

The nightly `live-smoke` workflow runs the same two commands, and `backfill` is the button for a
historical range. What they need in GitHub, none of which is inferable from the code:

| Kind | Name | Used by | Without it |
|---|---|---|---|
| Variable | `GEONERVA_SMOKE_URL` | `live-smoke` | the job skips rather than failing |
| Secret | `GEONERVA_SOAK_DATABASE_URL` | `live-smoke` | the soak step is skipped; the smoke still runs |
| Secret | `GEONERVA_WORKER_DATABASE_URL` | `backfill` | `check-config` fails and nothing is written |
| Secret | `GEONERVA_FIRMS_MAP_KEY` | `backfill` | FIRMS falls back to its keyless 24-hour window |
| Environment | `production` | `backfill` | the job cannot start |

The `production` environment is what makes a backfill an approval gate rather than a button
anybody with write access can press; configure its reviewers when you create it.

---

## 5. Rolling back

The image is pinned by digest in the environment file, so a rollback is an edit and a restart:

```sh
sed -i 's|^GEONERVA_WORKER_IMAGE=.*|GEONERVA_WORKER_IMAGE=…@sha256:<previous>|' /etc/geonerva/worker.env
sed -i 's|^GEONERVA_BUILD=.*|GEONERVA_BUILD=<previous sha>|' /etc/geonerva/worker.env
docker compose -f infra/worker/compose.yml --env-file /etc/geonerva/worker.env up -d
```

Change `GEONERVA_BUILD` with it, or the ledger will attribute the rolled-back build's runs to the
one you just left. The web app rolls back through Vercel's own deployment history.

**Migrations do not roll back.** Every migration so far is additive, and the recovery for a bad one
is a new migration. Plan accordingly.

---

## 6. What is still open

Recorded here rather than left to be discovered:

- **S-15b** — confirm against the real Supabase pooler, under load, that no prepared-statement
  error appears. It holds by construction (Kysely emits unnamed statements, ADR-008) and has never
  been proven against the pooler, because local PostgreSQL is not the thing being tested.
- **F-15** — `SECURITY.md` routes reports through GitHub's private vulnerability reporting and
  `CODE_OF_CONDUCT.md` points at the owner's GitHub profile. §3a asks for a published fallback
  security contact and a Code of Conduct contact; which address to publish is the owner's decision.
  Enabling private vulnerability reporting is a repository setting, not a file.
- **E-1** — CI has never run on a hosted runner. The E2E job's missing database service was fixed
  in this phase by reading the file; whether the suite passes there is still unknown.
- **Least privilege** is structural rather than enforced (§1 step 4).
- **No retention sweep is scheduled.** Nothing prunes yet.
- **No CSP reporting.** `SECURITY.md` §6: a policy break in production is invisible until someone
  reports a blank page.
- **No liveness endpoint.** An external monitor has to poll `/api/v1/sources/status`, which is a
  rate-limited domain endpoint rather than a probe.
