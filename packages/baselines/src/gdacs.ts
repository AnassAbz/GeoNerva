/**
 * `GDACS_CONTEXT` — how many GDACS events of a type there have been within 300 km in the last five
 * years (ARCHITECTURE §8.3). **Context, never an anomaly**: the counts are far too sparse for a
 * distribution, so there is no percentile and no band, only the count and the sentence.
 */

import { BASELINE_METHOD_VERSION, GDACS_CONTEXT } from './config.ts';

export interface GdacsContextResult {
  readonly methodVersion: string;
  readonly count: number;
  readonly sinceYear: number;
  readonly interpretation: string;
}

export function gdacsContext(input: {
  readonly asOf: Date;
  /** Singular and plural, e.g. `['flood event', 'flood events']`. */
  readonly noun: readonly [string, string];
  /** Events within the radius observed in the last five years, as known at `asOf`. */
  readonly count: number;
  /**
   * Where GeoNerva's unbroken GDACS record begins, when that is less than five years back. The
   * count then covers only that span, and the sentence says so rather than claiming five years.
   */
  readonly recordStart?: Date | null;
}): GdacsContextResult {
  const noun = input.count === 1 ? input.noun[0] : input.noun[1];
  const recordStart = input.recordStart ?? null;
  const within = `${String(input.count)} GDACS ${noun} within ${String(GDACS_CONTEXT.radiusKm)} km`;
  if (recordStart !== null) {
    return {
      methodVersion: BASELINE_METHOD_VERSION,
      count: input.count,
      sinceYear: recordStart.getUTCFullYear(),
      // The day, not the month: "since September 2026" for a record begun on the 29th would present
      // twenty-eight unread days as counted (review round 3).
      interpretation: `${within} since ${String(recordStart.getUTCDate())} ${MONTHS[recordStart.getUTCMonth()] ?? ''} ${String(recordStart.getUTCFullYear())}, when GeoNerva's GDACS record begins.`,
    };
  }
  const sinceYear = input.asOf.getUTCFullYear() - GDACS_CONTEXT.years;
  return {
    methodVersion: BASELINE_METHOD_VERSION,
    count: input.count,
    sinceYear,
    interpretation: `${within} since ${String(sinceYear)}.`,
  };
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
