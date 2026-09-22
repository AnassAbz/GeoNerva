/**
 * The daily fire aggregate's writer (ADR-040), against a real database.
 *
 * The rules under test: only a **final** day is judged, and today and yesterday never are; a day is
 * `COVERED` only when the ADR-041 ledger holds all twenty-four of its hours, recorded by the moment
 * the writer judges; a day FIRMS reported no satellite data for is `MISSING_DATA` however well
 * GeoNerva read it; a day whose detection partition retention has dropped is never `COVERED`; a day
 * is judged once and never again; counts are per 0.25° cell, day and feed, exclude detections that
 * arrived after the judging moment, and exist only for `COVERED` days.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DB } from '../index.ts';
import { setupTestDatabase, type TestDatabase } from '../testing/test-database.ts';
import { recordLiveCoverage } from './coverage.ts';
import { recordFireDailyAggregate, type FireDayState } from './fire-daily.ts';
import {
  bulkInsertDetections,
  dropDetectionPartitionsBefore,
  recordMissingDataDay,
} from './fire.ts';

let testDb: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  testDb = await setupTestDatabase();
  db = createDb(testDb.pool);
}, 120_000);

afterAll(async () => {
  await db.destroy();
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Midnight UTC of the day the writer is run in, and the moment it judges from.
 *
 * Deliberately months away from the wall clock: migration 0005 pre-creates a window of detection
 * partitions around the deployment date, and a test that asserts "this day has no partition" must
 * not be at the mercy of what day the suite happens to run on.
 */
const TODAY = Date.UTC(2026, 5, 15);
const NOW = new Date(TODAY + 12 * HOUR_MS);

/** Midnight UTC of the day `n` days before `TODAY`. `dayStart(2)` is the first final day. */
const dayStart = (n: number): Date => new Date(TODAY - n * DAY_MS);

/** `YYYY-MM-DD` for the day `n` days before `TODAY`, as the aggregate spells it. */
const dayName = (n: number): string => dayStart(n).toISOString().slice(0, 10);

/*
 * The 0.25° grid of ADR-011, spelled out for one pixel so that a change to the arithmetic cannot
 * pass unnoticed: 31.63° N falls in band floor((31.63 + 90) / 0.25) = 486 and 8.0° W in column
 * floor((-8.0 + 180) / 0.25) = 688, so the cell is 486 × 1440 + 688 = 700528. The cell one column
 * east (8.0° W → 7.6° W) is 700529.
 */
const CELL = 700_528;
const CELL_EAST = 700_529;

beforeEach(async () => {
  await testDb.truncate();
  /*
   * Partitions are tables, not rows, so `truncate` leaves them standing — and migration 0005
   * creates a week of them around the deployment date. Retention's own entry point clears
   * everything before the window this file works in, which is what makes "this day has no
   * partition" a state a test can assert rather than a coincidence.
   */
  await dropDetectionPartitionsBefore(db, dayStart(-2));
});

