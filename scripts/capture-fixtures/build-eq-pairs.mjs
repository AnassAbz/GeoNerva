// Build the labelled USGS <-> EMSC earthquake correlation set
//   packages/test-fixtures/sources/correlation/eq-pairs.json
//
// Method (see the "method" block written into the output):
//   1. USGS FDSN: global M>=4.5 for the last 12 months + Euro-Med/North-Africa M3-4.5 (2 requests).
//   2. Seeded sample: random global M>=4.5, "sequence" events (another USGS M>=4.5 within 1 h and 100 km),
//      and Euro-Med M3-4.5 events.
//   3. For each sampled USGS event U:
//        - EMSC EventID service  convert?source_id=U&source_catalog=USGS&out_catalog=UNID   -> unid S (+ misfit) or 404
//        - EMSC FDSN window query (format=json, +-1 h, maxradius 1 deg ~111 km) -> candidates C with EMSC values
//        - if S is not in the window, EMSC FDSN eventid=S (values of the matched event)
//   4. Labels:
//        MATCH    (U, S)                          label_source=emsc_eventid_service
//        NO_MATCH (U, C) for C != S, C within 1 h and <= 100 km (hard negatives; closest in time per U, 60 hardest overall)
//                                                  label_source=emsc_eventid_service (inferred: service maps U to S != C)
//        Pairs listed in eq-pairs-hand-checks.json override the above with label_source=hand_checked + notes.
//
// Usage:
//   node scripts/capture-fixtures/build-eq-pairs.mjs            # fetch (cached in $TMP/geonerva-eq-pairs-cache) and build
//   node scripts/capture-fixtures/build-eq-pairs.mjs --review   # also print sequence candidates for hand-checking
//
// Request budget: ~2 USGS + <= 2 EMSC requests per sampled event (+1 for out-of-window matches); < 700 total.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineKm, politeFetch, saveFixture, sha256 } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(tmpdir(), 'geonerva-eq-pairs-cache');
const SEED = 20260919;
const START = '2025-09-19T00:00:00';
const END = '2026-09-19T00:00:00';
const N_GLOBAL = 95;
const N_SEQUENCE = 45;
const N_EUROMED = 50;
const EUROMED = { minlatitude: 25, maxlatitude: 50, minlongitude: -20, maxlongitude: 45 };
const WINDOW_S = 3600;
const WINDOW_DEG = 1.0;
const HARD_NEG_KM = 100;
const MAX_NEG_PER_EVENT = 1;
const MAX_AUTO_NEG = 35; // hardest (smallest |dt|) service-inferred negatives kept; hand-checked pairs are always kept
const review = process.argv.includes('--review');

let requests = 0;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function sample(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Cached GET returning {status, text}. */
async function cachedGet(url) {
  await mkdir(CACHE, { recursive: true });
  const p = join(CACHE, sha256(Buffer.from(url)).slice(0, 32) + '.json');
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    /* miss */
  }
  const r = await politeFetch(url, { timeoutMs: 120_000 });
  requests++;
  if (r.timedOut || r.status >= 500) throw new Error(`HTTP ${r.status} (timeout=${r.timedOut}) for ${url}`);
  const out = { status: r.status, text: r.body.toString('utf8') };
  await writeFile(p, JSON.stringify(out));
  return out;
}

const qs = (o) => new URLSearchParams(o).toString();

function usgsRec(f) {
  const [lon, lat, depth] = f.geometry.coordinates;
  const p = f.properties;
  return { id: f.id, time: new Date(p.time).toISOString(), lat, lon, depth_km: depth, mag: p.mag, magType: p.magType, ids: p.ids };
}
function emscRec(f) {
  const p = f.properties;
  const t = p.time.endsWith('Z') ? p.time : p.time + 'Z';
  return { unid: p.unid, time: new Date(t).toISOString(), lat: p.lat, lon: p.lon, depth_km: p.depth, mag: p.mag, magType: p.magtype, auth: p.auth, lastupdate: p.lastupdate };
}
function delta(u, e) {
  return {
    dt_s: Math.round((Date.parse(e.time) - Date.parse(u.time)) / 10) / 100,
    dist_km: Math.round(haversineKm(u.lat, u.lon, e.lat, e.lon) * 10) / 10,
    dmag: e.mag == null || u.mag == null ? null : Math.round((e.mag - u.mag) * 100) / 100,
    ddepth_km: Math.round((e.depth_km - u.depth_km) * 10) / 10,
  };
}

