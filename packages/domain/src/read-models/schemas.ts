/**
 * Runtime schemas for the frozen read-model contracts, **proved equivalent to the interfaces**.
 *
 * ### Why this file exists, and why it is not a second source of truth
 *
 * The read models were frozen at G2 as TypeScript interfaces, which vanish at run time. P8's plan
 * asks for "OpenAPI generated from Zod" and "API contract tests (Zod ↔ OpenAPI)", and both need a
 * schema that exists while the process is running. Writing one by hand normally means two
 * descriptions of one contract, drifting apart — precisely the failure this project avoids
 * elsewhere by having exactly one implementation of anything that matters.
 *
 * So each schema carries a **compile-time proof** that its inferred type is the frozen interface,
 * in both directions:
 *
 * ```ts
 * export type SourceStatusMatches = Expect<Exact<z.infer<typeof sourceStatusSchema>, SourceStatus>>;
 * ```
 *
 * `Expect<T extends true>` fails to compile when `Exact` resolves to `false`. Add a field to the
 * interface and the schema stops matching; add one to the schema and it stops matching the other
 * way. There is still one contract; this file is a second *encoding* of it that cannot drift
 * silently, because `pnpm typecheck` is what stops it.
 *
 * ### What the schemas are for, and what they are not for
 *
 * They exist to **check GeoNerva's own output** — the contract tests parse every integration
 * response through the schema for its endpoint, which is the only way invariants like "every
 * response carries a schemaVersion" become mechanical rather than aspirational — and to generate
 * the OpenAPI document.
 *
 * They are **not** input validation. Request parameters are validated by `apps/web/lib/server/
 * params.ts` against ARCHITECTURE §13.2, which has rules no response schema expresses (coordinate
 * rounding, unknown-parameter rejection, length caps). Nothing here should ever be pointed at a
 * query string.
 *
 * ### Modifiers are normalized before comparison
 *
 * `z.infer` produces mutable types; the interfaces are `readonly` throughout. `readonly` on a
 * property does not affect assignability, but `T[]` and `readonly T[]` are not mutually
 * assignable — so the comparison strips modifiers on both sides with `DeepMutable`. The check is
 * therefore about *shape*, which is what crosses the wire; JSON has no notion of `readonly`.
 */

import { z } from 'zod';

import {
  AGREEMENT_LEVELS,
  FIELD_COMPARISON_CODES,
  BASELINE_BANDS,
  TREND_BANDS,
  BASELINE_STATUSES,
  CHANGE_PROMINENCES,
  CHANGE_TYPES,
  CONFIDENCE_CLASSES,
  DATA_CONFIDENCE_LEVELS,
  ERROR_CLASSES,
  FAMILY_AVAILABILITIES,
  FIRE_CLUSTER_STATUSES,
  GEOMETRY_KINDS,
  GEOMETRY_ROLES,
  HAZARD_FAMILIES,
  HAZARD_TYPES,
  HEADLINE_CODES,
  LIFECYCLE_STATUSES,
  LINK_MATCH_KINDS,
  LINK_RELATIONS,
  PRODUCT_STATUSES,
  RELEVANCE_LEVELS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  SOURCE_CAPABILITIES,
  SOURCE_HEALTH_STATUSES,
  SUPPRESSION_REASONS,
  type HazardFamily,
} from '../enums.ts';
import { EVIDENCE_KINDS } from '../evidence/evidence-id.ts';
import { SOURCE_HEALTH_REASONS } from '../health/source-health.ts';
import {
  GEOJSON_GEOMETRY_TYPES,
  USER_COORDINATE_DECIMALS,
  type GeoJsonGeometry,
} from '../value-objects/geography.ts';
import { familyCoverageSchema, type LocationRef } from '../value-objects/location.ts';
import { providerSeveritySchema } from '../value-objects/provider-severity.ts';
import { CHANGE_WINDOWS, READ_MODEL_SCHEMA_VERSION } from './common.ts';
import type {
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
  ConfidenceView,
  DataConfidence,
  Fact,
  FactValue,
  FamilyCard,
  FieldComparison,
  FreshnessPolicyView,
  GeometryView,
  Reason,
  RelevanceAssessment,
  ReplayHorizon,
  RunSummaryView,
  SensorRef,
  SourceHealthView,
  SourceProductView,
  SubjectSummary,
} from './common.ts';
import { PROBLEM_CODES, type ProblemDetails, type InvalidParam } from './problem.ts';
import type {
  CorrelationEvidenceDetail,
  EvidenceDetail,
  EvidenceDetailPayload,
  EvidenceItem,
  FireClusterVersionEvidenceDetail,
  FireDetectionSetEvidenceDetail,
  IngestionRunEvidenceDetail,
  ObservationEvidenceDetail,
  RawPayloadView,
} from './evidence-item.ts';
import { RAW_PAYLOAD_STATES } from './evidence-item.ts';
import type {
  AiBriefingView,
  AiSection,
  LocationBriefing,
  LocationSnapshotView,
  SnapshotOverall,
} from './location-briefing.ts';
import type {
  CorrelationDecisionView,
  CorrelationView,
  EventDetail,
  EventHeadline,
  EventObservationView,
  EventTimelineEntry,
  PossibleMatchView,
  RelatedEventRef,
} from './event-detail.ts';
import type {
  FireClusterDetail,
  FireClusterDetectionsView,
  FireClusterSummaryView,
  FireClusterVersionView,
  FireDetectionView,
} from './fire-cluster-detail.ts';
import type {
  HistoryResponse,
  LargestRecentView,
  RarityStatementView,
  ReferenceBandsView,
  SequenceContextView,
  TimeSeriesPoint,
  TimeSeriesView,
} from './history-response.ts';
import type {
  MapFeature,
  MapFeaturesResponse,
  PlaceSearchResponse,
  PlaceSearchResult,
  PlaceSuggestResponse,
  PlaceSuggestion,
  ReplayHorizonResponse,
} from './map-and-places.ts';
import type {
  DataQualityCheckView,
  SourceStatus,
  SourceStatusEntry,
  WorkerStatusView,
} from './source-status.ts';

/*
 * ── The equivalence proof ──────────────────────────────────────────────────────
 */

/** Strips `readonly` everywhere, so the comparison is about shape rather than modifiers. */
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends Date
    ? T
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T;

/** `true` only when the two types are mutually assignable after normalization. */
export type Exact<A, B> = [DeepMutable<A>] extends [DeepMutable<B>]
  ? [DeepMutable<B>] extends [DeepMutable<A>]
    ? true
    : false
  : false;

/** Fails to compile unless `T` is `true`. This is what makes the proofs above load-bearing. */
export type Expect<T extends true> = T;

/*
 * ── Primitives ────────────────────────────────────────────────────────────────
 *
 * `IsoTimestamp`, `EvidenceId` and `SubjectRef` are all `string` aliases, so the *type* check
 * cannot distinguish them. The patterns below are therefore doing real work at run time that the
 * compiler cannot: a `null` where a timestamp belongs, or a bare number where an evidence id
 * belongs, is caught by the schema and by nothing else.
 */

/** ISO-8601 in UTC with milliseconds and a `Z` suffix — the one form read models use. */
const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, 'must be an ISO-8601 UTC instant');

/** `EV:<KIND>:<body>`. The codec's grammar is stricter; this is the shape on the wire. */
const evidenceId = z.string().regex(new RegExp(`^EV:(?:${EVIDENCE_KINDS.join('|')}):\\S+$`, 'u'));

/** `CE:`, `FC:`, `SRC:` or `MET:` followed by an identifier. */
const subjectRef = z.string().regex(/^(?:CE|FC|SRC|MET):\S+$/u);

const schemaVersion = z.literal(READ_MODEL_SCHEMA_VERSION);

/**
 * A subject's deep link: a PRODUCT §6.1 route, `/event/<publicId>` or `/fire/<publicId>`.
 *
 * Checked here because the briefing emitted `/events/…` and `/fires/…` — pages that do not exist —
 * from five places for three phases, and nothing noticed until a UI tried to follow one (P9).
 */
const subjectHref = z.string().regex(/^\/(?:event|fire)\/[A-Z]{2}-\d{2}-[0-9A-Z]{4,12}$/u);

/**
 * A GeoJSON geometry, annotated rather than inferred.
 *
 * `GeoJsonGeometry` is self-referential (`geometries?: readonly GeoJsonGeometry[]`) and has an
 * optional `unknown` field, which `z.infer` cannot reproduce exactly. Annotating the schema with
 * `z.ZodType<GeoJsonGeometry>` makes the equivalence hold by construction instead of by proof,
 * which is the honest way to say "the compiler checked this one differently".
 */
export const geoJsonGeometrySchema: z.ZodType<GeoJsonGeometry> = z.lazy(() =>
  z.object({
    type: z.enum(GEOJSON_GEOMETRY_TYPES),
    coordinates: z.unknown().optional(),
    geometries: z.array(geoJsonGeometrySchema).optional(),
  }),
);

