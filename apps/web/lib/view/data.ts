/**
 * The data-access seam between the pages and the read models.
 *
 * **P9a:** every function returned a validated mock from `lib/fixtures`.
 * **P9b (this file):** the bodies call `lib/server/services.ts` — server components call the
 * service layer **in process** with request objects built by `lib/server/params.ts`, never the
 * HTTP API over loopback. The signatures here are what the pages depend on, so P9b changes this
 * file and nothing above it.
 *
 * ### Why the requests go through `params.ts` rather than being constructed by hand
 *
 * `services.ts` says it in its own header: a capability reachable two ways is a capability that
 * drifts, and the thing that keeps the two paths honest is that a request object is only
 * constructible from the parser. So every function below assembles a `URLSearchParams` and hands
 * it to the same `parseLocation` / `parseWindow` / `parseAsOf` / `parseHistory` / `parseViewport`
 * / `parsePublicId` the route handlers use. A page and the API therefore cannot disagree about
 * whether a coordinate is rounded, whether an `as_of` is in the future, or whether a viewport is
 * on the grid — not by agreement, but because there is one implementation.
 *
 * ### `null` means "no such subject"
 *
 * A page turns it into `notFound()`. A refusal the *service* raises — `LOCATION_NOT_FOUND`,
 * `NOT_FOUND`, or a `VALIDATION_FAILED` from a slug or public id that is not the shape GeoNerva
 * mints — is that, and becomes `null` here. Everything else (`AS_OF_BEFORE_HORIZON`, a database
 * failure) propagates, because a page that rendered "not found" for a retention limit would be
 * telling the reader the subject does not exist.
 *
 * ### Three places where this seam is not simply the HTTP route
 *
 *  1. **`/history` has no `as_of`** (§13.1), so `HistoryRequest` carries only `now`, which
 *     `buildHistory` uses as its knowledge time. During a replay the page therefore asks for the
 *     history *as of the replayed instant* by passing that instant as the request's clock. The
 *     alternative — charts built from the present under a banner that says later information is
 *     hidden — is the replay leak the banner exists to prevent. Reported: the frozen endpoint has
 *     no parameter for this, so an HTTP client cannot ask the same question.
 *  2. **A fire cluster gets a location here and not over HTTP.** §13.1 gives
 *     `/fire-clusters/{publicId}` no location parameter, for cache-key reasons; the service accepts
 *     one and `FireClusterDetail` carries relevance and distance. The page came from a place, so it
 *     passes it. This is the in-process seam being used for what it is for.
 *  3. **The map's viewport is derived, not requested.** A viewport is a map concept and the page
 *     has none until it knows where the location is, so `getMapFeatures` takes the resolved
 *     `LocationRef` the briefing already carries and snaps a box around it to the zoom's grid with
 *     the same `quantizeViewport` a client would have to use.
 */

import { quantizationStepDegrees, quantizeViewport } from '@geonerva/db/viewport';
import {
  tryParseEvidenceId,
  type BoundingBox,
  type ChangeWindow,
  type EventDetail,
  type EvidenceDetail,
  type FireClusterDetail,
  type HazardFamily,
  type HistoryResponse,
  type LocationBriefing,
  type LocationRef,
  type MapFeaturesResponse,
  type PlaceSuggestion,
  type SourceStatus,
} from '@geonerva/domain';
import { metricsFor } from '@geonerva/briefing';
import { permanentRedirect } from 'next/navigation';

import { serverNow } from '../server/config.ts';
import { database } from '../server/db.ts';
import {
  parseAsOf,
  parseFamilies,
  parseHistory,
  parseLocation,
  parsePublicId,
  parseViewport,
  parseWindow,
} from '../server/params.ts';
import { ApiProblemError } from '../server/problem.ts';
import { getPlaceSuggestions as suggestPlacesService } from '../server/places.ts';
import * as services from '../server/services.ts';
import { FAMILY_ORDER, MAPPED_FAMILIES } from './families.ts';
import { locationKeyFromSlug } from './routes.ts';

export interface BriefingQuery {
  readonly window: ChangeWindow;
  /** Present for a replay; validated ISO instant. */
  readonly asOf?: string;
}

