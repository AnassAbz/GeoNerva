# Security review — P2 (Domain model & database layer)

- **Reviewer:** independent Security Reviewer
- **Date:** 2026-09-19
- **Scope:** `git diff c1f5986..f5144f9` — merge `f5144f9`, branch commits `73af8b0`, `e43033d`, `d923bb0`, `4903962`. 76 files, +15,083/−13.
- **Mandatory surface (IMPLEMENTATION_PLAN §2.3):** migrations, database roles, RLS, `packages/db/src/spatial/**`.
- **Reference documents:** `DOMAIN_MODEL.md` §2, §4.5–§4.10, §6; `SECURITY.md` C2/C3/C4/H8/M1; `IMPLEMENTATION_PLAN.md` §2.3, §3a; ADR-002/003/008/018/021/030/031; `docs/reviews/security-p1.md`.
- **Environment:** PostgreSQL 17.0 (Debian) / PostGIS 3.4.3 on `127.0.0.1:54320`; Node 24.21.0; pg 8.23.0, pg-connection-string 2.14.0, Kysely 0.29.6.

> Note: commit `decf75b` (documentation) landed on `main` while this review was in progress. It is outside this scope and was not reviewed.

---

## 1. Verdict

**Gate G2 cannot be signed off from a security standpoint.**

Four HIGH findings are open, and two of them are the literal P2 exit criteria recorded in
IMPLEMENTATION_PLAN §3a, which states that "a phase gate cannot pass while its items are open":

| Exit criterion | Status |
|---|---|
| **F-6** — writing tests must refuse a non-local host and **use an isolated schema or database** | **PARTIALLY MET.** The host rule is enforced (and is stricter than documented). The isolation rule is not: any loopback-reachable database is accepted, including the development database and a port-forwarded production database. See S-3. |
| **F-7** — production DB URLs require TLS; the config refuses a non-TLS URL when `NODE_ENV=production` | **PARTIALLY MET.** The URL policy is correct and tested. The driver configuration it is supposed to enforce never reaches node-postgres: the parsed connection string overrides the explicit `ssl` object, dropping CA pinning and, with one extra query parameter, dropping certificate verification. See S-2. |

Independently of the exit criteria, `createPool` — the only connection factory in the project — cannot
open a connection at all (S-1), and daily partition creation is time-zone-dependent in a way that
breaks FIRMS ingestion outright on a non-UTC server (S-4).

The good news, and it is the part that matters most for this surface: **I found no SQL injection**,
the as-of layer is correct where it is used, the bitemporal constraints do what DOMAIN_MODEL §6.6
claims, and the C2 grant model is exactly what SECURITY.md describes for every table. Details and
evidence in §4.

---

## 2. Findings

