/**
 * `FIRE_TREND` — the last 7 days of thermal detections against the 28 before them, per covered
 * day (ARCHITECTURE §8.2). Labelled a **trend**, never "abnormal".
 *
 * Detection counts depend on overpasses, cloud and view angle as much as on fire, so a day FIRMS
 * reports as having no satellite data is **excluded** rather than counted as zero — a missing
 * overpass is not a quiet day. The band moves off `STABLE` only when the two daily means differ by
 * at least 50 % **and** by at least ten detections a day, so a jump from one detection to three is
 * not reported as fire activity trebling.
 */

import { BASELINE_METHOD_VERSION, FIRE_TREND } from './config.ts';

export type FireTrendBand = 'INCREASING' | 'STABLE' | 'DECREASING';
export type FireTrendStatus = 'OK' | 'INSUFFICIENT_COVERAGE';

export interface FireDay {
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  readonly detections: number;
  /** False when FIRMS reported no satellite data for the sensors this trend uses. */
  readonly covered: boolean;
}

export interface FireTrendResult {
  readonly methodVersion: string;
  readonly status: FireTrendStatus;
  readonly band: FireTrendBand | null;
  readonly recentMeanPerDay: number | null;
  readonly previousMeanPerDay: number | null;
  readonly recentCoveredDays: number;
  readonly previousCoveredDays: number;
  readonly interpretation: string;
}

/**
 * `days` must hold the last 35 days, oldest first: 28 previous, then 7 recent. A period with no
 * covered day at all has no mean, and the answer is `INSUFFICIENT_COVERAGE` — never a trend
 * computed from nothing.
 */
export function fireTrend(days: readonly FireDay[]): FireTrendResult {
  const expected = FIRE_TREND.previousDays + FIRE_TREND.recentDays;
  if (days.length !== expected) {
    throw new RangeError(
      `fireTrend: expected ${String(expected)} days, got ${String(days.length)}`,
    );
  }
  const previous = days.slice(0, FIRE_TREND.previousDays).filter((day) => day.covered);
  const recent = days.slice(FIRE_TREND.previousDays).filter((day) => day.covered);

  if (previous.length === 0 || recent.length === 0) {
    return {
      methodVersion: BASELINE_METHOD_VERSION,
      status: 'INSUFFICIENT_COVERAGE',
      band: null,
      recentMeanPerDay: null,
      previousMeanPerDay: null,
      recentCoveredDays: recent.length,
      previousCoveredDays: previous.length,
      interpretation:
        'Not enough satellite coverage in the last five weeks to compare fire activity here.',
    };
  }

  const recentMean = recent.reduce((total, day) => total + day.detections, 0) / recent.length;
  const previousMean = previous.reduce((total, day) => total + day.detections, 0) / previous.length;
  const difference = recentMean - previousMean;
  const relative =
    previousMean === 0 ? Number.POSITIVE_INFINITY : Math.abs(difference) / previousMean;
  const moved =
    relative >= FIRE_TREND.minimumRelativeChange &&
    Math.abs(difference) >= FIRE_TREND.minimumAbsolutePerDay;
  const band: FireTrendBand = !moved ? 'STABLE' : difference > 0 ? 'INCREASING' : 'DECREASING';

  const phrase =
    band === 'STABLE' ? 'about the same as' : band === 'INCREASING' ? 'more than' : 'fewer than';
  return {
    methodVersion: BASELINE_METHOD_VERSION,
    status: 'OK',
    band,
    recentMeanPerDay: recentMean,
    previousMeanPerDay: previousMean,
    recentCoveredDays: recent.length,
    previousCoveredDays: previous.length,
    interpretation:
      `Satellite thermal detections within ${String(FIRE_TREND.radiusKm)} km in the last 7 days: ` +
      `${formatRate(recentMean)} a day, ${phrase} the ${formatRate(previousMean)} a day of the 4 weeks before.`,
  };
}

function formatRate(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}
