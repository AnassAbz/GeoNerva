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

---

# Re-review (fix verification)

- **Date:** 2026-09-19
- **Scope:** `git diff f5144f9..HEAD` — commits `29eca2d`, `6373405`, `97bfce9`, `a6798c9`,
  `c2b55a2`, `36892f6`, `6e1fb11` (plus `decf75b`, docs, and `d65387b`, this report). 15 files,
  +1,402/−72.
- **Method:** read every changed file, then tried to break each fix on a live database
  (PostgreSQL 17.0 / PostGIS 3.4.3), including the specific attacks the orchestrator asked for:
  TLS parameters in unusual case and duplicated, a URL whose semantics stripping might change,
  guard bypasses, partition bounds at a DST boundary and with `TimeZone` set **per database**
  rather than per session, RLS on a partition created by the losing side of a race, a tombstone
  whose caller supplies a colliding hash, lock-timeout behaviour under a real long reader, and
  whether the lease rewrite introduced a new race.

## R.1 Verdict

**G2 can be signed off once R-1 is fixed.** Both §3a exit criteria are now met as written:

| Exit criterion | Status |
|---|---|
| **F-6** | **MET.** The guard is now `loopback AND *_test`, with an explicit override. Verified against 19 adversarial URLs. |
| **F-7** | **MET.** `assertConnectionUrlPolicy` refuses a non-TLS URL in production, and — beyond what the criterion asks — the driver now actually receives GeoNerva's `ssl` object, pinned CA included. |

Eleven of the thirteen findings I raised are closed and verified. One HIGH remains, and it is a
**partial** fix rather than a new defect: the corrected partition function is right, but migration
0009 leaves behind the partitions migration 0005 already created, and on a non-UTC server the
resulting boundary seam makes the *corrected* function fail permanently (R-1). Four MEDIUMs are
residuals worth fixing before the freeze; none of them blocks on its own.

## R.2 Findings

| Sev | ID | Location | Summary |
|---|---|---|---|
| HIGH | R-1 | `migrations/0009_partition_hardening.sql:124-140` | 0009 enables RLS on pre-existing partitions but does not re-bound them. On a non-UTC server the 0005 window keeps local bounds, so the fixed function raises an uncaught `42P17 … would overlap …` at the seam and ingestion stops permanently; rows already written land in the wrong day and retention drops them early. |
| MEDIUM | R-2 | `repositories/observation-versions.ts:268-274` | The tombstone hash is derived from the **head's** hash, and after the first tombstone the head *is* the tombstone — so every subsequent reconcile writes another version. Measured: 3 reconciles produced 3 tombstone versions. The docstring claims idempotency; `v.lifecycle_status` is selected and never used, which looks like the intended early return went missing. |
| MEDIUM | R-3 | `repositories/fire.ts:158-188` | `dropDetectionPartitionsBefore` accepts a `Transaction<DB>`; a deferred partition raises 55P03, which aborts that transaction, and the next iteration throws an uncaught `25P02`. This is the same defect the same commit removed from `acquireRunLease` (S-17). |
| MEDIUM | R-4 | `migrator/cli.ts:87` | **Answer to the explicit question: no, the migrator does not inherit the fix.** It still passes the raw URL and no `ssl`. The live bypass is closed (the policy now refuses `uselibpqcompat`/`ssl`), but the highest-privilege connection still lets the URL configure TLS, cannot pin a CA, and will silently stop verifying when pg v9 changes `sslmode=require` semantics. |
| MEDIUM | R-5 | `connection-url.ts:177-184` | `sslnegotiation` is not on the strip list. `?sslmode=verify-full&sslnegotiation=direct` resolves to `ssl = true`, replacing the explicit object and **silently dropping the pinned CA**. Still verified against the system trust store, so not a MITM hole — but it is the exact defect class the fix was written to close. |
| LOW | R-6 | `client.ts:98-112`, `IMPLEMENTATION_PLAN.md` §3a (S-15b) | Kysely 0.29.6 has no `preparedStatements` option — `KyselyConfig` is `{dialect, plugins?, log?}` — so the new argument is silently ignored. It is also unnecessary: Kysely's `PostgresDriver` calls `client.query(sql, params)` with no statement name, so pg never issues a *named* prepared statement. My original S-15 was right that the option was dead and wrong about the risk; the §3a entry now asserts something that is not true. |
| LOW | R-7 | `migrations/0009:66-92`, `repositories/fire.ts:170-186` | Retention's worst case is `N × lockTimeoutMs`, each attempt re-entering the parent's lock queue. Measured: 10 blocked partitions at 1 s each took 10.1 s; at the 5 s default that is 50 s of repeated ACCESS EXCLUSIVE requests. |
| LOW | R-8 | `connection-url.ts:113-126, 177-184` | TLS parameter handling is case-sensitive throughout, and duplicated `sslmode` reads only the first value. Every variant I tried fails safe, but the failure modes are accidental rather than designed. |
| LOW | R-9 | `connection-url.ts:79` | `databaseNameOf` still does not percent-decode (the commit message says it does). `…/prod%2F_test` is accepted; `…/scratch%5Ftest` is refused. Both fail safe. The `_test` suffix match is also case-sensitive, so `…/X_TEST` is refused. |
| LOW | R-10 | `migrations/0009:142-152` | The four functions are fixed, but there is no `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM PUBLIC`, so the next function added to the schema is `PUBLIC`-executable again. |
| LOW | R-11 | `eslint.config.js:75-90` | The `sql.raw` rule catches direct calls and aliasing, but not computed access. `(sql as never)['raw']('…')` produces **no** lint error. Destructuring is caught only incidentally, by `@typescript-eslint/unbound-method`. This is P1's F-1 lesson (bracket access) recurring. |
| LOW | S-11 | `spatial/fragments.ts:125,133` | Still open, unchanged and not claimed as fixed: `sql.lit(decimals)` remains the one value in the spatial layer that is not a bind parameter. |

## R.3 Findings in detail

### R-1 — HIGH — 0009 corrects the function but not the partitions 0005 already created

