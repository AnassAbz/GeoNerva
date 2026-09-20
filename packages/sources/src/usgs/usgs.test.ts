/**
 * The USGS adapter against real captured payloads (docs/TESTING.md §4.3).
 *
 * Every assertion here is about a failure that would otherwise be silent: a batch that ingests
 * half of itself, a revision invented by a re-stamped `updated`, a duplicate record created
 * because identity was keyed on a field USGS says may change, a station distance out by 111×.
 */

import { describe, expect, it } from 'vitest';

import { readFixtureBytes, readFixtureJson } from '@geonerva/test-fixtures';

import { NormalizationError, type ParseContext } from '../contract.ts';
import { parseUsgsFeed, usgsDescriptor } from './adapter.ts';
import { normalizeUsgsFeature, parseIds, roundStored, wrapLongitude } from './normalize.ts';
import { usgsFeatureSchema, type UsgsFeature } from './schema.ts';

const ctx: ParseContext = { descriptor: usgsDescriptor };
const normalizeCtx = { descriptor: usgsDescriptor };

function parse(file: string) {
  return parseUsgsFeed(readFixtureBytes('usgs', file), ctx);
}

function bodyOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** A minimal valid feature, for the cases no capture contains. */
function feature(overrides: Record<string, unknown> = {}): unknown {
  const properties = {
    mag: 2.5,
    place: 'somewhere',
    time: 1789850640280,
    updated: 1789850737127,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/nc1',
    detail: null,
    felt: null,
    cdi: null,
    mmi: null,
    alert: null,
    status: 'automatic',
    tsunami: 0,
    sig: 2,
    net: 'nc',
    code: '1',
    ids: ',nc1,',
    sources: ',nc,',
    types: ',origin,',
    nst: 8,
    dmin: 0.002881,
    rms: 0.01,
    gap: 117,
    magType: 'md',
    type: 'earthquake',
    title: 'M 2.5 - somewhere',
    ...(overrides['properties'] as Record<string, unknown> | undefined),
  };
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Point', coordinates: [-122.8, 38.7, 3.67] },
    id: 'nc1',
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'properties')),
  };
}

function feedOf(features: readonly unknown[], count: number | null = null): Uint8Array {
  return bodyOf({
    type: 'FeatureCollection',
    metadata: { generated: 1, url: 'x', title: 't', status: 200, api: '2.7.0', count },
    features,
  });
}

function parsedFeature(file: string, index = 0): UsgsFeature {
  const result = parse(file);
  if (result.verdict !== 'OK') throw new Error(`expected OK, got ${result.detail}`);
  const record = result.records[index];
  if (record === undefined) throw new Error(`no record at ${index}`);
  return record;
}

describe('parsing the real feed', () => {
  it('accepts the captured all_day feed whole', () => {
    const result = parse('all_day.geojson');
    expect(result.verdict).toBe('OK');
    if (result.verdict !== 'OK') return;
    expect(result.records).toHaveLength(230);
    expect(result.rejects).toHaveLength(0);
    expect(result.declaredCount).toBe(230);
  });

  it('tolerates an unknown field rather than failing the source', () => {
    // USGS adds product types over time. Refusing a batch for a field we do not read would take
    // the source down for a change that costs us nothing.
    const result = parse('drift-extra-field.json');
    expect(result.verdict).toBe('OK');
    if (result.verdict !== 'OK') return;
    expect(result.rejects).toHaveLength(0);
    expect(result.records).toHaveLength(230);
  });
});