| Sev | ID | Location | Summary |
|---|---|---|---|
| HIGH | S-1 | `packages/db/src/client.ts:81`, `packages/db/src/schema.ts:17` | `options: -c search_path=public, extensions` is whitespace-split by the server; every `createPool` connection fails with `FATAL: invalid value for parameter "search_path"`. No call site, no test. |
| HIGH | S-2 | `packages/db/src/client.ts:69`, `connection-url.ts:141-160`, `migrator/cli.ts:87` | **F-7.** node-postgres lets the parsed connection string override the explicit `ssl` config. CA pinning is silently dropped; `?sslmode=require&uselibpqcompat=true` passes the policy and yields `rejectUnauthorized: false`. The migrator sets no `ssl` at all. |
| HIGH | S-3 | `packages/db/src/testing/test-database.ts:67-84` | **F-6.** The guard reduces to "host must be loopback"; the `_test` branch is dead. A writing test (and `estimate-storage`) will migrate and `TRUNCATE` the development database, or a production database reached through an SSH/`kubectl` port-forward. |
| HIGH | S-4 | `migrations/0005_fire_activity.sql:72-74`, `repositories/fire.ts:58-66` | Partition bounds use `date::timestamptz` (session time zone) while names use the UTC date. On a non-UTC server, detections in the offset window cannot be inserted at all and retention drops the wrong day. |
| MEDIUM | S-5 | `migrations/0007_rls_and_roles.sql:24-42`, `0005_fire_activity.sql:60-81` | Partitions created at runtime have RLS **off**. Demonstrated: a granted non-owner role reads live detections by naming the partition, while the parent returns 0 rows. |
| MEDIUM | S-6 | `migrations/0005_fire_activity.sql:60-81` | `ensure_fire_detection_partition` is check-then-create with no exception handler. Two concurrent calls: one succeeds, one raises `42P07`, failing the whole detection batch. |
| MEDIUM | S-7 | `migrations/0005_fire_activity.sql:105-128`, `repositories/fire.ts:146-153` | Retention's `DROP TABLE <partition>` needs ACCESS EXCLUSIVE on the parent, sets no `lock_timeout`, and drops every eligible partition in one transaction. A long reader stalls the whole `fire_detections` table behind the lock queue. |
| MEDIUM | S-8 | `repositories/observation-versions.ts:207-282` → `:136` | `insertTombstone` copies the head's content forward, then refuses to write when the caller's hash equals the head's — which is the natural outcome. Demonstrated: the record stays `ACTIVE`, and the return value cannot distinguish this from "already tombstoned". |
| MEDIUM | S-9 | `spatial/queries.ts:81,110,145,176,202,283`; `.dependency-cruiser.cjs`; `replay-invariants.int.test.ts:171-197` | Exported fact readers that ignore `as_of` entirely. C4's two named controls — the depcruise rule and "I2 across all read paths" — do not exist as described; the property test's "every exported read path" claim is false. |
| MEDIUM | S-10 | `eslint.config.js` (absent) | C3's stated backstop — "lint rule bans `sql.raw` with non-literal input" — does not exist, in the phase that introduced all the SQL. |
| LOW | S-11 | `spatial/fragments.ts:125,133` | `sql.lit(decimals)` is the one value in the spatial layer that is not a bind parameter. Verified safe in Kysely 0.29.6, but it breaks the file's own rule 1 and compiles to `NaN` on a non-numeric input. |
| LOW | S-12 | `testing/test-database.ts:150` | `truncateAll` hand-quotes `geonerva."${table}"` without doubling `"`, while `ensureTestDatabase:120-125` correctly uses `quote_ident($1)`. |
| LOW | S-13 | `migrations/0007_rls_and_roles.sql:68-74` | The comment says the web role must never reach the AI outputs; the grant that follows includes `output`. Only `validation_errors` and the cost/token columns are actually withheld. |
| LOW | S-14 | `migrations/0007_rls_and_roles.sql` | `EXECUTE` on the three partition functions is still granted to `PUBLIC` (PostgreSQL's default); `REVOKE ALL ON SCHEMA … FROM PUBLIC` does not cover it. Not exploitable — they are `SECURITY INVOKER`. |
| LOW | S-15 | `client.ts:52-56, 136-144` | `preparedStatements: false` (required by ADR-008 behind the transaction pooler) is accepted and then never read by `createPool`. |
| LOW | S-16 | `repositories/ingestion-runs.ts:161` | `committed_at = clock_timestamp()` is statement time, not COMMIT time, contradicting the docstring and the batch-timestamp contract. |
| LOW | S-17 | `repositories/ingestion-runs.ts:80-121` | `acquireRunLease` keeps issuing statements after catching a unique violation; if handed a `Transaction`, everything after fails with `25P02`. |
| LOW | S-18 | `connection-url.ts:23`, `:79` | `0.0.0.0` is listed as loopback; `databaseNameOf` does not percent-decode, so `…/geonerva%2Ftest` is accepted and would create a database under a name pg does not connect to. |

No CRITICAL findings.

---

## 3. Findings in detail

### S-1 — HIGH — `createPool` cannot open a connection

**Location:** `packages/db/src/client.ts:81`, `packages/db/src/schema.ts:17`.

`SEARCH_PATH` is `'public, extensions'` — with a space — and is used both for `SET search_path TO …`
(valid SQL) and for the libpq `options` startup parameter (not valid there). PostgreSQL splits
`options` on whitespace, so the server receives `-c search_path=public,` plus a stray bare argument.

Measured against the local server:

```
client.ts form  (space)    => FAIL: invalid value for parameter "search_path": "public,"
harness form    (no space) => OK {"search_path":"public,extensions"}
```

`packages/db/src/testing/test-database.ts:184` happens to use the no-space form, which is why the
120 integration tests pass: they never go through `createPool`. A repository-wide search shows
`createPool`, `createDatabase`, `workerPoolOptions` and `webPoolOptions` have **no call sites at
all** outside their own definitions and the barrel export — the production connection path is
entirely untested.

**Failure scenario:** the first process wired to `workerPoolOptions`/`webPoolOptions` in P3/P8 fails
at start-up, before any query. Not silent, not data-destroying — which is why this is HIGH and not
CRITICAL — but it is the only connection factory in the project and G2 is meant to freeze this layer.

**Fix:** use a comma-only constant for the startup parameter (keep the readable form for `SET` if
desired, or drop the space everywhere), and add an integration test that opens a real connection
through `createPool` and asserts `SHOW search_path`.

---

### S-2 — HIGH — F-7: the TLS guarantee never reaches the driver

**Location:** `packages/db/src/client.ts:66-70`; `packages/db/src/connection-url.ts:141-160`;
`packages/db/src/migrator/cli.ts:87`; also `testing/create-test-database.ts:40`, `testing/test-database.ts:171,181`.

`connection-url.ts` promises two things: `sslmode` must be `require`/`verify-ca`/`verify-full` in
production for a non-loopback host, and "whatever `sslmode` says, GeoNerva always configures the
driver with `rejectUnauthorized: true`". The first holds. The second does not.

node-postgres merges the parsed connection string **over** the caller's config
(`pg/lib/connection-parameters.js:57-59`):

```js
if (config.connectionString) {
  config = Object.assign({}, config, parse(config.connectionString))
}
```

and `pg-connection-string` sets `config.ssl = {}` whenever the URL contains `sslmode`, `sslcert`,
`sslkey` or `sslrootcert` (index.js:77-79). So the object `sslConfigFor` builds is discarded.
Measured with pg 8.23.0, passing `ssl: { rejectUnauthorized: true, ca: 'PINNED-CA-PEM' }`:

| URL | resolved driver `ssl` |
|---|---|
| `?sslmode=require` | `{}` — CA pin dropped |
| `?sslmode=verify-full` | `{}` — CA pin dropped |
| `?sslmode=require&uselibpqcompat=true` | **`{"rejectUnauthorized":false}`** |
| `?sslmode=verify-full&uselibpqcompat=true` | `{}` |

Three consequences:

1. **`caCertificate` is dead code.** Any deployment that pins a CA believes it has done so and has not.
2. **Concrete bypass.** `DATABASE_URL_WORKER=postgresql://worker:pw@db.<ref>.supabase.co:5432/postgres?sslmode=require&uselibpqcompat=true`
   passes `assertConnectionUrlPolicy` (it only inspects `sslmode`, and `require` is in the allowed
   set) and runs with certificate verification off. An on-path attacker presents any certificate and
   captures the worker's database credentials and every write. This is the exact outcome F-7 was
   filed to prevent.
3. **Latent regression.** pg emits: *"In the next major version (pg-connection-string v3.0.0 and pg
   v9.0.0), these modes will adopt standard libpq semantics"* — i.e. `sslmode=require` will mean
   unverified. Because the explicit `ssl` object is overridden, GeoNerva's intended override will not
   save it; a routine dependency bump silently downgrades production TLS.

`migrator/cli.ts:87` builds its `pg.Client` with no `ssl` option at all, so the **highest-privilege**
connection in the system relies purely on driver defaults.

