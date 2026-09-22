/**
 * A few lines in the exact `cities15000` format, for tests.
 *
 * **Hand-written, not captured.** The columns, order and encoding are GeoNames'; the values are
 * rounded public facts about real cities, except `Nicetown`, which is fictional and exists so that
 * an exact name match can be shown to rank above a more populous prefix match. No test downloads
 * the real file.
 */

const COLUMNS = [
  'geonameid',
  'name',
  'asciiname',
  'alternatenames',
  'latitude',
  'longitude',
  'featureClass',
  'featureCode',
  'countryCode',
  'cc2',
  'admin1',
  'admin2',
  'admin3',
  'admin4',
  'population',
  'elevation',
  'dem',
  'timezone',
  'modified',
] as const;

type Row = Readonly<Record<(typeof COLUMNS)[number], string>>;

function line(row: Partial<Row> & Pick<Row, 'geonameid' | 'name'>): string {
  const full: Row = {
    asciiname: row.name,
    alternatenames: '',
    latitude: '0',
    longitude: '0',
    featureClass: 'P',
    featureCode: 'PPL',
    countryCode: '',
    cc2: '',
    admin1: '',
    admin2: '',
    admin3: '',
    admin4: '',
    population: '',
    elevation: '',
    dem: '0',
    timezone: 'UTC',
    modified: '2024-01-01',
    ...row,
  };
  return COLUMNS.map((column) => full[column]).join('\t');
}

export const GEONAMES_FIXTURE_ROWS = {
  marrakesh: line({
    geonameid: '2542997',
    name: 'Marrakesh',
    alternatenames: 'Marakech,Marrakech,Marrakesch,Marrakesh,Marrakus',
    latitude: '31.63416',
    longitude: '-7.99994',
    featureCode: 'PPLA',
    countryCode: 'MA',
    admin1: '07',
    population: '839296',
    timezone: 'Africa/Casablanca',
  }),
  paris: line({
    geonameid: '2988507',
    name: 'Paris',
    alternatenames: 'Lutetia,Paname,Parigi,Paris',
    latitude: '48.85341',
    longitude: '2.3488',
    featureCode: 'PPLC',
    countryCode: 'FR',
    admin1: '11',
    population: '2138551',
    timezone: 'Europe/Paris',
  }),
  parramatta: line({
    geonameid: '2153391',
    name: 'Parramatta',
    latitude: '-33.81667',
    longitude: '151',
    countryCode: 'AU',
    admin1: '02',
    population: '25798',
    timezone: 'Australia/Sydney',
  }),
  montreal: line({
    geonameid: '6077243',
    name: 'Montréal',
    asciiname: 'Montreal',
    alternatenames: 'Montreal,Montréal,Mont-Royal',
    latitude: '45.50884',
    longitude: '-73.58781',
    countryCode: 'CA',
    admin1: '10',
    population: '1600000',
    timezone: 'America/Toronto',
  }),
  nice: line({
    geonameid: '2990440',
    name: 'Nice',
    latitude: '43.70313',
    longitude: '7.26608',
    countryCode: 'FR',
    admin1: '93',
    population: '342669',
    timezone: 'Europe/Paris',
  }),
  nicetown: line({
    geonameid: '999999901',
    name: 'Nicetown',
    latitude: '43.8',
    longitude: '7.3',
    countryCode: 'FR',
    population: '900000',
    timezone: 'Europe/Paris',
  }),
  suva: line({
    geonameid: '2198148',
    name: 'Suva',
    latitude: '-18.14161',
    longitude: '178.44149',
    featureCode: 'PPLC',
    countryCode: 'FJ',
    admin1: '01',
    population: '77366',
    timezone: 'Pacific/Fiji',
  }),
} as const;

/** The whole fixture as the file would hold it: one row per line, a trailing newline. */
export const GEONAMES_FIXTURE = `${Object.values(GEONAMES_FIXTURE_ROWS).join('\n')}\n`;

export { line as geonamesLine };