describe('batch verdicts', () => {
  it.each([
    ['drift-truncated.json', 'a body cut in half'],
    ['drift-html-200.html', 'an HTML maintenance page served with HTTP 200'],
  ])('fails the whole batch for %s', (file) => {
    const result = parse(file);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('SCHEMA_DRIFT');
  });

  it('calls an empty feed suspicious rather than quiet', () => {
    // The single most misleading thing this system could do is report a broken feed as "no
    // earthquakes". USGS records ~400 a day; zero means the feed broke.
    const result = parse('drift-empty-collection.json');
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('EMPTY_SUSPICIOUS');
    expect(result.detail).toMatch(/silence is not normal/);
  });

  it.each([
    ['drift-missing-required.json', 'a removed required field'],
    ['drift-renamed-field.json', 'a renamed field'],
    ['drift-type-change.json', 'a changed field type'],
  ])('rejects one record for %s and keeps the rest', (file) => {
    const result = parse(file);
    expect(result.verdict).toBe('OK');
    if (result.verdict !== 'OK') return;
    expect(result.rejects).toHaveLength(1);
    expect(result.records).toHaveLength(229);
    expect(result.rejects[0]?.reasonCode).toBe('SCHEMA_INVALID');
    // The reject carries enough to find the record, and no more.
    expect(result.rejects[0]?.excerpt).toMatchObject({ id: expect.any(String) as unknown });
  });

  it('proceeds at the drift threshold and fails past it', () => {
    const good = Array.from({ length: 16 }, (_unused, index) =>
      feature({ id: `nc${index}`, properties: { ids: `,nc${index},` } }),
    );
    const bad = Array.from({ length: 4 }, () => ({ type: 'Feature', properties: {}, id: 'x' }));
    // 4 of 20 is exactly 20 %, which is not *above* the threshold.
    const atThreshold = parseUsgsFeed(feedOf([...good, ...bad]), ctx);
    expect(atThreshold.verdict).toBe('OK');

    const over = parseUsgsFeed(feedOf([...good.slice(0, 15), ...bad, { type: 'Feature' }]), ctx);
    expect(over.verdict).toBe('REJECTED');
    if (over.verdict !== 'REJECTED') return;
    expect(over.errorClass).toBe('SCHEMA_DRIFT');
    expect(over.detail).toMatch(/above the 20 % drift threshold/);
  });

  it('refuses a second copy of the same id instead of picking one', () => {
    const unique = Array.from({ length: 19 }, (_unused, index) =>
      feature({ id: `nc${index}`, properties: { ids: `,nc${index},` } }),
    );
    // The duplicate is one record in twenty, well under the drift threshold, so the batch stands
    // and the duplicate is visible as a reject rather than silently deduplicated.
    const result = parseUsgsFeed(feedOf([...unique, unique[0]]), ctx);
    expect(result.verdict).toBe('OK');
    if (result.verdict !== 'OK') return;
    expect(result.records).toHaveLength(19);
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]?.reasonCode).toBe('DUPLICATE_IN_BATCH');
  });

  it('calls a batch that is half duplicates drift, not a small batch', () => {
    const result = parseUsgsFeed(feedOf([feature(), feature()]), ctx);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('SCHEMA_DRIFT');
  });

  it('reports the declared count without acting on it', () => {
    // A trimmed or cached feed can disagree with its own metadata. That is worth seeing in the
    // run log; it is not worth stopping a source over.
    const result = parseUsgsFeed(feedOf([feature()], 230), ctx);
    expect(result.verdict).toBe('OK');
    if (result.verdict !== 'OK') return;
    expect(result.declaredCount).toBe(230);
    expect(result.records).toHaveLength(1);
  });
});

describe('identity', () => {
  it.each([
    [',nc75438582,', ['nc75438582']],
    // Sorted, not feed-ordered: the alias set is part of the content hash and ComCat reshuffles
    // `ids` when contributor preference changes.
    [',pt26261050,us7000tiar,pr2026261000,', ['pr2026261000', 'pt26261050', 'us7000tiar']],
    [',a,,a,', ['a']],
    [null, []],
  ])('parses ids %s', (ids, expected) => {
    expect(parseIds(ids)).toStrictEqual(expected);
  });

  it('is not a revision when the provider merely reorders ids', () => {
    const a = normalizeUsgsFeature(
      usgsFeatureSchema.parse(feature({ id: 'nc1', properties: { ids: ',nc1,us9,' } })),
      normalizeCtx,
    );
    const b = normalizeUsgsFeature(
      usgsFeatureSchema.parse(feature({ id: 'nc1', properties: { ids: ',us9,nc1,' } })),
      normalizeCtx,
    );
    expect(b.contentSha256.equals(a.contentSha256)).toBe(true);
  });

  it('keeps every alias of an event that changed its preferred id', () => {
    // P0 confirmed USGS answers a query for us7000tiar under pr2026261000. Both ids must resolve
    // to one record, or the same earthquake becomes two "independent" sources agreeing.
    // The capture is a bare Feature: FDSN answers a single-event query without an envelope.
    const parsedResult = usgsFeatureSchema.safeParse(
      readFixtureJson('usgs', 'fdsn-eventid-by-alias.geojson'),
    );
    expect(parsedResult.success).toBe(true);
    if (!parsedResult.success) return;

    const record = normalizeUsgsFeature(parsedResult.data, normalizeCtx);
    // Queried by us7000tiar, answered as pr2026261000 — one record, three ids.
    expect(record.primaryKey).toBe('pr2026261000');
    expect(record.aliases).toContain('us7000tiar');
    expect(record.aliases).toContain(record.primaryKey);
    expect(record.attributes['identity_refs']).toStrictEqual([...record.aliases]);
  });

  it('stops rather than create a duplicate when the id is missing from its own alias set', () => {
    const broken = usgsFeatureSchema.parse(feature({ properties: { ids: ',somethingelse,' } }));
    expect(() => normalizeUsgsFeature(broken, normalizeCtx)).toThrow(NormalizationError);
    try {
      normalizeUsgsFeature(broken, normalizeCtx);
    } catch (error) {
      // The failure has to be actionable without the payload.
      expect((error as NormalizationError).providerId).toBe('nc1');
      expect((error as NormalizationError).invariant).toBe('preferred-id-in-alias-set');
    }
  });
});