**Location:** `packages/db/migrations/0009_partition_hardening.sql:124-140` (the backfill loop enables
RLS only); the partitions in question come from `0005_fire_activity.sql:131`
(`SELECT geonerva.ensure_fire_detection_partitions((CURRENT_DATE - 3)::date, 8)`), which runs with
0005's *pre-fix* function definition.

**Setup:** a fresh database with `ALTER DATABASE … SET TimeZone = 'America/New_York'` — the
per-database form the orchestrator asked about, never a `SET TimeZone` — then migrations 0001…0009
applied in order by the normal path. The migrator issues no `SET TimeZone`, so it inherits it:

```text
session TimeZone inherited: America/New_York
migrated 9 files
```

**The UTC anchoring itself is correct**, including across a DST transition:

```text
fire_detections_20300310  FOR VALUES FROM ('2030-03-09 19:00:00-05') TO ('2030-03-10 20:00:00-04')
fire_detections_20300615  FOR VALUES FROM ('2030-06-14 20:00:00-04') TO ('2030-06-15 20:00:00-04')
```

Both are exactly 24 h in UTC (00:00Z to 00:00Z) even though the first spans the spring-forward
boundary. An insert at `2030-06-15T00:30:00Z` lands correctly. That part of S-4 is fixed.

**But the eight partitions 0005 created keep local bounds, and 0009 never touches them:**

```text
fire_detections_20260916  FOR VALUES FROM ('2026-09-16 00:00:00-04') TO ('2026-09-17 00:00:00-04')
…
fire_detections_20260923  FOR VALUES FROM ('2026-09-23 00:00:00-04') TO ('2026-09-24 00:00:00-04')
```

Three consequences, all measured:

1. **Ingestion stops permanently at the seam.** The last 0005 partition ends at
   `2026-09-24 04:00Z`, while the fixed function wants `2026-09-24 00:00Z … 2026-09-25 00:00Z`:

   ```text
   ensure_fire_detection_partition('2026-09-24')     -> 42P17 partition "fire_detections_20260924"
                                                        would overlap partition "fire_detections_20260923"
   ensure_fire_detection_partition('2026-09-25')     -> ok
   ensure_fire_detection_partitions('2026-09-22', 5) -> 42P17 (dies on that day, never reaches the rest)
   ```

   `42P17` is `invalid_object_definition`, and the new `EXCEPTION WHEN duplicate_table` handler does
   not catch it. `bulkInsertDetections` calls `ensurePartitionsForDays` before every batch, so from
   the fourth day after deployment onwards **every FIRMS batch fails**, and the nightly
   partition-maintenance job fails with it. There is no self-healing path: the error recurs on every
   run until someone issues DDL by hand.

2. **Rows land in the wrong day.** A detection at `2026-09-19T00:30:00Z` inserted *successfully*
   into `fire_detections_20260918` (00:30Z = 20:30 EDT on the 18th):

   ```text
   partition                            acquired_at
   geonerva.fire_detections_20260918    2026-09-19T00:30:00.000Z
   ```

   Silent mis-filing is worse than the original failure, which at least raised.

3. **Retention deletes inside the window.** `fire_detection_partitions_before('2026-09-19')` returns
   the 16th, 17th and 18th, so dropping `fire_detections_20260918` destroys that
   `2026-09-19T00:30Z` detection a full day early. This is the H8 "drops data inside the retention
   window" case, now reachable.

