/**
 * Baseline metrics of the fixture world, one per status the contract allows, and the history
 * responses the "Historical context" region draws from them.
 */

import type {
  BaselineMetricView,
  HazardFamily,
  HistoryResponse,
  TimeSeriesPoint,
} from '@geonerva/domain';

import {
  MARRAKECH,
  SCHEMA_VERSION,
  asOfContext,
  attributionFor,
  manifestFor,
  minutesBefore,
} from './common.ts';
import { EV, EQ_PUBLIC_ID, T, evidenceRegistry } from './world.ts';

export const EARTHQUAKE_ELEVATED_CAVEAT =
  'Elevated recent activity does not by itself indicate that a larger earthquake will occur.';

export type FixtureScenario = 'all-fresh' | 'firms-stale';

export function eqCount7d(asOf: string): BaselineMetricView {
  return {
    id: EV.basEq7,
    family: 'EARTHQUAKES',
    metricCode: 'EQ_COUNT_7D',
    label: 'Earthquakes within 150 km, per 7 days',
    params: { radiusKm: 150, windowDays: 7, minMagnitude: 3.1, sinceYear: 2021 },
    asOf,
    status: 'OK',
    observedValue: { kind: 'count', value: 2 },
    reference: {
      nWindows: 260,
      nEvents: 143,
      windowDays: 7,
      referenceFrom: '2021-09-20T00:00:00.000Z',
      referenceTo: '2026-09-15T13:06:00.000Z',
      median: 0,
      p25: 0,
      p75: 1,
      p90: 2,
      p95: 2,
      mean: 0.55,
      ratePerWindow: 0.55,
      activityRatio: null,
    },
    percentile: 91,
    band: 'ABOVE_TYPICAL',
    trendBand: null,
    interpretation:
      '2 earthquakes of M3.1 or larger within 150 km in the past 7 days: above typical for this area, compared with 260 7-day periods since 2021.',
    caveats: [EARTHQUAKE_ELEVATED_CAVEAT],
    methodVersion: 'bas-eq-1',
    evidenceIds: [EV.usgsV2, EV.usgsOlder],
  };
}

export function eqCount30d(asOf: string): BaselineMetricView {
  return {
    id: EV.basEq30,
    family: 'EARTHQUAKES',
    metricCode: 'EQ_COUNT_30D',
    label: 'Earthquakes within 150 km, per 30 days',
    params: { radiusKm: 150, windowDays: 30, minMagnitude: 3.1, sinceYear: null },
    asOf,
    status: 'INSUFFICIENT_COVERAGE',
    observedValue: { kind: 'unavailable', reason: 'INSUFFICIENT_HISTORY' },
    reference: null,
    percentile: null,
    band: null,
    trendBand: null,
    interpretation:
      'GeoNerva had been reading the earthquake catalog for less than 30 days at this time, so it cannot count a whole period.',
    caveats: [],
    methodVersion: 'bas-eq-1',
    evidenceIds: [],
  };
}

export function fireTrend(asOf: string, scenario: FixtureScenario): BaselineMetricView {
  if (scenario === 'firms-stale') {
    return {
      id: EV.basFireCoverage,
      family: 'FIRE_ACTIVITY',
      metricCode: 'FIRE_TREND',
      label: 'Fire activity trend',
      params: { radiusKm: 100, recentDays: 7, referenceDays: 28 },
      asOf,
      status: 'INSUFFICIENT_COVERAGE',
      observedValue: { kind: 'unavailable', reason: 'SOURCE_UNAVAILABLE' },
      reference: null,
      percentile: null,
      band: null,
      trendBand: null,
      interpretation:
        'NASA FIRMS has not delivered recently, so the last days cannot be counted and no trend can be stated.',
      caveats: [],
      methodVersion: 'bas-fire-1',
      evidenceIds: [EV.runFirmsFailed],
    };
  }
  return {
    id: EV.basFire,
    family: 'FIRE_ACTIVITY',
    metricCode: 'FIRE_TREND',
    label: 'Fire activity trend',
    params: { radiusKm: 100, recentDays: 7, referenceDays: 28 },
    asOf,
    status: 'INSUFFICIENT_HISTORY',
    observedValue: { kind: 'unavailable', reason: 'INSUFFICIENT_HISTORY' },
    reference: null,
    percentile: null,
    band: null,
    // A direction, not a distribution (ADR-040): there is no direction to state here either.
    trendBand: null,
    interpretation:
      'GeoNerva does not yet hold the five weeks of daily fire records this comparison needs, so it cannot say whether fire activity here is rising or falling.',
    caveats: [],
    methodVersion: 'bas-fire-1',
    evidenceIds: [],
  };
}