/** A `Readonly<Record<HazardFamily, T>>`: every family present, none extra. */
function byFamily<T extends z.ZodType>(value: T): z.ZodObject<Record<HazardFamily, T>> {
  return z.object(
    Object.fromEntries(HAZARD_FAMILIES.map((family) => [family, value])) as Record<HazardFamily, T>,
  );
}

/**
 * A coordinate carrying at most `USER_COORDINATE_DECIMALS` decimals (invariant I15).
 *
 * The check is on the value's **serialization**, because that is what leaves the server:
 * `Number(value.toFixed(2)) === value` holds exactly when the shortest JSON rendering of the
 * double has at most two decimals. 31.629512 fails; 31.63, -8 and 0 pass.
 *
 * A tolerance-based version — "within 1e-9 of a hundredth" — was written first and accepted
 * `31.630000000000003`, a float artefact carrying no positional information (about three
 * nanometres) that nonetheless serializes as fifteen decimals. I15 exists so that a response
 * cannot *appear* to know where someone is to the metre, so the rendering is the thing to
 * constrain.
 *
 * Checked over the whole two-decimal grid from -180 to 180 and over 36,001 rounded arbitrary
 * values: `Math.round(x * 100) / 100` always satisfies this, so a properly rounded coordinate is
 * never rejected.
 */
function roundedCoordinate(min: number, max: number): z.ZodNumber {
  return z
    .number()
    .min(min)
    .max(max)
    .refine((value) => Number(value.toFixed(USER_COORDINATE_DECIMALS)) === value, {
      message: `must carry at most ${String(USER_COORDINATE_DECIMALS)} decimals (I15)`,
    });
}

/*
 * ── Shared building blocks ────────────────────────────────────────────────────
 */

export const factValueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('number'),
    value: z.number(),
    unit: z.string().nullable(),
    decimals: z.number().int().min(0).max(12),
  }),
  z.object({ kind: z.literal('count'), value: z.number().int() }),
  z.object({ kind: z.literal('text'), value: z.string() }),
  z.object({ kind: z.literal('severity'), severity: providerSeveritySchema }),
  z.object({ kind: z.literal('timestamp'), value: isoTimestamp }),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum([
      'NOT_REPORTED_BY_SOURCE',
      'SOURCE_UNAVAILABLE',
      'NOT_COVERED',
      'INSUFFICIENT_HISTORY',
      'NOT_APPLICABLE',
      'BEYOND_REPLAY_HORIZON',
    ]),
  }),
]);
export type FactValueMatches = Expect<Exact<z.infer<typeof factValueSchema>, FactValue>>;

export const factSchema = z.object({
  code: z.string(),
  label: z.string(),
  value: factValueSchema,
  evidenceIds: z.array(evidenceId),
});
export type FactMatches = Expect<Exact<z.infer<typeof factSchema>, Fact>>;

export const reasonSchema = z.object({
  code: z.string(),
  text: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  evidenceIds: z.array(evidenceId),
});
export type ReasonMatches = Expect<Exact<z.infer<typeof reasonSchema>, Reason>>;

export const authoritativeBasisSchema = z.object({
  sourceId: z.string(),
  sourceName: z.string(),
  severity: providerSeveritySchema,
  statementVerbatim: z.string().nullable(),
  url: z.string().nullable(),
  evidenceId,
});
export type AuthoritativeBasisMatches = Expect<
  Exact<z.infer<typeof authoritativeBasisSchema>, AuthoritativeBasis>
>;

/**
 * Relevance, with invariant **I10** enforced by the schema rather than only by the engine.
 *
 * `CRITICAL` requires an `authoritativeBasis` and every other level forbids one. The engine
 * already guarantees this; encoding it here means a response that violated it would fail its own
 * contract test, which is a second, independent check on the claim that matters most — GeoNerva
 * never raises the loudest level on its own authority.
 */
export const relevanceAssessmentSchema = z
  .object({
    level: z.enum(RELEVANCE_LEVELS),
    reasons: z.array(reasonSchema),
    authoritativeBasis: authoritativeBasisSchema.nullable(),
    caveats: z.array(z.string()),
    evidenceIds: z.array(evidenceId),
    modelVersion: z.string(),
  })
  .refine((value) => (value.level === 'CRITICAL') === (value.authoritativeBasis !== null), {
    message: 'CRITICAL requires an authoritative basis, and no other level may carry one (I10)',
    path: ['authoritativeBasis'],
  });
export type RelevanceAssessmentMatches = Expect<
  Exact<z.infer<typeof relevanceAssessmentSchema>, RelevanceAssessment>
>;

export const fieldComparisonSchema = z.object({
  /*
   * The enum the builder emits, not `z.string()`. See `FIELD_COMPARISON_CODES` for why this is a
   * narrowing of the frozen contract rather than a change to it, and for what is deliberately not
   * in the list.
   */
  code: z.enum(FIELD_COMPARISON_CODES),
  label: z.string(),
  values: z.array(
    z.object({
      sourceId: z.string(),
      contributor: z.string().nullable(),
      value: factValueSchema,
      evidenceId,
    }),
  ),
  spread: factValueSchema.nullable(),
  isConflict: z.boolean(),
});
export type FieldComparisonMatches = Expect<
  Exact<z.infer<typeof fieldComparisonSchema>, FieldComparison>
>;

export const agreementSchema = z.object({
  level: z.enum(AGREEMENT_LEVELS),
  nSources: z.number().int().nonnegative(),
  nIndependentSources: z.number().int().nonnegative(),
  reasons: z.array(reasonSchema),
  comparisons: z.array(fieldComparisonSchema),
});
export type AgreementMatches = Expect<Exact<z.infer<typeof agreementSchema>, Agreement>>;

export const attributionSchema = z.object({
  sourceId: z.string(),
  name: z.string(),
  homepage: z.string().nullable(),
  licence: z.string().min(1),
  attributionText: z.string().min(1),
  termsUrl: z.string().nullable(),
  disclaimer: z.string().nullable(),
});
export type AttributionMatches = Expect<Exact<z.infer<typeof attributionSchema>, Attribution>>;

export const geometryViewSchema = z.object({
  role: z.enum(GEOMETRY_ROLES),
  kind: z.enum(GEOMETRY_KINDS),
  geometry: geoJsonGeometrySchema,
  validAt: isoTimestamp.nullable(),
  isForecast: z.boolean(),
  evidenceIds: z.array(evidenceId),
});
export type GeometryViewMatches = Expect<Exact<z.infer<typeof geometryViewSchema>, GeometryView>>;

export const freshnessPolicyViewSchema = z.object({
  pollIntervalS: z.number().int().nonnegative(),
  fetchFreshWithinS: z.number().int().nonnegative(),
  fetchStaleAfterS: z.number().int().nonnegative(),
  unavailableAfterS: z.number().int().nonnegative(),
  dataCurrentWithinS: z.number().int().nonnegative().nullable(),
  dataStaleAfterS: z.number().int().nonnegative().nullable(),
  quietIsNormal: z.boolean(),
});
export type FreshnessPolicyViewMatches = Expect<
  Exact<z.infer<typeof freshnessPolicyViewSchema>, FreshnessPolicyView>
>;

export const sourceHealthViewSchema = z.object({
  sourceId: z.string(),
  productId: z.number().int().nullable(),
  status: z.enum(SOURCE_HEALTH_STATUSES),
  lastAttemptAt: isoTimestamp.nullable(),
  lastSuccessAt: isoTimestamp.nullable(),
  newestObservedAt: isoTimestamp.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastErrorClass: z.enum(ERROR_CLASSES).nullable(),
  reasons: z.array(z.enum(SOURCE_HEALTH_REASONS)),
  expected: freshnessPolicyViewSchema,
  evidenceId: evidenceId.nullable(),
});
export type SourceHealthViewMatches = Expect<
  Exact<z.infer<typeof sourceHealthViewSchema>, SourceHealthView>
>;

export const sourceProductViewSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  hazardTypes: z.array(z.enum(HAZARD_TYPES)),
  capabilities: z.array(z.enum(SOURCE_CAPABILITIES)),
  platform: z.string().nullable(),
  instrument: z.string().nullable(),
  resolutionM: z.number().int().positive().nullable(),
  status: z.enum(PRODUCT_STATUSES),
  activeFrom: z.string().nullable(),
  activeTo: z.string().nullable(),
  health: sourceHealthViewSchema,
});
export type SourceProductViewMatches = Expect<
  Exact<z.infer<typeof sourceProductViewSchema>, SourceProductView>
>;