**Why HIGH, not CRITICAL:** it needs a non-UTC server, and both supported deployments (Supabase and
the project's pinned Docker image) are `Etc/UTC` today. But nothing in the code pins `TimeZone`, the
failure is unrecoverable without manual DDL, and it silently corrupts the day attribution of the
data that does get written.

**Fix:** in 0009, before (or instead of) the RLS backfill, repair any `fire_detections_YYYYMMDD`
partition whose bounds are not UTC-midnight-aligned. On a fresh migration they are empty, so
`DROP TABLE` plus recreate is sufficient; for a partition holding rows, `DETACH`, create the
UTC-bounded replacement, move the rows, drop the old one — or `RAISE EXCEPTION` with an actionable
message rather than leaving a database that cannot ingest. Separately, catch
`invalid_object_definition` in `ensure_fire_detection_partition` and re-raise it naming the
overlapping partition and the remedy. Belt and braces: set `TimeZone=UTC` on every connection and in
the migrator, and assert it in a migration test.

### R-2 — MEDIUM — the tombstone is idempotent only when the caller supplies a hash

**Location:** `packages/db/src/repositories/observation-versions.ts:268-274`.

```ts
const tombstoneHash = createHash('sha256')
  .update(input.status)
  .update(input.contentSha256 ?? row.latest_content_sha256)
  .digest();
```

The primary defect is fixed: tombstoning a live record now always writes, because
`sha256(status || head)` cannot equal `head`. But `row.latest_content_sha256` is the **current head**,
and after the first tombstone the head *is* the tombstone — so each reconcile hashes the previous
tombstone's hash and produces a new value. Measured on the EMSC `MISSING_FROM_SOURCE` path, where
there is no provider content and the caller therefore omits `contentSha256` (ADR-030: the record
simply vanished):

```text
reconcile day 11: {"inserted":true,"versionId":"2","versionSeq":2}
reconcile day 12: {"inserted":true,"versionId":"3","versionSeq":3}
reconcile day 13: {"inserted":true,"versionId":"4","versionSeq":4}
versions now: 1/ACTIVE 2/MISSING_FROM_SOURCE 3/MISSING_FROM_SOURCE 4/MISSING_FROM_SOURCE

with a stable caller hash instead:
  day 14: {"inserted":true,...}   day 15: {"inserted":false,...}   <- idempotent
```

The code comment states the opposite: *"tombstoning the same record twice produces the same hash, so
it stays idempotent instead of piling up identical versions"*. That holds only for the
caller-supplies-a-hash case, which is the USGS `DELETED` path — not the case the optional parameter
was added for.

**Effect:** ADR-030 re-queries the last 7 days daily, so a vanished EMSC `unid` gains one
`observation_versions` row per day forever, each with a fresh `ingested_at`. The record stays
correctly invisible (`observationsNow` returns 0 rows), so nothing false is shown — which is why this
is MEDIUM — but the change-signal diff between two knowledge states sees a new version of a dead
record every day, and storage grows without bound on records that will never return.

**Fix:** the query already selects `v.lifecycle_status` and never reads it — the intended guard looks
like it was dropped. Return `{ inserted: false }` when the head is already a tombstone with the same
status, or derive the hash from the newest **non-tombstone** version's hash so it is stable across
reconciles.

### R-3 — MEDIUM — retention poisons a caller's transaction

**Location:** `packages/db/src/repositories/fire.ts:158-188`.

The catch handles `55P03` and `continue`s — but 55P03 has already aborted the surrounding
transaction, so the next statement fails with `25P02`, which is not caught. Measured with a real
long reader holding `AccessShareLock` on the parent:

```text
dropDetectionPartitionsBefore(db, …)  -> {"dropped":[],"deferred":[ …10 partitions… ]}  (10.1 s)  OK
same call inside db.transaction()     -> THREW 25P02 current transaction is aborted             FAIL
```

The parameter type is `Kysely<DB> | Transaction<DB>`, and every sibling repository function in this
package takes a transaction, so the shape invites it. The docstring's "The caller commits between
partitions" is a convention with nothing enforcing it; inside one transaction the parent's ACCESS
EXCLUSIVE would also be held across every day, which is what S-7 was about.

**Fix:** narrow the parameter to `Kysely<DB>`, or wrap each drop in a savepoint so a deferred
partition cannot poison the outer transaction.

### R-4 — MEDIUM — the migrator CLI does not inherit the TLS fix

**Location:** `packages/db/src/migrator/cli.ts:87` — unchanged by this round:

```ts
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
```

No `driverConnectionString`, no `ssl`. What the policy change *did* buy: the CLI calls
`assertConnectionUrlPolicy`, which now refuses `uselibpqcompat` and `ssl` outright, so the concrete
MITM bypass from the first review is closed on this path too. What remains:

- `sslmode` still reaches the driver and still decides TLS, so pg — not GeoNerva — owns the decision
  on the connection that runs DDL with the highest-privilege credential;
- `sslmode=require` is accepted by the policy and resolves to `{}` today, i.e. verification by Node's
  default — but pg's own deprecation notice says v9 will make it `rejectUnauthorized: false`, and
  there is no override here to stop that;
- `sslrootcert`/`sslcert`/`sslkey` are honoured here and stripped in `createPool`, so the two paths
  disagree about what a URL means;
- a pinned CA is not available at all.

**Fix (one line):**

```ts
const client = new pg.Client({
  connectionString: driverConnectionString(url, variableName),
  ssl: sslConfigFor(url, { nodeEnv: process.env['NODE_ENV'], variableName }),
  connectionTimeoutMillis: 10_000,
});
```

`testing/create-test-database.ts:34` and `testing/test-database.ts:103,181,190` build raw clients
too, but the F-6 guard restricts them to loopback, where TLS is genuinely moot. Worth a comment
saying so, so the next reader does not have to re-derive it.

### R-5 — MEDIUM — `sslnegotiation=direct` still lets the URL win

**Location:** `packages/db/src/connection-url.ts:177-184` (`TLS_QUERY_PARAMETERS`).

`pg-connection-string` contains `if (config.sslnegotiation === 'direct' && config.ssl === undefined)
config.ssl = true`. Stripping `sslmode` makes `config.ssl` undefined, so this branch now fires where
it previously would not, and the resulting `ssl: true` overrides GeoNerva's object. Measured through
the exact pair of calls `createPool` makes, reading `client.connectionParameters.ssl`:

```text
?sslmode=verify-full                        -> {"rejectUnauthorized":true,"ca":"PINNED-CA"}   OK
?sslmode=require                            -> {"rejectUnauthorized":true,"ca":"PINNED-CA"}   OK
?sslmode=verify-full&SSLROOTCERT=/etc/x.pem -> {"rejectUnauthorized":true,"ca":"PINNED-CA"}   OK
?sslmode=verify-full&sslmode=disable        -> {"rejectUnauthorized":true,"ca":"PINNED-CA"}   OK
?sslmode=require&USELIBPQCOMPAT=true        -> {"rejectUnauthorized":true,"ca":"PINNED-CA"}   OK
?sslmode=verify-full&sslnegotiation=direct  -> true                                           CA DROPPED
?sslmode=verify-ca&sslnegotiation=direct    -> true                                           CA DROPPED
```

`ssl: true` still means `rejectUnauthorized: true` in Node, so the server is authenticated against
the system trust store — this is a silent loss of pinning, not an open door. But the module's own
docstring says "with every TLS parameter removed", and this one is not.

**Fix:** add `sslnegotiation` to `TLS_QUERY_PARAMETERS`, and make the removal case-insensitive:
delete any parameter whose lowercased name starts with `ssl` or equals `uselibpqcompat`. Better
still, reject unknown parameters rather than stripping silently.

### LOW findings

**R-6** — `packages/db/src/client.ts:98-112`. Kysely 0.29.6's `KyselyConfig` is
`{dialect, plugins?, log?}`; `preparedStatements` appears nowhere in the package, so the object
spread passes an option nothing reads (and the spread is why TypeScript does not object). It is also
not needed: `PostgresDriver.executeQuery` calls `client.query(compiledQuery.sql,
compiledQuery.parameters)` with no statement name, so pg uses the unnamed extended-protocol path and
never creates a server-side prepared statement. ADR-008's `prepare=false` is satisfied by
construction. **My original S-15 was right that the option was dead and wrong about the risk — the
risk does not exist.** Either drop the parameter or keep it with a comment explaining why it is a
no-op; and correct the §3a S-15b entry, which currently states that `preparedStatements: false` "is
now applied to the Kysely dialect".

**R-7** — retention now costs at most `lockTimeoutMs` per partition instead of blocking without
bound, which is the important change. But the cost is linear: 10 blocked partitions at 1 s took
10.1 s in my measurement, and each attempt re-enters the parent's lock queue, so concurrent fire
queries can be delayed by up to `lockTimeoutMs` per partition. Consider stopping after the first
deferral (if one is blocked the rest almost certainly are) or giving the whole run a budget.

**R-8** — `sslModeOf`, the rejected-parameter check and `TLS_QUERY_PARAMETERS` all use exact
lowercase matching, and `searchParams.get('sslmode')` reads only the first of duplicated values. I
tried `SSLMODE=`, `SslMode=`, `SSL=0`, `USELIBPQCOMPAT=true`, `SSLROOTCERT=`,
`?sslmode=verify-full&sslmode=disable` and `?sslmode=disable&sslmode=verify-full`: every one fails
safe, either refused outright or resolving to `rejectUnauthorized: true`. But
`?sslmode=verify-full&sslmode=disable` is *accepted* while the operator's last word was `disable`,
which is a confusing thing to be lenient about. Reject duplicated TLS parameters explicitly.

**R-9** — `databaseNameOf` (`connection-url.ts:79`) still returns the raw pathname. The commit
message for `6373405` says it percent-decodes; it does not. Measured: `…/prod%2F_test` is accepted
(the literal name `prod/_test` does not end in `_test`) and `…/scratch%5Ftest` is refused (the
literal name `scratch_test` does). Both directions fail safe — an accepted encoded name would have
`ensureTestDatabase` create `"prod%2F_test"` while pg connects to `prod/_test`, which errors rather
than truncating anything — so this is cosmetic. Note also that `endsWith('_test')` is case-sensitive,
so `…/X_TEST` and `…/scratch_TEST` are refused; safe, but worth saying out loud in the error message.

**R-10** — `0009:142-152` revokes `EXECUTE` from `PUBLIC` on all four functions (verified: `proacl`
no longer contains a bare `=X/geonerva` entry for any of them), but there is no
`ALTER DEFAULT PRIVILEGES IN SCHEMA geonerva REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, so the next
function a migration adds starts `PUBLIC`-executable again.

**R-11** — the new rule is effective for realistic code but not exhaustive. Probed:

```text
sql`SELECT ${sql.raw(column)}`                 -> error          OK
sql.raw('SELECT 1')                            -> error          OK
const raw = sql.raw; raw('SELECT 2')           -> error          OK
const { raw: d } = sql; d('SELECT 3')          -> only @typescript-eslint/unbound-method
(sql as never)['raw']('SELECT 4')              -> no error       MISS
```

The computed-access hole needs an explicit cast to compile, so review would catch it — but this is
exactly the shape of P1's F-1 (the `NEXT_PUBLIC` rule missing bracket access), and the lesson there
was to cover every syntactic form. Add `MemberExpression[computed=true][property.value='raw']` and a
destructuring selector.

**S-11** — unchanged and not claimed: `sql.lit(decimals)` at `spatial/fragments.ts:125,133`.

## R.4 Verified fixed

Each of these failed before its fix, and I re-verified it independently rather than relying on the
new tests.

| Finding | Evidence |
|---|---|
| **S-1** | `SEARCH_PATH.replaceAll(' ','')` produces `-c search_path=public,extensions`. The new `security-fixes.int.test.ts` opens a real pool through `createPool`, runs `SHOW search_path` and checks `to_regclass('geonerva.sources')`. The integration suite is green (134 tests), so the production connection factory is now exercised. |
| **S-2** (core) | Resolved `client.connectionParameters.ssl` for the createPool path is `{"rejectUnauthorized":true,"ca":"PINNED-CA"}` for both `sslmode=verify-full` and `sslmode=require` — the pinned CA now survives, which it did not before. `uselibpqcompat`, `ssl=false`, `sslmode=disable`, `sslmode=prefer` and a missing `sslmode` are all refused in production. Case variants of `sslmode` fail closed ("must require TLS in production"). See R-5 for the one remaining parameter. |
| **stripping is value-preserving** | I specifically looked for a URL whose meaning changes. `driverConnectionString` round-trips through `URLSearchParams`, which re-encodes `%20` as `+` — but `pg-connection-string` decodes both to a space, and a real connection carrying `options=-c%20statement_timeout%3D5000` produced `statement_timeout = 5s` both before and after stripping. Passwords with `%40`/`%3A`/`%2F`, IPv6 hosts, non-default ports, mixed-case hosts and unrelated parameters all survive unchanged. |
| **S-3** | 19 adversarial URLs. Now refused: the development database on loopback, `…/postgres`, an SSH-tunnelled `…@127.0.0.1:5433/supabase_prod`, `localhost:5432/production`, `0.0.0.0/x_test`, `localhost.`, the `userinfo@host` trick, a `#fragment` trick, `?dbname=` smuggling, unix sockets, and an override value of `true` instead of `1`. Accepted: the documented default, `[::1]/x_test`, and an explicit remote override. The one accepted case worth naming is a *tunnelled* database that is itself named `*_test` — inherent to a name-based rule, and the name does say "test". |
| **S-5** | `SELECT … WHERE NOT relrowsecurity` over the whole schema returns **zero rows** after migration, covering the eight partitions 0005 created (backfilled by 0009), partitions created at runtime, and — the case asked about — the partition seen by the **losing** side of a creation race: the winner enables RLS inside the same transaction that creates it, so the loser's early return is safe. Measured `relrowsecurity = true` on the raced partition. |
| **S-6** | Two concurrent autocommit sessions calling `ensure_fire_detection_partition('2031-08-08')`: `['ok(fire_detections_20310808)', 'ok(fire_detections_20310808)']`. Previously one raised `42P07`. |
| **S-7** (primary path) | With a second session holding an open transaction that had run `SELECT count(*) FROM geonerva.fire_detections`: `dropDetectionPartitionsBefore(…, {lockTimeoutMs:1000})` returned `{dropped:[], deferred:[…10 partitions…]}` in 10.1 s instead of blocking, and after the reader committed the same call dropped all 10. Retention no longer parks ingestion behind a reader. |
| **S-8** (primary path) | Tombstoning a live record now writes: `{"inserted":true,"versionSeq":2}`, and `observationsNow` drops to 0 rows. A caller-supplied hash that collides with the head can no longer suppress the tombstone, because the stored hash is `sha256(status || content)` rather than the caller's value. See R-2 for the repeat case. |
| **S-10** | The rule fires on `sql.raw(...)` inside a template, on a bare `sql.raw('…')` call and on aliasing. See R-11 for the residual forms. `pnpm lint --max-warnings=0` is clean with the rule active. |
| **S-12** | `truncateAll` now builds the list with `format('geonerva.%I', t)` server-side over a bound `text[]`. No hand-quoted identifier remains in the package. |
| **S-13** | `geonerva_web`'s column privileges on `agent_outputs` are now `created_at, id, model, prompt_version, role, snapshot_id, used, validation_status` — `output` is gone, and the grant finally matches the comment above it. (The table-level `REVOKE` correctly cleared 0007's column grants before the new grant re-established them.) |
| **S-14** | `proacl` for all four maintenance functions no longer contains a bare `=X/geonerva` (PUBLIC) entry: `{geonerva=X/geonerva,geonerva_worker=X/geonerva}`, plus `geonerva_web` on the reporting function only. See R-10. |
| **S-16** | The `clock_timestamp()` contract is now documented in place: `finishRun` must be the last statement of the ingestion transaction. That is what I asked for — the timestamp is unchanged, the invariant is now stated where someone will read it. |
| **S-17** | Verified with concurrency rather than by reading. Eight simultaneous cold acquisitions for one product: **1 acquired, 7 refused, 1 RUNNING row**. Eight simultaneous workers all finding the *same stale* lease: **1 acquired, 7 refused, 1 RUNNING row, exactly 1 row marked `LEASE_EXPIRED`** — no double-acquire, no lost lease, no duplicate expiry. Holder finishing mid-flight: 1 acquired. Inside a single transaction, a second acquire returns `{acquired:false, heldByRunId:…}` and a third acquire for a different source still works — no `25P02`. **The rewrite introduced no new race.** |
| **S-18** (half) | `0.0.0.0` is no longer treated as loopback and is refused. The percent-decoding half is R-9. |
| **S-9, C1-forward** | Recorded in `IMPLEMENTATION_PLAN.md` §3a against P8, with the dependency rule required before the first endpoint. Correctly scoped. |
| **DST** | `ensure_fire_detection_partition('2030-03-10')` under `America/New_York` produced `FROM ('2030-03-09 19:00:00-05') TO ('2030-03-10 20:00:00-04')` — exactly 24 h in UTC across the spring-forward boundary. The `AT TIME ZONE 'UTC'` anchoring is correct. |

