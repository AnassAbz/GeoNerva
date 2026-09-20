/**
 * The GDACS adapter against captured payloads and behaviour measured live on 2026-09-20.
 *
 * GDACS is the source that tests whether the contract survives *heterogeneity* rather than
 * scale: six hazard families through one endpoint, one property bag whose fields mean different
 * quantities per type, an API with no SLA, and an HTTP status that means the opposite of what it
 * means for the source added an hour earlier. Most of what is asserted here is a way of getting
 * that wrong quietly.
 */

import { describe, expect, it } from 'vitest';

import { SEVERITY_SCHEMES } from '@geonerva/domain';
import { readFixtureBytes, readFixtureJson } from '@geonerva/test-fixtures';

import { NormalizationError, type ParseContext } from '../contract.ts';
import { gdacsAdapter, gdacsDescriptor, parseGdacsList, type GdacsRecord } from './adapter.ts';
import { gdacsInstant, gdacsSearchUrl, isAreaFeature } from './api.ts';
import { normalizeGdacsFeature } from './normalize.ts';
import { gdacsFeatureSchema } from './schema.ts';

const eqCtx: ParseContext = { descriptor: gdacsDescriptor('EQ') };

function bodyOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Wraps captured list features in the composed body the adapter's `fetch` produces. */
function composedFrom(file: string, details: Record<string, unknown> = {}): Uint8Array {
  const collection = readFixtureJson('gdacs', file) as { features?: unknown[] };
  return bodyOf({ events: collection.features ?? [], details });
}

function parseEq(file: string, details: Record<string, unknown> = {}) {
  return parseGdacsList(composedFrom(file, details), eqCtx);
}

/** One live EQ list row, as the shape every synthetic case starts from. */
function feature(properties: Record<string, unknown> = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-33.4247, 57.1175] },
    properties: {
      eventtype: 'EQ',
      eventid: 1567022,
      episodeid: 1734905,
      eventname: '',
      name: 'Earthquake in Reykjanes Ridge',
      description: 'Earthquake in Reykjanes Ridge',
      alertlevel: 'Green',
      alertscore: 1,
      episodealertlevel: 'Green',
      episodealertscore: 0,
      istemporary: 'false',
      iscurrent: 'true',
      country: 'Reykjanes Ridge',
      iso3: '',
      fromdate: '2026-09-19T20:24:42',
      todate: '2026-09-19T20:24:42',
      datemodified: '2026-09-19T20:46:23',
      source: 'NEIC',
      sourceid: '',
      severitydata: {
        severity: 5.2,
        severitytext: 'Magnitude 5.2M, Depth:10km',
        severityunit: 'M',
      },
      affectedcountries: [],
      ...properties,
    },
  };
}

function normalizeOne(
  value: unknown,
  eventType: Parameters<typeof gdacsDescriptor>[0] = 'EQ',
  detail?: unknown,
  geometry?: GdacsRecord['geometry'],
) {
  const parsed = gdacsFeatureSchema.safeParse(value);
  if (!parsed.success) throw new Error(`should parse: ${parsed.error.message}`);
  const record: GdacsRecord = {
    feature: parsed.data,
    detail: detail as GdacsRecord['detail'],
    geometry,
  };
  return normalizeGdacsFeature(record, { descriptor: gdacsDescriptor(eventType) });
}

/** The area features out of a captured `getgeometry` answer. */
function capturedAreas(file: string): unknown[] {
  const collection = readFixtureJson('gdacs', file) as { features?: unknown[] };
  return (collection.features ?? []).filter((feature) => isAreaFeature(feature));
}

describe('timestamps', () => {
  it('reads a GDACS timestamp as UTC, not as the worker’s local time', () => {
    /*
     * GDACS sends `2026-09-19T20:24:42` with no offset, and ECMAScript reads a date-*time*
     * without an offset as **local**. On a worker in Europe/Paris every GDACS event would land
     * two hours early in summer — plausible, invisible, and wrong in a system whose entire
     * subject is when things happened.
     */
    expect(gdacsInstant('2026-09-19T20:24:42')?.toISOString()).toBe('2026-09-19T20:24:42.000Z');
    // An offset that is already there is honoured, not stamped twice.
    expect(gdacsInstant('2026-09-19T20:24:42Z')?.toISOString()).toBe('2026-09-19T20:24:42.000Z');
    expect(gdacsInstant('2026-09-19T22:24:42+02:00')?.toISOString()).toBe(
      '2026-09-19T20:24:42.000Z',
    );
    expect(gdacsInstant('   ')).toBeNull();
    expect(gdacsInstant('not a date')).toBeNull();
  });
});

