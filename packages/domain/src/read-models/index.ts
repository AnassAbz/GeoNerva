/**
 * Read-model contracts — **frozen at gate G2** (docs/IMPLEMENTATION_PLAN.md §2.4, rule 3).
 *
 * | Contract | Endpoint |
 * |---|---|
 * | `LocationBriefing` | `GET /api/v1/briefing` |
 * | `EventDetail` | `GET /api/v1/events/{publicId}` |
 * | `FireClusterDetail` | `GET /api/v1/fire-clusters/{publicId}` |
 * | `SourceStatus` | `GET /api/v1/sources/status` |
 * | `HistoryResponse` | `GET /api/v1/history` |
 * | `EvidenceItem` / `EvidenceDetail` | evidence manifests, `GET /api/v1/evidence/{id}` |
 * | `ProblemDetails` | every error response (`application/problem+json`) |
 * | `MapFeaturesResponse` | `GET /api/v1/events` |
 * | `PlaceSuggestResponse` / `PlaceSearchResponse` | `GET /api/v1/places/*` |
 * | `ReplayHorizonResponse` | `GET /api/v1/replay/horizon` |
 *
 * Changing a field after the freeze requires an orchestrator-approved ADR and a bump of
 * `READ_MODEL_SCHEMA_VERSION`. Adding an optional field is still a change: these types are
 * `readonly` and exact by intent, and mock generators in `packages/test-fixtures` are built
 * against them.
 */

export { READ_MODEL_SCHEMA_VERSION, UNAVAILABLE_REASONS, CHANGE_WINDOWS } from './common.ts';

export { toFreshnessPolicyView, toSourceHealthView } from './health-view.ts';

/*
 * Runtime schemas for the contracts above, each proved equivalent to its interface at compile
 * time. They exist so that P8's contract tests can check GeoNerva's own responses and so that the
 * OpenAPI document has something to be generated from; they are never used to validate a request.
 */
export {
  agreementSchema,
  aiBriefingViewSchema,
  aiSectionSchema,
  asOfContextSchema,
  attributionSchema,
  authoritativeBasisSchema,
  baselineMetricViewSchema,
  baselineReferenceSchema,
  briefingCopySchema,
  changeFacetSchema,
  changeSectionSchema,
  changeSignalViewSchema,
  confidenceViewSchema,
  correlationEvidenceDetailSchema,
  dataConfidenceSchema,
  dataQualityCheckViewSchema,
  evidenceDetailPayloadSchema,
  evidenceDetailSchema,
  evidenceItemSchema,
  factSchema,
  factValueSchema,
  familyCardSchema,
  fieldComparisonSchema,
  fireClusterVersionEvidenceDetailSchema,
  freshnessPolicyViewSchema,
  geoJsonGeometrySchema,
  geometryViewSchema,
  ingestionRunEvidenceDetailSchema,
  invalidParamSchema,
  locationBriefingSchema,
  locationRefSchema,
  locationSnapshotViewSchema,
  mapFeatureSchema,
  mapFeaturesResponseSchema,
  observationEvidenceDetailSchema,
  problemDetailsSchema,
  reasonSchema,
  relevanceAssessmentSchema,
  replayHorizonResponseSchema,
  replayHorizonSchema,
  runSummaryViewSchema,
  sensorRefSchema,
  snapshotOverallSchema,
  sourceHealthViewSchema,
  sourceProductViewSchema,
  sourceStatusEntrySchema,
  sourceStatusSchema,
  subjectSummarySchema,
  workerStatusViewSchema,
} from './schemas.ts';
export type { Exact, Expect } from './schemas.ts';
export type {
  Agreement,
  AsOfContext,
  Attribution,
  AuthoritativeBasis,
  BaselineMetricView,
  BaselineReference,
  BriefingCopy,
  ChangeFacet,
  ChangeSection,
  ChangeSignalView,
  ChangeWindow,
  ConfidenceView,
  DataConfidence,
  Fact,
  FactValue,
  FamilyCard,
  FieldComparison,
  FreshnessPolicyView,
  GeometryView,
  ReadModelSchemaVersion,
  Reason,
  RelevanceAssessment,
  ReplayHorizon,
  RunSummaryView,
  SensorRef,
  SourceHealthView,
  SourceProductView,
  SubjectSummary,
  UnavailableReason,
} from './common.ts';

export type {
  EvidenceDetail,
  EvidenceDetailPayload,
  EvidenceItem,
  CorrelationEvidenceDetail,
  FireClusterVersionEvidenceDetail,
  IngestionRunEvidenceDetail,
  ObservationEvidenceDetail,
} from './evidence-item.ts';

export type {
  AiBriefingView,
  AiSection,
  LocationBriefing,
  LocationSnapshotView,
  SnapshotOverall,
} from './location-briefing.ts';

export type {
  CorrelationDecisionView,
  CorrelationView,
  EventDetail,
  EventHeadline,
  EventObservationView,
  EventTimelineEntry,
  PossibleMatchView,
  RelatedEventRef,
} from './event-detail.ts';

export type {
  FireClusterDetail,
  FireClusterDetectionsView,
  FireClusterSummaryView,
  FireClusterVersionView,
  FireDetectionView,
} from './fire-cluster-detail.ts';

export type {
  DataQualityCheckView,
  SourceStatus,
  SourceStatusEntry,
  WorkerStatusView,
} from './source-status.ts';

export type {
  HistoryResponse,
  LargestRecentView,
  RarityStatementView,
  ReferenceBandsView,
  SequenceContextView,
  TimeSeriesPoint,
  TimeSeriesView,
} from './history-response.ts';

export {
  PROBLEM_CODES,
  PROBLEM_MEDIA_TYPE,
  PROBLEM_STATUS,
  PROBLEM_TYPE_BASE,
  problemTypeUri,
} from './problem.ts';
export type { InvalidParam, ProblemCode, ProblemDetails } from './problem.ts';

export type {
  MapFeature,
  MapFeaturesResponse,
  PlaceSearchResponse,
  PlaceSearchResult,
  PlaceSuggestResponse,
  PlaceSuggestion,
  ReplayHorizonResponse,
} from './map-and-places.ts';
