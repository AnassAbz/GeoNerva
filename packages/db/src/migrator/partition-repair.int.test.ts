/**
 * Migration 0010's repair block, against the state it exists for (re-verification V-1).
 *
 * The other partition tests cover *creation* under a non-UTC session — the half that was already
 * fixed — which is why the suite stayed green while the repair itself could not complete. This
 * test builds the actual broken state: a database migrated to 0009 while the server's TimeZone is
 * not UTC, carrying detections in partitions whose bounds are local midnight. Then it applies
 * 0010 and demands that every row survive, in the partition named for its own UTC day.
 *
 * Both zones are exercised on purpose. West of UTC a row spills forward into the next day and
 * east of UTC backward into the previous one, so a repair that walks partitions in one direction
 * passes in one zone and fails in the other.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { migrateUp } from './runner.ts';
import { MIGRATIONS_DIR } from './migrations.ts';

const ADMIN_URL = 'postgresql://geonerva:geonerva@127.0.0.1:54320/postgres';
/**
 * Cleanups, each with a name — which is how the 120 s hook timeout in this file was diagnosed.
 *
 * The failure message said only "Hook timed out", so the first step was to make each cleanup
 * report its own duration. The next full run printed
 * `slow cleanup: drop the database gn_repair_west_test took 69029 ms` against a measured ~330 ms
 * while the server was idle, which named the statement.
 *
 * ### What the drop is actually waiting for
 *
 * `DROP DATABASE` issues an **immediate, forced checkpoint and waits for it**. Under a write-heavy
 * suite that flush is the entire cost. Measured on this database, with several hundred thousand
 * rows of dirty buffers outstanding:
 *
 * | Sequence | Cost |
 * |---|---|
 * | dirty buffers, then `DROP DATABASE … WITH (FORCE)` | **14,641 ms** |
 * | dirty buffers, `CHECKPOINT` (654 ms), then the same drop | **343 ms** |
 *
 * So the cleanup now checkpoints first. The flush still happens — it is real work and cannot be
 * avoided — but it happens in a statement that is not also holding the drop, and the total falls
 * by more than an order of magnitude. `SLOW_CLEANUP_MS` stays, so a future regression reports
 * itself rather than presenting as an unexplained timeout.
 */
interface NamedCleanup {
  readonly what: string;
  run(): Promise<void> | void;
}

const cleanups: NamedCleanup[] = [];

/** Long enough that a healthy run is silent, short enough to catch a step heading for 120 s. */
const SLOW_CLEANUP_MS = 5_000;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    const started = Date.now();
    await cleanup.run();
    const elapsed = Date.now() - started;
    if (elapsed > SLOW_CLEANUP_MS) {
      process.stdout.write(`
    slow cleanup: ${cleanup.what} took ${String(elapsed)} ms
`);
    }
  }
});

/** A migrations directory holding only the files up to and including `lastVersion`. */
function migrationsUpTo(lastVersion: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'gn-migrations-'));
  cleanups.push({
    what: 'remove the temporary migrations directory',
    run: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  });
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    if (file.slice(0, 4) <= lastVersion) cpSync(join(MIGRATIONS_DIR, file), join(directory, file));
  }
  return directory;
}

async function createDatabaseInZone(name: string, timeZone: string): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    // The per-database form: a migration inherits it silently, which is what made this bug
    // invisible in development.
    await admin.query(`ALTER DATABASE ${name} SET TimeZone TO '${timeZone}'`);
  } finally {
    await admin.end();
  }
  cleanups.push({
    what: `drop the database ${name}`,
    run: async () => {
      const cleanupAdmin = new pg.Client({ connectionString: ADMIN_URL });
      await cleanupAdmin.connect();
      try {
        /*
         * Before the drop, not after, and not instead of it. See the header: the drop waits on a
         * forced checkpoint, and paying that cost in its own statement is what turns a 69-second
         * cleanup back into a fast one.
         */
        await cleanupAdmin.query('CHECKPOINT');
        await cleanupAdmin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanupAdmin.end();
      }
    },
  });
  return `postgresql://geonerva:geonerva@127.0.0.1:54320/${name}`;
}