describe('the query', () => {
  it('always sends alertlevel, because omitting it is how you get a 204', () => {
    // `SEARCH?eventlist=EQ` without it answers HTTP 204 — captured in P0, reproduced 2026-09-20.
    const url = gdacsSearchUrl(
      'EQ',
      { from: new Date('2026-09-19T00:00:00Z'), to: new Date('2026-09-20T00:00:00Z') },
      1,
    );
    expect(url).toContain('alertlevel=green%3Borange%3Bred');
    expect(url).toContain('eventlist=EQ');
    expect(url).toContain('pageSize=100');
  });

  it('sends dates the way GDACS writes them, with no offset', () => {
    const url = gdacsSearchUrl(
      'EQ',
      { from: new Date('2026-09-19T00:00:00Z'), to: new Date('2026-09-20T00:00:00Z') },
      1,
    );
    expect(url).toContain('fromDate=2026-09-19T00%3A00%3A00');
    expect(url).not.toContain('fromDate=2026-09-19T00%3A00%3A00.000Z');
  });

  it('refuses a window or a page that is not one', () => {
    const instant = new Date('2026-09-19T00:00:00Z');
    expect(() => gdacsSearchUrl('EQ', { from: instant, to: instant }, 1)).toThrow(/before it ends/);
    expect(() =>
      gdacsSearchUrl('EQ', { from: instant, to: new Date(instant.getTime() + 1) }, 0),
    ).toThrow(/not a page/);
  });
});

describe('parsing a captured list', () => {
  it('reads the live SEARCH capture', () => {
    const result = parseEq('geteventlist-search-eq.json');
    if (result.verdict !== 'OK') throw new Error(`expected OK, got ${result.detail}`);
    expect(result.records).toHaveLength(29);
    expect(result.rejects).toHaveLength(0);
    expect(result.declaredCount).toBeNull();
  });

  it('rejects a duplicate (eventtype, eventid) rather than versioning it twice', () => {
    const rows = Array.from({ length: 10 }, (_, index) => feature({ eventid: 1567000 + index }));
    const result = parseGdacsList(bodyOf({ events: [...rows, rows[0]], details: {} }), eqCtx);
    if (result.verdict !== 'OK') throw new Error('a duplicate is one reject, not a dead batch');
    expect(result.records).toHaveLength(10);
    expect(result.rejects[0]?.reasonCode).toBe('DUPLICATE_IN_BATCH');
  });

  it('fails the batch on the HTML maintenance page served with 200', () => {
    const result = parseGdacsList(readFixtureBytes('gdacs', 'drift-html-200.html'), eqCtx);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('SCHEMA_DRIFT');
  });

  it('treats an empty earthquake batch as suspicious', () => {
    // There were 27 GDACS earthquakes in one day. Zero is a broken read, not a quiet planet.
    const result = parseGdacsList(bodyOf({ events: [], details: {} }), eqCtx);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('EMPTY_SUSPICIOUS');
  });

  it('treats an empty volcano batch as a quiet day', () => {
    /*
     * The same emptiness, the opposite verdict, and the evidence is the difference: wildfires and
     * earthquakes are always in progress somewhere, volcanoes and cyclones are not. One rule for
     * all six would have to be wrong for three of them.
     */
    const result = parseGdacsList(bodyOf({ events: [], details: {} }), {
      descriptor: gdacsDescriptor('VO'),
    });
    expect(result.verdict).toBe('OK');
  });
});