**Project checks:** `pnpm typecheck` clean; `pnpm lint --max-warnings=0` clean with the new rule;
`pnpm depcruise` clean (103 modules, 297 dependencies); `pnpm test:unit` 297/297;
`pnpm test:integration` 134/134 against PostgreSQL 17.0 / PostGIS 3.4.3.

All probing used throwaway databases (`geonerva_rr_test`, `geonerva_rr2_test`,
`geonerva_probe_test`), which have been dropped. The development database was not touched.

## R.5 What blocks G2 now

1. **R-1** — must be fixed. A migration that leaves the database unable to ingest on a supported
   configuration is not a schema that can be frozen.

Recommended to fix in the same round, because they sit inside the code G2 freezes:

2. **R-2** — the tombstone path is the one ADR-030 depends on, and the guard is one early return.
3. **R-3** — reintroduces, in the retention path, the defect this round removed from the lease.
4. **R-4** — one line, and it makes the two connection paths agree about what a URL means.
5. **R-5** — one string in `TLS_QUERY_PARAMETERS`.

R-6 to R-11 and S-11 are LOW and can be recorded rather than fixed, except the §3a S-15b wording in
R-6, which should be corrected because it asserts a behaviour Kysely does not have.

Once R-1 is fixed I have no objection to signing G2 from a security standpoint. A further re-review
should re-run only the non-UTC migration scenario end to end: migrate a fresh database under
`ALTER DATABASE … SET TimeZone`, confirm every partition's bounds are UTC-midnight-aligned, confirm
`ensure_fire_detection_partitions` spans the old seam without raising, and confirm a detection at
`00:30Z` lands in the partition named for its own UTC day.

