// Shared helpers for GeoNerva fixture capture scripts.
// Dependency-free Node ESM (Node >= 22; developed on Node 24).
//
// - politeFetch: sequential, per-host minimum gap, timeout, identifying User-Agent.
// - saveFixture: writes bytes verbatim, computes sha256, upserts the source MANIFEST.json.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_AGENT = 'GeoNerva-fixture-capture/0.1 (open-source hazard-intelligence project)';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const FIXTURE_ROOT = join(REPO_ROOT, 'packages', 'test-fixtures', 'sources');

/** Minimum gap between two requests to the same host (ms). */
const HOST_GAP_MS = {
  'nominatim.openstreetmap.org': 1500,
  'www.seismicportal.eu': 1100,
};
const DEFAULT_GAP_MS = 1000;
const lastRequestAt = new Map();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polite fetch. Never throws on HTTP status; throws only on network error.
 * On timeout returns { status: 0, timedOut: true, body: empty }.
 * @returns {Promise<{status:number, contentType:string|null, headers:Record<string,string>, body:Buffer, url:string, timedOut:boolean, elapsedMs:number}>}
 */
export async function politeFetch(url, { timeoutMs = 60_000, headers = {}, method = 'GET' } = {}) {
  const host = new URL(url).host;
  const gap = HOST_GAP_MS[host] ?? DEFAULT_GAP_MS;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(host, Date.now());
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const body = Buffer.from(await res.arrayBuffer());
    const hdrs = Object.fromEntries(res.headers.entries());
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      headers: hdrs,
      body,
      url,
      timedOut: false,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return { status: 0, contentType: null, headers: {}, body: Buffer.alloc(0), url, timedOut: true, elapsedMs: Date.now() - started };
    }
    throw err;
  } finally {
    clearTimeout(timer);
    lastRequestAt.set(host, Date.now());
  }
}