describe.each([
  ['America/New_York', 'gn_repair_west_test'],
  ['Europe/Berlin', 'gn_repair_east_test'],
])('migration 0010 repairs partitions created under %s', (timeZone, databaseName) => {
  it('preserves every detection and routes it to its own UTC day', async () => {
    const url = await createDatabaseInZone(databaseName, timeZone);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    cleanups.push({
      what: `close the connection to ${databaseName}`,
      run: async () => {
        await client.end();
      },
    });

    // Deliberately no TimeZone pin: this reproduces a database migrated before that existed.
    await migrateUp(client, { directory: migrationsUpTo('0009') });

    const day = '2026-09-20';
    await client.query(`SELECT geonerva.ensure_fire_detection_partitions('${day}'::date, 2)`);
    const product = await client.query<{ id: number }>(
      "SELECT id FROM geonerva.source_products WHERE code = 'VIIRS_NOAA20_NRT'",
    );
    const productId = product.rows[0]?.id;
    expect(productId).toBeDefined();

    // One detection per UTC hour: some fall outside the local-midnight bounds of the partition
    // named for their day, which is exactly the spill the repair has to re-route.
    await client.query(
      `INSERT INTO geonerva.fire_detections
         (product_id, acquired_at, lat, lon, geog, provider_version, ingested_at)
       SELECT $1,
              '${day}T00:00:00Z'::timestamptz + make_interval(hours => h),
              10.0 + h, 20.0 + h,
              ST_SetSRID(ST_MakePoint(20.0 + h, 10.0 + h), 4326)::geography,
              '2.0NRT',
              '${day}T00:00:00Z'::timestamptz + make_interval(hours => h + 3)
       FROM generate_series(0, 23) AS h`,
      [productId],
    );

    const before = await client.query<{ n: string; digest: string }>(
      `SELECT count(*)::text AS n,
              md5(string_agg(acquired_at::text || ':' || lat::text, ',' ORDER BY acquired_at)) AS digest
       FROM geonerva.fire_detections`,
    );
    expect(Number(before.rows[0]?.n)).toBe(24);

    // The repair. Before the two-phase rewrite this raised 428C9, then 23514.
    await migrateUp(client, {});

    const after = await client.query<{ n: string; digest: string }>(
      `SELECT count(*)::text AS n,
              md5(string_agg(acquired_at::text || ':' || lat::text, ',' ORDER BY acquired_at)) AS digest
       FROM geonerva.fire_detections`,
    );
    expect(Number(after.rows[0]?.n), 'every detection must survive the repair').toBe(24);
    expect(after.rows[0]?.digest, 'and be unchanged').toBe(before.rows[0]?.digest);

    const misplaced = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM geonerva.fire_detections
       WHERE to_char((acquired_at AT TIME ZONE 'UTC')::date, 'YYYYMMDD')
             <> right(tableoid::regclass::text, 8)`,
    );
    expect(Number(misplaced.rows[0]?.n), 'each row is in the partition for its UTC day').toBe(0);

    const misaligned = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'fire_detections'
         AND (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \\(''([^'']+)''\\)'))[1]::timestamptz
             <> (to_date(right(c.relname, 8), 'YYYYMMDD')::timestamp AT TIME ZONE 'UTC')`,
    );
    expect(Number(misaligned.rows[0]?.n), 'no partition keeps local bounds').toBe(0);
  }, 180_000);
});

describe('schema hardening that a statement cannot express', () => {
  it('leaves no function in the schema executable by PUBLIC (V-4)', async () => {
    const url = await createDatabaseInZone('gn_grants_test', 'UTC');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    cleanups.push({
      what: 'close the connection to gn_grants_test',
      run: async () => {
        await client.end();
      },
    });
    await migrateUp(client, {});

    const publicExecutable = await client.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'geonerva'
         AND has_function_privilege('public', p.oid, 'EXECUTE')`,
    );
    expect(publicExecutable.rows.map((row) => row.signature)).toEqual([]);
  }, 120_000);
});
