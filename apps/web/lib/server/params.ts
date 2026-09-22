/**
 * Query-parameter validation (ARCHITECTURE §13.2).
 *
 * Every rule below is transcribed from §13.2 so a reader can compare them line by line:
 *
 * > - `lat ∈ [−90, 90]`, `lon ∈ [−180, 180]` (normalized), rounded to 0.01° **before** logging,
 * >   caching or querying.
 * > - `bbox` must be valid with area ≤ 60° × 60° at zoom < 4. Antimeridian bboxes are accepted.
 * > - `as_of ∈ [replay_horizon, now]`; `since` is clamped.
 * > - `families[]` must be from the enum.
 * > - String params are length-capped.
 * > - Unknown params → 400. This keeps cache keys canonical and prevents cache-busting abuse.
 *
 * ### Three rules that are security controls rather than hygiene
 *
 * **Unknown parameters are rejected.** A tolerated unknown parameter is a cache-busting primitive:
 * `?briefing&x=1`, `?x=2`, … are distinct CDN keys for one response, so an attacker can force
 * unlimited origin traffic through a cached endpoint. Rejecting them keeps the key canonical.
 *
 * **A coordinate must arrive already rounded; it is not rounded here.** ADR-015 and §13.2 both
 * say two decimals "before logging, caching or querying", and a server cannot round before the
 * URL reaches the CDN: by the time this code runs, `?lat=48.856614&lon=2.352222` is already the
 * cache key and already in the platform's own access log, which `log.ts`'s redaction cannot
 * touch. Rounding on arrival satisfied invariant I15 for the response *body* and left the
 * caller's ~10 cm position at the edge — so a finer coordinate is now a `VALIDATION_FAILED`
 * naming the rule, and a client that wants a briefing rounds before it asks.
 *
 * The residue is honest and stated: the first such request's URL still reaches the platform log
 * once. What it no longer does is return `200` and get stored under that key for two minutes.
 *
 * **Each parameter may appear once.** A repeated one is another cache-busting primitive:
 * `?window=24h&window=24h&window=24h` is one response under three CDN keys, and
 * `URLSearchParams.get` silently takes the first. Only `families` may repeat, because §13.1
 * writes it `families[]`.
 *
 * Two things the server cannot canonicalize, named so that nothing claims otherwise: parameter
 * **order**, which is fixed by the caller before the request exists, and the cardinality of
 * `as_of`, where every distinct past instant is a legitimately different question. Neither is
 * defended by validation; both are defended by §13.4's rate limit.
 *
 * **`Number()` is not used for numeric parsing.** `Number('')` is 0, `Number(' ')` is 0 and
 * `Number('1e999')` is `Infinity`; each would pass a naive range check. Parsing goes through an
 * explicit pattern and a finiteness test, so `NaN`, `Infinity`, `1e999`, `0x1f` and `''` are all
 * rejected rather than silently becoming a coordinate.
 */

import {
  isViewportWithinLimit,
  MAX_VIEWPORT_DEGREES,
  quantizationStepDegrees,
  quantizeViewport,
} from '@geonerva/db/viewport';
import {
  CHANGE_WINDOWS,
  HAZARD_FAMILIES,
  USER_COORDINATE_DECIMALS,
  hazardTypeOfPublicId,
  isLocationKey,
  isPublicId,
  roundUserCoordinate,
  type BoundingBox,
  type ChangeWindow,
  type HazardFamily,
  type InvalidParam,
} from '@geonerva/domain';

import { metricsFor, radiiFor, type HistoryMetric } from '@geonerva/briefing';

import { ApiProblemError } from './problem.ts';

/** §13.2: "String params are length-capped." */
export const MAX_QUERY_LENGTH = 64;
export const MAX_LOCATION_KEY_LENGTH = 32;
export const MAX_PUBLIC_ID_LENGTH = 32;
export const MAX_EVIDENCE_ID_LENGTH = 80;

