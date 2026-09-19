// V9 evidence: how far apart are the origins that ComCat itself associated into one event?
//
// Usage: node scripts/capture-fixtures/check-comcat-association.mjs [maxEvents]
//
// Takes the current 4.5_month feed, keeps events with >= 3 associated ids, fetches each event's
// detail document and measures the maximum pairwise origin-time and epicentre difference between
// the contributed origin products. PDL's code default is TIME_DIFF_MILLISECONDS = 16000 (±16 s);
// the production NEIC indexer configuration is not published, so this is an empirical lower bound.
// Nothing is written to the fixture tree — the numbers go into DATA_SOURCES.md §10 (V9).

import { fetchJson, haversineKm, politeFetch } from './lib.mjs';

const MAX_EVENTS = Number(process.argv[2] ?? 25);
const feed = await fetchJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson');
const multi = feed.features.filter((f) => f.properties.ids.split(',').filter(Boolean).length >= 3).slice(0, MAX_EVENTS);
console.log(`4.5_month: ${feed.features.length} events, ${multi.length} with >= 3 associated ids (capped at ${MAX_EVENTS})`);

let maxDt = 0;
let maxKm = 0;
const rows = [];
for (const f of multi) {
  const r = await politeFetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=${f.id}`);
  if (r.status !== 200) {
    console.log(`  ${f.id}: HTTP ${r.status}`);
    continue;
  }
  const origins = (JSON.parse(r.body.toString('utf8')).properties.products.origin ?? []).map((p) => ({
    src: p.source,
    t: Date.parse(p.properties.eventtime),
    lat: Number(p.properties.latitude),
    lon: Number(p.properties.longitude),
  }));
  if (origins.length < 2) continue;
  let dt = 0;
  let km = 0;
  for (const a of origins)
    for (const b of origins) {
      dt = Math.max(dt, Math.abs(a.t - b.t) / 1000);
      km = Math.max(km, haversineKm(a.lat, a.lon, b.lat, b.lon));
    }
  maxDt = Math.max(maxDt, dt);
  maxKm = Math.max(maxKm, km);
  rows.push({ id: f.id, sources: origins.map((o) => o.src).join('+'), dt_s: +dt.toFixed(1), dist_km: +km.toFixed(1) });
  console.log(`  ${f.id} ${rows.at(-1).sources} ${rows.at(-1).dt_s}s ${rows.at(-1).dist_km}km`);
}
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(
  `events measured: ${rows.length}; max origin-time spread ${maxDt.toFixed(1)} s (median ${med(rows.map((r) => r.dt_s))} s); max epicentre spread ${maxKm.toFixed(1)} km (median ${med(rows.map((r) => r.dist_km))} km)`,
);