/** The wall clock the pages format relative times against — the process's one clock. */
export function getNow(): Promise<string> {
  return Promise.resolve(serverNow().toISOString());
}

export async function getBriefing(
  slug: string,
  query: BriefingQuery,
): Promise<LocationBriefing | null> {
  const search = locationSearch(slug);
  if (search === null) return null;
  search.set('window', query.window);
  if (query.asOf !== undefined) search.set('as_of', query.asOf);

  const now = serverNow();
  try {
    const result = await services.getBriefing(database().db, {
      location: parseLocation(search),
      window: parseWindow(search),
      asOf: parseAsOf(search, now),
      now,
    });
    return result.briefing;
  } catch (error) {
    return absentOrRethrow(error);
  }
}

/**
 * Every chart the dashboard shows: one per family that has a historical metric, plus the
 * earthquake 30-day count beside the 7-day one.
 *
 * A family with no metric is skipped rather than requested — `parseHistory` refuses one, correctly,
 * and asking it anyway would turn "weather alerts have no baseline yet" into a validation error.
 * The metric list comes from `metricsFor`, which is the same function the parser validates against.
 */
export async function getHistories(
  slug: string,
  query: Pick<BriefingQuery, 'asOf'>,
): Promise<readonly HistoryResponse[]> {
  const base = locationSearch(slug);
  if (base === null) return [];

  /* The replay's knowledge time, or the present. See note 1 in the header. */
  const now =
    query.asOf === undefined ? serverNow() : parseAsOf(asOfSearch(query.asOf), serverNow());

  const requests: { family: HazardFamily; metric?: string }[] = [];
  for (const family of FAMILY_ORDER) {
    if (metricsFor(family).length > 0) requests.push({ family });
  }
  requests.push({ family: 'EARTHQUAKES', metric: 'EQ_COUNT_30D' });

  const histories = await Promise.all(
    requests.map(async (request) => {
      const search = new URLSearchParams(base);
      search.set('family', request.family);
      if (request.metric !== undefined) search.set('metric', request.metric);
      try {
        return await services.getHistory(database().db, {
          location: parseLocation(search),
          history: parseHistory(search),
          now,
        });
      } catch (error) {
        return absentOrRethrow(error);
      }
    }),
  );
  return histories.filter((history): history is HistoryResponse => history !== null);
}

/**
 * Map features for the box around a location.
 *
 * The location is the one the briefing resolved, not the slug, because a viewport needs
 * coordinates and only the `places` table has them for a named place. That is why this is the one
 * call the dashboard makes *after* the briefing rather than beside it.
 */
export async function getMapFeatures(
  location: LocationRef,
  query: Pick<BriefingQuery, 'asOf'> = {},
): Promise<MapFeaturesResponse | null> {
  const search = viewportSearch(location);
  if (query.asOf !== undefined) search.set('as_of', query.asOf);

  const now = serverNow();
  try {
    return await services.getEvents(database().db, {
      viewport: parseViewport(search),
      families: parseFamilies(search),
      asOf: parseAsOf(search, now),
      now,
    });
  } catch (error) {
    return absentOrRethrow(error);
  }
}

export async function getEventDetail(
  publicId: string,
  options: { readonly placeSlug?: string } = {},
): Promise<EventDetail | null> {
  const outcome = await detailOutcome(publicId, 'canonical_event', options, (request) =>
    services.getEventDetail(database().db, request),
  );
  if (outcome === null) return null;
  if (outcome.kind === 'redirect') {
    permanentRedirect(`/event/${encodeURIComponent(outcome.publicId)}${placeQuery(options)}`);
  }
  return outcome.detail;
}

export async function getFireCluster(
  publicId: string,
  options: { readonly placeSlug?: string } = {},
): Promise<FireClusterDetail | null> {
  const outcome = await detailOutcome(publicId, 'fire_cluster', options, (request) =>
    services.getFireClusterDetail(database().db, request),
  );
  if (outcome === null) return null;
  if (outcome.kind === 'redirect') {
    permanentRedirect(`/fire/${encodeURIComponent(outcome.publicId)}${placeQuery(options)}`);
  }
  return outcome.detail;
}