export const runSummaryViewSchema = z.object({
  id: z.string(),
  productId: z.number().int().nullable(),
  trigger: z.enum(RUN_TRIGGERS),
  status: z.enum(RUN_STATUSES),
  startedAt: isoTimestamp,
  committedAt: isoTimestamp.nullable(),
  durationMs: z.number().int().nullable(),
  counts: z.object({
    received: z.number().int().nonnegative(),
    newRecords: z.number().int().nonnegative(),
    newVersions: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
  newestObservedAt: isoTimestamp.nullable(),
  errorClass: z.enum(ERROR_CLASSES).nullable(),
  evidenceId,
});
export type RunSummaryViewMatches = Expect<
  Exact<z.infer<typeof runSummaryViewSchema>, RunSummaryView>
>;

export const replayHorizonSchema = z.object({
  profile: z.enum(['lean', 'standard']),
  byFamily: byFamily(z.object({ earliestAsOf: isoTimestamp, note: z.string().min(1) })),
});
export type ReplayHorizonMatches = Expect<
  Exact<z.infer<typeof replayHorizonSchema>, ReplayHorizon>
>;

export const asOfContextSchema = z.object({
  asOf: isoTimestamp,
  isReplay: z.boolean(),
  replayHorizon: replayHorizonSchema,
  sourceCutoffs: z.record(z.string(), isoTimestamp.nullable()),
});
export type AsOfContextMatches = Expect<Exact<z.infer<typeof asOfContextSchema>, AsOfContext>>;

export const confidenceViewSchema = z.object({
  class: z.enum(CONFIDENCE_CLASSES),
  raw: z.string().nullable(),
});
export type ConfidenceViewMatches = Expect<
  Exact<z.infer<typeof confidenceViewSchema>, ConfidenceView>
>;

export const sensorRefSchema = z.object({
  productId: z.number().int(),
  code: z.string(),
  platform: z.string().nullable(),
  instrument: z.string().nullable(),
  resolutionM: z.number().int().positive().nullable(),
});
export type SensorRefMatches = Expect<Exact<z.infer<typeof sensorRefSchema>, SensorRef>>;

export const subjectSummarySchema = z.object({
  subjectRef,
  hazardType: z.enum(HAZARD_TYPES),
  family: z.enum(HAZARD_FAMILIES),
  publicId: z.string(),
  title: z.string(),
  observedAt: isoTimestamp,
  lifecycleStatus: z.enum(LIFECYCLE_STATUSES),
  providerSeverity: providerSeveritySchema.nullable(),
  distanceKm: z.number().nonnegative(),
  hypocentralDistanceKm: z.number().nonnegative().nullable(),
  facts: z.array(factSchema),
  relevance: relevanceAssessmentSchema,
  agreement: agreementSchema.nullable(),
  evidenceIds: z.array(evidenceId),
  href: subjectHref,
});
export type SubjectSummaryMatches = Expect<
  Exact<z.infer<typeof subjectSummarySchema>, SubjectSummary>
>;

export const dataConfidenceSchema = z.object({
  level: z.enum(DATA_CONFIDENCE_LEVELS),
  reasons: z.array(reasonSchema),
});
export type DataConfidenceMatches = Expect<
  Exact<z.infer<typeof dataConfidenceSchema>, DataConfidence>
>;

export const baselineReferenceSchema = z.object({
  nWindows: z.number().int().nonnegative(),
  nEvents: z.number().int().nonnegative(),
  windowDays: z.number().int().positive(),
  referenceFrom: isoTimestamp,
  referenceTo: isoTimestamp,
  median: z.number(),
  p25: z.number(),
  p75: z.number(),
  p90: z.number(),
  p95: z.number(),
  mean: z.number(),
  ratePerWindow: z.number(),
  activityRatio: z.number().nullable(),
});
export type BaselineReferenceMatches = Expect<
  Exact<z.infer<typeof baselineReferenceSchema>, BaselineReference>
>;

export const baselineMetricViewSchema = z.object({
  id: evidenceId,
  family: z.enum(HAZARD_FAMILIES),
  metricCode: z.string(),
  label: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  asOf: isoTimestamp,
  status: z.enum(BASELINE_STATUSES),
  observedValue: factValueSchema,
  reference: baselineReferenceSchema.nullable(),
  percentile: z.number().min(0).max(100).nullable(),
  band: z.enum(BASELINE_BANDS).nullable(),
  trendBand: z.enum(TREND_BANDS).nullable(),
  interpretation: z.string().min(1),
  caveats: z.array(z.string()),
  methodVersion: z.string(),
  evidenceIds: z.array(evidenceId),
});
export type BaselineMetricViewMatches = Expect<
  Exact<z.infer<typeof baselineMetricViewSchema>, BaselineMetricView>
>;

/**
 * A family card, with invariant **I11** enforced by the schema.
 *
 * When `availability` is not `AVAILABLE`, `items` must be empty and `itemsTotal` must be zero.
 * "No relevant hazards were found" and "GeoNerva cannot see this family here" are different
 * answers, and this is the one rule that stops the second being rendered as the first.
 */
export const familyCardSchema = z
  .object({
    family: z.enum(HAZARD_FAMILIES),
    availability: z.enum(FAMILY_AVAILABILITIES),
    coverage: familyCoverageSchema,
    items: z.array(subjectSummarySchema),
    truncated: z.boolean(),
    itemsTotal: z.number().int().nonnegative(),
    metrics: z.array(baselineMetricViewSchema),
    dataConfidence: dataConfidenceSchema,
    sourceHealth: z.array(sourceHealthViewSchema),
    caveats: z.array(z.string()),
  })
  .refine(
    (card) =>
      card.availability === 'AVAILABLE' || (card.items.length === 0 && card.itemsTotal === 0),
    {
      message: 'a family that is not AVAILABLE must carry no items and no count (I11)',
      path: ['items'],
    },
  );
export type FamilyCardMatches = Expect<Exact<z.infer<typeof familyCardSchema>, FamilyCard>>;

export const briefingCopySchema = z.object({
  headline: z.string().min(1),
  summary: z.array(z.string()),
  byFamily: byFamily(z.array(z.string())),
  caveats: z.array(z.string()),
  templateVersion: z.string(),
});
export type BriefingCopyMatches = Expect<Exact<z.infer<typeof briefingCopySchema>, BriefingCopy>>;

export const changeFacetSchema = z.object({
  type: z.enum(CHANGE_TYPES),
  label: z.string(),
  before: factValueSchema.nullable(),
  after: factValueSchema.nullable(),
});
export type ChangeFacetMatches = Expect<Exact<z.infer<typeof changeFacetSchema>, ChangeFacet>>;

export const changeSignalViewSchema = z.object({
  id: evidenceId,
  type: z.enum(CHANGE_TYPES),
  family: z.enum(HAZARD_FAMILIES),
  subjectRef: subjectRef.nullable(),
  metricCode: z.string().nullable(),
  title: z.string(),
  detail: z.string().nullable(),
  before: factValueSchema.nullable(),
  after: factValueSchema.nullable(),
  fromAsOf: isoTimestamp,
  toAsOf: isoTimestamp,
  importance: z.number().int().min(0).max(100),
  prominence: z.enum(CHANGE_PROMINENCES),
  suppressionReason: z.enum(SUPPRESSION_REASONS).nullable(),
  lateReport: z.boolean(),
  facets: z.array(changeFacetSchema),
  reasonCodes: z.array(z.string()),
  evidenceIds: z.array(evidenceId),
  engineVersion: z.string(),
});
export type ChangeSignalViewMatches = Expect<
  Exact<z.infer<typeof changeSignalViewSchema>, ChangeSignalView>
>;

export const changeSectionSchema = z.object({
  window: z.enum(CHANGE_WINDOWS),
  fromAsOf: isoTimestamp,
  toAsOf: isoTimestamp,
  headline: z.array(changeSignalViewSchema),
  listed: z.array(changeSignalViewSchema),
  detail: z.array(changeSignalViewSchema),
  suppressed: z.array(changeSignalViewSchema),
  suppressedCount: z.number().int().nonnegative(),
  emptyStatement: z.string().nullable(),
});
export type ChangeSectionMatches = Expect<
  Exact<z.infer<typeof changeSectionSchema>, ChangeSection>
>;

/**
 * Every evidence id the response references, wherever it sits.
 *
 * A structural walk rather than a list of known fields: the fields that carry ids are spread across
 * a dozen nested types, and enumerating them is how I9 gets checked against one version of the
 * document's shape while a new field quietly escapes it.
 *
 * The first version walked for the key names `evidenceId` and `evidenceIds` **only**, and its
 * comment claimed that walking for the key name "cannot" miss a field. It missed two:
 * `BaselineMetricView.id` is an `EV:BAS:` reference and `ChangeSignalView.id` is an `EV:CHG:` one,
 * so a briefing could cite a change signal absent from its own manifest and this refinement could
 * not fail. A plain `id` is therefore collected too — but only when it *looks* like an evidence
 * reference, because `RunSummaryView.id` is a bare uuid and `SourceProductView.id` is a number,
 * and treating those as citations would demand manifest entries that should not exist.
 */
export function citedEvidenceIds(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) citedEvidenceIds(entry, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;

  for (const [key, entry] of Object.entries(value)) {
    /* The manifest is the answer, not a question: its own ids must not be treated as citations. */
    if (key === 'evidenceManifest') continue;
    if (key === 'evidenceId' && typeof entry === 'string') found.add(entry);
    else if (key === 'id' && typeof entry === 'string' && entry.startsWith('EV:')) found.add(entry);
    else if (key === 'evidenceIds' && Array.isArray(entry)) {
      for (const id of entry) if (typeof id === 'string') found.add(id);
    } else citedEvidenceIds(entry, found);
  }
  return found;
}

/*
 * ── Top-level responses ───────────────────────────────────────────────────────
 */

export const invalidParamSchema = z.object({
  name: z.string(),
  reason: z.string(),
});
export type InvalidParamMatches = Expect<Exact<z.infer<typeof invalidParamSchema>, InvalidParam>>;

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().nullable(),
  instance: z.string().nullable(),
  code: z.enum(PROBLEM_CODES),
  invalidParams: z.array(invalidParamSchema),
  retryAfterS: z.number().nonnegative().nullable(),
  earliestAsOf: isoTimestamp.nullable(),
  affectedFamilies: z.array(z.enum(HAZARD_FAMILIES)),
  /*
   * Nullable, because the contract is. `problemDocument` always mints one — the field exists to
   * correlate a response with a log line — but a schema stricter than the contract it describes
   * would reject a legitimate response, and the equivalence proof caught exactly that.
   */
  traceId: z.string().nullable(),
});
export type ProblemDetailsMatches = Expect<
  Exact<z.infer<typeof problemDetailsSchema>, ProblemDetails>