/** A validated location: either a named place key or a rounded coordinate pair. */
export type LocationParam =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'coordinates'; readonly lat: number; readonly lon: number };

/** Collects failures so one response can report every invalid parameter, not just the first. */
class ParamCollector {
  private readonly failures: InvalidParam[] = [];

  fail(name: string, reason: string): void {
    this.failures.push({ name, reason });
  }

  /** Throws `VALIDATION_FAILED` when anything failed. Never echoes a submitted value. */
  assertValid(): void {
    if (this.failures.length === 0) return;
    throw new ApiProblemError({
      code: 'VALIDATION_FAILED',
      detail: 'One or more parameters did not satisfy the documented rules.',
      invalidParams: this.failures,
    });
  }
}

/** Parameters §13.1 writes with `[]`, which may therefore appear more than once. */
const REPEATABLE_PARAMS = new Set(['families']);

/**
 * Rejects any parameter the endpoint does not declare, and any it declares that appears twice.
 *
 * Called **first** by every handler. The allowed set is the endpoint's own, so adding a parameter
 * is a deliberate act and a typo is a 400 rather than a silent no-op.
 *
 * The repeat check is the half that was missing. An unknown name and a duplicated known name are
 * the same attack — one response served under unbounded distinct CDN keys — and only the first was
 * being caught, which made this function's claim to "keep the key canonical" false for the easier
 * of the two.
 */
