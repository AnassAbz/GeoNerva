/**
 * @geonerva/domain — types, enumerations, Zod schemas, invariants, the evidence-id codec, the
 * source-health derivation and the frozen read-model contracts.
 *
 * This package depends on **nothing internal** and performs **no IO**: no database, no network,
 * no filesystem, no `process`, and no clock. Anything that needs "now" takes it as an argument,
 * which is what makes replay, health and the property tests deterministic
 * (docs/ARCHITECTURE.md §3, enforced by `.dependency-cruiser.cjs` and `eslint.config.js`).
 */

export * from './enums.ts';

export {
  DEFAULT_UNAVAILABLE_AFTER_S,
  INITIAL_FRESHNESS_POLICIES,
  freshnessPolicySchema,
  hasDataCurrencyPolicy,
  pollingPolicySchema,
  sourcePolicySchema,
} from './value-objects/freshness-policy.ts';
export type {
  FreshnessPolicy,
  InitialPolicyKey,
  PollingPolicy,
  SourcePolicy,
} from './value-objects/freshness-policy.ts';

export {
  MAX_BIGINT,
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_PREFIXES,
  PUBLIC_ID_TOKEN_LENGTH,
  databaseIdSchema,
  formatPublicId,
  isCountString,
  isDatabaseId,
  isPublicId,
  isSha256Hex,
  isUuid,
  parsePublicId,
  publicIdSchema,
  sha256HexSchema,
  uuidSchema,
} from './value-objects/ids.ts';
export type {
  DatabaseId,
  PublicIdParts,
  PublicIdPrefix,
  Sha256Hex,
  Uuid,
} from './value-objects/ids.ts';

export {
  DAY_MS,
  FUTURE_OBSERVATION_TOLERANCE_MS,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  elapsedSeconds,
  isObservedAtAcceptable,
  isValidityIntervalOrdered,
  isWithinValidity,
  isoTimestampSchema,
  parseIsoTimestamp,
  toIsoTimestamp,
  toIsoTimestampOrNull,
} from './value-objects/time.ts';
export type { IsoTimestamp, ValidityInterval } from './value-objects/time.ts';

export {
  GEOJSON_GEOMETRY_TYPES,
  MAX_LATITUDE,
  MAX_LONGITUDE,
  MAX_SEARCH_RADIUS_M,
  MIN_LATITUDE,
  MIN_LONGITUDE,
  USER_COORDINATE_DECIMALS,
  boundingBoxSchema,
  crossesAntimeridian,
  isNormalizedLongitude,
  isNullIsland,
  isValidLatitude,
  latLonSchema,
  latitudeSchema,
  longitudeSchema,
  radiusMetersSchema,
} from './value-objects/geography.ts';
export type {
  BoundingBox,
  GeoJsonGeometry,
  GeoJsonGeometryType,
  LatLon,
} from './value-objects/geography.ts';

export {
  LOCATION_KEY_KINDS,
  MAX_LOCATION_KEY_LENGTH,
  OSM_TYPES,
  familyCoverageSchema,
  formatCoordinateKey,
  formatNominatimKey,
  formatPlaceKey,
  isLocationKey,
  isPersistableLocationKey,
  locationKeyKind,
  locationKeySchema,
  parseLocationKey,
} from './value-objects/location.ts';
export type {
  CoverageByFamily,
  FamilyCoverage,
  LocationKeyKind,
  LocationRef,
  OsmType,
  ParsedLocationKey,
} from './value-objects/location.ts';

export {
  compareProviderSeverity,
  isElevatedSeverity,
  providerSeverityRank,
  providerSeveritySchema,
  severityScaleOf,
} from './value-objects/provider-severity.ts';
export type { ProviderSeverity } from './value-objects/provider-severity.ts';

export {
  SUBJECT_KINDS,
  formatSubjectRef,
  isSubjectRef,
  parseSubjectRef,
  subjectRefSchema,
} from './value-objects/subject-ref.ts';
export type { ParsedSubjectRef, SubjectKind, SubjectRef } from './value-objects/subject-ref.ts';

export {
  CONTENT_ADDRESSED_EVIDENCE_KINDS,
  EVIDENCE_KINDS,
  EvidenceIdError,
  PRIMARY_EVIDENCE_KINDS,
  evidenceId,
  evidenceIdKind,
  evidenceIdSchema,
  evidenceRefSchema,
  formatEvidenceId,
  isContentAddressedEvidenceKind,
  isEvidenceId,
  isPrimaryEvidenceKind,
  parseEvidenceId,
  tryParseEvidenceId,
} from './evidence/evidence-id.ts';
export type {
  ContentAddressedEvidenceKind,
  EvidenceId,
  EvidenceKind,
  EvidenceRef,
  PrimaryEvidenceKind,
} from './evidence/evidence-id.ts';

export {
  HAZARD_ATTRIBUTE_SCHEMAS,
  MAX_ATTRIBUTES_BYTES,
  P0_ATTRIBUTE_HAZARD_TYPES,
  droughtAttributesSchema,
  earthquakeAttributesSchema,
  floodAttributesSchema,
  isAttributesWithinSizeLimit,
  otherAttributesSchema,
  parseHazardAttributes,
  thermalActivityAttributesSchema,
  tropicalCycloneAttributesSchema,
  tsunamiAttributesSchema,
  volcanoAttributesSchema,
  weatherAlertAttributesSchema,
  wildfireEventAttributesSchema,
} from './attributes/hazard-attributes.ts';
export type {
  AttributesFor,
  DroughtAttributes,
  EarthquakeAttributes,
  FloodAttributes,
  HazardAttributes,
  HazardAttributesByType,
  OtherAttributes,
  ThermalActivityAttributes,
  TropicalCycloneAttributes,
  TsunamiAttributes,
  VolcanoAttributes,
  WeatherAlertAttributes,
  WildfireEventAttributes,
} from './attributes/hazard-attributes.ts';

export {
  SOURCE_HEALTH_REASONS,
  aggregateSourceHealth,
  deriveSourceHealth,
  isDataUnavailable,
} from './health/source-health.ts';
export type {
  DeriveSourceHealthInput,
  IngestionRunFact,
  SourceHealth,
  SourceHealthReason,
} from './health/source-health.ts';

export * from './read-models/index.ts';
