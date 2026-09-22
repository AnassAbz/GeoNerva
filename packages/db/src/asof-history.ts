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

/** Coverage per product: which products answer the question, and what each had read. */
export interface CatalogCoverage {
  /** Every product of the requested sources whose hazard types meet the requested ones. */
  readonly productIds: readonly number[];
  readonly spans: readonly (CoverageSpan & { readonly productId: number })[];
}

/**
 * The spans of observation time a set of feeds had been **read** for, as known at `asOf` —
 * from the coverage ledger (ADR-041), which outlives run retention.
 *
 * A reference period is a claim that every window in it was looked at, and the earliest record
 * held is not evidence of that (P8 review H1). The ledger holds the whole hours each feed's
 * successful scheduled polls and completed backfill intervals read, each with the moment it became
 * known; this read takes the hours recorded by `asOf` and joins consecutive ones into spans.
 *
 *  - **Per feed.** Only products whose `hazard_types` meet `hazardTypes` count, and each span says
 *    which product it belongs to; the caller decides whether any feed or every feed must be read.
 *  - **Magnitude floor.** `maxMinMagnitude` excludes hours read with a floor above it: an M5.5+
 *    backfill does not cover M4.5 counts. `null` accepts every floor.
 *  - **Edge.** The hour containing `asOf` is never whole, so a span ends at or before the last full
 *    hour; callers state their own tolerance for how close to `asOf` coverage must reach.
 */
export async function catalogCoverageAsOf(
  db: Kysely<DB>,
  options: {
    readonly asOf: Date;
    readonly sourceIds: readonly string[];
    readonly hazardTypes: readonly string[];
    readonly maxMinMagnitude: number | null;
  },
): Promise<CatalogCoverage> {
  if (options.sourceIds.length === 0 || options.hazardTypes.length === 0) {
    return { productIds: [], spans: [] };
  }
  const products = await sql<{ id: number }>`
    SELECT p.id
    FROM geonerva.source_products p
    WHERE p.source_id = ANY(${sql.val(options.sourceIds)}::text[])
      AND p.hazard_types && ${sql.val(options.hazardTypes)}::text[]
    ORDER BY p.id
  `.execute(db);
  const productIds = products.rows.map((row) => row.id);
  if (productIds.length === 0) return { productIds: [], spans: [] };

  const floorFilter =
    options.maxMinMagnitude === null
      ? sql`TRUE`
      : sql`(h.min_magnitude IS NULL OR h.min_magnitude <= ${options.maxMinMagnitude})`;
  const result = await sql<{ product_id: number; from_at: Date; to_at: Date }>`
    WITH known AS (
      SELECT DISTINCT h.product_id, h.hour
      FROM geonerva.feed_coverage_hours h
      WHERE h.product_id = ANY(${sql.val(productIds)}::smallint[])
        AND h.recorded_at <= ${options.asOf}
        AND ${floorFilter}
    ),
    islands AS (
      SELECT product_id, hour,
             hour - (row_number() OVER (PARTITION BY product_id ORDER BY hour)) * interval '1 hour'
               AS island
      FROM known
    )
    SELECT product_id, min(hour) AS from_at, max(hour) + interval '1 hour' AS to_at
    FROM islands
    GROUP BY product_id, island
    ORDER BY product_id, from_at
  `.execute(db);
  return {
    productIds,
    spans: result.rows.map((row) => ({
      productId: row.product_id,
      from: row.from_at,
      to: row.to_at,
    })),
  };
}
