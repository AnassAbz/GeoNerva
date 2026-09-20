/**
 * @geonerva/relevance — Pure hazard relevance, availability and data-confidence rules.
 *
 * Pure: no clock, no IO, no database. Health, coverage and counts arrive as arguments, which is
 * what makes every rule here testable without a provider and re-derivable from a stored snapshot.
 *
 * See docs/ARCHITECTURE.md §3 for this package's responsibility and allowed dependencies.
 */

export {
  AVAILABILITY_REASONS,
  highestRelevance,
  resolveAvailability,
  resolveDataConfidence,
} from './availability.ts';
export type {
  AvailabilityInput,
  AvailabilityReason,
  AvailabilityVerdict,
  DataConfidenceInput,
  SourceAvailabilityInput,
} from './availability.ts';

export { demote, promoteWithinHeuristics, reason } from './assessment.ts';
export type { Assessment, Reason } from './assessment.ts';

export {
  AUTHORITATIVE_ALERT_RADIUS_KM,
  DEEP_FOCUS_KM,
  EARTHQUAKE_BANDS,
  EARTHQUAKE_MODEL_VERSION,
  FELT_REPORTS_THRESHOLD,
  assessEarthquake,
  hypocentralDistanceKm,
} from './earthquake.ts';
export type { EarthquakeInput } from './earthquake.ts';
