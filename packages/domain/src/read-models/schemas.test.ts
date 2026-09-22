/**
 * The read-model schemas, tested for what they **reject**.
 *
 * The equivalence proofs in `schemas.ts` are compile-time and cover the shape. What they cannot
 * cover is the part of each schema that is a rule rather than a type: the refinements that encode
 * the invariants, and the string patterns that distinguish an ISO timestamp from any other string.
 * Those are logic, and logic that nothing has tried to break is logic nobody has checked.
 *
 * Every case below is a document that type-checks and must still be refused. A mutation run made
 * the point: removing the I11 refinement entirely left the whole contract suite green, because no
 * *real* response had ever violated it. A refinement no test exercises is a comment.
 */

import { describe, expect, it } from 'vitest';

import { HAZARD_FAMILIES } from '../enums.ts';
import { READ_MODEL_SCHEMA_VERSION } from './common.ts';
import { PROBLEM_CODES, PROBLEM_STATUS, problemTypeUri } from './problem.ts';
import {
  aiBriefingViewSchema,
  baselineMetricViewSchema,
  asOfContextSchema,
  citedEvidenceIds,
  evidenceDetailSchema,
  evidenceItemSchema,
  factValueSchema,
  familyCardSchema,
  historyResponseSchema,
  locationRefSchema,
  mapFeaturesResponseSchema,
  observationEvidenceDetailSchema,
  problemDetailsSchema,
  relevanceAssessmentSchema,
  runSummaryViewSchema,
  sourceStatusEntrySchema,
  sourceStatusSchema,
} from './schemas.ts';

const TS = '2026-09-21T12:00:00.000Z';

/** The fields every `SubjectSummary` needs, so a card can be built around one. */
function subject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subjectRef: 'CE:EQ-26-7K3F9Q',
    hazardType: 'EARTHQUAKE',
    family: 'EARTHQUAKES',
    publicId: 'EQ-26-7K3F9Q',
    title: 'M5.4, 55 km north',
    observedAt: TS,
    lifecycleStatus: 'ACTIVE',
    providerSeverity: null,
    distanceKm: 55.2,
    hypocentralDistanceKm: 56.1,
    facts: [],
    relevance: relevance(),
    agreement: null,
    evidenceIds: ['EV:OBS:41'],
    href: '/event/EQ-26-7K3F9Q',
    ...overrides,
  };
}

function relevance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    level: 'MODERATE',
    reasons: [],
    authoritativeBasis: null,
    caveats: [],
    evidenceIds: ['EV:REL:' + 'a'.repeat(64)],
    modelVersion: 'eq-1',
    ...overrides,
  };
}

function basis(): Record<string, unknown> {
  return {
    sourceId: 'gdacs',
    sourceName: 'GDACS',
    severity: { scheme: 'GDACS_ALERT', value: 'Orange' },
    statementVerbatim: null,
    url: null,
    evidenceId: 'EV:OBS:42',
  };
}

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    family: 'EARTHQUAKES',
    availability: 'AVAILABLE',
    coverage: { level: 'COVERED', note: null },
    items: [],
    truncated: false,
    itemsTotal: 0,
    metrics: [],
    dataConfidence: { level: 'HIGH', reasons: [] },
    sourceHealth: [],
    caveats: [],
    ...overrides,
  };
}