export function floodContext(asOf: string): BaselineMetricView {
  return {
    id: EV.basFlood,
    family: 'FLOODS',
    metricCode: 'GDACS_CONTEXT',
    label: 'GDACS flood events within 300 km',
    params: { radiusKm: 300, sinceYear: 2021 },
    asOf,
    status: 'RARE_ACTIVITY',
    observedValue: { kind: 'count', value: 1 },
    reference: null,
    percentile: null,
    band: null,
    trendBand: null,
    interpretation:
      "Rare here: 2 GDACS flood events within 300 km since 21 September 2021, when GeoNerva's GDACS record begins.",
    caveats: ['GDACS flood areas are modelled, not observed flood extents.'],
    methodVersion: 'bas-gdacs-1',
    evidenceIds: [EV.gdacsFlood],
  };
}

export function cycloneContext(asOf: string): BaselineMetricView {
  return {
    id: EV.basCyclone,
    family: 'CYCLONES',
    metricCode: 'GDACS_CONTEXT',
    label: 'GDACS tropical cyclone events within 300 km',
    params: { radiusKm: 300, sinceYear: 2021 },
    asOf,
    status: 'NOT_APPLICABLE',
    observedValue: { kind: 'unavailable', reason: 'NOT_APPLICABLE' },
    reference: null,
    percentile: null,
    band: null,
    trendBand: null,
    interpretation:
      'No GDACS tropical cyclone track has passed within 300 km of this location in the record, so there is no history to compare with.',
    caveats: [],
    methodVersion: 'bas-gdacs-1',
    evidenceIds: [],
  };
}

// ---------------------------------------------------------------------------------------------
// History responses.
// ---------------------------------------------------------------------------------------------

/** Weekly counts for the last 26 windows, oldest first; the final bucket is the current week. */
function weeklySeries(asOf: string): TimeSeriesPoint[] {
  const counts = [0, 1, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 2];
  return counts.map((value, index) => ({
    t: minutesBefore(asOf, (counts.length - index) * 7 * 24 * 60),
    value,
    missingReason: null,
  }));
}

/** Daily fire detections for 14 days, with two days the satellites did not cover. */
function dailyFireSeries(asOf: string, stale: boolean): TimeSeriesPoint[] {
  const counts: (number | null)[] = [0, 0, 1, 0, null, 0, 0, 0, 2, 0, null, 0, 6, 8];
  return counts.map((value, index) => {
    const lastDaysMissing = stale && index >= counts.length - 2;
    const missing = value === null || lastDaysMissing;
    return {
      t: minutesBefore(asOf, (counts.length - index) * 24 * 60),
      value: missing ? null : value,
      missingReason: lastDaysMissing
        ? 'NASA FIRMS has not delivered this day yet.'
        : value === null
          ? 'No satellite coverage that day (FIRMS missing_data).'
          : null,
    };
  });
}

export interface HistoryFixtureOptions {
  readonly family: HazardFamily;
  readonly metricCode?: string;
  readonly scenario?: FixtureScenario;
  readonly asOf: string;
  readonly isReplay?: boolean;
}

