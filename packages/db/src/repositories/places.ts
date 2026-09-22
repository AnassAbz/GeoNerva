/**
 * Writes to the GeoNames `places` reference table (ADR-013). Used only by the import script.
 *
 * The table is reference data, replaced from the upstream file rather than versioned, so an upsert
 * by `geonameid` is the whole contract: re-running an import with the same file changes nothing,
 * and a newer file updates names, populations and time zones in place.
 */

import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../generated/database.ts';

type Db = Kysely<DB> | Transaction<DB>;

export interface PlaceInput {
  readonly geonameid: number;
  readonly name: string;
  readonly asciiName: string;
  readonly altNames: string | null;
  readonly countryCode: string | null;
  readonly admin1: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly population: number | null;
  readonly timezone: string;
}

/** Rows per statement: well under PostgreSQL's 65,535 bind parameters at ten per row. */
const CHUNK = 1_000;

/** Inserts or updates places by `geonameid`. Returns the number of rows written. */
export async function upsertPlaces(db: Db, places: readonly PlaceInput[]): Promise<number> {
  let written = 0;
  for (let start = 0; start < places.length; start += CHUNK) {
    const chunk = places.slice(start, start + CHUNK);
    const result = await sql`
      INSERT INTO geonerva.places
        (geonameid, name, ascii_name, alt_names, country_code, admin1, lat, lon, population, timezone)
      SELECT * FROM unnest(
        ${sql.val(chunk.map((place) => place.geonameid))}::integer[],
        ${sql.val(chunk.map((place) => place.name))}::text[],
        ${sql.val(chunk.map((place) => place.asciiName))}::text[],
        ${sql.val(chunk.map((place) => place.altNames))}::text[],
        ${sql.val(chunk.map((place) => place.countryCode))}::text[],
        ${sql.val(chunk.map((place) => place.admin1))}::text[],
        ${sql.val(chunk.map((place) => place.lat))}::double precision[],
        ${sql.val(chunk.map((place) => place.lon))}::double precision[],
        ${sql.val(chunk.map((place) => place.population))}::integer[],
        ${sql.val(chunk.map((place) => place.timezone))}::text[]
      )
      ON CONFLICT (geonameid) DO UPDATE SET
        name = EXCLUDED.name,
        ascii_name = EXCLUDED.ascii_name,
        alt_names = EXCLUDED.alt_names,
        country_code = EXCLUDED.country_code,
        admin1 = EXCLUDED.admin1,
        lat = EXCLUDED.lat,
        lon = EXCLUDED.lon,
        population = EXCLUDED.population,
        timezone = EXCLUDED.timezone
    `.execute(db);
    written += Number(result.numAffectedRows ?? 0n);
  }
  return written;
}
