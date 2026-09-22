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
}): GdacsContextResult {
  const sinceYear = input.asOf.getUTCFullYear() - GDACS_CONTEXT.years;
  const noun = input.count === 1 ? input.noun[0] : input.noun[1];
  return {
    methodVersion: BASELINE_METHOD_VERSION,
    count: input.count,
    sinceYear,
    interpretation: `${String(input.count)} GDACS ${noun} within ${String(GDACS_CONTEXT.radiusKm)} km since ${String(sinceYear)}.`,
  };
}
