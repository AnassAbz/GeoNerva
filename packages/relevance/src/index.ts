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

export {
  CYCLONE_MODEL_VERSION,
  CYCLONE_TRACK_KM,
  FLOOD_CENTROID_ONLY_KM,
  FLOOD_MODEL_VERSION,
  FLOOD_MODELLED_AREA_CAVEAT,
  FLOOD_NEAR_AREA_KM,
  FLOOD_OUTER_KM,
  THERMAL_DETECTION_CAVEAT,
  VOLCANO_MODEL_VERSION,
  VOLCANO_NEAR_KM,
  VOLCANO_OUTER_KM,
  assessCyclone,
  assessFlood,
  assessVolcano,
} from './gdacs-families.ts';
export type { CycloneInput, FloodInput, GdacsAlertLevel, VolcanoInput } from './gdacs-families.ts';

export {
  FIRE_GROWTH_FLOOR,
  FIRE_HIGH_DETECTIONS_24H,
  FIRE_HIGH_OVERPASSES_24H,
  FIRE_MID_KM,
  FIRE_MODEL_VERSION,
  FIRE_NEAR_KM,
  FIRE_OFFICIAL_ALERT_KM,
  FIRE_OUTER_KM,
  assessFire,
} from './fire.ts';
export type { FireClusterState, FireInput } from './fire.ts';
