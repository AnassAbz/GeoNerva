/**
 * The committed golden snapshot for USGS normalization (docs/TESTING.md §4.3).
 *
 * Field-by-field assertions check the things someone thought to check. This checks *everything*,
 * including `contentSha256` — which is the only change detector (ADR-029), so an accidental
 * change to what the hash covers shows up here as a diff rather than as a silent wave of
 * revisions in production.
 *
 * When this test fails, the question is not "how do I update the file". It is: did I mean to
 * change what a revision is? If yes, regenerate with `UPDATE_GOLDEN=1` and say so in the commit
 * message, because every existing record will get one spurious version on the next poll.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { readFixtureJson } from '@geonerva/test-fixtures';

import { usgsDescriptor } from './adapter.ts';
import { normalizeUsgsFeature } from './normalize.ts';
import { usgsFeatureSchema } from './schema.ts';

const GOLDEN_PATH = new URL('./normalized.golden.json', import.meta.url);

/** The normalized record, with binary fields rendered as hex so the file is readable. */
function snapshot(feature: unknown): unknown {
  const parsed = usgsFeatureSchema.parse(feature);
  const record = normalizeUsgsFeature(parsed, { descriptor: usgsDescriptor });
  return {
    ...record,
    observedAt: record.observedAt.toISOString(),
    sourceUpdatedAt: record.sourceUpdatedAt?.toISOString() ?? null,
    contentSha256: record.contentSha256.toString('hex'),
    rawPayloadSha256: record.rawPayloadSha256.toString('hex'),
    // The raw payload is the input, which is already committed as a fixture.
    rawPayload: undefined,
  };
}

/** Cases chosen to cover the fields most likely to be got wrong, not to be exhaustive. */
function buildSnapshots(): Record<string, unknown> {
  const t0 = readFixtureJson('usgs', 'revision-t0.geojson') as { features: unknown[] };
  const t1 = readFixtureJson('usgs', 'revision-t1.geojson') as { features: unknown[] };
  const pager = readFixtureJson('usgs', 'summary-pager-alert.geojson') as { features: unknown[] };
  const alias = readFixtureJson('usgs', 'fdsn-eventid-by-alias.geojson');

  return {
    // The same event before and after a real revision: the two hashes must differ.
    'revision/before': snapshot(t0.features[0]),
    'revision/after': snapshot(t1.features[0]),
    // PAGER alert, felt reports and instrumental intensity all present.
    'pager-alert': snapshot(pager.features[0]),
    // Three aliases, a preferred id that is not the one we queried by.
    'renamed-identity': snapshot(alias),
  };
}

describe('normalized output', () => {
  it('matches the committed golden snapshot', () => {
    const actual = buildSnapshots();

    if (process.env['UPDATE_GOLDEN'] === '1') {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    }

    const expected: unknown = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    // Round-trip through JSON so `undefined` and key order are compared the same way both sides.
    expect(JSON.parse(JSON.stringify(actual))).toStrictEqual(expected);
  });

  it('gives the two sides of a real revision different hashes', () => {
    // Guards against a golden file that was regenerated from broken code: if normalization
    // collapsed, every snapshot would agree with itself and the test above would still pass.
    const snapshots = buildSnapshots() as Record<string, { contentSha256: string }>;
    expect(snapshots['revision/before']?.contentSha256).not.toBe(
      snapshots['revision/after']?.contentSha256,
    );
  });
});
