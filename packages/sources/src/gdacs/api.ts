/**
 * The GDACS API (DATA_SOURCES §2.1) — and the three things about it that shape everything else.
 *
 * It is an internal ASP.NET API exposed through Swagger, with no documented rate limit, SLA,
 * versioning or deprecation policy, and its own terms say it is provided "as is" and may change
 * "without prior notice". Everything here is therefore defensive in a way the FDSN services do
 * not need to be.
 *
 * **1. `alertlevel` must always be sent.** `SEARCH?eventlist=EQ` *without* it answers **HTTP 204**
 * — P0 captured it, and it reproduced unchanged on 2026-09-20. Sending the parameter is not
 * optional here; it is the difference between a result and a silence.
 *
 * **2. A window cannot be narrowed below the page size.** P0's guidance was to choose date windows
 * small enough that each returns under 100. Measured on 2026-09-20, that is not achievable for
 * wildfires: `fromDate`/`toDate` filter on the event's *range overlapping* the window, and an
 * active wildfire spans weeks, so a one-hour window returns the same full page of 100 as a
 * two-day one (WF 79 → 83 → 89 of 100 as the window shrank from 2 days to 6 hours — the count
 * went *up*, because the earthquakes dropped out first). There were 258 concurrent wildfires that
 * day. Windowing works for point-in-time hazards and cannot work for ongoing ones.
 *
 * So this module pages, and pages carefully. It stops on a short page, on a 204, or when a page
 * contributes nothing new — and if the page cap is reached while pages are still full it raises
 * `TOO_LARGE` rather than returning what it has, because a partial list that looks whole is the
 * failure this whole system is built to avoid.
 *
 * **3. Paging order is not stable.** P0 saw page 1 and page 2 of one `SEARCH` share 67 of 100
 * events, with many identical `todate`s. On 2026-09-20 three pages of wildfires had *zero*
 * overlap and terminated cleanly at 258. Both are real: the ordering is by a field with heavy
 * ties, so the sort is unstable and pages may overlap or skip depending on the day. Overlap is
 * handled by deduplicating on `(eventtype, eventid)`; *skipping* cannot be detected from the API
 * at all, and that limit is recorded rather than papered over.
 */

import type { HttpClient } from '@geonerva/http';
import { SourceFetchError } from '@geonerva/http';

export const GDACS_HOST = 'www.gdacs.org';
const GDACS_BASE = `https://${GDACS_HOST}/gdacsapi/api`;

/** The six event types GDACS publishes, each seeded as its own `source_products` row. */
export const GDACS_EVENT_TYPES = ['EQ', 'TC', 'FL', 'VO', 'WF', 'DR'] as const;
export type GdacsEventType = (typeof GDACS_EVENT_TYPES)[number];

export function isGdacsEventType(value: string): value is GdacsEventType {
  return (GDACS_EVENT_TYPES as readonly string[]).includes(value);
}

/** The service's maximum, and its page size. A full page means "there is more". */
export const GDACS_PAGE_SIZE = 100;

/**
 * How many pages one poll will walk before refusing.
 *
 * 2,000 events is far beyond anything observed — the largest real answer was 258 concurrent
 * wildfires — so reaching it means the query is not the query that was intended. Refusing beats
 * paging forever against an API with no documented rate limit.
 */
export const GDACS_MAX_PAGES = 20;

/**
 * Every alert level, always.
 *
 * Not a filter GeoNerva wants: omitting the parameter is the documented way to get an HTTP 204
 * out of this API, so the full set is sent as a way of *not* omitting it. Green events are the
 * overwhelming majority and are not excluded — GDACS Green still means an event happened.
 */
const ALERT_LEVELS = 'green;orange;red';

export interface GdacsWindow {
  readonly from: Date;
  readonly to: Date;
}

/**
 * GDACS dates carry **no timezone suffix** (`2026-09-19T20:24:42`), and neither do the ones it
 * accepts. Sent without one, and parsed back with an explicit `Z` — see `gdacsInstant`.
 */
function gdacsDate(value: Date): string {
  return value.toISOString().slice(0, 19);
}

