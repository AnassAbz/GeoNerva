/**
 * Domain enumerations (docs/DOMAIN_MODEL.md §3).
 *
 * `erasableSyntaxOnly` forbids TypeScript `enum`, so every enumeration is a frozen `as const`
 * tuple plus a union type derived from it (ADR-026). The tuples are the single source of truth:
 * Zod schemas, database CHECK constraints and exhaustiveness checks all derive from them.
 *
 * Terminology is part of the type system (ADR-020): there is no `WILDFIRE` hazard type, only
 * `THERMAL_ACTIVITY` (satellite detections) and `WILDFIRE_EVENT` (an official burnt-area event).
 */

/** What kind of natural hazard a record describes. */
export const HAZARD_TYPES = [
  'EARTHQUAKE',
  /** FIRMS thermal detections and the clusters built from them. Never called "wildfire". */
  'THERMAL_ACTIVITY',
  /** GDACS WF: an official burnt-area event (≥ 5,000 ha). */
  'WILDFIRE_EVENT',
  'FLOOD',
  'TROPICAL_CYCLONE',
  'VOLCANO',
  'DROUGHT',
  'WEATHER_ALERT',
  /** Reserved; no v1 source produces it. */
  'TSUNAMI',
  'OTHER',
] as const;
export type HazardType = (typeof HAZARD_TYPES)[number];

/** The UI groups hazard types into families; one family renders as one card. */
export const HAZARD_FAMILIES = [
  'EARTHQUAKES',
  'FIRE_ACTIVITY',
  'FLOODS',
  'CYCLONES',
  'WEATHER_ALERTS',
  'OTHER',
] as const;
export type HazardFamily = (typeof HAZARD_FAMILIES)[number];

/** Family → hazard types. Exhaustive and disjoint; asserted by a unit test. */
export const HAZARD_TYPES_BY_FAMILY: Readonly<Record<HazardFamily, readonly HazardType[]>> = {
  EARTHQUAKES: ['EARTHQUAKE'],
  FIRE_ACTIVITY: ['THERMAL_ACTIVITY', 'WILDFIRE_EVENT'],
  FLOODS: ['FLOOD'],
  CYCLONES: ['TROPICAL_CYCLONE'],
  WEATHER_ALERTS: ['WEATHER_ALERT'],
  OTHER: ['VOLCANO', 'DROUGHT', 'TSUNAMI', 'OTHER'],
};

const FAMILY_BY_HAZARD_TYPE: Readonly<Record<HazardType, HazardFamily>> = Object.freeze(
  Object.fromEntries(
    HAZARD_FAMILIES.flatMap((family) =>
      HAZARD_TYPES_BY_FAMILY[family].map((hazard) => [hazard, family] as const),
    ),
  ) as Record<HazardType, HazardFamily>,
);

/** The family a hazard type belongs to. Total: every hazard type has exactly one family. */
export function familyOf(hazardType: HazardType): HazardFamily {
  return FAMILY_BY_HAZARD_TYPE[hazardType];
}

/**
 * What a source or product can do. Code branches on capabilities, never on source ids
 * (docs/ARCHITECTURE.md §3, rule 4).
 */
export const SOURCE_CAPABILITIES = [
  'REALTIME_EVENTS',
  'HISTORICAL_EVENTS',
  'EVENT_DETAILS',
  'EVENT_REVISIONS',
  'DELETIONS',
  'POLYGONS',
  'TRACKS',
  'FORECAST_GEOMETRY',
  'POINT_DETECTIONS',
  'OFFICIAL_WARNINGS',
  'IMPACT_ALERT_LEVELS',
  'CROSS_REFERENCES',
] as const;
export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number];

/** What the representative geometry of an observation version actually is. */
export const GEOMETRY_KINDS = [
  'EPICENTER',
  'DETECTION_PIXEL_CENTER',
  'REGION_POLYGON',
  'MODEL_AREA',
  'TRACK_OBSERVED',
  'TRACK_FORECAST',
  'WIND_BUFFER',
  'UNCERTAINTY_CONE',
  'CENTROID_ONLY',
  'THREAT_AREA',
] as const;
export type GeometryKind = (typeof GEOMETRY_KINDS)[number];

/**
 * Roles for the additional geometries attached to an observation version
 * (`observation_geometries.role`). Open-ended by design: an adapter may add a role with a
 * migration, but the P0 set is fixed so that the UI can style them.
 */
