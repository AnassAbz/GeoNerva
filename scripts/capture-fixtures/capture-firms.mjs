// NASA FIRMS fixtures (TESTING.md §3) + V3/V4 evidence. Keyless: no MAP_KEY is available in P0.
//
// Usage: node scripts/capture-fixtures/capture-firms.mjs main
//
// The global 24 h CSVs are ~10 MB each; they are downloaded once and trimmed deterministically
// (header + selected rows, byte-exact lines, original line endings preserved).

import { captureUrl, politeFetch, saveFixture } from './lib.mjs';

const SOURCE = 'firms';
const F = 'https://firms.modaps.eosdis.nasa.gov';
const FILES = {
  j1: `${F}/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv`,
  j2: `${F}/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv`,
  j1usa: `${F}/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv`,
};
const BAD_KEY = 'INVALIDKEY000';
const SLICE_BBOX = { west: 10, south: -20, east: 40, north: 0 }; // Southern Africa burning season: dense, varied rows
const SLICE_ROWS = 300;
const SPAN_ROWS_PER_DATE = 100;

function splitCsv(text) {
  const nl = text.indexOf('\n');
  const eol = text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(eol);
  const trailing = lines[lines.length - 1] === '' ? lines.pop() : null;
  const header = lines.shift();
  const cols = header.split(',');
  return { eol, header, cols, lines, endsWithEol: trailing === '' };
}
const joinCsv = ({ eol, header }, rows) => [header, ...rows].join(eol) + eol;
const field = (cols, line, name) => line.split(',')[cols.indexOf(name)];

function stats(csv) {
  const c = csv.cols;
  const count = (name) => {
    const m = {};
    for (const l of csv.lines) {
      const v = field(c, l, name);
      m[v] = (m[v] ?? 0) + 1;
    }
    return m;
  };
  const times = csv.lines
    .map((l) => `${field(c, l, 'acq_date')}T${field(c, l, 'acq_time').padStart(4, '0')}`)
    .sort();
  return {
    rows: csv.lines.length,
    columns: c,
    version: count('version'),
    satellite: count('satellite'),
    confidence: count('confidence'),
    daynight: count('daynight'),
    acq_date: count('acq_date'),
    min_acq: times[0],
    max_acq: times[times.length - 1],
    line_ending: csv.eol === '\r\n' ? 'CRLF' : 'LF',
  };
}

async function sliceFile(key, prefix) {
  const r = await politeFetch(FILES[key], { timeoutMs: 180_000 });
  if (r.status !== 200) throw new Error(`${key}: HTTP ${r.status}`);
  const text = r.body.toString('utf8');
  const csv = splitCsv(text);
  const st = stats(csv);
  const c = csv.cols;
  const inBox = (l) => {
    const lat = Number(field(c, l, 'latitude'));
    const lon = Number(field(c, l, 'longitude'));
    return (
      lon >= SLICE_BBOX.west &&
      lon <= SLICE_BBOX.east &&
      lat >= SLICE_BBOX.south &&
      lat <= SLICE_BBOX.north
    );
  };
  const slice = csv.lines.filter(inBox).slice(0, SLICE_ROWS);
  await saveFixture(SOURCE, `${prefix}-24h-slice.csv`, joinCsv(csv, slice), {
    url: FILES[key],
    http_status: r.status,
    content_type: r.contentType,
    notes: `TRIMMED: header + first ${slice.length} rows (file order) inside bbox ${JSON.stringify(SLICE_BBOX)}. Full file: ${r.body.length} bytes, ${st.rows} rows, versions ${JSON.stringify(st.version)}, acq ${st.min_acq}..${st.max_acq} UTC.`,
  });
  const dates = Object.keys(st.acq_date).sort();
  let span = [];
  if (dates.length >= 2) {
    const first = csv.lines.filter((l) => field(c, l, 'acq_date') === dates[0]);
    const last = csv.lines.filter((l) => field(c, l, 'acq_date') === dates[dates.length - 1]);
    span = [...first.slice(-SPAN_ROWS_PER_DATE), ...last.slice(0, SPAN_ROWS_PER_DATE)];
  }
  await saveFixture(SOURCE, `${prefix}-24h-midnight-span.csv`, joinCsv(csv, span), {
    url: FILES[key],
    http_status: r.status,
    content_type: r.contentType,
    notes: `TRIMMED: header + last ${SPAN_ROWS_PER_DATE} rows of acq_date ${dates[0]} and first ${SPAN_ROWS_PER_DATE} rows of ${dates[dates.length - 1]} (file order). Stands in for a midnight-spanning DAY_RANGE=2 Area API response (same columns; the keyless file is a rolling 24 h window).`,
  });
  return { key, bytes: r.body.length, lastModified: r.headers['last-modified'], ...st };
}

async function main() {
  console.log('FIRMS main');
  const s1 = await sliceFile('j1', 'j1');
  const s2 = await sliceFile('j2', 'j2');

  // CONUS/Hawaii file: where URT/RT rows would appear if the NRT products carried them (V4).
  const usa = await politeFetch(FILES.j1usa);
  const usaCsv = splitCsv(usa.body.toString('utf8'));
  const su = stats(usaCsv);
  const keepUsa = usaCsv.lines.slice(0, 150);
  await saveFixture(SOURCE, 'j1-usa-24h-slice.csv', joinCsv(usaCsv, keepUsa), {
    url: FILES.j1usa,
    http_status: usa.status,
    content_type: usa.contentType,
    notes: `TRIMMED: header + first ${keepUsa.length} of ${su.rows} rows. Version values in full file: ${JSON.stringify(su.version)} (V4 evidence).`,
  });

  await saveFixture(
    SOURCE,
    'stats-24h.json',
    JSON.stringify(
      { j1: s1, j2: s2, j1usa: { key: 'j1usa', bytes: usa.body.length, ...su } },
      null,
      2,
    ) + '\n',
    {
      synthetic: true,
      derived_from: 'J1/J2 Global 24h + J1 USA 24h keyless files (full, not stored)',
      notes:
        'Computed summary of the full files at capture time (row counts, version/satellite/confidence distributions). Evidence for V4 and volume estimates; not a provider payload.',
    },
  );

  // MAP_KEY-dependent endpoints with an invalid key (V3).
  await captureUrl(
    SOURCE,
    'area-invalid-mapkey.txt',
    `${F}/api/area/csv/${BAD_KEY}/VIIRS_NOAA20_NRT/world/1`,
    {
      notes: 'Area API with an invalid MAP_KEY.',
    },
  );
  await captureUrl(
    SOURCE,
    'data-availability-invalid-mapkey.txt',
    `${F}/api/data_availability/csv/${BAD_KEY}/ALL`,
    {
      notes:
        'data_availability with an invalid MAP_KEY (V3: schema of a successful response not observable without a key).',
    },
  );
  await captureUrl(
    SOURCE,
    'mapkey-status-invalid.html',
    `${F}/mapserver/mapkey_status/?MAP_KEY=${BAD_KEY}`,
    {
      notes:
        'mapkey_status with an invalid key: HTTP 403 text/html one-line message (also returned when the limit is exceeded — indistinguishable).',
    },
  );
  await captureUrl(SOURCE, 'missing-data.json', `${F}/api/missing_data/?action=fetch_data`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    notes:
      'Keyless missing-data table as fetched by the /api/missing_data/ page itself: JSON {success, html, rowCount} where html is <tr> rows (date, satellite/sensor) for SP and NRT. Undocumented internal endpoint.',
  });
}

const cmd = process.argv[2];
if (cmd === 'main') await main();
else {
  console.error('usage: capture-firms.mjs main');
  process.exit(2);
}
