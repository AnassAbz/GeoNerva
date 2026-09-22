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
 * So coverage is what was actually fetched, in two kinds:
 *
 *  - **Backfill.** Every `DONE` interval of a `HISTORICAL` plan, checkpointed by `asOf` — marked
 *    `DONE` in the transaction that commits its facts (migration 0012). An interval claims no
 *    further than `completed_at`: a plan's `--to` can lie in the future, and a window cannot have
 *    been read past the moment its read finished.
 *  - **Live polling.** Chains of successful **scheduled** polls (`SUCCEEDED`, or `SKIPPED` — a
 *    not-modified answer is a read). A chain breaks wherever two consecutive polls are further
 *    apart than the source's own `fetchStaleAfterS`, the point at which GeoNerva itself calls the
 *    source stale; the hours inside such a gap were not being read. A chain reaches `asOf` only if
 *    its last poll is still within that bound of `asOf`. A failed poll, a `PARTIAL` one, a manual
 *    one-off and a deletion sweep (`RECONCILE`) establish nothing: none of them is evidence that
 *    the feed was being followed (P8 fix-verification review).
 *
 * `maxMinMagnitude` excludes plans that fetched only above a magnitude the caller will count
 * below: a plan for M5+ does not cover M4.5–5.0. `null` accepts every plan.
 *
 * Every direction of error here is towards less coverage, which a caller turns into a refusal,
 * never a count. One such direction is structural and recorded as ADR-041: ADR-033 keeps
 * `ingestion_runs` for 90 days on the lean profile, so once pruning is scheduled the live chains
 * older than that disappear, and a baseline reaching past them will refuse until coverage is kept
 * somewhere that outlives the runs.
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
    WITH polls AS (
      SELECT r.source_id,
             r.committed_at,
             make_interval(secs => (s.policy -> 'freshness' ->> 'fetchStaleAfterS')::double precision)
               AS max_gap,
             lag(r.committed_at) OVER (PARTITION BY r.source_id ORDER BY r.committed_at) AS previous
      FROM geonerva.ingestion_runs r
      JOIN geonerva.sources s ON s.id = r.source_id
      WHERE r.source_id = ANY(${sql.val(options.sourceIds)}::text[])
        AND r.trigger = 'SCHEDULE'
        AND r.status IN ('SUCCEEDED', 'SKIPPED')
        AND r.committed_at IS NOT NULL
        AND r.committed_at <= ${options.asOf}
    ),
    chained AS (
      SELECT polls.*,
             sum(CASE WHEN previous IS NULL OR committed_at - previous > max_gap THEN 1 ELSE 0 END)
               OVER (PARTITION BY source_id ORDER BY committed_at) AS chain
      FROM polls
    )
    SELECT i.interval_from AS from_at, LEAST(i.interval_to, i.completed_at) AS to_at
    FROM geonerva.backfill_intervals i
    JOIN geonerva.backfill_plans p ON p.id = i.plan_id
    WHERE p.mode = 'HISTORICAL'
      AND p.source_id = ANY(${sql.val(options.sourceIds)}::text[])
      AND i.status = 'DONE'
      AND i.completed_at <= ${options.asOf}
      AND ${magnitudeFilter}
    UNION ALL
    SELECT min(committed_at) AS from_at,
           CASE WHEN ${options.asOf}::timestamptz - max(committed_at) <= max(max_gap)
                THEN ${options.asOf}::timestamptz
                ELSE max(committed_at)
           END AS to_at
    FROM chained
    GROUP BY source_id, chain
  `.execute(db);
  return result.rows.map((row) => ({ from: row.from_at, to: row.to_at }));
}