async function productId(source: string, code: string): Promise<number> {
  const result = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = ${source} AND code = ${code}
  `.execute(db);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`no product ${source}/${code}`);
  return id;
}

/**
 * Records a whole UTC day in the ADR-041 ledger through the live writer, so the hours under test
 * are the ones a real poll would have produced rather than hand-placed rows.
 *
 * A window from one midnight to the next completes exactly the day's twenty-four whole hours;
 * `fromHour` starts it later, which leaves the day one hour short. Returns the number of hours
 * written, which the tests assert so that a wrong fixture fails loudly rather than quietly.
 */
async function coverDay(
  product: number,
  day: number,
  options: { readonly fromHour?: number; readonly recordedAt?: Date } = {},
): Promise<number> {
  const from = new Date(dayStart(day).getTime() + (options.fromHour ?? 0) * HOUR_MS);
  return db.transaction().execute((trx) =>
    recordLiveCoverage(trx, {
      productId: product,
      window: { from, to: dayStart(day - 1) },
      recordedAt: options.recordedAt ?? NOW,
    }),
  );
}

interface DetectionSpec {
  /** Days before `TODAY`; the detection is acquired at midday of it. */
  readonly day: number;
  readonly lat: number;
  readonly lon: number;
  readonly frp: number;
  readonly confidence?: 'LOW' | 'NOMINAL' | 'HIGH';
  /** When GeoNerva stored it. Defaults to the acquisition, i.e. well before `NOW`. */
  readonly ingestedAt?: Date;
}

/** Seeds detections through the production writer, which also creates the daily partitions. */
async function detect(product: number, specs: readonly DetectionSpec[]): Promise<void> {
  await bulkInsertDetections(
    db,
    specs.map((spec) => {
      const acquiredAt = new Date(dayStart(spec.day).getTime() + 12 * HOUR_MS);
      return {
        productId: product,
        acquiredAt,
        lat: spec.lat,
        lon: spec.lon,
        confidenceClass: spec.confidence ?? 'NOMINAL',
        confidenceRaw: 'n',
        frp: spec.frp,
        brightTi4: null,
        brightTi5: null,
        scan: null,
        track: null,
        daynight: 'D' as const,
        providerVersion: '2.0NRT',
        ingestedAt: spec.ingestedAt ?? acquiredAt,
      };
    }),
  );
}

async function coverage(product: number): Promise<{ day: string; state: FireDayState }[]> {
  const result = await sql<{ day: string; state: FireDayState }>`
    SELECT day::text AS day, state FROM geonerva.fire_daily_coverage
    WHERE product_id = ${product} ORDER BY day
  `.execute(db);
  return result.rows;
}

/** The state recorded for one day, or `undefined` when the writer declined to judge it. */
async function stateOf(product: number, day: number): Promise<FireDayState | undefined> {
  return (await coverage(product)).find((row) => row.day === dayName(day))?.state;
}

interface CountRow {
  readonly cell: number;
  readonly day: string;
  readonly n: number;
  readonly high: number;
  readonly frp: number | null;
}

async function counts(product: number): Promise<CountRow[]> {
  const result = await sql<{
    cell_id: number;
    day: string;
    n: number;
    n_high_conf: number;
    frp_sum: number | null;
  }>`
    SELECT cell_id, day::text AS day, n, n_high_conf, frp_sum FROM geonerva.fire_daily_counts
    WHERE product_id = ${product} ORDER BY day, cell_id
  `.execute(db);
  return result.rows.map((row) => ({
    cell: row.cell_id,
    day: row.day,
    n: row.n,
    high: row.n_high_conf,
    frp: row.frp_sum,
  }));
}

describe('recordFireDailyAggregate: which days it will judge at all', () => {
  /*
   * FIRMS re-reads a day for the whole of the next one (`DAY_RANGE = 2`), so a detection for
   * yesterday can still arrive today. Judging either would freeze a number that is still moving.
   */
  it('judges only the days that have left the FIRMS fetch window', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const written = await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });

    expect(written.days).toBe(6);
    expect((await coverage(noaa20)).map((row) => row.day)).toStrictEqual([
      dayName(7),
      dayName(6),
      dayName(5),
      dayName(4),
      dayName(3),
      dayName(2),
    ]);
    expect(await stateOf(noaa20, 0)).toBeUndefined();
    expect(await stateOf(noaa20, 1)).toBeUndefined();
  });

  it('looks no further back than it is asked to', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const written = await recordFireDailyAggregate(db, {
      productId: noaa20,
      now: NOW,
      finalAfterDays: 2,
      lookBackDays: 1,
    });
    expect(written.days).toBe(2);
    expect((await coverage(noaa20)).map((row) => row.day)).toStrictEqual([dayName(3), dayName(2)]);
  });
});

describe('recordFireDailyAggregate: what a day is worth', () => {
  it('calls a day COVERED only when the ledger holds all twenty-four of its hours', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    expect(await coverDay(noaa20, 2)).toBe(24);
    // Polling resumed at 01:00: 00:00–01:00 was never asked for, so the day was not read.
    expect(await coverDay(noaa20, 3, { fromHour: 1 })).toBe(23);
    await detect(noaa20, [
      { day: 2, lat: 31.63, lon: -8.0, frp: 1 },
      { day: 3, lat: 31.63, lon: -8.0, frp: 1 },
    ]);

    await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });

    expect(await stateOf(noaa20, 2)).toBe('COVERED');
    expect(await stateOf(noaa20, 3)).toBe('NOT_COVERED');
  });

  /*
   * The ledger is keyed by hour **and** magnitude floor, so the same hour can hold more than one
   * row: a feed read under two floors is two claims about one hour. Counting rows rather than
   * distinct hours would let twelve hours read twice add up to twenty-four and call a half-read day
   * complete — a whole quiet half-day published as fact. No FIRMS feed carries a floor today, so
   * this asserts the guard against the feed that eventually does.
   */
  it('counts an hour once however many magnitude floors vouched for it', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const day = dayStart(2);
    for (const floor of [null, 4.5]) {
      for (let hour = 0; hour < 12; hour += 1) {
        await sql`
          INSERT INTO geonerva.feed_coverage_hours (product_id, hour, recorded_at, min_magnitude)
          VALUES (${noaa20}, ${new Date(day.getTime() + hour * HOUR_MS)}, ${NOW}, ${floor})
        `.execute(db);
      }
    }
    const rows = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM geonerva.feed_coverage_hours WHERE product_id = ${noaa20}
    `.execute(db);
    // Twenty-four rows, twelve hours: the fixture is the trap the guard exists for.
    expect(rows.rows[0]?.n).toBe('24');
    await detect(noaa20, [{ day: 2, lat: 31.63, lon: -8.0, frp: 1 }]);

    await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });

    expect(await stateOf(noaa20, 2)).toBe('NOT_COVERED');
    expect(await counts(noaa20)).toEqual([]);
  });

  /*
   * The ledger is append-only precisely so that a replay reads what was known at T. The writer is
   * a reader of it like any other: an hour a later poll vouched for is not evidence about a
   * judgement made before that poll committed.
   */
  it('ignores ledger hours recorded after the moment it judges', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await productId('firms', 'VIIRS_NOAA21_NRT');
    const late = new Date(NOW.getTime() + HOUR_MS);
    // The same day, read the same way, on two feeds — the ledger stamped an hour after `NOW`.
    expect(await coverDay(noaa20, 2, { recordedAt: late })).toBe(24);
    expect(await coverDay(noaa21, 2, { recordedAt: late })).toBe(24);
    await detect(noaa20, [{ day: 2, lat: 31.63, lon: -8.0, frp: 1 }]);
    await detect(noaa21, [{ day: 2, lat: 31.63, lon: -8.0, frp: 1 }]);

    await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });
    expect(await stateOf(noaa20, 2)).toBe('NOT_COVERED');

    // Judged two hours later, the very same hours are knowledge, and the day reads as covered.
    await recordFireDailyAggregate(db, {
      productId: noaa21,
      now: new Date(NOW.getTime() + 2 * HOUR_MS),
    });
    expect(await stateOf(noaa21, 2)).toBe('COVERED');
  });

  /*
   * FIRMS saying there was no satellite data outranks GeoNerva's own reading: polling the feed
   * every hour of a day the satellite did not deliver is a complete read of nothing.
   */
  it('records MISSING_DATA even when the ledger covers the whole day', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    expect(await coverDay(noaa20, 2)).toBe(24);
    await detect(noaa20, [{ day: 2, lat: 31.63, lon: -8.0, frp: 1 }]);
    await recordMissingDataDay(db, noaa20, dayStart(2));

    await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });

    expect(await stateOf(noaa20, 2)).toBe('MISSING_DATA');
    expect(await counts(noaa20)).toStrictEqual([]);
  });

  /*
   * Retention drops whole partitions (ADR-018), and a dropped day's rows are simply gone. Calling
   * such a day COVERED would publish its absent detections as a quiet day — the one error this
   * aggregate exists to prevent — so the ledger's twenty-four hours do not save it.
   */
  it('never calls a day whose partition retention has dropped COVERED', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    expect(await coverDay(noaa20, 2)).toBe(24);
    await detect(noaa20, [{ day: 2, lat: 31.63, lon: -8.0, frp: 1 }]);

    const retention = await dropDetectionPartitionsBefore(db, dayStart(1));
    expect(retention.dropped).toContain(`fire_detections_${dayName(2).replaceAll('-', '')}`);

    await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });

    expect(await stateOf(noaa20, 2)).toBe('NOT_COVERED');
    expect(await counts(noaa20)).toStrictEqual([]);
  });
});