`connection-url.test.ts:85-104` asserts what `sslConfigFor` *returns*, not what the driver *uses*, so
the test suite is green while the guarantee is absent.

**Fix:**
- Require `sslmode=verify-full` in production (not "require or stronger"); `require` means
  "encrypt, do not authenticate" and is not worth accepting.
- Reject unknown/extra SSL-affecting query parameters: `uselibpqcompat`, `ssl`, `sslmode=no-verify`,
  `sslrootcert`, `sslnegotiation`.
- Stop letting the URL win: parse it and pass discrete `host/port/user/password/database` plus an
  explicit `ssl`, or strip the ssl parameters from the string before handing it to pg.
- Apply the same treatment in `migrator/cli.ts` and `testing/create-test-database.ts`.
- Test the **resolved** driver configuration (`new ConnectionParameters({connectionString, ssl})`),
  not `sslConfigFor`.

---

### S-3 — HIGH — F-6: the guard admits any loopback-reachable real database

**Location:** `packages/db/src/testing/test-database.ts:67-84`; writers at `:147-152` and
`packages/db/src/estimate-storage.ts:178`.

```ts
const isLocal = isLoopbackHost(host);
const looksLikeTestDatabase = database.endsWith('_test');
if (!isLocal && !looksLikeTestDatabase && !allowRemote) throw …;
if (!isLocal && !allowRemote) throw …;
```

The second clause subsumes the first, so the `_test` branch is unreachable and the effective rule is
"host must be loopback, or `GEONERVA_ALLOW_REMOTE_TEST_DB=1`". The database **name** is never checked
for a loopback host. Measured against `resolveTestDatabaseUrl`:

```
ACCEPTED  LOCAL DEV DB (not _test)      -> postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva
ACCEPTED  LOCAL postgres maintenance db -> postgresql://u:p@127.0.0.1:54320/postgres
ACCEPTED  SSH TUNNEL to prod            -> postgresql://u:p@127.0.0.1:5433/supabase_prod
ACCEPTED  localhost dev db              -> postgresql://u:p@localhost:5432/production
ACCEPTED  0.0.0.0 prod-name db          -> postgresql://u:p@0.0.0.0:5432/production
ACCEPTED  [::1] prod-name db            -> postgresql://u:p@[::1]:5432/production
ACCEPTED  host LOCALHOST uppercase      -> postgresql://u:p@LOCALHOST:5432/production
refused   127.0.0.2 (loopback/8)        -> not loopback per the allowlist
refused   IPv4-mapped [::ffff:127.0.0.1]-> normalised to [::ffff:7f00:1], not in the allowlist
refused   remote host, db ends _test    -> refused (stricter than documented)
refused   remote host, prod db          -> refused
ACCEPTED  remote + GEONERVA_ALLOW_REMOTE_TEST_DB=1
refused   unix socket (?host=/var/run/postgresql) -> "must contain a host"
refused   no db name
refused   userinfo trick 127.0.0.1:x@evil.example.com -> host read as evil.example.com
```

Every integration test calls `truncate()`, which issues
`TRUNCATE TABLE … RESTART IDENTITY CASCADE` over every non-seeded table in the schema
(`test-database.ts:147-152`), and `setupTestDatabase` runs `migrateUp` first.
`estimate-storage.ts:178` does the same and then loads ~700k rows.

**Exploit / failure scenario:** `ssh -L 5433:prod-db:5432` or `kubectl port-forward svc/postgres 5433:5432`
is routine operational practice. With that tunnel open, `DATABASE_URL_TEST=postgresql://…@127.0.0.1:5433/postgres`
plus `pnpm test:integration` migrates and truncates production. The same applies to
`…@127.0.0.1:54320/geonerva` — the development database the module's own rule 3 promises never to touch.

**Fix (one line, and it removes the dead branch):** make it a conjunction —

```ts
if (!allowRemote && !(isLocal && looksLikeTestDatabase)) throw new UnsafeTestDatabaseError(…);
```

Optionally also refuse a target that already contains rows in `geonerva.observation_versions`
without the override, which catches a `geonerva_test` that someone repurposed.

Answers to the specific probes requested: unix sockets are refused (no host); `DATABASE_URL_TEST`
unset falls back to the documented local default; `127.0.0.1` / `localhost` / `[::1]` / `0.0.0.0` /
`LOCALHOST` are all treated as loopback; `127.0.0.2` and `::ffff:127.0.0.1` are refused
(fail-safe); a remote host whose database ends in `_test` is refused; unusual ports are not
considered at all, which is the hole.

---

### S-4 — HIGH — partition bounds follow the session time zone, names follow UTC

**Location:** `packages/db/migrations/0005_fire_activity.sql:72-74`; `packages/db/src/repositories/fire.ts:58-66`;
`drop_fire_detection_partitions_before` at `0005:105-128`.

```sql
EXECUTE format(
  'CREATE TABLE geonerva.%I PARTITION OF geonerva.fire_detections FOR VALUES FROM (%L) TO (%L)',
  partition_name, day::timestamptz, (day + 1)::timestamptz);
```

`date::timestamptz` resolves midnight in the **session** `TimeZone`, while `partition_name` is
`to_char(day,'YYYYMMDD')` and the TypeScript caller derives `day` from
`acquiredAt.toISOString().slice(0,10)` — the **UTC** date. Nothing pins `TimeZone` on a connection
(`client.ts` sets only `search_path`).

Measured on the local server with `SET TimeZone='America/New_York'`:

```
fire_detections_20300101  FOR VALUES FROM ('2029-12-31 19:00:00-05') TO ('2030-01-01 19:00:00-05')
fire_detections_20300305  FOR VALUES FROM ('2030-03-05 00:00:00-05') TO ('2030-03-06 00:00:00-05')
INSERT acquired_at = '2030-03-05T00:30:00Z'
  -> ERROR: no partition of relation "fire_detections" found for row
```

