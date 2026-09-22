/**
 * The FIRMS adapter — thermal detections, and the one source that does not produce observation
 * versions at all.
 *
 * **It is deliberately not a `SourceAdapter`.** Every other adapter answers "what does the
 * provider say about this event, and has it changed?" FIRMS answers a different question: 230,000
 * pixel detections a day, with no identifier, no revisions, and no concept of an event. They live
 * in `fire_detections` — a partitioned, bulk-loaded table — and their identity is
 * `(product, acquired_at, round(lat, 4), round(lon, 4))` rather than a provider key (ADR-011).
 *
 * Forcing that through `normalize → NormalizedRecord → observation_versions` would mean 230,000
 * content hashes a day, 230,000 alias rows, and a `source_records` table that is 99.9 % thermal
 * pixels — for facts that are never revised and whose whole retention model is "drop the
 * partition". `DOMAIN_MODEL` §4.9 says so directly: **no P0 adapter writes an observation version
 * with hazard type `THERMAL_ACTIVITY`**.
 *
 * What it *does* share is everything that makes ingestion trustworthy: the same descriptor, the
 * same HTTP client with the same host allowlist and size cap, the same batch verdict, the same
 * run row, the same reject rows, the same drift classes. The pipeline gives it a different
 * persist step, not a different set of rules.
 *
 * **Credentials.** This is the only source with one, and FIRMS puts it in the URL *path*. Nothing
 * here returns a URL to a caller: `endpoint()` is a redacted string, errors are rewritten through
 * `redactFirmsUrl`, and the key is validated before it can reach a request. Without a key the
 * adapter reads the public 24-hour files, which is a fully supported mode and the one this build
 * has been run against.
 */

import { SourceFetchError, type HttpClient } from '@geonerva/http';

import { payloadHash, type SourceDescriptor } from '../contract.ts';
import {
  FIRMS_HOST,
  firmsAreaUrl,
  firmsEndpoint,
  firmsKeylessUrl,
  isInvalidKeyResponse,
  redactFirmsUrl,
  type FirmsSensor,
} from './api.ts';
import { parseFirmsCsv, type FirmsParseResult } from './parse.ts';

/**
 * How many days each poll asks for when a key is available.
 *
 * Two, so consecutive polls overlap by a whole day. FIRMS revises nothing and the insert is
 * `ON CONFLICT DO NOTHING`, so the overlap costs a duplicate check per row and buys immunity to
 * a missed poll, a late satellite downlink, or a worker that was down for an hour.
 */
export const FIRMS_DAY_RANGE = 2;

export const firmsDescriptor = (sensor: FirmsSensor): SourceDescriptor => ({
  sourceId: 'firms',
  productCode: sensor,
  policyKey: 'firms:VIIRS_*',
  hazardType: 'THERMAL_ACTIVITY',
  // Matches the seeded product exactly. HISTORICAL_EVENTS is real *with a key*; the keyless mode
  // cannot backfill, which is a property of the mode and is reported by the runner, not here.
  capabilities: ['POINT_DETECTIONS', 'REALTIME_EVENTS', 'HISTORICAL_EVENTS'],
  allowedHosts: [FIRMS_HOST],
  /*
   * Longer than the JSON sources'. The keyless global file is ≈ 10 MB of CSV and the Area API
   * builds its answer on demand; a 30-second deadline would record a working provider as a
   * timeout on a slow morning.
   */
  timeoutMs: 120_000,
  /*
   * P0 measured 10.7 MB for a 128,000-row global file, and a 7-day file at ≈ 49 MB. 64 MB holds
   * the daily files with room for growth while still stopping a wrong URL from exhausting the
   * worker.
   */
  maxBytes: 64 * 1024 * 1024,
  /*
   * Nowhere on Earth is never burning. The captured global files hold ≈ 128,000 rows, so an empty
   * one is a file that was not written or a request that was refused — and "no fires detected
   * worldwide" would be the most misleading sentence this system could produce.
   */
  emptyBatchIsSuspicious: true,
  maxRejectRatio: 0.2,
});

export interface FirmsFetchOptions {
  readonly client: HttpClient;
  readonly sensor: FirmsSensor;
  /** Absent means keyless mode: the public 24-hour file, no credential, no backfill. */
  readonly mapKey?: string | undefined;
  readonly dayRange?: number;
  /** `YYYY-MM-DD`, with a key only. */
  readonly date?: string;
  readonly signal?: AbortSignal;
}

export interface FirmsBody {
  readonly body: Uint8Array;
  readonly httpStatus: number;
  readonly bytes: number;
  readonly payloadSha256: Buffer;
  /** Redacted. Never the built URL. */
  readonly endpoint: string;
  readonly attempts: number;
  readonly durationMs: number;
  readonly keyless: boolean;
  /** See `firmsReadWindow`. */
  readonly readWindow: { readonly from: Date; readonly to: Date };
}

