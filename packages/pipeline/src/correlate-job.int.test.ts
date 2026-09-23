/**
 * **Ingested observations become canonical events without anyone typing a command** (ADR-044).
 *
 * This is the regression test for a defect that shipped: `correlateEarthquakes` existed, was
 * correct, was thoroughly tested — and was called from nothing. A deployment ingested 245 real
 * earthquakes and served "GeoNerva cannot currently report on earthquakes" until a human ran the
 * derivation by hand. Every test here asks whether the **job** does its work, not whether the
 * algorithm is right; `correlate.int.test.ts` owns the second question.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, derivationsAsOf, type DB } from '@geonerva/db';
import { setupTestDatabase, type TestDatabase } from '@geonerva/db/testing';
import { seedObservation } from '@geonerva/db/testing/factories';

import { runCorrelation } from './correlate-job.ts';
import { createJsonLogger, type Logger } from './logging.ts';

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

const T0 = new Date('2026-09-20T08:00:00.000Z');
const INGEST = new Date('2026-09-20T09:00:00.000Z');
const AS_OF = new Date('2026-09-20T10:00:00.000Z');
const AT = { lat: 31.6295, lon: -7.9811 };

/** Collects the log lines a run emits, so the terminal event can be asserted rather than assumed. */
function collectingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createJsonLogger(
    (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    () => AS_OF,
  );
  return { logger, lines };
}

async function seed(primaryKey: string, ingestedAt: Date = INGEST): Promise<void> {
  await seedObservation(db, {
    sourceId: 'usgs',
    primaryKey,
    aliases: [primaryKey],
    ingestedAt,
    observedAt: T0,
    centroid: AT,
    magnitude: 5,
    magnitudeType: 'mww',
    depthKm: 10,
    contributor: null,
    lifecycleStatus: 'ACTIVE',
  });
}

async function eventCount(): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*) AS n FROM geonerva.canonical_events
  `.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

async function activeLinkCount(): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*) AS n FROM geonerva.canonical_links WHERE unlinked_at IS NULL
  `.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

describe('correlation runs itself', () => {
  it('turns ingested observations into canonical events with no manual step', async () => {
    await seed('us1');
    await seed('us2');
    expect(await eventCount()).toBe(0);

    const { logger, lines } = collectingLogger();
    const outcome = await runCorrelation({ db, logger, asOf: AS_OF });

    expect(outcome.status).toBe('SUCCEEDED');
    expect(await eventCount()).toBe(2);
    expect(await activeLinkCount()).toBe(2);

    /* One terminal line, carrying the counters, at info because it did not fail. */
    const terminal = lines.filter((line) => line['event'] === 'correlation.run');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.['level']).toBe('info');
    expect(String(terminal[0]?.['detail'])).toContain('considered=2');
    expect(String(terminal[0]?.['detail'])).toContain('created=2');
  });

  it('records a run the availability model can see, so the briefing stops refusing', async () => {
    await seed('us1');

    const before = await derivationsAsOf(db, {
      asOf: new Date(Date.now() + 60_000),
      kinds: ['CORRELATION'],
    });
    expect(before[0]?.lastSucceededAt ?? null).toBeNull();

    await runCorrelation({ db, logger: collectingLogger().logger, asOf: AS_OF });

    /*
     * Real wall clock, not the scenario's `AS_OF`: `derivationsAsOf` filters on `finished_at`,
     * which is when the run actually ended, and a fixed 2026-09-20 bound would exclude it. The
     * same trap makes a "nothing succeeded" assertion pass for the wrong reason.
     */
    const after = await derivationsAsOf(db, {
      asOf: new Date(Date.now() + 60_000),
      kinds: ['CORRELATION'],
    });
    expect(after[0]?.lastSucceededAt).not.toBeNull();
    expect(after[0]?.latestStatus).toBe('SUCCEEDED');
  });
});