>;

export const evidenceItemSchema = z.object({
  id: evidenceId,
  kind: z.enum(EVIDENCE_KINDS),
  summary: z.string().min(1),
  sourceId: z.string().nullable(),
  productId: z.number().int().nullable(),
  observedAt: isoTimestamp.nullable(),
  ingestedAt: isoTimestamp,
  url: z.string().nullable(),
  resolvable: z.boolean(),
});
export type EvidenceItemMatches = Expect<Exact<z.infer<typeof evidenceItemSchema>, EvidenceItem>>;

export const replayHorizonResponseSchema = z.object({
  schemaVersion,
  generatedAt: isoTimestamp,
  horizon: replayHorizonSchema,
});
export type ReplayHorizonResponseMatches = Expect<
  Exact<z.infer<typeof replayHorizonResponseSchema>, ReplayHorizonResponse>
>;

export const workerStatusViewSchema = z.object({
  lastSeenAt: isoTimestamp,
  version: z.string().nullable(),
  isStale: z.boolean(),
});
export type WorkerStatusViewMatches = Expect<
  Exact<z.infer<typeof workerStatusViewSchema>, WorkerStatusView>
>;

export const dataQualityCheckViewSchema = z.object({
  code: z.string(),
  label: z.string(),
  status: z.enum(['OK', 'WARN', 'ALARM']),
  value: z.number().nullable(),
  threshold: z.number().nullable(),
  detail: z.string().nullable(),
  checkedAt: isoTimestamp,
});
export type DataQualityCheckViewMatches = Expect<
  Exact<z.infer<typeof dataQualityCheckViewSchema>, DataQualityCheckView>
>;

/**
 * One source on the data-status page.
 *
 * `successRate24h` is `nullable` and **not** defaulted to zero, which is the schema stating the
 * same rule the assembly does: a rate with no runs behind it does not exist, and a zero would read
 * as "every run failed".
 */
export const sourceStatusEntrySchema = z
  .object({
    sourceId: z.string(),
    name: z.string().min(1),
    homepage: z.string().nullable(),
    enabled: z.boolean(),
    licence: z.string().min(1),
    attributionText: z.string().min(1),
    termsUrl: z.string().nullable(),
    disclaimer: z.string().nullable(),
    coverageNote: z.string().nullable(),
    coverageGeometryAvailable: z.boolean(),
    hazardTypes: z.array(z.enum(HAZARD_TYPES)),
    capabilities: z.array(z.enum(SOURCE_CAPABILITIES)),
    health: sourceHealthViewSchema,
    products: z.array(sourceProductViewSchema),
    recentRuns: z.array(runSummaryViewSchema),
    successRate24h: z.number().min(0).max(1).nullable(),
    runCount24h: z.number().int().nonnegative(),
  })
  .refine((entry) => (entry.runCount24h === 0) === (entry.successRate24h === null), {
    message: 'a success rate exists exactly when runs were committed in the window',
    path: ['successRate24h'],
  });
export type SourceStatusEntryMatches = Expect<
  Exact<z.infer<typeof sourceStatusEntrySchema>, SourceStatusEntry>
>;

/**
 * `GET /api/v1/sources/status`.
 *
 * The refinement is invariant **I9**, which this contract was missing while `locationBriefingSchema`
 * had it. Its absence was not theoretical: the assembly omitted a manifest entry it could not
 * resolve while still citing the id in `recentRuns[].evidenceId`, and a test asserted that as the
 * desired behaviour. A response cannot cite what it does not carry.
 */
export const sourceStatusSchema = z
  .object({
    schemaVersion,
    asOfContext: asOfContextSchema,
    generatedAt: isoTimestamp,
    sources: z.array(sourceStatusEntrySchema),
    worker: workerStatusViewSchema.nullable(),
    dataQuality: z.array(dataQualityCheckViewSchema),
    evidenceManifest: z.array(evidenceItemSchema),
    attribution: z.array(attributionSchema),
  })
  .superRefine((status, ctx) => {
    const manifest = new Set(status.evidenceManifest.map((item) => item.id));
    for (const id of citedEvidenceIds(status)) {
      if (!manifest.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidenceManifest'],
          message: `the response cites ${id}, which its manifest does not contain (I9)`,
        });
      }
    }
  });
export type SourceStatusMatches = Expect<Exact<z.infer<typeof sourceStatusSchema>, SourceStatus>>;

/*
 * ── The briefing ──────────────────────────────────────────────────────────────
 */

/**
 * A location reference, with invariant **I15** enforced by the schema.
 *
 * `lat` and `lon` carry at most two decimals. The rounding happens at the request boundary
 * (`params.ts`), so this is a second, independent check on the same rule — and the one that runs
 * against what actually left the server. A response that reached three decimals would fail its
 * own contract test rather than being noticed by a reviewer.
 */
export const locationRefSchema = z.object({
  key: z.string(),
  label: z.string(),
  lat: roundedCoordinate(-90, 90),
  lon: roundedCoordinate(-180, 180),
  timezone: z.string().min(1),
  countryCode: z.string().nullable(),
  admin1: z.string().nullable(),
});
export type LocationRefMatches = Expect<Exact<z.infer<typeof locationRefSchema>, LocationRef>>;

export const snapshotOverallSchema = z.object({
  headlineCode: z.enum(HEADLINE_CODES),
  headlineRelevance: z.enum(RELEVANCE_LEVELS).nullable(),
  headlineText: z.string().min(1),
  coverageStatement: z.string(),
  unavailableFamilies: z.array(z.enum(HAZARD_FAMILIES)),
  notCoveredFamilies: z.array(z.enum(HAZARD_FAMILIES)),
  reasons: z.array(reasonSchema),
  evidenceIds: z.array(evidenceId),
});
export type SnapshotOverallMatches = Expect<
  Exact<z.infer<typeof snapshotOverallSchema>, SnapshotOverall>
>;

export const locationSnapshotViewSchema = z.object({
  asOf: isoTimestamp,
  engineVersion: z.string(),
  generatedAt: isoTimestamp,
  sourceHealth: z.array(sourceHealthViewSchema),
  families: byFamily(familyCardSchema),
  overall: snapshotOverallSchema,
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type LocationSnapshotViewMatches = Expect<
  Exact<z.infer<typeof locationSnapshotViewSchema>, LocationSnapshotView>
>;

export const aiSectionSchema = z.object({
  role: z.string(),
  heading: z.string(),
  text: z.string(),
  evidenceIds: z.array(evidenceId),
});
export type AiSectionMatches = Expect<Exact<z.infer<typeof aiSectionSchema>, AiSection>>;

/**
 * The AI block, whose absence is the normal case (`AI_MODE=disabled`, owner decision Q4).
 *
 * `validationStatus` admits only `PASSED` and `REPAIRED`: a `REJECTED` output is stored for
 * evaluation and never shown, so a response carrying one would be the validator having been
 * bypassed. The schema says so rather than trusting the writer.
 */
export const aiBriefingViewSchema = z.object({
  model: z.string(),
  promptVersion: z.string(),
  validationStatus: z.enum(['PASSED', 'REPAIRED']),
  sections: z.array(aiSectionSchema),
  evidenceIds: z.array(evidenceId),
  disclaimer: z.string().min(1),
  generatedAt: isoTimestamp,
});
export type AiBriefingViewMatches = Expect<
  Exact<z.infer<typeof aiBriefingViewSchema>, AiBriefingView>
>;

/**
 * `GET /api/v1/briefing`.
 *
 * The `superRefine` encodes invariants **I9** and **I12** over the assembled document, which is
 * the only level at which either can be checked: I9 asks that every evidence id referenced
 * *anywhere* be in the manifest, and I12 that the AI block reference nothing outside it. Both are
 * properties of the whole response, not of any field.
 */
export const locationBriefingSchema = z
  .object({
    schemaVersion,
    location: locationRefSchema,
    window: z.enum(CHANGE_WINDOWS),
    generatedAt: isoTimestamp,
    asOfContext: asOfContextSchema,
    engineVersion: z.string(),
    snapshot: locationSnapshotViewSchema,
    changes: changeSectionSchema,
    copy: briefingCopySchema,
    ai: aiBriefingViewSchema.nullable(),
    evidenceManifest: z.array(evidenceItemSchema),
    attribution: z.array(attributionSchema),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .superRefine((briefing, ctx) => {
    const manifest = new Set(briefing.evidenceManifest.map((item) => item.id));

    for (const id of citedEvidenceIds(briefing)) {
      if (!manifest.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidenceManifest'],
          message: `the response cites ${id}, which its manifest does not contain (I9)`,
        });
      }
    }

    for (const id of briefing.ai?.evidenceIds ?? []) {
      if (!manifest.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ai', 'evidenceIds'],
          message: `the AI text cites ${id}, which is outside the manifest (I12)`,
        });
      }
    }
  });
