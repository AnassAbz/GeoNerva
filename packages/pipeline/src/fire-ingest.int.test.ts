/**
 * The FIRMS path against a real PostGIS.
 *
 * The properties being tested are properties of the *database*: partition creation, the derived
 * identity key, and what `ON CONFLICT DO NOTHING` actually does across chunks. A mock would only
 * assert that the mock was called.
 *
 * The case that matters most is the midnight span. The keyless "24 hour" file is not 24 hours —
 * P0 measured one holding ≈ 42 hours across two `acq_date`s — so a persist path that created one
 * partition, or a parser that assumed one day, would drop everything before midnight and report a
 * successful run while doing it.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, listRecentRuns, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import type { HttpClient } from '@geonerva/http';
import { createSourceClient, firmsDescriptor } from '@geonerva/sources';
import { readFixtureBytes } from '@geonerva/test-fixtures';

import { runFireIngestion } from './fire-ingest.ts';
import { createMemoryLogger } from './logging.ts';

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

function clientServing(body: Uint8Array, status = 200): HttpClient {
  return createSourceClient(firmsDescriptor('VIIRS_NOAA20_NRT'), {
    userAgent: 'GeoNerva-test/0.1',
    resolveHost: () => Promise.resolve(['93.184.216.34']),
    sleep: () => Promise.resolve(),
    jitter: () => 1,
    fetchImpl: (() =>
      // A `Uint8Array` is a valid body; the DOM `BodyInit` name is not in this package's lib set.
      new Response(body, {
        status,
        headers: { 'content-type': 'text/csv' },
      })) as unknown as typeof fetch,
  });
}

/**
 * The logger of the last `ingest`, so an assertion about the stored run can say *why* the run row
 * was not finished if it was not. Two tests below failed intermittently (three occurrences, P8 and
 * P9) with a run left RUNNING and nothing to explain it; the next occurrence will print the cause.
 */
let lastLogger = createMemoryLogger();

function finishFailures(): string {
  const failures = lastLogger.entries.filter((entry) => entry.event === 'ingestion.finish_failed');
  return failures.length === 0 ? 'no finish_failed event' : JSON.stringify(failures);
}

async function ingest(file: string, status = 200) {
  lastLogger = createMemoryLogger();
  return runFireIngestion({
    db,
    client: clientServing(readFixtureBytes('firms', file), status),
    sensor: 'VIIRS_NOAA20_NRT',
    trigger: 'MANUAL',
    logger: lastLogger,
  });
}

