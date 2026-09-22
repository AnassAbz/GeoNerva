/**
 * The data-access seam between the pages and the read models.
 *
 * **P9a:** every function returns a validated mock from `lib/fixtures`.
 * **P9b:** these bodies are replaced by calls to `lib/server/services.ts` — server components
 * call the service layer in-process with request objects built by `lib/server/params.ts`, never
 * the HTTP API over loopback. The signatures here are what the pages depend on, so P9b changes
 * this file and nothing above it.
 *
 * Every function is async so that the swap does not change a single call site. `null` means
 * "no such subject" and becomes the route's not-found page.
 */

import type {
  ChangeWindow,
  EventDetail,
  FireClusterDetail,
  HazardFamily,
  HistoryResponse,
  LocationBriefing,
  MapFeaturesResponse,
  PlaceSuggestion,
  SourceStatus,
} from '@geonerva/domain';

import {
  EQ_PUBLIC_ID,
  FIRE_PUBLIC_ID,
  FIXTURE_NOW,
  FLOOD_PUBLIC_ID,
  MARRAKECH,
  PLACE_SUGGESTIONS,
  earthquakeDetail,
  fireClusterDetail,
  floodDetail,
  historyFixture,
  mapFeaturesFixture,
  marrakechBriefing,
  sourceStatusFixture,
  type FixtureScenario,
} from '../fixtures/index.ts';
import { FAMILY_ORDER } from './families.ts';
import { locationKeyFromSlug } from './routes.ts';

/**
 * P9a only: which fixture scenario to serve. Accepted from the `scenario` query parameter so
 * the outage presentation can be exercised end to end; P9b removes it (the seeded scenario
 * database takes its place, docs/TESTING.md §5).
 */
export type Scenario = FixtureScenario;

export function parseScenario(raw: string | string[] | undefined): Scenario {
  return raw === 'firms-stale' ? 'firms-stale' : 'all-fresh';
}

export interface BriefingQuery {
  readonly window: ChangeWindow;
  /** Present for a replay; validated ISO instant. */
  readonly asOf?: string;
  readonly scenario?: Scenario;
}

/** The wall clock the pages format relative times against. P9b: `new Date()` (or the fake). */
export function getNow(): Promise<string> {
  return Promise.resolve(FIXTURE_NOW);
}

export function getBriefing(slug: string, query: BriefingQuery): Promise<LocationBriefing | null> {
  if (locationKeyFromSlug(slug) !== MARRAKECH.key) return Promise.resolve(null);
  const options = {
    window: query.window,
    scenario: query.scenario ?? 'all-fresh',
    ...(query.asOf === undefined ? {} : { asOf: query.asOf }),
  };
  return Promise.resolve(marrakechBriefing(options));
}

export function getHistories(
  slug: string,
  query: Pick<BriefingQuery, 'asOf' | 'scenario'>,
): Promise<readonly HistoryResponse[]> {
  if (locationKeyFromSlug(slug) !== MARRAKECH.key) return Promise.resolve([]);
  const asOf = query.asOf ?? FIXTURE_NOW;
  const isReplay = query.asOf !== undefined;
  const scenario = query.scenario ?? 'all-fresh';
  const requests: { family: HazardFamily; metricCode?: string }[] = [
    ...FAMILY_ORDER.map((family) => ({ family })),
    { family: 'EARTHQUAKES', metricCode: 'EQ_COUNT_30D' },
  ];
  const histories = requests
    .map((request) => historyFixture({ ...request, scenario, asOf, isReplay }))
    .filter((history): history is HistoryResponse => history !== null);
  return Promise.resolve(histories);
}

export function getMapFeatures(
  slug: string,
  query: Pick<BriefingQuery, 'scenario'>,
): Promise<MapFeaturesResponse | null> {
  if (locationKeyFromSlug(slug) !== MARRAKECH.key) return Promise.resolve(null);
  return Promise.resolve(mapFeaturesFixture(query.scenario ?? 'all-fresh'));
}

export function getEventDetail(
  publicId: string,
  options: { readonly placeSlug?: string } = {},
): Promise<EventDetail | null> {
  const withPlace =
    options.placeSlug !== undefined && locationKeyFromSlug(options.placeSlug) === MARRAKECH.key;
  if (publicId === EQ_PUBLIC_ID) return Promise.resolve(earthquakeDetail({ withPlace }));
  if (publicId === FLOOD_PUBLIC_ID) return Promise.resolve(floodDetail({ withPlace }));
  return Promise.resolve(null);
}

export function getFireCluster(
  publicId: string,
  options: { readonly placeSlug?: string } = {},
): Promise<FireClusterDetail | null> {
  const withPlace =
    options.placeSlug !== undefined && locationKeyFromSlug(options.placeSlug) === MARRAKECH.key;
  if (publicId === FIRE_PUBLIC_ID) return Promise.resolve(fireClusterDetail({ withPlace }));
  return Promise.resolve(null);
}

export function getSourceStatus(scenario: Scenario = 'all-fresh'): Promise<SourceStatus> {
  return Promise.resolve(sourceStatusFixture(scenario));
}

/** Local type-ahead. P9b: the typed same-origin client for `/api/v1/places/suggest`. */
export function getPlaceSuggestions(): Promise<readonly PlaceSuggestion[]> {
  return Promise.resolve(PLACE_SUGGESTIONS);
}

/** Curated places for "Try: …" on the landing page (PRODUCT §6.1). */
export function getCuratedPlaces(): Promise<readonly { label: string; slug: string }[]> {
  return Promise.resolve([{ label: 'Marrakech', slug: 'marrakech-ma-2542997' }]);
}
