/** `SourceStatus` for the `/data-status` page, in the all-fresh and FIRMS-stale variants. */

import type {
  EvidenceItem,
  RunSummaryView,
  SourceHealthView,
  SourceProductView,
  SourceStatus,
  SourceStatusEntry,
} from '@geonerva/domain';

import {
  ATTRIBUTION,
  FIXTURE_NOW,
  PRODUCT,
  RUN,
  SCHEMA_VERSION,
  asOfContext,
  attributionFor,
  health,
  hex64,
  manifestFor,
  minutesBefore,
  type FixtureSourceId,
} from './common.ts';
import type { FixtureScenario } from './metrics.ts';
import { evidenceRegistry } from './world.ts';

function uuidFrom(seed: string): string {
  const h = hex64(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface RunPlan {
  readonly source: FixtureSourceId;
  readonly productId: number | null;
  readonly everyMinutes: number;
  readonly count: number;
  /** Indexes (0 = newest) of failed runs. */
  readonly failed?: readonly number[];
  readonly firstRunId?: string;
  readonly offsetMinutes: number;
  readonly received: number;
}

function runsFor(plan: RunPlan, asOf: string, extra: Map<string, EvidenceItem>): RunSummaryView[] {
  const runs: RunSummaryView[] = [];
  for (let index = 0; index < plan.count; index += 1) {
    const id =
      index === 0 && plan.firstRunId !== undefined
        ? plan.firstRunId
        : uuidFrom(`${plan.source}:${String(index)}`);
    const startedAt = minutesBefore(asOf, plan.offsetMinutes + index * plan.everyMinutes);
    const failed = plan.failed?.includes(index) ?? false;
    const committedAt = minutesBefore(startedAt, -1);
    const run: RunSummaryView = {
      id,
      productId: plan.productId,
      trigger: 'SCHEDULE',
      status: failed ? 'FAILED' : 'SUCCEEDED',
      startedAt,
      committedAt,
      durationMs: failed ? 30_000 : 4_200 + index * 37,
      counts: failed
        ? { received: 0, newRecords: 0, newVersions: 0, unchanged: 0, rejected: 0 }
        : {
            received: plan.received,
            newRecords: index % 4 === 0 ? 1 : 0,
            newVersions: index % 3 === 0 ? 1 : 0,
            unchanged: plan.received - 1,
            rejected: 0,
          },
      newestObservedAt: failed ? null : minutesBefore(startedAt, 35),
      errorClass: failed ? 'HTTP_5XX' : null,
      evidenceId: `EV:RUN:${id}`,
    };
    runs.push(run);
    if (!extra.has(run.evidenceId)) {
      extra.set(run.evidenceId, {
        id: run.evidenceId,
        kind: 'RUN',
        summary: `${plan.source.toUpperCase()} scheduled poll, ${failed ? 'failed (HTTP 5xx)' : 'succeeded'}.`,
        sourceId: plan.source,
        productId: plan.productId,
        observedAt: null,
        ingestedAt: committedAt,
        url: null,
        resolvable: true,
      });
    }
  }
  return runs;
}

function product(
  id: number,
  code: string,
  hazardTypes: SourceProductView['hazardTypes'],
  capabilities: SourceProductView['capabilities'],
  productHealth: SourceHealthView,
  sensor?: { platform: string; activeFrom: string },
): SourceProductView {
  return {
    id,
    code,
    hazardTypes,
    capabilities,
    platform: sensor?.platform ?? null,
    instrument: sensor === undefined ? null : 'VIIRS',
    resolutionM: sensor === undefined ? null : 375,
    status: 'ACTIVE',
    activeFrom: sensor?.activeFrom ?? null,
    activeTo: null,
    health: { ...productHealth, productId: id },
  };
}

export function sourceStatusFixture(scenario: FixtureScenario = 'all-fresh'): SourceStatus {
  const asOf = FIXTURE_NOW;
  const extra = new Map<string, EvidenceItem>();
  const stale = scenario === 'firms-stale';

  const usgsHealth = health({
    sourceId: 'usgs',
    status: 'FRESH',
    reasons: ['OK'],
    asOf,
    lastSuccessMinutesAgo: 4,
    newestObservedMinutesAgo: 79,
    runId: RUN.usgs,
  });
  const emscHealth = health({
    sourceId: 'emsc',
    status: 'FRESH',
    reasons: ['OK'],
    asOf,
    lastSuccessMinutesAgo: 5,
    newestObservedMinutesAgo: 41,
    runId: RUN.emsc,
  });
  const gdacsHealth = health({
    sourceId: 'gdacs',
    status: 'FRESH',
    reasons: ['OK'],
    asOf,
    lastSuccessMinutesAgo: 9,
    newestObservedMinutesAgo: 150,
    runId: RUN.gdacs,
  });
  const firmsHealth = stale
    ? health({
        sourceId: 'firms',
        status: 'STALE',
        reasons: ['POLL_STALE', 'LAST_POLL_FAILED'],
        asOf,
        lastSuccessMinutesAgo: 300,
        lastAttemptMinutesAgo: 22,
        newestObservedMinutesAgo: 11 * 60 + 10,
        consecutiveFailures: 9,
        lastErrorClass: 'HTTP_5XX',
        runId: RUN.firmsFailed,
      })
    : health({
        sourceId: 'firms',
        status: 'FRESH',
        reasons: ['OK'],
        asOf,
        lastSuccessMinutesAgo: 22,
        newestObservedMinutesAgo: 220,
        runId: RUN.firms,
      });
  const ecccHealth = health({
    sourceId: 'eccc',
    status: 'UNAVAILABLE',
    reasons: ['DISABLED'],
    asOf,
    lastSuccessMinutesAgo: null,
    newestObservedMinutesAgo: null,
    runId: null,
  });

  const usgsRuns = runsFor(
    {
      source: 'usgs',
      productId: PRODUCT.usgsComcat,
      everyMinutes: 5,
      count: 24,
      failed: [17],
      firstRunId: RUN.usgs,
      offsetMinutes: 5,
      received: 212,
    },
    asOf,
    extra,
  );
  const emscRuns = runsFor(
    {
      source: 'emsc',
      productId: PRODUCT.emscRts,
      everyMinutes: 5,
      count: 24,
      firstRunId: RUN.emsc,
      offsetMinutes: 6,
      received: 188,
    },
    asOf,
    extra,
  );
  const gdacsRuns = runsFor(
    {
      source: 'gdacs',
      productId: null,
      everyMinutes: 10,
      count: 24,
      firstRunId: RUN.gdacs,
      offsetMinutes: 10,
      received: 64,
    },
    asOf,
    extra,
  );
  const firmsRuns = runsFor(
    {
      source: 'firms',
      productId: PRODUCT.firmsNoaa21,
      everyMinutes: 30,
      count: 24,
      failed: stale ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : [],
      firstRunId: stale ? RUN.firmsFailed : RUN.firms,
      offsetMinutes: 23,
      received: 18_410,
    },
    asOf,
    extra,
  );

  const rate = (runs: readonly RunSummaryView[]) => {
    const recent = runs.filter(
      (run) =>
        run.committedAt !== null && Date.parse(run.committedAt) > Date.parse(asOf) - 86_400_000,
    );
    const ok = recent.filter((run) => run.status !== 'FAILED').length;
    return {
      runCount24h: recent.length,
      successRate24h: recent.length === 0 ? null : Math.round((ok / recent.length) * 1000) / 1000,
    };
  };

  const entry = (
    source: FixtureSourceId,
    rest: Omit<
      SourceStatusEntry,
      | 'sourceId'
      | 'name'
      | 'homepage'
      | 'licence'
      | 'attributionText'
      | 'termsUrl'
      | 'disclaimer'
      | 'runCount24h'
      | 'successRate24h'
    >,
  ): SourceStatusEntry => ({
    sourceId: source,
    name: ATTRIBUTION[source].name,
    homepage: ATTRIBUTION[source].homepage,
    licence: ATTRIBUTION[source].licence,
    attributionText: ATTRIBUTION[source].attributionText,
    termsUrl: ATTRIBUTION[source].termsUrl,
    disclaimer: ATTRIBUTION[source].disclaimer,
    ...rest,
    ...rate(rest.recentRuns),
  });

  const sources: SourceStatusEntry[] = [
    entry('usgs', {
      enabled: true,
      coverageNote:
        'Global, but completeness is only assured from about M4.5 outside the United States.',
      coverageGeometryAvailable: false,
      hazardTypes: ['EARTHQUAKE'],
      capabilities: ['REALTIME_EVENTS', 'HISTORICAL_EVENTS', 'EVENT_REVISIONS', 'DELETIONS'],
      health: usgsHealth,
      products: [
        product(
          PRODUCT.usgsComcat,
          'comcat',
          ['EARTHQUAKE'],
          ['REALTIME_EVENTS', 'EVENT_REVISIONS'],
          usgsHealth,
        ),
      ],
      recentRuns: usgsRuns,
    }),
    entry('emsc', {
      enabled: true,
      coverageNote:
        'Global, with a much denser network in Europe, the Mediterranean and North Africa than elsewhere.',
      coverageGeometryAvailable: false,
      hazardTypes: ['EARTHQUAKE'],
      capabilities: ['REALTIME_EVENTS', 'HISTORICAL_EVENTS', 'EVENT_REVISIONS'],
      health: emscHealth,
      products: [product(PRODUCT.emscRts, 'rts', ['EARTHQUAKE'], ['REALTIME_EVENTS'], emscHealth)],
      recentRuns: emscRuns,
    }),
    entry('gdacs', {
      enabled: true,
      coverageNote:
        'Global. Alert levels are modelled impact estimates, not measured hazard intensities.',
      coverageGeometryAvailable: false,
      hazardTypes: [
        'EARTHQUAKE',
        'FLOOD',
        'TROPICAL_CYCLONE',
        'WILDFIRE_EVENT',
        'VOLCANO',
        'DROUGHT',
      ],
      capabilities: ['REALTIME_EVENTS', 'POLYGONS', 'TRACKS', 'IMPACT_ALERT_LEVELS'],
      health: gdacsHealth,
      products: [
        product(PRODUCT.gdacsEq, 'EQ', ['EARTHQUAKE'], ['REALTIME_EVENTS'], gdacsHealth),
        product(PRODUCT.gdacsFl, 'FL', ['FLOOD'], ['REALTIME_EVENTS', 'POLYGONS'], gdacsHealth),
        product(
          PRODUCT.gdacsTc,
          'TC',
          ['TROPICAL_CYCLONE'],
          ['REALTIME_EVENTS', 'TRACKS', 'FORECAST_GEOMETRY'],
          gdacsHealth,
        ),
      ],
      recentRuns: gdacsRuns,
    }),
    entry('firms', {
      enabled: true,
      coverageNote:
        'Global. Near-real-time detections arrive about three hours after the satellite overpass, and a place is only seen a few times per day.',
      coverageGeometryAvailable: false,
      hazardTypes: ['THERMAL_ACTIVITY'],
      capabilities: ['POINT_DETECTIONS', 'REALTIME_EVENTS', 'HISTORICAL_EVENTS'],
      health: firmsHealth,
      products: [
        product(
          PRODUCT.firmsNoaa20,
          'VIIRS_NOAA20_NRT',
          ['THERMAL_ACTIVITY'],
          ['POINT_DETECTIONS'],
          firmsHealth,
          { platform: 'NOAA-20', activeFrom: '2018-01-01' },
        ),
        product(
          PRODUCT.firmsNoaa21,
          'VIIRS_NOAA21_NRT',
          ['THERMAL_ACTIVITY'],
          ['POINT_DETECTIONS'],
          firmsHealth,
          { platform: 'NOAA-21', activeFrom: '2023-01-01' },
        ),
      ],
      recentRuns: firmsRuns,
    }),
    entry('eccc', {
      enabled: false,
      coverageNote:
        'Canada only, and weather alerts only. Other regions are not covered by GeoNerva yet.',
      coverageGeometryAvailable: true,
      hazardTypes: ['WEATHER_ALERT'],
      capabilities: ['OFFICIAL_WARNINGS', 'POLYGONS'],
      health: ecccHealth,
      products: [],
      recentRuns: [],
    }),
  ];

  const status: SourceStatus = {
    schemaVersion: SCHEMA_VERSION,
    asOfContext: asOfContext(asOf, false, stale ? { firms: 300 } : {}),
    generatedAt: asOf,
    sources,
    worker: { lastSeenAt: minutesBefore(asOf, 1), version: '0.9.0', isStale: false },
    dataQuality: [
      {
        code: 'FUTURE_OBSERVATIONS',
        label: 'Observations dated in the future',
        status: 'OK',
        value: 0,
        threshold: 0,
        detail: null,
        checkedAt: minutesBefore(asOf, 4),
      },
      {
        code: 'FIRMS_EMPTY_BATCHES',
        label: 'Suspiciously empty FIRMS batches (24 h)',
        status: stale ? 'WARN' : 'OK',
        value: stale ? 9 : 0,
        threshold: 3,
        detail: stale ? 'Nine consecutive polls failed with an HTTP 5xx from the provider.' : null,
        checkedAt: minutesBefore(asOf, 22),
      },
    ],
    evidenceManifest: [],
    attribution: attributionFor('usgs', 'emsc', 'gdacs', 'firms', 'eccc'),
  };
  const registry = new Map([...evidenceRegistry(asOf), ...extra]);
  return { ...status, evidenceManifest: manifestFor(status, registry) };
}