The row's UTC day is `2030-03-05`, so `ensurePartitionsForDays` creates and checks exactly that
partition — and the row still does not fit it.

**Failure scenario:** on a host whose default `TimeZone` is not UTC, every detection acquired between
00:00Z and the UTC offset fails to insert, the whole `bulkInsertDetections` batch errors, and the run
is recorded FAILED. That is roughly a fifth of FIRMS volume per day at UTC−5. Retention compounds it:
`drop_fire_detection_partitions_before` compares a name-derived UTC date against locally-bounded
partitions, so it can drop a partition that still holds data inside the retention window. The local
container and Supabase both default to `Etc/UTC` today, which is why nothing fails now — the defect is
latent and configuration-dependent, but it is a hard failure when it fires.

**Fix:** build the bounds explicitly in UTC, e.g.
`format(…, (day::timestamp AT TIME ZONE 'UTC'), ((day + 1)::timestamp AT TIME ZONE 'UTC'))`;
set `TimeZone=UTC` alongside `search_path` on every connection and in the migrator; add a migration
test that runs under a non-UTC `SET TimeZone` and asserts the bounds.

---

### S-5 — MEDIUM — runtime-created partitions have RLS disabled

**Location:** `packages/db/migrations/0007_rls_and_roles.sql:24-42` versus `0005_fire_activity.sql:60-81`.

0007 enumerates the tables that exist at migration time and enables RLS on each. Partitions created
afterwards by `ensure_fire_detection_partition` do not inherit `relrowsecurity` — and RLS on a
partitioned parent applies only to queries that go through the parent.

Measured on a freshly migrated probe database with one detection in a pre-0007 partition and one in a
partition created at runtime, read by a `NOLOGIN` role holding only `USAGE` on the schema and
`SELECT ON ALL TABLES`:

```
parent  geonerva.fire_detections            -> 0 rows
old     geonerva.fire_detections_20260916   -> 0 rows   (relrowsecurity = true)
new     geonerva.fire_detections_20300101   -> 1 row    (relrowsecurity = false)  <-- data returned
```

and:

```
tables with RLS: 39 / 39   forced: 0 / 39      (at migration time)
fire_detections_20300101   relrowsecurity = false
```

So layer 2 of the migration's three-layer defence ("every table has RLS enabled and zero policies")
does not cover any fire data beyond the first eight days, which is all of it in steady state.
SECURITY.md C2's "RLS enabled with no policies" is therefore false as deployed.

**Why MEDIUM and not higher:** exploitation needs a second misconfiguration. `anon`/`authenticated`
have neither schema `USAGE` nor any grant, and `geonerva` is not exposed through the Data API, so a
leaked anon key still gets nothing. This defeats a defence-in-depth layer, not the perimeter.

**Fix:** add `EXECUTE format('ALTER TABLE geonerva.%I ENABLE ROW LEVEL SECURITY', partition_name)`
inside `ensure_fire_detection_partition`, and assert in a migration test that
`SELECT count(*) FROM pg_class … WHERE NOT relrowsecurity` is zero *after* creating a new partition.

---

### S-6 — MEDIUM — `ensure_fire_detection_partition` is not concurrency-safe

**Location:** `packages/db/migrations/0005_fire_activity.sql:60-81`; caller `repositories/fire.ts:58-66`,
invoked from `bulkInsertDetections` on every batch.

Check-then-create with no exception handler. Two autocommit sessions calling it for the same day:

```
concurrent ensure (autocommit): [ 'ok', 'ERR 42P07 relation "fire_detections_20310707" already exists' ]
```

The function's own comment says "Idempotently creates the daily partition for `day`. Safe to call
from every ingestion run." Two FIRMS products (NOAA-20 and NOAA-21) crossing a day boundary together,
or a retry overlapping a run, fails the whole batch with an unhandled error.

**Fix:** wrap the `EXECUTE` in `BEGIN … EXCEPTION WHEN duplicate_table THEN NULL; END;`.

---

### S-7 — MEDIUM — retention's `DROP PARTITION` can stall the whole detections table

**Location:** `migrations/0005_fire_activity.sql:105-128`; `repositories/fire.ts:146-153`.

`DROP TABLE <partition>` needs ACCESS EXCLUSIVE on the partitioned parent. Measured: a second session
with an open transaction that merely ran `SELECT count(*) FROM geonerva.fire_detections` holds
`AccessShareLock` on `geonerva.fire_detections`, and the DROP blocks:

```
DROP blocked -> canceling statement due to lock timeout      (my probe set lock_timeout = 1500ms)
reader locks: [{"t":"geonerva.fire_detections","mode":"AccessShareLock"}, …]
```

Neither the function nor the repository sets `lock_timeout`, and PostgreSQL's lock queue is FIFO, so
while the DROP waits every *new* query on `fire_detections` queues behind it. The worker's
`statement_timeout` is 120 s, so one retention run started during a long read can make the fire table
unavailable for up to two minutes; web queries (10 s `statement_timeout`) fail. The function drops
every eligible partition inside one call, holding the parent locked for the whole loop.

**On the "does retention drop data inside the window?" question:** on a UTC server, no.
`dropDetectionPartitionsBefore` truncates the cutoff to a UTC date and the function drops only
partitions whose day is strictly earlier, so it keeps at least the requested window (it errs towards
keeping). On a non-UTC server, see S-4.

**Fix:** `SET LOCAL lock_timeout = '2s'` before each DROP with a retry, one partition per
transaction, and consider `DETACH PARTITION CONCURRENTLY` followed by `DROP`.

---

### S-8 — MEDIUM — `insertTombstone` silently does nothing for the obvious caller

**Location:** `packages/db/src/repositories/observation-versions.ts:207-282`, delegating to
`insertVersionIfChanged` at `:136`.

