// Nominatim (OSMF public instance) fixtures. Exactly 2 requests, >= 1.5 s apart (usage policy: <= 1 req/s,
// identifying User-Agent, no bulk). The 429 fixture is synthetic (see derive-drift.mjs) — we do not provoke throttling.
//
// Usage: node scripts/capture-fixtures/capture-nominatim.mjs main

import { captureUrl } from './lib.mjs';

const SOURCE = 'nominatim';
const N = 'https://nominatim.openstreetmap.org/search';

async function main() {
  console.log('Nominatim main (2 requests)');
  await captureUrl(SOURCE, 'search-marrakech.json', `${N}?q=Marrakech&format=jsonv2&limit=5&addressdetails=1`, {
    notes: 'Free-text search, format=jsonv2, limit=5, addressdetails=1.',
  });
  await captureUrl(SOURCE, 'search-empty.json', `${N}?q=zzqxv%20nonexistent%20placename%2012345&format=jsonv2&limit=5`, {
    notes: 'Search with no match: HTTP 200 with an empty JSON array.',
  });
}

const cmd = process.argv[2];
if (cmd === 'main') await main();
else {
  console.error('usage: capture-nominatim.mjs main');
  process.exit(2);
}
