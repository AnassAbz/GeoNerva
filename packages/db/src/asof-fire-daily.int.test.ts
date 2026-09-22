/**
 * The daily fire aggregate read as of a knowledge time (ADR-040), against a real database.
 *
 * The rules under test: the latest row per key with `computed_at <= asOf` wins, so a correction is
 * invisible to a replay made before it; a day is covered only when **every** requested feed
 * recorded it `COVERED`; a cell counts when its centre lies within the radius, and the detections
 * of every requested feed are summed; every day of the window comes back, in order, with zero and
 * not covered where nothing is known; asking for no feeds asks nothing. And for
 * `fireProductsActiveThroughout`: only a feed whose whole lifetime spans the window may take part.
 */

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { fireDailyAsOf, fireProductsActiveThroughout } from './asof-fire-daily.ts';
import { createDb } from './client.ts';
import type { DB } from './generated/database.ts';
import type { FireDayState } from './repositories/fire-daily.ts';
import { setupTestDatabase, type TestDatabase } from './testing/test-database.ts';

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

const T0 = new Date('2026-06-15T10:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);

/** The day the aggregate rows in most of these tests are about. */
const DAY = '2026-06-10';

/*
 * The 0.25° grid of ADR-011. Cell 700528 is the band/column containing 31.63° N, 8.0° W, and its
 * centre — which is what the radius is measured to — is 31.625° N, 7.875° W. Cell 700529 is the
 * next column east, centred on 7.625° W: 23,718.9 m away along that parallel, measured with the
 * same geography type the read uses. The two radii below straddle it by ±19 m.
 */
const CELL = 700_528;
const CELL_EAST = 700_529;
const CELL_CENTRE = { lat: 31.625, lon: -7.875 };
const JUST_INSIDE_EAST = 23_800;
const JUST_OUTSIDE_EAST = 23_700;

async function productId(source: string, code: string): Promise<number> {
  const result = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products WHERE source_id = ${source} AND code = ${code}
  `.execute(db);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`no product ${source}/${code}`);
  return id;
}

/*
 * These two write the aggregate directly rather than through `recordFireDailyAggregate`.
 *
 * That writer judges a day exactly once and will not touch one it has already recorded, so it
 * cannot produce the second row of a correction — which is the very thing the as-of read exists to
 * resolve. The tables are append-only and stamped with a knowledge time; seeding them by hand is
 * how a correction, and a replay of the state before it, can be expressed at all.
 */
async function recordCoverage(
  product: number,
  options: { readonly day?: string; readonly computedAt: Date; readonly state: FireDayState },
): Promise<void> {
  await sql`
    INSERT INTO geonerva.fire_daily_coverage (product_id, day, computed_at, state)
    VALUES (${product}, ${options.day ?? DAY}::date, ${options.computedAt}, ${options.state})
  `.execute(db);
}

async function recordCount(
  product: number,
  options: {
    readonly cell?: number;
    readonly day?: string;
    readonly computedAt: Date;
    readonly n: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO geonerva.fire_daily_counts
      (cell_id, day, product_id, computed_at, n, n_high_conf, frp_sum)
    VALUES (${options.cell ?? CELL}, ${options.day ?? DAY}::date, ${product},
            ${options.computedAt}, ${options.n}, 0, 1.5)
  `.execute(db);
}

/** The read, asked about the single day `DAY` at the cell centre, wide enough to include it. */
async function readDay(
  asOf: Date,
  productIds: readonly number[],
  radiusM = 10_000,
): Promise<{ detections: number; covered: boolean }> {
  const rows = await fireDailyAsOf(db, {
    asOf,
    productIds,
    point: CELL_CENTRE,
    radiusM,
    from: DAY,
    to: DAY,
  });
  const row = rows[0];
  if (row === undefined) throw new Error('the read returned no row for the day it was asked about');
  return { detections: row.detections, covered: row.covered };
}

describe('fireDailyAsOf: what was known at T', () => {
  /**
   * The replay invariant, at the read that the fire trend rests on.
   *
   * Both tables are append-only: a day first judged unread and later corrected to read, and a count
   * later restated, are new rows with later `computed_at` values. A response GeoNerva issued at
   * 10:20 must still be reproducible at 10:20 after both corrections have landed — otherwise the
   * citation in it is a claim about a number that no longer exists.
   */
  it('reads the day as it stood at T, and never a correction made after it', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    await recordCoverage(noaa20, { computedAt: minutes(10), state: 'NOT_COVERED' });
    await recordCoverage(noaa20, { computedAt: minutes(30), state: 'COVERED' });
    await recordCount(noaa20, { computedAt: minutes(30), n: 4 });
    await recordCount(noaa20, { computedAt: minutes(50), n: 9 });

    // Before anything was judged at all.
    expect(await readDay(minutes(5), [noaa20])).toStrictEqual({ detections: 0, covered: false });
    // Judged, but not yet read: the absence of counts here is not a quiet day, and says so.
    expect(await readDay(minutes(20), [noaa20])).toStrictEqual({ detections: 0, covered: false });
    // After the correction to COVERED, with the count as it first stood.
    expect(await readDay(minutes(40), [noaa20])).toStrictEqual({ detections: 4, covered: true });
    // And only after the restatement does the larger number appear.
    expect(await readDay(minutes(60), [noaa20])).toStrictEqual({ detections: 9, covered: true });
  });

  it('includes a row computed exactly at T: the bound is inclusive', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    await recordCoverage(noaa20, { computedAt: minutes(30), state: 'COVERED' });
    await recordCount(noaa20, { computedAt: minutes(30), n: 4 });

    expect(await readDay(minutes(30), [noaa20])).toStrictEqual({ detections: 4, covered: true });
    expect(await readDay(new Date(minutes(30).getTime() - 1), [noaa20])).toStrictEqual({
      detections: 0,
      covered: false,
    });
  });
});

