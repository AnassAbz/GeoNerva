/**
 * The Marrakech `LocationBriefing`, in the variants the pages and tests need:
 *
 *  - `all-fresh` — every P0 source fresh; an M4.7 earthquake (moderate relevance), a fire activity
 *    cluster and a GDACS flood event nearby; weather warnings not covered.
 *  - `firms-stale` — NASA FIRMS has failed for five hours: the fire card is UNAVAILABLE, carries
 *    no items and no count, and the headline says so.
 *  - a replay at an earlier `asOf`, which hides everything GeoNerva learned later.
 */

import type {
  ChangeSection,
  ChangeSignalView,
  ChangeWindow,
  FamilyCard,
  HazardFamily,
  LocationBriefing,
  SnapshotOverall,
  SourceHealthView,
  SubjectSummary,
} from '@geonerva/domain';

import {
  FIXTURE_NOW,
  MARRAKECH,
  PRODUCT,
  RUN,
  SCHEMA_VERSION,
  asOfContext,
  attributionFor,
  health,
  hex64,
  manifestFor,
  minutesBefore,
} from './common.ts';
import {
  EARTHQUAKE_ELEVATED_CAVEAT,
  cycloneContext,
  eqCount7d,
  fireTrend,
  floodContext,
  type FixtureScenario,
} from './metrics.ts';
import {
  EQ_SUMMARY,
  EV,
  FIRE_SUMMARY,
  FLOOD_SUMMARY,
  OLDER_EQ_SUMMARY,
  T,
  THERMAL_CAVEAT,
  evidenceRegistry,
} from './world.ts';

export const ENGINE_VERSION = 'geonerva-1';

export interface BriefingFixtureOptions {
  readonly window?: ChangeWindow;
  readonly scenario?: FixtureScenario;
  /** A knowledge time in the past makes the briefing a replay. Defaults to the fixture clock. */
  readonly asOf?: string;
}

const WINDOW_MINUTES: Readonly<Record<ChangeWindow, number>> = {
  '6h': 6 * 60,
  '24h': 24 * 60,
  '7d': 7 * 24 * 60,
  since: 3 * 24 * 60,
};

const known = (asOf: string, ingestedAt: string): boolean =>
  Date.parse(ingestedAt) <= Date.parse(asOf);

function sourceHealthAt(asOf: string, scenario: FixtureScenario) {
  const firms: SourceHealthView =
    scenario === 'firms-stale'
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
  return {
    usgs: health({
      sourceId: 'usgs',
      status: 'FRESH',
      reasons: ['OK'],
      asOf,
      lastSuccessMinutesAgo: 4,
      newestObservedMinutesAgo: 79,
      runId: RUN.usgs,
    }),
    emsc: health({
      sourceId: 'emsc',
      status: 'FRESH',
      reasons: ['OK'],
      asOf,
      lastSuccessMinutesAgo: 5,
      newestObservedMinutesAgo: 41,
      runId: RUN.emsc,
    }),
    gdacs: health({
      sourceId: 'gdacs',
      status: 'FRESH',
      reasons: ['OK'],
      asOf,
      lastSuccessMinutesAgo: 9,
      newestObservedMinutesAgo: 150,
      runId: RUN.gdacs,
    }),
    gdacsEq: health({
      sourceId: 'gdacs',
      productId: PRODUCT.gdacsEq,
      status: 'FRESH',
      reasons: ['OK'],
      asOf,
      lastSuccessMinutesAgo: 9,
      newestObservedMinutesAgo: 46,
      runId: RUN.gdacs,
    }),
    firms,
    eccc: health({
      sourceId: 'eccc',
      status: 'UNAVAILABLE',
      reasons: ['DISABLED'],
      asOf,
      lastSuccessMinutesAgo: null,
      newestObservedMinutesAgo: null,
      runId: null,
    }),
  };
}

function signal(
  partial: Omit<
    ChangeSignalView,
    | 'fromAsOf'
    | 'toAsOf'
    | 'engineVersion'
    | 'suppressionReason'
    | 'lateReport'
    | 'facets'
    | 'metricCode'
  > &
    Partial<Pick<ChangeSignalView, 'suppressionReason' | 'lateReport' | 'facets' | 'metricCode'>>,
  fromAsOf: string,
  toAsOf: string,
): ChangeSignalView {
  return {
    metricCode: null,
    suppressionReason: null,
    lateReport: false,
    facets: [],
    ...partial,
    fromAsOf,
    toAsOf,
    engineVersion: ENGINE_VERSION,
  };
}

