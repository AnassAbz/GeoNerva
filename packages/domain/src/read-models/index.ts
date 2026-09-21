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
