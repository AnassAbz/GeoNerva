// Derive synthetic "drift" fixtures from real captured fixtures (TESTING.md §3). Offline, deterministic:
// same inputs -> same bytes. Every output is marked synthetic:true with derived_from in MANIFEST.json.
//
// Usage: node scripts/capture-fixtures/derive-drift.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_ROOT, saveFixture, splitTopLevelArray, joinTopLevelArray } from './lib.mjs';

const read = (source, file) => readFile(join(FIXTURE_ROOT, source, file), 'utf8');
const CAPTURED_AT = '2026-09-19T00:00:00.000Z'; // fixed so reruns are byte- and manifest-stable

const HTML_200 = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Service temporarily unavailable</title></head>
<body>
<h1>Service temporarily unavailable</h1>
<p>The server is undergoing maintenance. Please try again later.</p>
</body>
</html>
`;

/** Replace the first occurrence of `find` inside the first element of the named top-level array. */
function editFirstElement(text, key, find, replace) {
  const parts = splitTopLevelArray(text, key);
  const first = parts.elements[0];
  if (!first.includes(find)) throw new Error(`"${find}" not found in first ${key} element`);
  parts.elements[0] = first.replace(find, replace);
  return joinTopLevelArray(parts, parts.elements);
}
function emptyArray(text, key) {
  const parts = splitTopLevelArray(text, key);
  return joinTopLevelArray(parts, []);
}
const truncate = (text) => text.slice(0, Math.floor(text.length * 0.6));

async function save(source, file, body, derivedFrom, notes, extra = {}) {
  await saveFixture(source, file, body, {
    synthetic: true,
    derived_from: derivedFrom,
    captured_at: CAPTURED_AT,
    http_status: 'http_status' in extra ? extra.http_status : 200,
    content_type: extra.content_type ?? 'application/json',
    notes,
    extra: extra.expect_parse_error ? { expect_parse_error: true } : {},
  });
}

/** Standard JSON drift set for a FeatureCollection-like document. */
async function jsonDrift(
  source,
  baseFile,
  key,
  { rename, typeChange, remove, extraField },
  contentType,
) {
  const text = await read(source, baseFile);
  const ct = { content_type: contentType };
  await save(
    source,
    'drift-renamed-field.json',
    editFirstElement(text, key, rename[0], rename[1]),
    baseFile,
    `First ${key} element: ${rename[0]} renamed to ${rename[1]}. Expect: record rejected/unknown field reported, batch verdict per contract.`,
    ct,
  );
  await save(
    source,
    'drift-type-change.json',
    editFirstElement(text, key, typeChange[0], typeChange[1]),
    baseFile,
    `First ${key} element: ${typeChange[0]} -> ${typeChange[1]} (type change). Expect: schema reject of that record.`,
    ct,
  );
  await save(
    source,
    'drift-missing-required.json',
    editFirstElement(text, key, remove, ''),
    baseFile,
    `First ${key} element: removed ${remove} (required field). Expect: record rejected.`,
    ct,
  );
  await save(
    source,
    'drift-extra-field.json',
    editFirstElement(text, key, extraField[0], extraField[1]),
    baseFile,
    `First ${key} element: unknown extra field added. Expect: tolerated (no reject).`,
    ct,
  );
  await save(
    source,
    'drift-empty-collection.json',
    emptyArray(text, key),
    baseFile,
    `${key} array emptied. Expect: EMPTY_SUSPICIOUS (not "no events").`,
    ct,
  );
  await save(
    source,
    'drift-truncated.json',
    truncate(text),
    baseFile,
    'Body truncated at 60% of its length. Expect: parse failure -> batch FAILED, nothing written.',
    { ...ct, expect_parse_error: true },
  );
  await save(
    source,
    'drift-html-200.html',
    HTML_200,
    baseFile,
    'HTML maintenance page served with HTTP 200. Expect: content-type/parse guard -> batch FAILED.',
    { content_type: 'text/html; charset=utf-8' },
  );
}

async function main() {
  // USGS summary GeoJSON
  const usgsFirst = splitTopLevelArray(await read('usgs', 'all_day.geojson'), 'features')
    .elements[0];
  const usgsMag = /"mag":([-0-9.]+)/.exec(usgsFirst);
  const usgsTime = /"time":\d+,/.exec(usgsFirst);
  await jsonDrift(
    'usgs',
    'all_day.geojson',
    'features',
    {
      rename: ['"mag":', '"magnitude":'],
      typeChange: [usgsMag[0], `"mag":"${usgsMag[1]}"`],
      remove: usgsTime[0],
      extraField: ['"properties":{', '"properties":{"geonerva_unknown_field":{"nested":[1,2,3]},'],
    },
    'application/json',
  );

  // EMSC format=json
  const emsc = await read('emsc', 'json-page.json');
  const emscFirst = splitTopLevelArray(emsc, 'features').elements[0];
  const emscMag = /"mag": ?([-0-9.]+)/.exec(emscFirst);
  const emscTime = /"time": ?"[^"]*",?/.exec(emscFirst);
  await jsonDrift(
    'emsc',
    'json-page.json',
    'features',
    {
      rename: ['"unid"', '"event_unid"'],
      typeChange: [emscMag[0], emscMag[0].replace(emscMag[1], `"${emscMag[1]}"`)],
      remove: emscTime[0],
      extraField: ['"properties":', '"properties_v2_preview":{"x":1},"properties":'],
    },
    'application/json',
  );

  // EMSC websocket delete (P1): none observed in 25 min of listening (only create/update).
  const ws = JSON.parse(await read('emsc', 'websocket-frames.json'));
  const firstCreate = ws.frames.find((f) => f.startsWith('{"action":"create"'));
  await save(
    'emsc',
    'websocket-delete-frame.json',
    JSON.stringify(
      { frames: [firstCreate.replace('{"action":"create"', '{"action":"delete"')] },
      null,
      2,
    ) + '\n',
    'websocket-frames.json',
    'SYNTHETIC: first real "create" frame with action changed to "delete" (no delete frame arrived during a 25 min listen on 2026-09-19). Assumes a delete frame carries the same Feature payload — unverified. Expect: tombstone version for that unid.',
    { http_status: 101, content_type: 'application/json (wrapper: {frames: [raw frame strings]})' },
  );

  // GDACS event list
  const gd = await read('gdacs', 'geteventlist-search-eq.json');
  const gdFirst = splitTopLevelArray(gd, 'features').elements[0];
  const gdAlert = /"alertlevel": ?"[A-Za-z]+"/.exec(gdFirst)[0];
  const gdFrom = /"fromdate": ?"[^"]*",?/.exec(gdFirst)[0];
  await jsonDrift(
    'gdacs',
    'geteventlist-search-eq.json',
    'features',
    {
      rename: ['"eventid"', '"eventId"'],
      typeChange: [gdAlert, gdAlert.replace(/"([A-Za-z]+)"$/, '2')],
      remove: gdFrom,
      extraField: ['"properties":{', '"properties":{"newProviderField":"x",'],
    },
    'application/json; charset=utf-8',
  );

  // GDACS: flood with centroid only (no real one found among the scanned live floods).
  const fl = await read('gdacs', 'getgeometry-fl-affected-global.json');
  const flParts = splitTopLevelArray(fl, 'features');
  const centroidOnly = flParts.elements.filter((e) => /"Class": ?"Point_Centroid"/.test(e));
  await save(
    'gdacs',
    'getgeometry-fl-centroid-only.json',
    joinTopLevelArray(flParts, centroidOnly),
    'getgeometry-fl-affected-global.json',
    'SYNTHETIC: Poly_Affected and Poly_Global features removed, only Point_Centroid kept (no live centroid-only flood found on 2026-09-19 among 15 scanned). Expect: flood handled as centroid-only (no area claim).',
    { content_type: 'application/json; charset=utf-8' },
  );

  // GDACS: EQ whose sourceid resolves only via the USGS ids alias list.
  const eq = await read('gdacs', 'geteventdata-eq-prico.json');
  if (!eq.includes('"sourceid":"pr2026261000"'))
    throw new Error('unexpected geteventdata-eq-prico.json');
  await save(
    'gdacs',
    'geteventdata-eq-alias-only.json',
    eq.replace('"sourceid":"pr2026261000"', '"sourceid":"us7000tiar"'),
    'geteventdata-eq-prico.json',
    'SYNTHETIC: sourceid changed from the current USGS preferred id pr2026261000 to its alias us7000tiar (USGS ids ",pt26261050,us7000tiar,pr2026261000,", see usgs/fdsn-eventid-by-alias.geojson). All 70+ live GDACS EQs checked on 2026-09-19 used the current id, so this case was not observable live. Expect: resolves via USGS alias set, not via current id.',
    { content_type: 'application/json; charset=utf-8' },
  );

  // GDACS: timeout descriptor (no payload exists for a timeout).
  await save(
    'gdacs',
    'timeout.json',
    JSON.stringify(
      {
        scenario: 'timeout',
        description:
          'No response body within the client timeout. Contract tests inject this via the HTTP client mock; the adapter must record the run as FAILED (timeout) and must not treat it as "no events".',
        observed:
          'one GDACS timeout observed on 2026-09-19 during architecture-phase checks (DATA_SOURCES.md §2.1)',
      },
      null,
      2,
    ) + '\n',
    'n/a (scenario descriptor)',
    'SYNTHETIC scenario descriptor, not a provider body.',
    { http_status: null },
  );

  // FIRMS CSV drift (from the NOAA-20 slice)
  const csv = await read('firms', 'j1-24h-slice.csv');
  const lines = csv.split('\n');
  const header = lines[0];
  const cols = header.split(',');
  const mapCols = (fn) =>
    lines.map((l, i) => (l === '' ? l : fn(l.split(','), i)).toString()).join('\n');
  const ci = (n) => cols.indexOf(n);
  const csvMeta = { content_type: 'text/csv' };
  await save(
    'firms',
    'drift-renamed-column.csv',
    [header.replace('frp', 'FRP_MW'), ...lines.slice(1)].join('\n'),
    'j1-24h-slice.csv',
    'Column frp renamed to FRP_MW. Expect: batch rejected (required column missing).',
    csvMeta,
  );
  await save(
    'firms',
    'drift-type-change.csv',
    mapCols((c, i) =>
      (i === 1
        ? ((c[ci('acq_time')] =
            `${c[ci('acq_time')].padStart(4, '0').slice(0, 2)}:${c[ci('acq_time')].padStart(4, '0').slice(2)}`),
          c)
        : c
      ).join(','),
    ),
    'j1-24h-slice.csv',
    'First data row: acq_time "HHMM" -> "HH:MM". Expect: row rejected.',
    csvMeta,
  );
  await save(
    'firms',
    'drift-missing-column.csv',
    mapCols((c) => c.filter((_, k) => k !== ci('confidence')).join(',')),
    'j1-24h-slice.csv',
    'Column confidence dropped from header and rows. Expect: batch rejected.',
    csvMeta,
  );
  await save(
    'firms',
    'drift-extra-column.csv',
    mapCols((c, i) => [...c, i === 0 ? 'type' : '0'].join(',')),
    'j1-24h-slice.csv',
    'Extra trailing column "type" added. Expect: tolerated.',
    csvMeta,
  );
  await save(
    'firms',
    'drift-empty.csv',
    header + '\n',
    'j1-24h-slice.csv',
    'Header only, zero rows (what the Area API returns for no detections). Global/world poll with 0 rows -> EMPTY_SUSPICIOUS.',
    csvMeta,
  );
  await save(
    'firms',
    'drift-truncated.csv',
    csv.slice(0, Math.floor(csv.length * 0.6)),
    'j1-24h-slice.csv',
    'Body cut at 60% (mid-line). Expect: last row fails column count -> batch FAILED or row rejected per contract.',
    { ...csvMeta, expect_parse_error: true },
  );
  await save(
    'firms',
    'drift-html-200.html',
    HTML_200,
    'j1-24h-slice.csv',
    'HTML page with HTTP 200 instead of CSV. Expect: batch FAILED.',
    { content_type: 'text/html; charset=utf-8' },
  );

  // Nominatim 429 (never provoked against the public instance).
  await save(
    'nominatim',
    'error-429.html',
    `<html>\n<head><title>429 Too Many Requests</title></head>\n<body>\n<center><h1>429 Too Many Requests</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n`,
    'n/a (generic nginx 429 page)',
    'SYNTHETIC: HTTP 429 body shape (nginx default). Not captured live — provoking throttling would violate the Nominatim usage policy. Expect: back off, serve cache, never retry-storm.',
    { http_status: 429, content_type: 'text/html' },
  );
}

await main();
