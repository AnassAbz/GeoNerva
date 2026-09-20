/**
 * NASA FIRMS (DATA_SOURCES §3) — the only source in v1 that carries a credential, and the only
 * one that puts it **in the URL path**.
 *
 * That single fact shapes this module more than anything else about FIRMS. A URL here is not
 * loggable, not quotable in an error, and not storable — and the ordinary reflex of "log the URL
 * on failure" would put a key in a log aggregator where nothing downstream would ever notice.
 * So:
 *
 *  - `firmsEndpoint()` is what anything observable gets: host and a **redacted** path, never the
 *    built URL. There is no code path that returns a URL to a caller who might log it.
 *  - `redactFirmsUrl` exists for the one place a URL can still escape — an error thrown from
 *    inside the HTTP client, which stores `context.host` — and is applied to anything that might
 *    carry one.
 *  - The key is validated before use, so a misconfigured deployment fails at the boundary rather
 *    than sending an almost-key to NASA and getting an error back that might quote it.
 *
 * **The keyless mode is a real mode, not a fallback nobody tested.** Without a `MAP_KEY` the
 * adapter reads the public 24-hour global CSVs, which need no credential at all. That is what
 * makes zero-config development possible, and it is also what this build runs on: the
 * `FIRMS_MAP_KEY` environment variable is optional by design (`.env.example`).
 *
 * The two modes differ in ways that matter and are not hidden:
 *
 *  - The keyless files are **not a strict 24 hours**. P0 measured a file modified at 20:40 UTC
 *    holding acquisitions from 00:01 the previous day to 18:34 the same day — about 42 hours,
 *    spanning two `acq_date`s, with the newest detection roughly two hours old. Anything
 *    reasoning about coverage must read the data, not the filename.
 *  - They are large: ≈ 10 MB and ≈ 128,000 rows per sensor.
 *  - There is no backfill: keyless gives you the last day or the last week and nothing else.
 */

import { SourceFetchError } from '@geonerva/http';

export const FIRMS_HOST = 'firms.modaps.eosdis.nasa.gov';

/** The two sensors v1 ingests. Suomi-NPP ends 2026-11-01 and MODIS is shutting down (ADR-009). */
export const FIRMS_SENSORS = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'] as const;
export type FirmsSensor = (typeof FIRMS_SENSORS)[number];

export function isFirmsSensor(value: string): value is FirmsSensor {
  return (FIRMS_SENSORS as readonly string[]).includes(value);
}

/** The keyless 24-hour global file for each sensor. NOAA-20 is J1, NOAA-21 is J2. */
const KEYLESS_PATHS: Readonly<Record<FirmsSensor, string>> = {
  VIIRS_NOAA20_NRT: '/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv',
  VIIRS_NOAA21_NRT: '/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv',
};

/**
 * A MAP_KEY, as FIRMS's own validator defines it: 32 lowercase alphanumerics.
 *
 * Checked before the key can reach a URL. A key with a stray newline from a copied secret would
 * otherwise be sent to NASA and come back as an error whose body this code would then have to be
 * careful never to quote — better to never send it.
 */
const MAP_KEY_PATTERN = /^[a-z0-9]{32}$/;

export function isValidMapKey(value: string): boolean {
  return MAP_KEY_PATTERN.test(value);
}

/** `DAY_RANGE` is documented as 1–5. Not 1–10, whatever older material says. */
export const FIRMS_MAX_DAY_RANGE = 5;

export interface FirmsAreaRequest {
  readonly sensor: FirmsSensor;
  readonly mapKey: string;
  /** 1–5. The routine poll uses 2, so consecutive polls overlap by a whole day. */
  readonly dayRange: number;
  /** `YYYY-MM-DD`. Omitted means "ending now". */
  readonly date?: string;
}