export function rejectUnknownParams(search: URLSearchParams, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  const unknown = [...new Set([...search.keys()].filter((key) => !permitted.has(key)))].sort();
  if (unknown.length > 0) {
    throw new ApiProblemError({
      code: 'UNKNOWN_PARAMETER',
      detail: `This endpoint accepts only: ${allowed.join(', ')}.`,
      /*
       * The parameter *name* is echoed and its value is not. A name is capped here and is what the
       * caller needs in order to fix the request; the value is arbitrary input.
       */
      invalidParams: unknown.map((name) => ({
        name: cappedName(name),
        reason: 'is not a parameter of this endpoint',
      })),
    });
  }

  const counts = new Map<string, number>();
  for (const key of search.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
  const repeated = [...counts]
    .filter(([key, count]) => count > 1 && !REPEATABLE_PARAMS.has(key))
    .map(([key]) => key)
    .sort();
  if (repeated.length === 0) return;

  throw new ApiProblemError({
    code: 'VALIDATION_FAILED',
    detail: 'Each parameter may appear only once, so that one response has one cache key.',
    invalidParams: repeated.map((name) => ({
      name: cappedName(name),
      reason: 'must appear at most once',
    })),
  });
}

function cappedName(name: string): string {
  return name.length > 40 ? `${name.slice(0, 40)}…` : name;
}

/**
 * A finite decimal number, parsed strictly.
 *
 * Deliberately not `Number()`. The pattern admits an optional sign, digits, an optional fraction
 * and nothing else — so `Infinity`, `NaN`, `1e999`, `0x1f`, `''`, `' 1'` and `'1,5'` are all
 * rejected before any range comparison, rather than becoming `0` or `Infinity` and then passing
 * one.
 */
export function parseFiniteNumber(raw: string): number | null {
  if (!/^[+-]?\d{1,12}(?:\.\d{1,12})?$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * `place` or `lat,lon`, exactly one of them.
 *
 * Both is a 400 rather than a precedence rule: two locations in one request is ambiguous, and
 * picking one silently would mean a caller could be shown a briefing for a place they did not ask
 * about. The coordinate branch **requires** an already-rounded value; see the header for why
 * rounding it here was not enough.
 */
export function parseLocation(search: URLSearchParams): LocationParam {
  const collector = new ParamCollector();
  const place = search.get('place');
  const latRaw = search.get('lat');
  const lonRaw = search.get('lon');
  const hasCoordinates = latRaw !== null || lonRaw !== null;

  if (place !== null && hasCoordinates) {
    collector.fail('place', 'cannot be combined with lat and lon');
    collector.assertValid();
  }

  if (place !== null) {
    if (place.length > MAX_LOCATION_KEY_LENGTH) {
      collector.fail('place', `must be at most ${String(MAX_LOCATION_KEY_LENGTH)} characters`);
    } else if (!isLocationKey(place)) {
      /*
       * `p:` and `c:` are the two `resolveLocation` handles — a `c:` key is a coordinate pair and
       * needs no `places` table. `n:` is accepted by `isLocationKey` and resolved by nothing, so
       * advertising it here promised an input that always answers 404.
       */
      collector.fail(
        'place',
        'must be a place key (p:2542997) or a coordinate key (c:31.63,-8.00)',
      );
    }
    collector.assertValid();
    return { kind: 'key', key: place };
  }

  if (!hasCoordinates) {
    collector.fail('place', 'is required, or supply lat and lon');
    collector.assertValid();
  }

  if (latRaw === null) collector.fail('lat', 'is required when lon is supplied');
  if (lonRaw === null) collector.fail('lon', 'is required when lat is supplied');
  collector.assertValid();

  const lat = latRaw === null ? null : parseFiniteNumber(latRaw);
  const lon = lonRaw === null ? null : parseFiniteNumber(lonRaw);
  if (lat === null) collector.fail('lat', 'must be a finite decimal number');
  if (lon === null) collector.fail('lon', 'must be a finite decimal number');
  collector.assertValid();

  if (lat !== null && (lat < -90 || lat > 90)) {
    collector.fail('lat', 'must be within [-90, 90]');
  }
  /*
   * §13.2 writes `lon ∈ [−180, 180]`, and the value is normalized — so +180 and −180 are the same
   * meridian. The inclusive check accepts both spellings; normalization then folds +180 to −180.
   */
  if (lon !== null && (lon < -180 || lon > 180)) {
    collector.fail('lon', 'must be within [-180, 180]');
  }
  collector.assertValid();

  /*
   * The precision check runs after the range check, so a request that is wrong in both ways is
   * told about the range first — the more fundamental mistake, and the one a caller is more likely
   * to have made deliberately.
   */
  if (lat !== null && roundUserCoordinate(lat) !== lat) {
    collector.fail('lat', COORDINATE_PRECISION_REASON);
  }
  if (lon !== null && roundUserCoordinate(lon) !== lon) {
    collector.fail('lon', COORDINATE_PRECISION_REASON);
  }
  collector.assertValid();

  return {
    kind: 'coordinates',
    /*
     * Still through `roundUserCoordinate`, although the value is already canonical: it maps `-0`
     * to `0`. `-0` survives `!==` against `0` unnoticed and serializes as `-0` in JSON, which is a
     * second spelling of one location and therefore a second cache key.
     */
    lat: roundUserCoordinate(lat ?? 0),
    lon: roundUserCoordinate(normalizeLongitude(lon ?? 0)),
  };
}

/**
 * The reason a coordinate is refused, phrased as the rule and never echoing the value.
 *
 * It names the decimal count rather than saying "too precise", because the caller's fix is
 * mechanical: round before asking.
 */
const COORDINATE_PRECISION_REASON =
  `must carry at most ${String(USER_COORDINATE_DECIMALS)} decimals (e.g. 31.63); ` +
  'round before sending, so that a precise position never becomes a cache key';

/** +180 and −180 name one meridian; folding gives a single canonical cache key. */
function normalizeLongitude(lon: number): number {
  return lon === 180 ? -180 : lon;
}

/** `window=6h|24h|7d`, defaulting to the documented 24 h (§10.1). */
export function parseWindow(search: URLSearchParams, name = 'window'): ChangeWindow {
  const raw = search.get(name);
  if (raw === null) return '24h';
  if ((CHANGE_WINDOWS as readonly string[]).includes(raw)) return raw as ChangeWindow;
  throw new ApiProblemError({
    code: 'VALIDATION_FAILED',
    detail: 'The comparison window is not one of the supported values.',
    invalidParams: [{ name, reason: `must be one of: ${CHANGE_WINDOWS.join(', ')}` }],
  });
}

/**
 * `as_of` — a knowledge time.
 *
 * Absent means now. A future value is `AS_OF_IN_FUTURE` and not a clamp, because silently moving
 * it would answer a question the caller did not ask; invariant I2 is that replay never sees the
 * future, and the honest response to being asked for the future is to say so. The horizon check
 * lives in the service, which knows the per-family horizons.
 *
 * A small tolerance absorbs clock skew between the caller and the server. Without it a client
 * sending `new Date().toISOString()` fails intermittently for reasons it cannot see.
 */
export const AS_OF_FUTURE_TOLERANCE_MS = 5_000;

export function parseAsOf(search: URLSearchParams, now: Date, name = 'as_of'): Date {
  const raw = search.get(name);
  if (raw === null) return now;

  if (
    raw.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(raw)
  ) {
    throw new ApiProblemError({
      code: 'VALIDATION_FAILED',
      detail:
        'The knowledge time must be an ISO-8601 instant ending in Z, or with an offset whose ' +
        'plus sign is percent-encoded as %2B.',
      /*
       * The `%2B` note is not pedantry: a bare `+` in a query string decodes to a space, so
       * `?as_of=2026-09-21T00:00:00+02:00` arrives as `…00:00 02:00` and is rejected as malformed
       * while looking exactly like the form the old message advertised.
       */
      invalidParams: [{ name, reason: 'must be an ISO-8601 instant, e.g. 2026-09-21T00:00:00Z' }],
    });
  }

  const parsed = new Date(raw.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiProblemError({
      code: 'VALIDATION_FAILED',
      detail: 'The knowledge time is not a valid instant.',
      invalidParams: [{ name, reason: 'must be a valid ISO-8601 instant' }],
    });
  }

  if (parsed.getTime() > now.getTime() + AS_OF_FUTURE_TOLERANCE_MS) {
    throw new ApiProblemError({
      code: 'AS_OF_IN_FUTURE',
      detail: 'GeoNerva cannot report on a time that has not happened yet.',
    });
  }

  return parsed;
}

/** `families[]` from the enum. Repeated or comma-separated, deduplicated and sorted. */
export function parseFamilies(search: URLSearchParams, name = 'families'): readonly HazardFamily[] {
  const raw = search.getAll(name).flatMap((value) => value.split(','));
  /*
   * An absent parameter means every family. So does a present-but-empty one — `?families=` — which
   * previously fell through the loop and returned `[]`: an empty family list is a request for
   * nothing, and a response built from it would show no hazards for a reason the caller never
   * asked for. That is a false zero manufactured by a typo.
   */
  if (raw.every((value) => value.trim() === '')) return HAZARD_FAMILIES;

  const collector = new ParamCollector();
  const known = new Set<string>(HAZARD_FAMILIES);
  const chosen = new Set<HazardFamily>();
  for (const value of raw) {
    const trimmed = value.trim();
    if (trimmed === '') continue;
    if (!known.has(trimmed)) {
      collector.fail(name, `must contain only: ${HAZARD_FAMILIES.join(', ')}`);
      break;
    }
    chosen.add(trimmed as HazardFamily);
  }
  collector.assertValid();
  /*
   * Sorted, so `families=FLOODS,EARTHQUAKES` and `families=EARTHQUAKES,FLOODS` are one cache key
   * rather than two. §13.3 keys the CDN on the canonical URL and this is half of what makes a URL
   * canonical.
   */
  return HAZARD_FAMILIES.filter((family) => chosen.has(family));
}

/** A bounded positive integer, e.g. `limit`. Out-of-range is a 400, never a silent clamp. */
export function parseLimit(
  search: URLSearchParams,
  options: { readonly name?: string; readonly max: number; readonly fallback: number },
): number {
  const name = options.name ?? 'limit';
  const raw = search.get(name);
  if (raw === null) return options.fallback;

  if (!/^\d{1,4}$/u.test(raw)) {
    throw new ApiProblemError({
      code: 'VALIDATION_FAILED',
      detail: 'The limit must be a small positive integer.',
      invalidParams: [{ name, reason: 'must be a positive integer' }],
    });
  }
  const value = Number(raw);
  if (value < 1 || value > options.max) {
    throw new ApiProblemError({
      code: 'VALIDATION_FAILED',
      detail: 'The limit is outside the range this endpoint allows.',
      invalidParams: [{ name, reason: `must be within [1, ${String(options.max)}]` }],
    });
  }
  return value;
}

/** A free-text search term: length-capped, and control characters rejected rather than stripped. */
export function parseQuery(search: URLSearchParams, name = 'q'): string {
  const raw = search.get(name);
  const collector = new ParamCollector();
  if (raw === null || raw.trim().length < 2) {
    collector.fail(name, 'must be at least 2 characters');
    collector.assertValid();
  }
  const value = (raw ?? '').trim();
  if (value.length > MAX_QUERY_LENGTH) {
    collector.fail(name, `must be at most ${String(MAX_QUERY_LENGTH)} characters`);
  }
  /*
   * Rejected rather than sanitized. Stripping would make two different requests into one cache
   * key and would hide the fact that the input was malformed; a control character in a search
   * term is not a typo a user makes.
   */
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    collector.fail(name, 'must not contain control characters');
  }
  /*
   * A coordinate pair typed into the search box is a position, and ADR-015 applies to it exactly as
   * it does to `lat`/`lon`: "48.856614,2.352222" would otherwise reach Nominatim and the geocode
   * cache key unrounded (P8 review). What this cannot do is keep it out of the platform's access
   * log — the URL reached the edge before any of this ran, the residual S-1 already records.
   * Refused rather than rounded for that reason, and two decimals pass, as they do everywhere.
   */
  if (containsPreciseCoordinate(value)) {
    collector.fail(name, 'must not contain a coordinate with more than 2 decimals');
  }
  collector.assertValid();
  return value;
}

/*
 * Sexagesimal forms precise on their own (reviews rounds 3 and 4). Before matching, every degree
 * mark a keyboard produces — `°`, the ring above `˚`, and `º`, which NFKC folds to `o` — becomes
 * `°`, and after NFKC the typographic double prime (″) is two primes (′′).
 *
 *  - degrees, minutes and seconds, however the seconds are marked, or colon-separated;
 *  - degrees and decimal minutes to two or more places (about 20 m);
 *  - spaced degrees and minutes (decimal, or with seconds) with an upper-case hemisphere letter
 *    after them or before them. Minutes are two digits and under 60, seconds under 60, and the
 *    letter must stand alone, so "Room 1 2 3 N" and "Flight 12 34 Newark" are not positions.
 *    "size 10 12 14 S" still is — it is a valid position, and a 400 is the cheaper mistake.
 */
const MINUTES = String.raw`[0-5]?\d`;
const SEXAGESIMAL: readonly RegExp[] = [
  new RegExp(String.raw`\d{1,3}\s*°\s*${MINUTES}\s*['′:]\s*${MINUTES}(?:[.,]\d+)?`, 'u'),
  new RegExp(String.raw`\d{1,3}\s*°\s*${MINUTES}[.,]\d{2,}`, 'u'),
  new RegExp(String.raw`(?<![\d.])\d{1,3}:${MINUTES}:${MINUTES}(?:[.,]\d+)?\s*[NSEW]\b`, 'u'),
  new RegExp(
    String.raw`(?<![\d.])\d{1,3}\s+[0-5]\d(?:[.,]\d{2,}|\s+${MINUTES}(?:[.,]\d+)?)\s*[NSEW](?![A-Za-z])`,
    'u',
  ),
  new RegExp(
    String.raw`(?<![A-Za-z])[NSEW]\s*\d{1,3}\s+[0-5]\d(?:[.,]\d{2,}|\s+${MINUTES}(?:[.,]\d+)?)(?![\d.])`,
    'u',
  ),
];

/**
 * Whether a search term carries a position finer than two decimals.
 *
 * A scan rather than one pattern, because the fix-verification review walked straight past the
 * first pattern with the spellings Nominatim itself understands: hemisphere letters
 * (`48.856614N 2.352222E`), degree signs, a slash or words between the numbers, comma decimals,
 * fullwidth digits, and degrees-minutes-seconds. So:
 *
 *  - NFKC first, which folds fullwidth digits and compatibility forms into ASCII;
 *  - any degrees-minutes-seconds form with seconds (about 30 m) is precise on its own;
 *  - otherwise, two decimal numbers of latitude/longitude size, separated by at most a dozen
 *    characters with no digit in them, with at least one of the two carrying three or more
 *    decimals.
 *
 * Both numbers must be decimals. An address like "Av. Paulista 1.578, 01310-200", where "1.578" is
 * a house number with a thousands separator, has one decimal number and passes.
 */
export function containsPreciseCoordinate(raw: string): boolean {
  // Degree marks are unified *before* NFKC, which would otherwise fold `º` into a plain `o`.
  const text = raw.replace(/[º˚]/gu, '°').normalize('NFKC');
  if (SEXAGESIMAL.some((pattern) => pattern.test(text))) return true;

  // Not after a digit or a dot, so a match never starts inside another number; after a comma is
  // fine, since "48.856614,2.352222" separates its pair with one.
  const numbers = [...text.matchAll(/(?<![\d.])[-+]?\d{1,3}[.,](\d+)(?![\d])/gu)];
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1];
    const current = numbers[index];
    if (previous === undefined || current === undefined) continue;
    const between = text.slice(previous.index + previous[0].length, current.index);
    if (between.length > 12 || /\d/u.test(between)) continue;
    const decimals = Math.max(previous[1]?.length ?? 0, current[1]?.length ?? 0);
    if (decimals >= 3) return true;
  }
  return false;
}

