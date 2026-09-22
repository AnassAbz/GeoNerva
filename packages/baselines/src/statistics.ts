/**
 * The non-parametric statistics §8 asks for (principle 2: "empirical percentiles over historical
 * windows. Seismicity and fire activity are clustered, so they are not Poisson").
 */

/**
 * The mid-rank percentile of `observed` among `reference` values: the share strictly below, plus
 * half the share equal, times 100.
 *
 * Mid-rank is what makes ties and zero-heavy distributions behave. With fifty zero-count weeks
 * and an observed zero, a "fraction below" rule says p0 and a "fraction at or below" rule says
 * p100 — both confidently wrong. Mid-rank says p50: exactly typical, which is the truth.
 */
export function midRankPercentile(observed: number, reference: readonly number[]): number {
  if (reference.length === 0) throw new RangeError('midRankPercentile: empty reference');
  let below = 0;
  let equal = 0;
  for (const value of reference) {
    if (value < observed) below += 1;
    else if (value === observed) equal += 1;
  }
  return (100 * (below + equal / 2)) / reference.length;
}

/**
 * The `p`-th quantile (0–100) by linear interpolation between closest ranks — Hyndman & Fan
 * type 7, the default in R and NumPy, named here so that a number on the methodology page can be
 * reproduced by anyone with the same windows.
 */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError('quantile: empty input');
  if (!(p >= 0 && p <= 100)) throw new RangeError('quantile: p must be within [0, 100]');
  const sorted = [...values].sort((left, right) => left - right);
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('mean: empty input');
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Counts per non-overlapping window of `windowDays`, walking **backwards** from `end` (exclusive)
 * for `windows` windows. Index 0 is the window ending at `end`.
 *
 * Backwards from the current window's start, so every reference window has the same length as the
 * one it is compared with and none overlaps it — "all non-overlapping windows of length W in the
 * reference period, ending before the current window" (§8.1).
 */
export function countPerWindow(
  times: readonly Date[],
  options: { readonly end: Date; readonly windowDays: number; readonly windows: number },
): number[] {
  const windowMs = options.windowDays * 24 * 60 * 60 * 1000;
  const counts = new Array<number>(options.windows).fill(0);
  const endMs = options.end.getTime();
  for (const time of times) {
    const age = endMs - time.getTime();
    if (age <= 0) continue;
    const index = Math.floor((age - 1) / windowMs);
    if (index < options.windows) counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}