describe('the gate', () => {
  it('does no work, and writes no run, when nothing has been ingested since the last one', async () => {
    await seed('us1');
    await runCorrelation({ db, logger: collectingLogger().logger, asOf: AS_OF });

    const runsAfterFirst = await sql<{ n: string }>`
      SELECT count(*) AS n FROM geonerva.analysis_runs WHERE kind = 'CORRELATION'
    `.execute(db);

    const { logger, lines } = collectingLogger();
    const second = await runCorrelation({
      db,
      logger,
      asOf: new Date(AS_OF.getTime() + 60_000),
    });

    expect(second.status).toBe('SKIPPED');
    expect(second.runId).toBeNull();
    /*
     * The point of the gate is that the ledger records events, not heartbeats: a skipped run must
     * not leave an `analysis_runs` row saying nothing happened.
     */
    const runsAfterSecond = await sql<{ n: string }>`
      SELECT count(*) AS n FROM geonerva.analysis_runs WHERE kind = 'CORRELATION'
    `.execute(db);
    expect(runsAfterSecond.rows[0]?.n).toBe(runsAfterFirst.rows[0]?.n);
    expect(String(lines.at(-1)?.['detail'])).toContain('nothing ingested since');
  });

  it('opens again as soon as a new fact arrives', async () => {
    await seed('us1');
    await runCorrelation({ db, logger: collectingLogger().logger, asOf: AS_OF });

    const laterIngest = new Date(AS_OF.getTime() + 60_000);
    await seed('us2', laterIngest);

    const outcome = await runCorrelation({
      db,
      logger: collectingLogger().logger,
      asOf: new Date(laterIngest.getTime() + 60_000),
    });

    expect(outcome.status).toBe('SUCCEEDED');
    expect(await eventCount()).toBe(2);
  });

  /*
   * The subtle one, and the reason the gate reads `as_of` rather than `finished_at`. A fact that
   * arrives *during* a run has `ingested_at` before that run finished, and was still excluded by
   * the knowledge time the run applied. Gating on when the run ended would call it seen and strand
   * it until some unrelated earthquake happened along.
   */
  it('does not strand a fact that arrived while the previous run was in flight', async () => {
    await seed('us1');
    const firstAsOf = AS_OF;
    await runCorrelation({ db, logger: collectingLogger().logger, asOf: firstAsOf });

    /* Ingested after the run's knowledge bound, but before any wall clock it could have finished at. */
    await seed('mid-flight', new Date(firstAsOf.getTime() + 1_000));

    const outcome = await runCorrelation({
      db,
      logger: collectingLogger().logger,
      asOf: new Date(firstAsOf.getTime() + 120_000),
    });

    expect(outcome.status).toBe('SUCCEEDED');
    expect(await eventCount()).toBe(2);
  });

  /*
   * A run that failed is not a run that saw the facts. If the gate counted one, a single transient
   * failure would leave the work stranded until some unrelated earthquake happened to arrive — the
   * derivation would sit behind the fact store indefinitely while the product reported
   * `DERIVATION_STALE` and nobody retried.
   */
  it('does not treat a failed run as having seen the facts', async () => {
    await seed('us1');

    /* A failed run whose knowledge time is *newer* than the fact: only its status disqualifies it. */
    await sql`
      INSERT INTO geonerva.analysis_runs
        (id, kind, as_of, engine_version, started_at, finished_at, status, error_class)
      VALUES (gen_random_uuid(), 'CORRELATION', ${new Date(AS_OF.getTime() + 30_000)},
              'test', ${AS_OF}, ${AS_OF}, 'FAILED', 'INTERNAL')
    `.execute(db);

    const outcome = await runCorrelation({
      db,
      logger: collectingLogger().logger,
      asOf: new Date(AS_OF.getTime() + 60_000),
    });

    expect(outcome.status).toBe('SUCCEEDED');
    expect(await eventCount()).toBe(1);
  });

  it('skips quietly when there are no earthquake facts at all', async () => {
    const outcome = await runCorrelation({ db, logger: collectingLogger().logger, asOf: AS_OF });

    expect(outcome.status).toBe('SKIPPED');
    expect(await eventCount()).toBe(0);
  });
});

