/**
 * The EMSC adapter against real captured payloads and against behaviour measured live on
 * 2026-09-20 (docs/TESTING.md §4.3).
 *
 * The assertions worth reading are the ones that encode a difference from USGS. EMSC is close
 * enough to USGS to invite a copied adapter, and each of these is a way a copied adapter would
 * have been wrong while still looking right: an inverted depth, a truncated window marked
 * complete, an empty window reported as a broken feed, a re-cased magnitude type manufacturing a
 * revision of every record in the bulletin.
 */

import { describe, expect, it } from 'vitest';

import { readFixtureBytes, readFixtureJson } from '@geonerva/test-fixtures';

import { NormalizationError, type ParseContext } from '../contract.ts';
import { emscDescriptor, parseEmscFeed } from './adapter.ts';
import {
  EMSC_MAX_ROWS,
  emscCountUrl,
  emscQueryUrl,
  emscUpdatedAfterUrl,
  isTruncated,
  parseEmscCount,
} from './fdsn.ts';
import { normalizeEmscFeature } from './normalize.ts';
import { emscFeatureSchema, type EmscFeature } from './schema.ts';

const ctx: ParseContext = { descriptor: emscDescriptor };
const normalizeCtx = { descriptor: emscDescriptor };

function parse(file: string) {
  return parseEmscFeed(readFixtureBytes('emsc', file), ctx);
}

function bodyOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** One live feature, as the shape every synthetic case starts from. */
function feature(properties: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  const depth = 'depth' in properties ? (properties['depth'] as number | null) : 8.1;
  return {
    type: 'Feature',
    id: '20260803_0000324',
    geometry: {
      type: 'Point',
      coordinates: [-5.2113, 32.2039, depth === null ? 0 : -depth],
    },
    properties: {
      unid: '20260803_0000324',
      source_id: '2037122',
      source_catalog: 'EMSC-RTS',
      time: '2026-08-03T20:14:45.87Z',
      lastupdate: '2026-08-04T06:37:24.378543Z',
      lat: 32.2039,
      lon: -5.2113,
      depth: 8.1,
      mag: 4.7,
      magtype: 'mw',
      evtype: 'ke',
      auth: 'EMSC',
      flynn_region: 'MOROCCO',
      ...properties,
    },
    ...rest,
  };
}

function normalizeOne(value: unknown): ReturnType<typeof normalizeEmscFeature> {
  const parsed = emscFeatureSchema.safeParse(value);
  if (!parsed.success) throw new Error(`fixture should parse: ${parsed.error.message}`);
  return normalizeEmscFeature(parsed.data, normalizeCtx);
}

