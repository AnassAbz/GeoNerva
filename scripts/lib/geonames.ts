/**
 * Parsing the GeoNames `cities15000` export (ADR-013, IMPLEMENTATION_PLAN P8 task 2).
 *
 * The file is tab-separated, one populated place per line, **19 columns**, UTF-8, no header:
 *
 * ```text
 *  0 geonameid   1 name        2 asciiname   3 alternatenames   4 latitude   5 longitude
 *  6 feature cl. 7 feature cd. 8 country     9 cc2             10 admin1    11 admin2
 * 12 admin3     13 admin4     14 population 15 elevation       16 dem       17 timezone
 * 18 modification date
 * ```
 *
 * The plan records the upstream size — 34,146 rows — and the reason the alternates matter:
 * "Marrakech" exists only as an alternate of "Marrakesh". Every line that does not parse is
 * **counted and reported with its line number**, never skipped silently: a short import would make
 * places vanish from type-ahead with nothing to say why.
 */

import type { PlaceInput } from '@geonerva/db';

export const GEONAMES_COLUMNS = 19;

export interface GeonamesParseResult {
  readonly places: PlaceInput[];
  readonly rejected: { readonly line: number; readonly reason: string }[];
}

export function parseGeonames(text: string): GeonamesParseResult {
  const places: PlaceInput[] = [];
  const rejected: { line: number; reason: string }[] = [];

  const lines = text.split(/\r?\n/u);
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw === '') return;
    const columns = raw.split('\t');
    if (columns.length !== GEONAMES_COLUMNS) {
      rejected.push({ line, reason: `has ${String(columns.length)} columns, expected 19` });
      return;
    }
    const outcome = toPlace(columns);
    if (typeof outcome === 'string') rejected.push({ line, reason: outcome });
    else places.push(outcome);
  });

  return { places, rejected };
}

/** One row, or the reason it was refused. */
function toPlace(columns: readonly string[]): PlaceInput | string {
  const column = (index: number): string => columns[index] ?? '';

  if (!/^[1-9]\d{0,9}$/u.test(column(0))) return 'geonameid is not a positive integer';
  const geonameid = Number(column(0));
  if (geonameid > 2_147_483_647) return 'geonameid does not fit an integer';

  const name = column(1).trim();
  if (name === '') return 'name is empty';
  const asciiName = column(2).trim() === '' ? name : column(2).trim();

  const lat = Number(column(4));
  const lonRaw = Number(column(5));
  if (column(4) === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return 'latitude is not within [-90, 90]';
  }
  if (column(5) === '' || !Number.isFinite(lonRaw) || lonRaw < -180 || lonRaw > 180) {
    return 'longitude is not within [-180, 180]';
  }
  // +180 and -180 are one meridian; the table stores the normalized one.
  const lon = lonRaw === 180 ? -180 : lonRaw;

  if (column(6) !== 'P') return 'feature class is not P (a populated place)';

  const timezone = column(17).trim();
  if (timezone === '') return 'timezone is empty';

  const populationRaw = column(14).trim();
  let population: number | null = null;
  if (populationRaw !== '') {
    if (!/^\d{1,10}$/u.test(populationRaw)) return 'population is not a non-negative integer';
    population = Number(populationRaw);
    if (population > 2_147_483_647) return 'population does not fit an integer';
  }

  const altNames = column(3).trim();
  const countryCode = column(8).trim();
  const admin1 = column(10).trim();

  return {
    geonameid,
    name,
    asciiName,
    altNames: altNames === '' ? null : altNames,
    countryCode: countryCode === '' ? null : countryCode,
    admin1: admin1 === '' ? null : admin1,
    lat,
    lon,
    population,
    timezone,
  };
}