describe('invariant I10 — CRITICAL requires an authoritative basis', () => {
  it('accepts CRITICAL with a basis', () => {
    expect(
      relevanceAssessmentSchema.safeParse(
        relevance({ level: 'CRITICAL', authoritativeBasis: basis() }),
      ).success,
    ).toBe(true);
  });

  /*
   * The failure this exists to prevent: GeoNerva raising its loudest level on its own authority.
   * `CRITICAL` is only reachable behind an official alert (ARCHITECTURE §9, ADR-017).
   */
  it('rejects CRITICAL with no basis', () => {
    const result = relevanceAssessmentSchema.safeParse(
      relevance({ level: 'CRITICAL', authoritativeBasis: null }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('I10');
  });

  /*
   * And the other direction, which is the half usually forgotten: a basis attached to a level
   * below CRITICAL would let a `MODERATE` item carry an official-alert badge.
   */
  it.each(['LOW', 'MODERATE', 'HIGH'])('rejects %s carrying a basis', (level) => {
    expect(
      relevanceAssessmentSchema.safeParse(relevance({ level, authoritativeBasis: basis() }))
        .success,
    ).toBe(false);
  });
});

describe('invariant I11 — an absence is never a zero', () => {
  it('accepts an AVAILABLE family with items', () => {
    expect(familyCardSchema.safeParse(card({ items: [subject()], itemsTotal: 1 })).success).toBe(
      true,
    );
  });

  it.each(['UNAVAILABLE', 'NOT_COVERED'])('accepts a %s family with nothing', (availability) => {
    expect(
      familyCardSchema.safeParse(
        card({ availability, coverage: { level: 'NOT_COVERED', note: 'No source covers this.' } }),
      ).success,
    ).toBe(true);
  });

  /**
   * The rule, from both sides.
   *
   * "No relevant hazards were found" and "GeoNerva cannot see this family here" are different
   * answers, and a card that is not `AVAILABLE` must carry neither items nor a count — because a
   * count of zero on such a card is the first answer rendered in place of the second.
   */
  it.each(['UNAVAILABLE', 'NOT_COVERED'])('rejects a %s family carrying items', (availability) => {
    const result = familyCardSchema.safeParse(
      card({
        availability,
        coverage: { level: 'NOT_COVERED', note: 'No source covers this.' },
        items: [subject()],
        itemsTotal: 1,
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('I11');
  });

  it('rejects a non-AVAILABLE family carrying a count with no items', () => {
    expect(
      familyCardSchema.safeParse(
        card({
          availability: 'UNAVAILABLE',
          coverage: { level: 'PARTIAL', note: 'Partial coverage.' },
          items: [],
          itemsTotal: 3,
        }),
      ).success,
    ).toBe(false);
  });

  /* `familyCoverageSchema`'s own rule: a limitation must be explained, not implied. */
  it('rejects PARTIAL coverage with no note', () => {
    expect(
      familyCardSchema.safeParse(card({ coverage: { level: 'PARTIAL', note: null } })).success,
    ).toBe(false);
  });
});

describe('invariant I15 — coordinates carry at most two decimals', () => {
  function location(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      key: 'c:31.63,-8.00',
      label: '31.63, -8.00',
      lat: 31.63,
      lon: -8,
      timezone: 'UTC',
      countryCode: null,
      admin1: null,
      ...overrides,
    };
  }

  it('accepts a rounded pair', () => {
    expect(locationRefSchema.safeParse(location()).success).toBe(true);
  });

  it('accepts an integer coordinate', () => {
    expect(locationRefSchema.safeParse(location({ lat: 0, lon: 0 })).success).toBe(true);
  });

  it.each([
    ['three decimals', 31.631],
    ['six decimals', 31.629512],
    ['a float artefact', 31.630000000000003],
  ])('rejects a latitude with %s', (_label, lat) => {
    const result = locationRefSchema.safeParse(location({ lat }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('I15');
  });

  it('rejects a longitude past two decimals', () => {
    expect(locationRefSchema.safeParse(location({ lon: -7.981084 })).success).toBe(false);
  });

  it('rejects a coordinate outside the world', () => {
    expect(locationRefSchema.safeParse(location({ lat: 91 })).success).toBe(false);
    expect(locationRefSchema.safeParse(location({ lon: 180.5 })).success).toBe(false);
  });
});

describe('timestamps are the one ISO form read models use', () => {
  it('accepts the canonical form', () => {
    expect(asOfContextSchema.safeParse(asOfContext()).success).toBe(true);
  });

  /*
   * Milliseconds are not decoration. `new Date(x).toISOString()` always emits them, so a timestamp
   * without them came from somewhere else — a hand-built string, a truncation, a different
   * serializer — and a contract that accepted both would make two spellings of one instant.
   */
  it.each([
    ['no milliseconds', '2026-09-21T12:00:00Z'],
    ['an offset instead of Z', '2026-09-21T14:00:00.000+02:00'],
    ['a space separator', '2026-09-21 12:00:00.000Z'],
    ['a date alone', '2026-09-21'],
    ['microseconds', '2026-09-21T12:00:00.000000Z'],
    ['a unix timestamp', '1789000000'],
    ['empty', ''],
  ])('rejects %s', (_label, asOf) => {
    expect(asOfContextSchema.safeParse(asOfContext({ asOf })).success).toBe(false);
  });

  function asOfContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      asOf: TS,
      isReplay: false,
      replayHorizon: {
        profile: 'lean',
        byFamily: {
          EARTHQUAKES: { earliestAsOf: TS, note: 'kept forever above M4.5' },
          FIRE_ACTIVITY: { earliestAsOf: TS, note: '72 h of detections' },
          FLOODS: { earliestAsOf: TS, note: 'kept forever' },
          CYCLONES: { earliestAsOf: TS, note: 'kept forever' },
          WEATHER_ALERTS: { earliestAsOf: TS, note: 'no source enabled' },
          OTHER: { earliestAsOf: TS, note: 'kept forever' },
        },
      },
      sourceCutoffs: { usgs: TS, firms: null },
      ...overrides,
    };
  }

  /** Every family, or the horizon is not a horizon. */
  it('rejects a replay horizon missing a family', () => {
    const value = asOfContext() as { replayHorizon: { byFamily: Record<string, unknown> } };
    delete value.replayHorizon.byFamily['CYCLONES'];
    expect(asOfContextSchema.safeParse(value).success).toBe(false);
  });
});

describe('problem documents', () => {
  function problem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: problemTypeUri('VALIDATION_FAILED'),
      title: 'One or more parameters are invalid',
      status: 400,
      detail: null,
      instance: '/api/v1/briefing',
      code: 'VALIDATION_FAILED',
      invalidParams: [],
      retryAfterS: null,
      earliestAsOf: null,
      affectedFamilies: [],
      traceId: '0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77',
      ...overrides,
    };
  }

  it('accepts a well-formed document', () => {
    expect(problemDetailsSchema.safeParse(problem()).success).toBe(true);
  });

  /**
   * The status a code carries is frozen, and this is the assertion that pins it.
   *
   * A schema range of 400–599 accepts a 418 for `VALIDATION_FAILED`, and the response's HTTP
   * status is built from the same field, so the two would agree while both being wrong. The
   * frozen table is the only thing that can catch it.
   */
  it.each(PROBLEM_CODES)('gives %s the status the frozen table assigns it', (code) => {
    expect(PROBLEM_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(
      problemDetailsSchema.safeParse(problem({ code, status: PROBLEM_STATUS[code] })).success,
    ).toBe(true);
  });

  it('rejects a status outside the error range', () => {
    expect(problemDetailsSchema.safeParse(problem({ status: 200 })).success).toBe(false);
    expect(problemDetailsSchema.safeParse(problem({ status: 600 })).success).toBe(false);
  });

  it('rejects a code outside the frozen list', () => {
    expect(problemDetailsSchema.safeParse(problem({ code: 'TEAPOT' })).success).toBe(false);
  });

  it('rejects an empty title, which the frontend may display verbatim', () => {
    expect(problemDetailsSchema.safeParse(problem({ title: '' })).success).toBe(false);
  });

  it('requires every extension field rather than allowing it to be omitted', () => {
    const value = problem();
    delete value['invalidParams'];
    expect(problemDetailsSchema.safeParse(value).success).toBe(false);
  });
});

describe('evidence', () => {
  function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'EV:RUN:0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77',
      kind: 'RUN',
      summary: 'usgs ingestion run, SUCCEEDED',
      sourceId: 'usgs',
      productId: 1,
      observedAt: null,
      ingestedAt: TS,
      url: null,
      resolvable: true,
      ...overrides,
    };
  }

  function runDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: 'RUN',
      runId: '0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77',
      sourceId: 'usgs',
      productId: 1,
      trigger: 'SCHEDULE',
      status: 'SUCCEEDED',
      startedAt: TS,
      finishedAt: TS,
      committedAt: TS,
      httpStatus: 200,
      bytesReceived: 1024,
      counts: { received: 1, newRecords: 0, newVersions: 0, unchanged: 1, rejected: 0 },
      newestObservedAt: null,
      errorClass: null,
      errorMessage: null,
      payloadSha256: null,
      workerVersion: null,
      ...overrides,
    };
  }

  it('accepts a matching item and payload', () => {
    expect(
      evidenceDetailSchema.safeParse({
        schemaVersion: READ_MODEL_SCHEMA_VERSION,
        item: item(),
        detail: runDetail(),
        attribution: [],
      }).success,
    ).toBe(true);
  });

  /* A citation must resolve to what it says it is. */
  it('rejects a payload whose kind differs from the item', () => {
    const result = evidenceDetailSchema.safeParse({
      schemaVersion: READ_MODEL_SCHEMA_VERSION,
      item: item({ kind: 'OBS', id: 'EV:OBS:41' }),
      detail: runDetail(),
      attribution: [],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('same kind');
  });

  it('rejects a detail served for an item marked unresolvable', () => {
    expect(
      evidenceDetailSchema.safeParse({
        schemaVersion: READ_MODEL_SCHEMA_VERSION,
        item: item({ resolvable: false }),
        detail: runDetail(),
        attribution: [],
      }).success,
    ).toBe(false);
  });

  it('rejects an error message past the 1 KB the column allows', () => {
    expect(
      evidenceDetailSchema.safeParse({
        schemaVersion: READ_MODEL_SCHEMA_VERSION,
        item: item(),
        detail: runDetail({ errorMessage: 'x'.repeat(1025) }),
        attribution: [],
      }).success,
    ).toBe(false);
  });

  it.each([
    ['a bare number', '41'],
    ['a lowercase kind', 'EV:obs:41'],
    ['an unknown kind', 'EV:XXX:41'],
    ['no kind', 'EV:41'],
  ])('rejects %s as an evidence id', (_label, id) => {
    expect(evidenceItemSchema.safeParse(item({ id })).success).toBe(false);
  });

  it('accepts every declared kind in an id', () => {
    for (const [kind, body] of [
      ['OBS', '41'],
      ['FCV', '904'],
      ['FDS', '904:148'],
      ['RUN', '0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77'],
      ['COR', '77'],
      ['BAS', 'a'.repeat(64)],
      ['REL', 'b'.repeat(64)],
      ['CHG', 'c'.repeat(64)],
    ] as const) {
      const parsed = evidenceItemSchema.safeParse(
        item({ id: `EV:${kind}:${body}`, kind, resolvable: false }),
      );
      expect(parsed.success, `${kind} ${body}`).toBe(true);
    }
  });
});

describe('citedEvidenceIds — the walk invariant I9 is checked with', () => {
  it('collects an evidenceId and an evidenceIds array', () => {
    expect([
      ...citedEvidenceIds({ evidenceId: 'EV:OBS:41', nested: { evidenceIds: ['EV:RUN:x'] } }),
    ]).toEqual(['EV:OBS:41', 'EV:RUN:x']);
  });

  /**
   * The two fields the first version missed, and the reason it missed them.
   *
   * `BaselineMetricView.id` is an `EV:BAS:` reference and `ChangeSignalView.id` is an `EV:CHG:`
   * one — both `EvidenceId`-typed and both named plainly `id`. The walk looked only for
   * `evidenceId` and `evidenceIds`, so a briefing could cite a change signal absent from its own
   * manifest and the refinement could not fail. Its comment claimed walking for the key name
   * "cannot" miss a field.
   */
  it('collects an id field that holds an evidence reference', () => {
    const changes = { headline: [{ id: 'EV:CHG:'.concat('a'.repeat(64)), title: 'x' }] };
    const metrics = { metrics: [{ id: 'EV:BAS:'.concat('b'.repeat(64)), metricCode: 'M' }] };
    expect([...citedEvidenceIds(changes)]).toEqual([`EV:CHG:${'a'.repeat(64)}`]);
    expect([...citedEvidenceIds(metrics)]).toEqual([`EV:BAS:${'b'.repeat(64)}`]);
  });

  /**
   * And the reason the check is on the *value* rather than on the key name alone.
   *
   * `RunSummaryView.id` is a bare uuid and `SourceProductView.id` is a number. Treating those as
   * citations would demand manifest entries that should not exist, which would turn a correct
   * response into a contract failure.
   */
  it('ignores an id that is not an evidence reference', () => {
    expect([...citedEvidenceIds({ id: '0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77' })]).toEqual([]);
    expect([...citedEvidenceIds({ id: 7 })]).toEqual([]);
    expect([...citedEvidenceIds({ id: 'EQ-26-7K3F9Q' })]).toEqual([]);
  });

  /* The manifest is the answer, not a question: its own ids are not citations. */
  it('does not treat the manifest as a citation of itself', () => {
    expect([
      ...citedEvidenceIds({
        evidenceManifest: [{ id: 'EV:OBS:41' }],
        cited: { evidenceId: 'EV:RUN:x' },
      }),
    ]).toEqual(['EV:RUN:x']);
  });

  it('walks arrays and nested objects to any depth', () => {
    expect([...citedEvidenceIds({ a: [{ b: [{ c: { evidenceIds: ['EV:COR:9'] } }] }] })]).toEqual([
      'EV:COR:9',
    ]);
  });
});

describe('the data-status entry', () => {
  function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sourceId: 'usgs',
      name: 'USGS',
      homepage: null,
      enabled: true,
      licence: 'Public domain',
      attributionText: 'Courtesy of the USGS.',
      termsUrl: null,
      disclaimer: null,
      coverageNote: null,
      coverageGeometryAvailable: false,
      hazardTypes: ['EARTHQUAKE'],
      capabilities: ['EVENT_REVISIONS'],
      health: {
        sourceId: 'usgs',
        productId: null,
        status: 'FRESH',
        lastAttemptAt: TS,
        lastSuccessAt: TS,
        newestObservedAt: TS,
        consecutiveFailures: 0,
        lastErrorClass: null,
        reasons: ['OK'],
        expected: {
          pollIntervalS: 300,
          fetchFreshWithinS: 900,
          fetchStaleAfterS: 3600,
          unavailableAfterS: 86_400,
          dataCurrentWithinS: 3600,
          dataStaleAfterS: 86_400,
          quietIsNormal: true,
        },
        evidenceId: 'EV:RUN:0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77',
      },
      products: [],
      recentRuns: [],
      successRate24h: 1,
      runCount24h: 4,
      ...overrides,
    };
  }

  it('accepts a rate with runs behind it', () => {
    expect(sourceStatusEntrySchema.safeParse(entry()).success).toBe(true);
  });

  it('accepts no rate when no run committed', () => {
    expect(
      sourceStatusEntrySchema.safeParse(entry({ successRate24h: null, runCount24h: 0 })).success,
    ).toBe(true);
  });

  /**
   * A rate exists exactly when runs do.
   *
   * Both halves are wrong in their own way: a rate with a denominator of zero is a number computed
   * from nothing, and a missing rate beside four committed runs hides a fact the page exists to
   * show.
   */
  it('rejects a rate with no runs behind it', () => {
    expect(
      sourceStatusEntrySchema.safeParse(entry({ successRate24h: 1, runCount24h: 0 })).success,
    ).toBe(false);
  });

  it('rejects a missing rate when runs were committed', () => {
    expect(
      sourceStatusEntrySchema.safeParse(entry({ successRate24h: null, runCount24h: 4 })).success,
    ).toBe(false);
  });

  it('rejects a rate outside [0, 1]', () => {
    expect(sourceStatusEntrySchema.safeParse(entry({ successRate24h: 1.5 })).success).toBe(false);
    expect(sourceStatusEntrySchema.safeParse(entry({ successRate24h: -0.1 })).success).toBe(false);
  });
});