export function gdacsSearchUrl(
  eventType: GdacsEventType,
  window: GdacsWindow,
  pageNumber: number,
): string {
  if (window.from.getTime() >= window.to.getTime()) {
    throw new SourceFetchError('CONFIG_ERROR', 'the GDACS window must start before it ends', {
      host: GDACS_HOST,
    });
  }
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new SourceFetchError('CONFIG_ERROR', `page number ${pageNumber} is not a page`, {
      host: GDACS_HOST,
    });
  }
  const params = new URLSearchParams({
    eventlist: eventType,
    alertlevel: ALERT_LEVELS,
    fromDate: gdacsDate(window.from),
    toDate: gdacsDate(window.to),
    pageSize: String(GDACS_PAGE_SIZE),
    pageNumber: String(pageNumber),
  });
  return `${GDACS_BASE}/events/geteventlist/SEARCH?${params.toString()}`;
}

/**
 * One event's full record.
 *
 * Needed for earthquakes and only for earthquakes: `sourceid` is **empty in the list and in the
 * RSS**, and it is the USGS event id that makes a GDACS earthquake a *derived copy* rather than
 * an independent second opinion (ADR-030). Without it, GDACS agreeing with USGS would read as two
 * sources agreeing, when it is one source quoted twice.
 */
export function gdacsEventDataUrl(eventType: GdacsEventType, eventId: number): string {
  if (!Number.isInteger(eventId) || eventId < 1) {
    throw new SourceFetchError('CONFIG_ERROR', `event id ${eventId} is not an id`, {
      host: GDACS_HOST,
    });
  }
  const params = new URLSearchParams({ eventtype: eventType, eventid: String(eventId) });
  return `${GDACS_BASE}/events/geteventdata?${params.toString()}`;
}

/** Host and path only, for logs. GDACS needs no credential, so nothing here is a secret. */
export function gdacsEndpoint(eventType: GdacsEventType): string {
  return `${GDACS_HOST}/gdacsapi/api/events/geteventlist/SEARCH(${eventType})`;
}

/**
 * Parses a GDACS timestamp as UTC.
 *
 * GDACS sends `2026-09-19T20:24:42` with no offset. ECMAScript reads a date-*time* without an
 * offset as **local time**, so `new Date(...)` on a worker in Europe/Paris would place every
 * GDACS event two hours early in summer — plausible, invisible, and wrong in a system whose whole
 * subject is when things happened. The `Z` is appended explicitly, and a value that already
 * carries an offset is left alone rather than double-stamped.
 */