---

# Re-verification

- **Date:** 2026-09-19
- **Scope:** `git diff 6e1fb11..HEAD` — commits `a51e81b`, `2bcab03`, `7757332`, `ce4ac29`,
  `33b3c81`, `b64eeac` (plus `5e6a951`, the re-review above). 12 files, +1,371/−35.
- **Method:** the narrow scenario I specified, redone independently, plus the case the orchestrator
  could not test — a database that **already holds rows** with local-midnight bounds — in two zones
  on opposite sides of UTC. Every other fix re-probed rather than read.

## V.1 Verdict

**G2 can be signed off from a security standpoint.** Nothing blocks it.

The finding that blocked it — R-1, a fresh non-UTC install left unable to ingest — is fixed, and I
verified it independently: after `0001…0010` under `ALTER DATABASE … SET TimeZone='America/New_York'`
every partition is UTC-aligned (0 misaligned of 5) and a detection at `00:30Z` lands in the partition
named for its own UTC day. The cause is removed as well: every connection now pins `TimeZone=UTC`,
the database itself is pinned, and a recurrence raises an actionable error instead of a bare overlap.

One real defect remains in 0010's repair path (V-1): the branch that moves rows out of a misaligned
partition **cannot work**, for two independent reasons. I am not treating it as a blocker, and I want
the reasoning on the record so it can be overruled: the branch is reachable only from a database that
was migrated to 0009-or-earlier under a non-UTC zone *and then accumulated detections*. GeoNerva has
no deployed instance, the development and CI databases are UTC, migrations 0001→0010 run in one pass
on an empty database, and from this commit onward every connection pins UTC — so that state does not
exist and can no longer be created. It is a broken path with no reachable caller, not a live failure.
It must still be fixed, because a migration is immutable once applied and this one's comment promises
a capability it does not have.

## V.2 Findings

