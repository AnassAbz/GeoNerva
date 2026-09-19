// Verify every fixture under packages/test-fixtures/sources/**:
//   - each MANIFEST.json entry points at an existing file whose sha256 and byte size match
//   - every fixture file is listed in its MANIFEST
//   - required manifest fields are present; synthetic entries name derived_from
//   - JSON / GeoJSON / NDJSON parse; CSV has a consistent column count; XML is well-formed-ish
//     (balanced tags, via a small dependency-free checker)
//   - no obvious secrets (32-char FIRMS MAP_KEY-looking path segments, "api_key=", bearer tokens)
//   - total size <= 6 MB
//
// Usage: node scripts/capture-fixtures/verify-manifests.mjs [--prune]
//   --prune  drop MANIFEST entries whose file no longer exists (then re-verify)

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { FIXTURE_ROOT, sha256 } from './lib.mjs';

const MAX_TOTAL = 6 * 1024 * 1024;
const REQUIRED = [
  'file',
  'url',
  'captured_at',
  'sha256',
  'http_status',
  'content_type',
  'notes',
  'synthetic',
  'derived_from',
];
const prune = process.argv.includes('--prune');

function checkXml(text) {
  // Strip comments, CDATA, processing instructions, doctype; then check tag balance.
  const s = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^>]*?)?)(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) {
      const top = stack.pop();
      if (top !== name) throw new Error(`XML: </${name}> closes <${top}>`);
    } else stack.push(name);
  }
  if (stack.length) throw new Error(`XML: unclosed <${stack.pop()}>`);
}

function checkCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l !== '');
  if (!lines.length) throw new Error('CSV: empty');
  const n = lines[0].split(',').length;
  lines.forEach((l, i) => {
    if (l.split(',').length !== n)
      throw new Error(`CSV: line ${i + 1} has ${l.split(',').length} cols, header ${n}`);
  });
  return lines.length - 1;
}

function parseCheck(file, buf, entry) {
  const ext = extname(file).toLowerCase();
  const text = buf.toString('utf8');
  const expectBroken = entry.expect_parse_error === true;
  try {
    if (ext === '.json' || ext === '.geojson') {
      if (buf.length) JSON.parse(text);
    } else if (ext === '.ndjson') {
      text
        .split('\n')
        .filter(Boolean)
        .forEach((l) => JSON.parse(l));
    } else if (ext === '.csv') checkCsv(text);
    else if (ext === '.xml') checkXml(text);
    // .txt / .html: raw provider bodies, no structural check
  } catch (e) {
    if (expectBroken) return 'expected-parse-error';
    throw e;
  }
  if (expectBroken) throw new Error('marked expect_parse_error but parsed fine');
  return 'ok';
}

const SECRET_PATTERNS = [
  /\/api\/[a-z_]+\/csv\/(?!INVALIDKEY000|<MAP_KEY>)[0-9a-f]{32}\//i,
  /MAP_KEY=(?!INVALIDKEY000|<MAP_KEY>)[0-9a-f]{32}/i,
  /api[_-]?key=[A-Za-z0-9]{16,}/i,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /[A-Za-z0-9._%+-]+@gmail\.com/i,
];

let errors = 0;
let total = 0;
const perSource = {};
const fail = (msg) => {
  errors++;
  console.error('FAIL', msg);
};

for (const source of (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()) {
  const dir = join(FIXTURE_ROOT, source);
  const manifestPath = join(dir, 'MANIFEST.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    fail(`${source}: MANIFEST.json missing or invalid (${e.message})`);
    continue;
  }
  const files = (await readdir(dir)).filter((f) => f !== 'MANIFEST.json');
  if (prune) {
    const before = manifest.fixtures.length;
    manifest.fixtures = manifest.fixtures.filter((f) => files.includes(f.file));
    if (manifest.fixtures.length !== before) {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      console.log(
        `pruned ${before - manifest.fixtures.length} stale entries from ${source}/MANIFEST.json`,
      );
    }
  }
  const listed = new Set();
  let bytes = (await stat(manifestPath)).size;
  let ok = 0;
  for (const entry of manifest.fixtures) {
    listed.add(entry.file);
    for (const k of REQUIRED)
      if (!(k in entry)) fail(`${source}/${entry.file}: manifest field "${k}" missing`);
    if (entry.synthetic && !entry.derived_from)
      fail(`${source}/${entry.file}: synthetic without derived_from`);
    let buf;
    try {
      buf = await readFile(join(dir, entry.file));
    } catch {
      fail(`${source}/${entry.file}: listed in MANIFEST but missing`);
      continue;
    }
    bytes += buf.length;
    if (sha256(buf) !== entry.sha256) fail(`${source}/${entry.file}: sha256 mismatch`);
    if (entry.bytes !== undefined && entry.bytes !== buf.length)
      fail(`${source}/${entry.file}: size mismatch`);
    try {
      parseCheck(entry.file, buf, entry);
    } catch (e) {
      fail(`${source}/${entry.file}: ${e.message}`);
    }
    const text = buf.toString('utf8') + JSON.stringify(entry);
    for (const re of SECRET_PATTERNS)
      if (re.test(text))
        fail(`${source}/${entry.file}: possible secret/personal data matches ${re}`);
    ok++;
  }
  for (const f of files) if (!listed.has(f)) fail(`${source}/${f}: file not listed in MANIFEST`);
  const synth = manifest.fixtures.filter((f) => f.synthetic).length;
  perSource[source] = {
    fixtures: manifest.fixtures.length,
    real: manifest.fixtures.length - synth,
    synthetic: synth,
    bytes,
  };
  total += bytes;
  console.log(
    `${source.padEnd(12)} ${String(ok).padStart(3)} fixtures verified (${synth} synthetic), ${(bytes / 1024).toFixed(1)} KiB`,
  );
}

console.log(
  `TOTAL ${(total / 1024 / 1024).toFixed(2)} MiB (${total} bytes) across ${Object.keys(perSource).length} sources`,
);
if (total > MAX_TOTAL) fail(`total fixture size ${total} > ${MAX_TOTAL}`);
if (errors) {
  console.error(`${errors} error(s)`);
  process.exit(1);
}
console.log('OK: all manifests verified');
