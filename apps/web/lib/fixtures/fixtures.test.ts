/**
 * Every P9a mock read model must satisfy its frozen runtime schema, so that the pages built
 * against the mocks are built against the contract P8 serves. A mock that drifts fails here.
 */

import { metricsFor } from '@geonerva/briefing';
import {
  CHANGE_WINDOWS,
  FACT_CODES,
  FIELD_COMPARISON_CODES,
  HAZARD_FAMILIES,
  READ_MODEL_SCHEMA_VERSION,
  REVISION_CHANGED_FIELDS,
  REVISION_CHANGE_CODES,
  eventDetailSchema,
  evidenceDetailSchema,
  fireClusterDetailSchema,
  historyResponseSchema,
  locationBriefingSchema,
  mapFeaturesResponseSchema,
  placeSuggestionSchema,
  sourceStatusSchema,
} from '@geonerva/domain';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_NOW,
  PLACE_SUGGESTIONS,
  earthquakeDetail,
  fireClusterDetail,
  floodDetail,
  historyFixture,
  mapFeaturesFixture,
  marrakechBriefing,
  observationEvidence,
  runEvidence,
  sourceStatusFixture,
} from './index.ts';

function expectValid(
  schema: { safeParse: (value: unknown) => { success: boolean; error?: unknown } },
  value: unknown,
): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `fixture does not satisfy its schema: ${JSON.stringify(result.error, null, 2)}`,
    );
  }
  expect(result.success).toBe(true);
}

describe('LocationBriefing fixtures', () => {
  for (const window of CHANGE_WINDOWS) {
    for (const scenario of ['all-fresh', 'firms-stale'] as const) {
      it(`${scenario}, window ${window}, is a valid LocationBriefing`, () => {
        expectValid(locationBriefingSchema, marrakechBriefing({ window, scenario }));
      });
    }
  }

  it('a replay at an earlier knowledge time is valid and hides what arrived later', () => {
    const replay = marrakechBriefing({ asOf: '2026-09-22T10:10:00.000Z' });
    expectValid(locationBriefingSchema, replay);
    expect(replay.asOfContext.isReplay).toBe(true);
    const titles = replay.snapshot.families.EARTHQUAKES.items.map((item) => item.publicId);
    expect(titles).not.toContain('EQ-26-7K3F9Q');
  });

  it('carries the current schema version rather than a literal', () => {
    expect(marrakechBriefing().schemaVersion).toBe(READ_MODEL_SCHEMA_VERSION);
  });

  it('in the FIRMS outage, the fire card is unavailable with no items and no count (I11)', () => {
    const card = marrakechBriefing({ scenario: 'firms-stale' }).snapshot.families.FIRE_ACTIVITY;
    expect(card.availability).toBe('UNAVAILABLE');
    expect(card.items).toHaveLength(0);
    expect(card.itemsTotal).toBe(0);
    expect(card.sourceHealth[0]?.status).toBe('STALE');
  });

  it('weather warnings are not covered in Morocco', () => {
    const card = marrakechBriefing().snapshot.families.WEATHER_ALERTS;
    expect(card.availability).toBe('NOT_COVERED');
  });

  /*
   * The title used to name the magnitude types — "USGS Mww 4.7 and EMSC mb 4.6" — which the
   * response does not carry: `magnitude_type` is read into the member solutions and dropped on
   * the way out (H-3). The assertions never checked them; the title implied coverage that did not
   * exist, which is the same drift in prose.
   */
  it('the earthquake carries two independent sources with minor differences', () => {
    const eq = marrakechBriefing().snapshot.families.EARTHQUAKES.items[0];
    expect(eq?.agreement?.level).toBe('MINOR_DIFFERENCES');
    expect(eq?.agreement?.nIndependentSources).toBe(2);
    const magnitudes = eq?.agreement?.comparisons
      .find((comparison) => comparison.code === 'MAGNITUDE')
      ?.values.map((value) => [value.sourceId, value.value]);
    expect(magnitudes).toEqual([
      ['usgs', { kind: 'number', value: 4.7, unit: null, decimals: 1 }],
      ['emsc', { kind: 'number', value: 4.6, unit: null, decimals: 1 }],
    ]);
  });
});

describe('detail fixtures', () => {
  it('earthquake detail, with and without a place, is a valid EventDetail', () => {
    expectValid(eventDetailSchema, earthquakeDetail());
    expectValid(eventDetailSchema, earthquakeDetail({ withPlace: false }));
  });

  it('flood detail is a valid EventDetail', () => {
    expectValid(eventDetailSchema, floodDetail());
  });

  it('fire cluster detail, with and without a place, is a valid FireClusterDetail', () => {
    expectValid(fireClusterDetailSchema, fireClusterDetail());
    expectValid(fireClusterDetailSchema, fireClusterDetail({ withPlace: false }));
  });

  it('evidence details are valid EvidenceDetail responses', () => {
    expectValid(evidenceDetailSchema, observationEvidence());
    expectValid(evidenceDetailSchema, runEvidence());
  });
});

describe('source status, map and places fixtures', () => {
  it('source status, normal and FIRMS-stale, is a valid SourceStatus', () => {
    expectValid(sourceStatusSchema, sourceStatusFixture('all-fresh'));
    expectValid(sourceStatusSchema, sourceStatusFixture('firms-stale'));
  });

  it('map features, normal and FIRMS-stale, are a valid MapFeaturesResponse', () => {
    expectValid(mapFeaturesResponseSchema, mapFeaturesFixture('all-fresh'));
    expectValid(mapFeaturesResponseSchema, mapFeaturesFixture('firms-stale'));
  });

  it('place suggestions are valid', () => {
    for (const suggestion of PLACE_SUGGESTIONS) expectValid(placeSuggestionSchema, suggestion);
  });
});