describe('fireDailyAsOf: coverage is unanimous or it is nothing', () => {
  /*
   * One satellite's unread day is not a quiet day for the pair. If NOAA-21 was not read, the
   * group's count for that day is missing a sensor's worth of detections, and comparing it with a
   * day both sensors were read for would show a drop that is entirely an artefact of the gap.
   */
  it('calls a day covered only when every requested feed recorded it COVERED', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await productId('firms', 'VIIRS_NOAA21_NRT');
    await recordCoverage(noaa20, { computedAt: minutes(10), state: 'COVERED' });
    await recordCoverage(noaa21, { computedAt: minutes(10), state: 'NOT_COVERED' });

    expect((await readDay(minutes(20), [noaa20, noaa21])).covered).toBe(false);
    // Asked about NOAA-20 alone, the same day is covered: the feed did read it.
    expect((await readDay(minutes(20), [noaa20])).covered).toBe(true);
  });

  it('does not count a MISSING_DATA day as covered either', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await productId('firms', 'VIIRS_NOAA21_NRT');
    await recordCoverage(noaa20, { computedAt: minutes(10), state: 'COVERED' });
    await recordCoverage(noaa21, { computedAt: minutes(10), state: 'MISSING_DATA' });

    expect((await readDay(minutes(20), [noaa20, noaa21])).covered).toBe(false);
  });

  it('is not covered when a feed never judged the day at all', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await productId('firms', 'VIIRS_NOAA21_NRT');
    await recordCoverage(noaa20, { computedAt: minutes(10), state: 'COVERED' });

    expect((await readDay(minutes(20), [noaa20, noaa21])).covered).toBe(false);
  });
});

describe('fireDailyAsOf: the radius and the feeds', () => {
  /*
   * A cell is in or out as a whole, judged by its centre — the grid is about 28 km across at the
   * equator, so the circle's edge is approximate by up to half a cell. What must be exact is the
   * rule: the centre, not the nearest corner, and not the cell the query point happens to sit in.
   */
  it('includes a cell whose centre is within the radius and excludes one just outside', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    await recordCoverage(noaa20, { computedAt: minutes(10), state: 'COVERED' });
    await recordCount(noaa20, { cell: CELL, computedAt: minutes(10), n: 3 });
    await recordCount(noaa20, { cell: CELL_EAST, computedAt: minutes(10), n: 5 });

    expect((await readDay(minutes(20), [noaa20], JUST_OUTSIDE_EAST)).detections).toBe(3);
    expect((await readDay(minutes(20), [noaa20], JUST_INSIDE_EAST)).detections).toBe(8);
  });

  it('sums the cells of every requested feed', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await productId('firms', 'VIIRS_NOAA21_NRT');
    for (const product of [noaa20, noaa21]) {
      await recordCoverage(product, { computedAt: minutes(10), state: 'COVERED' });
    }
    await recordCount(noaa20, { cell: CELL, computedAt: minutes(10), n: 3 });
    await recordCount(noaa21, { cell: CELL, computedAt: minutes(10), n: 4 });
    await recordCount(noaa21, { cell: CELL_EAST, computedAt: minutes(10), n: 5 });

    expect(await readDay(minutes(20), [noaa20, noaa21], JUST_INSIDE_EAST)).toStrictEqual({
      detections: 12,
      covered: true,
    });
    // NOAA-20 alone sees only its own three.
    expect((await readDay(minutes(20), [noaa20], JUST_INSIDE_EAST)).detections).toBe(3);
  });
});