describe('invariant I9 on the data-status response', () => {
  function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: READ_MODEL_SCHEMA_VERSION,
      asOfContext: {
        asOf: TS,
        isReplay: false,
        replayHorizon: {
          profile: 'lean',
          byFamily: Object.fromEntries(
            ['EARTHQUAKES', 'FIRE_ACTIVITY', 'FLOODS', 'CYCLONES', 'WEATHER_ALERTS', 'OTHER'].map(
              (family) => [family, { earliestAsOf: TS, note: 'n' }],
            ),
          ),
        },
        sourceCutoffs: {},
      },
      generatedAt: TS,
      sources: [],
      worker: null,
      dataQuality: [],
      evidenceManifest: [],
      attribution: [],
      ...overrides,
    };
  }

  const RUN_ID = 'EV:RUN:0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77';

  function entryCiting(evidenceId: string | null): Record<string, unknown> {
    return {
      sourceId: 'usgs',
      name: 'USGS',
      homepage: null,
      enabled: true,
      licence: 'Public domain',
      attributionText: 'Courtesy of the USGS.',
      termsUrl: null,
      disclaimer: null,
      coverageNote: null,
      coverageGeometryAvailable: false,
      hazardTypes: ['EARTHQUAKE'],
      capabilities: [],
      health: {
        sourceId: 'usgs',
        productId: null,
        status: 'FRESH',
        lastAttemptAt: TS,
        lastSuccessAt: TS,
        newestObservedAt: TS,
        consecutiveFailures: 0,
        lastErrorClass: null,
        reasons: ['OK'],
        expected: {
          pollIntervalS: 300,
          fetchFreshWithinS: 900,
          fetchStaleAfterS: 3600,
          unavailableAfterS: 86_400,
          dataCurrentWithinS: 3600,
          dataStaleAfterS: 86_400,
          quietIsNormal: true,
        },
        evidenceId,
      },
      products: [],
      recentRuns: [],
      successRate24h: null,
      runCount24h: 0,
    };
  }

  function manifestEntryFor(id: string): Record<string, unknown> {
    return {
      id,
      kind: 'RUN',
      summary: 'usgs ingestion run, SUCCEEDED',
      sourceId: 'usgs',
      productId: null,
      observedAt: null,
      ingestedAt: TS,
      url: null,
      resolvable: true,
    };
  }

  it('accepts a response whose citations are all in its manifest', () => {
    expect(
      sourceStatusSchema.safeParse(
        status({ sources: [entryCiting(RUN_ID)], evidenceManifest: [manifestEntryFor(RUN_ID)] }),
      ).success,
    ).toBe(true);
  });

  it('accepts a response that cites nothing', () => {
    expect(sourceStatusSchema.safeParse(status({ sources: [entryCiting(null)] })).success).toBe(
      true,
    );
  });

  /**
   * The contract was missing this refinement while the briefing's had it, and the gap was not
   * theoretical: the assembly omitted a manifest entry it could not resolve while still citing the
   * id, and a test asserted that as the desired behaviour.
   */
  it('rejects a response that cites an id its manifest does not contain', () => {
    const result = sourceStatusSchema.safeParse(status({ sources: [entryCiting(RUN_ID)] }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('I9');
  });
});