describe('the query layer', () => {
  it('asks for format=json, because format=geojson is an HTTP 400 here', () => {
    const url = emscQueryUrl({
      from: new Date('2010-01-01T00:00:00Z'),
      to: new Date('2010-01-02T00:00:00Z'),
    });
    expect(url).toContain('format=json');
    expect(url).not.toContain('format=geojson');
  });

  it('bridges our half-open window onto FDSN’s inclusive endtime', () => {
    const url = emscQueryUrl({
      from: new Date('2010-01-01T00:00:00Z'),
      to: new Date('2010-01-02T00:00:00Z'),
    });
    // Without the millisecond, two adjacent windows both claim an event at midnight.
    expect(url).toContain('endtime=2010-01-01T23%3A59%3A59.999Z');
  });

  it('sends no orderby at all', () => {
    /*
     * EMSC validates `orderby` against the *unanchored* pattern
     * `time|time-asc|magnitude|magnitude-asc`, so `orderby=time_asc` passes validation — it
     * contains "time" — then matches no known value and returns rows in an arbitrary order with
     * no error (measured 2026-09-20: `time` gave a 2026 event, `time-asc` a 1998 one, `time_asc`
     * a 2023 one). A parameter whose typos are silent is a parameter not worth sending when the
     * whole window is taken anyway.
     */
    const url = emscQueryUrl({
      from: new Date('2020-01-01T00:00:00Z'),
      to: new Date('2020-01-02T00:00:00Z'),
    });
    expect(url).not.toContain('orderby');
  });

  it('points the count endpoint at the same window', () => {
    const window = { from: new Date('2010-01-01T00:00:00Z'), to: new Date('2010-01-02T00:00:00Z') };
    expect(emscCountUrl(window)).toBe(emscQueryUrl(window).replace('/query?', '/count?'));
  });

  it('refuses a window that is not a question', () => {
    const instant = new Date('2020-01-01T00:00:00Z');
    expect(() => emscQueryUrl({ from: instant, to: instant })).toThrow(/strictly before/);
  });

  it('refuses a limit the service would silently clamp', () => {
    expect(() => emscUpdatedAfterUrl(new Date(), EMSC_MAX_ROWS + 1)).toThrow(/whole number/);
    expect(() => emscUpdatedAfterUrl(new Date(), 0)).toThrow(/whole number/);
    expect(() => emscUpdatedAfterUrl(new Date(Number.NaN))).toThrow(/real instant/);
  });

  it('reads the plain count answer, which is not the USGS shape', () => {
    // EMSC: {"count": 97}. USGS answers an over-limit count with 200 and an `error` field; a
    // shared parser would mean one of the two loses a check it needs.
    expect(parseEmscCount(bodyOf({ count: 97 }))).toBe(97);
    expect(() => parseEmscCount(bodyOf({ total: 97 }))).toThrow(/changed shape/);
    expect(() => parseEmscCount(new TextEncoder().encode('<html>'))).toThrow(/did not answer/);
  });
});

describe('parsing a captured page', () => {
  it('accepts a live page and rejects nothing', () => {
    const result = parse('json-page.json');
    if (result.verdict !== 'OK') throw new Error(`expected OK, got ${result.detail}`);
    expect(result.records).toHaveLength(200);
    expect(result.rejects).toHaveLength(0);
  });

  it('accepts the bare Feature that an eventid lookup returns', () => {
    // `eventid=<unid>` answers with a Feature, not a FeatureCollection (DATA_SOURCES §6.1).
    const result = parse('eventid-morocco.json');
    if (result.verdict !== 'OK') throw new Error(`expected OK, got ${result.detail}`);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.properties.unid).toBe('20260803_0000324');
  });

  it('never reports metadata.count as a declared count', () => {
    /*
     * It counts what was *returned*, not what matched. `revision-t1.json` was trimmed to 2
     * features while `count` still says 27 — and live, `limit=25000` answers `count: 20000`
     * beside 20,000 features. Feeding it to the pipeline's completeness check would log a
     * reassuring match on exactly the response that was truncated.
     */
    const result = parse('revision-t1.json');
    if (result.verdict !== 'OK') throw new Error('fixture should parse');
    const captured = readFixtureJson('emsc', 'revision-t1.json') as { metadata: { count: number } };
    expect(captured.metadata.count).toBe(27);
    expect(result.records).toHaveLength(2);
    expect(result.declaredCount).toBeNull();
  });
});

describe('drift fixtures behave as their manifest says', () => {
  it('treats a 200 with no features as suspicious, not as a quiet catalogue', () => {
    // A quiet window arrives as HTTP 204 and never reaches the parser, so a 200 carrying an empty
    // collection is a service that was configured to answer 204 and did not.
    const result = parse('drift-empty-collection.json');
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('EMPTY_SUSPICIOUS');
  });

  it('tolerates an unknown extra field', () => {
    const result = parse('drift-extra-field.json');
    expect(result.verdict).toBe('OK');
    if (result.verdict !== 'OK') return;
    expect(result.rejects).toHaveLength(0);
  });

  it('fails the batch on an HTML page served with 200', () => {
    const result = parse('drift-html-200.html');
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('SCHEMA_DRIFT');
  });

  it('fails the batch on a truncated body', () => {
    const result = parse('drift-truncated.json');
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('SCHEMA_DRIFT');
  });

  it('rejects the one record whose required field vanished, and keeps the batch', () => {
    const result = parse('drift-missing-required.json');
    if (result.verdict !== 'OK') throw new Error('one bad record must not fail a 200-record batch');
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]?.reasonCode).toBe('SCHEMA_INVALID');
  });

  it('rejects the record whose unid was renamed', () => {
    const result = parse('drift-renamed-field.json');
    if (result.verdict !== 'OK') throw new Error('one bad record must not fail the batch');
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]?.detail).toMatch(/unid/);
  });

  it('rejects the record whose magnitude became a string', () => {
    const result = parse('drift-type-change.json');
    if (result.verdict !== 'OK') throw new Error('one bad record must not fail the batch');
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]?.reasonCode).toBe('SCHEMA_INVALID');
  });
});