describe('normalizing across hazard families', () => {
  it('reads the earthquake magnitude from severitydata', () => {
    const record = normalizeOne(feature());
    expect(record.hazardType).toBe('EARTHQUAKE');
    expect(record.magnitude).toBe(5.2);
    expect(record.magnitudeType).toBe('M');
    expect(record.primaryKey).toBe('EQ:1567022');
  });

  it('reads a wildfire’s burnt area from the same field, because the unit says so', () => {
    /*
     * `severitydata.severity` is a magnitude for EQ, km/h for TC and hectares for WF. The unit is
     * not decoration — it is what says which quantity the number is — and a flattened "severity"
     * column would put 5.2 and 8214 side by side as if they were comparable.
     */
    const record = normalizeOne(
      feature({
        eventtype: 'WF',
        eventid: 1023,
        severitydata: {
          severity: 8214,
          severitytext: 'Green impact for forestfire in 8214 ha',
          severityunit: 'ha',
        },
      }),
      'WF',
    );
    expect(record.hazardType).toBe('WILDFIRE_EVENT');
    expect(record.attributes['burnt_area_ha']).toBe(8214);
    // Not a magnitude. Nothing outside EARTHQUAKE gets one.
    expect(record.magnitude).toBeNull();
  });

  it('reads a cyclone’s wind speed, and refuses a number whose unit says something else', () => {
    const storm = normalizeOne(
      feature({
        eventtype: 'TC',
        eventid: 2044,
        eventname: 'SAUDEL-26',
        severitydata: {
          severity: 111.1104,
          severitytext: 'Tropical Storm (maximum wind speed of 111 km/h)',
          severityunit: 'km/h',
        },
      }),
      'TC',
    );
    expect(storm.attributes['max_wind_kmh']).toBe(111.11);
    expect(storm.attributes['storm_name']).toBe('SAUDEL-26');

    // The same number under the wrong unit is not a wind speed, and guessing would be worse.
    const mislabelled = normalizeOne(
      feature({
        eventtype: 'TC',
        eventid: 2045,
        severitydata: { severity: 111.1104, severitytext: '', severityunit: 'ha' },
      }),
      'TC',
    );
    expect(mislabelled.attributes['max_wind_kmh']).toBeUndefined();
  });

  it('refuses a flood when getgeometry could not be asked', () => {
    /*
     * `has_area_geometry` is required by the flood schema and is not knowable from the list —
     * every row says `Class: Point_Centroid` regardless of what `getgeometry` holds — and the
     * answer caps or uncaps the event's relevance (ARCHITECTURE §9.3). A flood whose geometry
     * call failed is a reject, never a flood recorded as having no modelled area.
     */
    expect(() => normalizeOne(feature({ eventtype: 'FL', eventid: 3001 }), 'FL')).toThrow(
      /only knowable from it/,
    );
  });

  it('records a flood’s modelled area, under roles that keep the two apart', () => {
    const areas = capturedAreas('getgeometry-fl-affected-global.json');
    // The capture holds a centroid plus `Poly_Affected` and `Poly_Global`; only the two polygons
    // are areas.
    expect(areas).toHaveLength(2);

    const record = normalizeOne(feature({ eventtype: 'FL', eventid: 3001 }), 'FL', undefined, {
      hasArea: true,
      features: areas,
      oversized: false,
    });
    expect(record.attributes['has_area_geometry']).toBe(true);
    expect(record.geometries?.map((geometry) => geometry.role)).toStrictEqual([
      'affected_area',
      'global_area',
    ]);
  });

  it('still says a flood has an area when the shape was too large to keep', () => {
    /*
     * P0 measured a single flood episode's geometry at 1.8 MB. Dropping the shape is a decision
     * about *our* storage; dropping the flag with it would turn that into a statement about the
     * provider's data, and the event would be described as having no modelled area at all.
     */
    const record = normalizeOne(feature({ eventtype: 'FL', eventid: 3001 }), 'FL', undefined, {
      hasArea: true,
      features: [],
      oversized: true,
    });
    expect(record.attributes['has_area_geometry']).toBe(true);
    expect(record.geometries).toBeUndefined();
  });

  it('records a flood with no modelled area as having none', () => {
    const record = normalizeOne(feature({ eventtype: 'FL', eventid: 3001 }), 'FL', undefined, {
      hasArea: false,
      features: [],
      oversized: false,
    });
    expect(record.attributes['has_area_geometry']).toBe(false);
  });

  it('treats a growing flood area as a revision', () => {
    /*
     * For a flood the shape is frequently the *only* thing that moves: the centroid, the alert
     * level and the severity sentence stay put while the modelled area spreads. Leaving the
     * shapes out of the content hash would make that look like nothing happening.
     */
    const areas = capturedAreas('getgeometry-fl-affected-global.json');
    const before = normalizeOne(feature({ eventtype: 'FL', eventid: 3001 }), 'FL', undefined, {
      hasArea: true,
      features: areas,
      oversized: false,
    });
    const after = normalizeOne(feature({ eventtype: 'FL', eventid: 3001 }), 'FL', undefined, {
      hasArea: true,
      features: [areas[0]],
      oversized: false,
    });
    expect(after.contentSha256).not.toStrictEqual(before.contentSha256);
  });

  it('refuses an event of the wrong type for the product', () => {
    // Six products share one endpoint. A TC in the EQ batch means the query was not the query.
    let thrown: unknown;
    try {
      normalizeOne(feature({ eventtype: 'TC' }), 'EQ');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NormalizationError);
    expect((thrown as NormalizationError).isRecordLevel).toBe(false);
  });
});

