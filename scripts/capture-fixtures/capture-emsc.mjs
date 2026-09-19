// EMSC SeismicPortal fixtures (TESTING.md §3).
//
// Usage:
//   node scripts/capture-fixtures/capture-emsc.mjs main        # static fixtures + updatedafter poll t0
//   node scripts/capture-fixtures/capture-emsc.mjs revisions   # >= 1 h later: poll updatedafter again, store real revision pairs
//   node scripts/capture-fixtures/capture-emsc.mjs ws [secs]   # listen to the realtime websocket (P1), default 180 s

import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FIXTURE_ROOT,
  USER_AGENT,
  captureUrl,
  politeFetch,
  saveFixture,
  trimFeatureCollection,
} from './lib.mjs';

const SOURCE = 'emsc';
const FDSN = 'https://www.seismicportal.eu/fdsnws/event/1/query';
const MOROCCO_UNID = '20260803_0000324'; // = USGS us6000thv7 (DATA_SOURCES §6.2)
const LATE_UPDATE_UNID = '20250913_0000173'; // origin 2025-09-13, lastupdate 2026-09-19 (seen in updatedafter on 2026-09-19)

async function main() {
  console.log('EMSC main');
  await captureUrl(
    SOURCE,
    'json-page.json',
    `${FDSN}?format=json&starttime=2026-09-18T00:00:00&endtime=2026-09-19T00:00:00&limit=200&orderby=time`,
    {
      notes:
        'One page (limit=200) of format=json (GeoJSON FeatureCollection) for a fixed UTC day. NB geometry z = -depth (negative km); properties.depth is positive.',
    },
  );
  const since = new Date(Date.now() - 3600e3).toISOString().slice(0, 19);
  await captureUrl(
    SOURCE,
    'updatedafter-t0.json',
    `${FDSN}?format=json&updatedafter=${since}&limit=500`,
    {
      notes: `The production poll shape: updatedafter=now-1h. Contains recent events and old events revised within the hour (lastupdate >> time). t0 of the revision pair.`,
    },
  );
  await captureUrl(SOURCE, 'eventid-morocco.json', `${FDSN}?format=json&eventid=${MOROCCO_UNID}`, {
    notes:
      'The Morocco M4.7 of 2026-08-03 (= USGS us6000thv7). Single Feature (not a FeatureCollection) when queried by eventid.',
  });
  await captureUrl(
    SOURCE,
    'morocco-marrakech-300km-12mo.json',
    `${FDSN}?format=json&lat=31.63&lon=-8.0&maxradius=2.7&starttime=2025-09-19T00:00:00&endtime=2026-09-19T00:00:00&limit=500`,
    {
      notes:
        'Morocco sample: Marrakech (31.63,-8.0), maxradius 2.7 deg (~300 km), 12 months. Radius parameters are degrees.',
    },
  );
  await captureUrl(
    SOURCE,
    'eventid-late-update.json',
    `${FDSN}?format=json&eventid=${LATE_UPDATE_UNID}`,
    {
      notes:
        'Event whose lastupdate is ~1 year after origin time (re-revised on 2026-09-19). Update case: lastupdate changed -> new version.',
    },
  );
  await captureUrl(SOURCE, 'format-geojson-400.json', `${FDSN}?format=geojson&limit=1`, {
    notes:
      'format=geojson is rejected with HTTP 400 (body is JSON {"detail": ...}); the GeoJSON format is format=json.',
  });
  await captureUrl(
    SOURCE,
    'nodata-204.txt',
    `${FDSN}?format=json&starttime=2026-09-18T00:00:00&endtime=2026-09-18T00:00:01&minmag=9`,
    {
      notes:
        'Empty result: FDSN nodata behaviour (expected HTTP 204 with empty body unless nodata=404).',
    },
  );
}