describe('the silent row cap', () => {
  it('refuses a response that arrives at the cap', () => {
    /*
     * The finding this exists for: `limit=25000` answers HTTP 200 with exactly 20,000 features
     * and no marker of any kind. USGS refuses the same situation with a 400. A window that held
     * 20,000 events and one that held 200,000 are indistinguishable, so the only safe reading is
     * "incomplete" — anything else marks a backfill interval DONE over a hole.
     */
    const features = Array.from({ length: EMSC_MAX_ROWS }, (_, index) =>
      feature(
        { unid: `2026${String(index).padStart(11, '0')}` },
        { id: `2026${String(index).padStart(11, '0')}` },
      ),
    );
    const result = parseEmscFeed(bodyOf({ type: 'FeatureCollection', features }), ctx);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('SCHEMA_DRIFT');
    expect(result.detail).toMatch(/row cap/);
  });

  it('accepts one row below the cap, so the rule is a cap and not a ceiling on volume', () => {
    expect(isTruncated(EMSC_MAX_ROWS - 1)).toBe(false);
    expect(isTruncated(EMSC_MAX_ROWS)).toBe(true);
  });

  it('rejects a duplicate unid rather than writing two versions in one batch', () => {
    /*
     * Ten distinct events and one repeat, not two features and one repeat: with a batch of two a
     * single reject is 50 %, which trips the drift threshold and fails the whole batch. That is
     * the batch verdict working, but it would hide the per-record rule this test is about.
     */
    const distinct = Array.from({ length: 10 }, (_, index) => {
      const unid = `2026080${index}_0000324`;
      return feature({ unid }, { id: unid });
    });
    const body = bodyOf({
      type: 'FeatureCollection',
      features: [...distinct, distinct[0]],
    });
    const result = parseEmscFeed(body, ctx);
    if (result.verdict !== 'OK') throw new Error('a duplicate is one reject, not a dead batch');
    expect(result.records).toHaveLength(10);
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]?.reasonCode).toBe('DUPLICATE_IN_BATCH');
  });
});