function changesFor(
  window: ChangeWindow,
  asOf: string,
  scenario: FixtureScenario,
  present: { eq: boolean; fire: boolean },
): ChangeSection {
  const fromAsOf = minutesBefore(asOf, WINDOW_MINUTES[window]);
  const inWindow = (at: string): boolean =>
    Date.parse(at) > Date.parse(fromAsOf) && Date.parse(at) <= Date.parse(asOf);
  const s = (partial: Parameters<typeof signal>[0]) => signal(partial, fromAsOf, asOf);

  const headline: ChangeSignalView[] = [];
  const listed: ChangeSignalView[] = [];

  if (present.eq && inWindow(T.usgsV1Ingested)) {
    headline.push(
      s({
        id: EV.chgEqNew,
        type: 'NEW_EVENT',
        family: 'EARTHQUAKES',
        subjectRef: EQ_SUMMARY.subjectRef,
        title: 'New M4.7 earthquake 142 km east of Marrakech',
        detail:
          'Reported by USGS and EMSC. USGS later revised its magnitude from mb 4.6 to Mww 4.7.',
        before: null,
        after: { kind: 'number', value: 4.7, unit: null, decimals: 1 },
        importance: 78,
        prominence: 'HEADLINE',
        facets: [
          {
            type: 'EVENT_UPDATED',
            label: 'Magnitude revised by USGS',
            before: { kind: 'number', value: 4.6, unit: null, decimals: 1 },
            after: { kind: 'number', value: 4.7, unit: null, decimals: 1 },
          },
        ],
        reasonCodes: ['NEW_EVENT', 'RELEVANCE_MODERATE'],
        evidenceIds: [EV.usgsV1, EV.usgsV2, EV.emscV1, EV.relEq],
      }),
    );
  }

  if (scenario === 'firms-stale') {
    listed.push(
      s({
        id: EV.chgFirmsStale,
        type: 'SOURCE_STALE',
        family: 'FIRE_ACTIVITY',
        subjectRef: 'SRC:firms',
        title: 'NASA FIRMS stopped delivering fire activity data',
        detail: 'The last successful poll was 5 hours ago; fire activity cannot be described here.',
        before: null,
        after: null,
        importance: 64,
        prominence: 'LISTED',
        reasonCodes: ['SOURCE_STALE'],
        evidenceIds: [EV.runFirmsFailed],
      }),
    );
  } else if (present.fire && inWindow(T.fcv3)) {
    listed.push(
      s({
        id: EV.chgFireGrew,
        type: 'ACTIVITY_INCREASE',
        family: 'FIRE_ACTIVITY',
        subjectRef: FIRE_SUMMARY.subjectRef,
        title: 'Fire activity cluster 39 km south-west grew from 9 to 14 detections',
        detail: 'Satellite thermal detections from a third overpass.',
        before: { kind: 'count', value: 9 },
        after: { kind: 'count', value: 14 },
        importance: 41,
        prominence: 'LISTED',
        reasonCodes: ['ACTIVITY_INCREASE'],
        evidenceIds: [EV.fcv2, EV.fcv3],
      }),
    );
  }

  if (inWindow(T.floodUpdated)) {
    listed.push(
      s({
        id: EV.chgFloodUpdated,
        type: 'EVENT_UPDATED',
        family: 'FLOODS',
        subjectRef: FLOOD_SUMMARY.subjectRef,
        title: 'GDACS updated the flood event in Souss-Massa (episode 3)',
        detail: 'The alert level stays Green.',
        before: null,
        after: null,
        importance: 32,
        prominence: 'LISTED',
        reasonCodes: ['EVENT_UPDATED'],
        evidenceIds: [EV.gdacsFlood],
      }),
    );
  }

  if (inWindow(T.olderEqIngested)) {
    listed.push(
      s({
        id: EV.chgEqOlder,
        type: 'NEW_EVENT',
        family: 'EARTHQUAKES',
        subjectRef: OLDER_EQ_SUMMARY.subjectRef,
        title: 'New M3.4 earthquake 96 km south-west of Marrakech',
        detail: null,
        before: null,
        after: { kind: 'number', value: 3.4, unit: null, decimals: 1 },
        importance: 30,
        prominence: 'LISTED',
        reasonCodes: ['NEW_EVENT'],
        evidenceIds: [EV.usgsOlder],
      }),
    );
  }

  const suppressed: ChangeSignalView[] = [
    s({
      id: EV.chgEqSmall,
      type: 'NEW_EVENT',
      family: 'EARTHQUAKES',
      subjectRef: null,
      title: 'New M2.8 earthquake 118 km south',
      detail: null,
      before: null,
      after: { kind: 'number', value: 2.8, unit: null, decimals: 1 },
      importance: 6,
      prominence: 'SUPPRESSED',
      suppressionReason: 'IMMATERIAL',
      reasonCodes: ['BELOW_COMPLETENESS'],
      evidenceIds: [],
    }),
    s({
      id: EV.chgEqFar,
      type: 'NEW_EVENT',
      family: 'EARTHQUAKES',
      subjectRef: null,
      title: 'New M3.9 earthquake 1,210 km north-east',
      detail: null,
      before: null,
      after: { kind: 'number', value: 3.9, unit: null, decimals: 1 },
      importance: 4,
      prominence: 'SUPPRESSED',
      suppressionReason: 'LOW_RELEVANCE_BOTH',
      reasonCodes: ['LOW_RELEVANCE'],
      evidenceIds: [],
    }),
    s({
      id: EV.chgFireFlare,
      type: 'NEW_EVENT',
      family: 'FIRE_ACTIVITY',
      subjectRef: null,
      title: '1 thermal detection at a known industrial site 64 km north',
      detail: null,
      before: null,
      after: { kind: 'count', value: 1 },
      importance: 3,
      prominence: 'SUPPRESSED',
      suppressionReason: 'IMMATERIAL',
      reasonCodes: ['SINGLE_DETECTION'],
      evidenceIds: [],
    }),
  ];

  return {
    window,
    fromAsOf,
    toAsOf: asOf,
    headline,
    listed,
    detail: [],
    suppressed,
    suppressedCount: suppressed.length,
    emptyStatement:
      headline.length === 0 && listed.length === 0
        ? `Nothing meaningful changed ${windowWords(window)}.`
        : null,
  };
}

