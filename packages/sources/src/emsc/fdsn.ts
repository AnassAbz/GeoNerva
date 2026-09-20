/**
 * The EMSC SeismicPortal FDSN event service (DATA_SOURCES §6.1).
 *
 * It speaks the same protocol as USGS's and behaves differently in the three places that decide
 * whether a backfill is complete. All three were measured live on 2026-09-20:
 *
 *  1. **Over-limit is silent.** `limit=25000` answers **HTTP 200** with `metadata.count: 20000`
 *     and exactly 20,000 features. USGS refuses the same situation with a 400. A splitter written
 *     against USGS's behaviour would therefore mark an over-large EMSC window `DONE`, having
 *     silently dropped everything past the twenty-thousandth row, and the plan would reach
 *     `COMPLETED` over a hole. Windows are sized from the `count` endpoint **before** fetching,
 *     and a response that comes back at the cap is refused rather than accepted.
 *  2. **`count` is a plain count.** `{"count": 97}` — no `maxAllowed`, no 200-with-`error`. It is
 *     also not bounded by `limit`: the whole catalogue answers `{"count": 1604478}`.
 *  3. **There is no deletion query.** `includedeleted` is HTTP 400, *Unknown request
 *     parameters(s)*. EMSC publishes retractions only on its websocket (`action: delete`), which
 *     needs a persistent worker and is out of scope here. The seeded `emsc/rts` product therefore
 *     does not declare `DELETIONS`, and this module offers no sweep — an absence that is
 *     documented rather than a capability that quietly does nothing.
 *
 * A fourth measurement shaped what is *not* sent. `orderby` is validated against the unanchored
 * pattern `time|time-asc|magnitude|magnitude-asc`, so `orderby=banana` is a clean 422 but
 * `orderby=time_asc` **passes validation** — it contains `time` — and then matches no known value,
 * returning rows in an arbitrary order with no error at all: it answered with a 2023 event where
 * `time` gives 2026 and `time-asc` gives 1998. A typo in an ordering parameter that silently
 * changes the ordering is the kind of thing that is discovered years later, so window queries send
 * no `orderby` at all. The whole window is taken or the window is refused; order never matters.
 */

import { z } from 'zod';

import type { HttpClient } from '@geonerva/http';

import type { HistoricalInterface, HistoricalRequestOptions } from '../historical.ts';

import { assertWindow, bridgeEndtime, FdsnQueryError, type FdsnWindow } from '../fdsn/window.ts';

export const EMSC_HOST = 'www.seismicportal.eu';
const EMSC_BASE = `https://${EMSC_HOST}/fdsnws/event/1`;

/**
 * The most rows one request will ever return.
 *
 * Not a documented parameter ceiling but an observed truncation point, which is why it is used as
 * a tripwire rather than as a page size: a response holding exactly this many rows is treated as
 * untrustworthy, because that is indistinguishable from a window that held more.
 */
export const EMSC_MAX_ROWS = 20_000;

/**
 * How full a window may be before the planner splits it rather than fetching it.
 *
 * Below the cap, not at it. The `count` is taken before the query and the catalogue keeps moving
 * underneath — a revision inside the window between the two calls adds rows — so sizing to exactly
 * 20,000 would occasionally produce a silently truncated fetch. 80 % leaves room for that.
 */
export const EMSC_WINDOW_TARGET = Math.floor(EMSC_MAX_ROWS * 0.8);

/** `format=geojson` is an HTTP 400 here. The GeoJSON representation is `format=json`. */
const FORMAT = 'json';

/**
 * A bounded historical query.
 *
 * The parameter list is closed, exactly as it is for USGS: a passthrough would let a caller turn
 * this into an arbitrary outbound request to a host the allowlist has already approved.
 */
export function emscQueryUrl(window: FdsnWindow): string {
  assertWindow(window);
  const params = new URLSearchParams({
    format: FORMAT,
    starttime: window.from.toISOString(),
    endtime: bridgeEndtime(window.to),
    limit: String(EMSC_MAX_ROWS),
  });
  if (window.minMagnitude !== undefined) {
    params.set('minmagnitude', String(window.minMagnitude));
  }
  return `${EMSC_BASE}/query?${params.toString()}`;
}