async function detectionCount(): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM geonerva.fire_detections
  `.execute(db);
  return Number(result.rows[0]?.n ?? '0');
}

describe('ingesting detections', () => {
  it('stores a captured slice and reports counts that reconcile', async () => {
    const outcome = await ingest('j1-24h-slice.csv');

    expect(outcome.status).toBe('SUCCEEDED');
    /*
     * The real invariant is `received = inserted + duplicates + rejected`.
     *
     * This asserted `received = inserted + duplicates`, which is *arithmetically unfalsifiable*
     * for a reject-free fixture: `duplicates` is defined as `detections.length - inserted`, so
     * the sum is `detections.length` by construction and the assertion only says
     * `received === detections.length` — true whenever nothing was rejected, whatever the insert
     * did. A G5 reviewer pointed it out. The full form is checked here, and the reject term is
     * exercised by the drifted-row test below.
     */
    expect(outcome.counts.received).toBe(
      outcome.counts.inserted + outcome.counts.duplicates + outcome.counts.rejected,
    );
    expect(outcome.counts.inserted).toBeGreaterThan(100);
    expect(await detectionCount()).toBe(outcome.counts.inserted);
    expect(outcome.keyless).toBe(true);
  });

  it('keeps the counts reconciled when some rows are rejected', async () => {
    /*
     * The reject term, with a real value in it. The identity above is trivially true when
     * `rejected` is zero, which is why the reject-free fixture could not test it.
     */
    const good =
      '-13.66386,17.06811,296.27,0.38,0.36,2026-09-18,0013,N20,nominal,2.0NRT,285.89,0.35,N';
    const bad = '999,17.06811,296.27,0.38,0.36,2026-09-18,0013,N20,nominal,2.0NRT,285.89,0.35,N';
    const header =
      'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight';
    const rows = [header];
    /*
     * Four-decimal longitudes, distinct at the precision the identity key keeps.
     *
     * The first attempt used five-decimal values, which `roundCoordinate` collapsed onto five
     * distinct pixels — so 40 rows became 5 detections. That is the identity key working exactly
     * as designed, and a useful reminder that a test fixture has to respect it.
     */
    for (let index = 0; index < 40; index += 1) {
      rows.push(good.replace('17.06811', `17.${String(6000 + index)}`));
    }
    rows.push(bad, bad);

    const outcome = await runFireIngestion({
      db,
      client: clientServing(new TextEncoder().encode(rows.join('\n'))),
      sensor: 'VIIRS_NOAA20_NRT',
      trigger: 'MANUAL',
      logger: createMemoryLogger(),
    });

    // 2 of 42 is under the drift threshold, so the batch stands — as PARTIAL, not SUCCEEDED.
    expect(outcome.status).toBe('PARTIAL');
    expect(outcome.counts.rejected).toBe(2);
    expect(outcome.counts.received).toBe(
      outcome.counts.inserted + outcome.counts.duplicates + outcome.counts.rejected,
    );
    expect(await detectionCount()).toBe(40);
  });

  it('refuses a batch that would create a partition per row', async () => {
    /*
     * `ensurePartitionsForDays` issues a `CREATE TABLE ... PARTITION OF` plus an `ALTER TABLE`
     * per distinct day, **before** the insert — and the DDL is not rolled back by a later
     * failure, while retention only drops days *older* than its cutoff. A file with scattered
     * dates would therefore accrete partitions permanently, on every poll.
     *
     * A real file spans two days; a keyed `DAY_RANGE=5` request spans six.
     */
    const header =
      'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight';
    const rows = [header];
    for (let day = 1; day <= 20; day += 1) {
      const date = `2026-03-${String(day).padStart(2, '0')}`;
      rows.push(
        `-13.6${String(day)},17.06811,296.27,0.38,0.36,${date},0013,N20,nominal,2.0NRT,285.89,0.35,N`,
      );
    }

    const outcome = await runFireIngestion({
      db,
      client: clientServing(new TextEncoder().encode(rows.join('\n'))),
      sensor: 'VIIRS_NOAA20_NRT',
      trigger: 'MANUAL',
      logger: createMemoryLogger(),
    });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe('SCHEMA_DRIFT');
    expect(outcome.detail).toMatch(/distinct acquisition days/);
    expect(await detectionCount()).toBe(0);
    // And nothing was created: the guard runs before the insert, which is the whole point.
    const partitions = await sql<{ relname: string }>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'geonerva' AND c.relname LIKE 'fire_detections_202603%'
    `.execute(db);
    expect(partitions.rows).toHaveLength(0);
  });

  it('rejects a detection dated after now instead of partitioning the future', async () => {
    /*
     * The parser cannot judge this — it is pure, and "later than now" needs a clock. So the rule
     * lives here: a detection more than five minutes ahead of the ingest clock is a
     * `FUTURE_OBSERVATION` reject (matching invariant I13, which `observation_versions` enforces
     * in the database and `fire_detections` has no CHECK for), and it never reaches the partition
     * set — where it would have created a day that retention can never reclaim.
     */
    const header =
      'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight';
    /*
     * The acceptable row's timestamp is derived from the clock, not hardcoded.
     *
     * It read `<today>,0013` until a run at 00:07 UTC failed it: on that date "today at 00:13" is
     * six minutes in the *future*, past the five-minute horizon, so both rows were rejected and
     * the test reported a product fault that did not exist. A fixed wall-clock time inside a
     * test that compares against `now` is only ever correct for part of the day.
     */
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const recentDate = twoHoursAgo.toISOString().slice(0, 10);
    const recentTime = twoHoursAgo.toISOString().slice(11, 16).replace(':', '');
    const future = new Date(Date.now() + 40 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
    const rows = [
      header,
      `-13.66,17.06,296.27,0.38,0.36,${recentDate},${recentTime},N20,nominal,2.0NRT,285.89,0.35,N`,
      `-13.67,17.07,296.27,0.38,0.36,${future},0013,N20,nominal,2.0NRT,285.89,0.35,N`,
    ];

    const outcome = await runFireIngestion({
      db,
      client: clientServing(new TextEncoder().encode(rows.join('\n'))),
      sensor: 'VIIRS_NOAA20_NRT',
      trigger: 'MANUAL',
      logger: createMemoryLogger(),
    });

    expect(outcome.status).toBe('PARTIAL');
    expect(outcome.counts.rejected).toBe(1);
    expect(outcome.counts.inserted).toBe(1);
    expect(await detectionCount()).toBe(1);

    const partitions = await sql<{ relname: string }>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'geonerva'
        AND c.relname = ${'fire_detections_' + future.replaceAll('-', '')}
    `.execute(db);
    expect(partitions.rows).toHaveLength(0);
  });

  it('inserts nothing the second time, which is what makes an overlapping poll free', async () => {
    /*
     * FIRMS publishes no detection id, so the identity is
     * `(product, acquired_at, round(lat, 4), round(lon, 4))` (ADR-011). If the parser's rounding
     * and the column's disagreed, every poll would insert the same pixels again — and with a
     * `DAY_RANGE=2` poll every 30 minutes, the table would grow by a day of detections every
     * half hour while every run reported success.
     */
    const first = await ingest('j1-24h-slice.csv');
    const second = await ingest('j1-24h-slice.csv');

    expect(second.counts.inserted).toBe(0);
    expect(second.counts.duplicates).toBe(first.counts.received);
    expect(await detectionCount()).toBe(first.counts.inserted);
  });

  it('creates a partition per day a batch touches', async () => {
    // The "24 hour" file spans two `acq_date`s. One partition would silently lose a day.
    const outcome = await ingest('j1-24h-midnight-span.csv');
    expect(outcome.status).toBe('SUCCEEDED');

    const days = await sql<{ day: string; n: string }>`
      SELECT acquired_at::date::text AS day, count(*)::text AS n
      FROM geonerva.fire_detections GROUP BY 1 ORDER BY 1
    `.execute(db);
    expect(days.rows.length).toBeGreaterThan(1);
    // Every row landed somewhere; nothing was dropped at the boundary.
    const stored = days.rows.reduce((total, row) => total + Number(row.n), 0);
    expect(stored).toBe(outcome.counts.inserted);

    const partitions = await sql<{ relname: string }>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'geonerva' AND c.relname LIKE 'fire_detections_2%'
    `.execute(db);
    expect(partitions.rows.length).toBeGreaterThanOrEqual(days.rows.length);
  });
});