describe('recordFireDailyAggregate: append-only and judged once', () => {
  it('leaves a day it has already judged alone and adds only what has since become final', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    expect(await coverDay(noaa20, 2)).toBe(24);
    await detect(noaa20, [{ day: 2, lat: 31.63, lon: -8.0, frp: 3 }]);

    const first = await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });
    expect(first.days).toBe(6);
    expect(first.cells).toBe(1);

    /*
     * A day later. `dayStart(1)` has become final, so it is judged for the first time; the six days
     * already on the ledger are not looked at again, however much better the evidence for them has
     * become since.
     */
    expect(await coverDay(noaa20, 1)).toBe(24);
    await detect(noaa20, [{ day: 1, lat: 31.63, lon: -8.0, frp: 5 }]);
    const later = new Date(NOW.getTime() + DAY_MS);
    const second = await recordFireDailyAggregate(db, { productId: noaa20, now: later });
    expect(second.days).toBe(1);

    const rows = await sql<{ day: string; computed_at: Date; n: string }>`
      SELECT day::text AS day, min(computed_at) AS computed_at, count(*)::text AS n
      FROM geonerva.fire_daily_coverage WHERE product_id = ${noaa20}
      GROUP BY day ORDER BY day
    `.execute(db);
    expect(rows.rows).toHaveLength(7);
    expect(rows.rows.every((row) => row.n === '1')).toBe(true);
    expect(rows.rows.find((row) => row.day === dayName(2))?.computed_at).toStrictEqual(NOW);
    expect(rows.rows.find((row) => row.day === dayName(1))?.computed_at).toStrictEqual(later);

    // One count row per covered day, and no second copy of the first day's.
    expect(await counts(noaa20)).toStrictEqual([
      { cell: CELL, day: dayName(2), n: 1, high: 0, frp: 3 },
      { cell: CELL, day: dayName(1), n: 1, high: 0, frp: 5 },
    ]);
  });
});