describe('normalizing', () => {
  it('reads the depth from properties, not from the GeoJSON z', () => {
    // The whole catalogue would be sign-inverted by the USGS line, and every value would stay
    // plausible. 8.1 km down, published as z = -8.1.
    const record = normalizeOne(readFixtureJson('emsc', 'eventid-morocco.json'));
    expect(record.depthKm).toBe(8.1);
  });

  it('keeps a depth above the datum negative', () => {
    /*
     * From `revision-t0.json`: a Hawaiʻi event at `depth: -0.2` with z = 0.2 — 200 m *above* sea
     * level. It is the case that proves the relationship is a negation rather than an absolute
     * value, and `Math.abs` would have passed the first test and corrupted this one.
     */
    const result = parse('revision-t0.json');
    if (result.verdict !== 'OK') throw new Error('fixture should parse');
    const hawaii = result.records.find((record) => record.properties.unid === '20260919_0000238');
    if (hawaii === undefined) throw new Error('the Hawaii event is the point of this fixture');
    expect(hawaii.properties.depth).toBe(-0.2);
    expect(normalizeEmscFeature(hawaii, normalizeCtx).depthKm).toBe(-0.2);
  });

  it('reads the bulletin depth, where the z is the depth rather than its negation', () => {
    /*
     * The regression for the defect a live backfill found: a 2010 day rejected 73 % of its
     * records against a check that assumed the RTS sign convention held everywhere. It does not.
     * Of the 97 events that day, 78 EMSC-EMB records publish z = +depth and 12 RTS records
     * publish z = -depth; the 7 remaining EMB records sit at depth 0, where the two agree.
     *
     * Every value stayed plausible when it was wrong, which is the whole reason this is a test
     * and not a comment: 78 of 97 historical depths were sign-inverted and nothing looked amiss.
     */
    const result = parse('emb-2010-day.json');
    if (result.verdict !== 'OK') throw new Error(`the bulletin must ingest, got ${result.detail}`);
    expect(result.records).toHaveLength(97);
    expect(result.rejects).toHaveLength(0);

    const byCatalogue = { 'EMSC-EMB': 0, 'EMSC-RTS': 0 } as Record<string, number>;
    for (const record of result.records) {
      const normalized = normalizeEmscFeature(record, normalizeCtx);
      const catalogue = String(normalized.attributes['provider_catalog']);
      byCatalogue[catalogue] = (byCatalogue[catalogue] ?? 0) + 1;
      // Positive, always: EMSC's 2010 bulletin has no event above the datum, and a sign-reading
      // adapter would have produced 78 negative ones.
      expect(normalized.depthKm === null || normalized.depthKm >= 0).toBe(true);
    }
    expect(byCatalogue['EMSC-EMB']).toBe(85);
    expect(byCatalogue['EMSC-RTS']).toBe(12);
  });

  it('still rejects a z that is not the same distance as the depth', () => {
    // The sign is unusable; the magnitude is the one claim both serializers make, so a z that is
    // some other number entirely is still drift.
    expect(() =>
      normalizeOne({
        ...feature(),
        geometry: { type: 'Point', coordinates: [-5.2113, 32.2039, 40] },
      }),
    ).toThrow(/not the same distance/);
  });

  it('accepts a bulletin event that omits the magnitude keys altogether', () => {
    // EMSC omits the `mag` and `magtype` *keys* on some bulletin events rather than sending null:
    // 2 of the 97 on 2010-01-01. Requiring the key would reject a real event forever.
    const withoutMagnitude = feature();
    delete (withoutMagnitude.properties as Record<string, unknown>)['mag'];
    delete (withoutMagnitude.properties as Record<string, unknown>)['magtype'];
    const record = normalizeOne(withoutMagnitude);
    expect(record.magnitude).toBeNull();
    expect(record.magnitudeType).toBeNull();
  });

  it('keys identity on unid and treats a disagreeing feature id as fatal', () => {
    const record = normalizeOne(readFixtureJson('emsc', 'eventid-morocco.json'));
    expect(record.primaryKey).toBe('20260803_0000324');
    expect(record.aliases).toStrictEqual(['20260803_0000324']);

    let thrown: unknown;
    try {
      normalizeOne(feature({}, { id: '20260803_9999999' }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NormalizationError);
    // Fatal, not a reject: ingesting under the wrong key fabricates a duplicate record that later
    // reads as a second independent source.
    expect((thrown as NormalizationError).isRecordLevel).toBe(false);
  });

  it('never puts source_id in the alias set', () => {
    /*
     * `source_id` is unique only within `source_catalog`, and one response carries both EMSC-RTS
     * and EMSC-EMB. A bare `2037122` as an alias could merge two different earthquakes into one
     * record — and a merged record is exactly what the independence rule exists to prevent.
     */
    const record = normalizeOne(feature());
    expect(record.aliases).not.toContain('2037122');
    expect(record.attributes['provider_catalog']).toBe('EMSC-RTS');
  });

  it('records the catalogue per record, because a backfill mixes two', () => {
    const record = normalizeOne(feature({ source_catalog: 'EMSC-EMB' }));
    expect(record.attributes['provider_catalog']).toBe('EMSC-EMB');
  });

  it('lower-cases the magnitude type', () => {
    // Live: recent events carry `ml`, a 1998 one carries `MD`, for the same scale. Hashing the
    // casing would turn a re-cased bulletin into a revision of every record in it.
    expect(normalizeOne(feature({ magtype: 'MD' })).magnitudeType).toBe('md');
    expect(normalizeOne(feature({ magtype: 'MD' })).contentSha256).toStrictEqual(
      normalizeOne(feature({ magtype: 'md' })).contentSha256,
    );
  });

  it('stores evtype verbatim rather than guessing what the code means', () => {
    // `ke`/`se`/`ue` are the observed values and EMSC documents no vocabulary. A wrong expansion
    // would present something that is not an earthquake as one.
    expect(normalizeOne(feature({ evtype: 'se' })).attributes['event_type']).toBe('se');
  });

  it('leaves the provider status null rather than inventing one', () => {
    // EMSC publishes no review state at all. An absent provider statement must not be dressed up.
    const record = normalizeOne(feature());
    expect(record.providerStatus).toBeNull();
    expect(record.lifecycleStatus).toBe('ACTIVE');
    expect(record.attributes['review_status']).toBeUndefined();
  });

  it('rejects a position that disagrees with its own geometry', () => {
    expect(() =>
      normalizeOne({
        ...feature(),
        geometry: { type: 'Point', coordinates: [-5.9, 32.2039, -8.1] },
      }),
    ).toThrow(/disagree with geometry/);
  });

  it('rejects a timestamp outside the range a real catalogue can hold', () => {
    // Parsable but not a fact: it would sort to one end of every time-ordered query forever.
    expect(() => normalizeOne(feature({ time: '1731-01-01T00:00:00Z' }))).toThrow(/1900, 2100/);
  });
});

describe('a field that disappeared', () => {
  it('fails the batch when magnitudes vanish wholesale', () => {
    /*
     * The cost of making `mag` optional, paid back.
     *
     * A rename to `magnitude` parses perfectly — every field is a loose object — and quietly
     * nulls every magnitude in the catalogue. Magnitude drives relevance, so this has to be loud,
     * and the only thing distinguishing it from the bulletin's occasional missing value is how
     * much of the batch is affected: ~2 % against 100 %.
     */
    const features = Array.from({ length: 40 }, (_, index) => {
      const unid = `20100101_000${String(index).padStart(4, '0')}`;
      const record = feature({ unid }, { id: unid });
      delete (record.properties as Record<string, unknown>)['mag'];
      return record;
    });
    const result = parseEmscFeed(bodyOf({ type: 'FeatureCollection', features }), ctx);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('SCHEMA_DRIFT');
    expect(result.detail).toMatch(/no magnitude/);
  });

  it('does not fire on the real bulletin, where a few events simply have none', () => {
    // 2 of 97 on the captured day. A rule that cannot tell this from a rename is not a rule.
    const result = parse('emb-2010-day.json');
    expect(result.verdict).toBe('OK');
    if (result.verdict !== 'OK') return;
    const missing = result.records.filter(
      (record) => record.properties.mag === undefined || record.properties.mag === null,
    );
    expect(missing).toHaveLength(2);
  });

  it('says nothing about a batch too small for a ratio to mean anything', () => {
    // Three records with one missing is 33 %, and means nothing at all.
    const features = Array.from({ length: 3 }, (_, index) => {
      const unid = `20100101_000${String(index).padStart(4, '0')}`;
      const record = feature({ unid }, { id: unid });
      if (index === 0) delete (record.properties as Record<string, unknown>)['mag'];
      return record;
    });
    const result = parseEmscFeed(bodyOf({ type: 'FeatureCollection', features }), ctx);
    expect(result.verdict).toBe('OK');
  });
});

describe('change detection', () => {
  it('produces the same hash for the same feature, whatever the key order', () => {
    /*
     * EMSC uses two serializers: with `orderby` the members come out in a different order with
     * different whitespace, for the same event. Without canonicalization the same record would
     * dedupe to two raw rows depending on which query returned it.
     */
    const first = normalizeOne(feature());
    const reordered = feature();
    const shuffled = {
      geometry: reordered.geometry,
      type: reordered.type,
      properties: Object.fromEntries(
        Object.entries(reordered.properties).reverse(),
      ) as unknown as Record<string, unknown>,
      id: reordered.id,
    };
    const second = normalizeOne(shuffled);
    expect(second.contentSha256).toStrictEqual(first.contentSha256);
    expect(second.rawPayloadSha256).toStrictEqual(first.rawPayloadSha256);
  });

  it('ignores lastupdate, so a re-stamp is not a revision', () => {
    const before = normalizeOne(feature());
    const after = normalizeOne(feature({ lastupdate: '2026-09-20T12:00:00.000000Z' }));
    expect(after.contentSha256).toStrictEqual(before.contentSha256);
    expect(after.sourceUpdatedAt?.toISOString()).toBe('2026-09-20T12:00:00.000Z');
  });

  it('sees a real revision in the captured t0 → t1 pair', () => {
    const t0 = parse('revision-t0.json');
    const t1 = parse('revision-t1.json');
    if (t0.verdict !== 'OK' || t1.verdict !== 'OK') throw new Error('fixtures should parse');

    const hashesAt = (records: readonly EmscFeature[]) =>
      new Map(
        records.map((record) => {
          const normalized = normalizeEmscFeature(record, normalizeCtx);
          return [normalized.primaryKey, normalized.contentSha256.toString('hex')];
        }),
      );
    const before = hashesAt(t0.records);
    const after = hashesAt(t1.records);

    expect([...after.keys()].sort()).toStrictEqual([...before.keys()].sort());
    const changed = [...after].filter(([unid, hash]) => before.get(unid) !== hash);
    // The pair was captured precisely because these two events were revised between polls.
    expect(changed.length).toBeGreaterThan(0);
  });

  it('gives the same hash to the same event served by EMSC’s two serializers', () => {
    /*
     * This used to parse the *same bytes* twice and assert the results matched — which, for a
     * function with no clock, no IO and no randomness, no mutation of the parser or the
     * normalizer could ever fail. It was a tautology, and a G5 reviewer said so.
     *
     * The real property, and the one that costs something: EMSC serializes the same event
     * differently depending on whether `orderby` was sent — different member order, different
     * whitespace — so the same record must hash alike across both. That is what makes a live
     * poll and a backfill agree that they are looking at one earthquake rather than two.
     */
    const result = parse('json-page.json');
    if (result.verdict !== 'OK') throw new Error('fixture should parse');
    const digest = (records: readonly EmscFeature[]) =>
      records.map((record) =>
        normalizeEmscFeature(record, normalizeCtx).contentSha256.toString('hex'),
      );
    const reserialized = result.records.map((record) =>
      emscFeatureSchema.parse(
        JSON.parse(
          JSON.stringify({
            geometry: record.geometry,
            type: record.type,
            properties: Object.fromEntries(Object.entries(record.properties).reverse()),
            id: record.id,
          }),
        ),
      ),
    );
    expect(digest(reserialized)).toStrictEqual(digest(result.records));
  });
});

describe('the descriptor', () => {
  it('does not claim deletions, because the service refuses the parameter', () => {
    // `includedeleted` is HTTP 400 "Unknown request parameters(s)" (live, 2026-09-20). Claiming
    // the capability would let a future caller believe a sweep exists.
    expect(emscDescriptor.capabilities).not.toContain('DELETIONS');
    expect(emscDescriptor.capabilities).toContain('HISTORICAL_EVENTS');
  });

  it('allows only the EMSC host', () => {
    expect(emscDescriptor.allowedHosts).toStrictEqual(['www.seismicportal.eu']);
  });
});