describe('normalization', () => {
  it('reads the captured feed end to end without raising', () => {
    const result = parse('all_day.geojson');
    if (result.verdict !== 'OK') throw new Error('fixture should parse');
    const records = result.records.map((raw) => normalizeUsgsFeature(raw, normalizeCtx));
    expect(records).toHaveLength(230);
    expect(records.every((record) => record.hazardType === 'EARTHQUAKE')).toBe(true);
    expect(records.every((record) => record.geometryKind === 'EPICENTER')).toBe(true);
    expect(records.every((record) => record.contentSha256.length === 32)).toBe(true);
  });

  it('converts dmin from degrees to kilometres', () => {
    const raw = parsedFeature('all_day.geojson');
    const record = normalizeUsgsFeature(raw, normalizeCtx);
    const dmin = raw.properties.dmin;
    expect(dmin).not.toBeNull();
    // 0.002881° is ~0.32 km. Stored raw it would read as 0.003 km — a 111× understatement of how
    // well constrained the solution is. Rounded to the two decimals the column holds.
    expect(record.attributes['min_station_distance_km']).toBeCloseTo(dmin! * 111.195, 2);
    expect(record.attributes['min_station_distance_km']).toBe(0.32);
    expect(record.attributes['min_station_distance_km']).not.toBe(dmin);
  });

  it('keeps a null magnitude instead of inventing one', () => {
    // Real USGS data: sonic booms carry mag: null. A zero here would be a fabricated measurement.
    const json = readFixtureJson('usgs', 'fdsn-mag-null-sonic-boom.geojson') as {
      features: unknown[];
    };
    const withNullMag = json.features
      .map((candidate) => usgsFeatureSchema.safeParse(candidate))
      .find((result) => result.success && result.data.properties.mag === null);
    expect(withNullMag?.success).toBe(true);
    if (withNullMag?.success !== true) return;

    const record = normalizeUsgsFeature(withNullMag.data, normalizeCtx);
    expect(record.magnitude).toBeNull();
  });

  it('accepts a negative depth, which means above sea level', () => {
    const shallow = usgsFeatureSchema.parse(
      feature({ geometry: { type: 'Point', coordinates: [-122.8, 38.7, -1.5] } }),
    );
    expect(normalizeUsgsFeature(shallow, normalizeCtx).depthKm).toBe(-1.5);
  });

  it('treats the provider timestamps as epoch milliseconds UTC', () => {
    const record = normalizeUsgsFeature(usgsFeatureSchema.parse(feature()), normalizeCtx);
    expect(record.observedAt.toISOString()).toBe(new Date(1789850640280).toISOString());
    expect(record.observedAt.getTime()).toBe(1789850640280);
    expect(record.sourceUpdatedAt?.getTime()).toBe(1789850737127);
  });

  it('marks a deleted event as a tombstone rather than dropping it', () => {
    const json = readFixtureJson('usgs', 'fdsn-includedeleted-only.geojson') as {
      features: unknown[];
    };
    const deleted = json.features
      .map((candidate) => usgsFeatureSchema.safeParse(candidate))
      .find((result) => result.success && result.data.properties.status === 'deleted');
    expect(deleted?.success).toBe(true);
    if (deleted?.success !== true) return;

    const record = normalizeUsgsFeature(deleted.data, normalizeCtx);
    expect(record.lifecycleStatus).toBe('DELETED');
    expect(record.providerStatus).toBe('deleted');
  });

  it('carries the PAGER alert as a scheme-tagged severity', () => {
    const json = readFixtureJson('usgs', 'summary-pager-alert.geojson') as { features: unknown[] };
    const parsedResult = usgsFeatureSchema.safeParse(json.features[0]);
    expect(parsedResult.success).toBe(true);
    if (!parsedResult.success) return;

    const record = normalizeUsgsFeature(parsedResult.data, normalizeCtx);
    expect(record.severityScheme).toBe('PAGER');
    expect(record.severityValue).toBe(parsedResult.data.properties.alert);
  });

  it('refuses (0, 0), which is a missing coordinate and not a place', () => {
    const nullIsland = usgsFeatureSchema.parse(
      feature({ geometry: { type: 'Point', coordinates: [0, 0, 10] } }),
    );
    try {
      normalizeUsgsFeature(nullIsland, normalizeCtx);
      expect.unreachable();
    } catch (error) {
      const failure = error as NormalizationError;
      expect(failure.reasonCode).toBe('NULL_ISLAND');
      // One bad record, not a dead source.
      expect(failure.isRecordLevel).toBe(true);
    }
  });

  it.each([
    [180, -180],
    [-180, -180],
    [180.5, -179.5],
    [179.899, 179.899],
    [-155.285507202148, -155.285507202148],
  ])('wraps longitude %p to %p instead of refusing it', (input, expected) => {
    // USGS publishes Kermadec and Fiji events on the antimeridian, and a captured month of M4.5+
    // data already reached 179.899. `isNormalizedLongitude` excludes exactly 180, so rejecting
    // would take the source dark for the 24 hours `all_day` keeps republishing that event.
    expect(wrapLongitude(input)).toBe(expected);
    const onTheLine = usgsFeatureSchema.parse(
      feature({ geometry: { type: 'Point', coordinates: [input, -27.86, 94] } }),
    );
    expect(normalizeUsgsFeature(onTheLine, normalizeCtx).centroid.lon).toBe(expected);
  });

  it.each([
    ['cdi', { cdi: 15 }],
    ['gap', { gap: 400 }],
    ['sig', { sig: 9_000 }],
    ['nst', { nst: 2.5 }],
  ])('rejects an out-of-range %s rather than quietly clamping it', (field, properties) => {
    /*
     * Clamping looks harmless and is not: the clamped value goes into the content hash, so a
     * provider revising gap from 380 to 500 — both clamped to 360 — would hash identically and a
     * real revision would be discarded as `unchanged`.
     */
    const bad = usgsFeatureSchema.parse(feature({ properties }));
    try {
      normalizeUsgsFeature(bad, normalizeCtx);
      expect.unreachable();
    } catch (error) {
      const failure = error as NormalizationError;
      expect(failure.reasonCode).toBe('SCHEMA_INVALID');
      expect(failure.isRecordLevel, `${field} must not kill the batch`).toBe(true);
      expect(failure.message).toContain(field);
    }
  });

  it.each([
    [8.245, 8.25],
    [-8.245, -8.25],
    [2.567, 2.57],
    [0.005, 0.01],
    [3.67000007629395, 3.67],
    [1.5, 1.5],
    [-0.004, 0],
  ])('rounds %p to %p, the way numeric(_, 2) would', (input, expected) => {
    // Verified against PostgreSQL: SELECT 8.245::numeric(6,2) is 8.25, because `pg` sends the
    // decimal string "8.245" and numeric rounds half away from zero. Math.round(v * 100) / 100
    // gives 8.24 here, and would hash a value the database does not hold.
    expect(roundStored(input)).toBe(expected);
  });

  it('rounds magnitude and depth to what the column actually stores', () => {
    // numeric(4,2) and numeric(6,2). Hashing more precision than the column holds would make
    // content_sha256 impossible to re-derive from the stored row.
    const precise = usgsFeatureSchema.parse(
      feature({
        properties: { mag: 2.567 },
        geometry: { type: 'Point', coordinates: [-122.8, 38.7, 8.245] },
      }),
    );
    const record = normalizeUsgsFeature(precise, normalizeCtx);
    expect(record.magnitude).toBe(2.57);
    expect(record.depthKm).toBe(8.25);
  });

  it('treats a broken identity as fatal, unlike a bad value', () => {
    const broken = usgsFeatureSchema.parse(feature({ properties: { ids: ',somethingelse,' } }));
    try {
      normalizeUsgsFeature(broken, normalizeCtx);
      expect.unreachable();
    } catch (error) {
      const failure = error as NormalizationError;
      expect(failure.reasonCode).toBeUndefined();
      expect(failure.isRecordLevel, 'a duplicate record is worse than a lost batch').toBe(false);
    }
  });
});

