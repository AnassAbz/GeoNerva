/**
 * A run's stamps come from one clock — the database's (the fire-ingest and EMSC intermittents).
 *
 * `committed_at` and `finished_at` are CHECKed `>= started_at`. `started_at` used to be the
 * worker's clock while `committed_at` was the database's, so whenever the database clock ran
 * behind the worker's by more than a run's duration, `finishRun` was refused: measured on the WSL
 * development VM at up to 7 ms behind in 12 % of samples, which a run failing in a millisecond or
 * two crossed intermittently. The skew is simulated here deterministically by moving the worker's
 * clock an hour ahead — `Date` only, so the database driver's timers are untouched.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type DB } from '../index.ts';
import { setupTestDatabase, type TestDatabase } from '../testing/test-database.ts';
import { acquireRunLease, finishRun } from './ingestion-runs.ts';

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

afterEach(() => {
  vi.useRealTimers();
});

describe('run timestamps', () => {
  it('finish a fast run even when the worker clock runs ahead of the database', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60 * 60 * 1000 });

    const lease = await acquireRunLease(db, {
      sourceId: 'usgs',
      productId: null,
      trigger: 'MANUAL',
    });
    if (!lease.acquired) throw new Error('lease not acquired');
    await finishRun(db, {
      runId: lease.runId,
      status: 'FAILED',
      errorClass: 'SCHEMA_DRIFT',
      errorMessage: 'drift',
    });

    const row = await sql<{ status: string; started: Date; finished: Date; committed: Date }>`
      SELECT status, started_at AS started, finished_at AS finished, committed_at AS committed
      FROM geonerva.ingestion_runs WHERE id = ${lease.runId}::uuid
    `.execute(db);
    expect(row.rows[0]?.status).toBe('FAILED');
    // All three from the database: none of them is an hour in the future.
    const now = await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(db);
    expect(row.rows[0]?.started.getTime()).toBeLessThanOrEqual(now.rows[0]?.at.getTime() ?? 0);
  });

  it('still honours an explicit start and finish, which is how tests describe a timeline', async () => {
    const startedAt = new Date('2026-09-21T10:00:00.000Z');
    const lease = await acquireRunLease(db, {
      sourceId: 'usgs',
      productId: null,
      trigger: 'MANUAL',
      startedAt,
    });
    if (!lease.acquired) throw new Error('lease not acquired');
    await finishRun(db, {
      runId: lease.runId,
      status: 'SUCCEEDED',
      finishedAt: new Date('2026-09-21T10:00:05.000Z'),
    });
    const row = await sql<{ started: Date; finished: Date }>`
      SELECT started_at AS started, finished_at AS finished FROM geonerva.ingestion_runs
      WHERE id = ${lease.runId}::uuid
    `.execute(db);
    expect(row.rows[0]?.started.toISOString()).toBe('2026-09-21T10:00:00.000Z');
    expect(row.rows[0]?.finished.toISOString()).toBe('2026-09-21T10:00:05.000Z');
  });
});