describe('history fixtures', () => {
  const statuses = new Set<string>();
  for (const family of HAZARD_FAMILIES) {
    for (const scenario of ['all-fresh', 'firms-stale'] as const) {
      it(`${family} (${scenario}) is a valid HistoryResponse or intentionally absent`, () => {
        const history = historyFixture({ family, scenario, asOf: FIXTURE_NOW });
        if (history === null) {
          expect(['WEATHER_ALERTS', 'OTHER']).toContain(family);
          return;
        }
        expectValid(historyResponseSchema, history);
        statuses.add(history.metric.status);
      });
    }
  }

  it('the 30-day earthquake metric is a valid HistoryResponse', () => {
    const history = historyFixture({
      family: 'EARTHQUAKES',
      metricCode: 'EQ_COUNT_30D',
      asOf: FIXTURE_NOW,
    });
    expectValid(historyResponseSchema, history);
    if (history !== null) statuses.add(history.metric.status);
  });

  it('together, the history fixtures cover every baseline status', () => {
    expect([...statuses].sort()).toEqual([
      'INSUFFICIENT_COVERAGE',
      'INSUFFICIENT_HISTORY',
      'NOT_APPLICABLE',
      'OK',
      'RARE_ACTIVITY',
    ]);
  });
});

/**
 * The contract test QA round 2 §4 asks for.
 *
 * Schema validity is necessary and was never sufficient: at `12567bf` every fixture above parsed
 * cleanly while spelling its field codes `'magnitude'`, `'magnitude_type'`, `'depth'`,
 * `'origin_time'`, `'alert_level'` and `'detections_24h'` — a vocabulary no builder has ever
 * emitted — because the schema typed each of them `z.string()`. The component suite renders these
 * fixtures, so it was green against a shape the API does not produce, and two of the round's five
 * HIGH findings were things those tests asserted were **correct**.
 *
 * What closes that hole is comparing the fixtures' enumerable codes with the builders' own lists.
 * `FACT_CODES`, `FIELD_COMPARISON_CODES` and `REVISION_CHANGE_CODES` live in `@geonerva/domain`
 * beside the enums, and the builders assert their literals against them (`satisfies FactCode` in
 * `snapshot.ts`, `satisfies RevisionChangeCode` in `timeline.ts`). So the check runs **both**
 * ways, and either kind of drift fails here:
 *
 *  - a fixture using a code no builder emits fails the ⊆ direction;
 *  - a builder gaining a code fails to compile until the list grows, and the list growing fails
 *    the ⊇ direction until a fixture supplies one. `MAGNITUDE_TYPE` — H-3's missing comparison —
 *    is exactly this case: adding it to the builder will make this test demand it here.
 */
describe('fixture codes match the vocabulary the builders emit', () => {
  /** Every fixture that can hold a `Fact`, a `FieldComparison` or a revision. */
  function surfaces() {
    const briefings = (['all-fresh', 'firms-stale'] as const).map((scenario) =>
      marrakechBriefing({ scenario }),
    );
    return {
      items: [
        ...briefings.flatMap((briefing) =>
          HAZARD_FAMILIES.flatMap((family) => briefing.snapshot.families[family].items),
        ),
        ...[earthquakeDetail(), floodDetail()].map((detail) => ({
          facts: detail.headline.facts,
          agreement: detail.agreement,
        })),
      ],
      metrics: [
        ...briefings.flatMap((briefing) =>
          HAZARD_FAMILIES.flatMap((family) => briefing.snapshot.families[family].metrics),
        ),
      ],
      revisions: [earthquakeDetail(), floodDetail()].flatMap((detail) => detail.timeline),
    };
  }

  it('every fact code is one the builders emit', () => {
    const used = new Set(surfaces().items.flatMap((item) => item.facts.map((fact) => fact.code)));
    expect([...used].filter((code) => !(FACT_CODES as readonly string[]).includes(code))).toEqual(
      [],
    );
  });

  it('every fact code the builders emit is exercised by a fixture', () => {
    const used = new Set(surfaces().items.flatMap((item) => item.facts.map((fact) => fact.code)));
    expect(FACT_CODES.filter((code) => !used.has(code))).toEqual([]);
  });

  it('every comparison code is one the builders emit, and each is exercised', () => {
    const used = new Set(
      surfaces().items.flatMap(
        (item) => item.agreement?.comparisons.map((comparison) => comparison.code) ?? [],
      ),
    );
    expect(
      [...used].filter((code) => !(FIELD_COMPARISON_CODES as readonly string[]).includes(code)),
    ).toEqual([]);
    expect(FIELD_COMPARISON_CODES.filter((code) => !used.has(code))).toEqual([]);
  });

  it('every revision change code and changed-field name is one describeRevision produces', () => {
    const revisions = surfaces().revisions;
    const codes = new Set(revisions.flatMap((entry) => entry.changes.map((change) => change.code)));
    const fields = new Set(revisions.flatMap((entry) => entry.changedFields));
    expect(
      [...codes].filter((code) => !(REVISION_CHANGE_CODES as readonly string[]).includes(code)),
    ).toEqual([]);
    expect(
      [...fields].filter(
        (field) => !(REVISION_CHANGED_FIELDS as readonly string[]).includes(field),
      ),
    ).toEqual([]);
  });

  it('every metric code is one buildHistory offers', () => {
    const offered = new Set(HAZARD_FAMILIES.flatMap((family) => metricsFor(family)) as string[]);
    const used = new Set(surfaces().metrics.map((metric) => metric.metricCode));
    expect([...used].filter((code) => !offered.has(code))).toEqual([]);
  });
});
