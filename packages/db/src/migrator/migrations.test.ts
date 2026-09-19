import { describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR, checksumOf, loadMigrations } from './migrations.ts';
import { parseArgs, resolveMigrationUrl } from './cli.ts';

describe('migration files', () => {
  it('loads every migration in order', async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(8);
    const versions = migrations.map((migration) => migration.version);
    expect(versions).toStrictEqual([...versions].sort());
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions[0]).toBe('0001');
  });

  it('names the first migrations as the schema expects', async () => {
    const migrations = await loadMigrations();
    expect(migrations[0]?.name).toBe('schema_and_extensions');
    expect(migrations.map((m) => m.name)).toContain('rls_and_roles');
    expect(migrations.map((m) => m.name)).toContain('seed_sources');
  });

  it('points at packages/db/migrations', () => {
    expect(MIGRATIONS_DIR.replace(/\\/g, '/')).toMatch(/packages\/db\/migrations$/);
  });

  it('rejects a directory with no migrations', async () => {
    await expect(loadMigrations(`${MIGRATIONS_DIR}/does-not-exist`)).rejects.toThrow();
  });
});

describe('checksums', () => {
  it('is a lowercase sha-256 hex digest', () => {
    expect(checksumOf('SELECT 1;')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across line endings, so Windows and CI agree', () => {
    expect(checksumOf('a\r\nb\r\n')).toBe(checksumOf('a\nb\n'));
  });

  it('changes when the SQL changes', () => {
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });

  it('changes when only whitespace changes, because applied files are immutable', () => {
    // A reformat is still an edit to an applied migration, and the migrator must say so rather
    // than silently accepting a file that no longer matches what ran.
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT  1;'));
  });
});

describe('cli argument parsing', () => {
  it('defaults to `up`', () => {
    expect(parseArgs([])).toStrictEqual({ command: 'up', url: undefined });
  });

  it('accepts a command and both --url spellings', () => {
    expect(parseArgs(['status'])).toStrictEqual({ command: 'status', url: undefined });
    expect(parseArgs(['up', '--url', 'postgres://x/y']).url).toBe('postgres://x/y');
    expect(parseArgs(['--url=postgres://x/y']).url).toBe('postgres://x/y');
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown argument/);
  });
});

describe('cli url resolution', () => {
  it('prefers the explicit url, then the migration url, then the worker url', () => {
    expect(resolveMigrationUrl({}, 'postgres://explicit/db')).toBe('postgres://explicit/db');
    expect(
      resolveMigrationUrl({
        DATABASE_URL_MIGRATE: 'postgres://migrate/db',
        DATABASE_URL_WORKER: 'postgres://worker/db',
      }),
    ).toBe('postgres://migrate/db');
    expect(resolveMigrationUrl({ DATABASE_URL_WORKER: 'postgres://worker/db' })).toBe(
      'postgres://worker/db',
    );
  });

  it('never uses the web URL: migrations are a worker-side operation', () => {
    expect(() => resolveMigrationUrl({ DATABASE_URL: 'postgres://web/db' })).toThrow(
      /no database URL/,
    );
  });
});