/** The exact number of events in a window, for deciding whether it can be fetched at all. */
export function emscCountUrl(window: FdsnWindow): string {
  return emscQueryUrl(window).replace('/query?', '/count?');
}

/**
 * The live poll.
 *
 * `updatedafter` rather than a window over origin time, because EMSC revises old events: a poll on
 * 2026-09-20 returned an event whose origin time was 2025-09-15, revised within the hour. A window
 * over origin time would never have seen that revision.
 *
 * The answer is **not ordered by `lastupdate`** — verified on the same poll, neither ascending nor
 * descending — so nothing here may assume the last row is the newest revision. The worker overlaps
 * its window generously instead and lets idempotency absorb the repeats.
 */
export function emscUpdatedAfterUrl(since: Date, limit = EMSC_MAX_ROWS): string {
  if (!Number.isFinite(since.getTime())) {
    throw new FdsnQueryError('updatedafter needs a real instant');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > EMSC_MAX_ROWS) {
    throw new FdsnQueryError(`limit must be a whole number in [1, ${EMSC_MAX_ROWS}], got ${limit}`);
  }
  const params = new URLSearchParams({
    format: FORMAT,
    updatedafter: since.toISOString(),
    limit: String(limit),
  });
  return `${EMSC_BASE}/query?${params.toString()}`;
}

/** Host and path only, for logs. Never carries a credential — EMSC needs none. */
export function emscEndpoint(kind: 'query' | 'count' = 'query'): string {
  return `${EMSC_HOST}/fdsnws/event/1/${kind}`;
}

const emscCountSchema = z.looseObject({ count: z.number().int().min(0) });

/**
 * Reads the `count` answer.
 *
 * Deliberately not `parseFdsnCount`: USGS answers an over-limit count with HTTP 200 and an
 * `error` field, and sharing one parser would mean either EMSC inherits a check that can never
 * fire or USGS loses the one that must. The shapes are one field apart; the semantics are not the
 * same shape at all.
 */
export function parseEmscCount(body: Uint8Array): number {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new FdsnQueryError('the EMSC count endpoint did not answer with JSON');
  }
  const parsed = emscCountSchema.safeParse(json);
  if (!parsed.success) {
    throw new FdsnQueryError(
      `the EMSC count answer changed shape: ${parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data.count;
}

/**
 * Whether a response must be assumed incomplete.
 *
 * The service gives no signal of its own, so the row count is the only evidence there is. Exactly
 * at the cap counts as truncated: a window that genuinely held 20,000 events and one that held
 * 200,000 produce indistinguishable answers, and guessing in favour of completeness would write a
 * partial window and call it whole.
 */
export function isTruncated(received: number): boolean {
  return received >= EMSC_MAX_ROWS;
}

/** Fetches a count. Separate from the query path so a planner cannot accidentally ingest. */
export async function emscCount(
  client: HttpClient,
  window: FdsnWindow,
  signal?: AbortSignal,
): Promise<number> {
  const response = await client.get(emscCountUrl(window), {
    ...(signal === undefined ? {} : { signal }),
  });
  return parseEmscCount(response.body);
}

/**
 * EMSC as a historical source.
 *
 * The two answers that differ from USGS are both here, and both follow from the same measurement:
 * this service does not refuse an over-large window, it truncates one.
 *
 *  - `overLimit` compares against `EMSC_WINDOW_TARGET`, not the cap. The count and the query are
 *    two requests and the catalogue moves between them, so sizing to exactly 20,000 would
 *    occasionally produce a silently truncated fetch that nothing could detect afterwards.
 *  - `isSizeRefusal` is `false` for every status, because there is no status to read. A failure
 *    here is a failure, and splitting on it would halve a healthy window over a transient outage.
 */
export const emscHistorical: HistoricalInterface = {
  endpoint: () => emscEndpoint('query'),
  count: async (window, options: HistoricalRequestOptions) => {
    const count = await emscCount(options.client, window, options.signal);
    return { count, overLimit: count > EMSC_WINDOW_TARGET };
  },
  fetch: async (window, options: HistoricalRequestOptions) => {
    const response = await options.client.get(emscQueryUrl(window), {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      body: response.body,
      httpStatus: response.status,
      bytes: response.bytes,
      attempts: response.attempts,
      durationMs: response.durationMs,
    };
  },
  isSizeRefusal: () => false,
};