`insertTombstone` reads the head, copies **every** field forward unchanged, and delegates to
`insertVersionIfChanged`, which returns `{ inserted: false }` when the supplied `contentSha256`
equals the head's. But the caller supplies that hash, and the content being hashed is by construction
identical to the head's. Measured end-to-end against the real repository:

```
seeded record 1 as ACTIVE   (head hash = sha256('content-A'))
insertTombstone(hash == head hash) -> {"inserted":false,"versionId":"1","versionSeq":1}
observationsAsOf: [ 'tomb-1/ACTIVE' ]
observationsNow : [ 'tomb-1/ACTIVE' ]
insertTombstone(distinct hash)     -> {"inserted":true,"versionId":"2","versionSeq":2}
observationsAsOf after real tombstone: 0 rows
```

The return value cannot distinguish "already tombstoned" from "refused to tombstone", so the caller
cannot detect the failure either. The existing tests (`repositories.int.test.ts:374-398`, for both
`DELETED` and `MISSING_FROM_SOURCE`) always pass an unrelated hash, so nothing catches it.

**Failure scenario, once P3 uses this API:** a USGS event the provider explicitly withdrew, or an
EMSC `unid` absent from two consecutive reconciles (ADR-030), stays visible and is presented as
current, permanently. That is the "fake certainty" half of asset #1 and threat M4.

**Fix:** compute the hash inside `insertTombstone` from the head hash plus the status, so it always
differs; or raise `VersionRejectedError` when a tombstone's hash equals the head's. Add a test that
passes the head hash.

---

### S-9 — MEDIUM — C4's two named controls do not exist, and exported readers ignore `as_of`

**Locations:**
- `packages/db/src/spatial/queries.ts:81` `nearestObservationVersions`, `:110` `geometriesCoveringPoint`,
  `:145` `distanceToGeometries`, `:176` `observationsInViewport`, `:202` `fireDetectionsInViewport`,
  `:283` `nearestDetections` — all re-exported from `spatial/index.ts` and `src/index.ts`.
- `repositories/ingestion-runs.ts:216-224` `listRecentRuns` (`asOf` optional).
- `repositories/observation-versions.ts:300` `listVersions` (`asOf` optional).
- `.dependency-cruiser.cjs:102-104`.
- `replay-invariants.int.test.ts:171-197`.

None of the spatial functions filters `ingested_at <= T`. `observationsInViewport` additionally
returns **every version** of a record rather than the latest one per record, so a revised earthquake
would be drawn once per revision on the map.

SECURITY.md C4 lists two controls for exactly this:

1. *"The as-of module is the only fact reader (**depcruise rule**)"* — no such rule exists. The only
   related rule says "Only `packages/db` (and operational scripts) may talk to Postgres directly".
   `pnpm depcruise` reports 0 violations across 102 modules, and nothing prevents `apps/web` from
   importing `observationsInViewport` in P8/P9.
2. *"property invariant I2 across **all** read paths"* — `replay-invariants.int.test.ts` states it
   "hammers **every** exported read path". I listed the exported read functions and checked each:
   `readEverything` exercises `observationsAsOf` (4 option shapes), `linksAsOf`, `clusterVersionsAsOf`,
   `healthAsOf` and `sourceCutoffsAsOf` — and nothing else. It does **not** touch `observationsNow`,
   `clusterVersionsNow`, any of the six spatial readers, `listRecentRuns` or `listVersions`.
   **The docstring's claim is false as written.**

To be fair to the implementation: the two `*Now` fast paths *are* properly covered — just elsewhere.
`asof.int.test.ts:251-303` asserts `observationsNow` equals `observationsAsOf(now)` including radius,
ordering, distances and tombstones, and `:404-407` does the same for `clusterVersionsNow`. That is
the equivalence ARCHITECTURE §5 depends on and it is real. The genuine gap is `spatial/queries.ts`
plus the two optional-`asOf` repository readers.

**Why MEDIUM:** nothing consumes these yet, so no replay is currently wrong. It becomes a C4 breach
the moment a P8/P9 map or radius endpoint picks the convenient function.

**Fix, before P8:** give the spatial fact readers a mandatory `asOf` (and a latest-version-per-record
projection for the viewport query), or move them behind `asof.ts` and export only the fragments; add
the depcruise rule C4 claims; extend `readEverything` to every exported read path, and correct its
docstring to describe what it actually covers.

---

### S-10 — MEDIUM — the C3 lint backstop does not exist

**Location:** `eslint.config.js` — no rule; `docs/SECURITY.md` C3 asserts one.

C3's control list ends with "(lint rule bans `sql.raw` with non-literal input)". There is no
`no-restricted-syntax` entry or other rule matching `sql.raw`, `sql.lit`, `sql.id`, or string
concatenation into a `sql` template. P2 is the phase that introduced every line of SQL in the
project, and `pnpm lint --max-warnings=0` passes clean without the rule existing.

No live defect — I found no `sql.raw` anywhere and every value in the diff is bound (§4.1). This is a
missing tripwire, not a vulnerability.

**Fix:** add the rule (ban `sql.raw`; ban `sql.lit`/`sql.id` with a non-`Literal` argument), or amend
SECURITY.md C3 to describe the controls that actually exist (isolation in `packages/db`, Kysely
parameterization, Zod-validated inputs).

---

### LOW findings

**S-11** — `spatial/fragments.ts:125,133`. `asGeoJson`/`expressionAsGeoJson` are exported public API
and pass `decimals` through `sql.lit`, which places it in the SQL text rather than in `parameters`.
I verified Kysely 0.29.6 escapes it correctly, so this is **not** an injection primitive
(see §4.1 for the compiled output), but it violates the file's own rule 1 ("Every value is a bind
parameter") and a non-numeric value compiles to a literal `NaN`, i.e. a hard query error.
Use `${decimals}`.

**S-12** — `testing/test-database.ts:150` builds `geonerva."${table}"` by hand without doubling
embedded `"`. Names come from `pg_class`, and `REVOKE ALL ON SCHEMA geonerva FROM PUBLIC` prevents a
non-owner creating a table there, so it is not reachable — but it is the only hand-quoted identifier
in the package, and `ensureTestDatabase:120-125` already shows the right pattern (`quote_ident($1)`).

