/**
 * @geonerva/changes — Pure snapshot diff producing ChangeSignals with importance and prominence.
 *
 * Pure: no clock, no IO, no database. Two snapshots arrive as arguments, which is what makes
 * "What Changed?" testable without a provider and re-derivable from stored snapshots.
 *
 * See docs/ARCHITECTURE.md §10 for the classifier and §3 for this package's allowed dependencies.
 */

export {
  ACTIVITY_ABS_MIN,
  ACTIVITY_RELATIVE_FRACTION,
  DELTA_WEIGHT,
  IMPORTANCE_BASE,
  LEVEL_WEIGHT,
  MATERIALITY,
  MAX_HEADLINE,
  PROMINENCE_BANDS,
  RECENCY_WEIGHT,
} from './config.ts';

export { diffSnapshots, titleFor as changeTitleFor } from './classify.ts';
export type { ChangeFacetValue, ChangeSignal, DiffOptions, DiffResult } from './classify.ts';
