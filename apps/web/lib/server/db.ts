/**
 * The web process's database handle, and the **only** module that touches `@geonerva/db`.
 *
 * ### Why the imports here are so specific
 *
 * `@geonerva/db`'s root barrel re-exports `repositories/index.ts`, and a repository read returns
 * the *newest* row rather than the row as of `T` — so a replay served through one would silently
 * show the present. `.dependency-cruiser.cjs` enforces that with
 * `web-reads-facts-only-through-asof`, and the rule is not theoretical: importing the barrel from
 * `apps/web` produces five violations reaching `sources.ts`, `source-records.ts`,
 * `raw-records.ts`, `observation-versions.ts` and `ingestion-runs.ts`. Verified, not assumed.
 *
 * So this module imports the two **subpaths** and nothing else: `@geonerva/db/client` for the
 * pool and `@geonerva/db/asof` for every read. Funnelling both through one file means the rule has
 * exactly one place to be violated, and a reviewer has one file to read.
 *
 * ### The pool
 *
 * `webPoolOptions` sets `application_name=geonerva-web` — so a runaway query is attributable in
 * `pg_stat_activity` — and a **10-second statement timeout**, which is the backstop behind every
 * bounded query in this layer: a spatial query that escapes its radius cap still cannot hold a
 * connection open indefinitely.
 *
 * ### The role, and a claim this comment used to make and should not have
 *
 * Migration 0007 grants `geonerva_web` `SELECT` on facts, `INSERT`/`UPDATE` on exactly
 * `rate_limit_buckets` and `geocode_cache`, and no `SELECT` at all on `raw_source_records` or
 * `agent_outputs`. Those grants are correct. What was written here — that the read-only property
 * "is enforced by the database rather than by this code" — is **not true of either deployment
 * shape available today**, and saying so was worse than saying nothing:
 *
 *  - **As the `geonerva_web` role.** Every table has RLS `ENABLE` with **zero policies** and the
 *    role has no `BYPASSRLS`, so deny-all applies to it: verified, `pg_policies` for the
 *    `geonerva` schema is empty. `packages/pipeline/src/blindness.int.test.ts` measures the
 *    consequence — under `SET LOCAL ROLE geonerva_web`, `observationsAsOf` returns 0 rows where
 *    the owner sees 230. Every endpoint would serve an empty world.
 *  - **As 0007's documented default**, granting the NOLOGIN group role to the owning login role.
 *    Role membership is additive and the login role still *owns* the tables, so it keeps
 *    `INSERT`/`UPDATE`/`DELETE` on everything and bypasses policy-less RLS as owner. The grants
 *    describe a restriction that does not bind.
 *
 * So the read-only property is currently enforced by **this layer's structure** — no write
 * statement exists outside `consumeRateLimit`, and the dependency rules stop a repository being
 * reachable — and the database's part of it is waiting on RLS policies that no phase has written.
 * `docs/reviews/gate-g8.md` §9 carries this as an open finding rather than a fixed one, because
 * writing those policies touches every table and is not a change to make quietly inside an API
 * phase.
 */

import { createDatabase, webPoolOptions, type DatabaseHandle } from '@geonerva/db/client';
import type { DB } from '@geonerva/db/schema';
import type { Kysely as KyselyType } from 'kysely';

export {
  attributionsFor,
  clusterEvidenceAsOf,
  clusterVersionsAsOf,
  correlationEvidenceAsOf,
  derivationsAsOf,
  evidenceItemsAsOf,
  healthAsOf,
  linksAsOf,
  observationEvidenceAsOf,
  observationsAsOf,
  productCoverageFor,
  runEvidenceAsOf,
  runSummariesAsOf,
  runTally24hAsOf,
  sourceCatalog,
  sourceCutoffsAsOf,
  workerHeartbeatAsOf,
} from '@geonerva/db/asof';

export type {
  AttributionRow,
  ClusterEvidenceRow,
  CorrelationEvidenceRow,
  EvidenceRow,
  ObservationEvidenceRow,
  RunEvidenceRow,
  RunSummaryRow,
  RunTallyRow,
  SourceHealthAsOf,
  SourceProductRow,
  SourceRow,
  WorkerHeartbeatRow,
} from '@geonerva/db/asof';

/** The handle type the service layer passes around. */
export type Kysely = KyselyType<DB>;

let handle: DatabaseHandle | null = null;

/**
 * The process-wide handle, created on first use.
 *
 * A module-level singleton rather than a per-request pool: a serverless instance serves many
 * requests and a new pool per request would exhaust Postgres' connection limit long before it
 * exhausted anything else. `close` exists for tests; production never calls it.
 */
export function database(): DatabaseHandle {
  if (handle !== null) return handle;

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.trim() === '') {
    /*
     * A configuration failure, raised as a plain error rather than a problem document. It happens
     * at startup on the first request, the message names the variable and never its value, and
     * the API layer turns it into a generic `INTERNAL_ERROR` — a caller must not be able to
     * distinguish "misconfigured" from "broken", because the difference tells them about the
     * deployment.
     */
    throw new Error('DATABASE_URL is not set');
  }

  /*
   * Destructured rather than accessed.
   *
   * `process.env.NODE_ENV` and `process.env['NODE_ENV']` are each valid in one of this
   * repository's two TypeScript programs and rejected by the other: the web program has Next's
   * `ProcessEnv` augmentation, which declares `NODE_ENV` and so makes eslint's `dot-notation`
   * require the dot, while the root program sees it through the index signature, where
   * `noPropertyAccessFromIndexSignature` forbids exactly that. Destructuring is the one form both
   * accept.
   */
  const { NODE_ENV } = process.env;
  handle = createDatabase(webPoolOptions(connectionString, NODE_ENV));
  return handle;
}

/** Replaces the handle. Tests only; it is how an integration test injects its own database. */
export function setDatabaseForTesting(replacement: DatabaseHandle | null): void {
  handle = replacement;
}