describe('what GDACS says about itself', () => {
  it('records an earthquake as a derived copy of the USGS solution', () => {
    /*
     * The single most important assertion in this file. 99 of 100 recent GDACS earthquakes carry
     * `source: NEIC` and a `sourceid` that *is* the USGS event id. Without recording that, "USGS
     * and GDACS agree" would render as two independent sources corroborating each other, when it
     * is one solution quoted twice — the failure ADR-030 exists to prevent.
     *
     * `sourceid` is empty in the list; only `geteventdata` has it.
     */
    const detail = (
      readFixtureJson('gdacs', 'geteventdata-eq-neic.json') as {
        properties: Record<string, unknown>;
      }
    ).properties;
    expect(detail['sourceid']).toBe('us7000tild');

    const record = normalizeOne(feature(), 'EQ', detail);
    expect(record.derivedFrom).toStrictEqual({ source: 'usgs', ref: 'us7000tild' });
    expect(record.attributes['upstream_event_ref']).toBe('us7000tild');
  });

  it('leaves derivedFrom absent when the detail call gave nothing, never "independent"', () => {
    // Absent means "not known to be derived". It is never evidence of independence.
    const record = normalizeOne(feature());
    expect(record.derivedFrom).toBeUndefined();
    expect(record.attributes['upstream_event_ref']).toBeUndefined();
  });

  it('does not claim a lineage for hazards whose upstream GeoNerva does not hold', () => {
    /*
     * A wildfire's `sourceid` points at GWIS, a flood's at GLOFAS — models GeoNerva does not
     * ingest. Recording `derivedFrom` there would be a cross-reference to nowhere.
     */
    const record = normalizeOne(
      feature({
        eventtype: 'WF',
        eventid: 1023,
        source: 'GWIS',
        sourceid: 'gwis-99',
        severitydata: { severity: 10, severitytext: '', severityunit: 'ha' },
      }),
      'WF',
    );
    expect(record.derivedFrom).toBeUndefined();
  });

  it('reads iscurrent as the string it is', () => {
    /*
     * `Boolean("false")` is `true`. The obvious coercion marks every finished event as ongoing,
     * and a finished event left ACTIVE sits on the map forever.
     */
    expect(normalizeOne(feature()).lifecycleStatus).toBe('ACTIVE');
    const ended = normalizeOne(feature({ iscurrent: 'false' }));
    // ENDED, not DELETED: the event happened and finished. A tombstone would remove it.
    expect(ended.lifecycleStatus).toBe('ENDED');

    /*
     * `is_current` is also kept as an attribute — but only for the GDACS-native hazards, whose
     * schemas spread `gdacsCommon`. `earthquakeAttributesSchema` is shared with USGS and EMSC and
     * has no such field, so a GDACS earthquake carries the fact in `lifecycle_status` alone.
     */
    const endedFire = normalizeOne(
      feature({
        eventtype: 'WF',
        eventid: 1023,
        iscurrent: 'false',
        severitydata: { severity: 10, severitytext: '', severityunit: 'ha' },
      }),
      'WF',
    );
    expect(endedFire.attributes['is_current']).toBe(false);
    expect(normalizeOne(feature()).attributes['is_current']).toBeUndefined();
  });

  it('keeps the alert level on GDACS’s own scale and maps it onto nothing', () => {
    const record = normalizeOne(feature({ alertlevel: 'Orange', episodealertlevel: 'Red' }));
    /*
     * `GDACS_ALERT`, the name the frozen vocabulary uses — not `GDACS`, which is what this said
     * until a live batch of 79 wildfires was refused by the column's CHECK after a successful
     * fetch, parse and normalize. `NormalizedRecord.severityScheme` is now typed to that
     * vocabulary, so the next one is a compile error instead of a lost batch.
     */
    expect(record.severityScheme).toBe('GDACS_ALERT');
    expect(SEVERITY_SCHEMES).toContain(record.severityScheme);
    // The episode's level is what this version carries; SAUDEL-26 went Green → Orange within one
    // event, so the two are genuinely different facts.
    expect(record.severityValue).toBe('Red');
  });

  it('rejects a fourth alert level rather than storing a word nothing can render', () => {
    const result = parseGdacsList(
      bodyOf({
        events: Array.from({ length: 10 }, (_, index) => feature({ eventid: 1567000 + index })),
        details: {},
      }),
      eqCtx,
    );
    if (result.verdict !== 'OK') throw new Error('fixture should parse');
    expect(() => normalizeOne(feature({ alertlevel: 'Yellow' }))).toThrow(/not Green, Orange/);
  });
});