async function revisions() {
  console.log('EMSC revisions');
  const t0Text = await readFile(join(FIXTURE_ROOT, SOURCE, 'updatedafter-t0.json'), 'utf8');
  const t0 = JSON.parse(t0Text);
  const byId = new Map(t0.features.map((f) => [f.id, f.properties.lastupdate]));
  const unids = [...byId.keys()];
  // Re-query each t0 event by eventid would cost many requests; instead poll updatedafter over the whole interval.
  const oldest = t0.features
    .map((f) => f.properties.lastupdate)
    .sort()[0]
    .slice(0, 19);
  const url = `${FDSN}?format=json&updatedafter=${oldest}&limit=2000`;
  const r = await politeFetch(url);
  const t1Text = r.body.toString('utf8');
  const t1 = JSON.parse(t1Text);
  const changed = new Set(
    t1.features
      .filter((f) => byId.has(f.id) && byId.get(f.id) !== f.properties.lastupdate)
      .map((f) => f.id),
  );
  const diffs = {};
  const t0m = new Map(t0.features.map((f) => [f.id, f.properties]));
  for (const f of t1.features) {
    if (!changed.has(f.id)) continue;
    const a = t0m.get(f.id);
    const b = f.properties;
    diffs[f.id] = Object.keys(b)
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .join(',');
  }
  console.log(`  t0 events ${unids.length}, changed ${changed.size}`, diffs);
  const a = trimFeatureCollection(t0Text, (f) => changed.has(f.id));
  const b = trimFeatureCollection(t1Text, (f) => changed.has(f.id));
  await saveFixture(SOURCE, 'revision-t0.json', a.text, {
    url: 'see updatedafter-t0.json',
    http_status: 200,
    content_type: 'application/json',
    notes: `TRIMMED from updatedafter-t0.json to the ${a.kept} events whose lastupdate changed by t1. Changed properties: ${JSON.stringify(diffs)}`,
  });
  await saveFixture(SOURCE, 'revision-t1.json', b.text, {
    url,
    http_status: r.status,
    content_type: r.contentType,
    notes: `TRIMMED to the same ${b.kept} events as revision-t0.json, polled later (real revisions: same unid, newer lastupdate).`,
  });
}

async function ws(secs = 180) {
  console.log(`EMSC websocket listen ${secs}s`);
  const url = 'wss://www.seismicportal.eu/standing_order/websocket';
  const msgs = [];
  await new Promise((resolve) => {
    const sock = new WebSocket(url, { headers: { 'User-Agent': USER_AGENT } });
    const timer = setTimeout(() => sock.close(), secs * 1000);
    sock.onopen = () => console.log('  open', new Date().toISOString());
    sock.onmessage = (ev) => {
      msgs.push({ received_at: new Date().toISOString(), data: String(ev.data) });
      console.log('  msg', String(ev.data).slice(0, 120));
    };
    sock.onerror = (e) => console.log('  ws error', e?.message ?? e);
    sock.onclose = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  await saveFrames(url, secs, msgs);
}

/** Frames are pretty-printed multi-line JSON, so they are stored as a JSON array of the raw frame strings. */
async function saveFrames(url, secs, msgs) {
  const actions = msgs.map((m) => {
    try {
      return JSON.parse(m.data).action;
    } catch {
      return 'unparseable';
    }
  });
  const body =
    JSON.stringify(
      { frames: msgs.map((m) => m.data), received_at: msgs.map((m) => m.received_at) },
      null,
      2,
    ) + '\n';
  await saveFixture(SOURCE, 'websocket-frames.json', body, {
    url,
    http_status: 101,
    content_type:
      'application/json (wrapper: {frames: [raw websocket text frame strings], received_at: [...]})',
    notes: `Raw text frames received during a ${secs}s listen, each kept verbatim as a string. Actions: ${JSON.stringify(actions)}. Frame payload shape: {action, data: GeoJSON Feature}.`,
  });
}

/** Convert a legacy websocket-frames.ndjson (frames joined by "\n", frames may span lines) into websocket-frames.json. */
async function convertLegacy(secs) {
  const p = join(FIXTURE_ROOT, SOURCE, 'websocket-frames.ndjson');
  const text = await readFile(p, 'utf8');
  const frames = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) frames.push(text.slice(start, i + 1));
    }
  }
  await saveFrames(
    'wss://www.seismicportal.eu/standing_order/websocket',
    secs,
    frames.map((data) => ({ data, received_at: null })),
  );
  await unlink(p);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'main') await main();
else if (cmd === 'revisions') await revisions();
else if (cmd === 'ws') await ws(Number(arg ?? 180));
else if (cmd === 'ws-convert') await convertLegacy(Number(arg ?? 1500));
else {
  console.error('usage: capture-emsc.mjs main | revisions | ws [secs]');
  process.exit(2);
}
