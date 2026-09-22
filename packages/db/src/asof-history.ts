/**
 * Reads the baselines need that no other view does (ARCHITECTURE §8). Part of the as-of layer,
 * re-exported through `@geonerva/db/asof`.
 */

import { sql, type Kysely } from 'kysely';

import type { DB } from './generated/database.ts';

/**
 * The earliest `observed_at` among versions of the given hazard types known at `asOf` — where the
 * catalog GeoNerva holds actually begins.
 *
 * A reference period must not reach before it. Counting the years before a backfill started as
 * windows with no earthquakes would make every place look quieter, and "rare here" would be a
 * statement about GeoNerva's archive rather than about the ground.
 */
export async function earliestObservedAsOf(
  db: Kysely<DB>,
  options: { readonly asOf: Date; readonly hazardTypes: readonly string[] },
): Promise<Date | null> {
  if (options.hazardTypes.length === 0) return null;
  const result = await sql<{ earliest: Date | null }>`
    SELECT min(v.observed_at) AS earliest
    FROM geonerva.observation_versions v
    WHERE v.ingested_at <= ${options.asOf}
      AND v.hazard_type = ANY(${sql.val(options.hazardTypes)}::text[])
  `.execute(db);
  return result.rows[0]?.earliest ?? null;
}