describe('when the batch is not usable', () => {
  it('writes nothing and records why, for a file whose column was renamed', async () => {
    // `frp` → `FRP_MW`. Storing null radiative power on every detection would be
    // indistinguishable from a genuinely quiet set of fires.
    const outcome = await ingest('drift-renamed-column.csv');

    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe('SCHEMA_DRIFT');
    expect(await detectionCount()).toBe(0);

    const runs = await listRecentRuns(db, { sourceId: 'firms', limit: 1 });
    expect(runs[0]?.status, finishFailures()).toBe('FAILED');
    expect(runs[0]?.errorClass).toBe('SCHEMA_DRIFT');
  });

  it('treats an empty global file as broken rather than as a quiet planet', async () => {
    const outcome = await ingest('drift-empty.csv');
    expect(outcome.errorClass).toBe('EMPTY_SUSPICIOUS');
    expect(await detectionCount()).toBe(0);
  });

  it('classifies a refused credential as CONFIG_ERROR, which never self-heals', async () => {
    /*
     * FIRMS answers an unusable key with 400 from the Area API, 401 from `data_availability` and
     * 403 from `mapkey_status`, and the same message covers an exhausted transaction budget.
     * None of them is retryable, and `CONFIG_ERROR` is what makes the worker exit non-zero rather
     * than sit there looking healthy (ADR-032).
     */
    const outcome = await runFireIngestion({
      db,
      client: clientServing(readFixtureBytes('firms', 'area-invalid-mapkey.txt'), 400),
      sensor: 'VIIRS_NOAA20_NRT',
      mapKey: 'abcdef0123456789abcdef0123456789',
      trigger: 'MANUAL',
      logger: createMemoryLogger(),
    });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe('CONFIG_ERROR');
    expect(outcome.keyless).toBe(false);
    expect(await detectionCount()).toBe(0);
  });

  it('never writes the key, or anything key-shaped, into the run row', async () => {
    /*
     * The negative test the gate asks for. FIRMS puts its credential in the URL *path*, so the
     * ordinary reflex of recording a failing URL would put a working key into
     * `ingestion_runs.error_message`, where it would sit until someone read the table.
     */
    const key = 'abcdef0123456789abcdef0123456789';
    lastLogger = createMemoryLogger();
    await runFireIngestion({
      db,
      client: clientServing(readFixtureBytes('firms', 'area-invalid-mapkey.txt'), 400),
      sensor: 'VIIRS_NOAA20_NRT',
      mapKey: key,
      trigger: 'MANUAL',
      logger: lastLogger,
    });

    const stored = await sql<{ error_message: string | null; http_status: number | null }>`
      SELECT error_message, http_status FROM geonerva.ingestion_runs WHERE source_id = 'firms'
    `.execute(db);
    expect(stored.rows).toHaveLength(1);
    const message = stored.rows[0]?.error_message ?? '';
    expect(message).not.toContain(key);
    // Not a prefix either: a partial key is a slow leak.
    expect(message).not.toContain(key.slice(0, 8));
    expect(message, finishFailures()).toMatch(/credential/);
    // The status still reaches the row, because *which* refusal it was is diagnosable and safe.
    expect(stored.rows[0]?.http_status).toBe(400);
  });
});