describe('run summaries', () => {
  it('rejects a negative count', () => {
    expect(
      runSummaryViewSchema.safeParse({
        id: '0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77',
        productId: null,
        trigger: 'SCHEDULE',
        status: 'SUCCEEDED',
        startedAt: TS,
        committedAt: TS,
        durationMs: 10,
        counts: { received: -1, newRecords: 0, newVersions: 0, unchanged: 0, rejected: 0 },
        newestObservedAt: null,
        errorClass: null,
        evidenceId: 'EV:RUN:0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77',
      }).success,
    ).toBe(false);
  });
});

describe('map features', () => {
  function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const box = { west: -9, south: 31, east: -7, north: 32 };
    return {
      schemaVersion: READ_MODEL_SCHEMA_VERSION,
      asOfContext: {
        asOf: TS,
        isReplay: false,
        replayHorizon: {
          profile: 'lean',
          byFamily: Object.fromEntries(
            ['EARTHQUAKES', 'FIRE_ACTIVITY', 'FLOODS', 'CYCLONES', 'WEATHER_ALERTS', 'OTHER'].map(
              (family) => [family, { earliestAsOf: TS, note: 'n' }],
            ),
          ),
        },
        sourceCutoffs: {},
      },
      bbox: box,
      bboxParts: [box],
      zoom: 6,
      families: ['EARTHQUAKES'],
      features: [],
      truncated: false,
      cap: 500,
      total: 0,
      attribution: [],
      ...overrides,
    };
  }

  it('accepts an empty viewport', () => {
    expect(mapFeaturesResponseSchema.safeParse(response()).success).toBe(true);
  });

  /* §7.5: above the cap the response says so rather than silently dropping features. */
  it('rejects a total above the feature count with truncated false', () => {
    expect(
      mapFeaturesResponseSchema.safeParse(response({ total: 900, truncated: false })).success,
    ).toBe(false);
  });

  it('rejects truncated true when nothing was dropped', () => {
    expect(
      mapFeaturesResponseSchema.safeParse(response({ total: 0, truncated: true })).success,
    ).toBe(false);
  });

  it('rejects more than two bbox parts, because only the antimeridian splits a viewport', () => {
    const box = { west: -9, south: 31, east: -7, north: 32 };
    expect(
      mapFeaturesResponseSchema.safeParse(response({ bboxParts: [box, box, box] })).success,
    ).toBe(false);
  });

  it('rejects an empty bboxParts, which would describe no viewport at all', () => {
    expect(mapFeaturesResponseSchema.safeParse(response({ bboxParts: [] })).success).toBe(false);
  });
});