| Sev | ID | Location | Summary |
|---|---|---|---|
| MEDIUM | V-1 | `migrations/0010_partition_bounds_repair.sql:63-76` | The row-preserving repair fails, twice over: (a) `INSERT … SELECT *` includes the `GENERATED ALWAYS` columns and raises `428C9 cannot insert a non-DEFAULT value into column "lat_e4"`; (b) with that corrected, the single ascending pass creates neighbour partitions with `ensure_fire_detection_partition`, which returns early because the neighbour still exists **misaligned**, leaving a routing gap — `23514 no partition of relation "fire_detections" found for row`. Reproduced in both `America/New_York` and `Europe/Berlin`. |
| LOW | V-2 | `connection-url.ts:85-87` | R-9 is half fixed. `_test` matching is now case-insensitive (verified), but `databaseNameOf` still does **not** percent-decode, contrary to the change summary. `…/scratch%5Ftest` (really `scratch_test`) is refused; `…/prod%2F_test` (really `prod/_test`) is accepted. Both fail safe. |
| LOW | V-3 | `repositories/fire.ts:160` | R-3 is documented, not enforced: Kysely's `Transaction<DB>` **extends** `Kysely<DB>`, so narrowing the parameter type does not stop a caller passing a transaction, and the 25P02 poisoning stays reachable with no compile error. |
| LOW | V-4 | `migrations/0010:145` | `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` is a **no-op** in PostgreSQL 17. Proved: after migration there is no `f` row in `pg_default_acl`, a newly created function has `proacl = null`, and `has_function_privilege('public', …, 'EXECUTE')` is `true`. Running the statement standalone, and again after an `ALTER DEFAULT PRIVILEGES … GRANT`, changes nothing. R-10 is not fixed — and a fix that silently does nothing is worse than a known gap. |
| LOW | V-5 | `eslint.config.js:91-101` | The computed-access selector works for the case it names but has a false-positive class — a plain `payload['raw']` data access is reported as a SQL-injection violation — and still misses a variable key (`sql[key](…)`). |
| LOW | V-6 | `connection-url.ts:66-72` | Duplicated `sslmode` still reads only the first value: `?sslmode=verify-full&sslmode=disable` is accepted while the operator's last word was `disable`. Fails safe; carried over from R-8. |
| LOW | V-7 | `migrations/0010:131-140` | `ALTER DATABASE … SET TimeZone` changes the default for **every** connection to that database, not just GeoNerva's, and the handler catches only `insufficient_privilege`. See V.4 for the Supabase answer. |
| LOW | V-8 | `migrations/0010:79` | `ensure_fire_detection_partitions(current_date - 1, 5)` evaluates `current_date` in the *session's* zone, which at that point is still the old one — so on a non-UTC server the recreated window can be offset by a day. Harmless, but inconsistent with the explicit UTC anchoring everywhere else in the file. |

No HIGH or CRITICAL findings.

## V.3 Findings in detail

### V-1 — MEDIUM — the row-preserving repair path does not work

**Location:** `packages/db/migrations/0010_partition_bounds_repair.sql:63-76`.

**Setup:** migrate `0001…0009` on a fresh database under `ALTER DATABASE … SET TimeZone=<zone>`, seed
one detection per UTC hour across every partition day, record a digest of every row, then apply 0010
and compare. Two zones, on opposite sides of UTC.

**(a) Generated columns.** `INSERT INTO geonerva.fire_detections SELECT * FROM geonerva.%I` selects
every column of the detached table, including `lat_e4` and `lon_e4`, which are
`GENERATED ALWAYS AS … STORED`:

```text
America/New_York  8 partitions, 188 rows seeded
  NOTICE: repairing fire_detections_20260916 (… , 24 rows)
  *** 0010 FAILED *** 428C9 cannot insert a non-DEFAULT value into column "lat_e4"

Europe/Berlin     8 partitions, 190 rows seeded
  NOTICE: repairing fire_detections_20260917 (… , 22 rows)
  *** 0010 FAILED *** 428C9 cannot insert a non-DEFAULT value into column "lat_e4"
```

The migration is transactional, so it rolls back: **no data is lost**, but the repair can never
complete and the database stays on 0009 — which is exactly the state that cannot ingest.

**(b) Ordering.** With the generated columns excluded (I patched a scratch copy of 0010 to name the
18 non-generated columns explicitly, to see what lay behind (a)) the next failure appears
immediately, in **both** zones:

```text
America/New_York  *** FAILED *** 23514 no partition of relation "fire_detections" found for row
Europe/Berlin     *** FAILED *** 23514 no partition of relation "fire_detections" found for row
```

The cause is that the loop repairs one partition at a time while its neighbours are still attached
and still misaligned. A local-midnight partition for day *D* holds rows that belong to two UTC days,
and the spill day's partition already exists under the right *name* — so
`ensure_fire_detection_partition` takes its early `IF EXISTS … RETURN` branch and never creates the
UTC-aligned range. The spill rows then have nowhere to go:

- west of UTC (`America/New_York`, UTC−4): partition `20260916` covers `[16T04:00Z, 17T04:00Z)`; its
  rows from `[17T00:00Z, 17T04:00Z)` need an aligned `20260917`, which is still the old local one
  starting at `17T04:00Z`;
- east of UTC (`Europe/Berlin`, UTC+2): partition `20260917` covers `[16T22:00Z, 17T22:00Z)`; its
  rows from `[16T22:00Z, 17T00:00Z)` need an aligned `20260916`, which still ends at `16T22:00Z`.

So neither ascending nor descending order is sufficient — the spill always points at a partition that
has not been repaired yet in one of the two directions.

**On the "two old partitions mapping onto the same UTC day" question:** they cannot. The day is
derived from the partition *name* (`to_date(right(relname,8),'YYYYMMDD')`), names are unique, and
local days map one-to-one onto names. What does happen is the converse — one old partition's rows
span **two** UTC days — which is (b).

**Fix.** Make the repair two-phase, so no rows are re-inserted while any misaligned partition is
still attached:

1. collect every misaligned partition; `DETACH` them all;
2. move their rows into one staging table (`CREATE TEMP TABLE … AS SELECT …`), then drop the
   detached tables;
3. `ensure_fire_detection_partition` for every UTC day the staged rows touch;
4. re-insert from staging with an **explicit column list** that excludes `lat_e4`/`lon_e4` — build it
   from `information_schema.columns WHERE is_generated = 'NEVER'` so a future column cannot
   reintroduce (a);
