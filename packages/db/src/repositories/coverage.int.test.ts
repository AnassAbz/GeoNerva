/**
 * The coverage ledger's writers (ADR-041), against a real database.
 *
 * The rules under test: an hour is recorded only when a read window contains all of it; a window
 * that meets the frontier extends it and one that does not starts a new run, so a gap is never
 * bridged; the first `recorded_at` of an hour stands; a backfill interval claims no further than its
 * completion, only when `DONE` and `HISTORICAL`, for every feed of a product-less plan, and with its
 * magnitude floor.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DB } from '../index.ts';
import { setupTestDatabase, type TestDatabase } from '../testing/test-database.ts';
import { recordIntervalCoverage, recordLiveCoverage } from './coverage.ts';

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

const HOUR = 60 * 60 * 1000;
const at = (hours: number): Date => new Date(Date.UTC(2026, 8, 20) + hours * HOUR);

async function productId(source: string, code: string): Promise<number> {
  const result = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = ${source} AND code = ${code}
  `.execute(db);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`no product ${source}/${code}`);
  return id;
}

async function hours(product: number): Promise<{ hour: number; recordedAt: number }[]> {
  const result = await sql<{ hour: Date; recorded_at: Date; floor: string | null }>`
    SELECT hour, recorded_at, min_magnitude::text AS floor FROM geonerva.feed_coverage_hours
    WHERE product_id = ${product} ORDER BY hour
  `.execute(db);
  return result.rows.map((row) => ({
    hour: (row.hour.getTime() - at(0).getTime()) / HOUR,
    recordedAt: (row.recorded_at.getTime() - at(0).getTime()) / HOUR,
  }));
}

async function live(
  product: number,
  from: number,
  to: number,
  recordedAt: number,
): Promise<number> {
  return db.transaction().execute((trx) =>
    recordLiveCoverage(trx, {
      productId: product,
      window: { from: at(from), to: at(to) },
      recordedAt: at(recordedAt),
    }),
  );
}

describe('recordLiveCoverage', () => {
  it('records only whole hours inside the window, stamped with the poll', async () => {
    const usgs = await productId('usgs', 'comcat');
    // [00:30, 03:15): whole hours 01:00 and 02:00 only.
    await live(usgs, 0.5, 3.25, 3.3);
    expect(await hours(usgs)).toStrictEqual([
      { hour: 1, recordedAt: 3.3 },
      { hour: 2, recordedAt: 3.3 },
    ]);
  });

  it('completes the hour the frontier ended in when the next window meets it', async () => {
    const usgs = await productId('usgs', 'comcat');
    await live(usgs, 0, 2.5, 2.5); // hours 0, 1; 02:00 is half read
    await live(usgs, 2.25, 4.0, 4.0); // meets the frontier: 02:00 and 03:00 now whole
    expect(await hours(usgs)).toStrictEqual([
      { hour: 0, recordedAt: 2.5 },
      { hour: 1, recordedAt: 2.5 },
      { hour: 2, recordedAt: 4.0 },
      { hour: 3, recordedAt: 4.0 },
    ]);
  });

  it('chains short windows into whole hours when they overlap', async () => {
    // EMSC-like: fifteen-minute windows every five minutes.
    const emsc = await productId('emsc', 'rts');
    for (let minute = 15; minute <= 75; minute += 5) {
      await live(emsc, (minute - 15) / 60, minute / 60, minute / 60);
    }
    expect((await hours(emsc)).map((row) => row.hour)).toStrictEqual([0]);
  });

  it('never bridges a gap between windows that do not meet', async () => {
    const emsc = await productId('emsc', 'rts');
    await live(emsc, 0, 1.25, 1.25); // hour 0
    // A forty-minute lapse, then fifteen-minute windows again: 01:25–02:05 was never asked for.
    await live(emsc, 2.0 - 0.25 + 0.1, 2.1, 2.1);
    await live(emsc, 2.1 - 0.25, 3.05, 3.05);
    const recorded = (await hours(emsc)).map((row) => row.hour);
    expect(recorded).toContain(0);
    expect(recorded).not.toContain(1);
  });

  it('bridges a lapse its own look-back covers, recorded when that poll committed', async () => {
    // USGS-like 24-hour windows: a two-hour stop is read again by the next poll.
    const usgs = await productId('usgs', 'comcat');
    await live(usgs, -24, 10, 10);
    await live(usgs, -12, 14, 14);
    const byHour = new Map((await hours(usgs)).map((row) => [row.hour, row.recordedAt]));
    expect(byHour.get(9)).toBe(10);
    expect(byHour.get(11), 'the lapse, read by the later poll').toBe(14);
    expect(byHour.get(13)).toBe(14);
  });

  it('records the earlier hours when a poll reads further back than the run began', async () => {
    // A wider look-back after an outage: the run extends backwards, and only whole hours count.
    const usgs = await productId('usgs', 'comcat');
    await live(usgs, 4.5, 6, 6);
    await live(usgs, 1.5, 6.5, 6.5);
    expect((await hours(usgs)).map((row) => row.hour)).toStrictEqual([2, 3, 4, 5]);
  });

  it('never records the partial hour a run began in, however far later windows reach', async () => {
    /*
     * Polling resumed at 00:25 with fifteen-minute windows: 00:00–00:25 was never asked for, so
     * the 00:00 hour is not coverage no matter how many windows follow it.
     */
    const emsc = await productId('emsc', 'rts');
    for (let minute = 25; minute <= 180; minute += 5) {
      await live(emsc, (minute - 15) / 60, minute / 60, minute / 60);
    }
    expect((await hours(emsc)).map((row) => row.hour)).toStrictEqual([1, 2]);
  });

  it('keeps the first recorded_at of an hour forever', async () => {
    const usgs = await productId('usgs', 'comcat');
    await live(usgs, 0, 3, 3);
    await live(usgs, 0, 3, 9);
    expect((await hours(usgs)).map((row) => row.recordedAt)).toStrictEqual([3, 3, 3]);
  });

  it('keeps each feed to itself', async () => {
    const floods = await productId('gdacs', 'FL');
    const quakes = await productId('gdacs', 'EQ');
    await live(quakes, 0, 5, 5);
    expect(await hours(floods)).toStrictEqual([]);
  });
});

