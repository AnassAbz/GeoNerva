/**
 * Loading and checksumming the migration files.
 *
 * Migrations are plain `.sql` files (ADR-021) named `NNNN_snake_case_name.sql`. They are applied
 * in lexicographic order of the numeric prefix, exactly once, and they are **immutable**: an
 * already-applied file whose checksum changes is an error, not a re-run. That is what makes a
 * deployed database and a checked-out repository comparable.
 *
 * Line endings are normalized to LF before hashing. A Windows checkout with `autocrlf` must not
 * produce a different checksum from the Linux CI runner for byte-identical content.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding the `.sql` files: `packages/db/migrations`. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
);

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  /** The numeric prefix, e.g. `0003`. Unique and ordered. */
  readonly version: string;
  /** The descriptive part, e.g. `provider_facts`. */
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  /** SHA-256 of the LF-normalized file contents, lowercase hex. */
  readonly checksum: string;
}

/** Raised when the migration directory itself is malformed. */
export class MigrationLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLoadError';
  }
}

/** SHA-256 of the LF-normalized text, as lowercase hex. */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Loads every migration file, in application order. */
export async function loadMigrations(directory = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    throw new MigrationLoadError(
      `cannot read the migrations directory ${directory}: ${(error as Error).message}`,
    );
  }

  const sqlFiles = entries.filter((entry) => entry.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];
  const seen = new Set<string>();

  for (const fileName of sqlFiles) {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (match === null) {
      throw new MigrationLoadError(
        `migration file "${fileName}" must be named NNNN_snake_case_name.sql`,
      );
    }
    const version = match[1];
    const name = match[2];
    if (version === undefined || name === undefined) {
      throw new MigrationLoadError(`migration file "${fileName}" has an unreadable name`);
    }
    if (seen.has(version)) {
      throw new MigrationLoadError(`duplicate migration version ${version}`);
    }
    seen.add(version);

    const sql = await readFile(path.join(directory, fileName), 'utf8');
    if (sql.trim() === '') {
      throw new MigrationLoadError(`migration ${fileName} is empty`);
    }
    migrations.push({ version, name, fileName, sql, checksum: checksumOf(sql) });
  }

  if (migrations.length === 0) {
    throw new MigrationLoadError(`no migrations found in ${directory}`);
  }
  return migrations;
}
