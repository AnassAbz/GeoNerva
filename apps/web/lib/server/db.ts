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

import { webConfig } from './config.ts';
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

/*
 * Reference data and the provider cache, which are not facts and take no knowledge time (see
 * `packages/db/src/places.ts`). `storeGeocodeResult` is the web role's second granted write.
 */
export {
  cachedGeocodeResult,
  nearestPlaceTimezone,
  placeByGeonameId,
  storeGeocodeResult,
  suggestPlaces,
} from '@geonerva/db/places';
export type { PlaceRow } from '@geonerva/db/places';

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

  /*
   * Through the validated configuration, not around it.
   *
   * This used to read `process.env['DATABASE_URL']` directly and check it for emptiness, which
   * made it the one part of the web process that could run on an environment `packages/config`
   * had never seen: a URL with the wrong scheme reached the driver, and `NODE_ENV` was taken raw
   * rather than parsed, so the production TLS policy keyed off an unvalidated string. The config
   * is memoized, so this costs nothing per request beyond the first.
   *
   * A failure is still a plain `Error` rather than a problem document: the API layer turns it into
   * a generic `INTERNAL_ERROR`, because a caller must not be able to distinguish "misconfigured"
   * from "broken" — that difference is information about the deployment.
   */
  const config = webConfig();
  handle = createDatabase(webPoolOptions(config.DATABASE_URL, config.NODE_ENV));
  return handle;
}

/** Replaces the handle. Tests only; it is how an integration test injects its own database. */
export function setDatabaseForTesting(replacement: DatabaseHandle | null): void {
  handle = replacement;
}