/**
 * Fetches one sensor's detections.
 *
 * The invalid-key case is classified rather than retried. FIRMS returns three different statuses
 * for it depending on endpoint — 400 from the Area API, 401 from `data_availability`, 403 from
 * `mapkey_status` — and all three mean the same thing: the credential is unusable and no amount
 * of retrying will change that. `CONFIG_ERROR` is the class for "ours to fix, never self-heals"
 * (ADR-032), which is exactly right and is what makes the worker exit non-zero instead of sitting
 * there looking healthy.
 *
 * The same message covers an exhausted 5,000-per-10-minutes budget, because FIRMS does not
 * distinguish the two. The detail says so rather than guessing which it was.
 */
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * What one FIRMS request read (ADR-041).
 *
 *  - Keyless: the public file of the last 24 hours.
 *  - Area API, live: `DAY_RANGE` UTC days ending today, up to the request.
 *  - Area API with `date`: those whole days starting at `date`.
 */
export function firmsReadWindow(input: {
  readonly keyless: boolean;
  readonly dayRange: number;
  readonly date?: string | undefined;
  readonly requestedAt: Date;
}): { from: Date; to: Date } {
  if (input.keyless) {
    return { from: new Date(input.requestedAt.getTime() - DAY_MS), to: input.requestedAt };
  }
  if (input.date !== undefined) {
    const from = new Date(`${input.date}T00:00:00.000Z`);
    const to = new Date(
      Math.min(from.getTime() + input.dayRange * DAY_MS, input.requestedAt.getTime()),
    );
    return { from, to };
  }
  const today = Math.floor(input.requestedAt.getTime() / DAY_MS) * DAY_MS;
  return { from: new Date(today - (input.dayRange - 1) * DAY_MS), to: input.requestedAt };
}

export async function fetchFirms(options: FirmsFetchOptions): Promise<FirmsBody> {
  const mapKey = options.mapKey;
  const keyless = mapKey === undefined || mapKey.length === 0;
  const url = keyless
    ? firmsKeylessUrl(options.sensor)
    : firmsAreaUrl({
        sensor: options.sensor,
        mapKey,
        dayRange: options.dayRange ?? FIRMS_DAY_RANGE,
        ...(options.date === undefined ? {} : { date: options.date }),
      });

  const requestedAt = new Date();
  let response;
  try {
    response = await options.client.get(url, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof SourceFetchError) {
      /*
       * Rebuilt rather than rethrown, so that nothing derived from the URL can reach a log or a
       * run row. `SourceFetchError.context` holds a host rather than a URL, and the client
       * already discards non-2xx bodies — this is the third layer, and the one that would still
       * hold if either of the other two changed.
       */
      const status = error.context.status;
      if (status === 400 || status === 401 || status === 403) {
        throw new SourceFetchError(
          'CONFIG_ERROR',
          'FIRMS refused the credential; the MAP_KEY is invalid or its transaction budget is spent',
          { host: FIRMS_HOST, status },
        );
      }
      throw new SourceFetchError(error.errorClass, redactFirmsUrl(error.describe(), mapKey), {
        host: FIRMS_HOST,
        ...(status === undefined ? {} : { status }),
      });
    }
    throw error;
  }

  // A 200 carrying `Invalid MAP_KEY.` is not documented, and this costs one regex on 512 bytes.
  if (isInvalidKeyResponse(response.status, response.body)) {
    throw new SourceFetchError(
      'CONFIG_ERROR',
      'FIRMS refused the credential; the MAP_KEY is invalid or its transaction budget is spent',
      { host: FIRMS_HOST, status: response.status },
    );
  }

  return {
    body: response.body,
    httpStatus: response.status,
    bytes: response.bytes,
    payloadSha256: payloadHash(response.body),
    endpoint: firmsEndpoint(options.sensor, keyless),
    attempts: response.attempts,
    durationMs: response.durationMs,
    keyless,
    readWindow: firmsReadWindow({
      keyless,
      dayRange: options.dayRange ?? FIRMS_DAY_RANGE,
      date: options.date,
      requestedAt,
    }),
  };
}

/** Parses a body against this sensor's descriptor. */
export function parseFirms(body: Uint8Array, sensor: FirmsSensor): FirmsParseResult {
  const descriptor = firmsDescriptor(sensor);
  return parseFirmsCsv(body, {
    emptyIsSuspicious: descriptor.emptyBatchIsSuspicious,
    maxRejectRatio: descriptor.maxRejectRatio,
  });
}
