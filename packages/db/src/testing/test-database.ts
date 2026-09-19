/**
 * The integration-test database harness — security finding **F-6**
 * (docs/reviews/security-p1.md, docs/IMPLEMENTATION_PLAN.md §3a).
 *
 * A writing test must never be able to reach a real database. The rules enforced here:
 *
 *  1. **Only `DATABASE_URL_TEST`.** `DATABASE_URL` and `DATABASE_URL_WORKER` are never consulted,
 *     not even as a fallback, so a developer with a production URL in their shell cannot lose
 *     their data to `pnpm test:integration`. When the variable is unset, the harness uses the
 *     documented local default (`…:54320/geonerva_test`) and nothing else.
 *  2. **Local, or explicitly permitted.** The host must be loopback, or the database name must
 *     end in `_test`. Anything else is refused unless `GEONERVA_ALLOW_REMOTE_TEST_DB=1` is set,
 *     which makes reaching a remote database a deliberate, visible act.
 *  3. **Isolated.** Tests run against their own database inside the shared container, created on
 *     demand and migrated from empty. The suite truncates between tests rather than sharing
 *     state, and it never touches the development database.
 *
 * `packages/db` is the only place that knows how to do this, so every future integration test
 * inherits the guard instead of re-implementing it.
 */

import pg from 'pg';

import { databaseNameOf, hostOf, isLoopbackHost } from '../connection-url.ts';
import { migrateUp } from '../migrator/runner.ts';

/**
 * The documented local test database: the compose container from `infra/docker-compose.yml`, but
 * a **separate database** inside it, so that a test run cannot disturb development data.
 */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva_test';

/** The one variable integration tests may read. */
export const TEST_DATABASE_URL_VAR = 'DATABASE_URL_TEST';

/** The explicit escape hatch for a non-local test database. */
export const ALLOW_REMOTE_VAR = 'GEONERVA_ALLOW_REMOTE_TEST_DB';

/** Raised when the configured test database is refused. */
export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTestDatabaseError';
  }
}

export type TestEnv = Readonly<Record<string, string | undefined>>;

/**
 * Resolves and validates the test connection string. Pure with respect to the environment it is
 * handed, so the guard itself is unit-testable without a database.
 */
export function resolveTestDatabaseUrl(env: TestEnv): string {
  const configured = env[TEST_DATABASE_URL_VAR]?.trim();
  const url =
    configured === undefined || configured === '' ? DEFAULT_TEST_DATABASE_URL : configured;

  const host = hostOf(url, TEST_DATABASE_URL_VAR);
  const database = databaseNameOf(url, TEST_DATABASE_URL_VAR);
  const allowRemote = env[ALLOW_REMOTE_VAR] === '1';

  if (database === '') {
    throw new UnsafeTestDatabaseError(`${TEST_DATABASE_URL_VAR} must name a database`);
  }

  const isLocal = isLoopbackHost(host);
  const looksLikeTestDatabase = database.endsWith('_test');

  // Both conditions, not either (S-3). "Loopback" is not evidence that a database is disposable:
  // the development database is on loopback, and so is any production database someone has
  // port-forwarded or tunnelled. These tests migrate and TRUNCATE whatever they are pointed at,
  // so the name has to say out loud that losing it is acceptable.
  if (!allowRemote && !(isLocal && looksLikeTestDatabase)) {
    const reason = isLocal
      ? `the database name "${database}" does not end in "_test"`
      : `the host ${host} is not loopback`;
    throw new UnsafeTestDatabaseError(
      `refusing to run writing tests against ${host}/${database}: ${reason}. ` +
        `Point ${TEST_DATABASE_URL_VAR} at a disposable database, or set ${ALLOW_REMOTE_VAR}=1 ` +
        `to override deliberately.`,
    );
  }

  return url;
}

/** Connection string to the maintenance database on the same server. */
function maintenanceUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

/**
 * Creates the test database if it does not exist. Only ever called for a URL that has already
 * passed `resolveTestDatabaseUrl`, and only for a database whose name ends in `_test` or that
 * lives on loopback — so this can never create a database on a production server by accident.
 */
export async function ensureTestDatabase(url: string): Promise<{ created: boolean }> {
  const database = databaseNameOf(url, TEST_DATABASE_URL_VAR);

  const admin = new pg.Client({
    connectionString: maintenanceUrl(url),
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rowCount !== null && existing.rowCount > 0) return { created: false };

    // `CREATE DATABASE` cannot be parameterized, so the identifier is quoted by the server's own
    // quoting function rather than interpolated by hand.
    const quoted = await admin.query<{ name: string }>('SELECT quote_ident($1) AS name', [
      database,
    ]);
    const identifier = quoted.rows[0]?.name;
    if (identifier === undefined) throw new Error('could not quote the database name');
    await admin.query(`CREATE DATABASE ${identifier}`);
    return { created: true };
  } finally {
    await admin.end();
  }
}

/** Tables that seed data lives in; `resetTestData` restores them rather than emptying them. */
const SEEDED_TABLES = new Set(['sources', 'source_products', 'schema_migrations']);

/** Every base table in the schema, excluding partitions (which are truncated via their parent). */
async function listTables(client: pg.ClientBase): Promise<string[]> {
  const result = await client.query<{ relname: string }>(
    `SELECT c.relname
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'geonerva'
       AND c.relkind IN ('r', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
     ORDER BY c.relname`,
  );
  return result.rows.map((row) => row.relname);
}

/**
 * Empties every table except the seeded reference data, in one statement so that foreign keys do
 * not dictate an order. Identity sequences are restarted, which keeps ids stable across tests and
 * makes a failing assertion readable.
 */
export async function truncateAll(client: pg.ClientBase): Promise<void> {
  const tables = (await listTables(client)).filter((table) => !SEEDED_TABLES.has(table));
  if (tables.length === 0) return;
  // Identifiers cannot be bound as parameters, so they are quoted by the server rather than by
  // hand: hand-quoting does not double an embedded `"` and would break on an unusual table name
  // (S-12). The names come from the catalog, not from a caller, but the safe form costs nothing.
  const quoted = await client.query<{ list: string }>(
    `SELECT string_agg(format('geonerva.%I', t), ', ' ORDER BY t) AS list
     FROM unnest($1::text[]) AS t`,
    [tables],
  );
  const list = quoted.rows[0]?.list;
  if (list === undefined || list === '') return;
  await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export interface TestDatabase {
  readonly url: string;
  readonly pool: pg.Pool;
  /** Empties everything except seeded reference data. */
  truncate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Prepares the test database: validates the URL, creates the database if needed, applies every
 * migration from empty, and hands back a pool. Safe to call from many test files; the migration
 * step is protected by the migrator's advisory lock.
 */
export async function setupTestDatabase(env: TestEnv = process.env): Promise<TestDatabase> {
  const url = resolveTestDatabaseUrl(env);
  await ensureTestDatabase(url);

  const migrationClient = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await migrationClient.connect();
  try {
    await migrationClient.query('SET search_path TO public, extensions');
    await migrateUp(migrationClient);
  } finally {
    await migrationClient.end();
  }

  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    options: '-c search_path=public,extensions',
  });

  return {
    url,
    pool,
    truncate: async () => {
      const client = await pool.connect();
      try {
        await truncateAll(client);
      } finally {
        client.release();
      }
    },
    close: async () => {
      await pool.end();
    },
  };
}