export type LocationBriefingMatches = Expect<
  Exact<z.infer<typeof locationBriefingSchema>, LocationBriefing>
>;

/*
 * ── Evidence detail ───────────────────────────────────────────────────────────
 */

export const rawPayloadViewSchema = z
  .object({
    state: z.enum(RAW_PAYLOAD_STATES),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    capturedAt: isoTimestamp.nullable(),
    retentionExpiresAt: isoTimestamp.nullable(),
  })
  .superRefine((view, ctx) => {
    const captured = view.state === 'AVAILABLE' || view.state === 'PRUNED';
    // A captured body has a digest, a capture time and an expiry; nothing else claims either time.
    if (
      captured !== (view.capturedAt !== null) ||
      captured !== (view.retentionExpiresAt !== null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['capturedAt'],
        message: 'capture and expiry times exist exactly when a body was captured',
      });
    }
    if (captured && view.sha256 === null) {
      ctx.addIssue({ code: 'custom', path: ['sha256'], message: 'a captured body has a digest' });
    }
    if (view.state === 'SOURCE_UNAVAILABLE' && view.sha256 !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['sha256'],
        message: 'an unreadable raw row has no readable digest',
      });
    }
  });
export type RawPayloadViewMatches = Expect<
  Exact<z.infer<typeof rawPayloadViewSchema>, RawPayloadView>
>;

export const observationEvidenceDetailSchema = z
  .object({
    kind: z.literal('OBS'),
    versionId: z.string(),
    versionSeq: z.number().int().positive(),
    sourceRecordPrimaryKey: z.string(),
    hazardType: z.string(),
    lifecycleStatus: z.enum(LIFECYCLE_STATUSES),
    observedAt: isoTimestamp,
    validFrom: isoTimestamp.nullable(),
    validTo: isoTimestamp.nullable(),
    sourceUpdatedAt: isoTimestamp.nullable(),
    ingestedAt: isoTimestamp,
    contributor: z.string().nullable(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    rawExcerpt: z.unknown(),
    rawPayloadSha256: z.string().nullable(),
    rawPayloadPruned: z.boolean(),
    rawPayload: rawPayloadViewSchema,
    sourceUrl: z.string().nullable(),
  })
  .superRefine((detail, ctx) => {
    // The two P8 fields restate the lifecycle; they may never disagree with it (ADR-038).
    if (detail.rawExcerpt !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['rawExcerpt'],
        message: 'provider bodies are never served',
      });
    }
    if (detail.rawPayloadSha256 !== detail.rawPayload.sha256) {
      ctx.addIssue({
        code: 'custom',
        path: ['rawPayloadSha256'],
        message: 'must equal rawPayload.sha256',
      });
    }
    if (detail.rawPayloadPruned !== (detail.rawPayload.state === 'PRUNED')) {
      ctx.addIssue({
        code: 'custom',
        path: ['rawPayloadPruned'],
        message: "must equal rawPayload.state === 'PRUNED'",
      });
    }
  });
export type ObservationEvidenceDetailMatches = Expect<
  Exact<z.infer<typeof observationEvidenceDetailSchema>, ObservationEvidenceDetail>
>;

export const fireClusterVersionEvidenceDetailSchema = z.object({
  kind: z.literal('FCV'),
  clusterVersionId: z.string(),
  clusterPublicId: z.string(),
  asOf: isoTimestamp,
  detectionCountTotal: z.number().int().nonnegative(),
  detectionCount24h: z.number().int().nonnegative(),
  distinctOverpasses24h: z.number().int().nonnegative(),
  firstDetectedAt: isoTimestamp,
  lastDetectedAt: isoTimestamp,
  frpSum24h: z.number().nonnegative().nullable(),
  frpMax: z.number().nonnegative().nullable(),
  maxConfidence: z.string().nullable(),
  productIds: z.array(z.number().int()),
  detectionSetEvidenceId: evidenceId,
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type FireClusterVersionEvidenceDetailMatches = Expect<
  Exact<z.infer<typeof fireClusterVersionEvidenceDetailSchema>, FireClusterVersionEvidenceDetail>
>;

export const fireDetectionSetEvidenceDetailSchema = z.object({
  kind: z.literal('FDS'),
  clusterVersionId: z.string(),
  clusterPublicId: z.string(),
  asOf: isoTimestamp,
  countClaimed: z.number().int().nonnegative(),
  countHeld: z.number().int().nonnegative(),
  retentionIncomplete: z.boolean(),
  firstDetectedAt: isoTimestamp,
  lastDetectedAt: isoTimestamp,
  byDay: z.array(
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      count: z.number().int().nonnegative(),
      frpSum: z.number().nullable(),
    }),
  ),
  clusterVersionEvidenceId: evidenceId,
});
export type FireDetectionSetEvidenceDetailMatches = Expect<
  Exact<z.infer<typeof fireDetectionSetEvidenceDetailSchema>, FireDetectionSetEvidenceDetail>
>;

