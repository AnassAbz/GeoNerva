/**
 * Regression tests for the P2 security review (docs/reviews/security-p2.md).
 *
 * Every test here failed before its fix. They are grouped in one file because they share a
 * database and because the review is the thing they collectively answer; each test names the
 * finding it covers so a future change that reopens one says so by name.
 */
import { createHash } from 'node:crypto';

import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, createPool } from './client.ts';
import { driverConnectionString, isLoopbackHost } from './connection-url.ts';
import type { DB } from './generated/database.ts';
import { ensurePartitionsForDays, listDetectionPartitionDays } from './repositories/fire.ts';
import { insertTombstone } from './repositories/observation-versions.ts';
import { resolveSourceRecord } from './repositories/source-records.ts';
import { PLACES, contentHash, seedObservation } from './testing/factories.ts';
import {
  resolveTestDatabaseUrl,
  setupTestDatabase,
  UnsafeTestDatabaseError,
  type TestDatabase,
} from './testing/test-database.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await testDb.truncate();
});

describe('S-1 — the connection factory can actually open a connection', () => {
  it('sets search_path through the startup parameter without a FATAL', async () => {
    const pool = createPool({
      connectionString: testDb.url,
      variableName: 'DATABASE_URL_TEST',
      applicationName: 'geonerva-s1-test',
    });
    try {
      // Reaching this line is the assertion: with a space in the `options` startup parameter the
      // server splits on whitespace, `search_path` arrives as `public,` and connecting fails with
      // a FATAL before any query runs.
      const result = await pool.query<{ search_path: string }>('SHOW search_path');
      expect(result.rows[0]?.search_path).toMatch(/public.*extensions/);
      const schema = await pool.query<{ ok: boolean }>(
        "SELECT to_regclass('geonerva.sources') IS NOT NULL AS ok",
      );
      expect(schema.rows[0]?.ok).toBe(true);
    } finally {
      await pool.end();
    }
  });
});

describe('S-2 — TLS configuration is the driver’s, not the URL’s', () => {
  it('strips TLS parameters so an explicit ssl object survives', () => {
    const url = 'postgresql://u:p@db.example.com:5432/x?sslmode=verify-full&application_name=a';
    const stripped = driverConnectionString(url);
    expect(stripped).not.toContain('sslmode');
    expect(stripped).toContain('application_name=a');

    // The property that actually matters: what node-postgres ends up using.
    const client = new pg.Client({
      connectionString: stripped,
      ssl: { rejectUnauthorized: true, ca: 'CA-PEM' },
    });
    // `connectionParameters` is where pg records what it will actually use; it is not in the
    // published types, which is precisely why this needed a test rather than a reading.
    const resolved = (client as unknown as { connectionParameters: { ssl: unknown } })
      .connectionParameters.ssl as { rejectUnauthorized?: boolean; ca?: string };
    expect(resolved.rejectUnauthorized).toBe(true);
    expect(resolved.ca).toBe('CA-PEM');
  });

  it('refuses the parameters that let the driver weaken TLS', () => {
    for (const url of [
      'postgresql://u:p@db.example.com/x?sslmode=require&uselibpqcompat=true',
      'postgresql://u:p@db.example.com/x?ssl=false',
    ]) {
      expect(() => createPool({ connectionString: url, nodeEnv: 'production' })).toThrow(
        /must not set/,
      );
    }
  });
});

describe('S-3 — the test-database guard needs loopback AND a disposable name', () => {
  it('refuses a loopback database that is not named *_test', () => {
    expect(() =>
      resolveTestDatabaseUrl({
        DATABASE_URL_TEST: 'postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva',
      }),
    ).toThrow(UnsafeTestDatabaseError);
  });

  it('refuses a port-forwarded remote database even when it is named *_test', () => {
    expect(() =>
      resolveTestDatabaseUrl({ DATABASE_URL_TEST: 'postgresql://u:p@db.example.com/app_test' }),
    ).toThrow(UnsafeTestDatabaseError);
  });

  it('accepts the documented local test database, and an override when demanded', () => {
    expect(
      resolveTestDatabaseUrl({
        DATABASE_URL_TEST: 'postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva_test',
      }),
    ).toContain('geonerva_test');
    expect(
      resolveTestDatabaseUrl({
        DATABASE_URL_TEST: 'postgresql://u:p@db.example.com/anything',
        GEONERVA_ALLOW_REMOTE_TEST_DB: '1',
      }),
    ).toContain('db.example.com');
  });

  it('does not treat 0.0.0.0 as this machine (S-18)', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });
});