async function main() {
  // 1. USGS
  const usgsUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?${qs({ format: 'geojson', starttime: START, endtime: END, minmagnitude: 4.5, eventtype: 'earthquake', orderby: 'time-asc' })}`;
  const g = JSON.parse((await cachedGet(usgsUrl)).text).features.map(usgsRec);
  const emUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?${qs({ format: 'geojson', starttime: START, endtime: END, minmagnitude: 3, maxmagnitude: 4.49, eventtype: 'earthquake', orderby: 'time-asc', ...EUROMED })}`;
  const em = JSON.parse((await cachedGet(emUrl)).text).features.map(usgsRec);
  console.log(`USGS global M>=4.5: ${g.length}; Euro-Med M3-4.5: ${em.length}`);

  // 2. sample
  const seqIds = new Set();
  for (let i = 0; i < g.length; i++) {
    for (let j = i + 1; j < g.length; j++) {
      const dt = (Date.parse(g[j].time) - Date.parse(g[i].time)) / 1000;
      if (dt > WINDOW_S) break;
      if (haversineKm(g[i].lat, g[i].lon, g[j].lat, g[j].lon) <= HARD_NEG_KM) {
        seqIds.add(g[i].id);
        seqIds.add(g[j].id);
      }
    }
  }
  const seq = sample(g.filter((u) => seqIds.has(u.id)), N_SEQUENCE);
  const seqSet = new Set(seq.map((u) => u.id));
  const glob = sample(g.filter((u) => !seqSet.has(u.id)), N_GLOBAL);
  const eu = sample(em, N_EUROMED);
  const picked = [...glob.map((u) => [u, 'global_m45']), ...seq.map((u) => [u, 'sequence_m45']), ...eu.map((u) => [u, 'euromed_m3_4.5'])];
  picked.sort((a, b) => a[0].time.localeCompare(b[0].time));
  console.log(`sampled: global ${glob.length}, sequence ${seq.length} (of ${seqIds.size}), euromed ${eu.length}`);

  // 3. EMSC
  const hand = JSON.parse(await readFile(join(here, 'eq-pairs-hand-checks.json'), 'utf8').catch(() => '{"checks":[]}')).checks;
  const handKey = new Map(hand.map((h) => [`${h.usgs_id}|${h.emsc_unid}`, h]));
  const pairs = [];
  const unmatched = [];
  const reviewRows = [];
  const windowCands = new Map(); // usgs id -> { u, subset, S, misfit, cands }
  for (const [u, subset] of picked) {
    const conv = await cachedGet(`https://www.seismicportal.eu/eventid/api/convert?${qs({ source_id: u.id, source_catalog: 'USGS', out_catalog: 'UNID' })}`);
    let S = null;
    let misfit = null;
    if (conv.status === 200) {
      const arr = JSON.parse(conv.text);
      if (arr.length) {
        S = arr[0].eventid;
        misfit = arr[0].misfit;
      }
    }
    const t = Date.parse(u.time);
    const win = await cachedGet(
      `https://www.seismicportal.eu/fdsnws/event/1/query?${qs({
        format: 'json',
        starttime: new Date(t - WINDOW_S * 1000).toISOString().slice(0, 19),
        endtime: new Date(t + WINDOW_S * 1000).toISOString().slice(0, 19),
        lat: u.lat.toFixed(4),
        lon: u.lon.toFixed(4),
        maxradius: WINDOW_DEG,
        limit: 300,
      })}`,
    );
    const cands = win.status === 200 && win.text ? JSON.parse(win.text).features.map(emscRec) : [];
    let matched = S ? cands.find((c) => c.unid === S) : null;
    if (S && !matched) {
      const one = await cachedGet(`https://www.seismicportal.eu/fdsnws/event/1/query?${qs({ format: 'json', eventid: S })}`);
      if (one.status === 200) matched = emscRec(JSON.parse(one.text));
    }
    windowCands.set(u.id, { u, subset, S, misfit, cands: matched && !cands.some((c) => c.unid === matched.unid) ? [...cands, matched] : cands });
    if (matched) {
      pairs.push({ u, e: matched, label: 'MATCH', source: 'emsc_eventid_service', misfit, subset });
    } else {
      unmatched.push({ usgs: u, subset, eventid_service: conv.status !== 200 ? `HTTP ${conv.status}` : S ? `unid ${S} not retrievable` : `HTTP 200, empty match list`, nearest_candidates: cands.map((c) => ({ ...c, delta: delta(u, c) })).sort((a, b) => Math.abs(a.delta.dt_s) - Math.abs(b.delta.dt_s)).slice(0, 2) });
    }
    const negs = cands
      .filter((c) => c.unid !== S)
      .map((c) => ({ c, d: delta(u, c) }))
      .filter(({ d }) => Math.abs(d.dt_s) <= WINDOW_S && d.dist_km <= HARD_NEG_KM);
    negs.sort((a, b) => Math.abs(a.d.dt_s) - Math.abs(b.d.dt_s));
    const hardNegs = negs.slice(0, MAX_NEG_PER_EVENT);
    for (const { c } of hardNegs) {
      if (S) pairs.push({ u, e: c, label: 'NO_MATCH', source: 'emsc_eventid_service', misfit: null, subset, inferred: true, S });
    }
    if (review && (negs.length || !matched)) reviewRows.push({ u, S, matched, negs: negs.slice(0, 4) });
  }
  // Keep only the hardest service-inferred negatives (smallest |dt|), always keeping hand-checked pairs.
  const isHand = (p) => handKey.has(`${p.u.id}|${p.e.unid}`);
  const autoNeg = pairs.filter((p) => p.label === 'NO_MATCH' && !isHand(p)).sort((a, b) => Math.abs(delta(a.u, a.e).dt_s) - Math.abs(delta(b.u, b.e).dt_s));
  const keepNeg = new Set(autoNeg.slice(0, MAX_AUTO_NEG));
  const kept = pairs.filter((p) => p.label === 'MATCH' || isHand(p) || keepNeg.has(p));
  // Hand checks may add pairs that were not auto-generated, as long as the EMSC event is in that USGS event's window.
  for (const h of hand) {
    if (kept.some((p) => p.u.id === h.usgs_id && p.e.unid === h.emsc_unid)) continue;
    const w = windowCands.get(h.usgs_id);
    const c = w?.cands.find((x) => x.unid === h.emsc_unid);
    if (c) kept.push({ u: w.u, e: c, label: h.label, source: 'hand_checked', misfit: null, subset: w.subset, S: w.S, added_by_hand: true });
  }

  // 4. apply hand checks and emit
  const out = [];
  const seen = new Set();
  kept.sort((a, b) => a.u.time.localeCompare(b.u.time) || (a.label === 'MATCH' ? -1 : 1));
  for (const p of kept) {
    const key = `${p.u.id}|${p.e.unid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const h = handKey.get(key);
    const entry = {
      pair_id: key.replace('|', '__'),
      usgs: { id: p.u.id, time: p.u.time, lat: p.u.lat, lon: p.u.lon, depth_km: p.u.depth_km, mag: p.u.mag, magType: p.u.magType },
      emsc: { unid: p.e.unid, time: p.e.time, lat: p.e.lat, lon: p.e.lon, depth_km: p.e.depth_km, mag: p.e.mag, magType: p.e.magType, auth: p.e.auth },
      delta: delta(p.u, p.e),
      label: h ? h.label : p.label,
      label_source: h ? 'hand_checked' : p.source,
      eventid_service: { unid: p.S ?? (p.label === 'MATCH' ? p.e.unid : null), misfit: p.misfit },
      subset: p.subset,
      ...(h?.ambiguous ? { ambiguous: true } : {}),
      notes: h
        ? h.notes +
          (p.added_by_hand
            ? ` [pair added by hand check; EventID service: ${p.S ? `maps ${p.u.id} to ${p.S}` : 'no match for ' + p.u.id}]`
            : h.label !== p.label
              ? ` [hand label ${h.label} overrides service-derived ${p.label}]`
              : ' [agrees with EventID service]')
        : p.inferred
          ? `Hard negative inferred: EventID service maps ${p.u.id} to ${p.S}; this EMSC event is a different event within ${WINDOW_S / 3600} h and ${HARD_NEG_KM} km.`
          : '',
    };
    out.push(entry);
  }
  for (const h of hand) if (!seen.has(`${h.usgs_id}|${h.emsc_unid}`)) console.warn(`WARN hand check not found among generated pairs: ${h.usgs_id}|${h.emsc_unid}`);

  const counts = {
    total: out.length,
    MATCH: out.filter((x) => x.label === 'MATCH').length,
    NO_MATCH: out.filter((x) => x.label === 'NO_MATCH').length,
    hand_checked: out.filter((x) => x.label_source === 'hand_checked').length,
    by_subset: Object.fromEntries(['global_m45', 'sequence_m45', 'euromed_m3_4.5'].map((s) => [s, out.filter((x) => x.subset === s).length])),
    usgs_events_sampled: picked.length,
    usgs_events_without_emsc_match: unmatched.length,
  };
  const doc = {
    description: 'Labelled USGS<->EMSC earthquake pairs for correlation calibration (G5). Ground truth: EMSC EventID service (itself a fuzzy misfit match) plus a hand-checked subset.',
    generated_at: new Date().toISOString(),
    method: {
      script: 'scripts/capture-fixtures/build-eq-pairs.mjs',
      seed: SEED,
      period: [START + 'Z', END + 'Z'],
      usgs_queries: [usgsUrl, emUrl],
      eventid_service: 'https://www.seismicportal.eu/eventid/api/convert?source_id=<USGS id>&source_catalog=USGS&out_catalog=UNID',
      emsc_window: `format=json, +-${WINDOW_S}s, maxradius=${WINDOW_DEG} deg around the USGS epicentre`,
      hard_negative_rule: `EMSC event != service match, |dt| <= ${WINDOW_S}s and distance <= ${HARD_NEG_KM} km, closest-in-time ${MAX_NEG_PER_EVENT} per USGS event, then the ${MAX_AUTO_NEG} smallest |dt| overall; hand-checked pairs always kept`,
      hand_checks: 'scripts/capture-fixtures/eq-pairs-hand-checks.json',
      caveats: [
        'The EventID service is a fuzzy misfit match (dloc/105 + dt/13 + dmag/0.8) tuned for M>4.5; MATCH labels from it are not independent ground truth.',
        'NO_MATCH labels inferred from the service assume a one-to-one USGS<->EMSC mapping.',
        'delta.dt_s = EMSC time - USGS time; delta.dmag = EMSC mag - USGS mag (magnitude types may differ).',
      ],
    },
    counts,
    pairs: out,
    usgs_without_emsc_match: unmatched,
  };
  await saveFixture('correlation', 'eq-pairs.json', JSON.stringify(doc, null, 2) + '\n', {
    synthetic: true,
    derived_from: 'USGS FDSN + EMSC EventID service + EMSC FDSN (live, 2026-09-19)',
    notes: `Labelled correlation set: ${JSON.stringify(counts)}. Built by build-eq-pairs.mjs (network requests this run: ${requests}).`,
  });
  console.log(counts, `network requests this run: ${requests}`);

  if (review) {
    for (const r of reviewRows) {
      console.log(`\nU ${r.u.id} ${r.u.time} M${r.u.mag}${r.u.magType} ${r.u.lat},${r.u.lon} d${r.u.depth_km}  service=${r.S}  matched=${r.matched ? 'yes' : 'NO'}`);
      if (r.matched) console.log(`   S ${r.matched.unid} ${JSON.stringify(delta(r.u, r.matched))} M${r.matched.mag}${r.matched.magType} ${r.matched.auth}`);
      for (const { c, d } of r.negs) console.log(`   C ${c.unid} ${JSON.stringify(d)} M${c.mag}${c.magType} ${c.auth}`);
    }
  }
}

await main();