describe('recordFireDailyAggregate: the counts', () => {
  it('counts per cell, per day and per feed, and only what had arrived', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    expect(await coverDay(noaa20, 2)).toBe(24);
    await detect(noaa20, [
      { day: 2, lat: 31.63, lon: -8.0, frp: 1, confidence: 'HIGH' },
      { day: 2, lat: 31.64, lon: -8.0, frp: 2, confidence: 'HIGH' },
      { day: 2, lat: 31.65, lon: -8.0, frp: 4, confidence: 'NOMINAL' },
      /*
       * A late arrival: acquired on the day, stored an hour after the writer judged. Counting it
       * would make the same replay return two different numbers depending on when it was asked.
       */
      {
        day: 2,
        lat: 31.66,
        lon: -8.0,
        frp: 8,
        confidence: 'HIGH',
        ingestedAt: new Date(NOW.getTime() + HOUR_MS),
      },
      // One column east: a different cell, not a different day.
      { day: 2, lat: 31.63, lon: -7.6, frp: 16, confidence: 'LOW' },
    ]);

    const written = await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });

    expect(written.cells).toBe(2);
    expect(await counts(noaa20)).toStrictEqual([
      { cell: CELL, day: dayName(2), n: 3, high: 2, frp: 7 },
      { cell: CELL_EAST, day: dayName(2), n: 1, high: 0, frp: 16 },
    ]);
  });

  /*
   * ADR-009: a sensor's contribution stays separable, so that a satellite added or retired mid
   * window cannot manufacture a trend. Two satellites see the same fire; that is two counts.
   */
  it('keeps each feed to itself', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await productId('firms', 'VIIRS_NOAA21_NRT');
    expect(await coverDay(noaa20, 2)).toBe(24);
    await detect(noaa20, [{ day: 2, lat: 31.63, lon: -8.0, frp: 1 }]);
    await detect(noaa21, [{ day: 2, lat: 31.63, lon: -8.0, frp: 1 }]);

    await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });

    expect(await counts(noaa20)).toHaveLength(1);
    expect(await counts(noaa21)).toStrictEqual([]);
    expect(await coverage(noaa21)).toStrictEqual([]);
  });

  /*
   * Only a COVERED day's absence of rows means zero. A day GeoNerva did not read every hour of, or
   * that FIRMS had no satellite data for, is excluded from the comparison entirely — so writing
   * counts for it would put a number where the aggregate has agreed to stay silent.
   */
  it('writes count rows only for the days it recorded COVERED', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    expect(await coverDay(noaa20, 2)).toBe(24);
    expect(await coverDay(noaa20, 3, { fromHour: 1 })).toBe(23);
    expect(await coverDay(noaa20, 4)).toBe(24);
    await recordMissingDataDay(db, noaa20, dayStart(4));
    await detect(noaa20, [
      { day: 2, lat: 31.63, lon: -8.0, frp: 1 },
      { day: 3, lat: 31.63, lon: -8.0, frp: 1 },
      { day: 4, lat: 31.63, lon: -8.0, frp: 1 },
    ]);

    await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });

    expect(await stateOf(noaa20, 3)).toBe('NOT_COVERED');
    expect(await stateOf(noaa20, 4)).toBe('MISSING_DATA');
    expect((await counts(noaa20)).map((row) => row.day)).toStrictEqual([dayName(2)]);
  });

  /**
   * More than one day can become final in the same call — a worker that was down for a day, or the
   * `lookBackDays` sweep that exists for exactly that case — and every one of them must be counted.
   *
   * This is not a hypothetical: the counts insert bounds `acquired_at` by the first and last entry
   * of the covered list, which is only a range if that list is in ascending order.
   */
  it('counts every covered day when several become final at once', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    expect(await coverDay(noaa20, 2)).toBe(24);
    expect(await coverDay(noaa20, 3)).toBe(24);
    expect(await coverDay(noaa20, 4)).toBe(24);
    await detect(noaa20, [
      { day: 2, lat: 31.63, lon: -8.0, frp: 1 },
      { day: 3, lat: 31.63, lon: -8.0, frp: 2 },
      { day: 4, lat: 31.63, lon: -8.0, frp: 4 },
    ]);

    const written = await recordFireDailyAggregate(db, { productId: noaa20, now: NOW });

    expect(await stateOf(noaa20, 2)).toBe('COVERED');
    expect(await stateOf(noaa20, 3)).toBe('COVERED');
    expect(await stateOf(noaa20, 4)).toBe('COVERED');
    expect(written.cells).toBe(3);
    expect(await counts(noaa20)).toStrictEqual([
      { cell: CELL, day: dayName(4), n: 1, high: 0, frp: 4 },
      { cell: CELL, day: dayName(3), n: 1, high: 0, frp: 2 },
      { cell: CELL, day: dayName(2), n: 1, high: 0, frp: 1 },
    ]);
  });
});