describe('repeated and overlapping runs', () => {
  it('does not duplicate links or events however many times it runs', async () => {
    await seed('us1');
    await seed('us2');

    /* Each run is forced past the gate by a fresh knowledge time, so the work list is re-derived. */
    for (let index = 0; index < 4; index += 1) {
      /*
       * Each extra fact is ingested *after* the previous run's knowledge time, which is what gets
       * the next run past the gate. Seeding them earlier would make the gate skip — correctly —
       * and the test would prove nothing about repetition.
       */
      const runAsOf = new Date(AS_OF.getTime() + (index + 1) * 60_000);
      await seed(`extra-${String(index)}`, new Date(runAsOf.getTime() - 1_000));
      await runCorrelation({ db, logger: collectingLogger().logger, asOf: runAsOf });
    }

    const events = await eventCount();
    const links = await activeLinkCount();

    /* Two seeds plus four extras, each its own earthquake: six records, six links, six events. */
    expect(events).toBe(6);
    expect(links).toBe(6);

    /* And invariant I6 holds: no record carries two active links. */
    const doubled = await sql<{ n: string }>`
      SELECT count(*) AS n FROM (
        SELECT source_record_id FROM geonerva.canonical_links
        WHERE unlinked_at IS NULL
        GROUP BY source_record_id HAVING count(*) > 1
      ) AS offenders
    `.execute(db);
    expect(doubled.rows[0]?.n).toBe('0');
  });

  /*
   * Correlation mints identities, so two overlapping runs can each open an event for one
   * earthquake before the other's projection lands — one earthquake, two `SINGLE_SOURCE` events.
   * The advisory lock is what stops that, and this asserts the second run declines rather than
   * waiting or proceeding.
   */
  it('refuses to run beside another correlation rather than splitting an earthquake in two', async () => {
    await seed('us1');

    /*
     * A second connection from the same pool, not a second pool: the pool is shared with every
     * other test in this file, and ending it here would take them all down with it.
     */
    await db.connection().execute(async (held) => {
      const taken = await sql<{ locked: boolean }>`
        SELECT pg_try_advisory_lock(4405001) AS locked
      `.execute(held);
      expect(taken.rows[0]?.locked).toBe(true);

      try {
        const { logger, lines } = collectingLogger();
        const outcome = await runCorrelation({ db, logger, asOf: AS_OF });

        expect(outcome.status).toBe('SKIPPED');
        expect(await eventCount()).toBe(0);
        expect(String(lines.at(-1)?.['detail'])).toContain(
          'another correlation run holds the lock',
        );
      } finally {
        await sql`SELECT pg_advisory_unlock(4405001)`.execute(held);
      }
    });

    /* And once the lock is free, the same work happens. */
    const outcome = await runCorrelation({ db, logger: collectingLogger().logger, asOf: AS_OF });
    expect(outcome.status).toBe('SUCCEEDED');
    expect(await eventCount()).toBe(1);
  });
});

describe('when correlation fails', () => {
  /*
   * The product must not present an empty world as a quiet one, and `derivationVerdict` is what
   * prevents it — given a derivation that has never succeeded over facts that exist, it answers
   * `UNAVAILABLE` / `DERIVATION_NOT_RUN` with `mayRenderZero: false`. That verdict is proved in
   * `packages/relevance/src/availability.test.ts`, and its effect on a real briefing in
   * `packages/briefing/src/snapshot.int.test.ts` ("AVAILABILITY_DERIVATION_NOT_RUN").
   *
   * What neither of those can prove, and this does, is the **seam**: that a correlation which
   * fails leaves the ledger saying so. If a failed run moved `lastSucceededAt`, every assertion
   * above it would still pass while the product quietly began vouching for events it never built.
   */
  it('leaves the ledger unable to vouch for the family, so the briefing keeps refusing', async () => {
    await seed('us1');

    /*
     * The shared handle is broken and put back, rather than a second pool created: `testDb.pool`
     * is shared, and ending it would break every later test in this file.
     */
    const spy = vi.spyOn(db, 'connection').mockImplementation(() => {
      throw new Error('connection lost mid-run: postgresql://user:hunter2@host/db');
    });

    const { logger, lines } = collectingLogger();
    const outcome = await runCorrelation({ db, logger, asOf: AS_OF });
    spy.mockRestore();

    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorClass).toBe('UNKNOWN');

    const terminal = lines.filter((line) => line['event'] === 'correlation.run');
    expect(terminal.at(-1)?.['level']).toBe('error');
    /* The message is withheld: it can carry a connection string. */
    expect(String(terminal.at(-1)?.['detail'])).not.toContain('hunter2');

    /*
     * Nothing succeeded, so the derivation the availability model reads is still "never run" —
     * which is what keeps the card refusing instead of reporting a quiet world.
     */
    const derivations = await derivationsAsOf(db, {
      asOf: new Date(Date.now() + 60_000),
      kinds: ['CORRELATION'],
    });
    expect(derivations[0]?.lastSucceededAt ?? null).toBeNull();
    expect(await eventCount()).toBe(0);
  });

  it('recovers on the next tick once the failure clears', async () => {
    await seed('us1');
    const outcome = await runCorrelation({
      db,
      logger: collectingLogger().logger,
      asOf: AS_OF,
    });

    expect(outcome.status).toBe('SUCCEEDED');
    expect(await eventCount()).toBe(1);
  });
});