export async function getSourceStatus(): Promise<SourceStatus> {
  const now = serverNow();
  return await services.getSourceStatus(database().db, { asOf: now, now });
}

/**
 * How many cited observations a page resolves the raw-record metadata for, eagerly.
 *
 * **A bound, stated rather than discovered.** The drawer's "Raw record" section (ADR-038) exists
 * only for `OBS` evidence — `components/evidence.tsx` renders it for that kind and no other — and
 * each id costs three reads. A briefing's manifest is not bounded by anything a page controls, so
 * resolving every citation would make a dashboard's query count a function of how much happened
 * near the reader. Twelve covers every observation the Marrakech scenario cites and is small enough
 * that the cost is a constant.
 *
 * What a reader loses past the bound is the "Raw record" paragraph on the thirteenth observation;
 * the citation itself, its summary, its times and its provider link all come from the manifest the
 * response already carried, so nothing disappears and nothing is silently approximated.
 */
export const EVIDENCE_DETAIL_LIMIT = 12;

/**
 * Resolved evidence for whichever of `ids` are observations, over the same service
 * `/api/v1/evidence/{id}` uses.
 *
 * Failures are dropped rather than raised: `getEvidence` answers `NOT_FOUND` for a content-
 * addressed kind and for anything retention has dropped, and a missing footnote must not take a
 * page down with it — the same trade `getBriefing` makes with `strictManifest: false`.
 */
export async function getEvidenceDetails(
  ids: readonly string[],
  options: { readonly asOf?: string } = {},
): Promise<readonly EvidenceDetail[]> {
  const wanted = [...new Set(ids)]
    .filter((id) => tryParseEvidenceId(id)?.kind === 'OBS')
    .slice(0, EVIDENCE_DETAIL_LIMIT);
  if (wanted.length === 0) return [];

  const now = serverNow();
  const asOf = options.asOf === undefined ? now : parseAsOf(asOfSearch(options.asOf), now);
  const settled = await Promise.allSettled(
    wanted.map((id) => services.getEvidence(database().db, { id, asOf, now })),
  );
  return settled
    .filter(
      (result): result is PromiseFulfilledResult<EvidenceDetail> => result.status === 'fulfilled',
    )
    .map((result) => result.value);
}

/**
 * The type-ahead's starting list.
 *
 * Read from the local GeoNames table through the same service `/api/v1/places/suggest` uses, so
 * the server-rendered options and the ones the browser fetches as the reader types come from one
 * query. Nothing here calls a provider (ADR-013).
 */
export async function getPlaceSuggestions(): Promise<readonly PlaceSuggestion[]> {
  const curated = await getCuratedPlaces();
  const first = curated[0];
  if (first === undefined) return [];
  try {
    const response = await suggestPlacesService(database().db, {
      query: first.label,
      limit: CURATED_SUGGESTION_LIMIT,
    });
    return response.suggestions;
  } catch {
    /*
     * An empty list, not a thrown error. The landing page is usable without suggestions — the
     * reader can still submit a search — and a places table that has not been imported is a
     * deployment state, not a reason to serve a 500 on the front page.
     */
    return [];
  }
}

const CURATED_SUGGESTION_LIMIT = 5;

/** Curated places for "Try: …" on the landing page (PRODUCT §6.1). Editorial, not a fact. */
export function getCuratedPlaces(): Promise<readonly { label: string; slug: string }[]> {
  return Promise.resolve([{ label: 'Marrakech', slug: 'marrakech-ma-2542997' }]);
}

// ---------------------------------------------------------------------------------------------
// Request construction. Everything below builds parameters for `params.ts` and parses nothing
// itself, so there is no second validator in this file.
// ---------------------------------------------------------------------------------------------

/** `?place=<key>` for a slug, or `null` when the slug is not one GeoNerva mints. */
function locationSearch(slug: string): URLSearchParams | null {
  const key = locationKeyFromSlug(slug);
  return key === null ? null : new URLSearchParams({ place: key });
}

function asOfSearch(asOf: string): URLSearchParams {
  return new URLSearchParams({ as_of: asOf });
}