5. assert `count(*)` before and after, and `RAISE EXCEPTION` on any difference. A repair that can
   silently lose detections should refuse to be silent.

A regression test should migrate to 0009 under a non-UTC zone, insert detections on every UTC hour,
apply 0010 and assert both the row digest and that every row sits in the partition named for its own
UTC day. The new tests in `security-fixes.int.test.ts` cover partition *creation* and routing under a
non-UTC session, which is the fixed half; they do not touch the repair block, which is why the suite
is green.

### V-2 — LOW — `databaseNameOf` still does not percent-decode

`packages/db/src/connection-url.ts:85-87` is unchanged:

```ts
export function databaseNameOf(url: string, variableName = 'DATABASE_URL'): string {
  return parse(url, variableName).pathname.replace(/^\//, '');
}
```

Measured: `…/scratch%5Ftest → "scratch%5Ftest"`, `…/prod%2F_test → "prod%2F_test"`,
`…/X_TEST → "X_TEST"`. Consequences for the F-6 guard, both fail-safe: `scratch%5Ftest` — a database
genuinely named `scratch_test` — is **refused**, and `prod%2F_test` — genuinely `prod/_test` — is
**accepted** (though `ensureTestDatabase` would then create a database under a name pg does not
connect to, which errors rather than damaging anything). The case-insensitivity half of R-9 *is*
fixed: `…/X_TEST` is now accepted.

### V-3 — LOW — the `Kysely<DB>` narrowing does not exclude a transaction

`packages/db/src/repositories/fire.ts:160`. Kysely declares `class Transaction<DB> extends Kysely<DB>`,
so a transaction satisfies the narrowed parameter. Verified by compiling
`const asKysely: Kysely<DB> = trx;` inside `db.transaction().execute(…)` — no cast needed, no
type error, `true` at runtime. The comment is right about the hazard; the type does not prevent it.

**Fix:** a runtime guard is the only thing that actually holds — e.g. check `isTransaction`/the
connection provider and throw, or restructure so retention takes a `pg.Pool` and opens its own
connection. Failing that, the comment is the whole control and should say so.

### V-4 — LOW — the default-privilege revoke is a no-op

`packages/db/migrations/0010:145`. Measured after migration:

```text
new function ACL:                    {"proname":"probe_fn","proacl":null}
pg_default_acl rows:                 sequences and tables only — no 'f' row
PUBLIC can execute the new function: true
```

and running the statement by hand changes nothing:

```text
as shipped in 0010                            defacl_f=[]  newfn={acl:null, pub:true}
after running the same statement standalone   defacl_f=[]  newfn={acl:null, pub:true}
after also GRANTing to geonerva_worker        defacl_f=[{geonerva_worker=X/geonerva}]  newfn pub=true
then REVOKE FROM PUBLIC again                 defacl_f=[{geonerva_worker=X/geonerva}]  newfn pub=true
```

`ALTER DEFAULT PRIVILEGES … REVOKE` removes grants that `ALTER DEFAULT PRIVILEGES … GRANT` added; it
does not displace PostgreSQL's built-in `EXECUTE TO PUBLIC` default for functions. The four existing
maintenance functions *are* correctly revoked (0009), so nothing regressed — but the guard against
the *next* function is not there.

**Fix:** end each migration that creates a function with
`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA geonerva FROM PUBLIC`, and add a migration test asserting
that no function in the schema is `PUBLIC`-executable. A test is the only form of this that cannot
silently stop working.

### LOW findings

**V-5** — the extended rule hits its stated target and has one false-positive class. Probed:

```text
sql`SELECT ${sql.raw(column)}`              -> error   OK
sql.raw('SELECT 1')                         -> error   OK
const alias = sql.raw; alias('SELECT 2')    -> error   OK
(sql as never)['raw']('SELECT 3')           -> error   OK   (R-11's target, now closed)
const key='raw'; (sql as never)[key]('…')   -> no error      (variable key)
const { raw: d } = sql; d('SELECT 5')       -> only unbound-method
payload['raw']                              -> error   FALSE POSITIVE
```

`MemberExpression[computed=true][property.value='raw']` matches any `x['raw']`, so a data object with
a `raw` key now needs an `eslint-disable`. The rule is still net-positive; consider scoping it to
`[object.name='sql']` plus a cast-aware variant, and note that `ImportSpecifier[imported.name='raw']`
bans importing *any* symbol called `raw` from *any* module — currently harmless, but broad.

**V-6** — `sslModeOf` now scans case-insensitively but still returns on the first match, so
`?sslmode=verify-full&sslmode=disable` is accepted (and resolves to `rejectUnauthorized: true`,
because both copies are stripped) while `?sslmode=disable&sslmode=verify-full` is refused. Safe, but
lenient about a contradiction. Reject a duplicated `sslmode` outright.

**V-7, V-8** — see V.4.

## V.4 The two judgement calls

**Pinning `TimeZone=UTC` on the database — safe for Supabase?** Yes, with one change I would make.

- It will not usually take the error path you handle: on Supabase the migration role is `postgres`,
  which owns the database, so `ALTER DATABASE postgres SET TimeZone TO 'UTC'` **succeeds**. The
  `insufficient_privilege` handler is a reasonable belt, not the expected path.
- The value is a no-op in effect — Supabase already defaults to UTC — so there is no behaviour change
  to be surprised by.
- The thing worth narrowing is blast radius, not risk: `ALTER DATABASE` changes the default for
  *every* connection to that database, including PostgREST, the SQL editor, `pg_cron` and anything
  else in the project. An application migration claiming a database-wide default is a wider reach
  than it needs. `ALTER ROLE <app role> IN DATABASE <db> SET TimeZone TO 'UTC'` gets the same
  protection scoped to GeoNerva's roles, and the per-connection pin in `client.ts` and `cli.ts`
  already covers the requirement on its own.
- One robustness point: catch `OTHERS` with a `NOTICE`, not just `insufficient_privilege`. A managed
  host that refuses this with `feature_not_supported` (or anything else) would fail the whole
  migration, and the per-connection pin means nothing is actually lost by tolerating it. Verified
  that the statement runs correctly inside the migration's transaction.