describe('the content hash decides what a revision is', () => {
  it('ignores a re-stamped updated', () => {
    // USGS re-stamps `updated` on events whose content did not change. Hashing it would create a
    // version every poll and fill "What Changed?" with changes that never happened.
    const raw = usgsFeatureSchema.parse(feature());
    const restamped = usgsFeatureSchema.parse(feature({ properties: { updated: 1789999999999 } }));
    const before = normalizeUsgsFeature(raw, normalizeCtx);
    const after = normalizeUsgsFeature(restamped, normalizeCtx);

    expect(after.contentSha256.equals(before.contentSha256)).toBe(true);
    // ...while the provider's own stamp is still recorded, because it is evidence.
    expect(after.sourceUpdatedAt).not.toStrictEqual(before.sourceUpdatedAt);
  });

  it('changes when the magnitude, position, depth or status changes', () => {
    const base = normalizeUsgsFeature(usgsFeatureSchema.parse(feature()), normalizeCtx);
    const variants: Record<string, unknown> = {
      magnitude: feature({ properties: { mag: 2.6 } }),
      status: feature({ properties: { status: 'reviewed' } }),
      depth: feature({ geometry: { type: 'Point', coordinates: [-122.8, 38.7, 9] } }),
      position: feature({ geometry: { type: 'Point', coordinates: [-122.9, 38.7, 3.67] } }),
      place: feature({ properties: { place: 'somewhere else' } }),
    };
    for (const [name, variant] of Object.entries(variants)) {
      const changed = normalizeUsgsFeature(usgsFeatureSchema.parse(variant), normalizeCtx);
      expect(changed.contentSha256.equals(base.contentSha256), `${name} must be a revision`).toBe(
        false,
      );
    }
  });

  it('is stable across key order, so a reordered payload is not a revision', () => {
    const original = feature() as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    const a = normalizeUsgsFeature(usgsFeatureSchema.parse(original), normalizeCtx);
    const b = normalizeUsgsFeature(usgsFeatureSchema.parse(reordered), normalizeCtx);
    expect(b.contentSha256.equals(a.contentSha256)).toBe(true);
    expect(b.rawPayloadSha256.equals(a.rawPayloadSha256)).toBe(true);
  });

  it('sees the real revision between two consecutive polls', () => {
    // The captured pair: hv75040342 went automatic → reviewed with a new magnitude and position.
    const t0 = parse('revision-t0.geojson');
    const t1 = parse('revision-t1.geojson');
    if (t0.verdict !== 'OK' || t1.verdict !== 'OK') throw new Error('fixtures should parse');

    const before = t0.records.map((raw) => normalizeUsgsFeature(raw, normalizeCtx));
    const after = t1.records.map((raw) => normalizeUsgsFeature(raw, normalizeCtx));
    const changed = after.find((record) => record.primaryKey === 'hv75040342');
    const original = before.find((record) => record.primaryKey === 'hv75040342');

    expect(original).toBeDefined();
    expect(changed).toBeDefined();
    expect(changed?.contentSha256.equals(original?.contentSha256 ?? Buffer.alloc(32))).toBe(false);
    expect(original?.providerStatus).toBe('automatic');
    expect(changed?.providerStatus).toBe('reviewed');
  });

  it('is identical when the same feed is parsed twice', () => {
    const first = parse('all_day.geojson');
    const second = parse('all_day.geojson');
    if (first.verdict !== 'OK' || second.verdict !== 'OK') throw new Error('fixture should parse');

    const hashes = (records: readonly UsgsFeature[]): string[] =>
      records.map((raw) => normalizeUsgsFeature(raw, normalizeCtx).contentSha256.toString('hex'));
    expect(hashes(second.records)).toStrictEqual(hashes(first.records));
  });
});