export const ingestionRunEvidenceDetailSchema = z.object({
  kind: z.literal('RUN'),
  runId: z.string(),
  sourceId: z.string(),
  productId: z.number().int().nullable(),
  trigger: z.string(),
  status: z.string(),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp.nullable(),
  committedAt: isoTimestamp.nullable(),
  httpStatus: z.number().int().nullable(),
  bytesReceived: z.number().int().nonnegative().nullable(),
  counts: z.object({
    received: z.number().int().nonnegative(),
    newRecords: z.number().int().nonnegative(),
    newVersions: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
  newestObservedAt: isoTimestamp.nullable(),
  errorClass: z.string().nullable(),
  /* At most 1 KB, sanitized at write time (`sanitizeDetail`, SECURITY.md M7). Bound asserted. */
  errorMessage: z.string().max(1024).nullable(),
  payloadSha256: z.string().nullable(),
  workerVersion: z.string().nullable(),
});
export type IngestionRunEvidenceDetailMatches = Expect<
  Exact<z.infer<typeof ingestionRunEvidenceDetailSchema>, IngestionRunEvidenceDetail>
>;

export const correlationEvidenceDetailSchema = z.object({
  kind: z.literal('COR'),
  linkId: z.string(),
  canonicalEventPublicId: z.string(),
  sourceRecordPrimaryKey: z.string(),
  sourceId: z.string(),
  relation: z.enum(['PRIMARY', 'SAME_EVENT', 'DERIVED_COPY']),
  matchKind: z.enum(['IDENTITY_REF', 'SPATIOTEMPORAL', 'SEED']),
  confidence: z.number().min(0).max(1).nullable(),
  reasons: z.unknown(),
  algorithmVersion: z.string(),
  linkedAt: isoTimestamp,
  unlinkedAt: isoTimestamp.nullable(),
  unlinkReason: z.string().nullable(),
});
export type CorrelationEvidenceDetailMatches = Expect<
  Exact<z.infer<typeof correlationEvidenceDetailSchema>, CorrelationEvidenceDetail>
>;

export const evidenceDetailPayloadSchema = z.discriminatedUnion('kind', [
  observationEvidenceDetailSchema,
  fireClusterVersionEvidenceDetailSchema,
  fireDetectionSetEvidenceDetailSchema,
  ingestionRunEvidenceDetailSchema,
  correlationEvidenceDetailSchema,
]);
export type EvidenceDetailPayloadMatches = Expect<
  Exact<z.infer<typeof evidenceDetailPayloadSchema>, EvidenceDetailPayload>
>;

/**
 * `GET /api/v1/evidence/{id}`.
 *
 * The refinements are the two rules the endpoint exists to keep. The payload's kind and the
 * manifest entry's kind must agree: a response that resolved `EV:OBS:41` and returned a `RUN`
 * payload would be internally inconsistent in a way no field-level check catches, and the whole
 * purpose of the endpoint is that a citation resolves to *what it says it is*. And an item served
 * here must be one this endpoint can resolve, so `resolvable: false` in its own response is a
 * contradiction.
 */
export const evidenceDetailSchema = z
  .object({
    schemaVersion,
    item: evidenceItemSchema,
    detail: evidenceDetailPayloadSchema,
    attribution: z.array(attributionSchema),
  })
  .refine((response) => response.item.kind === response.detail.kind, {
    message: 'the manifest entry and the payload must describe the same kind of evidence',
    path: ['detail', 'kind'],
  })
  .refine((response) => response.item.resolvable, {
    message: 'an evidence detail may only be served for a kind the endpoint can resolve',
    path: ['item', 'resolvable'],
  });
export type EvidenceDetailMatches = Expect<
  Exact<z.infer<typeof evidenceDetailSchema>, EvidenceDetail>
>;

/*
 * ── Map features ──────────────────────────────────────────────────────────────
 */

const bboxSchema = z.object({
  west: z.number().min(-180).max(180),
  south: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180),
  north: z.number().min(-90).max(90),
});

export const mapFeatureSchema = z.object({
  subjectRef,
  publicId: z.string(),
  kind: z.enum(['canonical_event', 'fire_cluster', 'fire_detection']),
  hazardType: z.enum(HAZARD_TYPES),
  family: z.enum(HAZARD_FAMILIES),
  geometry: geoJsonGeometrySchema,
  observedAt: isoTimestamp,
  isActive: z.boolean(),
  providerSeverity: providerSeveritySchema.nullable(),
  magnitudeValue: z.number().nullable(),
  clusterStatus: z.enum(FIRE_CLUSTER_STATUSES).nullable(),
  confidence: confidenceViewSchema.nullable(),
  label: z.string(),
  href: subjectHref,
  evidenceIds: z.array(evidenceId),
});
export type MapFeatureMatches = Expect<Exact<z.infer<typeof mapFeatureSchema>, MapFeature>>;

/**
 * `GET /api/v1/events`.
 *
 * `truncated` must agree with the cap and the total: above the cap the response says so rather
 * than silently dropping features (ARCHITECTURE §7.5). A map that quietly showed 500 of 900 fires
 * is the failure this refinement makes impossible to ship.
 */
export const mapFeaturesResponseSchema = z
  .object({
    schemaVersion,
    asOfContext: asOfContextSchema,
    bbox: bboxSchema,
    bboxParts: z.array(bboxSchema).min(1).max(2),
    zoom: z.number().int().min(0).max(22),
    families: z.array(z.enum(HAZARD_FAMILIES)),
    features: z.array(mapFeatureSchema),
    truncated: z.boolean(),
    cap: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    /* `partialRecord`, because a request names the families it wants and gets those. */
    coverage: z.partialRecord(
      z.enum(HAZARD_FAMILIES),
      z.object({
        availability: z.enum(FAMILY_AVAILABILITIES),
        note: z.string().min(1).nullable(),
      }),
    ),
    attribution: z.array(attributionSchema),
  })
  .refine((response) => response.features.length <= response.cap, {
    message: 'the response returned more features than its own cap',
    path: ['features'],
  })
  /*
   * A statement for every family asked about and for no other. A map that quietly omitted one
   * would be back where ADR-042 started: `total: 0` meaning two different things.
   */
  .refine(
    (response) =>
      response.families.every((family) => response.coverage[family] !== undefined) &&
      Object.keys(response.coverage).length === new Set(response.families).size,
    {
      message: 'coverage must carry exactly the families the request asked about (ADR-042)',
      path: ['coverage'],
    },
  )
  .refine(
    (response) =>
      response.features.every(
        (feature) => response.coverage[feature.family]?.availability !== 'NOT_COVERED',
      ),
    {
      message: 'a family with features on the map cannot also be reported as not covered',
      path: ['coverage'],
    },
  )
  .refine((response) => response.truncated === response.total > response.features.length, {
    message: 'truncated must be true exactly when features were dropped',
    path: ['truncated'],
  });
export type MapFeaturesResponseMatches = Expect<
  Exact<z.infer<typeof mapFeaturesResponseSchema>, MapFeaturesResponse>
>;

/*
 * ── Event and fire-cluster detail ─────────────────────────────────────────────
 *
 * The two detail contracts, frozen at G2 and given runtime form here. Beyond the shapes, each
 * refinement states an invariant the type cannot:
 *
 *  - **I9**: every cited evidence id is in the response's own manifest.
 *  - **Location is all-or-nothing**: `relevance` and the distances are present together or absent
 *    together, because both exist only when the caller supplied a location. A relevance level with
 *    no distance behind it — or a distance with no assessment — is a half-answer.
 *  - **History is newest first**, as both contracts document. A timeline in planner order reads as
 *    a different story.
 *  - **A merge is a pair**: `mergedIntoPublicId` and `mergedAt` are both set or both null, as the
 *    table's own CHECK constraint makes them.
 *  - **Truncation is declared** for the detection sample, exactly as for map features.
 */

/** Newest first by a timestamp field: each entry no later than the one before it. */
function isNewestFirst<T>(entries: readonly T[], at: (entry: T) => string): boolean {
  return entries.every((entry, index) => {
    const previous = entries[index - 1];
    return previous === undefined || at(previous) >= at(entry);
  });
}

export const eventHeadlineSchema = z.object({
  title: z.string().min(1),
  observedAt: isoTimestamp,
  lifecycleStatus: z.enum(LIFECYCLE_STATUSES),
  isActive: z.boolean(),
  providerSeverity: providerSeveritySchema.nullable(),
  preferredSourceId: z.string().min(1),
  preferenceReason: reasonSchema,
  centroid: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
  facts: z.array(factSchema),
  evidenceIds: z.array(evidenceId),
});
export type EventHeadlineMatches = Expect<
  Exact<z.infer<typeof eventHeadlineSchema>, EventHeadline>
>;

export const eventObservationViewSchema = z
  .object({
    sourceId: z.string().min(1),
    sourceName: z.string().min(1),
    productCode: z.string().nullable(),
    contributor: z.string().nullable(),
    relation: z.enum(LINK_RELATIONS),
    matchKind: z.enum(LINK_MATCH_KINDS),
    isDerivedCopy: z.boolean(),
    primaryKey: z.string().min(1),
    aliases: z.array(z.string()),
    versionId: z.string().regex(/^\d+$/u),
    versionSeq: z.number().int().positive(),
    observedAt: isoTimestamp,
    validFrom: isoTimestamp.nullable(),
    validTo: isoTimestamp.nullable(),
    sourceUpdatedAt: isoTimestamp.nullable(),
    ingestedAt: isoTimestamp,
    lifecycleStatus: z.enum(LIFECYCLE_STATUSES),
    providerSeverity: providerSeveritySchema.nullable(),
    providerStatus: z.string().nullable(),
    title: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    facts: z.array(factSchema),
    evidenceId,
  })
  .refine((view) => view.isDerivedCopy === (view.relation === 'DERIVED_COPY'), {
    message: 'isDerivedCopy must say exactly what relation says (ADR-006)',
    path: ['isDerivedCopy'],
  });
export type EventObservationViewMatches = Expect<
  Exact<z.infer<typeof eventObservationViewSchema>, EventObservationView>
>;

export const eventTimelineEntrySchema = z.object({
  versionId: z.string().regex(/^\d+$/u),
  versionSeq: z.number().int().positive(),
  sourceId: z.string().min(1),
  ingestedAt: isoTimestamp,
  observedAt: isoTimestamp,
  sourceUpdatedAt: isoTimestamp.nullable(),
  lifecycleStatus: z.enum(LIFECYCLE_STATUSES),
  summary: z.string().min(1),
  changedFields: z.array(z.string()),
  changes: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      before: factValueSchema.nullable(),
      after: factValueSchema.nullable(),
    }),
  ),
  evidenceId,
});
export type EventTimelineEntryMatches = Expect<
  Exact<z.infer<typeof eventTimelineEntrySchema>, EventTimelineEntry>
>;

export const correlationDecisionViewSchema = z
  .object({
    linkId: z.string().regex(/^\d+$/u),
    sourceId: z.string().min(1),
    primaryKey: z.string().min(1),
    relation: z.enum(LINK_RELATIONS),
    matchKind: z.enum(LINK_MATCH_KINDS),
    confidence: z.number().min(0).max(1).nullable(),
    reasons: z.array(reasonSchema),
    linkedAt: isoTimestamp,
    unlinkedAt: isoTimestamp.nullable(),
    unlinkReason: z.string().nullable(),
    evidenceId,
  })
  .refine((view) => view.unlinkedAt !== null || view.unlinkReason === null, {
    message: 'a link that is still open has no unlink reason',
    path: ['unlinkReason'],
  });
