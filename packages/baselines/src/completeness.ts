/**
 * Magnitude of completeness, Mc (ARCHITECTURE §8.1): the smallest magnitude above which a catalog
 * records essentially every event in a region.
 *
 * **Maximum curvature, +0.2.** Bin the magnitudes at 0.1, take the most populated bin, add 0.2 —
 * the standard correction, because maximum curvature is known to underestimate Mc. It needs at
 * least 50 events at or above the candidate, and below that the USGS global statement (M4.5)
 * stands in.
 *
 * **The retention floor.** ADR-035 keeps earthquake facts below M4.5 for 30 days only. A
 * reference period reaching further back therefore holds every recent event but only the M4.5+
 * ones before that, and counting a small quake in the current window against a reference that has
 * forgotten its peers would be comparing unlike with unlike — §8's first principle. So when the
 * reference extends past that horizon, the counting threshold is never below M4.5, and the reason
 * is returned so the completeness statement can say it.
 */

import { EARTHQUAKE_BASELINE } from './config.ts';

export type CompletenessMethod = 'MAXIMUM_CURVATURE' | 'FALLBACK' | 'RETENTION_FLOOR';

export interface Completeness {
  /** The threshold counts use. */
  readonly threshold: number;
  readonly method: CompletenessMethod;
  /** Events at or above the maximum-curvature candidate, when one was estimated. */
  readonly eventsAboveCandidate: number | null;
}

/** Magnitudes below this are retained for 30 days only (ADR-035). */
export const RETENTION_FLOOR_MAGNITUDE = 4.5;

export function estimateCompleteness(
  magnitudes: readonly number[],
  options: { readonly referenceBeyondRetention: boolean },
): Completeness {
  const config = EARTHQUAKE_BASELINE;
  const estimate = maximumCurvature(magnitudes);

  let threshold: number;
  let method: CompletenessMethod;
  if (estimate === null || estimate.eventsAbove < config.mcMinimumEvents) {
    threshold = config.mcFallback;
    method = 'FALLBACK';
  } else {
    threshold = estimate.mc;
    method = 'MAXIMUM_CURVATURE';
  }

  if (options.referenceBeyondRetention && threshold < RETENTION_FLOOR_MAGNITUDE) {
    threshold = RETENTION_FLOOR_MAGNITUDE;
    method = 'RETENTION_FLOOR';
  }

  return { threshold, method, eventsAboveCandidate: estimate?.eventsAbove ?? null };
}

/**
 * The maximum-curvature candidate: the most populated 0.1 bin plus the correction. Ties go to the
 * **smaller** magnitude — the lower candidate keeps more events, and the minimum-events rule is
 * what refuses a candidate the data cannot support. `null` for an empty catalog.
 */
export function maximumCurvature(
  magnitudes: readonly number[],
): { readonly mc: number; readonly eventsAbove: number } | null {
  const valid = magnitudes.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return null;
  const bins = new Map<number, number>();
  for (const value of valid) {
    // Integer tenths, so 4.49999 and 4.5 cannot land in different bins through float error.
    const bin = Math.round(value * 10);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  let modeBin = Number.POSITIVE_INFINITY;
  let modeCount = -1;
  for (const [bin, count] of bins) {
    if (count > modeCount || (count === modeCount && bin < modeBin)) {
      modeBin = bin;
      modeCount = count;
    }
  }
  const mcTenths = modeBin + Math.round(EARTHQUAKE_BASELINE.mcCorrection * 10);
  const mc = mcTenths / 10;
  const eventsAbove = valid.filter((value) => Math.round(value * 10) >= mcTenths).length;
  return { mc, eventsAbove };
}
