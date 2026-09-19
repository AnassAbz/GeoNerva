// USGS ComCat fixtures (TESTING.md §3).
//
// Usage:
//   node scripts/capture-fixtures/capture-usgs.mjs main        # capture the static fixture set (t0 all_day included)
//   node scripts/capture-fixtures/capture-usgs.mjs revisions   # re-fetch all_day (t1), diff against the stored t0,
//                                                              # store byte-exact revision pairs (run >= 1 h after `main`)
//
// Event IDs below were chosen on 2026-09-19 from live data; they are pinned so reruns are reproducible.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_ROOT, captureUrl, politeFetch, saveFixture, trimFeatureCollection } from './lib.mjs';

const SOURCE = 'usgs';
const FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';
const FDSN = 'https://earthquake.usgs.gov/fdsnws/event/1';

// Pinned examples (see MANIFEST notes).
const ALIAS_QUERY_ID = 'us7000tiar'; // secondary id of pr2026261000 (ids ",pt26261050,us7000tiar,pr2026261000,")
const DELETED_EVENT_ID = 'nn00924612'; // appeared in includedeleted=only on 2026-09-19
const SUPERSEDED_EVENT_ID = 'us7000tiet'; // small detail doc with 2 contributing origins (us + ak)

async function main() {
  console.log('USGS main');
  await captureUrl(SOURCE, 'all_day.geojson', `${FEED}/all_day.geojson`, {
    notes: 'Real-time summary feed, whole (not trimmed). Also serves as t0 of the revision pair (see revision-t0/t1).',
  });

  await captureUrl(SOURCE, 'fdsn-eventid-by-alias.geojson', `${FDSN}/query?format=geojson&eventid=${ALIAS_QUERY_ID}`, {
    notes: `Queried by secondary alias ${ALIAS_QUERY_ID}; response id is the preferred id pr2026261000 (ids ,pt26261050,us7000tiar,pr2026261000,). Demonstrates that the queried id != returned id (ids/preferred-id change). FDSN detail format (single Feature with products).`,
  });

  await captureUrl(SOURCE, 'fdsn-superseded-detail.geojson', `${FDSN}/query?format=geojson&eventid=${SUPERSEDED_EVENT_ID}&includesuperseded=true`, {
    notes: `Detail with includesuperseded=true: origin products from us and ak (AKa2026snnoxq) with different magnitudes (3.6 vs 3.5). includesuperseded only works with eventid.`,
  });

  await captureUrl(
    SOURCE,
    'fdsn-includedeleted-only.geojson',
    `${FDSN}/query?format=geojson&includedeleted=only&starttime=2026-09-12&endtime=2026-09-19`,
    { notes: 'Deleted events (status "deleted", types null, place may be null) for a fixed 7-day window. Summary feeds silently drop these.' },
  );

  await captureUrl(SOURCE, 'fdsn-eventid-deleted-409.txt', `${FDSN}/query?format=geojson&eventid=${DELETED_EVENT_ID}`, {
    notes: `Querying a deleted event by eventid (${DELETED_EVENT_ID}); documented to return HTTP 409.`,
  });

  await captureUrl(
    SOURCE,
    'fdsn-mag-null-sonic-boom.geojson',
    `${FDSN}/query?format=geojson&eventtype=sonic%20boom&starttime=2024-01-01&endtime=2026-09-19`,
    { notes: 'Contains real features with "mag":null and "magType":null (sonic booms). No mag-null feature existed in all_month on 2026-09-19.' },
  );

  // tsunami=1 and PAGER alert from the 4.5_month feed, trimmed byte-exactly per feature.
  const m45 = await politeFetch(`${FEED}/4.5_month.geojson`);
  const text45 = m45.body.toString('utf8');
  const tsu = trimFeatureCollection(text45, (f) => f.properties.tsunami === 1);
  await saveFixture(SOURCE, 'summary-tsunami.geojson', tsu.text, {
    url: `${FEED}/4.5_month.geojson`,
    http_status: m45.status,
    content_type: m45.contentType,
    notes: `TRIMMED: 4.5_month feed keeping only features with tsunami=1 (${tsu.kept}/${tsu.total}). Feature bytes are verbatim; metadata.count still reflects the untrimmed feed.`,
  });
  const alert = trimFeatureCollection(text45, (f) => f.properties.alert !== null);
  await saveFixture(SOURCE, 'summary-pager-alert.geojson', alert.text, {
    url: `${FEED}/4.5_month.geojson`,
    http_status: m45.status,
    content_type: m45.contentType,
    notes: `TRIMMED: 4.5_month feed keeping only features with non-null PAGER alert (${alert.kept}/${alert.total}; green and yellow present). metadata.count reflects the untrimmed feed.`,
  });

  await captureUrl(SOURCE, 'fdsn-over-20k-400.txt', `${FDSN}/query?format=geojson&starttime=2026-01-01&endtime=2026-09-19`, {
    notes: 'Query matching > 20,000 events returns HTTP 400 text/plain. NB: an open-ended query from 2000-01-01 returned HTTP 503 "table is full" once on 2026-09-19 instead of 400 — adapters must treat both as "split the range".',
  });
  await captureUrl(SOURCE, 'fdsn-count-over-limit.json', `${FDSN}/count?format=geojson&starttime=2026-01-01&endtime=2026-09-19`, {
    notes: 'count endpoint returns 200 with {count,maxAllowed,error} when over the limit — use it for chunk planning.',
  });
}