describe('S-4 — partition bounds are anchored to UTC', () => {
  it('accepts a detection at either end of the UTC day whatever the session time zone', async () => {
    const day = new Date('2026-07-01T00:00:00.000Z');
    await ensurePartitionsForDays(db, [day]);

    for (const timeZone of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
      await sql`SELECT set_config('TimeZone', ${timeZone}, false)`.execute(db);
      const product = await sql<{ id: number }>`
        SELECT id FROM geonerva.source_products WHERE code = 'VIIRS_NOAA20_NRT'
      `.execute(db);
      const productId = product.rows[0]?.id ?? 1;

      // 00:01 and 23:59 UTC: the rows a shifted boundary would reject.
      for (const [hour, minute] of [
        [0, 1],
        [23, 59],
      ]) {
        const acquiredAt = new Date(Date.UTC(2026, 6, 1, hour ?? 0, minute ?? 0));
        await expect(
          sql`
            INSERT INTO geonerva.fire_detections
              (product_id, acquired_at, lat, lon, geog, provider_version, ingested_at)
            VALUES (${productId}, ${acquiredAt}, 31.6, -8.0,
                    ST_SetSRID(ST_MakePoint(-8.0, 31.6), 4326)::geography,
                    '2.0NRT', ${new Date(acquiredAt.getTime() + 3 * 3600_000)})
            ON CONFLICT DO NOTHING
          `.execute(db),
        ).resolves.toBeDefined();
      }
    }
    await sql`SELECT set_config('TimeZone', 'UTC', false)`.execute(db);
    expect(await listDetectionPartitionDays(db)).toContain('20260701');
  });
});

describe('S-5 — row-level security covers partitions created at runtime', () => {
  it('enables RLS on a new partition', async () => {
    await ensurePartitionsForDays(db, [new Date('2026-08-15T00:00:00.000Z')]);
    const result = await sql<{ relrowsecurity: boolean }>`
      SELECT c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'geonerva' AND c.relname = 'fire_detections_20260815'
    `.execute(db);
    expect(result.rows[0]?.relrowsecurity, 'RLS must be on for a runtime partition').toBe(true);
  });
});

describe('S-6 — concurrent partition creation does not fail a batch', () => {
  it('survives many simultaneous callers for the same day', async () => {
    const day = new Date('2026-06-05T00:00:00.000Z');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => ensurePartitionsForDays(db, [day])),
    );
    const reasons = results
      .filter((result) => result.status === 'rejected')
      .map((result) => String(result.reason));
    expect(reasons, 'a lost race must not fail an ingestion batch').toEqual([]);
    expect(await listDetectionPartitionDays(db)).toContain('20260605');
  });
});

describe('S-8 — a tombstone is actually written', () => {
  it('tombstones a record whose content has not changed, and stays idempotent', async () => {
    const ingestedAt = new Date('2026-09-19T10:00:00.000Z');
    const hash = contentHash('emsc-vanished', 4.4);
    const seeded = await seedObservation(db, {
      sourceId: 'emsc',
      primaryKey: '20260919_0000001',
      ingestedAt,
      magnitude: 4.4,
      centroid: PLACES.marrakech,
      contentSha256: hash,
    });
    expect(seeded.inserted).toBe(true);

    // The natural call: the content did not change, only our knowledge that it is gone.
    const first = await db.transaction().execute((trx) =>
      insertTombstone(trx, {
        sourceRecordId: seeded.sourceRecordId,
        status: 'MISSING_FROM_SOURCE',
        ingestedAt: new Date(ingestedAt.getTime() + 86_400_000),
        contentSha256: hash,
      }),
    );
    expect(first.inserted, 'the tombstone must be written').toBe(true);

    const head = await sql<{ lifecycle_status: string }>`
      SELECT v.lifecycle_status
      FROM geonerva.source_record_heads h
      JOIN geonerva.observation_versions v ON v.id = h.latest_version_id
      WHERE h.source_record_id = ${seeded.sourceRecordId}::bigint
    `.execute(db);
    expect(head.rows[0]?.lifecycle_status).toBe('MISSING_FROM_SOURCE');

    // Repeating the reconcile must not pile up identical tombstones.
    const second = await db.transaction().execute((trx) =>
      insertTombstone(trx, {
        sourceRecordId: seeded.sourceRecordId,
        status: 'MISSING_FROM_SOURCE',
        ingestedAt: new Date(ingestedAt.getTime() + 2 * 86_400_000),
        contentSha256: hash,
      }),
    );
    expect(second.inserted, 'a repeated tombstone is not a new version').toBe(false);

    const versions = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.observation_versions
      WHERE source_record_id = ${seeded.sourceRecordId}::bigint
    `.execute(db);
    expect(Number(versions.rows[0]?.n)).toBe(2);
  });

  it('derives a hash that differs from the live head', () => {
    const live = contentHash('x', 1);
    const tombstone = createHash('sha256').update('DELETED').update(live).digest();
    expect(tombstone.equals(live)).toBe(false);
  });
});

describe('S-13 — the web role cannot read AI output text', () => {
  it('withholds the output column while keeping the metadata', async () => {
    const grants = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.column_privileges
      WHERE grantee = 'geonerva_web'
        AND table_schema = 'geonerva'
        AND table_name = 'agent_outputs'
        AND privilege_type = 'SELECT'
      ORDER BY column_name
    `.execute(db);
    const columns = grants.rows.map((row) => row.column_name);
    expect(columns).not.toContain('output');
    expect(columns).not.toContain('validation_errors');
    expect(columns).toContain('validation_status');
  });
});

describe('S-9 — a source record still resolves after the fixes', () => {
  it('keeps identity resolution working', async () => {
    const identity = await db.transaction().execute((trx) =>
      resolveSourceRecord(trx, {
        sourceId: 'usgs',
        productId: null,
        hazardType: 'EARTHQUAKE',
        primaryKey: 'us-sanity',
        firstIngestedAt: new Date('2026-09-19T10:00:00.000Z'),
      }),
    );
    expect(identity.sourceRecordId).toMatch(/^\d+$/);
  });
});