/**
 * Builds an Area API URL.
 *
 * **The result contains the MAP_KEY.** It must not be logged, stored, attached to an error, or
 * returned anywhere a caller might do any of those. It exists only to be handed to the HTTP
 * client. `firmsEndpoint` is what everything observable uses instead.
 */
export function firmsAreaUrl(request: FirmsAreaRequest): string {
  if (!isValidMapKey(request.mapKey)) {
    // Deliberately says nothing about the value — not its length, not a prefix, not a suffix.
    throw new SourceFetchError('CONFIG_ERROR', 'the FIRMS MAP_KEY is not a valid key', {
      host: FIRMS_HOST,
    });
  }
  if (
    !Number.isInteger(request.dayRange) ||
    request.dayRange < 1 ||
    request.dayRange > FIRMS_MAX_DAY_RANGE
  ) {
    throw new SourceFetchError(
      'CONFIG_ERROR',
      `DAY_RANGE ${request.dayRange} is outside the documented 1–${FIRMS_MAX_DAY_RANGE}`,
      { host: FIRMS_HOST },
    );
  }
  if (request.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(request.date)) {
    throw new SourceFetchError('CONFIG_ERROR', `${request.date} is not a YYYY-MM-DD date`, {
      host: FIRMS_HOST,
    });
  }
  const suffix = request.date === undefined ? '' : `/${request.date}`;
  return (
    `https://${FIRMS_HOST}/api/area/csv/${request.mapKey}/${request.sensor}/world/` +
    `${String(request.dayRange)}${suffix}`
  );
}

/** The keyless global 24-hour file. No credential is involved, so this URL is safe to show. */
export function firmsKeylessUrl(sensor: FirmsSensor): string {
  return `https://${FIRMS_HOST}${KEYLESS_PATHS[sensor]}`;
}

/**
 * What logs, errors and run rows are allowed to see.
 *
 * Host and a path with the key replaced by a fixed placeholder — never the real path segment,
 * not even truncated. A "first four characters" style redaction is a slow leak, and a key with
 * 32 characters of entropy does not need many samples to become guessable.
 */
export function firmsEndpoint(sensor: FirmsSensor, keyless: boolean): string {
  return keyless
    ? `${FIRMS_HOST}${KEYLESS_PATHS[sensor]}`
    : `${FIRMS_HOST}/api/area/csv/{MAP_KEY}/${sensor}/world`;
}

/**
 * Removes anything that looks like a MAP_KEY from text on its way out.
 *
 * The belt to `firmsEndpoint`'s braces. The HTTP client is careful and the adapter is careful,
 * but a provider can put a request URL into an error body, a redirect can carry one, and a
 * future caller can be less careful than this one — so the last step before text becomes a log
 * line or a stored `error_message` removes the shape of a key wherever it appears.
 *
 * Matches the key's own alphabet and length, which is narrow enough not to eat ordinary words and
 * wide enough to catch the key in a path, a query string or a sentence.
 */
export function redactFirmsUrl(text: string): string {
  return text.replace(/\b[a-z0-9]{32}\b/g, '{MAP_KEY}');
}

/**
 * How an invalid key comes back, which is **not the same on every endpoint**.
 *
 * P0 captured all three: the Area API answers HTTP **400** `text/plain` `Invalid MAP_KEY.`,
 * `data_availability` answers **401** with the same text, and `mapkey_status` answers **403**
 * `text/html`. A client that treated 400 as "bad request, our fault, do not retry" and 401 as
 * "authentication, retry with a refresh" would be wrong about both. All three mean one thing:
 * the credential is unusable and no retry will change that.
 *
 * The same message also covers an exhausted transaction budget — FIRMS does not distinguish
 * them — so the classification says what is known and not more.
 */
export function isInvalidKeyResponse(status: number, body: Uint8Array): boolean {
  if (status !== 400 && status !== 401 && status !== 403) return false;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(body.subarray(0, 512));
  return /invalid\s+map_key|exceeded your transaction/i.test(text);
}
