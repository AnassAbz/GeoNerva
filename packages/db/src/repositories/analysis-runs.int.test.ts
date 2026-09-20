/**
 * Analysis runs and the derivation as-of reader.
 *
 * The tests that matter here are the ones about *knowledge time*, because this reader exists to
 * answer one question no other reader can: has GeoNerva's own derivation produced a result the
 * caller is allowed to see at `T`? Getting that wrong reintroduces the failure the whole axis was
 * built to stop — a family with unprocessed data reporting "nothing to report".
 */

import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { derivationsAsOf } from '../asof.ts';
import { createDb } from '../client.ts';
import type { DB } from '../generated/database.ts';
import { setupTestDatabase, type TestDatabase } from '../testing/test-database.ts';
import { finishAnalysisRun, listAnalysisRuns, startAnalysisRun } from './analysis-runs.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

const T0 = new Date('2026-09-20T10:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);

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

/** Opens and closes a run in one step, for the cases that only care about the finished row. */
async function ranAt(
  kind: 'CORRELATION' | 'CLUSTERING',
  startedAt: Date,
  finishedAt: Date,
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED',
  engineVersion = 'eq-corr-1',
): Promise<string> {
  const id = await startAnalysisRun(db, { kind, engineVersion, startedAt });
  await finishAnalysisRun(db, { id, status, finishedAt, stats: { linked: 3 } });
  return id;
}

describe('the run lifecycle', () => {
  it('records a successful derivation with its stats', async () => {
    const id = await startAnalysisRun(db, {
      kind: 'CORRELATION',
      engineVersion: 'eq-corr-1',
      asOf: T0,
      startedAt: T0,
    });
    await finishAnalysisRun(db, {
      id,
      status: 'SUCCEEDED',
      finishedAt: minutes(2),
      stats: { considered: 40, linked: 12 },
    });

    const runs = await listAnalysisRuns(db, { kind: 'CORRELATION' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('SUCCEEDED');
    expect(runs[0]?.finished_at).toEqual(minutes(2));
    expect(runs[0]?.stats).toEqual({ considered: 40, linked: 12 });
  });

  it('records a failure rather than dropping it', async () => {
    /*
     * A failed derivation is the evidence that a family's items are not trustworthy. Dropping the
     * row would make the family look merely quiet, which is the confusion this table exists to
     * prevent.
     */
    const id = await startAnalysisRun(db, { kind: 'CLUSTERING', engineVersion: 'fc-1' });
    await finishAnalysisRun(db, { id, status: 'FAILED', errorClass: 'TIMEOUT' });

    const runs = await listAnalysisRuns(db, { kind: 'CLUSTERING' });
    expect(runs[0]?.status).toBe('FAILED');
    expect(runs[0]?.error_class).toBe('TIMEOUT');
  });

  it('refuses to finish a run twice', async () => {
    // Two closes would overwrite the first outcome, and a derivation has exactly one outcome.
    const id = await startAnalysisRun(db, { kind: 'CORRELATION', engineVersion: 'eq-corr-1' });
    await finishAnalysisRun(db, { id, status: 'SUCCEEDED' });
    await expect(finishAnalysisRun(db, { id, status: 'FAILED' })).rejects.toThrow(/not RUNNING/);
  });

  it('refuses to finish a run that does not exist', async () => {
    await expect(
      finishAnalysisRun(db, { id: randomUUID(), status: 'SUCCEEDED' }),
    ).rejects.toThrow();
  });
});

describe('derivation state at a knowledge time', () => {
  it('reports nothing when no derivation has ever finished', async () => {
    // The distinguishing case: no row at all is *not* the same as a row that derived nothing.
    expect(await derivationsAsOf(db, { asOf: minutes(60) })).toEqual([]);
  });

  it('does not credit a run that had not finished yet at T', async () => {
    /*
     * Invariant I2 on the derived side. A run in flight has produced nothing a reader can see, so
     * a replay at a T inside that run must not report the derivation as current — it would claim
     * results that did not exist at T.
     */
    await ranAt('CORRELATION', T0, minutes(30), 'SUCCEEDED');

    expect(await derivationsAsOf(db, { asOf: minutes(15) })).toEqual([]);
    const after = await derivationsAsOf(db, { asOf: minutes(30) });
    expect(after[0]?.lastSucceededAt).toEqual(minutes(30));
  });

  it('never reports a RUNNING run, whatever the knowledge time', async () => {
    await startAnalysisRun(db, { kind: 'CORRELATION', engineVersion: 'eq-corr-1', startedAt: T0 });
    expect(await derivationsAsOf(db, { asOf: minutes(600) })).toEqual([]);
  });

  it('keeps the last success visible behind a later failure', async () => {
    /*
     * The two fields answer different questions: `latestStatus` says whether the derivation is
     * currently healthy, and `lastSucceededAt` says how old the results on screen are. Collapsing
     * them would force a choice between hiding real clusters and calling stale ones current.
     */
    await ranAt('CLUSTERING', T0, minutes(10), 'SUCCEEDED', 'fc-1');
    await ranAt('CLUSTERING', minutes(20), minutes(25), 'FAILED', 'fc-1');

    const [state] = await derivationsAsOf(db, { asOf: minutes(60) });
    expect(state?.latestStatus).toBe('FAILED');
    expect(state?.latestFinishedAt).toEqual(minutes(25));
    expect(state?.lastSucceededAt).toEqual(minutes(10));
  });

  it('does not count a PARTIAL run as a success', async () => {
    /*
     * A partial derivation produced *some* results and the row does not say which, so it cannot
     * be assumed to cover the location being asked about. Reporting the family as behind is the
     * direction that fails loudly.
     */
    await ranAt('CLUSTERING', T0, minutes(10), 'PARTIAL', 'fc-1');

    const [state] = await derivationsAsOf(db, { asOf: minutes(60) });
    expect(state?.latestStatus).toBe('PARTIAL');
    expect(state?.lastSucceededAt).toBeNull();
  });

  it('separates kinds, so a healthy clustering cannot vouch for a broken correlation', async () => {
    await ranAt('CLUSTERING', T0, minutes(10), 'SUCCEEDED', 'fc-1');
    await ranAt('CORRELATION', T0, minutes(11), 'FAILED');

    const states = await derivationsAsOf(db, { asOf: minutes(60) });
    expect(states.map((state) => state.kind)).toEqual(['CLUSTERING', 'CORRELATION']);
    expect(states.find((state) => state.kind === 'CORRELATION')?.lastSucceededAt).toBeNull();
    expect(states.find((state) => state.kind === 'CLUSTERING')?.lastSucceededAt).toEqual(
      minutes(10),
    );
  });

  it('filters to the kinds asked for', async () => {
    await ranAt('CLUSTERING', T0, minutes(10), 'SUCCEEDED', 'fc-1');
    await ranAt('CORRELATION', T0, minutes(11), 'SUCCEEDED');

    const states = await derivationsAsOf(db, { asOf: minutes(60), kinds: ['CORRELATION'] });
    expect(states.map((state) => state.kind)).toEqual(['CORRELATION']);
  });

  it('carries the engine version of the success, not of the latest attempt', async () => {
    // A snapshot must not attribute its items to an engine version that never produced them.
    await ranAt('CORRELATION', T0, minutes(10), 'SUCCEEDED', 'eq-corr-1');
    await ranAt('CORRELATION', minutes(20), minutes(25), 'FAILED', 'eq-corr-2');

    const [state] = await derivationsAsOf(db, { asOf: minutes(60) });
    expect(state?.latestEngineVersion).toBe('eq-corr-2');
    expect(state?.lastSucceededEngineVersion).toBe('eq-corr-1');
  });

  it('returns a stable order that does not depend on insertion order', async () => {
    await ranAt('CORRELATION', T0, minutes(11), 'SUCCEEDED');
    await ranAt('CLUSTERING', T0, minutes(10), 'SUCCEEDED', 'fc-1');

    const first = await derivationsAsOf(db, { asOf: minutes(60) });
    const second = await derivationsAsOf(db, { asOf: minutes(60) });
    expect(first.map((state) => state.kind)).toEqual(['CLUSTERING', 'CORRELATION']);
    expect(second).toEqual(first);
  });
});