function placeQuery(options: { readonly placeSlug?: string }): string {
  return options.placeSlug === undefined ? '' : `?place=${encodeURIComponent(options.placeSlug)}`;
}

/**
 * The zoom the dashboard's map is drawn at, and the box it asks for.
 *
 * Zoom 6 is what `MapPanel` opens at, and the half-extent is a little over the widest family
 * radius, so the features the cards list are inside the box the map draws. The box is snapped
 * **outward** to the zoom's grid by `quantizeViewport` — the same function a browser client would
 * have to call — which is what `parseViewport` then checks it against.
 */
const MAP_ZOOM = 6;
const MAP_HALF_EXTENT_KM = 320;
const KM_PER_DEGREE_LATITUDE = 110.574;
const KM_PER_DEGREE_LONGITUDE_AT_EQUATOR = 111.32;

function viewportSearch(location: LocationRef): URLSearchParams {
  const bbox = mapViewport(location);
  const search = new URLSearchParams({
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north].map((edge) => String(edge)).join(','),
    zoom: String(MAP_ZOOM),
    families: MAPPED_FAMILIES.join(','),
  });
  return search;
}

/** A grid-aligned box around a location, clamped to the world. */
export function mapViewport(location: Pick<LocationRef, 'lat' | 'lon'>): BoundingBox {
  const dLat = MAP_HALF_EXTENT_KM / KM_PER_DEGREE_LATITUDE;
  /*
   * The cosine is floored well away from zero so a polar location does not ask for a box wider
   * than the world; the clamp below then does the rest.
   */
  const cosine = Math.max(0.05, Math.cos((location.lat * Math.PI) / 180));
  const dLon = MAP_HALF_EXTENT_KM / (KM_PER_DEGREE_LONGITUDE_AT_EQUATOR * cosine);
  const step = quantizationStepDegrees(MAP_ZOOM);
  const snapped = quantizeViewport(
    {
      west: Math.max(-180, location.lon - dLon),
      south: Math.max(-90, location.lat - dLat),
      east: Math.min(180, location.lon + dLon),
      north: Math.min(90, location.lat + dLat),
    },
    MAP_ZOOM,
  );
  /*
   * `quantizeViewport` clamps at ±180 and ±90, and a clamped edge is not on the grid — ±90 is not
   * a multiple of the step at most zooms. Pulling such an edge back inside by one step keeps the
   * box grid-aligned, which is what the parser requires, at the cost of a sliver of a viewport no
   * map can show anyway.
   */
  return {
    west: snapped.west <= -180 ? -180 + step : snapped.west,
    south: snapped.south <= -90 ? -90 + step : snapped.south,
    east: snapped.east >= 180 ? 180 - step : snapped.east,
    north: snapped.north >= 90 ? 90 - step : snapped.north,
  };
}

/** Shared by the two detail pages: validate the id, resolve the place, call the service. */
async function detailOutcome<T>(
  publicId: string,
  expect: 'canonical_event' | 'fire_cluster',
  options: { readonly placeSlug?: string },
  call: (request: services.DetailRequest) => Promise<services.DetailOutcome<T>>,
): Promise<services.DetailOutcome<T> | null> {
  const now = serverNow();
  try {
    const placeSearch = options.placeSlug === undefined ? null : locationSearch(options.placeSlug);
    return await call({
      publicId: parsePublicId(publicId, expect),
      asOf: now,
      now,
      location: placeSearch === null ? null : parseLocation(placeSearch),
    });
  } catch (error) {
    return absentOrRethrow(error);
  }
}

/**
 * `null` for a refusal that means "GeoNerva has no such subject", and a rethrow for everything
 * else.
 *
 * `AS_OF_BEFORE_HORIZON` is deliberately **not** in the list. ADR-035's rule is that retention loss
 * is reported rather than rendered as an absence, and a 404 page is an absence.
 */
function absentOrRethrow(error: unknown): null {
  if (error instanceof ApiProblemError) {
    const { code } = error.problem;
    if (code === 'LOCATION_NOT_FOUND' || code === 'NOT_FOUND' || code === 'VALIDATION_FAILED') {
      return null;
    }
  }
  throw error;
}
