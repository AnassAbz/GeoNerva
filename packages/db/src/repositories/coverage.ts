/**
 * The coverage ledger's writers (ADR-041). See migration 0017 for the two tables and why one is a
 * fact and the other operational state.
 *
 * An hour is recorded only when a read window GeoNerva completed contains all of it, and its
 * `recorded_at` is the moment that became true — the commit of the poll that completed it, or the
 * completion of the backfill interval that read it. The first writer of an hour stands forever
 * (`ON CONFLICT DO NOTHING`), so a replay at T reads exactly what was known at T.
 */

import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../generated/database.ts';

type Db = Kysely<DB> | Transaction<DB>;

const HOUR_MS = 60 * 60 * 1000;

/** The first whole hour at or after `at`. */
function ceilHour(at: Date): Date {
  return new Date(Math.ceil(at.getTime() / HOUR_MS) * HOUR_MS);
}

/** The start of the hour containing `at`. */
function floorHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Records what one successful **scheduled** poll read, for its feed.
 *
 * The frontier is the contiguous run the feed's earlier windows joined into. A window that meets
 * it extends it; one that does not starts a new run, so a gap between them is never bridged. Every
 * whole hour the (possibly extended) run now contains and the ledger does not already hold is
 * written with `recordedAt` — the poll's commit — because that is when it became covered.
 *
 * Callers pass only runs that read everything they asked for: `SUCCEEDED` or `SKIPPED` (an
 * unchanged answer is still a read), never `PARTIAL`, `FAILED`, a manual one-off or a sweep. That
 * rule lives with the callers; this function trusts it.
 */
export async function recordLiveCoverage(
  db: Db,
  input: {
    readonly productId: number;
    readonly window: { readonly from: Date; readonly to: Date };
    readonly recordedAt: Date;
  },
): Promise<number> {
  const { window } = input;
  if (window.from.getTime() >= window.to.getTime()) return 0;

  const current = await sql<{ covered_from: Date; covered_to: Date }>`
    SELECT covered_from, covered_to FROM geonerva.feed_coverage_frontier
    WHERE product_id = ${input.productId}
    FOR UPDATE
  `.execute(db);
  const frontier = current.rows[0];

  const joins =
    frontier !== undefined &&
    window.from.getTime() <= frontier.covered_to.getTime() &&
    window.to.getTime() >= frontier.covered_from.getTime();

  const from = joins
    ? new Date(Math.min(frontier.covered_from.getTime(), window.from.getTime()))
    : window.from;
  const to = joins
    ? new Date(Math.max(frontier.covered_to.getTime(), window.to.getTime()))
    : window.to;
  /*
   * The first hour this poll can newly complete.
   *
   * A fresh run starts at its window's first whole hour. A joining one starts at the earlier of
   * that and the hour the old frontier ended in — the hour this window may just have completed —
   * because every hour before that was recorded by the poll that completed it. Earlier hours of a
   * backward extension are covered by the window's own first whole hour, and anything already
   * recorded is dropped by `ON CONFLICT DO NOTHING`.
   *
   * Both are then clamped to the merged run's own first whole hour, which is **not** redundant: a
   * run that began at 12:25 has not read 12:00–12:25, so when a later window of it passes 13:00 the
   * candidate (the hour the frontier ended in, 12:00) would record an hour a quarter of which was
   * never asked for. Two mutation controls survived against this clamp and I read that as dead
   * code and deleted it; the history suite failed on exactly that hour, and it is back with the
   * test it was missing.
   */
  const candidate = joins
    ? new Date(Math.min(ceilHour(window.from).getTime(), floorHour(frontier.covered_to).getTime()))
    : ceilHour(window.from);
  const first = new Date(Math.max(candidate.getTime(), ceilHour(from).getTime()));

  await sql`
    INSERT INTO geonerva.feed_coverage_frontier (product_id, covered_from, covered_to, updated_at)
    VALUES (${input.productId}, ${from}, ${to}, clock_timestamp())
    ON CONFLICT (product_id) DO UPDATE
      SET covered_from = EXCLUDED.covered_from,
          covered_to = EXCLUDED.covered_to,
          updated_at = EXCLUDED.updated_at
  `.execute(db);

  const last = new Date(floorHour(to).getTime() - HOUR_MS);
  if (first.getTime() > last.getTime()) return 0;

  const inserted = await sql`
    INSERT INTO geonerva.feed_coverage_hours (product_id, hour, min_magnitude, recorded_at)
    SELECT ${input.productId}, h, NULL, ${input.recordedAt}
    FROM generate_series(${first}::timestamptz, ${last}::timestamptz, interval '1 hour') AS h
    ON CONFLICT DO NOTHING
  `.execute(db);
  return Number(inserted.numAffectedRows ?? 0n);
}

/**
 * Records the hours one completed backfill interval read, for every feed its plan covers.
 *
 * Called in the transaction that marks the interval `DONE`, so the checkpoint, the facts and the
 * coverage commit together. `LEAST(interval_to, completed_at)`: a window cannot have been read past
 * the moment its read finished. A plan with no product is source-level and covers each of its
 * source's products; the plan's magnitude floor travels with every hour.
 */
export async function recordIntervalCoverage(
  trx: Transaction<DB>,
  input: { readonly planId: string; readonly from: Date; readonly to: Date },
): Promise<number> {
  const inserted = await sql`
    INSERT INTO geonerva.feed_coverage_hours (product_id, hour, min_magnitude, recorded_at)
    SELECT p.id, h.hour, pl.min_magnitude, i.completed_at
    FROM geonerva.backfill_intervals i
    JOIN geonerva.backfill_plans pl ON pl.id = i.plan_id
    JOIN geonerva.source_products p
      ON p.source_id = pl.source_id AND (pl.product_id IS NULL OR pl.product_id = p.id)
    CROSS JOIN LATERAL generate_series(
      date_trunc('hour', i.interval_from)
        + CASE WHEN date_trunc('hour', i.interval_from) = i.interval_from
               THEN interval '0' ELSE interval '1 hour' END,
      date_trunc('hour', LEAST(i.interval_to, i.completed_at)) - interval '1 hour',
      interval '1 hour'
    ) AS h(hour)
    WHERE i.plan_id = ${input.planId}::uuid
      AND i.interval_from = ${input.from}
      AND i.interval_to = ${input.to}
      AND i.status = 'DONE'
      AND pl.mode = 'HISTORICAL'
    ON CONFLICT DO NOTHING
  `.execute(trx);
  return Number(inserted.numAffectedRows ?? 0n);
}