export async function fetchJson(url, opts) {
  const r = await politeFetch(url, opts);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}: ${r.body.toString('utf8').slice(0, 200)}`);
  return JSON.parse(r.body.toString('utf8'));
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Redact API keys embedded in URLs (FIRMS MAP_KEY path segment or query). */
export function redactUrl(url) {
  return url
    .replace(/(\/api\/[a-z_]+\/csv\/)([^/]+)(\/)/i, (m, a, key, c) => (key === 'INVALIDKEY000' ? m : `${a}<MAP_KEY>${c}`))
    .replace(/(MAP_KEY=)([^&]+)/i, (m, a, key) => (key === 'INVALIDKEY000' ? m : `${a}<MAP_KEY>`));
}

async function readManifest(source) {
  const p = join(FIXTURE_ROOT, source, 'MANIFEST.json');
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return { source, fixtures: [] };
  }
}

async function writeManifest(source, manifest) {
  const p = join(FIXTURE_ROOT, source, 'MANIFEST.json');
  manifest.fixtures.sort((a, b) => a.file.localeCompare(b.file));
  await writeFile(p, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * Write a fixture byte-exact and upsert its MANIFEST entry.
 * @param {string} source e.g. 'usgs'
 * @param {string} file   e.g. 'all_day.geojson'
 * @param {Buffer|string} body
 * @param {{url?:string|null, http_status?:number|null, content_type?:string|null, notes?:string, synthetic?:boolean, derived_from?:string|null, captured_at?:string, extra?:object}} meta
 */
export async function saveFixture(source, file, body, meta = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const dir = join(FIXTURE_ROOT, source);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), buf);
  const manifest = await readManifest(source);
  const entry = {
    file,
    url: meta.url ? redactUrl(meta.url) : null,
    captured_at: meta.captured_at ?? new Date().toISOString(),
    sha256: sha256(buf),
    bytes: buf.length,
    http_status: meta.http_status ?? null,
    content_type: meta.content_type ?? null,
    notes: meta.notes ?? '',
    synthetic: meta.synthetic ?? false,
    derived_from: meta.derived_from ?? null,
    ...(meta.extra ?? {}),
  };
  manifest.fixtures = manifest.fixtures.filter((f) => f.file !== file);
  manifest.fixtures.push(entry);
  await writeManifest(source, manifest);
  console.log(`  saved ${source}/${file} (${buf.length} B, HTTP ${entry.http_status})`);
  return entry;
}

/** Fetch a URL and store the response verbatim as a fixture. */
export async function captureUrl(source, file, url, { notes = '', timeoutMs, headers, transform } = {}) {
  const r = await politeFetch(url, { timeoutMs, headers });
  let body = r.body;
  let extraNotes = '';
  if (transform) {
    const t = await transform(r);
    body = t.body;
    extraNotes = t.notes ?? '';
  }
  const entry = await saveFixture(source, file, body, {
    url,
    http_status: r.timedOut ? null : r.status,
    content_type: r.contentType,
    notes: [notes, extraNotes, r.timedOut ? `TIMED OUT after ${r.elapsedMs} ms (body empty)` : ''].filter(Boolean).join(' '),
  });
  return { ...r, entry };
}

/** Great-circle distance in km (haversine, R = 6371.0088). */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isoNow() {
  return new Date().toISOString();
}

/**
 * Split the raw text of a JSON document into { prefix, elements[], suffix } where
 * elements are the raw (byte-exact) texts of the items of the array stored under
 * `key` at depth 1 of the root object. Used for deterministic trimming without
 * re-serialising provider JSON.
 */
export function splitTopLevelArray(text, key) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let strStart = -1;
  let lastString = null;
  let arrStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') {
        inStr = false;
        lastString = text.slice(strStart + 1, i);
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      strStart = i;
      continue;
    }
    if (c === '{' || c === '[') {
      if (c === '[' && depth === 1 && lastString === key) {
        arrStart = i;
        break;
      }
      depth++;
    } else if (c === '}' || c === ']') depth--;
    else if (c === ',') lastString = null;
  }
  if (arrStart < 0) throw new Error(`array "${key}" not found at top level`);
  const elements = [];
  depth = 0;
  inStr = false;
  esc = false;
  let elStart = -1;
  let separator = null;
  let i = arrStart + 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      if (elStart < 0) elStart = i;
      continue;
    }
    if (depth === 0 && (c === ',' || c === ']')) {
      if (elStart >= 0) {
        const raw = text.slice(elStart, i);
        const trimmed = raw.trimEnd();
        elements.push(trimmed);
        // separator = trailing whitespace + ',' + leading whitespace of the next element
        if (c === ',' && separator === null) {
          let k = i + 1;
          while (k < text.length && /\s/.test(text[k])) k++;
          separator = raw.slice(trimmed.length) + text.slice(i, k);
        }
      }
      elStart = -1;
      if (c === ']') break;
      continue;
    }
    if (c === '{' || c === '[') {
      if (depth === 0 && elStart < 0) elStart = i;
      depth++;
    } else if (c === '}' || c === ']') depth--;
    else if (depth === 0 && elStart < 0 && !/\s/.test(c)) elStart = i;
  }
  return { prefix: text.slice(0, arrStart + 1), elements, suffix: text.slice(i), separator: separator ?? ',' };
}

/** Rebuild a document from splitTopLevelArray parts keeping only the given raw elements. */
export function joinTopLevelArray({ prefix, suffix, separator }, elements) {
  return prefix + elements.join(separator ?? ',') + suffix;
}

/** Keep only features for which pred(parsedFeature, index) is true; byte-exact per feature. */
export function trimFeatureCollection(text, pred, key = 'features') {
  const parts = splitTopLevelArray(text, key);
  const kept = parts.elements.filter((raw, i) => pred(JSON.parse(raw), i));
  return { text: joinTopLevelArray(parts, kept), kept: kept.length, total: parts.elements.length };
}
