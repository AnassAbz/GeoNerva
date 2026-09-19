// ECCC MSC GeoMet `weather-alerts` — V1 (stable feature identity across polls).
//
// Usage:
//   node scripts/capture-fixtures/capture-eccc.mjs poll <label>     # store one full poll as weather-alerts-<label>.json
//   node scripts/capture-fixtures/capture-eccc.mjs analyze <a> <b>  # compare two stored polls, write identity-analysis-<a>-<b>.json
//   node scripts/capture-fixtures/capture-eccc.mjs pair             # poll "a", wait 150 s, poll "b", analyze
//
// P1 source: only V1 evidence is captured in P0.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_ROOT, captureUrl, saveFixture, sleep } from './lib.mjs';

const SOURCE = 'eccc';
const URL_ALL = 'https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=1000';

async function poll(label) {
  console.log(`ECCC poll ${label}`);
  const r = await captureUrl(SOURCE, `weather-alerts-${label}.json`, URL_ALL, {
    notes: `Full GeoMet weather-alerts collection (limit=1000, so un-paginated). Poll "${label}" for V1 identity analysis.`,
  });
  if (r.status !== 200) throw new Error(`poll failed: HTTP ${r.status}`);
}

function idParts(id) {
  // Observed shape: <digits><YYYYMMDDhhmm>_<feature_id>, e.g. 636507912014517831202609190507_fea1-869
  const m = /^(\d+?)(\d{12})_(.+)$/.exec(id);
  return m
    ? { prefix: m[1], stamp: m[2], suffix: m[3] }
    : { prefix: null, stamp: null, suffix: null };
}

async function analyze(a, b) {
  const load = async (l) =>
    JSON.parse(await readFile(join(FIXTURE_ROOT, SOURCE, `weather-alerts-${l}.json`), 'utf8'));
  const A = await load(a);
  const B = await load(b);
  const idsA = new Set(A.features.map((f) => f.id));
  const idsB = new Set(B.features.map((f) => f.id));
  const same = [...idsA].filter((x) => idsB.has(x));
  const onlyA = [...idsA].filter((x) => !idsB.has(x));
  const onlyB = [...idsB].filter((x) => !idsA.has(x));
  const key = (f) =>
    `${f.properties.feature_id}|${f.properties.alert_code}|${f.properties.validity_datetime}`;
  const byId = (fc) => new Map(fc.features.map((f) => [f.id, f]));
  const mA = byId(A);
  const mB = byId(B);
  const changedProps = [];
  for (const id of same) {
    const pa = mA.get(id).properties;
    const pb = mB.get(id).properties;
    const diff = Object.keys({ ...pa, ...pb }).filter(
      (k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k]),
    );
    if (diff.length) changedProps.push({ id, changed: diff });
  }
  // Is the `id` composite and does feature_id repeat within one poll?
  const featureIdDupA =
    A.features.length - new Set(A.features.map((f) => f.properties.feature_id)).size;
  const idPrefixes = new Set(A.features.map((f) => idParts(f.id).prefix + idParts(f.id).stamp));
  const suffixEqualsFeatureId = A.features.every(
    (f) => idParts(f.id).suffix === f.properties.feature_id,
  );
  const propKeys = [...new Set(A.features.flatMap((f) => Object.keys(f.properties)))].sort();
  const summary = {
    polls: {
      a: { label: a, timeStamp: A.timeStamp, count: A.features.length },
      b: { label: b, timeStamp: B.timeStamp, count: B.features.length },
    },
    ids_identical_across_polls: same.length,
    ids_only_in_a: onlyA,
    ids_only_in_b: onlyB,
    same_id_with_changed_properties: changedProps,
    distinct_alert_messages_in_a: idPrefixes.size,
    feature_id_duplicates_within_a: featureIdDupA,
    id_suffix_equals_properties_feature_id: suffixEqualsFeatureId,
    natural_key_collisions_in_a: A.features.length - new Set(A.features.map(key)).size,
    property_keys: propKeys,
  };
  await saveFixture(
    SOURCE,
    `identity-analysis-${a}-${b}.json`,
    JSON.stringify(summary, null, 2) + '\n',
    {
      synthetic: true,
      derived_from: `weather-alerts-${a}.json + weather-alerts-${b}.json`,
      notes: 'Computed by capture-eccc.mjs analyze; evidence for V1. Not a provider payload.',
    },
  );
  console.log(JSON.stringify({ ...summary, property_keys: undefined }, null, 2));
}

const [cmd, x, y] = process.argv.slice(2);
if (cmd === 'poll') await poll(x);
else if (cmd === 'analyze') await analyze(x, y);
else if (cmd === 'pair') {
  await poll('a');
  console.log('waiting 150 s ...');
  await sleep(150_000);
  await poll('b');
  await analyze('a', 'b');
} else {
  console.error('usage: capture-eccc.mjs poll <label> | analyze <a> <b> | pair');
  process.exit(2);
}
