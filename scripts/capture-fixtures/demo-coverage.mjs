// Demo-place data coverage check (owner decision Q5) -> packages/test-fixtures/sources/coverage/demo-coverage.json
//
// Usage: node scripts/capture-fixtures/demo-coverage.mjs [--skip-firms]
//
// Per place:
//   USGS  FDSN count, M>=2.5 and M>=4.5, 150 km and 300 km, last 5 years          (20 requests)
//   EMSC  FDSN count, M>=2.5 and M>=4.5, 150 km (1.349 deg) and 300 km (2.698 deg) (20 requests)
//   FIRMS keyless NOAA-20 + NOAA-21 Global 7d CSVs (~50 MB each, 2 requests), detections within 150 km
//   GDACS SEARCH by country name(s), all hazards/levels, 5 years, windows split until < 100 results
//         (paging is unreliable: overlapping pages observed), then client-side distance <= 300 km from the
//         event point geometry.

import { haversineKm, politeFetch, saveFixture } from './lib.mjs';

const START = '2021-09-19';
const END = '2026-09-19';
const KM_PER_DEG = 111.195; // mean great-circle km per degree (R = 6371.0088)
const PLACES = [
  { name: 'Marrakech', lat: 31.63416, lon: -7.99994, gdacsCountries: ['Morocco'] },
  {
    name: 'Vancouver',
    lat: 49.24966,
    lon: -123.11934,
    gdacsCountries: ['Canada', 'United States'],
  },
  {
    name: 'Los Angeles',
    lat: 34.05223,
    lon: -118.24368,
    gdacsCountries: ['United States', 'Mexico'],
  },
  { name: 'Tokyo', lat: 35.6895, lon: 139.69171, gdacsCountries: ['Japan'] },
  { name: 'Reykjavík', lat: 64.13548, lon: -21.89541, gdacsCountries: ['Iceland'] },
]; // coordinates: GeoNames cities15000 (2026-09-19)
const skipFirms = process.argv.includes('--skip-firms');
let requests = 0;

async function get(url, opts) {
  requests++;
  const r = await politeFetch(url, { timeoutMs: 300_000, ...opts });
  if (r.timedOut) throw new Error(`timeout ${url}`);
  return r;
}

async function usgsCount(p, km, minmag) {
  const r = await get(
    `https://earthquake.usgs.gov/fdsnws/event/1/count?format=geojson&starttime=${START}&endtime=${END}&latitude=${p.lat}&longitude=${p.lon}&maxradiuskm=${km}&minmagnitude=${minmag}`,
  );
  return JSON.parse(r.body.toString()).count;
}
async function emscCount(p, km, minmag) {
  const deg = (km / KM_PER_DEG).toFixed(3);
  const r = await get(
    `https://www.seismicportal.eu/fdsnws/event/1/count?starttime=${START}T00:00:00&endtime=${END}T00:00:00&lat=${p.lat}&lon=${p.lon}&maxradius=${deg}&minmag=${minmag}`,
  );
  const m = /<Events>\s*(\d+)\s*<\/Events>/.exec(r.body.toString());
  if (!m) throw new Error(`EMSC count parse: ${r.status} ${r.body.toString().slice(0, 200)}`);
  return Number(m[1]);
}

async function firms7d(url) {
  const r = await get(url);
  const text = r.body.toString('utf8');
  const lines = text.split('\n');
  const cols = lines[0].trim().split(',');
  const iLat = cols.indexOf('latitude');
  const iLon = cols.indexOf('longitude');
  const iDate = cols.indexOf('acq_date');
  const counts = Object.fromEntries(PLACES.map((p) => [p.name, 0]));
  const dates = new Set();
  let rows = 0;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const c = l.split(',');
    rows++;
    dates.add(c[iDate]);
    const lat = +c[iLat];
    const lon = +c[iLon];
    for (const p of PLACES) {
      if (Math.abs(lat - p.lat) > 1.5) continue;
      if (haversineKm(p.lat, p.lon, lat, lon) <= 150) counts[p.name]++;
    }
  }
  return {
    url,
    bytes: r.body.length,
    rows,
    acq_dates: [...dates].sort(),
    last_modified: r.headers['last-modified'],
    counts,
  };
}

