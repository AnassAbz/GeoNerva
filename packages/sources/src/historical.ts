/**
 * The historical interface — what a backfill needs from a source, and nothing else.
 *
 * The G4 review recorded that the pipeline imported USGS FDSN functions directly, and deliberately
 * left it: an abstraction invented for one implementation is a guess about the second. EMSC is the
 * second, and it turned out to disagree with USGS on the one question the backfill loop is built
 * around — *how does this service tell me a window is too big?*
 *
 *  - **USGS says so.** An over-large query is HTTP 400, the `count` endpoint answers 200 with an
 *    `error` field, and P0 saw 503 *table is full*. The loop can react to a refusal.
 *  - **EMSC does not say.** `limit=25000` returns HTTP 200 with exactly 20,000 rows and no marker
 *    of any kind (measured 2026-09-20). There is no refusal to react to, so the count *is* the
 *    gate, and a response that comes back at the cap is refused by the parser as a backstop.
 *
 * A single shared implementation would have had to pick one of those, and either choice is a
 * silent hole in the other catalogue. So the interface is the question, and each source answers it
 * in its own terms. `isSizeRefusal` returning `false` for every status is a real answer meaning
 * "this service never refuses; trust the count" — not a stub.
 *
 * What is deliberately *not* here: deletions. USGS has `includedeleted`; EMSC answers HTTP 400 for
 * it and publishes retractions only on a websocket. A capability one of two sources has does not
 * belong in the interface both implement — `runDeletionSweep` takes the USGS query layer directly,
 * and the seeded capabilities are what decide whether a sweep may run at all.
 */

import type { HttpClient } from '@geonerva/http';

import type { FdsnWindow } from './fdsn/window.ts';

/** Everything a historical request needs beyond the window itself. */
export interface HistoricalRequestOptions {
  readonly client: HttpClient;
  readonly signal?: AbortSignal;
}

/** A raw provider answer for one window, before parsing. */
export interface HistoricalBody {
  readonly body: Uint8Array;
  readonly httpStatus: number;
  readonly bytes: number;
  readonly attempts: number;
  readonly durationMs: number;
}

export interface HistoricalCount {
  /** How many records the provider says the window holds. */
  readonly count: number;
  /**
   * Whether the window must be split before it is fetched.
   *
   * For a service that refuses an over-large query this is a convenience; for one that truncates
   * silently it is the only protection there is.
   */
  readonly overLimit: boolean;
}

export interface HistoricalInterface {
  /** Host and path only, for logs. Never a full URL — a query can carry a key elsewhere. */
  endpoint(): string;
  /** Asks how many rows a window holds, before paying for them. */
  count(window: FdsnWindow, options: HistoricalRequestOptions): Promise<HistoricalCount>;
  fetch(window: FdsnWindow, options: HistoricalRequestOptions): Promise<HistoricalBody>;
  /**
   * Whether a failed run's HTTP status means "this window holds more than I will return".
   *
   * Answering `false` for everything is a valid and meaningful answer: it says this service does
   * not refuse over-large windows, so a failure is a failure and must never be mistaken for a
   * splitting signal. Splitting on an ordinary outage halves a healthy window permanently.
   */
  isSizeRefusal(httpStatus: number | null): boolean;
}
