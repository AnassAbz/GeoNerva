/**
 * The migrator: transactional, checksummed, advisory-lock protected, `up` only (ADR-021).
 *
 * Design choices and why:
 *
 *  - **One transaction per migration.** A file either applies completely or not at all, and the
 *    bookkeeping row is written inside the same transaction, so "applied" and "actually there"
 *    cannot disagree. PostgreSQL supports transactional DDL, so this costs nothing.
 *  - **Advisory lock.** Two workers starting at once must not race. The lock is taken on the
 *    session before anything is read, and released at the end.
 *  - **Checksums are immutable.** Editing an applied migration is a mistake that would make two
 *    databases silently different; it is reported as an error naming the file, never re-applied.
 *  - **No `down`.** A down migration is a second, untested code path that runs only in a crisis.
 *    Corrections are new `up` migrations, which is the only form that has actually been executed
 *    before it matters.
 *  - **`search_path` is set per migration**, so the files can name PostGIS types unqualified
 *    while every GeoNerva object stays schema-qualified (ADR-008).
 */

import type pg from 'pg';

import { SEARCH_PATH } from '../schema.ts';
import { loadMigrations, type MigrationFile } from './migrations.ts';

/**
 * Advisory-lock key for schema migrations. An arbitrary but fixed 64-bit constant; anything else
 * in the system that takes an advisory lock must not reuse it.
 */
export const MIGRATION_LOCK_KEY = 4_705_312_026_000_001n;

/** Bookkeeping table. Created before anything else, idempotently. */
const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS geonerva;

CREATE TABLE IF NOT EXISTS geonerva.schema_migrations (
  version       text PRIMARY KEY,
  name          text NOT NULL,
  checksum      text NOT NULL,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  execution_ms  integer NOT NULL,
  applied_by    text NOT NULL DEFAULT current_user
);

COMMENT ON TABLE geonerva.schema_migrations IS
  'Applied migrations. A changed checksum is an error: applied migrations are immutable.';
`;

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly executionMs: number;
}

export interface MigrationStatusEntry {
  readonly version: string;
  readonly name: string;
  readonly state: 'applied' | 'pending' | 'checksum-mismatch' | 'missing-file';
  readonly appliedAt: Date | null;
  readonly executionMs: number | null;
}

export interface MigrationStatus {
  readonly entries: readonly MigrationStatusEntry[];
  readonly pendingCount: number;
  readonly appliedCount: number;
  readonly isDirty: boolean;
}

export interface MigrateResult {
  readonly applied: readonly { version: string; name: string; executionMs: number }[];
  readonly alreadyApplied: number;
}

/** Raised when the database and the repository disagree about what has been applied. */
export class MigrationIntegrityError extends Error {
  readonly version: string;

  constructor(version: string, message: string) {
    super(message);
    this.name = 'MigrationIntegrityError';
    this.version = version;
  }
}

/** Raised when a migration fails to execute. Carries the file, never the connection string. */
export class MigrationFailedError extends Error {
  readonly version: string;
  readonly fileName: string;

  constructor(migration: MigrationFile, cause: unknown) {
    super(`migration ${migration.fileName} failed: ${(cause as Error).message}`);
    this.name = 'MigrationFailedError';
    this.version = migration.version;
    this.fileName = migration.fileName;
    this.cause = cause;
  }
}

async function readApplied(client: pg.ClientBase): Promise<Map<string, AppliedMigration>> {
  const result = await client.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
    execution_ms: number;
  }>('SELECT version, name, checksum, applied_at, execution_ms FROM geonerva.schema_migrations');

  return new Map(
    result.rows.map((row) => [
      row.version,
      {
        version: row.version,
        name: row.name,
        checksum: row.checksum,
        appliedAt: row.applied_at,
        executionMs: row.execution_ms,
      },
    ]),
  );
}

/**
 * Applies every pending migration, in order.
 *
 * Re-running with nothing pending is a no-op: it reports `applied: []`, writes nothing, and
 * leaves the bookkeeping table untouched. That property is asserted by an integration test,
 * because "migrate on every boot" is how the worker is meant to start.
 */
export async function migrateUp(
  client: pg.ClientBase,
  options: { directory?: string } = {},
): Promise<MigrateResult> {
  const migrations = await loadMigrations(options.directory);

  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
  try {
    await client.query(BOOTSTRAP_SQL);
    const applied = await readApplied(client);

    for (const migration of migrations) {
      const previous = applied.get(migration.version);
      if (previous !== undefined) {
        if (previous.checksum !== migration.checksum) {
          throw new MigrationIntegrityError(
            migration.version,
            `migration ${migration.fileName} has changed since it was applied ` +
              `(applied ${previous.checksum.slice(0, 12)}, file ${migration.checksum.slice(0, 12)}). ` +
              'Applied migrations are immutable: add a new migration instead.',
          );
        }
      }
    }

    const results: { version: string; name: string; executionMs: number }[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;

      const startedAt = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL search_path TO ${SEARCH_PATH}`);
        await client.query(migration.sql);
        const executionMs = Date.now() - startedAt;
        await client.query(
          `INSERT INTO geonerva.schema_migrations (version, name, checksum, execution_ms)
           VALUES ($1, $2, $3, $4)`,
          [migration.version, migration.name, migration.checksum, executionMs],
        );
        await client.query('COMMIT');
        results.push({ version: migration.version, name: migration.name, executionMs });
      } catch (error) {
        await client.query('ROLLBACK');
        throw new MigrationFailedError(migration, error);
      }
    }

    return { applied: results, alreadyApplied: applied.size };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
  }
}

/** Reports what is applied, what is pending, and anything that disagrees. Writes nothing. */
export async function migrationStatus(
  client: pg.ClientBase,
  options: { directory?: string } = {},
): Promise<MigrationStatus> {
  const migrations = await loadMigrations(options.directory);

  const tableExists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'geonerva' AND c.relname = 'schema_migrations'
     ) AS exists`,
  );

  const applied = tableExists.rows[0]?.exists === true ? await readApplied(client) : new Map();
  const entries: MigrationStatusEntry[] = [];

  for (const migration of migrations) {
    const previous = applied.get(migration.version);
    if (previous === undefined) {
      entries.push({
        version: migration.version,
        name: migration.name,
        state: 'pending',
        appliedAt: null,
        executionMs: null,
      });
      continue;
    }
    entries.push({
      version: migration.version,
      name: migration.name,
      state: previous.checksum === migration.checksum ? 'applied' : 'checksum-mismatch',
      appliedAt: previous.appliedAt,
      executionMs: previous.executionMs,
    });
  }

  // A version recorded in the database with no file in the repository means the checkout is older
  // than the database, which is just as dangerous as a changed checksum.
  const knownVersions = new Set(migrations.map((migration) => migration.version));
  for (const [version, previous] of applied) {
    if (knownVersions.has(version)) continue;
    entries.push({
      version,
      name: previous.name,
      state: 'missing-file',
      appliedAt: previous.appliedAt,
      executionMs: previous.executionMs,
    });
  }

  entries.sort((a, b) => a.version.localeCompare(b.version));
  return {
    entries,
    pendingCount: entries.filter((entry) => entry.state === 'pending').length,
    appliedCount: entries.filter((entry) => entry.state === 'applied').length,
    isDirty: entries.some(
      (entry) => entry.state === 'checksum-mismatch' || entry.state === 'missing-file',
    ),
  };
}
