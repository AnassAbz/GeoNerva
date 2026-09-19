/**
 * Migration and schema integration tests (docs/TESTING.md §4.9).
 *
 * These run against a real PostGIS, because the things they check — RLS, grants, partitioning,
 * generated columns, CHECK constraints — do not exist anywhere else.
 */

import type pg from 'pg';

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshnessPolicySchema, INITIAL_FRESHNESS_POLICIES } from '@geonerva/domain';

import { createDb } from '../client.ts';
import type { DB } from '../generated/database.ts';
import {
  MIN_SUPPORTED_POSTGIS_VERSION,
  REQUIRED_POSTGIS_FUNCTIONS,
  functionsBeyondTarget,
  isAtLeastVersion,
} from '../postgis-requirements.ts';
import { setupTestDatabase, type TestDatabase } from '../testing/test-database.ts';
import { checksumOf, loadMigrations } from './migrations.ts';
import { migrateUp, migrationStatus } from './runner.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

/**
 * Runs `fn` with a raw `pg` client (the migrator takes one rather than a Kysely instance) and
 * always releases it, so a failing assertion cannot exhaust the pool for later tests.
 */
async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await testDb.pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

describe('migrations', () => {
  it('applies from empty and reports every migration as applied', async () => {
    const status = await withClient((client) => migrationStatus(client));
    expect(status.pendingCount).toBe(0);
    expect(status.isDirty).toBe(false);
    expect(status.appliedCount).toBeGreaterThanOrEqual(8);
  });

  it('is a no-op when re-run', async () => {
    const result = await withClient((client) => migrateUp(client));
    expect(result.applied).toStrictEqual([]);
    expect(result.alreadyApplied).toBeGreaterThanOrEqual(8);
  });

  it('records the checksum of the file that was applied', async () => {
    const migrations = await loadMigrations();
    const rows = await sql<{ version: string; checksum: string }>`
      SELECT version, checksum FROM geonerva.schema_migrations ORDER BY version
    `.execute(db);
    for (const migration of migrations) {
      const row = rows.rows.find((candidate) => candidate.version === migration.version);
      expect(row?.checksum).toBe(migration.checksum);
      expect(row?.checksum).toBe(checksumOf(migration.sql));
    }
  });

  it('refuses to run when an applied migration has been edited', async () => {
    await sql`
      UPDATE geonerva.schema_migrations SET checksum = repeat('0', 64) WHERE version = '0002'
    `.execute(db);
    try {
      await withClient(async (client) => {
        await expect(migrateUp(client)).rejects.toThrow(/has changed since it was applied/);
        const status = await migrationStatus(client);
        expect(status.isDirty).toBe(true);
      });
    } finally {
      const migrations = await loadMigrations();
      const original = migrations.find((migration) => migration.version === '0002');
      await sql`
        UPDATE geonerva.schema_migrations SET checksum = ${original?.checksum ?? ''}
        WHERE version = '0002'
      `.execute(db);
    }
  });

  it('reports a database that is ahead of the checkout', async () => {
    await sql`
      INSERT INTO geonerva.schema_migrations (version, name, checksum, execution_ms)
      VALUES ('9999', 'from_the_future', repeat('a', 64), 1)
    `.execute(db);
    try {
      const status = await withClient((client) => migrationStatus(client));
      expect(status.entries.some((entry) => entry.state === 'missing-file')).toBe(true);
      expect(status.isDirty).toBe(true);
    } finally {
      await sql`DELETE FROM geonerva.schema_migrations WHERE version = '9999'`.execute(db);
    }
  });
});

describe('platform', () => {
  it('runs on a PostGIS at least as new as the production target, and reports the version', async () => {
    const result = await sql<{ full: string; version: string; pg: string }>`
      SELECT postgis_full_version() AS full,
             (SELECT extversion FROM pg_extension WHERE extname = 'postgis') AS version,
             current_setting('server_version') AS pg
    `.execute(db);
    const row = result.rows[0];
    expect(row).toBeDefined();
    // Printed so that a local/production version mismatch is visible in CI output (ADR-031).
    process.stdout.write(`\n    PostgreSQL ${row?.pg ?? '?'} / PostGIS ${row?.version ?? '?'}\n`);
    expect(isAtLeastVersion(row?.version ?? '0', MIN_SUPPORTED_POSTGIS_VERSION)).toBe(true);
  });

  it('uses no PostGIS function newer than the production target', () => {
    expect(functionsBeyondTarget()).toStrictEqual([]);
  });

  it('finds every PostGIS function GeoNerva depends on on this server', async () => {
    const names = REQUIRED_POSTGIS_FUNCTIONS.map((requirement) => requirement.name);
    const result = await sql<{ proname: string }>`
      SELECT DISTINCT p.proname
      FROM pg_proc p
      WHERE p.proname = ANY(${sql.val(names)}::text[])
    `.execute(db);
    const found = new Set(result.rows.map((row) => row.proname));
    expect([...names].filter((name) => !found.has(name))).toStrictEqual([]);
  });
});