describe('the AI block', () => {
  function ai(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'claude-opus-5',
      promptVersion: 'v1',
      validationStatus: 'PASSED',
      sections: [],
      evidenceIds: [],
      disclaimer: 'Generated text, checked against the evidence above.',
      generatedAt: TS,
      ...overrides,
    };
  }

  it.each(['PASSED', 'REPAIRED'])('accepts %s', (validationStatus) => {
    expect(aiBriefingViewSchema.safeParse(ai({ validationStatus })).success).toBe(true);
  });

  /*
   * A `REJECTED` output is kept for evaluation and never shown (ADR-012, ARCHITECTURE §11). A
   * response carrying one would be the validator having been bypassed, so the contract refuses it
   * rather than relying on the writer.
   */
  it('rejects REJECTED, which must never reach a reader', () => {
    expect(aiBriefingViewSchema.safeParse(ai({ validationStatus: 'REJECTED' })).success).toBe(
      false,
    );
  });

  it('requires a disclaimer', () => {
    expect(aiBriefingViewSchema.safeParse(ai({ disclaimer: '' })).success).toBe(false);
  });
});

describe('fact values', () => {
  it('keeps the decimals a number must be rendered with, so 5.30 stays 5.30', () => {
    expect(
      factValueSchema.safeParse({ kind: 'number', value: 5.3, unit: null, decimals: 2 }).success,
    ).toBe(true);
  });

  it('rejects a number with no decimals field', () => {
    expect(factValueSchema.safeParse({ kind: 'number', value: 5.3, unit: null }).success).toBe(
      false,
    );
  });

  it('requires a reason for an unavailable value', () => {
    expect(factValueSchema.safeParse({ kind: 'unavailable' }).success).toBe(false);
    expect(factValueSchema.safeParse({ kind: 'unavailable', reason: 'NOT_COVERED' }).success).toBe(
      true,
    );
  });

  it('rejects a reason outside the declared list', () => {
    expect(factValueSchema.safeParse({ kind: 'unavailable', reason: 'DUNNO' }).success).toBe(false);
  });

  /* A severity is always `{ scheme, value }`: never converted, never compared across schemes. */
  it('rejects a bare severity string', () => {
    expect(factValueSchema.safeParse({ kind: 'severity', severity: 'Orange' }).success).toBe(false);
    expect(
      factValueSchema.safeParse({
        kind: 'severity',
        severity: { scheme: 'GDACS_ALERT', value: 'Orange' },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(factValueSchema.safeParse({ kind: 'percentage', value: 40 }).success).toBe(false);
  });
});

describe('ObservationEvidenceDetail: the raw-payload lifecycle (ADR-038)', () => {
  const SHA = 'c'.repeat(64);
  function detail(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'OBS',
      versionId: '41',
      versionSeq: 1,
      sourceRecordPrimaryKey: 'us7000tikb',
      hazardType: 'EARTHQUAKE',
      lifecycleStatus: 'ACTIVE',
      observedAt: '2026-09-21T11:58:00.000Z',
      validFrom: null,
      validTo: null,
      sourceUpdatedAt: null,
      ingestedAt: '2026-09-21T12:04:00.000Z',
      contributor: 'us',
      contentSha256: 'b'.repeat(64),
      rawExcerpt: null,
      rawPayloadSha256: SHA,
      rawPayloadPruned: false,
      rawPayload: {
        state: 'AVAILABLE',
        sha256: SHA,
        capturedAt: '2026-09-21T12:04:00.000Z',
        retentionExpiresAt: '2026-10-21T12:04:00.000Z',
      },
      sourceUrl: null,
      ...overrides,
    };
  }
  const parses = (value: unknown) => observationEvidenceDetailSchema.safeParse(value).success;

  it('accepts a consistent detail', () => {
    expect(parses(detail())).toBe(true);
  });

  it('refuses a served excerpt', () => {
    expect(parses(detail({ rawExcerpt: { any: 'body' } }))).toBe(false);
  });

  it('refuses P8 fields that disagree with the lifecycle', () => {
    expect(parses(detail({ rawPayloadSha256: null }))).toBe(false);
    expect(parses(detail({ rawPayloadPruned: true }))).toBe(false);
  });

  it('refuses a captured state without its digest or times, and times without a capture', () => {
    const view = detail().rawPayload;
    expect(parses(detail({ rawPayload: { ...view, sha256: null }, rawPayloadSha256: null }))).toBe(
      false,
    );
    expect(parses(detail({ rawPayload: { ...view, capturedAt: null } }))).toBe(false);
    expect(parses(detail({ rawPayload: { ...view, retentionExpiresAt: null } }))).toBe(false);
    expect(
      parses(
        detail({
          rawPayload: { ...view, state: 'NOT_CAPTURED' },
        }),
      ),
    ).toBe(false);
  });

  it('refuses a digest for an unreadable row', () => {
    expect(
      parses(
        detail({
          rawPayload: {
            state: 'SOURCE_UNAVAILABLE',
            sha256: SHA,
            capturedAt: null,
            retentionExpiresAt: null,
          },
        }),
      ),
    ).toBe(false);
    expect(
      parses(
        detail({
          rawPayloadSha256: null,
          rawPayload: {
            state: 'SOURCE_UNAVAILABLE',
            sha256: null,
            capturedAt: null,
            retentionExpiresAt: null,
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('subject links follow the product routes (PRODUCT §6.1)', () => {
  const parses = (href: string): boolean =>
    familyCardSchema.safeParse(card({ items: [subject({ href })], itemsTotal: 1 })).success;

  it('accepts /event/<publicId> and /fire/<publicId>', () => {
    expect(parses('/event/EQ-26-7K3F9Q')).toBe(true);
    expect(parses('/fire/FR-26-2B8K4M')).toBe(true);
  });

  it('refuses the plural API-shaped paths the briefing used to emit, and anything else', () => {
    for (const href of [
      '/events/EQ-26-7K3F9Q',
      '/fires/FR-26-2B8K4M',
      '/api/v1/events/EQ-26-7K3F9Q',
      'https://example.org/event/EQ-26-7K3F9Q',
      '/event/EQ-26-7K3F9Q?x=1',
      '/event/',
    ]) {
      expect(parses(href), href).toBe(false);
    }
  });
});

describe('a trend carries a direction, not a distribution band (ADR-040)', () => {
  function metric(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'EV:BAS:8f14e45fce0b4d3a9c1e2b7f6a5d4c3b2a1908f7e6d5c4b3a2019f8e7d6c5b4a',
      family: 'FIRE_ACTIVITY',
      metricCode: 'FIRE_TREND',
      label: 'Fire activity within 100 km',
      params: { radiusKm: 100, lastDay: '2026-09-20' },
      asOf: TS,
      status: 'OK',
      observedValue: { kind: 'number', value: 31.4, unit: 'detections/day', decimals: 1 },
      reference: null,
      percentile: null,
      band: null,
      trendBand: 'INCREASING',
      interpretation: 'More thermal detections in the last 7 days than in the 4 weeks before.',
      caveats: [],
      methodVersion: 'baselines-1',
      evidenceIds: [],
      ...overrides,
    };
  }

  it('accepts a direction with no distribution band', () => {
    expect(baselineMetricViewSchema.safeParse(metric()).success).toBe(true);
  });

  /*
   * The field is required, not optional: a metric that simply omits it would read to a client as
   * "no direction known", which is a different statement from "this metric has no direction".
   */
  it('requires the field, and refuses a direction that is not one of the three', () => {
    const withoutTrend = metric();
    delete withoutTrend['trendBand'];
    expect(baselineMetricViewSchema.safeParse(withoutTrend).success).toBe(false);
    for (const value of ['RISING', 'ABOVE_TYPICAL', 'increasing', '']) {
      expect(baselineMetricViewSchema.safeParse(metric({ trendBand: value })).success, value).toBe(
        false,
      );
    }
  });

  /* A refused comparison still has to be a valid document: no direction, and no value. */
  it('accepts the insufficient-coverage answer, which has neither band', () => {
    expect(
      baselineMetricViewSchema.safeParse(
        metric({
          status: 'INSUFFICIENT_COVERAGE',
          observedValue: { kind: 'unavailable', reason: 'NOT_COVERED' },
          trendBand: null,
          interpretation: 'Not enough satellite coverage in the last five weeks.',
        }),
      ).success,
    ).toBe(true);
  });
});

/**
 * `/history`'s response-level rules, and the one ADR-040 changed.
 *
 * The refinement used to read "a reference distribution exists exactly when the metric status is
 * OK", which was true while every metric was a comparison against a distribution. `FIRE_TREND`
 * states a direction instead and succeeds with no reference at all, so a successful trend was
 * rejected by the contract it was built for. Nothing caught it: the refinement had no test.
 */
describe('a history response and its reference distribution', () => {
  const BAS = 'EV:BAS:8f14e45fce0b4d3a9c1e2b7f6a5d4c3b2a1908f7e6d5c4b3a2019f8e7d6c5b4a';

  function bands(): Record<string, unknown> {
    return {
      windowDays: 7,
      nWindows: 260,
      nEvents: 812,
      referenceFrom: TS,
      referenceTo: TS,
      p25: 1,
      median: 2,
      p75: 4,
      p90: 6,
      p95: 8,
      mean: 2.9,
      evidenceIds: [],
    };
  }

  function reference(): Record<string, unknown> {
    return {
      nWindows: 260,
      nEvents: 812,
      windowDays: 7,
      referenceFrom: TS,
      referenceTo: TS,
      median: 2,
      p25: 1,
      p75: 4,
      p90: 6,
      p95: 8,
      mean: 2.9,
      ratePerWindow: 2.9,
      activityRatio: 1.4,
    };
  }

  function history(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: READ_MODEL_SCHEMA_VERSION,
      location: {
        key: 'c:31.63,-8.00',
        label: '31.63, -8.00',
        lat: 31.63,
        lon: -8,
        timezone: 'UTC',
        countryCode: null,
        admin1: null,
      },
      family: 'FIRE_ACTIVITY',
      metricCode: 'FIRE_TREND',
      asOfContext: {
        asOf: TS,
        isReplay: false,
        replayHorizon: {
          profile: 'lean',
          byFamily: Object.fromEntries(
            HAZARD_FAMILIES.map((family) => [family, { earliestAsOf: TS, note: 'kept' }]),
          ),
        },
        sourceCutoffs: { firms: TS },
      },
      metric: {
        id: BAS,
        family: 'FIRE_ACTIVITY',
        metricCode: 'FIRE_TREND',
        label: 'Fire activity within 100 km',
        params: { radiusKm: 100 },
        asOf: TS,
        status: 'OK',
        observedValue: { kind: 'number', value: 31.4, unit: 'detections/day', decimals: 1 },
        reference: null,
        percentile: null,
        band: null,
        trendBand: 'INCREASING',
        interpretation: 'More thermal detections than in the four weeks before.',
        caveats: [],
        methodVersion: 'baselines-1',
        evidenceIds: [],
      },
      series: [],
      referenceBands: null,
      rarity: null,
      largestRecent: null,
      sequenceContext: null,
      completenessStatement: null,
      caveats: [],
      methodologyHref: '/methodology#fire-trend',
      // I9: the manifest must contain everything the response cites, the metric's own id included.
      evidenceManifest: [
        {
          id: BAS,
          kind: 'BAS',
          summary: 'fire activity trend within 100 km',
          sourceId: null,
          productId: null,
          observedAt: null,
          ingestedAt: TS,
          url: null,
          resolvable: true,
        },
      ],
      attribution: [],
      ...overrides,
    };
  }

  /** A distribution metric, for the rule the trend is exempt from. */
  function distribution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const base = history({ family: 'EARTHQUAKES', metricCode: 'EQ_COUNT_7D' });
    return {
      ...base,
      metric: {
        ...(base['metric'] as Record<string, unknown>),
        family: 'EARTHQUAKES',
        metricCode: 'EQ_COUNT_7D',
        label: 'Earthquakes in 7 days',
        observedValue: { kind: 'count', value: 5 },
        trendBand: null,
        band: 'TYPICAL',
        percentile: 62,
        reference: reference(),
      },
      referenceBands: bands(),
      ...overrides,
    };
  }

  it('accepts a successful trend that has no reference distribution (ADR-040)', () => {
    expect(historyResponseSchema.safeParse(history()).success).toBe(true);
  });

  /* The other direction: a direction with a distribution beside it is a statistic nobody computed. */
  it('refuses a trend that carries a reference distribution', () => {
    const result = historyResponseSchema.safeParse(history({ referenceBands: bands() }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('a trend states a direction instead');

    /* A fully-formed distribution beside a direction is the coherent-looking version, and worse. */
    const base = history({ referenceBands: bands() });
    const metric = { ...(base['metric'] as Record<string, unknown>) };
    metric['reference'] = reference();
    expect(historyResponseSchema.safeParse({ ...base, metric }).success).toBe(false);
  });

  it('still requires a reference when a distribution metric is OK', () => {
    expect(historyResponseSchema.safeParse(distribution()).success).toBe(true);
    expect(historyResponseSchema.safeParse(distribution({ referenceBands: null })).success).toBe(
      false,
    );
  });

  /* A refused comparison keeps the old rule: no status OK, no reference, and no band. */
  it('refuses a reference on a metric that did not succeed', () => {
    const base = history();
    const metric = { ...(base['metric'] as Record<string, unknown>) };
    metric['status'] = 'INSUFFICIENT_COVERAGE';
    metric['trendBand'] = null;
    metric['observedValue'] = { kind: 'unavailable', reason: 'NOT_COVERED' };
    expect(
      historyResponseSchema.safeParse({ ...base, metric, referenceBands: bands() }).success,
    ).toBe(false);
    expect(historyResponseSchema.safeParse({ ...base, metric }).success).toBe(true);
  });
});