async function gdacsWindow(country, from, to, acc, depth = 0) {
  const url = `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;DR;WF&alertlevel=green;orange;red&country=${encodeURIComponent(country)}&fromDate=${from}&toDate=${to}&pageSize=100&pageNumber=1`;
  const r = await get(url);
  if (r.status === 204 || r.status === 404) return;
  if (r.status !== 200) throw new Error(`GDACS ${r.status} ${url}`);
  const feats = JSON.parse(r.body.toString()).features ?? [];
  const spanDays = (Date.parse(to) - Date.parse(from)) / 864e5;
  if (feats.length >= 100 && spanDays > 1 && depth < 12) {
    const mid = new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString().slice(0, 10);
    const next = new Date(Date.parse(mid) + 864e5).toISOString().slice(0, 10);
    await gdacsWindow(country, from, mid, acc, depth + 1);
    await gdacsWindow(country, next, to, acc, depth + 1);
    return;
  }
  if (feats.length >= 100) acc.truncatedWindows.push(`${country} ${from}..${to}`);
  for (const f of feats) acc.events.set(`${f.properties.eventtype}${f.properties.eventid}`, f);
}

async function main() {
  const out = { generated_at: new Date().toISOString(), period: [START, END], places: [] };
  for (const p of PLACES) {
    const row = { ...p, usgs: {}, emsc: {} };
    for (const km of [150, 300])
      for (const mm of [2.5, 4.5]) row.usgs[`r${km}_m${mm}`] = await usgsCount(p, km, mm);
    for (const km of [150, 300])
      for (const mm of [2.5, 4.5]) row.emsc[`r${km}_m${mm}`] = await emscCount(p, km, mm);
    out.places.push(row);
    console.log(p.name, JSON.stringify(row.usgs), JSON.stringify(row.emsc));
  }

  // GDACS
  const byCountry = new Map();
  for (const c of [...new Set(PLACES.flatMap((p) => p.gdacsCountries))]) {
    const acc = { events: new Map(), truncatedWindows: [] };
    for (let y = 2021; y < 2026; y++) await gdacsWindow(c, `${y}-09-19`, `${y + 1}-09-18`, acc);
    byCountry.set(c, acc);
    console.log(
      `GDACS ${c}: ${acc.events.size} events (truncated windows: ${acc.truncatedWindows.length})`,
    );
  }
  for (const row of out.places) {
    const seen = new Map();
    const trunc = [];
    for (const c of row.gdacsCountries) {
      const acc = byCountry.get(c);
      trunc.push(...acc.truncatedWindows);
      for (const [k, f] of acc.events) {
        const [lon, lat] = f.geometry.coordinates;
        const d = haversineKm(row.lat, row.lon, lat, lon);
        if (d <= 300)
          seen.set(k, {
            type: f.properties.eventtype,
            level: f.properties.alertlevel,
            name: f.properties.name,
            from: f.properties.fromdate,
            km: Math.round(d),
          });
      }
    }
    const ev = [...seen.values()];
    row.gdacs = {
      r300_total: ev.length,
      by_type: ev.reduce((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {}),
      by_level: ev.reduce((a, e) => ((a[e.level] = (a[e.level] ?? 0) + 1), a), {}),
      truncated_windows: trunc,
      examples: ev.sort((a, b) => b.from.localeCompare(a.from)).slice(0, 5),
    };
    console.log(row.name, 'GDACS', JSON.stringify(row.gdacs.by_type));
  }

  if (!skipFirms) {
    const j1 = await firms7d(
      'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_7d.csv',
    );
    const j2 = await firms7d(
      'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_7d.csv',
    );
    out.firms_7d = { j1: { ...j1 }, j2: { ...j2 } };
    for (const row of out.places)
      row.firms_7d_r150 = {
        noaa20: j1.counts[row.name],
        noaa21: j2.counts[row.name],
        total: j1.counts[row.name] + j2.counts[row.name],
      };
    console.log('FIRMS', JSON.stringify(out.places.map((r) => [r.name, r.firms_7d_r150])));
  }
  out.requests = requests;
  await saveFixture('coverage', 'demo-coverage.json', JSON.stringify(out, null, 2) + '\n', {
    synthetic: true,
    derived_from:
      'USGS FDSN count, EMSC FDSN count, GDACS SEARCH (by country), FIRMS keyless Global 7d CSVs — live 2026-09-19',
    notes: `Demo-place coverage summary (Q5), computed by demo-coverage.mjs; ${requests} requests.`,
  });
  console.log('requests', requests);
}

await main();