function windowWords(window: ChangeWindow): string {
  switch (window) {
    case '6h':
      return 'in the last 6 hours';
    case '24h':
      return 'in the last 24 hours';
    case '7d':
      return 'in the last 7 days';
    case 'since':
      return 'since your last visit';
  }
}

export function marrakechBriefing(options: BriefingFixtureOptions = {}): LocationBriefing {
  const window = options.window ?? '24h';
  const scenario = options.scenario ?? 'all-fresh';
  const asOf = options.asOf ?? FIXTURE_NOW;
  const isReplay = Date.parse(asOf) < Date.parse(FIXTURE_NOW) - 5 * 60_000;
  const hs = sourceHealthAt(asOf, scenario);

  const present = {
    eq: known(asOf, T.usgsV2Ingested),
    olderEq: known(asOf, T.olderEqIngested),
    fire: known(asOf, T.fcv3) && scenario === 'all-fresh',
    flood: known(asOf, T.floodIngested),
  };

  const eqItems: SubjectSummary[] = [
    ...(present.eq ? [EQ_SUMMARY] : []),
    ...(present.olderEq ? [OLDER_EQ_SUMMARY] : []),
  ];

  const families: Record<HazardFamily, FamilyCard> = {
    EARTHQUAKES: {
      family: 'EARTHQUAKES',
      availability: 'AVAILABLE',
      coverage: { level: 'COVERED', note: null },
      items: eqItems,
      truncated: false,
      itemsTotal: eqItems.length,
      metrics: [eqCount7d(asOf)],
      dataConfidence: {
        level: 'MEDIUM',
        reasons: [
          {
            code: 'COMPLETENESS_THRESHOLD',
            text: 'Earthquake records here are complete from about M3.1; smaller earthquakes may be missing.',
            params: { minMagnitude: 3.1 },
            evidenceIds: [EV.basEq7],
          },
        ],
      },
      sourceHealth: [hs.usgs, hs.emsc, hs.gdacsEq],
      caveats: [],
    },
    FIRE_ACTIVITY:
      scenario === 'firms-stale'
        ? {
            family: 'FIRE_ACTIVITY',
            availability: 'UNAVAILABLE',
            coverage: { level: 'COVERED', note: null },
            items: [],
            truncated: false,
            itemsTotal: 0,
            metrics: [fireTrend(asOf, scenario)],
            dataConfidence: {
              level: 'LOW',
              reasons: [
                {
                  code: 'SOURCE_STALE',
                  text: 'NASA FIRMS has not delivered successfully for 5 hours (expected within 3 hours), so the absence of thermal detections cannot be confirmed.',
                  params: { sourceId: 'firms', hoursSinceSuccess: 5, expectedHours: 3 },
                  evidenceIds: [EV.runFirmsFailed],
                },
              ],
            },
            sourceHealth: [hs.firms],
            caveats: [THERMAL_CAVEAT],
          }
        : {
            family: 'FIRE_ACTIVITY',
            availability: 'AVAILABLE',
            coverage: { level: 'COVERED', note: null },
            items: present.fire ? [FIRE_SUMMARY] : [],
            truncated: false,
            itemsTotal: present.fire ? 1 : 0,
            metrics: [fireTrend(asOf, scenario)],
            dataConfidence: {
              level: 'MEDIUM',
              reasons: [
                {
                  code: 'OVERPASS_SAMPLING',
                  text: 'Satellites see this area a few times a day, and detections arrive about three hours after each overpass.',
                  params: { overpassesPerDay: 4 },
                  evidenceIds: [],
                },
              ],
            },
            sourceHealth: [hs.firms],
            caveats: [THERMAL_CAVEAT],
          },
    FLOODS: {
      family: 'FLOODS',
      availability: 'AVAILABLE',
      coverage: { level: 'COVERED', note: null },
      items: present.flood ? [FLOOD_SUMMARY] : [],
      truncated: false,
      itemsTotal: present.flood ? 1 : 0,
      metrics: [floodContext(asOf)],
      dataConfidence: {
        level: 'MEDIUM',
        reasons: [
          {
            code: 'MODELLED_AREAS',
            text: 'GDACS flood areas are modelled from rainfall and river data, not observed.',
            params: {},
            evidenceIds: [],
          },
        ],
      },
      sourceHealth: [hs.gdacs],
      caveats: ['GDACS flood areas are modelled, not observed flood extents.'],
    },
    CYCLONES: {
      family: 'CYCLONES',
      availability: 'AVAILABLE',
      coverage: { level: 'COVERED', note: null },
      items: [],
      truncated: false,
      itemsTotal: 0,
      metrics: [cycloneContext(asOf)],
      dataConfidence: { level: 'HIGH', reasons: [] },
      sourceHealth: [hs.gdacs],
      caveats: [],
    },
    WEATHER_ALERTS: {
      family: 'WEATHER_ALERTS',
      availability: 'NOT_COVERED',
      coverage: {
        level: 'NOT_COVERED',
        note: 'GeoNerva has no weather-warning source for Morocco. Weather warnings are planned for Canada first, then the United States.',
      },
      items: [],
      truncated: false,
      itemsTotal: 0,
      metrics: [],
      dataConfidence: {
        level: 'LOW',
        reasons: [
          {
            code: 'NOT_COVERED',
            text: 'No weather-warning source covers this location.',
            params: {},
            evidenceIds: [],
          },
        ],
      },
      sourceHealth: [hs.eccc],
      caveats: [],
    },
    OTHER: {
      family: 'OTHER',
      availability: 'AVAILABLE',
      coverage: { level: 'COVERED', note: null },
      items: [],
      truncated: false,
      itemsTotal: 0,
      metrics: [],
      dataConfidence: { level: 'HIGH', reasons: [] },
      sourceHealth: [hs.gdacs],
      caveats: [],
    },
  };

  const overall: SnapshotOverall =
    scenario === 'firms-stale'
      ? {
          headlineCode: 'DATA_UNAVAILABLE',
          headlineRelevance: present.eq ? 'MODERATE' : 'LOW',
          headlineText: 'GeoNerva cannot currently report on fire activity here.',
          coverageStatement: 'Not covered here: weather warnings.',
          unavailableFamilies: ['FIRE_ACTIVITY'],
          notCoveredFamilies: ['WEATHER_ALERTS'],
          reasons: families.FIRE_ACTIVITY.dataConfidence.reasons,
          evidenceIds: present.eq ? EQ_SUMMARY.evidenceIds : [],
        }
      : {
          headlineCode: 'NO_HIGH_RELEVANCE_ITEMS',
          headlineRelevance: present.eq ? 'MODERATE' : 'LOW',
          headlineText: 'Nothing here currently needs your attention.',
          coverageStatement: 'Not covered here: weather warnings.',
          unavailableFamilies: [],
          notCoveredFamilies: ['WEATHER_ALERTS'],
          reasons: [],
          evidenceIds: present.eq ? EQ_SUMMARY.evidenceIds : [],
        };

  const changes = changesFor(window, asOf, scenario, present);
  const place = MARRAKECH.label;
  const firstChange = changes.headline[0] ?? changes.listed[0];
  const otherChanges = changes.headline.length + changes.listed.length - 1;

  const summary: string[] = [];
  if (scenario === 'firms-stale') {
    summary.push(
      'GeoNerva cannot describe fire activity here at the moment, so treat the absence of that as unknown rather than as quiet.',
    );
  }
  const tracked = (['EARTHQUAKES', 'FIRE_ACTIVITY', 'FLOODS'] as const)
    .filter((family) => families[family].items.length > 0)
    .map((family) => {
      const count = families[family].itemsTotal;
      const words =
        family === 'EARTHQUAKES'
          ? 'earthquakes'
          : family === 'FIRE_ACTIVITY'
            ? 'fire activity'
            : 'floods';
      return `${String(count)} ${words} item${count === 1 ? '' : 's'}`;
    });
  if (tracked.length > 0) {
    summary.push(
      `GeoNerva is currently tracking ${tracked.slice(0, -1).join(', ')}${tracked.length > 1 ? ' and ' : ''}${tracked.at(-1) ?? ''} near this location.`,
    );
  }
  summary.push(
    'Weather warnings is not covered here, so GeoNerva would not have seen it either way.',
  );
  summary.push(
    firstChange === undefined
      ? `Nothing meaningful changed ${windowWords(window)}; ${String(changes.suppressedCount)} minor changes were filtered out.`
      : otherChanges <= 0
        ? `${firstChange.title} ${windowWords(window)}.`
        : `${firstChange.title}, and ${String(otherChanges)} other change${otherChanges === 1 ? '' : 's'} ${windowWords(window)}.`,
  );

  const byFamily: Record<HazardFamily, string[]> = {
    EARTHQUAKES:
      eqItems[0] === undefined
        ? ['No earthquakes to report here.']
        : [
            `${eqItems[0].title}, about ${eqItems[0].distanceKm.toFixed(0)} km away.`,
            ...(eqItems.length > 1
              ? [`${String(eqItems.length)} earthquakes items in total.`]
              : []),
          ],
    FIRE_ACTIVITY:
      scenario === 'firms-stale'
        ? [families.FIRE_ACTIVITY.dataConfidence.reasons[0]?.text ?? '']
        : present.fire
          ? [`${FIRE_SUMMARY.title}, about 39 km away.`, THERMAL_CAVEAT]
          : ['No fire activity to report here.', THERMAL_CAVEAT],
    FLOODS: present.flood
      ? [
          `${FLOOD_SUMMARY.title}, about 171 km away.`,
          'GDACS flood areas are modelled, not observed flood extents.',
        ]
      : ['No floods to report here.'],
    CYCLONES: ['No tropical cyclones to report here.'],
    WEATHER_ALERTS: [families.WEATHER_ALERTS.coverage.note ?? ''],
    OTHER: ['No volcanoes and droughts to report here.'],
  };

  const headlineCopy =
    scenario === 'firms-stale'
      ? `GeoNerva cannot currently report on fire activity near ${place}.`
      : `Nothing GeoNerva is tracking near ${place} currently needs your attention.`;

  const snapshotSha = hex64(`snapshot:${scenario}:${asOf}`);
  const briefing: LocationBriefing = {
    schemaVersion: SCHEMA_VERSION,
    location: MARRAKECH,
    window,
    generatedAt: isReplay ? FIXTURE_NOW : asOf,
    asOfContext: asOfContext(asOf, isReplay, scenario === 'firms-stale' ? { firms: 300 } : {}),
    engineVersion: ENGINE_VERSION,
    snapshot: {
      asOf,
      engineVersion: ENGINE_VERSION,
      generatedAt: isReplay ? FIXTURE_NOW : asOf,
      sourceHealth: [hs.usgs, hs.emsc, hs.gdacs, hs.firms, hs.eccc],
      families,
      overall,
      contentSha256: snapshotSha,
    },
    changes,
    copy: {
      headline: headlineCopy,
      summary,
      byFamily,
      caveats: [
        'GDACS flood areas are modelled, not observed flood extents.',
        ...(present.eq ? [EARTHQUAKE_ELEVATED_CAVEAT] : []),
        THERMAL_CAVEAT,
      ],
      templateVersion: 'tpl-1',
    },
    ai: null,
    evidenceManifest: [],
    attribution: attributionFor('usgs', 'emsc', 'gdacs', 'firms'),
    contentSha256: snapshotSha,
  };
  return { ...briefing, evidenceManifest: manifestFor(briefing, evidenceRegistry(asOf)) };
}