export const GEOMETRY_ROLES = [
  'affected_area',
  'global_area',
  'region',
  'track_observed',
  'track_forecast',
  'wind_60',
  'wind_90',
  'wind_120',
  'cone',
  'hull',
] as const;
export type GeometryRole = (typeof GEOMETRY_ROLES)[number];

/** Lifecycle of a single observation version, as the provider reports it. */
export const LIFECYCLE_STATUSES = [
  'ACTIVE',
  'UPDATED',
  'ENDED',
  'CANCELLED',
  'EXPIRED',
  /** Tombstone: the provider **explicitly** withdrew the record; previous content is copied. */
  'DELETED',
  /**
   * Tombstone by inference: the record vanished from a source that offers no deletion channel.
   * EMSC's FDSN API cannot be queried for deletions (only its websocket carries
   * `action: "delete"`, which v1 does not consume), so a `unid` that is absent from two
   * consecutive 7-day reconciles gets this status. It is deliberately distinct from `DELETED`:
   * GeoNerva inferred it, the provider did not say it.
   */
  'MISSING_FROM_SOURCE',
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/** Lifecycle statuses that mean "this record no longer stands". */
export const TOMBSTONE_LIFECYCLE_STATUSES = ['DELETED', 'MISSING_FROM_SOURCE'] as const;
export type TombstoneLifecycleStatus = (typeof TOMBSTONE_LIFECYCLE_STATUSES)[number];

/** True when a version is a tombstone rather than a live statement about the world. */
export function isTombstone(status: LifecycleStatus): boolean {
  return status === 'DELETED' || status === 'MISSING_FROM_SOURCE';
}

/**
 * Derived source health (docs/DOMAIN_MODEL.md §4.3, ADR-022). Never stored.
 *
 * The brief's "CONFLICTING" is deliberately absent: conflicts are a property of an event
 * (`AgreementLevel.CONFLICT`), not of a source.
 */
export const SOURCE_HEALTH_STATUSES = ['FRESH', 'DEGRADED', 'STALE', 'UNAVAILABLE'] as const;
export type SourceHealthStatus = (typeof SOURCE_HEALTH_STATUSES)[number];

/** Whether GeoNerva has a source for a place × family at all. Absence is stated, never implied. */
export const COVERAGE_LEVELS = ['COVERED', 'PARTIAL', 'NOT_COVERED'] as const;
export type CoverageLevel = (typeof COVERAGE_LEVELS)[number];

/**
 * How much attention an item deserves for a place. **Not** a probability of harm (ADR-017).
 * `CRITICAL` requires an authoritative basis; GeoNerva's own heuristics top out at `HIGH`.
 */
export const RELEVANCE_LEVELS = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;
export type RelevanceLevel = (typeof RELEVANCE_LEVELS)[number];

/** Rank of a relevance level, for `max()`-style comparisons. Higher means more attention. */
export const RELEVANCE_RANK: Readonly<Record<RelevanceLevel, number>> = {
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** How well the sources describing one canonical event agree. */
export const AGREEMENT_LEVELS = [
  'SINGLE_SOURCE',
  /** Only derived copies (e.g. GDACS earthquakes, which restate USGS) — not independent. */
  'DERIVED_ONLY',
  'AGREE',
  'MINOR_DIFFERENCES',
  'CONFLICT',
] as const;
export type AgreementLevel = (typeof AGREEMENT_LEVELS)[number];

/** Why a source record is attached to a canonical event. */
export const LINK_RELATIONS = ['PRIMARY', 'SAME_EVENT', 'DERIVED_COPY'] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

/** How the link was decided. `SEED` is for fixtures and scenario datasets. */
export const LINK_MATCH_KINDS = ['IDENTITY_REF', 'SPATIOTEMPORAL', 'SEED'] as const;
export type LinkMatchKind = (typeof LINK_MATCH_KINDS)[number];

/** Outcome of a pairwise correlation evaluation that did **not** produce a link. */
export const CORRELATION_DECISIONS = ['POSSIBLE_MATCH', 'NO_MATCH_CLOSE'] as const;
export type CorrelationDecision = (typeof CORRELATION_DECISIONS)[number];

/** Why an ingestion run started. */
export const RUN_TRIGGERS = ['SCHEDULE', 'MANUAL', 'BACKFILL', 'RECONCILE'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** Terminal (and initial) states of an ingestion run. Failed runs are committed as evidence. */
export const RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Run statuses that count as a successful poll for freshness purposes. */
export const SUCCESSFUL_RUN_STATUSES = ['SUCCEEDED', 'PARTIAL', 'SKIPPED'] as const;
export type SuccessfulRunStatus = (typeof SUCCESSFUL_RUN_STATUSES)[number];

/** Sanitized failure classes (docs/ARCHITECTURE.md §4.2). Never a provider message. */
export const ERROR_CLASSES = [
  'HTTP_4XX',
  'HTTP_5XX',
  'TIMEOUT',
  'TOO_LARGE',
  'SCHEMA_DRIFT',
  'EMPTY_SUSPICIOUS',
  'RATE_LIMITED',
  'DB_ERROR',
  /** The previous run's lease was still held and had to be expired. */
  'LEASE_EXPIRED',
  'UNKNOWN',
  /** DNS, connection or TLS failure: there was never an answer to time out on. */
  'NETWORK',
  /**
   * The allowlist, the private-address check or a refused redirect (ADR-032).
   *
   * A statement about GeoNerva, not about the provider: it means we are blind to this source.
   * Source health must not read it as "the source is down", and it never self-heals by retrying.
   */
  'CONFIG_ERROR',
  /** The caller cancelled — a worker shutting down. Not evidence about the provider at all. */
  'ABORTED',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/**
 * Failures that say something about the *provider*, for describing a failure to a reader.
 *
 * **This is not the health rule.** `deriveSourceHealth` counts every failed run except `ABORTED`,
 * including `CONFIG_ERROR` — a broken allowlist means we genuinely have no data, so the status
 * must fall (ADR-032). An earlier version of this comment said the opposite and was wrong; the
 * health function is the authority, and it is tested in both directions.
 */
export const PROVIDER_ERROR_CLASSES = [
  'HTTP_4XX',
  'HTTP_5XX',
  'TIMEOUT',
  'TOO_LARGE',
  'SCHEMA_DRIFT',
  'EMPTY_SUSPICIOUS',
  'RATE_LIMITED',
  'NETWORK',
] as const satisfies readonly ErrorClass[];

/** True when the class blames the provider rather than GeoNerva. Presentation only. */
export function isProviderFault(errorClass: ErrorClass): boolean {
  return (PROVIDER_ERROR_CLASSES as readonly ErrorClass[]).includes(errorClass);
}

/** Why a record was rejected at parse or normalize time (`ingestion_rejects.reason_code`). */
export const REJECT_REASON_CODES = [
  'SCHEMA_INVALID',
  'FUTURE_OBSERVATION',
  'COORDINATES_INVALID',
  'NULL_ISLAND',
  'MISSING_IDENTITY',
  'MISSING_OBSERVED_AT',
  'DUPLICATE_IN_BATCH',
  'UNSUPPORTED_HAZARD_TYPE',
] as const;
export type RejectReasonCode = (typeof REJECT_REASON_CODES)[number];

/** Lifecycle of a source product (a feed or a satellite sensor). */
export const PRODUCT_STATUSES = ['ACTIVE', 'RETIRING', 'RETIRED'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** How a product expresses detection confidence. VIIRS is categorical, MODIS numeric. */
export const CONFIDENCE_SCALES = ['CATEGORICAL', 'NUMERIC'] as const;
export type ConfidenceScale = (typeof CONFIDENCE_SCALES)[number];

/** Normalized VIIRS/MODIS detection confidence. The provider's raw value is kept alongside. */
export const CONFIDENCE_CLASSES = ['LOW', 'NOMINAL', 'HIGH'] as const;
export type ConfidenceClass = (typeof CONFIDENCE_CLASSES)[number];

/** Expected delivery latency band of a product (docs/DATA_SOURCES.md §3.3). */
export const LATENCY_CLASSES = ['URT', 'RT', 'NRT', 'STANDARD', 'MINUTES', 'HOURS'] as const;
export type LatencyClass = (typeof LATENCY_CLASSES)[number];

/** Lifecycle of a fire activity cluster (docs/DOMAIN_MODEL.md §4.10). */
export const FIRE_CLUSTER_STATUSES = ['ACTIVE', 'COOLING', 'INACTIVE', 'MERGED'] as const;
export type FireClusterStatus = (typeof FIRE_CLUSTER_STATUSES)[number];

/** Provider severity schemes. Provider semantics are preserved, never translated (§1.4). */
export const SEVERITY_SCHEMES = [
  'GDACS_ALERT',
  'PAGER',
  'ECCC_RISK_COLOUR',
  'CAP_SEVERITY',
] as const;
export type SeverityScheme = (typeof SEVERITY_SCHEMES)[number];

/** What a derivation run computed (`analysis_runs.kind`). */
export const ANALYSIS_KINDS = [
  'CORRELATION',
  'CLUSTERING',
  'SNAPSHOT',
  'BASELINE',
  'AI_BRIEFING',
  'RETENTION',
] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

/** Whether a family's data can be shown at all (docs/DOMAIN_MODEL.md §4.14). */
export const FAMILY_AVAILABILITIES = ['AVAILABLE', 'UNAVAILABLE', 'NOT_COVERED'] as const;
export type FamilyAvailability = (typeof FAMILY_AVAILABILITIES)[number];

/** Confidence in the data behind a family card (docs/ARCHITECTURE.md §9.7). Never a percentage. */
export const DATA_CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type DataConfidenceLevel = (typeof DATA_CONFIDENCE_LEVELS)[number];

/** Status of a baseline metric computation (docs/DOMAIN_MODEL.md §4.13, ARCHITECTURE §8.1). */
export const BASELINE_STATUSES = [
  'OK',
  /** ≥ 52 reference windows but < 20 reference events: report rarity, not a percentile. */
  'RARE_ACTIVITY',
  'INSUFFICIENT_HISTORY',
  'INSUFFICIENT_COVERAGE',
  'NOT_APPLICABLE',
] as const;
export type BaselineStatus = (typeof BASELINE_STATUSES)[number];

/** Where an observed value sits relative to its own history. */
export const BASELINE_BANDS = [
  'BELOW_TYPICAL',
  'TYPICAL',
  'ABOVE_TYPICAL',
  'WELL_ABOVE_TYPICAL',
] as const;
export type BaselineBand = (typeof BASELINE_BANDS)[number];

/** Direction bands for the P0 fire trend metric (docs/ARCHITECTURE.md §8.2). */
export const TREND_BANDS = ['INCREASING', 'STABLE', 'DECREASING'] as const;
export type TrendBand = (typeof TREND_BANDS)[number];

/** Kinds of change signal produced by diffing two snapshots (docs/DOMAIN_MODEL.md §4.15). */
export const CHANGE_TYPES = [
  'NEW_EVENT',
  'EVENT_UPDATED',
  'EVENT_ESCALATED',
  'EVENT_DEESCALATED',
  'EVENT_RESOLVED',
  'ACTIVITY_INCREASE',
  'ACTIVITY_DECREASE',
  'ABNORMAL_ACTIVITY',
  'SOURCE_STALE',
  'SOURCE_RECOVERED',
  'SOURCE_CONFLICT',
  'RELEVANCE_INCREASE',
  'RELEVANCE_DECREASE',
  'ENTERED_AREA',
  'LEFT_AREA',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** How prominently a change signal is shown (docs/ARCHITECTURE.md §10.4). */
export const CHANGE_PROMINENCES = ['HEADLINE', 'LISTED', 'DETAIL', 'SUPPRESSED'] as const;
export type ChangeProminence = (typeof CHANGE_PROMINENCES)[number];

/** Why a change signal was suppressed. Suppression is always explained, never silent. */
export const SUPPRESSION_REASONS = [
  'IMMATERIAL',
  'AGED_OUT',
  'LOW_RELEVANCE_BOTH',
  'HYSTERESIS',
  'FAMILY_NOT_COVERED',
  'GROUPED',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Headline verdict codes for a location (docs/ARCHITECTURE.md §9.8). */
export const HEADLINE_CODES = [
  'OFFICIAL_ALERT_AFFECTING_AREA',
  'HIGH_RELEVANCE_PRESENT',
  'DATA_UNAVAILABLE',
  'NO_HIGH_RELEVANCE_ITEMS',
] as const;
export type HeadlineCode = (typeof HEADLINE_CODES)[number];

/** Validation outcome of one runtime-AI call (P1, docs/DOMAIN_MODEL.md §4.16). */
export const AI_VALIDATION_STATUSES = ['PASSED', 'REPAIRED', 'REJECTED'] as const;
export type AiValidationStatus = (typeof AI_VALIDATION_STATUSES)[number];
