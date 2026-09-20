/**
 * Backfill plans and interval checkpoints, against real PostgreSQL.
 *
 * These have to be integration tests: every property being checked — the unique request index
 * that turns a repeat into a resume, `FOR UPDATE SKIP LOCKED`, the CHECK constraints, and the
 * atomicity of a checkpoint with the facts beside it — is a property of the database.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DB } from '../client.ts';
import { setupTestDatabase, type TestDatabase } from '../testing/test-database.ts';
import {
  addBackfillIntervals,
  backfillProgress,
  claimNextInterval,
  finishBackfillPlan,
  findBackfillPlan,
  markIntervalDone,
  markIntervalFailed,
  openBackfillPlan,
  recordIntervalAttempt,
  splitBackfillInterval,
  type BackfillPlanRequest,
} from './backfill.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const JAN = new Date('2026-01-01T00:00:00.000Z');
const FEB = new Date('2026-02-01T00:00:00.000Z');
const day = (n: number): Date => new Date(JAN.getTime() + n * 24 * 60 * 60 * 1000);

const REQUEST: BackfillPlanRequest = {
  sourceId: 'usgs',
  productId: null,
  mode: 'HISTORICAL',
  rangeFrom: JAN,
  rangeTo: FEB,
  minMagnitude: 4.5,
  windowMs: 7 * 24 * 60 * 60 * 1000,
  minWindowMs: 60_000,
};

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

describe('opening a plan', () => {
  it('records the request faithfully, including the numeric parameters', async () => {
    const { plan, created } = await openBackfillPlan(db, REQUEST);
    expect(created).toBe(true);

    // bigint and numeric arrive as strings from pg; a silent NaN here would be a wrong plan.
    expect(plan.windowMs).toBe(REQUEST.windowMs);
    expect(plan.minWindowMs).toBe(REQUEST.minWindowMs);
    expect(plan.minMagnitude).toBe(4.5);
    expect(plan.status).toBe('RUNNING');

    const reread = await findBackfillPlan(db, plan.id);
    expect(reread, 'a resumed process reads its own parameters back').toStrictEqual(plan);
  });

  it('resumes the same plan when the identical range is requested again', async () => {
    const first = await openBackfillPlan(db, REQUEST);
    const second = await openBackfillPlan(db, REQUEST);

    expect(second.created).toBe(false);
    expect(second.plan.id).toBe(first.plan.id);
    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.backfill_plans
    `.execute(db);
    expect(count.rows[0]?.n, 'one request, one plan').toBe('1');
  });

  it('treats a different range, magnitude or mode as a different plan', async () => {
    await openBackfillPlan(db, REQUEST);
    await openBackfillPlan(db, { ...REQUEST, rangeTo: day(20) });
    await openBackfillPlan(db, { ...REQUEST, minMagnitude: null });
    await openBackfillPlan(db, { ...REQUEST, mode: 'DELETION_SWEEP' });

    const count = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.backfill_plans
    `.execute(db);
    expect(count.rows[0]?.n).toBe('4');
  });

  it('reopens a completed plan, because a finished range can still gain revisions', async () => {
    const { plan } = await openBackfillPlan(db, REQUEST);
    await finishBackfillPlan(db, plan.id, 'COMPLETED');
    expect((await findBackfillPlan(db, plan.id))?.status).toBe('COMPLETED');

    const again = await openBackfillPlan(db, REQUEST);
    expect(again.plan.id).toBe(plan.id);
    expect(again.plan.status).toBe('RUNNING');
    expect(again.plan.finishedAt).toBeNull();
  });

  it.each([
    ['an inverted range', { rangeFrom: FEB, rangeTo: JAN }],
    ['a window below the floor', { windowMs: 1_000, minWindowMs: 60_000 }],
  ])('refuses %s at the database level', async (_name, override) => {
    // The CHECK constraints are the backstop for a caller that skipped validation.
    await expect(openBackfillPlan(db, { ...REQUEST, ...override })).rejects.toThrow();
  });
});

describe('intervals', () => {
  async function planWithIntervals(): Promise<string> {
    const { plan } = await openBackfillPlan(db, REQUEST);
    await addBackfillIntervals(db, plan.id, [
      { from: day(0), to: day(7) },
      { from: day(7), to: day(14) },
      { from: day(14), to: day(21) },
    ]);
    return plan.id;
  }

  it('adds intervals once, however many times planning runs', async () => {
    const planId = await planWithIntervals();
    const addedAgain = await addBackfillIntervals(db, planId, [
      { from: day(0), to: day(7) },
      { from: day(7), to: day(14) },
      { from: day(14), to: day(21) },
    ]);
    expect(addedAgain, 're-planning adds nothing').toBe(0);
    expect((await backfillProgress(db, planId)).total).toBe(3);
  });

  it('does not reset a finished interval when planning runs again', async () => {
    const planId = await planWithIntervals();
    await db
      .transaction()
      .execute((trx) => markIntervalDone(trx, planId, { from: day(0), to: day(7) }, 12, null));

    await addBackfillIntervals(db, planId, [{ from: day(0), to: day(7) }]);

    const progress = await backfillProgress(db, planId);
    expect(progress.done, 'completed work stays completed').toBe(1);
    expect(progress.pending).toBe(2);
  });

  it('claims the earliest pending interval', async () => {
    const planId = await planWithIntervals();
    const claimed = await db.transaction().execute((trx) => claimNextInterval(trx, planId));
    expect(claimed?.from).toStrictEqual(day(0));
  });

  it('returns null once nothing is pending, which is how a plan ends', async () => {
    const planId = await planWithIntervals();
    for (const from of [0, 7, 14]) {
      await db
        .transaction()
        .execute((trx) =>
          markIntervalDone(trx, planId, { from: day(from), to: day(from + 7) }, 1, null),
        );
    }
    const claimed = await db.transaction().execute((trx) => claimNextInterval(trx, planId));
    expect(claimed).toBeNull();
  });

  it('counts attempts, so an interval that keeps failing is visible', async () => {
    const planId = await planWithIntervals();
    const interval = { from: day(0), to: day(7) };
    expect(await recordIntervalAttempt(db, planId, interval)).toBe(1);
    expect(await recordIntervalAttempt(db, planId, interval)).toBe(2);
  });

  it('raises rather than silently counting an attempt on an interval that is not there', async () => {
    const planId = await planWithIntervals();
    await expect(
      recordIntervalAttempt(db, planId, { from: day(99), to: day(100) }),
    ).rejects.toThrow(/no backfill interval/);
  });

  it('refuses to checkpoint an interval that does not exist', async () => {
    // The safe direction: the caller's transaction aborts, the facts roll back, and the next pass
    // redoes the window. Committing facts whose checkpoint failed is the dangerous alternative.
    const planId = await planWithIntervals();
    await expect(
      db
        .transaction()
        .execute((trx) => markIntervalDone(trx, planId, { from: day(99), to: day(100) }, 1, null)),
    ).rejects.toThrow(/could not checkpoint/);
  });
});

describe('splitting', () => {
  it('replaces a parent with children that tile it, atomically', async () => {
    const { plan } = await openBackfillPlan(db, REQUEST);
    await addBackfillIntervals(db, plan.id, [{ from: day(0), to: day(7) }]);

    await db.transaction().execute((trx) =>
      splitBackfillInterval(trx, plan.id, { from: day(0), to: day(7) }, [
        { from: day(0), to: day(3.5) },
        { from: day(3.5), to: day(7) },
      ]),
    );

    const progress = await backfillProgress(db, plan.id);
    expect(progress.split, 'the parent is kept as SPLIT, not deleted').toBe(1);
    expect(progress.pending).toBe(2);

    // The parent must never come back as PENDING, or a resumed process would split it forever.
    const claimed = await db.transaction().execute((trx) => claimNextInterval(trx, plan.id));
    expect(claimed?.to).toStrictEqual(day(3.5));
  });

  it('refuses to split the same parent twice', async () => {
    const { plan } = await openBackfillPlan(db, REQUEST);
    await addBackfillIntervals(db, plan.id, [{ from: day(0), to: day(7) }]);
    const children = [
      { from: day(0), to: day(3.5) },
      { from: day(3.5), to: day(7) },
    ];
    await db
      .transaction()
      .execute((trx) =>
        splitBackfillInterval(trx, plan.id, { from: day(0), to: day(7) }, children),
      );

    await expect(
      db
        .transaction()
        .execute((trx) =>
          splitBackfillInterval(trx, plan.id, { from: day(0), to: day(7) }, children),
        ),
    ).rejects.toThrow(/could not split/);
  });
});

describe('finishing a plan', () => {
  it('refuses COMPLETED while work is outstanding', async () => {
    // "Most of it is done" is exactly the claim this project must never make.
    const { plan } = await openBackfillPlan(db, REQUEST);
    await addBackfillIntervals(db, plan.id, [
      { from: day(0), to: day(7) },
      { from: day(7), to: day(14) },
    ]);
    await db
      .transaction()
      .execute((trx) => markIntervalDone(trx, plan.id, { from: day(0), to: day(7) }, 3, null));

    await expect(finishBackfillPlan(db, plan.id, 'COMPLETED')).rejects.toThrow(
      /1 pending, 0 failed/,
    );
  });

  it('refuses COMPLETED while an interval is FAILED', async () => {
    const { plan } = await openBackfillPlan(db, REQUEST);
    await addBackfillIntervals(db, plan.id, [{ from: day(0), to: day(7) }]);
    await markIntervalFailed(db, plan.id, { from: day(0), to: day(7) }, 'HTTP_4XX', 'bad request');

    await expect(finishBackfillPlan(db, plan.id, 'COMPLETED')).rejects.toThrow(
      /0 pending, 1 failed/,
    );
  });

  it('allows COMPLETED once every interval is DONE or SPLIT', async () => {
    const { plan } = await openBackfillPlan(db, REQUEST);
    await addBackfillIntervals(db, plan.id, [{ from: day(0), to: day(7) }]);
    await db.transaction().execute((trx) =>
      splitBackfillInterval(trx, plan.id, { from: day(0), to: day(7) }, [
        { from: day(0), to: day(3.5) },
        { from: day(3.5), to: day(7) },
      ]),
    );
    for (const [from, to] of [
      [0, 3.5],
      [3.5, 7],
    ] as const) {
      await db
        .transaction()
        .execute((trx) =>
          markIntervalDone(trx, plan.id, { from: day(from), to: day(to) }, 5, null),
        );
    }

    await finishBackfillPlan(db, plan.id, 'COMPLETED');
    const finished = await findBackfillPlan(db, plan.id);
    expect(finished?.status).toBe('COMPLETED');
    expect(finished?.finishedAt).not.toBeNull();
    expect((await backfillProgress(db, plan.id)).received).toBe(10);
  });
});

describe('the checkpoint is atomic with whatever the caller writes beside it', () => {
  it('rolls the checkpoint back when the surrounding transaction fails', async () => {
    /*
     * This is the crash window P4.2 asks about, closed by construction rather than handled after
     * the fact: `markIntervalDone` takes a Transaction, so the checkpoint lands in the same
     * transaction as the window's facts. If anything in that transaction fails, the checkpoint
     * goes back too and the interval stays PENDING for the next pass.
     */
    const { plan } = await openBackfillPlan(db, REQUEST);
    await addBackfillIntervals(db, plan.id, [{ from: day(0), to: day(7) }]);

    await expect(
      db.transaction().execute(async (trx) => {
        await markIntervalDone(trx, plan.id, { from: day(0), to: day(7) }, 42, null);
        throw new Error('the batch failed after the checkpoint was written');
      }),
    ).rejects.toThrow('the batch failed after the checkpoint was written');

    const progress = await backfillProgress(db, plan.id);
    expect(progress.done, 'no checkpoint without its facts').toBe(0);
    expect(progress.pending).toBe(1);
    expect(progress.received).toBe(0);
  });
});