describe('change detection', () => {
  it('ignores datemodified, which GDACS bulk-restamps', () => {
    /*
     * P0 saw dozens of unrelated old events — including a 2026-09-04 volcano — re-stamped within
     * the same minute. Hashing it would manufacture a revision of everything a job touched.
     */
    const before = normalizeOne(feature());
    const after = normalizeOne(feature({ datemodified: '2026-09-20T09:00:00' }));
    expect(after.contentSha256).toStrictEqual(before.contentSha256);
    expect(after.sourceUpdatedAt?.toISOString()).toBe('2026-09-20T09:00:00.000Z');
  });

  it('ignores todate, which tracks "now" for an ongoing event', () => {
    // A wildfire burning for a fortnight has `todate` of today, every day. In the hash it would
    // be a new version each poll, each saying nothing happened.
    const before = normalizeOne(feature());
    const after = normalizeOne(feature({ todate: '2026-09-20T23:59:59' }));
    expect(after.contentSha256).toStrictEqual(before.contentSha256);
  });

  it('treats a new episode as a revision, because that is what GDACS means by an update', () => {
    const before = normalizeOne(feature());
    const after = normalizeOne(feature({ episodeid: 1734906 }));
    expect(after.contentSha256).not.toStrictEqual(before.contentSha256);
  });

  it('treats an alert-level change as a revision', () => {
    const before = normalizeOne(feature());
    const after = normalizeOne(feature({ episodealertlevel: 'Orange' }));
    expect(after.contentSha256).not.toStrictEqual(before.contentSha256);
  });

  it('is idempotent over the captured list', () => {
    const first = parseEq('geteventlist-search-eq.json');
    const second = parseEq('geteventlist-search-eq.json');
    if (first.verdict !== 'OK' || second.verdict !== 'OK') throw new Error('should parse');
    const digest = (records: readonly GdacsRecord[]) =>
      records.map((record) =>
        normalizeGdacsFeature(record, { descriptor: gdacsDescriptor('EQ') }).contentSha256.toString(
          'hex',
        ),
      );
    expect(digest(second.records)).toStrictEqual(digest(first.records));
  });
});

describe('the descriptors', () => {
  it('gives every event type its own product, matching the seed', () => {
    expect(gdacsDescriptor('EQ').productCode).toBe('EQ');
    expect(gdacsDescriptor('DR').hazardType).toBe('DROUGHT');
    expect(gdacsDescriptor('TC').capabilities).toContain('FORECAST_GEOMETRY');
    // Every GDACS product shares one seeded freshness policy.
    expect(gdacsDescriptor('VO').policyKey).toBe('gdacs:*');
    expect(gdacsAdapter('WF').descriptor.hazardType).toBe('WILDFIRE_EVENT');
  });

  it('allows only the GDACS host', () => {
    expect(gdacsDescriptor('EQ').allowedHosts).toStrictEqual(['www.gdacs.org']);
  });
});
