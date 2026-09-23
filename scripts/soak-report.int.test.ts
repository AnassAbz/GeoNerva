/**
 * The soak tally against a real PostgreSQL, because its bugs live in SQL's three-valued logic
 * rather than in its arithmetic.
 *
 * The first version of the query wrote `NOT (error_class = 'ABORTED')`. A run that succeeded has
 * no `error_class`, so that expression is NULL, so the filter dropped **every success** out of the
 * denominator — and the arithmetic above it was perfectly correct the whole time. No unit test
 * over a `SoakTally` would have noticed. This one would.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DB } from '../packages/db/src/index.ts';
import { setupTestDatabase, type TestDatabase } from '../packages/db/src/testing/test-database.ts';
import { tallyRuns } from './soak-report.ts';

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

interface RunShape {
  readonly status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  readonly errorClass?: string | null;
  readonly trigger?: 'SCHEDULE' | 'MANUAL' | 'BACKFILL' | 'RECONCILE';
  readonly agoHours?: number;
  readonly build?: string | null;
}

/** Writes one committed run. The lease index only constrains `RUNNING`, so these can pile up. */
async function run(shape: RunShape): Promise<void> {
  const at = sql`now() - make_interval(hours => ${shape.agoHours ?? 1})`;
  await sql`
    INSERT INTO geonerva.ingestion_runs
      (id, source_id, product_id, trigger, started_at, status, committed_at, finished_at,
       error_class, worker_version)
    VALUES (gen_random_uuid(), 'usgs', NULL, ${shape.trigger ?? 'SCHEDULE'}, ${at},
            ${shape.status}, ${at}, ${at}, ${shape.errorClass ?? null}, ${shape.build ?? null})
  `.execute(db);
}

describe('the soak tally', () => {
  it('counts a success, which carries no error class at all', async () => {
    await run({ status: 'SUCCEEDED' });

    const tally = await tallyRuns(db, 24);

    expect(tally.judged).toBe(1);
    expect(tally.succeeded).toBe(1);
  });

  it('excludes provider failures from the denominator rather than counting them against us', async () => {
    await run({ status: 'SUCCEEDED' });
    await run({ status: 'FAILED', errorClass: 'HTTP_5XX' });
    await run({ status: 'FAILED', errorClass: 'NETWORK' });

    const tally = await tallyRuns(db, 24);

    expect(tally.judged).toBe(1);
    expect(tally.succeeded).toBe(1);
    expect(tally.providerFailures).toBe(2);
  });

  /*
   * The opposite of the source-health rule, deliberately. `deriveSourceHealth` counts
   * `CONFIG_ERROR` as a failure because a broken allowlist means there really is no data; the soak
   * counts it too, but as *ours* — it is the clearest possible case of the deployment misbehaving.
   */
  it('counts our own failures against us', async () => {
    await run({ status: 'SUCCEEDED' });
    await run({ status: 'FAILED', errorClass: 'CONFIG_ERROR' });
    await run({ status: 'FAILED', errorClass: 'DB_ERROR' });

    const tally = await tallyRuns(db, 24);

    expect(tally.judged).toBe(3);
    expect(tally.succeeded).toBe(1);
    expect(tally.providerFailures).toBe(0);
  });

  it('leaves a run we cancelled ourselves out of both sides', async () => {
    await run({ status: 'SUCCEEDED' });
    await run({ status: 'FAILED', errorClass: 'ABORTED' });

    const tally = await tallyRuns(db, 24);

    expect(tally.judged).toBe(1);
    expect(tally.succeeded).toBe(1);
    expect(tally.aborted).toBe(1);
  });

  it('treats SKIPPED as doing its job and PARTIAL as not', async () => {
    await run({ status: 'SKIPPED' });
    await run({ status: 'PARTIAL' });

    const tally = await tallyRuns(db, 24);

    expect(tally.judged).toBe(2);
    expect(tally.succeeded).toBe(1);
  });

  it('ignores anything that is not a scheduled poll', async () => {
    await run({ status: 'SUCCEEDED', trigger: 'BACKFILL' });
    await run({ status: 'FAILED', errorClass: 'DB_ERROR', trigger: 'MANUAL' });

    expect((await tallyRuns(db, 24)).judged).toBe(0);
  });

  it('ignores runs outside the window', async () => {
    await run({ status: 'SUCCEEDED', agoHours: 30 });
    await run({ status: 'SUCCEEDED', agoHours: 2 });

    expect((await tallyRuns(db, 24)).judged).toBe(1);
  });

  it('names every build it saw, so a soak straddling a deploy says so', async () => {
    await run({ status: 'SUCCEEDED', build: 'ef6e970' });
    await run({ status: 'SUCCEEDED', build: 'cb758d0' });
    await run({ status: 'SUCCEEDED', build: null });

    const tally = await tallyRuns(db, 24);

    expect([...tally.builds].sort()).toEqual(['cb758d0', 'ef6e970']);
    expect(tally.judged).toBe(3);
  });
});