**S-13** — `0007_rls_and_roles.sql:68-74`. The comment reads "The web role must never be able to
reach … the AI outputs, which may contain rejected model text", and the grant immediately below
includes `output`. Verified column privileges for `geonerva_web` on `agent_outputs`:
`created_at, id, model, output, prompt_version, role, snapshot_id, used, validation_status`. Only
`input_sha256`, `validation_errors`, `tokens_in`, `tokens_out`, `cost_micros` are withheld. If the web
legitimately needs `output` (it does, to render a briefing), say that and note that `used` /
`validation_status` are the real gate; otherwise remove `output` from the grant.

**S-14** — PostgreSQL grants function `EXECUTE` to `PUBLIC` by default and
`REVOKE ALL ON SCHEMA geonerva FROM PUBLIC` does not cover it. Verified `proacl` for all three
functions: `{=X/geonerva, geonerva=X/geonerva, geonerva_worker=X/geonerva}` — the leading `=X` is
`PUBLIC`. Not exploitable: `prosecdef = false` for all three, so a non-owner calling
`drop_fire_detection_partitions_before` gets `permission denied` on the DDL. Add
`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA geonerva FROM PUBLIC` and the matching
`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM PUBLIC`.

**S-15** — `client.ts:52-56` declares `preparedStatements` and `webPoolOptions:136-144` sets it to
`false` for the Supabase transaction pooler (ADR-008: "Web connects via the transaction pooler with
`prepare=false`"), but `createPool` never reads it and Kysely's `PostgresDialect` keeps issuing named
statements. A latent P8 failure behind port 6543.

**S-16** — `repositories/ingestion-runs.ts:161` sets `committed_at = clock_timestamp()` inside the
`UPDATE`; the docstring says "the real wall clock at COMMIT". A reader whose `asOf` falls between the
UPDATE and the actual COMMIT is told the cutoff includes a batch it cannot yet see. Small, but this is
the timestamp the entire replay model hangs on.

**S-17** — `repositories/ingestion-runs.ts:80-121`. After catching the `23505` from
`insertRunningRun`, the function issues three more statements. Every other repository in this package
takes a `Transaction<DB>`; this one's signature accepts `Kysely<DB>`, so a caller passing a
transaction gets `25P02 current transaction is aborted` on everything after the catch. Document the
constraint or use a savepoint.

**S-18** — `connection-url.ts:23` lists `0.0.0.0` as loopback (it is not, although it usually resolves
locally); `databaseNameOf` at `:79` does not percent-decode, so `…/geonerva%2Ftest` is accepted and
`ensureTestDatabase` would `CREATE DATABASE` under a name pg does not then connect to.

---

## 4. Verified correct

### 4.1 C3 — no SQL injection anywhere in the diff

I read every raw `sql` site in `spatial/fragments.ts`, `spatial/queries.ts`, `spatial/viewport.ts`,
`asof.ts`, all six files under `repositories/`, `migrator/migrations.ts`, `migrator/runner.ts`,
`migrator/cli.ts`, `estimate-storage.ts`, `testing/test-database.ts` and `testing/create-test-database.ts`.

Every value reaches SQL as a bound parameter — `${…}` inside a Kysely `sql` template, or `sql.val()`
for arrays. The only non-parameter interpolations in the whole diff are:

| Site | What is interpolated | Assessment |
|---|---|---|
| `sql.ref(column)` (7 sites in `fragments.ts`) | literal strings at every call site (`'v.centroid'`, `'g.geog'`, `'d.geog'`) | safe; Kysely quotes and doubles `"` |
| `sql.lit(SRID_WGS84)` / `sql.lit(decimals)` | a module constant / a `number` | safe today; see S-11 |
| `SET search_path TO ${SEARCH_PATH}` and `-c search_path=${SEARCH_PATH}` | a module constant | safe (but see S-1) |
| `client.query(migration.sql)` | repository `.sql` files, checksummed | safe |
| `geonerva."${table}"` in `truncateAll` | `pg_class.relname` | see S-12 |
| `CREATE DATABASE ${identifier}` | the server's own `quote_ident($1)` output | safe, and the correct pattern |
| `format('… geonerva.%I …', partition_name)` in plpgsql | `to_char(day,'YYYYMMDD')` computed in-database | safe |

I compiled adversarial fragments against a Kysely dummy dialect to confirm the escaping rather than
assume it:

```
sql.ref('centroid"; DROP TABLE geonerva.sources; --')
  -> SELECT "centroid""; DROP TABLE geonerva"."sources; --"        (quotes doubled, no escape)
sql.lit("a' || (SELECT version()) || '")
  -> SELECT 'a'' || (SELECT version()) || '''                       (quotes doubled, no escape)
asGeoJson('v.centroid', "6), (SELECT current_setting('is_superuser')")
  -> ST_AsGeoJSON("v"."centroid"::geometry, '6), (SELECT current_setting(''is_superuser'')')
geographyPoint({lat,lon}) -> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography   PARAMS [-8, 31.6]
withinRadius('v.centroid', …, 5000) -> ST_DWithin("v"."centroid", …, $3)         PARAMS [2, 1, 5000]
```

Specifically on the vectors named in the review brief:
- **Identifiers:** never built from caller data.
- **`ORDER BY`:** `asof.ts` selects between two hard-coded fragments (`ordering`), never a string.
- **`LIMIT`:** always `${options.limit ?? N}` — a bind parameter.
- **Partition names:** derived inside the database from a `date` and passed through `%I`.
- **Array filters:** `= ANY(${sql.val(list)}::text[]|::uuid[]|::bigint[])` — a single bound array,
  the correct shape.
- **`sql.join(envelopeTests, sql\` OR \`)`:** the separator is a literal template; the joined
  fragments are themselves fully parameterized.
- `grep` for `sql.raw` across `packages/`, `apps/`, `scripts/`: **no occurrences**.

I could not construct an input that escapes.

### 4.2 C2 — the grant and privilege model matches SECURITY.md, table by table

Measured on a freshly migrated database:

- `geonerva_web` write privileges across the **entire** schema — the complete result set:

  | table | privilege |
  |---|---|
  | `geocode_cache` | INSERT |
  | `geocode_cache` | UPDATE |
  | `rate_limit_buckets` | INSERT |
  | `rate_limit_buckets` | UPDATE |

  Nothing else. The web role cannot write a single fact, exactly as C2 claims.
- `geonerva_web` has **no** table-level `SELECT` on `raw_source_records` or `agent_outputs` (empty
  result set from `role_table_grants`), only the nine-column grant on `agent_outputs` (see S-13).
- `geonerva_worker` has SELECT/INSERT/UPDATE/DELETE on all tables plus sequences and functions.
- `PUBLIC` has nothing on the schema; both roles are `NOLOGIN` group roles as documented.
- **Future tables and partitions:** `ALTER DEFAULT PRIVILEGES` works. A partition created at runtime
  by the migration owner came out as
  `{geonerva=arwdDxtm/geonerva, geonerva_worker=arwd/geonerva, geonerva_web=r/geonerva}` —
  the web role inherits read, and does not inherit write. (Privileges on a partitioned table are
  checked on the parent, so even a partition created by a different role would not break reads.)
- **`FORCE` vs `ENABLE`:** `relforcerowsecurity = 0` for all 39 tables, and the reasoning in the
  migration is correct — `FORCE` would lock out the owning role the application runs as, breaking the
  application the control is meant to protect. Deny-all works as designed for non-owners: a role with
  `USAGE` + `SELECT` gets **0 rows and no error** from every RLS-enabled table.
- **`SECURITY DEFINER`:** none. `prosecdef = false` for all three functions in the schema.

The only deviation from C2's description is S-5 (runtime-created partitions).

### 4.3 C4 — the as-of layer itself is correct

`asof.ts` handles the three hard cases properly, and I read each query:

- `observationsAsOf` re-applies the spatial predicate to the **latest** version rather than using it
  only as a pre-filter, so an epicentre revised into or out of a radius appears/disappears correctly
  at replay time (`asof.ts:107-143` and `:210`).
- Merges are treated as knowledge: `merged_at IS NULL OR merged_at > ${asOf}`, not `merged_at IS NULL`.
- `DISTINCT ON (source_record_id) … ORDER BY source_record_id, ingested_at DESC, version_seq DESC`
  makes same-batch ties deterministic, which is what a backfill needs.
- `linksAsOf` implements `linked_at <= T < coalesce(unlinked_at, ∞)` and also respects
  `e.merged_at > T`.
- `clusterVersionsAsOf` filters derived rows on `as_of`, not `ingested_at` — correct per DOMAIN_MODEL §2.
- `healthAsOf` and `sourceCutoffsAsOf` filter on `committed_at <= asOf`, and the lookback window is
  derived from `asOf` so it stays consistent under replay.
- The `*Now` fast paths are proven equal to the as-of path at now (`asof.int.test.ts:251-303`,
  `:404-407`), and `rebuildHeads` can reconstruct the cache from versions.

The gap is only in the paths that bypass this module — S-9.

### 4.4 Data-integrity constraints (DOMAIN_MODEL §6.6)

Each of these was exercised by inserting violating rows against a live database:

| Invariant | Probe | Result |
|---|---|---|
| I13 `observed_at <= ingested_at + 5 min` | `+4m59s` / `+5m01s` | accepted / **refused** (`CHECK`) |
| I13, application layer | `insertVersionIfChanged` | raises `VersionRejectedError('FUTURE_OBSERVATION')` before touching SQL; property-tested for 6…10,000 minutes ahead |
| lifecycle enum incl. `MISSING_FROM_SOURCE` | `MISSING_FROM_SOURCE` / `BOGUS_STATUS` | accepted / **refused** |
| I6 one active canonical link | second row with `unlinked_at IS NULL` for the same record | **refused** (partial unique index, matches §6.3 exactly); a closed link is accepted |
| Run lease | second `RUNNING` row for the same source with `product_id IS NULL` | **refused** — the `COALESCE(product_id,-1)` does its job |
| ADR-015 privacy | `p:2542997`, `n:N12345` accepted; `c:31.00,-8.00`, `p:0`, `n:X12345`, `p:2542997 ` (trailing space), `P:2542997` all **refused** | raw coordinates cannot be persisted |
| A→B→A content | re-inserting the head's hash as a later version | allowed, as documented and intended |

Idempotency mechanisms are all present as §6.6 specifies:
`raw_source_records UNIQUE(source_id, payload_sha256)`;
`observation_versions UNIQUE(source_record_id, version_seq)` with the head compared under
`SELECT … FOR UPDATE`; `fire_detections UNIQUE(product_id, acquired_at, lat_e4, lon_e4)` with
`ON CONFLICT DO NOTHING`; `fire_cluster_versions UNIQUE(cluster_id, content_sha256)`;
`location_snapshots UNIQUE(location_key, as_of, engine_version)`; the alias table for USGS preferred-id
changes.

**`MISSING_FROM_SOURCE` is consistent across all four layers** — DOMAIN_MODEL.md:69,
`enums.ts:119-145` (`LIFECYCLE_STATUSES`, `TOMBSTONE_LIFECYCLE_STATUSES`, `isTombstone`), the
`lifecycle_status` CHECK in migration 0003, and `TOMBSTONE_STATUSES` in `asof.ts:92`.
`excludeTombstones` defaults to `true` and excludes both tombstone statuses. ADR-030 is honoured.

### 4.5 H8 — availability mechanisms that are correct

- **Run lease.** Enforced by the database, not by a flag. A stale lease is expired to
  `FAILED / LEASE_EXPIRED` by the next run rather than blocking the product forever, the expiring
  `UPDATE` is itself the concurrency control (only one transaction can win it), and the "holder
  finished in between" race is handled. Tested at `repositories.int.test.ts:58-130`. No lock leak.
- **Migrator advisory lock.** Session-level `pg_advisory_lock(4705312026000001)`, taken before any
  read, released in `finally`, and released automatically if the connection drops. One transaction
  per migration with the bookkeeping row inside it, so "applied" and "actually there" cannot
  disagree. Checksums are LF-normalized SHA-256; a changed applied file is an error naming the file;
  a version in the database with no file in the checkout is reported as `missing-file`. No `down` path.
- **Retention window.** On a UTC server, `dropDetectionPartitionsBefore` errs towards keeping data:
  it truncates the cutoff to a UTC date and drops only partitions whose day is strictly earlier.

The open H8 items are S-4, S-6 and S-7.

### 4.6 `estimate-storage.ts` (review item 8)

It cannot invent a target: `main()` writes only through `setupTestDatabase()`, so it inherits the F-6
guard, and all of its SQL is parameterized (`generate_series(1, ${perDay})`, `${dayStart}`,
`${sourceId}` are bind parameters). It therefore **can** be pointed at a real database exactly to the
extent S-3 allows, and no further. Two notes: its header says it loads into "a throwaway database"
when in fact it truncates and reuses the configured test database (`:178`), and it inserts ~700k rows,
so running it against the wrong target is both destructive and slow.

### 4.7 Other things checked and found sound

- Antimeridian handling (`viewport.ts`): a crossing box splits into `[west,180]` and `[-180,east]`,
  degenerate boxes are refused rather than silently returning nothing, latitudes are clamped, and
  quantization is grow-only with explicit float guards. Covered by `viewport.test.ts` and
  `spatial.int.test.ts:344-367`.
- Public IDs use `crypto.randomInt` over a reduced alphabet with collision retry — not enumerable.
- Error messages never echo a connection string: `DatabaseUrlError` names the variable only, and
  `describeConnectionTarget` emits `host:port/database` without user, password or query string. P1's
  F-2 fix holds here.
- `ingestion_runs.error_message` is bounded to 1 KB by a CHECK; `observation_versions.attributes` to
  16 KB, with an application-side check as well.
- PostGIS 3.3 discipline (ADR-031) is enforced by `postgis-requirements.ts` plus an integration test,
  not only by review.

### 4.8 Project checks (all green)

```
pnpm typecheck      20 packages, clean
pnpm lint           eslint --max-warnings=0, clean
pnpm depcruise      no dependency violations found (102 modules, 286 dependencies cruised)
pnpm test:unit      18 files, 296 tests passed
pnpm test:integration  6 files, 120 tests passed
                    PostgreSQL 17.0 (Debian 17.0-1.pgdg110+1) / PostGIS 3.4.3
```

All probing was done against a scratch database (`geonerva_probe_test`), which has been dropped. The
development database was not touched and `git status` is clean apart from this report.

---

## 5. Defect now vs. later phase

**Defects in P2 code, to fix before G2 is signed:**
S-1, S-2 (F-7), S-3 (F-6), S-4, S-5, S-6, S-7, S-8, S-11, S-12, S-13, S-14, S-16, S-17, S-18.

**Must be addressed in a named later phase:**

| Item | Phase | Requirement |
|---|---|---|
| S-9 | **P2 (test + depcruise rule) / before P8** | Add the depcruise rule C4 claims; extend `readEverything` to every exported read path and fix its docstring; give the spatial fact readers a mandatory `asOf` before any of them reaches a request path. |
| S-10 | **P2 or next docs pass** | Implement the `sql.raw` lint rule, or correct SECURITY.md C3. |
| S-15 | **P8** | Honour `preparedStatements: false` behind the Supabase transaction pooler (ADR-008). |
| RLS misconfiguration detection | **P3 / P8** | Under deny-all, a non-owner role without `BYPASSRLS` gets **0 rows and no error** from every table — measured: `sources → 0`, `observation_versions → 0`, `fire_detections → 0`. `deriveSourceHealth` with zero runs correctly returns `UNAVAILABLE / NEVER_SUCCEEDED`, but `healthAsOf` would return an *empty* list because `sources` itself reads empty, so C1's short-circuit has nothing to act on. Add a start-up self-check that asserts at least one seeded source is readable, and make the read path treat an empty `sources` result as a failure rather than as "nothing configured". The migration's deployment note warns about this configuration; nothing detects it. |
| `TimeZone=UTC` per connection | **P3** | See S-4. |
| F-7 live verification | **P10** | Assert the resolved driver `ssl` object against the live Supabase connection, not just the URL. |

---

## 6. Gate G2

**Not signable from a security standpoint.** Blocking items:

1. **S-3 (F-6)** — an explicit P2 exit criterion; its isolation half is unmet.
2. **S-2 (F-7)** — an explicit P2 exit criterion; the URL policy is met, the driver guarantee is not.
3. **S-1** — the project's only connection factory cannot connect, and nothing tests it.
4. **S-4** — latent, but it is a hard ingestion failure and the schema is what G2 freezes.

S-5 through S-8 are MEDIUM and, with the exception of S-5, are all inside migration 0005/0007 or the
repository layer that G2 freezes; they are cheap to fix now and expensive to fix after the freeze.
S-9 and S-10 do not have to block G2 provided they are recorded in IMPLEMENTATION_PLAN §3a against
P8 and P2 respectively, with the depcruise rule landing before any web code exists.

Re-review needed after the fixes, focused on: the resolved driver `ssl` configuration, the F-6
conjunction, a `createPool` integration test, partition bounds under a non-UTC `TimeZone`, RLS on a
runtime-created partition, and a tombstone test that passes the head hash.
