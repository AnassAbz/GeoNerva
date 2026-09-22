/**
 * @geonerva/baselines — Pure historical statistics: magnitude of completeness, empirical
 * percentiles, bands, fire trend (ARCHITECTURE §8).
 *
 * See docs/ARCHITECTURE.md §3 for this package's responsibility and allowed dependencies. Nothing
 * here reads a database or a clock: the caller reads the catalog as of a knowledge time and hands
 * it over, which is what makes a baseline reproducible for a replay.
 */

export {
  AFTERSHOCK_CAVEAT,
  BASELINE_METHOD_VERSION,
  EARTHQUAKE_BASELINE,
  EARTHQUAKE_ELEVATED_CAVEAT,
  FIRE_TREND,
  GDACS_CONTEXT,
} from './config.ts';

export {
  RETENTION_FLOOR_MAGNITUDE,
  estimateCompleteness,
  maximumCurvature,
} from './completeness.ts';
export type { Completeness, CompletenessMethod } from './completeness.ts';

export { earthquakeCountBaseline } from './earthquakes.ts';
export type {
  BaselineStatus,
  EarthquakeBand,
  EarthquakeCountInput,
  EarthquakeCountReference,
  EarthquakeCountResult,
  QuakeRecord,
} from './earthquakes.ts';

export { fireTrend } from './fire.ts';
export type { FireDay, FireTrendBand, FireTrendResult, FireTrendStatus } from './fire.ts';

export { gdacsContext } from './gdacs.ts';
export type { GdacsContextResult } from './gdacs.ts';

export { countPerWindow, mean, midRankPercentile, quantile } from './statistics.ts';