/**
 * A public id, checked against the format GeoNerva mints — and against the kind of subject the
 * endpoint serves.
 *
 * The domain's `isPublicId` is the check, not a looser pattern of its own. An earlier pattern here
 * accepted any two-letter prefix and a four-to-twelve character token, so `XX-26-AAAA` passed
 * validation and then named no hazard type; the family lookup that the horizon rule needs would
 * have turned it into a 500.
 *
 * `FR-` ids name fire *clusters* and every other prefix names a canonical event, so each detail
 * endpoint refuses the other's ids with the reason, rather than looking one up and answering
 * "not found" about a subject that may well exist at the other address.
 */
export function parsePublicId(
  raw: string,
  expect: 'canonical_event' | 'fire_cluster',
  name = 'publicId',
): string {
  if (raw.length > MAX_PUBLIC_ID_LENGTH || !isPublicId(raw)) {
    throw new ApiProblemError({
      code: 'VALIDATION_FAILED',
      detail: 'That identifier is not the shape GeoNerva issues.',
      invalidParams: [{ name, reason: 'must be a GeoNerva public id, e.g. EQ-26-7K3F9Q' }],
    });
  }
  const isCluster = hazardTypeOfPublicId(raw) === 'THERMAL_ACTIVITY';
  if (isCluster !== (expect === 'fire_cluster')) {
    throw new ApiProblemError({
      code: 'VALIDATION_FAILED',
      detail: isCluster
        ? 'That identifier names a fire cluster; fetch it from /api/v1/fire-clusters/{publicId}.'
        : 'That identifier names an event; fetch it from /api/v1/events/{publicId}.',
      invalidParams: [
        {
          name,
          reason: isCluster
            ? 'must be an event id, not an FR- cluster id'
            : 'must be an FR- cluster id',
        },
      ],
    });
  }
  return raw;
}