describe('recordIntervalCoverage', () => {
  async function interval(options: {
    readonly source: string;
    readonly productCode?: string;
    readonly mode?: 'HISTORICAL' | 'DELETION_SWEEP';
    readonly status?: 'DONE' | 'SPLIT' | 'PENDING';
    readonly from: number;
    readonly to: number;
    readonly completedAt: number | null;
    readonly minMagnitude?: number;
  }): Promise<number> {
    const product =
      options.productCode === undefined
        ? null
        : await productId(options.source, options.productCode);
    const plan = await sql<{ id: string }>`
      INSERT INTO geonerva.backfill_plans
        (id, source_id, product_id, mode, range_from, range_to, min_magnitude, window_ms,
         min_window_ms, status)
      VALUES (gen_random_uuid(), ${options.source}, ${product}, ${options.mode ?? 'HISTORICAL'},
              ${at(options.from)}, ${at(options.to)}, ${options.minMagnitude ?? null}, 3600000,
              3600000, 'RUNNING')
      RETURNING id::text AS id
    `.execute(db);
    const planId = plan.rows[0]?.id ?? '';
    await sql`
      INSERT INTO geonerva.backfill_intervals (plan_id, interval_from, interval_to, status, completed_at)
      VALUES (${planId}::uuid, ${at(options.from)}, ${at(options.to)}, ${options.status ?? 'DONE'},
              ${options.completedAt === null ? null : at(options.completedAt)})
    `.execute(db);
    return db
      .transaction()
      .execute((trx) =>
        recordIntervalCoverage(trx, { planId, from: at(options.from), to: at(options.to) }),
      );
  }

  it('records the whole hours a finished interval read, at its completion', async () => {
    const usgs = await productId('usgs', 'comcat');
    await interval({ source: 'usgs', productCode: 'comcat', from: 0, to: 3, completedAt: 30 });
    expect(await hours(usgs)).toStrictEqual([
      { hour: 0, recordedAt: 30 },
      { hour: 1, recordedAt: 30 },
      { hour: 2, recordedAt: 30 },
    ]);
  });

  it('claims nothing past the moment the read finished', async () => {
    const usgs = await productId('usgs', 'comcat');
    // A `--to` in the future: the interval completed at 02:00, so 02:00 onward was not read.
    await interval({ source: 'usgs', productCode: 'comcat', from: 0, to: 48, completedAt: 2 });
    expect((await hours(usgs)).map((row) => row.hour)).toStrictEqual([0, 1]);
  });

  it('records nothing for an interval that is split, pending, or a deletion sweep', async () => {
    const usgs = await productId('usgs', 'comcat');
    expect(
      await interval({
        source: 'usgs',
        productCode: 'comcat',
        status: 'SPLIT',
        from: 0,
        to: 5,
        completedAt: 6,
      }),
    ).toBe(0);
    expect(
      await interval({
        source: 'usgs',
        productCode: 'comcat',
        status: 'PENDING',
        from: 10,
        to: 15,
        completedAt: null,
      }),
    ).toBe(0);
    expect(
      await interval({
        source: 'usgs',
        productCode: 'comcat',
        mode: 'DELETION_SWEEP',
        from: 20,
        to: 25,
        completedAt: 26,
      }),
    ).toBe(0);
    expect(await hours(usgs)).toStrictEqual([]);
  });

  it('covers every feed of a product-less plan, and keeps the plan magnitude floor', async () => {
    await interval({ source: 'gdacs', from: 0, to: 2, completedAt: 3, minMagnitude: 5.5 });
    const floors = await sql<{ code: string; n: string; floor: string | null }>`
      SELECT p.code, count(*)::text AS n, max(h.min_magnitude)::text AS floor
      FROM geonerva.feed_coverage_hours h JOIN geonerva.source_products p ON p.id = h.product_id
      WHERE p.source_id = 'gdacs' GROUP BY p.code ORDER BY p.code
    `.execute(db);
    expect(floors.rows.map((row) => row.code)).toStrictEqual(['DR', 'EQ', 'FL', 'TC', 'VO', 'WF']);
    expect(floors.rows.every((row) => row.n === '2' && row.floor === '5.50')).toBe(true);
  });
});