describe('schema shape', () => {
  it('puts every table in the geonerva schema, never in public', async () => {
    const result = await sql<{ n: string }>`
      SELECT count(*)::text AS n
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND c.relname NOT IN ('spatial_ref_sys')
    `.execute(db);
    expect(Number(result.rows[0]?.n)).toBe(0);
  });

  it('enables row-level security on every table (deny-all for anon/authenticated)', async () => {
    const result = await sql<{ relname: string }>`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'geonerva' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
      ORDER BY c.relname
    `.execute(db);
    // `schema_migrations` is created by the migrator's bootstrap, before 0007 runs.
    const missing = result.rows
      .map((row) => row.relname)
      .filter((name) => name !== 'schema_migrations');
    expect(missing).toStrictEqual([]);
  });

  it('defines no RLS policies, which is what makes RLS deny-all', async () => {
    const result = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM pg_policies WHERE schemaname = 'geonerva'
    `.execute(db);
    expect(Number(result.rows[0]?.n)).toBe(0);
  });

  it('creates both database roles', async () => {
    const result = await sql<{ rolname: string; rolcanlogin: boolean }>`
      SELECT rolname, rolcanlogin FROM pg_roles
      WHERE rolname IN ('geonerva_worker', 'geonerva_web') ORDER BY rolname
    `.execute(db);
    expect(result.rows.map((row) => row.rolname)).toStrictEqual([
      'geonerva_web',
      'geonerva_worker',
    ]);
    expect(result.rows.every((row) => !row.rolcanlogin)).toBe(true);
  });

  it('gives the web role read access to facts but no write access to them', async () => {
    const result = await sql<{ table_name: string; privilege_type: string }>`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'geonerva_web' AND table_schema = 'geonerva'
      ORDER BY table_name, privilege_type
    `.execute(db);

    const byTable = new Map<string, Set<string>>();
    for (const row of result.rows) {
      const set = byTable.get(row.table_name) ?? new Set<string>();
      set.add(row.privilege_type);
      byTable.set(row.table_name, set);
    }

    expect([...(byTable.get('observation_versions') ?? [])]).toStrictEqual(['SELECT']);
    expect([...(byTable.get('fire_detections') ?? [])]).toStrictEqual(['SELECT']);
    expect([...(byTable.get('ingestion_runs') ?? [])]).toStrictEqual(['SELECT']);

    // Exactly two tables the read path must write to do its job.
    expect([...(byTable.get('rate_limit_buckets') ?? [])].sort()).toStrictEqual([
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
    expect([...(byTable.get('geocode_cache') ?? [])].sort()).toStrictEqual([
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);

    // Raw provider payloads are not the web app's business.
    expect(byTable.get('raw_source_records')).toBeUndefined();
  });

  it('gives the worker read/write on the facts it ingests', async () => {
    const result = await sql<{ privilege_type: string }>`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'geonerva_worker' AND table_schema = 'geonerva'
        AND table_name = 'observation_versions'
      ORDER BY privilege_type
    `.execute(db);
    expect(result.rows.map((row) => row.privilege_type).sort()).toStrictEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });

  it('partitions fire_detections by day and creates a usable window', async () => {
    const result = await sql<{ partitioned: boolean; partitions: string }>`
      SELECT (c.relkind = 'p') AS partitioned,
             (SELECT count(*)::text FROM pg_inherits i WHERE i.inhparent = c.oid) AS partitions
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'geonerva' AND c.relname = 'fire_detections'
    `.execute(db);
    expect(result.rows[0]?.partitioned).toBe(true);
    expect(Number(result.rows[0]?.partitions)).toBeGreaterThanOrEqual(8);
  });

  it('indexes geography columns with GiST', async () => {
    const result = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'geonerva' AND indexdef LIKE '%USING gist%'
      ORDER BY indexname
    `.execute(db);
    const names = result.rows.map((row) => row.indexname);
    expect(names).toContain('observation_versions_centroid_gix');
    expect(names).toContain('observation_geometries_geog_gix');
    expect(names).toContain('observation_geometries_geom_gix');
    expect(names).toContain('fire_cluster_versions_hull_gix');
  });

  it('creates the BRIN indexes on ingestion time', async () => {
    const result = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'geonerva' AND indexdef LIKE '%USING brin%'
    `.execute(db);
    expect(result.rows.map((row) => row.indexname)).toContain(
      'observation_versions_ingested_brin_idx',
    );
  });

  it('enforces the replay invariant I13 in the database itself', async () => {
    await expect(
      sql`
        INSERT INTO geonerva.source_records (source_id, hazard_type, primary_key, first_ingested_at)
        VALUES ('usgs', 'EARTHQUAKE', 'check-i13', now())
      `.execute(db),
    ).resolves.toBeDefined();

    const recordId = await sql<{ id: string }>`
      SELECT id::text AS id FROM geonerva.source_records WHERE primary_key = 'check-i13'
    `.execute(db);
    const id = recordId.rows[0]?.id ?? '0';

    await expect(
      sql`
        INSERT INTO geonerva.observation_versions
          (source_record_id, version_seq, hazard_type, ingested_at, observed_at, lifecycle_status,
           centroid, geometry_kind, attributes, content_sha256)
        VALUES (${id}::bigint, 1, 'EARTHQUAKE', now(), now() + interval '1 hour', 'ACTIVE',
                ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, 'EPICENTER', '{}'::jsonb,
                decode(repeat('00', 32), 'hex'))
      `.execute(db),
    ).rejects.toThrow();

    await sql`DELETE FROM geonerva.source_records WHERE primary_key = 'check-i13'`.execute(db);
  });

  it('refuses to persist a raw-coordinate location key (ADR-015)', async () => {
    await expect(
      sql`
        INSERT INTO geonerva.analysis_locations (key, label, lat, lon, geog, timezone)
        VALUES ('c:31.63,-8.00', 'somewhere', 31.63, -8.00,
                ST_SetSRID(ST_MakePoint(-8, 31.63), 4326)::geography, 'UTC')
      `.execute(db),
    ).rejects.toThrow(/analysis_locations_named_place_only/);
  });
});

describe('seeds', () => {
  it('seeds the five P0 sources, with ECCC disabled for P1', async () => {
    const result = await sql<{ id: string; enabled: boolean; licence: string }>`
      SELECT id, enabled, licence FROM geonerva.sources ORDER BY id
    `.execute(db);
    expect(result.rows.map((row) => row.id)).toStrictEqual([
      'eccc',
      'emsc',
      'firms',
      'gdacs',
      'usgs',
    ]);
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    expect(byId.get('eccc')?.enabled).toBe(false);
    expect(byId.get('usgs')?.enabled).toBe(true);
    // GDACS licence takes the stricter reading of its inconsistent terms (DATA_SOURCES §2.7).
    expect(byId.get('gdacs')?.licence).toContain('CC BY 4.0');
  });

  it('seeds attribution and a disclaimer for every source', async () => {
    const result = await sql<{ id: string; attribution_text: string; coverage_note: string }>`
      SELECT id, attribution_text, coverage_note FROM geonerva.sources ORDER BY id
    `.execute(db);
    for (const row of result.rows) {
      expect(row.attribution_text.length).toBeGreaterThan(10);
      expect(row.coverage_note.length).toBeGreaterThan(10);
    }
  });

  it('seeds policies that validate against the domain schema and match the documented values', async () => {
    const result = await sql<{ id: string; policy: { freshness: unknown } }>`
      SELECT id, policy FROM geonerva.sources ORDER BY id
    `.execute(db);

    const expected: Record<string, keyof typeof INITIAL_FRESHNESS_POLICIES> = {
      usgs: 'usgs:comcat',
      emsc: 'emsc:rts',
      gdacs: 'gdacs:*',
      firms: 'firms:VIIRS_*',
      eccc: 'eccc:weather-alerts',
    };

    for (const row of result.rows) {
      const parsed = freshnessPolicySchema.parse(row.policy.freshness);
      const key = expected[row.id];
      expect(key, `no expected policy for ${row.id}`).toBeDefined();
      if (key !== undefined) {
        expect(parsed).toStrictEqual(INITIAL_FRESHNESS_POLICIES[key]);
      }
    }
  });

  it('seeds only the two VIIRS sensors FIRMS should ingest (ADR-009)', async () => {
    const result = await sql<{ code: string; platform: string; resolution_m: number }>`
      SELECT code, platform, resolution_m FROM geonerva.source_products
      WHERE source_id = 'firms' ORDER BY code
    `.execute(db);
    expect(result.rows.map((row) => row.code)).toStrictEqual([
      'VIIRS_NOAA20_NRT',
      'VIIRS_NOAA21_NRT',
    ]);
    expect(result.rows.every((row) => row.resolution_m === 375)).toBe(true);
  });

  it('seeds one GDACS product per event type', async () => {
    const result = await sql<{ code: string }>`
      SELECT code FROM geonerva.source_products WHERE source_id = 'gdacs' ORDER BY code
    `.execute(db);
    expect(result.rows.map((row) => row.code)).toStrictEqual(['DR', 'EQ', 'FL', 'TC', 'VO', 'WF']);
  });
});