/** The highest zoom a map may ask for; the frozen response schema bounds `zoom` the same way. */
export const MAX_ZOOM = 22;

/** A validated viewport: a canonical, grid-aligned box and the integer zoom it was drawn at. */
export interface ViewportParam {
  readonly bbox: BoundingBox;
  readonly zoom: number;
}

/**
 * `bbox=west,south,east,north` and `zoom`, both required (§13.1, §13.2).
 *
 * ### The box must arrive already on the grid, for the same reason a coordinate must
 *
 * §7.5 says bboxes are "quantized to a tile-aligned grid for cache hits", and a server cannot
 * quantize a URL the CDN has already keyed: `?bbox=-8.0712,31.5890,…` is a distinct cache entry
 * for every pixel of every pan, which is §13.2's cache-busting abuse delivered by an ordinary map.
 * So a box whose edges are not on the zoom's grid is refused, naming the grid step, and a client
 * snaps outward before it asks — `quantizeViewport` is the rule, and it only ever grows a box.
 *
 * Each edge must also be written in its **shortest** form (`11.25`, not `11.250` or `+11.25`):
 * those are one number and three cache keys. Grid values are dyadic multiples of 90°, so every one
 * of them has an exact shortest decimal and the rule costs a client nothing.
 *
 * ### Geometry
 *
 * `west > east` crosses the antimeridian and is accepted (§13.2). A zero-width or zero-height box
 * is refused rather than read as "nothing" or "everything". `+180` may only be an eastern edge and
 * `−180` only a western one: a western edge on `+180` is the same meridian as `−180` and would
 * make a crossing box out of an ordinary one.
 *
 * ### Size
 *
 * §13.2: "area ≤ 60° × 60° at zoom < 4". Width is measured the short way round, so an antimeridian
 * box is not charged 340°. `zoom` is declared by the caller, and nothing ties it to the box — a
 * caller can claim zoom 4 for a world-sized box — so this cap is not what bounds the work; the
 * response's feature cap is.
 */