async function revisions() {
  console.log('USGS revisions (t1 vs stored t0)');
  const t0Text = await readFile(join(FIXTURE_ROOT, SOURCE, 'all_day.geojson'), 'utf8');
  const t0 = JSON.parse(t0Text);
  const r = await politeFetch(`${FEED}/all_day.geojson`);
  const t1Text = r.body.toString('utf8');
  const t1 = JSON.parse(t1Text);
  const byId0 = new Map(t0.features.map((f) => [f.id, f]));
  const changed = new Set();
  const reasons = {};
  for (const f of t1.features) {
    const a = byId0.get(f.id);
    if (!a) continue;
    const p0 = a.properties;
    const p1 = f.properties;
    const why = [];
    if (p0.status !== p1.status) why.push(`status ${p0.status}->${p1.status}`);
    if (p0.mag !== p1.mag) why.push(`mag ${p0.mag}->${p1.mag}`);
    if (p0.magType !== p1.magType) why.push(`magType ${p0.magType}->${p1.magType}`);
    if (p0.ids !== p1.ids) why.push(`ids ${p0.ids}->${p1.ids}`);
    if (JSON.stringify(a.geometry) !== JSON.stringify(f.geometry)) why.push('location/depth');
    if (why.length) {
      changed.add(f.id);
      reasons[f.id] = why.join('; ');
    }
  }
  // Also detect preferred-id changes: t1 feature whose ids contain a t0 id but whose id differs.
  for (const f of t1.features) {
    if (byId0.has(f.id)) continue;
    const aliases = f.properties.ids.split(',').filter(Boolean);
    const prev = aliases.find((x) => byId0.has(x));
    if (prev) {
      changed.add(f.id);
      changed.add(prev);
      reasons[f.id] = `preferred id change ${prev}->${f.id}`;
    }
  }
  const t0Trim = trimFeatureCollection(t0Text, (f) => changed.has(f.id));
  const t1Trim = trimFeatureCollection(t1Text, (f) => changed.has(f.id) || Object.keys(reasons).includes(f.id));
  const statusFlips = Object.values(reasons).filter((x) => x.includes('status automatic->reviewed')).length;
  console.log(`  changed: ${changed.size}, automatic->reviewed: ${statusFlips}`);
  console.log(reasons);
  await saveFixture(SOURCE, 'revision-t0.geojson', t0Trim.text, {
    url: `${FEED}/all_day.geojson`,
    http_status: 200,
    content_type: 'application/json; charset=utf-8',
    captured_at: new Date(t0.metadata.generated).toISOString(),
    notes: `TRIMMED from all_day.geojson (t0) to the ${t0Trim.kept} features that changed by t1. Reasons: ${JSON.stringify(reasons)}`,
  });
  await saveFixture(SOURCE, 'revision-t1.geojson', t1Trim.text, {
    url: `${FEED}/all_day.geojson`,
    http_status: r.status,
    content_type: r.contentType,
    notes: `TRIMMED from a second all_day poll (t1, generated ${new Date(t1.metadata.generated).toISOString()}) to the ${t1Trim.kept} features that changed since t0 (${statusFlips} automatic->reviewed). Pair with revision-t0.geojson.`,
    extra: { revision_reasons: reasons },
  });
}

const cmd = process.argv[2];
if (cmd === 'main') await main();
else if (cmd === 'revisions') await revisions();
else {
  console.error('usage: capture-usgs.mjs main | revisions');
  process.exit(2);
}
