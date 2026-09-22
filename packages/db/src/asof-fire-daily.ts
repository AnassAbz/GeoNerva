/**
 * The daily fire aggregate, as of a knowledge time (ADR-040). Part of the as-of layer.
 */

import { sql, type Kysely } from 'kysely';

import { FIRE_GRID } from '@geonerva/domain';

import type { DB } from './generated/database.ts';

/** One UTC day of the trend: what was read, and how much was detected within the radius. */
export interface FireDailyRow {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  readonly detections: number;
  /** True only when every feed asked for recorded the whole day as read. */
  readonly covered: boolean;
}

/**
 * The feeds whose whole lifetime spans `[from, to]`, so a sensor added or retired inside the
 * window cannot change the comparison (ADR-009, ADR-040).
 */
export async function fireProductsActiveThroughout(
  db: Kysely<DB>,
  options: { readonly from: Date; readonly to: Date },
): Promise<number[]> {
  /*
   * The window's bounds are UTC days, and they are turned into UTC days *here* rather than left to
   * the driver. A `Date` is serialized with the calling process's local offset, so binding it
   * straight into `::date` asks about whatever calendar day it was in that timezone: on a machine
   * four hours behind UTC, a window starting at midnight UTC was checked against the day before.
   * The caller pairs this with `fireDailyAsOf`, which is given the same window as UTC day strings,
   * and the two have to be talking about the same days.
   */
  const from = options.from.toISOString().slice(0, 10);
  const to = options.to.toISOString().slice(0, 10);
  const result = await sql<{ id: number }>`
    SELECT id FROM geonerva.source_products
    WHERE source_id = 'firms'
      AND hazard_types && ARRAY['THERMAL_ACTIVITY']::text[]
      AND (active_from IS NULL OR active_from <= ${from}::date)
      AND (active_to IS NULL OR active_to >= ${to}::date)
    ORDER BY id
  `.execute(db);
  return result.rows.map((row) => row.id);
}

/**
 * Per-day detections and coverage for a set of feeds, as known at `asOf`.
 *
 * Both tables are append-only, so "as known at" is the latest row per key with
 * `computed_at <= asOf`. A day counts as covered only when **every** feed recorded it `COVERED`:
 * one sensor's missing day is not a quiet day for the group.
 *
 * Cells are included when their centre lies within the radius, on `FIRE_GRID`'s one definition of
 * that grid, so the edge of the circle is approximate by up to half a cell; the trend compares
 * one place with its own past through the same cells, which is what makes that acceptable.
 */
export async function fireDailyAsOf(
  db: Kysely<DB>,
  options: {
    readonly asOf: Date;
    readonly productIds: readonly number[];
    readonly point: { readonly lat: number; readonly lon: number };
    readonly radiusM: number;
    readonly from: string;
    readonly to: string;
  },
): Promise<FireDailyRow[]> {
  if (options.productIds.length === 0) return [];
  const result = await sql<{ day: string; detections: string; covered: boolean }>`
    WITH days AS (
      SELECT generate_series(${options.from}::date, ${options.to}::date, interval '1 day')::date AS day
    ),
    state AS (
      SELECT DISTINCT ON (c.product_id, c.day) c.product_id, c.day, c.state
      FROM geonerva.fire_daily_coverage c
      WHERE c.product_id = ANY(${sql.val(options.productIds)}::smallint[])
        AND c.computed_at <= ${options.asOf}
        AND c.day BETWEEN ${options.from}::date AND ${options.to}::date
      ORDER BY c.product_id, c.day, c.computed_at DESC
    ),
    counts AS (
      SELECT DISTINCT ON (n.cell_id, n.day, n.product_id) n.cell_id, n.day, n.product_id, n.n
      FROM geonerva.fire_daily_counts n
      WHERE n.product_id = ANY(${sql.val(options.productIds)}::smallint[])
        AND n.computed_at <= ${options.asOf}
        AND n.day BETWEEN ${options.from}::date AND ${options.to}::date
        AND ST_DWithin(
              ST_SetSRID(ST_MakePoint(
                (n.cell_id % ${sql.lit(FIRE_GRID.columns)}) * ${sql.lit(FIRE_GRID.degrees)}
                  - 180 + ${sql.lit(FIRE_GRID.degrees / 2)},
                (n.cell_id / ${sql.lit(FIRE_GRID.columns)}) * ${sql.lit(FIRE_GRID.degrees)}
                  - 90 + ${sql.lit(FIRE_GRID.degrees / 2)}
              ), 4326)::geography,
              ST_SetSRID(ST_MakePoint(${options.point.lon}, ${options.point.lat}), 4326)::geography,
              ${options.radiusM})
      ORDER BY n.cell_id, n.day, n.product_id, n.computed_at DESC
    )
    SELECT d.day::text AS day,
           COALESCE((SELECT sum(c.n) FROM counts c WHERE c.day = d.day), 0)::text AS detections,
           (SELECT count(*) FROM state s WHERE s.day = d.day AND s.state = 'COVERED')
             = ${options.productIds.length} AS covered
    FROM days d
    ORDER BY d.day
  `.execute(db);
  return result.rows.map((row) => ({
    day: row.day,
    detections: Number(row.detections),
    covered: row.covered,
  }));
}