export function parseViewport(search: URLSearchParams): ViewportParam {
  const collector = new ParamCollector();
  const bboxRaw = search.get('bbox');
  const zoomRaw = search.get('zoom');

  if (bboxRaw === null) collector.fail('bbox', 'is required: west,south,east,north in degrees');
  if (zoomRaw === null) collector.fail('zoom', 'is required');
  collector.assertValid();

  const zoom = zoomRaw !== null && /^\d{1,2}$/u.test(zoomRaw) ? Number(zoomRaw) : null;
  if (zoom === null || zoom > MAX_ZOOM || String(zoom) !== zoomRaw) {
    collector.fail('zoom', `must be an integer within [0, ${String(MAX_ZOOM)}]`);
  }

  /*
   * No separate length cap: `parseFiniteNumber` admits at most 26 characters per edge, so a valid
   * box is at most 107 characters, and any longer string fails the part count or an edge's
   * pattern with the same reason a cap would give. A mutation run showed the cap could not change
   * an outcome, and a check that cannot fail is a distinction a reader has to disprove.
   */
  const parts = (bboxRaw ?? '').split(',');
  const edges = parts.map((part) => parseFiniteNumber(part));
  if (parts.length !== 4 || edges.some((edge) => edge === null)) {
    collector.fail('bbox', 'must be four finite decimals: west,south,east,north');
  } else if (parts.some((part, index) => String(edges[index]) !== part)) {
    collector.fail('bbox', 'each edge must be written in its shortest form, e.g. 11.25 or -90');
  }
  collector.assertValid();

  const [west, south, east, north] = edges as [number, number, number, number];
  if (west < -180 || west >= 180) collector.fail('bbox', 'west must be within [-180, 180)');
  if (east <= -180 || east > 180) collector.fail('bbox', 'east must be within (-180, 180]');
  if (south < -90 || south > 90 || north < -90 || north > 90) {
    collector.fail('bbox', 'south and north must be within [-90, 90]');
  }
  collector.assertValid();
  if (south >= north) collector.fail('bbox', 'south must be less than north');
  if (west === east) collector.fail('bbox', 'west and east must differ');
  collector.assertValid();

  const bbox: BoundingBox = { west, south, east, north };
  const level = zoom ?? 0;
  const snapped = quantizeViewport(bbox, level);
  if (
    snapped.west !== west ||
    snapped.south !== south ||
    snapped.east !== east ||
    snapped.north !== north
  ) {
    collector.fail(
      'bbox',
      `edges must lie on this zoom's grid of ${String(quantizationStepDegrees(level))}°; ` +
        'snap outward before sending, so that nearby views share one cache key',
    );
  }
  collector.assertValid();

  if (!isViewportWithinLimit(bbox, level)) {
    throw new ApiProblemError({
      code: 'BBOX_TOO_LARGE',
      detail: `Below zoom 4 a viewport may span at most ${String(MAX_VIEWPORT_DEGREES)}° in each direction.`,
      invalidParams: [
        {
          name: 'bbox',
          reason: `must span at most ${String(MAX_VIEWPORT_DEGREES)}° of longitude and of latitude below zoom 4`,
        },
      ],
    });
  }

  return { bbox, zoom: level };
}

