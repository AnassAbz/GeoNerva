/**
 * Reads the baselines need that no other view does (ARCHITECTURE §8). Part of the as-of layer,
 * re-exported through `@geonerva/db/asof`.
 */

import { sql, type Kysely } from 'kysely';

import type { DB } from './generated/database.ts';

/** A span of observation time GeoNerva had read a catalog for. Half-open: `[from, to)`. */
export interface CoverageSpan {
  readonly from: Date;
  readonly to: Date;
}

/**
 * The spans of observation time a set of sources had been **read** for, as known at `asOf`.
 *
 * A reference period is a claim that every window in it was looked at. The earliest record held
 * is not evidence of that: a backfill that finished 2016–2017 and then failed leaves eight years
 * unread, and counting them as quiet weeks makes an ordinary week "above typical" (P8 review H1).
 * So coverage is what was actually fetched:
 *
 *  - every `DONE` interval of a `HISTORICAL` backfill plan, checkpointed by `asOf` — an interval is
 *    marked `DONE` in the transaction that commits its facts (migration 0012), so it cannot claim
 *    a window whose records are not there; and
 *  - from the first committed **live** run (any trigger but `BACKFILL`) up to `asOf`, since
 *    polling from then on is what brought the recent catalog in.
 *
 * `maxMinMagnitude` excludes plans that fetched only above a magnitude the caller will count
 * below: a plan for M5+ does not cover M4.5–5.0. `null` accepts every plan.
 *
 * A live span does not know about outages inside it; source health reports those. It starts at the
 * first run rather than reaching back over the feed's own look-back, which is the conservative
 * direction — an uncovered hour is refused, never counted as quiet.
 */
export async function catalogCoverageAsOf(
  db: Kysely<DB>,
  options: {
    readonly asOf: Date;
    readonly sourceIds: readonly string[];
    readonly maxMinMagnitude: number | null;
  },
): Promise<CoverageSpan[]> {
  if (options.sourceIds.length === 0) return [];
  const magnitudeFilter =
    options.maxMinMagnitude === null
      ? sql`TRUE`
      : sql`(p.min_magnitude IS NULL OR p.min_magnitude <= ${options.maxMinMagnitude})`;
  const result = await sql<{ from_at: Date; to_at: Date }>`
    SELECT i.interval_from AS from_at, i.interval_to AS to_at
    FROM geonerva.backfill_intervals i
    JOIN geonerva.backfill_plans p ON p.id = i.plan_id
    WHERE p.mode = 'HISTORICAL'
      AND p.source_id = ANY(${sql.val(options.sourceIds)}::text[])
      AND i.status = 'DONE'
      AND i.completed_at <= ${options.asOf}
      AND ${magnitudeFilter}
    UNION ALL
    SELECT min(r.committed_at) AS from_at, ${options.asOf}::timestamptz AS to_at
    FROM geonerva.ingestion_runs r
    WHERE r.source_id = ANY(${sql.val(options.sourceIds)}::text[])
      AND r.trigger <> 'BACKFILL'
      AND r.committed_at IS NOT NULL
      AND r.committed_at <= ${options.asOf}
    HAVING min(r.committed_at) IS NOT NULL
  `.execute(db);
  return result.rows.map((row) => ({ from: row.from_at, to: row.to_at }));
}
