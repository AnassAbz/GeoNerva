/**
 * Migration 0016 classifies raw rows that existed before it (ADR-038).
 *
 * The new `payload_captured` column cannot be inferred from `payload_pruned` alone, so the
 * migration reads what can be established: a row still holding a body was captured; a pruned row
 * was captured if a *live* run cited it, and otherwise is taken as never captured. This test builds
 * a database at 0015, writes one row of each kind the way the schema allowed then, migrates it
 * forward and reads the answer.
 */

import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR } from './migrations.ts';
import { migrateUp } from './runner.ts';

const ADMIN_URL = 'postgresql://geonerva:geonerva@127.0.0.1:54320/postgres';
const DATABASE = 'gn_raw_payload_migration_test';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 300_000);

function migrationsUpTo(lastVersion: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'gn-migrations-'));
  cleanups.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    if (file.slice(0, 4) <= lastVersion) cpSync(join(MIGRATIONS_DIR, file), join(directory, file));
  }
  return directory;
}

async function scratchDatabase(): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
  } finally {
    await admin.end();
  }
  cleanups.push(async () => {
    const cleanupAdmin = new pg.Client({ connectionString: ADMIN_URL });
    await cleanupAdmin.connect();
    try {
      await cleanupAdmin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    } finally {
      await cleanupAdmin.end();
    }
  });
  return `postgresql://geonerva:geonerva@127.0.0.1:54320/${DATABASE}`;
}

describe('migration 0016', () => {
  it('classifies existing raw rows as captured or never captured', async () => {
    const client = new pg.Client({ connectionString: await scratchDatabase() });
    await client.connect();
    cleanups.push(async () => {
      await client.end();
    });
    await client.query('SET search_path TO public, extensions');
    await migrateUp(client, { directory: migrationsUpTo('0015') });

    // Three raw rows as 0015 allowed them, and the versions and runs that cite them.
    await client.query(`
      INSERT INTO geonerva.ingestion_runs (id, source_id, trigger, started_at, committed_at, status)
      VALUES ('00000000-0000-0000-0000-00000000000a', 'usgs', 'SCHEDULE', now(), now(), 'SUCCEEDED'),
             ('00000000-0000-0000-0000-00000000000b', 'usgs', 'BACKFILL', now(), now(), 'SUCCEEDED');
      INSERT INTO geonerva.raw_source_records (id, source_id, payload_sha256, payload, payload_pruned)
      VALUES (1, 'usgs', decode(repeat('01', 32), 'hex'), '{"held": true}', false),
             (2, 'usgs', decode(repeat('02', 32), 'hex'), NULL, true),
             (3, 'usgs', decode(repeat('03', 32), 'hex'), NULL, true);
      INSERT INTO geonerva.source_records (id, source_id, hazard_type, primary_key, first_ingested_at)
      VALUES (1, 'usgs', 'EARTHQUAKE', 'k1', now()), (2, 'usgs', 'EARTHQUAKE', 'k2', now()),
             (3, 'usgs', 'EARTHQUAKE', 'k3', now());
    `);
    for (const [record, raw, run] of [
      [1, 1, 'a'],
      [2, 2, 'a'],
      [3, 3, 'b'],
    ] as const) {
      await client.query(
        `INSERT INTO geonerva.observation_versions
           (source_record_id, version_seq, hazard_type, ingested_at, observed_at, lifecycle_status,
            centroid, geometry_kind, attributes, content_sha256, raw_record_id, ingestion_run_id)
         VALUES ($1, 1, 'EARTHQUAKE', now(), now(), 'ACTIVE',
                 ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, 'EPICENTER', '{}'::jsonb,
                 decode(repeat('0${String(record)}', 32), 'hex'), $2,
                 '00000000-0000-0000-0000-00000000000${run}')`,
        [record, raw],
      );
    }

    await migrateUp(client);

    const rows = await client.query<{ id: string; payload_captured: boolean }>(
      'SELECT id::text AS id, payload_captured FROM geonerva.raw_source_records ORDER BY id',
    );
    expect(rows.rows).toStrictEqual([
      // Still holds its body.
      { id: '1', payload_captured: true },
      // Pruned, cited by a live run: a body was held and retention removed it.
      { id: '2', payload_captured: true },
      // Pruned and cited only by a backfill: never held (ADR-033).
      { id: '3', payload_captured: false },
    ]);

    // The web role reads the metadata columns and never the body (the grant, on this database).
    const grants = await client.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.role_column_grants
      WHERE grantee = 'geonerva_web' AND table_schema = 'geonerva'
        AND table_name = 'raw_source_records' AND privilege_type = 'SELECT'
      ORDER BY column_name`);
    expect(grants.rows.map((row) => row.column_name)).toStrictEqual([
      'first_seen_at',
      'id',
      'payload_captured',
      'payload_pruned',
      'payload_sha256',
      'source_id',
    ]);
    await client.query('BEGIN; SET LOCAL ROLE geonerva_web');
    await client.query(
      'SELECT id, payload_sha256, payload_captured FROM geonerva.raw_source_records',
    );
    await expect(client.query('SELECT payload FROM geonerva.raw_source_records')).rejects.toThrow(
      /permission denied/u,
    );
    await client.query('ROLLBACK');

    // A body can only sit in a row that captured one.
    await expect(
      client.query("UPDATE geonerva.raw_source_records SET payload = '{}' WHERE id = 3"),
    ).rejects.toThrow(/raw_source_records_payload_implies_captured/u);
  });
});
