/**
 * The daily fire aggregate `FIRE_TREND` reads, and what a day's coverage means (ADR-040).
 *
 * Raw detections live 72 hours on the lean profile, so a 35-day comparison has to read an
 * aggregate. Two things make that aggregate honest rather than merely small:
 *
 *  - **A day is written once, when it is final.** The UTC day is over and it has left the FIRMS
 *    `DAY_RANGE` window, so no further detection for it can arrive. Nothing is ever updated, so a
 *    replay reads the day as it stood at T. The tables are keyed by `computed_at`, so a correction
 *    is expressible as a later row — but **nothing in v1 writes one**: this function skips any day
 *    already recorded, and a day's detections are dropped with their partition soon after it is
 *    aggregated, so there would be nothing left to recount from.
 *  - **Coverage is recorded beside the counts.** A day GeoNerva did not read every hour of, or that
 *    FIRMS reported no satellite data for, is not a day with no fires. Only a `COVERED` day's
 *    absence of rows means zero.
 */

import { sql, type Kysely, type Transaction } from 'kysely';

import { FIRE_GRID } from '@geonerva/domain';

import type { DB } from '../generated/database.ts';

type Db = Kysely<DB> | Transaction<DB>;

/** ADR-011's grid, as SQL over a detection's own columns, from the one definition of it. */
const CELL_ID = sql`(
  floor((d.lat + 90) / ${sql.lit(FIRE_GRID.degrees)})::int * ${sql.lit(FIRE_GRID.columns)}
  + floor((d.lon + 180) / ${sql.lit(FIRE_GRID.degrees)})::int
)`;

export type FireDayState = 'COVERED' | 'MISSING_DATA' | 'NOT_COVERED';

/**
 * Computes and records every final day a feed has not been aggregated for yet.
 *
 * `finalAfterDays` is how long a day stays inside the FIRMS fetch window: with `DAY_RANGE = 2` a
 * day is still re-read throughout the next day, so it is final two days after it started. The
 * detections it needs are within the 72-hour retention for exactly that long, which is why this
 * runs after every FIRMS ingestion rather than nightly.
 */
export async function recordFireDailyAggregate(
  db: Db,
  input: {
    readonly productId: number;
    readonly now: Date;
    readonly finalAfterDays?: number;
    /** How many final days to look back over, for a worker that was down. */
    readonly lookBackDays?: number;
  },
): Promise<{ readonly days: number; readonly cells: number }> {
  const finalAfter = input.finalAfterDays ?? 2;
  const lookBack = input.lookBackDays ?? 5;

  const days = await sql<{ day: string; state: FireDayState }>`
    WITH candidate AS (
      SELECT (date_trunc('day', ${input.now}::timestamptz) - make_interval(days => g))::date AS day
      -- Both bounds are cast: two untyped parameters leave generate_series ambiguous between its
      -- integer, numeric and timestamp forms, and PostgreSQL refuses the call outright with
      -- 42725, "function generate_series(unknown, unknown) is not unique".
      FROM generate_series(${finalAfter}::int, ${finalAfter + lookBack}::int) AS g
    ),
    already AS (
      SELECT DISTINCT day FROM geonerva.fire_daily_coverage WHERE product_id = ${input.productId}
    ),
    judged AS (
      SELECT c.day,
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM geonerva.fire_missing_data_days m
                 WHERE m.product_id = ${input.productId} AND m.day = c.day
               ) THEN 'MISSING_DATA'
               -- No partition, no detections to count. Retention drops whole daily partitions
               -- (ADR-018), so a day whose partition is gone can never be aggregated: recording it
               -- COVERED would publish its absent rows as a quiet day. Declining to compare is the
               -- conservative error, and the same answer covers a day GeoNerva never stored at all.
               WHEN NOT EXISTS (
                 SELECT 1
                 FROM pg_class pc
                 JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                 WHERE pn.nspname = 'geonerva'
                   AND pc.relname = 'fire_detections_' || to_char(c.day, 'YYYYMMDD')
               ) THEN 'NOT_COVERED'
               -- DISTINCT because the ledger is keyed by hour *and* magnitude floor: one hour
               -- recorded under two floors is still one hour read, and counting rows would call a
               -- half-read day complete. FIRMS is never read with a floor today, so this is a
               -- guard against a future feed rather than a live defect.
               WHEN (
                 SELECT count(DISTINCT h.hour) FROM geonerva.feed_coverage_hours h
                 WHERE h.product_id = ${input.productId}
                   AND h.recorded_at <= ${input.now}
                   AND h.hour >= c.day::timestamptz
                   AND h.hour < c.day::timestamptz + interval '1 day'
               ) = 24 THEN 'COVERED'
               ELSE 'NOT_COVERED'
             END AS state
      FROM candidate c
      WHERE c.day NOT IN (SELECT day FROM already)
    )
    INSERT INTO geonerva.fire_daily_coverage (product_id, day, computed_at, state)
    SELECT ${input.productId}, day, ${input.now}, state FROM judged
    RETURNING day::text AS day, state
  `.execute(db);

  /*
   * Sorted, because the `acquired_at` bounds below are a *range* and the candidate days arrive
   * newest first — `generate_series` counts the offset upward, so the day it produces counts
   * downward. Unsorted, `>= covered[0] AND < covered[last] + 1 day` is an empty interval the
   * moment two days are covered at once, and every count for them is silently dropped. Two days
   * at once is the ordinary case for the `lookBackDays` sweep after a worker was down.
   * `YYYY-MM-DD` sorts lexicographically exactly as it sorts chronologically.
   */
  const covered = days.rows
    .filter((row) => row.state === 'COVERED')
    .map((row) => row.day)
    .sort();
  if (covered.length === 0) return { days: days.rows.length, cells: 0 };

  const cells = await sql`
    INSERT INTO geonerva.fire_daily_counts
      (cell_id, day, product_id, computed_at, n, n_high_conf, frp_sum)
    SELECT ${CELL_ID}, d.acquired_at::date, ${input.productId}, ${input.now},
           count(*)::int,
           count(*) FILTER (WHERE d.confidence_class = 'HIGH')::int,
           sum(d.frp)::real
    FROM geonerva.fire_detections d
    WHERE d.product_id = ${input.productId}
      AND d.acquired_at >= ${covered[0]}::date
      AND d.acquired_at < (${covered[covered.length - 1]}::date + interval '1 day')
      AND d.acquired_at::date = ANY(${sql.val(covered)}::date[])
      AND d.ingested_at <= ${input.now}
    GROUP BY 1, 2
  `.execute(db);

  return { days: days.rows.length, cells: Number(cells.numAffectedRows ?? 0n) };
}
