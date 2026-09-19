/**
 * The database client: a node-postgres pool plus the Kysely instance built on it (ADR-021).
 *
 * Two connection profiles, because the two processes need different things
 * (docs/ARCHITECTURE.md §2):
 *
 *  - **worker** — session or direct connection. It needs prepared statements, long transactions
 *    and `COPY`, so it keeps a small pool and lets Kysely use named statements.
 *  - **web** — Supabase's transaction pooler (port 6543). Prepared statements do not survive a
 *    transaction-pooled connection, so this profile disables them.
 *
 * `search_path` is set to `public, extensions` on every connection so that PostGIS types and
 * functions resolve on both a plain PostgreSQL (PostGIS in `public`) and Supabase (PostGIS in
 * `extensions`). GeoNerva's own tables are always written schema-qualified as `geonerva.…`, so
 * nothing this package does depends on `geonerva` being in the search path — which also means a
 * table created in another schema can never shadow one of ours.
 */

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import {
  assertConnectionUrlPolicy,
  driverConnectionString,
  describeConnectionTarget,
  sslConfigFor,
} from './connection-url.ts';
import type { DB } from './generated/database.ts';
import { SEARCH_PATH } from './schema.ts';

export { GEONERVA_SCHEMA, SEARCH_PATH } from './schema.ts';

export interface CreatePoolOptions {
  readonly connectionString: string;
  /** `production` enables the TLS requirement (F-7). Defaults to non-production. */
  readonly nodeEnv?: string | undefined;
  /** Which environment variable the URL came from, for error messages that never echo it. */
  readonly variableName?: string;
  /** Shown in `pg_stat_activity`, which makes a runaway query attributable. */
  readonly applicationName?: string;
  readonly max?: number;
  /**
   * `false` for the web app behind a transaction pooler: prepared statements do not survive a
   * connection that is handed to another transaction.
   */
  readonly preparedStatements?: boolean;
  /** PEM certificate authority, when a deployment pins one. */
  readonly caCertificate?: string | undefined;
  /** Server-side statement timeout. A read path must not be able to pin a connection forever. */
  readonly statementTimeoutMs?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
}

/**
 * Builds a validated pool. The connection string is checked against the TLS policy **before** the
 * first connection is attempted, so a misconfigured production deployment fails at start-up
 * rather than after it has already leaked a handshake.
 */
export function createPool(options: CreatePoolOptions): pg.Pool {
  const variableName = options.variableName ?? 'DATABASE_URL';
  assertConnectionUrlPolicy(options.connectionString, {
    nodeEnv: options.nodeEnv,
    variableName,
  });

  const statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
  const pool = new pg.Pool({
    connectionString: driverConnectionString(options.connectionString, variableName),
    ssl: sslConfigFor(options.connectionString, {
      nodeEnv: options.nodeEnv,
      variableName,
      caCertificate: options.caCertificate,
    }),
    application_name: options.applicationName ?? 'geonerva',
    max: options.max ?? 5,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    statement_timeout: statementTimeoutMs,
    // Startup parameter, which survives a transaction pooler; the per-connection SET below is the
    // belt to its braces for poolers that strip `options`.
    // No space after the comma: the server splits `options` on whitespace, so `public, extensions`
    // arrives as search_path=`public,` and every connection fails with a FATAL (S-1).
    options: `-c search_path=${SEARCH_PATH.replaceAll(' ', '')}`,
  });

  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${SEARCH_PATH}`).catch(() => {
      // A failure here is not fatal: the startup parameter has already set the same value, and
      // every GeoNerva table reference is schema-qualified. The next real query surfaces any
      // genuine connection problem.
    });
  });

  return pool;
}

/**
 * Builds the typed Kysely instance. Every query goes through this.
 *
 * `preparedStatements: false` disables Kysely's prepared-statement cache, which is required
 * behind a transaction pooler (ADR-008, S-15).
 */
export function createDb(
  pool: pg.Pool,
  options: { preparedStatements?: boolean } = {},
): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    ...(options.preparedStatements === false ? { preparedStatements: false } : {}),
  });
}

export interface DatabaseHandle {
  readonly db: Kysely<DB>;
  readonly pool: pg.Pool;
  /** `host:port/database` — safe to log. */
  readonly target: string;
  close(): Promise<void>;
}

/** Convenience: pool + Kysely + a safe description + a single close. */
export function createDatabase(options: CreatePoolOptions): DatabaseHandle {
  const pool = createPool(options);
  const db = createDb(pool, { preparedStatements: options.preparedStatements ?? true });
  return {
    db,
    pool,
    target: describeConnectionTarget(options.connectionString, options.variableName),
    close: async () => {
      await db.destroy();
    },
  };
}

/** Options for the ingestion worker: session connection, prepared statements, longer statements. */
export function workerPoolOptions(connectionString: string, nodeEnv?: string): CreatePoolOptions {
  return {
    connectionString,
    nodeEnv,
    variableName: 'DATABASE_URL_WORKER',
    applicationName: 'geonerva-worker',
    max: 5,
    preparedStatements: true,
    statementTimeoutMs: 120_000,
  };
}

/** Options for the read-only web app behind a transaction pooler. */
export function webPoolOptions(connectionString: string, nodeEnv?: string): CreatePoolOptions {
  return {
    connectionString,
    nodeEnv,
    variableName: 'DATABASE_URL',
    applicationName: 'geonerva-web',
    max: 10,
    preparedStatements: false,
    statementTimeoutMs: 10_000,
  };
}