export function gdacsInstant(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const parsed = new Date(hasZone ? trimmed : `${trimmed}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export interface GdacsPagedList {
  readonly kind: 'LIST';
  /** Every distinct feature seen, in the order first seen. */
  readonly features: readonly unknown[];
  readonly pagesRead: number;
  /** Rows returned across all pages, before deduplication. `rows - features.length` is overlap. */
  readonly rows: number;
  readonly attempts: number;
  readonly durationMs: number;
}

/**
 * A page that was not a feature collection at all.
 *
 * Returned rather than thrown, carrying the provider's bytes untouched, because this is *drift*
 * and `SourceFetchError` has no class for drift — its taxonomy is transport. Handing the body
 * back lets the adapter's `parse` fail it as `SCHEMA_DRIFT` with the real payload in hand, which
 * is where the 200-with-an-HTML-maintenance-page case belongs and what the captured fixture
 * expects.
 */
export interface GdacsMalformedPage {
  readonly kind: 'MALFORMED';
  readonly page: number;
  readonly body: Uint8Array;
  readonly httpStatus: number;
  readonly attempts: number;
  readonly durationMs: number;
}

/** Pulls `(eventtype, eventid)` out of a feature without trusting its shape. */
function identityOf(feature: unknown): string | null {
  if (typeof feature !== 'object' || feature === null) return null;
  const properties = (feature as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null) return null;
  const { eventtype, eventid } = properties as { eventtype?: unknown; eventid?: unknown };
  if (typeof eventtype !== 'string') return null;
  if (typeof eventid !== 'number' && typeof eventid !== 'string') return null;
  return `${eventtype}:${String(eventid)}`;
}

function featuresOf(body: Uint8Array): unknown[] | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const features = (json as { features?: unknown }).features;
  return Array.isArray(features) ? features : null;
}

/**
 * Reads every page of one event type's list.
 *
 * Termination, in order of preference: a short page (the clean end), a 204 (the same thing said
 * differently), or a page that contributes nothing new (the unstable-sort symptom — carrying on
 * would loop over the same rows). Reaching `GDACS_MAX_PAGES` with pages still full is not a
 * termination, it is a refusal.
 */
export async function gdacsFetchList(
  client: HttpClient,
  eventType: GdacsEventType,
  window: GdacsWindow,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GdacsPagedList | GdacsMalformedPage> {
  const features: unknown[] = [];
  const seen = new Set<string>();
  let rows = 0;
  let attempts = 0;
  let durationMs = 0;

  for (let page = 1; page <= GDACS_MAX_PAGES; page += 1) {
    const response = await client.get(gdacsSearchUrl(eventType, window, page), {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    attempts += response.attempts;
    durationMs += response.durationMs;

    // 204 on a query that *does* carry `alertlevel` means this type genuinely has nothing in the
    // window — `alertlevel=orange;red` for wildfires answered 204 on 2026-09-20, because there
    // were none. Whether that is believable for the whole poll is the batch verdict's decision,
    // not this function's.
    if (response.status === 204 || response.bytes === 0) {
      return { kind: 'LIST', features, pagesRead: page - 1, rows, attempts, durationMs };
    }

    const page_ = featuresOf(response.body);
    if (page_ === null) {
      return {
        kind: 'MALFORMED',
        page,
        body: response.body,
        httpStatus: response.status,
        attempts,
        durationMs,
      };
    }

    rows += page_.length;
    let added = 0;
    for (const feature of page_) {
      const identity = identityOf(feature);
      /*
       * A feature with no usable identity is kept, not dropped.
       *
       * It cannot be deduplicated, and it will fail validation in `parse` and become a counted
       * reject row with a reason. Dropping it here would make it vanish between the provider and
       * the reject count, and "nothing is skipped silently" is the rule this contract is built on.
       */
      if (identity === null) {
        features.push(feature);
        added += 1;
        continue;
      }
      if (seen.has(identity)) continue;
      seen.add(identity);
      features.push(feature);
      added += 1;
    }

    if (page_.length < GDACS_PAGE_SIZE) {
      return { kind: 'LIST', features, pagesRead: page, rows, attempts, durationMs };
    }
    if (added === 0) {
      // A full page of rows already seen. The sort has looped; more pages cannot help.
      return { kind: 'LIST', features, pagesRead: page, rows, attempts, durationMs };
    }
  }

  /*
   * The page cap, with pages still full.
   *
   * Returning what has been read would be a list that looks complete and is not — the precise
   * failure a "quiet day" is indistinguishable from. `TOO_LARGE` says which kind of failure it is
   * and leaves the window as the thing to change.
   */
  throw new SourceFetchError(
    'TOO_LARGE',
    `the ${eventType} list was still full after ${GDACS_MAX_PAGES} pages ` +
      `(${rows} rows); the window is too wide to read completely`,
    { host: GDACS_HOST },
  );
}

/**
 * Fetches one event's detail, tolerating the absence of it.
 *
 * Returns `null` when there is nothing — typed as `unknown` because `unknown | null` is just
 * `unknown`, and the caller checks for null explicitly.
 *
 * Returns `null` rather than throwing when GDACS has nothing to say about an event it just listed
 * — an internal API with no SLA does that — because one missing `sourceid` must not fail a batch
 * of a hundred events. What it costs is recorded: a GDACS earthquake without an upstream
 * reference is normalized without one, which correlation reads as "not known to be derived"
 * rather than as "independent".
 */
export async function gdacsFetchEventData(
  client: HttpClient,
  eventType: GdacsEventType,
  eventId: number,
  options: { readonly signal?: AbortSignal } = {},
): Promise<unknown> {
  let response;
  try {
    response = await client.get(gdacsEventDataUrl(eventType, eventId), {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof SourceFetchError) return null;
    throw error;
  }
  if (response.status === 204 || response.bytes === 0) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
  } catch {
    return null;
  }
}

/**
 * The geometry endpoint.
 *
 * One request per event, so it is only made where the shape *is* the fact. For a flood that is
 * unavoidable: `FloodAttributes.has_area_geometry` is a required field that decides how the event
 * is described and whether its relevance is capped (ARCHITECTURE §9.3), and the event list cannot
 * answer it — every list row reports `Class: Point_Centroid` whatever `getgeometry` holds.
 */
export function gdacsGeometryUrl(
  eventType: GdacsEventType,
  eventId: number,
  episodeId: number | null,
): string {
  if (!Number.isInteger(eventId) || eventId < 1) {
    throw new SourceFetchError('CONFIG_ERROR', `event id ${eventId} is not an id`, {
      host: GDACS_HOST,
    });
  }
  const params = new URLSearchParams({ eventtype: eventType, eventid: String(eventId) });
  if (episodeId !== null && Number.isInteger(episodeId) && episodeId > 0) {
    params.set('episodeid', String(episodeId));
  }
  return `${GDACS_BASE}/polygons/getgeometry?${params.toString()}`;
}

/**
 * How large one event's geometry may be before it is left out.
 *
 * P0 measured `getgeometry` answers from 9 KB to **1.8 MB** for a single flood episode. A cap is
 * not an optimisation here: `observation_versions.attributes` is bounded at 16 KB and the
 * geometry table has no such bound, so an uncapped fetch would put a multi-megabyte polygon into
 * every version of every episode of a months-long flood. 512 KB keeps the shapes that are usable
 * and drops the ones that are really a raster in disguise.
 *
 * Exceeding it is **not** silent: the record still says the provider has an area
 * (`has_area_geometry: true`), and only the shape itself is absent. Dropping the flag too would
 * turn "too big to store" into "no modelled area", which is the lie this cap must not tell.
 */
export const GDACS_MAX_GEOMETRY_BYTES = 512 * 1024;

export interface GdacsGeometryAnswer {
  /** The provider published an area for this event, whether or not it was small enough to keep. */
  readonly hasArea: boolean;
  /** The features, when the body was small enough to use. */
  readonly features: readonly unknown[];
  /** True when an area exists but was left out for size. */
  readonly oversized: boolean;
}

/**
 * Fetches one event's geometry.
 *
 * `null` means the question could not be asked — a failure, a 204, an unparsable body — which is
 * different from "there is no area" and is what the caller must not confuse with `hasArea: false`.
 */
export async function gdacsFetchGeometry(
  client: HttpClient,
  eventType: GdacsEventType,
  eventId: number,
  episodeId: number | null,
  options: { readonly signal?: AbortSignal } = {},
): Promise<GdacsGeometryAnswer | null> {
  let response;
  try {
    response = await client.get(gdacsGeometryUrl(eventType, eventId, episodeId), {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof SourceFetchError) return null;
    throw error;
  }
  if (response.status === 204 || response.bytes === 0) return null;

  const features = featuresOf(response.body);
  if (features === null) return null;

  const areas = features.filter((feature) => isAreaFeature(feature));
  if (areas.length === 0) return { hasArea: false, features: [], oversized: false };
  if (response.bytes > GDACS_MAX_GEOMETRY_BYTES) {
    return { hasArea: true, features: [], oversized: true };
  }
  return { hasArea: true, features: areas, oversized: false };
}

/**
 * Whether a geometry feature is an *area* rather than the centroid.
 *
 * GDACS names them per hazard: `Poly_Affected` and `Poly_Global` for floods, `Poly_area` for
 * wildfires, `Poly_Circle` and the ash cones for volcanoes, and a family of wind buffers and
 * cones for cyclones. Matching on the `Poly_` prefix rather than an enumerated list is deliberate
 * — a class this code has not seen is still an area, and treating an unknown polygon as "no area"
 * would be the wrong default for a flood.
 */
export function isAreaFeature(feature: unknown): boolean {
  if (typeof feature !== 'object' || feature === null) return false;
  const properties = (feature as { properties?: unknown }).properties;
  const geometry = (feature as { geometry?: unknown }).geometry;
  if (typeof geometry !== 'object' || geometry === null) return false;
  const geometryType = (geometry as { type?: unknown }).type;
  if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') return false;
  if (typeof properties !== 'object' || properties === null) return true;
  const cls = (properties as { Class?: unknown }).Class;
  return typeof cls !== 'string' || cls.startsWith('Poly_');
}