describe('fireDailyAsOf: the shape of the window', () => {
  /*
   * A trend divides by the number of covered days, so a caller has to be able to tell a day with
   * no detections from a day that is not there. Dropping the empty days would make the second
   * indistinguishable from the first, which is the confusion ADR-040 exists to prevent.
   */
  it('returns every day of the window in order, zero and not covered where nothing is known', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    await recordCoverage(noaa20, { computedAt: minutes(10), state: 'COVERED' });
    await recordCount(noaa20, { computedAt: minutes(10), n: 7 });

    const rows = await fireDailyAsOf(db, {
      asOf: minutes(20),
      productIds: [noaa20],
      point: CELL_CENTRE,
      radiusM: 10_000,
      from: '2026-06-08',
      to: '2026-06-12',
    });

    expect(rows).toStrictEqual([
      { day: '2026-06-08', detections: 0, covered: false },
      { day: '2026-06-09', detections: 0, covered: false },
      { day: '2026-06-10', detections: 7, covered: true },
      { day: '2026-06-11', detections: 0, covered: false },
      { day: '2026-06-12', detections: 0, covered: false },
    ]);
  });

  it('ignores aggregate rows outside the window it was asked about', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    await recordCoverage(noaa20, { day: '2026-06-20', computedAt: minutes(10), state: 'COVERED' });
    await recordCount(noaa20, { day: '2026-06-20', computedAt: minutes(10), n: 7 });

    expect(await readDay(minutes(20), [noaa20])).toStrictEqual({ detections: 0, covered: false });
  });

  /* No feed spans the window, so there is nothing to compare — not a window of quiet days. */
  it('returns nothing when no feed is asked for', async () => {
    expect(
      await fireDailyAsOf(db, {
        asOf: minutes(20),
        productIds: [],
        point: CELL_CENTRE,
        radiusM: 10_000,
        from: '2026-06-08',
        to: '2026-06-12',
      }),
    ).toStrictEqual([]);
  });
});

describe('fireProductsActiveThroughout', () => {
  const FROM = new Date('2026-06-01T00:00:00.000Z');
  const TO = new Date('2026-06-30T00:00:00.000Z');

  /**
   * Runs `body` with a feed's lifecycle dates changed, and puts them back afterwards.
   *
   * `source_products` is seed data, and the harness's `truncate` deliberately leaves it standing —
   * so a test that edited a sensor's dates in place would leak the edit into every file that ran
   * after it.
   */
  async function withLifecycle<T>(
    product: number,
    dates: { readonly activeFrom?: string; readonly activeTo?: string },
    body: () => Promise<T>,
  ): Promise<T> {
    const before = await sql<{ active_from: string | null; active_to: string | null }>`
      SELECT active_from::text AS active_from, active_to::text AS active_to
      FROM geonerva.source_products WHERE id = ${product}
    `.execute(db);
    const saved = before.rows[0];
    if (saved === undefined) throw new Error(`no product ${product}`);
    try {
      await sql`
        UPDATE geonerva.source_products
        SET active_from = ${dates.activeFrom ?? saved.active_from}::date,
            active_to = ${dates.activeTo ?? saved.active_to}::date
        WHERE id = ${product}
      `.execute(db);
      return await body();
    } finally {
      await sql`
        UPDATE geonerva.source_products
        SET active_from = ${saved.active_from}::date, active_to = ${saved.active_to}::date
        WHERE id = ${product}
      `.execute(db);
    }
  }

  it('returns the feeds whose whole lifetime spans the window, ordered by id', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await productId('firms', 'VIIRS_NOAA21_NRT');
    expect(noaa20).toBeLessThan(noaa21);
    expect(await fireProductsActiveThroughout(db, { from: FROM, to: TO })).toStrictEqual([
      noaa20,
      noaa21,
    ]);
  });

  /*
   * ADR-009: a sensor that came online part-way through the window contributes detections to the
   * later days and none to the earlier ones, which reads as a rise in fire activity that is
   * really a second satellite. The comparison declines to use it rather than correcting for it.
   */
  it('excludes a sensor that came online inside the window', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await productId('firms', 'VIIRS_NOAA21_NRT');
    await withLifecycle(noaa21, { activeFrom: '2026-06-10' }, async () => {
      expect(await fireProductsActiveThroughout(db, { from: FROM, to: TO })).toStrictEqual([
        noaa20,
      ]);
    });
  });

  it('excludes a sensor retired inside the window', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await productId('firms', 'VIIRS_NOAA21_NRT');
    await withLifecycle(noaa20, { activeTo: '2026-06-20' }, async () => {
      expect(await fireProductsActiveThroughout(db, { from: FROM, to: TO })).toStrictEqual([
        noaa21,
      ]);
    });
  });

  /* A lifetime that meets the window's own edges covers it: the bounds are inclusive. */
  it('includes a sensor whose lifetime starts and ends exactly on the window', async () => {
    const noaa20 = await productId('firms', 'VIIRS_NOAA20_NRT');
    const noaa21 = await productId('firms', 'VIIRS_NOAA21_NRT');
    await withLifecycle(noaa21, { activeFrom: '2026-06-01', activeTo: '2026-06-30' }, async () => {
      expect(await fireProductsActiveThroughout(db, { from: FROM, to: TO })).toStrictEqual([
        noaa20,
        noaa21,
      ]);
    });
  });
});