export type CorrelationDecisionViewMatches = Expect<
  Exact<z.infer<typeof correlationDecisionViewSchema>, CorrelationDecisionView>
>;

export const possibleMatchViewSchema = z.object({
  otherPublicId: z.string().nullable(),
  sourceId: z.string().min(1),
  primaryKey: z.string().min(1),
  score: z.number().min(0).max(1),
  reasons: z.array(reasonSchema),
  evaluatedAt: isoTimestamp,
});
export type PossibleMatchViewMatches = Expect<
  Exact<z.infer<typeof possibleMatchViewSchema>, PossibleMatchView>
>;

export const correlationViewSchema = z.object({
  algorithmVersion: z.string().min(1),
  decisions: z.array(correlationDecisionViewSchema),
  possibleMatches: z.array(possibleMatchViewSchema),
  agreementLevel: z.enum(AGREEMENT_LEVELS),
});
export type CorrelationViewMatches = Expect<
  Exact<z.infer<typeof correlationViewSchema>, CorrelationView>
>;

export const relatedEventRefSchema = z.object({
  subjectRef,
  publicId: z.string().min(1),
  hazardType: z.enum(HAZARD_TYPES),
  relation: z.string().min(1),
  label: z.string().min(1),
  href: subjectHref,
  reasons: z.array(reasonSchema),
});
export type RelatedEventRefMatches = Expect<
  Exact<z.infer<typeof relatedEventRefSchema>, RelatedEventRef>
>;

/** I9, as every top-level response with a manifest states it. */
function requireManifestCoverage(
  response: { readonly evidenceManifest: readonly { readonly id: string }[] },
  ctx: z.RefinementCtx,
): void {
  const manifest = new Set(response.evidenceManifest.map((item) => item.id));
  for (const id of citedEvidenceIds(response)) {
    if (!manifest.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceManifest'],
        message: `the response cites ${id}, which its manifest does not contain (I9)`,
      });
    }
  }
}

/** `mergedIntoPublicId` and `mergedAt` are both set or both null, as the table's CHECK says. */
function requireMergePair(
  response: { readonly mergedIntoPublicId: string | null; readonly mergedAt: string | null },
  ctx: z.RefinementCtx,
): void {
  if ((response.mergedIntoPublicId === null) !== (response.mergedAt === null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['mergedAt'],
      message: 'mergedIntoPublicId and mergedAt must be set together',
    });
  }
}

/**
 * `GET /api/v1/events/{publicId}`.
 */
export const eventDetailSchema = z
  .object({
    schemaVersion,
    publicId: z.string().min(1),
    subjectRef,
    hazardType: z.enum(HAZARD_TYPES),
    family: z.enum(HAZARD_FAMILIES),
    asOfContext: asOfContextSchema,
    createdAt: isoTimestamp,
    headline: eventHeadlineSchema,
    observations: z.array(eventObservationViewSchema),
    agreement: agreementSchema,
    timeline: z.array(eventTimelineEntrySchema),
    correlation: correlationViewSchema,
    geometries: z.array(geometryViewSchema),
    relevance: relevanceAssessmentSchema.nullable(),
    distanceKm: z.number().nonnegative().nullable(),
    hypocentralDistanceKm: z.number().nonnegative().nullable(),
    mergedIntoPublicId: z.string().nullable(),
    mergedAt: isoTimestamp.nullable(),
    supersededPublicIds: z.array(z.string()),
    relatedEvents: z.array(relatedEventRefSchema),
    evidenceManifest: z.array(evidenceItemSchema),
    attribution: z.array(attributionSchema),
  })
  .superRefine((detail, ctx) => {
    requireManifestCoverage(detail, ctx);
    requireMergePair(detail, ctx);

    if ((detail.relevance === null) !== (detail.distanceKm === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['relevance'],
        message: 'relevance and distanceKm exist only together, when a location was supplied',
      });
    }
    if (detail.hypocentralDistanceKm !== null && detail.distanceKm === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['hypocentralDistanceKm'],
        message: 'a hypocentral distance needs the epicentral distance it extends',
      });
    }
    if (!isNewestFirst(detail.timeline, (entry) => entry.ingestedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeline'],
        message: 'the timeline must be newest first',
      });
    }
  });
export type EventDetailMatches = Expect<Exact<z.infer<typeof eventDetailSchema>, EventDetail>>;

export const fireClusterSummaryViewSchema = z.object({
  clusterVersionId: z.string().regex(/^\d+$/u),
  asOf: isoTimestamp,
  countedTo: isoTimestamp,
  detectionCountTotal: z.number().int().nonnegative(),
  detectionCount24h: z.number().int().nonnegative(),
  distinctOverpasses24h: z.number().int().nonnegative(),
  firstDetectedAt: isoTimestamp,
  lastDetectedAt: isoTimestamp,
  frpSum24h: z.number().nonnegative().nullable(),
  frpMax: z.number().nonnegative().nullable(),
  maxConfidence: confidenceViewSchema.nullable(),
  sensors: z.array(sensorRefSchema),
  facts: z.array(factSchema),
  evidenceIds: z.array(evidenceId),
});
export type FireClusterSummaryViewMatches = Expect<
  Exact<z.infer<typeof fireClusterSummaryViewSchema>, FireClusterSummaryView>
>;

export const fireClusterVersionViewSchema = z.object({
  clusterVersionId: z.string().regex(/^\d+$/u),
  asOf: isoTimestamp,
  detectionCountTotal: z.number().int().nonnegative(),
  detectionCount24h: z.number().int().nonnegative(),
  distinctOverpasses24h: z.number().int().nonnegative(),
  frpSum24h: z.number().nonnegative().nullable(),
  frpMax: z.number().nonnegative().nullable(),
  lastDetectedAt: isoTimestamp,
  summary: z.string().min(1),
  evidenceId,
});
export type FireClusterVersionViewMatches = Expect<
  Exact<z.infer<typeof fireClusterVersionViewSchema>, FireClusterVersionView>
>;

export const fireDetectionViewSchema = z.object({
  acquiredAt: isoTimestamp,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  productId: z.number().int().positive(),
  confidence: confidenceViewSchema,
  frpMw: z.number().nonnegative().nullable(),
  brightnessTi4K: z.number().nullable(),
  brightnessTi5K: z.number().nullable(),
  daynight: z.enum(['D', 'N']).nullable(),
  scanKm: z.number().nonnegative().nullable(),
  trackKm: z.number().nonnegative().nullable(),
  distanceKm: z.number().nonnegative().nullable(),
});
export type FireDetectionViewMatches = Expect<
  Exact<z.infer<typeof fireDetectionViewSchema>, FireDetectionView>
>;

export const fireClusterDetectionsViewSchema = z
  .object({
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    cap: z.number().int().positive(),
    sample: z.array(fireDetectionViewSchema),
    byDay: z.array(
      z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        count: z.number().int().nonnegative(),
        frpSum: z.number().nonnegative().nullable(),
        hasSatelliteCoverage: z.boolean(),
      }),
    ),
    evidenceId,
  })
  .refine((view) => view.sample.length <= view.cap, {
    message: 'the sample is larger than its own cap',
    path: ['sample'],
  })
  .refine((view) => view.truncated === view.total > view.sample.length, {
    message: 'truncated must be true exactly when detections were left out of the sample',
    path: ['truncated'],
  });
export type FireClusterDetectionsViewMatches = Expect<
  Exact<z.infer<typeof fireClusterDetectionsViewSchema>, FireClusterDetectionsView>
>;

/**
 * `GET /api/v1/fire-clusters/{publicId}`.
 */
export const fireClusterDetailSchema = z
  .object({
    schemaVersion,
    publicId: z.string().min(1),
    subjectRef,
    asOfContext: asOfContextSchema,
    status: z.enum(FIRE_CLUSTER_STATUSES),
    createdAt: isoTimestamp,
    summary: fireClusterSummaryViewSchema,
    hull: geoJsonGeometrySchema.nullable(),
    centroid: geoJsonGeometrySchema,
    relevance: relevanceAssessmentSchema.nullable(),
    distanceKm: z.number().nonnegative().nullable(),
    nearestDetectionKm: z.number().nonnegative().nullable(),
    versions: z.array(fireClusterVersionViewSchema),
    detections: fireClusterDetectionsViewSchema,
    mergedIntoPublicId: z.string().nullable(),
    mergedAt: isoTimestamp.nullable(),
    mergedFromPublicIds: z.array(z.string()),
    relatedEvents: z.array(relatedEventRefSchema),
    mandatoryCaveat: z.string().min(1),
    evidenceManifest: z.array(evidenceItemSchema),
    attribution: z.array(attributionSchema),
  })
  .superRefine((detail, ctx) => {
    requireManifestCoverage(detail, ctx);
    requireMergePair(detail, ctx);

    if ((detail.relevance === null) !== (detail.distanceKm === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['relevance'],
        message: 'relevance and distanceKm exist only together, when a location was supplied',
      });
    }
    /*
     * An implication, not an equivalence. A nearest detection needs a location; but a location does
     * not guarantee one. When a cluster's members cannot be verified — partitions pruned, a merge —
     * only the distance to its area or centre is known, and the interface's `number | null` is how
     * the contract says "not measured". The equivalence this replaced (written in P8, not at G2)
     * forced the builder to publish a bound under this field's name (P8 review H3).
     */
    if (detail.nearestDetectionKm !== null && detail.distanceKm === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['nearestDetectionKm'],
        message: 'a nearest-detection distance exists only when a location was supplied',
      });
    }
    if (!isNewestFirst(detail.versions, (version) => version.asOf)) {
      ctx.addIssue({
        code: 'custom',
        path: ['versions'],
        message: 'summary versions must be newest first',
      });
    }
  });