**Recreating the deployment window in 0010 — surprising?** No, and it is the right call.

- 0005 already does exactly this, so it is consistent rather than novel, and the repair may legitimately
  have dropped every partition, so leaving a fresh database with none would be worse.
- It is a convenience rather than a correctness requirement — `ensurePartitionsForDays` runs before
  every batch — which is worth one sentence in the comment so a future reader does not think the
  window is load-bearing.
- The one wrinkle is V-8: `current_date` is evaluated in the session's zone, which at that point in
  0010 is still the old one (`ALTER DATABASE … SET` only affects new sessions). Use
  `(now() AT TIME ZONE 'UTC')::date` so the whole file speaks UTC. Note also that this makes the
  migration's effect depend on *when* it runs, which is already true of 0005 but slightly weakens
  "the same migrations produce the same schema".

## V.5 Verified fixed

| Finding | Evidence |
|---|---|
| **R-1** (fresh installs — the blocker) | Independently redone: fresh database, `ALTER DATABASE … SET TimeZone='America/New_York'`, migrated `0001…0010`. **0 misaligned of 5 partitions**, each bound at UTC midnight (`FROM ('2026-09-17 20:00:00-04')` = `2026-09-18T00:00:00Z`, displayed in the session's zone). A detection at `00:30Z` landed in `fire_detections_20260920`, the partition named for its own UTC day. The repair loop ran and corrected all eight partitions 0005 had created (`NOTICE: repairing fire_detections_20260916 … 0 rows`, ×8). The seam that used to raise `42P17` is gone. |
| **R-1** (cause removed) | `client.ts` pins `-c TimeZone=UTC` in the startup options *and* in the per-connection `SET`; `migrator/cli.ts` does the same; `ALTER DATABASE` recorded `setconfig = ["TimeZone=UTC"]`, and a pool that sets no zone of its own reports `TimeZone = UTC`. `ensure_fire_detection_partition` now catches `invalid_object_definition` and re-raises naming the cause and the remedy. |
| **R-2** | Four consecutive `MISSING_FROM_SOURCE` reconciles with no caller hash: `inserted:true` once, then `inserted:false` three times — **exactly one tombstone version** (`1/ACTIVE 2/MISSING_FROM_SOURCE`), record invisible. Escalation works: `→ DELETED` writes version 3, a repeat of `DELETED` is a no-op, `→ MISSING_FROM_SOURCE` writes version 4 (correct — the status genuinely changed). The USGS stable-hash path stays idempotent (`inserted:true`, then false, false). |
| **R-4** | `migrator/cli.ts` now builds its client from `driverConnectionString` + `sslConfigFor`, with `-c search_path=… -c TimeZone=UTC`. The highest-privilege connection and `createPool` now agree about what a URL means. |
| **R-5 / R-8** | Stronger than I asked for. Every `ssl*` parameter in any case, plus `uselibpqcompat` and `requiressl`, is **refused** rather than stripped: `sslnegotiation`, `SSLNEGOTIATION`, `SslNegotiation`, `sslrootcert`, `SSLROOTCERT`, `sslcompression`, `sslsni`, `requiressl`, `uselibpqcompat`, `USELIBPQCOMPAT`, `ssl`, `SSL`. `sslmode` is read case-insensitively, so `?SSLMODE=verify-full` and `?SslMode=verify-full` are now accepted and resolve to `{"rejectUnauthorized":true,"ca":"PINNED-CA"}` instead of failing closed. The pinned CA survives in every accepted case, and unrelated parameters (`application_name`, `options`) pass through untouched. The prefix rule means a parameter libpq adds in future is refused by default, which is the right direction. |
| **R-6** | `preparedStatements` removed from `CreatePoolOptions`, `createDb`, `workerPoolOptions` and `webPoolOptions`. The §3a S-15b entry now states the requirement holds by construction and that Kysely has no such option — accurate. |
| **R-11** | `(sql as never)['raw']('…')` is now an error, which was the stated target. See V-5 for the residuals. |
| **S-11** | `sql.lit(decimals)` is gone. Compiled: `ST_AsGeoJSON("v"."centroid"::geometry, $1)` with `PARAMS=[6]` for `asGeoJson`, and `$1 / [3]` for `expressionAsGeoJson`. **Every value in the spatial layer is now a bound parameter**, without exception — the file's own rule 1 finally holds as written. |
| **F-6 guard** (re-probed) | The development database, `…/postgres`, a tunnelled `…@127.0.0.1:5433/supabase_prod` and `0.0.0.0/x_test` are all refused; `X_TEST` is now accepted thanks to the case-insensitive match. |

**Project checks:** `pnpm typecheck` clean; `pnpm lint --max-warnings=0` clean; `pnpm depcruise` clean
(103 modules, 298 dependencies); `pnpm test:unit` 297/297; `pnpm test:integration` 136/136 against
PostgreSQL 17.0 / PostGIS 3.4.3.

All probing used throwaway databases (`geonerva_v1_test` … `geonerva_v7_test`), which have been
dropped, and a scratch copy of 0010 that was never written into the repository. The development
database was not touched.

## V.6 Gate G2

**Signed off from a security standpoint. Nothing blocks it.**

- No CRITICAL or HIGH finding is open. Every finding from the first review and the re-review that was
  a defect in reachable code is fixed and independently verified.
- Both §3a exit criteria, F-6 and F-7, are met, and F-7 is now met in a stronger form than the
  criterion asks: GeoNerva — not the URL — configures the driver's TLS, on every connection including
  the migrator.
- V-1 is a genuine defect that must be fixed, but its only caller is a database state that does not
  exist and can no longer arise. It should be a tracked follow-up, not a gate item. If the orchestrator
  disagrees with that reachability argument, the fix is half a day's work and V.3 describes it.

Recommended follow-ups, in order: V-1 (two-phase repair with an explicit column list and a row-count
assertion, plus the regression test that would have caught it), V-4 (replace the no-op revoke with an
end-of-migration `REVOKE` and a test), V-2 and V-3 (small, and both are cases where a summary claims
more than the code does), then V-5 to V-8. None of them needs to precede P3.