/** The history response for one family and metric, or `null` when the family offers none. */
export function historyFixture(options: HistoryFixtureOptions): HistoryResponse | null {
  const { asOf } = options;
  const scenario = options.scenario ?? 'all-fresh';
  const context = asOfContext(
    asOf,
    options.isReplay ?? false,
    scenario === 'firms-stale' ? { firms: 300 } : {},
  );
  const registry = evidenceRegistry(asOf);

  const common = {
    schemaVersion: SCHEMA_VERSION,
    location: MARRAKECH,
    family: options.family,
    asOfContext: context,
    largestRecent: null,
    sequenceContext: null,
    completenessStatement: null,
    caveats: [],
    evidenceManifest: [],
  } as const;

  let response: HistoryResponse;
  switch (options.family) {
    case 'EARTHQUAKES': {
      if (options.metricCode === 'EQ_COUNT_30D') {
        const metric = eqCount30d(asOf);
        response = {
          ...common,
          metricCode: metric.metricCode,
          metric,
          series: [],
          referenceBands: null,
          rarity: null,
          completenessStatement:
            'Counts include earthquakes of M3.1 and larger (the smallest size reliably recorded here).',
          methodologyHref: '/methodology#eq-count',
          attribution: attributionFor('usgs', 'emsc'),
        };
        break;
      }
      const metric = eqCount7d(asOf);
      const reference = metric.reference;
      if (reference === null) throw new Error('EQ_COUNT_7D fixture must carry its reference');
      response = {
        ...common,
        metricCode: metric.metricCode,
        metric,
        series: [
          {
            code: 'eq_count',
            label: 'Earthquakes of M3.1 or larger within 150 km',
            unit: null,
            bucketDays: 7,
            points: weeklySeries(asOf),
          },
        ],
        referenceBands: {
          windowDays: reference.windowDays,
          nWindows: reference.nWindows,
          nEvents: reference.nEvents,
          referenceFrom: reference.referenceFrom,
          referenceTo: reference.referenceTo,
          p25: reference.p25,
          median: reference.median,
          p75: reference.p75,
          p90: reference.p90,
          p95: reference.p95,
          mean: reference.mean,
          evidenceIds: [metric.id],
        },
        rarity: null,
        largestRecent: {
          value: { kind: 'number', value: 4.7, unit: null, decimals: 1 },
          observedAt: T.eqObserved,
          subjectPublicId: EQ_PUBLIC_ID,
          comparisonSince: '2024-03-02T04:11:00.000Z',
          text: 'The largest within 150 km since March 2024.',
          evidenceIds: [EV.usgsV2],
        },
        completenessStatement:
          'Counts include earthquakes of M3.1 and larger (the smallest size reliably recorded here).',
        caveats: [EARTHQUAKE_ELEVATED_CAVEAT],
        methodologyHref: '/methodology#eq-count',
        attribution: attributionFor('usgs', 'emsc'),
      };
      break;
    }
    case 'FIRE_ACTIVITY': {
      const metric = fireTrend(asOf, scenario);
      response = {
        ...common,
        metricCode: metric.metricCode,
        metric,
        series: [
          {
            code: 'fire_detections_daily',
            label: 'Thermal detections per day within 100 km',
            unit: null,
            bucketDays: 1,
            points: dailyFireSeries(asOf, scenario === 'firms-stale'),
          },
        ],
        referenceBands: null,
        rarity: null,
        caveats: [
          'Satellite thermal detections can include non-vegetation heat sources (e.g. gas flares, industrial sites, volcanoes). They are not confirmed wildfires.',
        ],
        methodologyHref: '/methodology#fire-trend',
        attribution: attributionFor('firms'),
      };
      break;
    }
    case 'FLOODS': {
      const metric = floodContext(asOf);
      response = {
        ...common,
        metricCode: metric.metricCode,
        metric,
        series: [],
        referenceBands: null,
        rarity: {
          nEvents: 2,
          sinceYear: 2021,
          radiusKm: 300,
          thresholdLabel: 'GDACS flood events',
          text: '2 GDACS flood events within 300 km since 2021.',
          evidenceIds: [EV.gdacsFlood],
        },
        caveats: metric.caveats,
        methodologyHref: '/methodology#gdacs-context',
        attribution: attributionFor('gdacs'),
      };
      break;
    }
    case 'CYCLONES': {
      const metric = cycloneContext(asOf);
      response = {
        ...common,
        metricCode: metric.metricCode,
        metric,
        series: [],
        referenceBands: null,
        rarity: null,
        methodologyHref: '/methodology#gdacs-context',
        attribution: attributionFor('gdacs'),
      };
      break;
    }
    case 'WEATHER_ALERTS':
    case 'OTHER':
      return null;
  }
  return { ...response, evidenceManifest: manifestFor(response, registry) };
}