export type FireClusterDetailMatches = Expect<
  Exact<z.infer<typeof fireClusterDetailSchema>, FireClusterDetail>
>;

/*
 * ── Places ─────────────────────────────────────────────────────────────────────
 *
 * A suggestion is a GeoNames populated place, public reference data, and its coordinates are the
 * city's own. A search or reverse result is the answer to a question a *person* asked — often
 * about where they are — so its coordinates are held to invariant I15, as the contract states.
 */

export const placeSuggestionSchema = z.object({
  key: z.string().regex(/^p:[1-9][0-9]{0,9}$/u),
  label: z.string().min(1),
  countryCode: z.string().nullable(),
  admin1: z.string().nullable(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  population: z.number().int().nonnegative().nullable(),
  timezone: z.string().min(1),
});
export type PlaceSuggestionMatches = Expect<
  Exact<z.infer<typeof placeSuggestionSchema>, PlaceSuggestion>
>;

/** `GET /api/v1/places/suggest`. At most ten suggestions (§13.1: `limit ≤ 10`). */
export const placeSuggestResponseSchema = z.object({
  schemaVersion,
  query: z.string().min(2).max(64),
  suggestions: z.array(placeSuggestionSchema).max(10),
  attribution: z.array(attributionSchema),
});
export type PlaceSuggestResponseMatches = Expect<
  Exact<z.infer<typeof placeSuggestResponseSchema>, PlaceSuggestResponse>
>;

export const placeSearchResultSchema = z.object({
  key: z
    .string()
    .regex(
      /^(?:p:[1-9][0-9]{0,9}|n:[NWR][1-9][0-9]{0,18}|c:-?[0-9]{1,2}\.[0-9]{2},-?[0-9]{1,3}\.[0-9]{2})$/u,
    ),
  label: z.string().min(1),
  countryCode: z.string().nullable(),
  admin1: z.string().nullable(),
  lat: roundedCoordinate(-90, 90),
  lon: roundedCoordinate(-180, 180),
  timezone: z.string(),
  kind: z.string().nullable(),
});
export type PlaceSearchResultMatches = Expect<
  Exact<z.infer<typeof placeSearchResultSchema>, PlaceSearchResult>
>;

/** `GET /api/v1/places/search` and `GET /api/v1/places/reverse`. */
export const placeSearchResponseSchema = z.object({
  schemaVersion,
  query: z.string().max(64),
  results: z.array(placeSearchResultSchema),
  fromCache: z.boolean(),
  attribution: z.array(attributionSchema),
});
export type PlaceSearchResponseMatches = Expect<
  Exact<z.infer<typeof placeSearchResponseSchema>, PlaceSearchResponse>
>;

/*
 * ── History ────────────────────────────────────────────────────────────────────
 *
 * The contract's three rules, as refinements: reference bands exist exactly when the metric's
 * status is `OK`, a rarity statement exactly when it is `RARE_ACTIVITY`, and every citation is in
 * the manifest (I9). A percentile beside `INSUFFICIENT_HISTORY` would be the statistic §8 says to
 * refuse.
 */

export const timeSeriesPointSchema = z
  .object({
    t: isoTimestamp,
    value: z.number().nullable(),
    missingReason: z.string().nullable(),
  })
  .refine((point) => (point.value === null) === (point.missingReason !== null), {
    message: 'a missing value carries its reason, and a present one carries none',
    path: ['missingReason'],
  });
export type TimeSeriesPointMatches = Expect<
  Exact<z.infer<typeof timeSeriesPointSchema>, TimeSeriesPoint>
>;

export const timeSeriesViewSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  unit: z.string().nullable(),
  bucketDays: z.number().int().positive(),
  points: z.array(timeSeriesPointSchema),
});
export type TimeSeriesViewMatches = Expect<
  Exact<z.infer<typeof timeSeriesViewSchema>, TimeSeriesView>
>;

export const referenceBandsViewSchema = z.object({
  windowDays: z.number().int().positive(),
  nWindows: z.number().int().nonnegative(),
  nEvents: z.number().int().nonnegative(),
  referenceFrom: isoTimestamp,
  referenceTo: isoTimestamp,
  p25: z.number(),
  median: z.number(),
  p75: z.number(),
  p90: z.number(),
  p95: z.number(),
  mean: z.number(),
  evidenceIds: z.array(evidenceId),
});
export type ReferenceBandsViewMatches = Expect<
  Exact<z.infer<typeof referenceBandsViewSchema>, ReferenceBandsView>
>;

export const rarityStatementViewSchema = z.object({
  nEvents: z.number().int().nonnegative(),
  sinceYear: z.number().int(),
  radiusKm: z.number().positive(),
  thresholdLabel: z.string().min(1),
  text: z.string().min(1),
  evidenceIds: z.array(evidenceId),
});
export type RarityStatementViewMatches = Expect<
  Exact<z.infer<typeof rarityStatementViewSchema>, RarityStatementView>
>;

export const largestRecentViewSchema = z.object({
  value: factValueSchema,
  observedAt: isoTimestamp,
  subjectPublicId: z.string().nullable(),
  comparisonSince: isoTimestamp,
  text: z.string().min(1),
  evidenceIds: z.array(evidenceId),
});
export type LargestRecentViewMatches = Expect<
  Exact<z.infer<typeof largestRecentViewSchema>, LargestRecentView>
>;

export const sequenceContextViewSchema = z.object({
  triggerPublicId: z.string().min(1),
  triggerValue: factValueSchema,
  triggerObservedAt: isoTimestamp,
  text: z.string().min(1),
  caveat: z.string().min(1),
  evidenceIds: z.array(evidenceId),
});
export type SequenceContextViewMatches = Expect<
  Exact<z.infer<typeof sequenceContextViewSchema>, SequenceContextView>
>;

/** `GET /api/v1/history`. */
export const historyResponseSchema = z
  .object({
    schemaVersion,
    location: locationRefSchema,
    family: z.enum(HAZARD_FAMILIES),
    metricCode: z.string().min(1),
    asOfContext: asOfContextSchema,
    metric: baselineMetricViewSchema,
    series: z.array(timeSeriesViewSchema),
    referenceBands: referenceBandsViewSchema.nullable(),
    rarity: rarityStatementViewSchema.nullable(),
    largestRecent: largestRecentViewSchema.nullable(),
    sequenceContext: sequenceContextViewSchema.nullable(),
    completenessStatement: z.string().nullable(),
    caveats: z.array(z.string()),
    methodologyHref: z.string().regex(/^\/methodology(?:#[a-z0-9-]+)?$/u),
    evidenceManifest: z.array(evidenceItemSchema),
    attribution: z.array(attributionSchema),
  })
  .superRefine((history, ctx) => {
    requireManifestCoverage(history, ctx);
    const ok = history.metric.status === 'OK';
    /*
     * A trend answers a different question from a baseline: it states a **direction**, not a
     * position in a distribution (ADR-040). `FIRE_TREND` succeeds with no reference at all, and a
     * reference distribution beside a direction would be a statistic nothing computed — so the
     * rule is "exactly when a *distribution* metric is OK", and a trend must carry neither.
     */
    const distribution = history.metric.trendBand === null;
    const expectsReference = ok && distribution;
    if (
      expectsReference !== (history.metric.reference !== null) ||
      expectsReference !== (history.referenceBands !== null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceBands'],
        message:
          'a reference distribution exists exactly when a distribution metric is OK; a trend states a direction instead',
      });
    }
    if (!ok && (history.metric.percentile !== null || history.metric.band !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['metric', 'percentile'],
        message: 'a percentile or band without a supportable reference is the statistic §8 refuses',
      });
    }
    if ((history.metric.status === 'RARE_ACTIVITY') !== (history.rarity !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['rarity'],
        message: 'a rarity statement exists exactly when the status is RARE_ACTIVITY',
      });
    }
    if (
      history.metricCode !== history.metric.metricCode ||
      history.family !== history.metric.family
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['metricCode'],
        message: 'the response and its metric must name the same metric and family',
      });
    }
  });
export type HistoryResponseMatches = Expect<
  Exact<z.infer<typeof historyResponseSchema>, HistoryResponse>
>;