/** Re-exported so callers do not import the rounding rule from two places. */
export { USER_COORDINATE_DECIMALS };

export interface HistoryParam {
  readonly family: HazardFamily;
  readonly metric: HistoryMetric;
  readonly radiusKm: number;
}

/**
 * `family`, `metric` and `radius_km` for `/history` (§13.1).
 *
 * `family` is required: a chart is always of one family, and defaulting it would give a caller who
 * mistyped the name an earthquake chart instead of an error. `metric` and `radius_km` default to
 * the family's primary metric and that metric's default radius (§8.1: 150 km), and anything else
 * must be one of the values the metric was calibrated for — a radius of 151 km is a 400, never a
 * silently different baseline.
 */
export function parseHistory(search: URLSearchParams): HistoryParam {
  const rawFamily = search.get('family');
  if (rawFamily === null || !(HAZARD_FAMILIES as readonly string[]).includes(rawFamily)) {
    return invalid('family', `is required and must be one of: ${HAZARD_FAMILIES.join(', ')}`);
  }
  const family = rawFamily as HazardFamily;
  const offered = metricsFor(family);
  const metric = (search.get('metric') ?? offered[0]) as HistoryMetric | undefined;
  if (metric === undefined) return invalid('family', 'has no historical metric yet');
  if (!(offered as readonly string[]).includes(metric)) {
    return invalid('metric', `must be one of: ${offered.join(', ')}`);
  }

  const radii = radiiFor(metric);
  const rawRadius = search.get('radius_km');
  const radiusKm =
    rawRadius === null ? radii[0] : /^\d{1,3}$/u.test(rawRadius) ? Number(rawRadius) : null;
  if (radiusKm === undefined || radiusKm === null || !radii.includes(radiusKm)) {
    return invalid('radius_km', `must be one of: ${[...radii].sort((a, b) => a - b).join(', ')}`);
  }
  return { family, metric, radiusKm };
}

/** One failed parameter, reported the way `ParamCollector` reports several. */
function invalid(name: string, reason: string): never {
  throw new ApiProblemError({
    code: 'VALIDATION_FAILED',
    detail: 'One or more parameters did not satisfy the documented rules.',
    invalidParams: [{ name, reason }],
  });
}
