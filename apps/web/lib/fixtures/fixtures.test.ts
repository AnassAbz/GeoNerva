/**
 * Every P9a mock read model must satisfy its frozen runtime schema, so that the pages built
 * against the mocks are built against the contract P8 serves. A mock that drifts fails here.
 */

import {
  CHANGE_WINDOWS,
  HAZARD_FAMILIES,
  READ_MODEL_SCHEMA_VERSION,
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

  it('the earthquake carries USGS Mww 4.7 and EMSC mb 4.6 with minor differences', () => {
    const eq = marrakechBriefing().snapshot.families.EARTHQUAKES.items[0];
    expect(eq?.agreement?.level).toBe('MINOR_DIFFERENCES');
    expect(eq?.agreement?.nIndependentSources).toBe(2);
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
