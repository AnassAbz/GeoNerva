/**
 * Shared read-model building blocks.
 *
 * ## What a read model is here
 *
 * These types are the **wire contract** between `packages/briefing` + `apps/web/app/api` (P8) and
 * the frontend (P9). They are frozen at gate G2 (docs/IMPLEMENTATION_PLAN.md §2.4) so that the
 * API and the frontend can be built in parallel, the frontend working against generated mocks in
 * `packages/test-fixtures/src/read-models` until P8 lands.
 *
 * ## Rules every read model obeys
 *
 *  1. **Serializable.** Only JSON primitives, arrays and plain objects. Timestamps are
 *     `IsoTimestamp` strings in UTC; identifiers are strings; no `Date`, `bigint` or `Map`.
 *  2. **Every claim carries evidence.** Anything a user could question has `evidenceIds`, and
 *     every ID in a response appears in that response's `evidenceManifest` (invariant I9).
 *  3. **Absence is explicit.** There is no field whose emptiness has to be interpreted. A value
 *     GeoNerva does not have is `FactValue` of kind `unavailable` with a reason, never `0` and
 *     never omitted (invariant I11).
 *  4. **Observed, derived and generated stay apart.** Provider values live in `facts`, GeoNerva's
 *     computations in `relevance`/`metrics`/`distanceKm`, and AI text in a separate `ai` block
 *     that is absent unless it passed validation.
 *  5. **Provider scales are never converted.** A severity is always `{ scheme, value }`.
 *  6. **`schemaVersion` is present on every top-level response** and is bumped by an ADR, so a
 *     cached frontend and a newer API can detect each other.
 *  7. **Coordinates for user-supplied locations carry at most two decimals** (invariant I15).
 */

import type {
  AgreementLevel,
  ChangeProminence,
  ChangeType,
  ConfidenceClass,
  DataConfidenceLevel,
  ErrorClass,
  FamilyAvailability,
  GeometryKind,
  GeometryRole,
  HazardFamily,
  HazardType,
  LifecycleStatus,
  RelevanceLevel,
  RunStatus,
  RunTrigger,
  SourceCapability,
  SourceHealthStatus,
} from '../enums.ts';
import type { EvidenceId } from '../evidence/evidence-id.ts';
import type { GeoJsonGeometry } from '../value-objects/geography.ts';
import type { FamilyCoverage } from '../value-objects/location.ts';
import type { ProviderSeverity } from '../value-objects/provider-severity.ts';
import type { SourceHealthReason } from '../health/source-health.ts';
import type { SubjectRef } from '../value-objects/subject-ref.ts';
import type { IsoTimestamp } from '../value-objects/time.ts';

/**
 * Current version of the read-model contracts. Bumping it requires an ADR.
 *
 * 2 — ADR-038: `ObservationEvidenceDetail.rawPayload`, the raw-payload lifecycle state.
 */
export const READ_MODEL_SCHEMA_VERSION = 2;

export type ReadModelSchemaVersion = typeof READ_MODEL_SCHEMA_VERSION;

/**
 * A single value GeoNerva shows, tagged so that the UI can format it and so that "we don't know"
 * is a first-class case rather than a missing field.
 */
export type FactValue =
  | {
      readonly kind: 'number';
      readonly value: number;
      /** Unit symbol as rendered, e.g. `km`, `MW`, `ha`, `km/h`. `null` for dimensionless. */
      readonly unit: string | null;
      /** Decimal places the value must be rendered with, so that 5.30 never becomes 5.3. */
      readonly decimals: number;
    }
  | { readonly kind: 'count'; readonly value: number }
  | { readonly kind: 'text'; readonly value: string }
  /** A provider severity on its own scale. Never converted, never compared across schemes. */
  | { readonly kind: 'severity'; readonly severity: ProviderSeverity }
  | { readonly kind: 'timestamp'; readonly value: IsoTimestamp }
  | { readonly kind: 'boolean'; readonly value: boolean }
  /** GeoNerva has no value, and says which of the possible reasons applies. */
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason };

/** Why a value is missing. Rendered as words, never as an empty cell or a zero. */
export const UNAVAILABLE_REASONS = [
  'NOT_REPORTED_BY_SOURCE',
  'SOURCE_UNAVAILABLE',
  'NOT_COVERED',
  'INSUFFICIENT_HISTORY',
  'NOT_APPLICABLE',
  'BEYOND_REPLAY_HORIZON',
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * One labelled provider fact about a subject, with the evidence it came from. `code` is stable
 * and machine-readable; `label` is the already-localized human string produced by the
 * deterministic templates (there is no client-side i18n in v1).
 */
export interface Fact {
  readonly code: string;
  readonly label: string;
  readonly value: FactValue;
  readonly evidenceIds: readonly EvidenceId[];
}

/**
 * A machine-readable explanation. `code` is what tests assert on and what the change engine keys
 * off; `text` is the rendered sentence; `params` holds the numbers that appear in it, so the AI
 * validator can check that no number was invented (docs/ARCHITECTURE.md §11).
 */
export interface Reason {
  readonly code: string;
  readonly text: string;
  readonly params: Readonly<Record<string, string | number | boolean | null>>;
  readonly evidenceIds: readonly EvidenceId[];
}

/**
 * A relevance assessment (docs/ARCHITECTURE.md §9). Relevance answers "how much attention does
 * this deserve for this place?" — it is **not** a probability of harm, and `CRITICAL` is only
 * reachable with an `authoritativeBasis`, i.e. an official alert (invariant I10).
 */
export interface RelevanceAssessment {
  readonly level: RelevanceLevel;
  readonly reasons: readonly Reason[];
  /** Present if and only if `level === 'CRITICAL'`. */
  readonly authoritativeBasis: AuthoritativeBasis | null;
  /** Mandatory qualifications, e.g. the thermal-detection caveat. Always rendered. */
  readonly caveats: readonly string[];
  readonly evidenceIds: readonly EvidenceId[];
  readonly modelVersion: string;
}

/** The official alert that justifies a `CRITICAL` relevance. */
export interface AuthoritativeBasis {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly severity: ProviderSeverity;
  /** The authority's own wording, verbatim. */
  readonly statementVerbatim: string | null;
  readonly url: string | null;
  readonly evidenceId: EvidenceId;
}

/** How well the sources describing one event agree, and on what. */
export interface Agreement {
  readonly level: AgreementLevel;
  readonly nSources: number;
  /** Excludes derived copies: GDACS restating USGS is not a second opinion (ADR-006). */
  readonly nIndependentSources: number;
  readonly reasons: readonly Reason[];
  readonly comparisons: readonly FieldComparison[];
}

/** Per-field comparison across sources, which is what makes `CONFLICT` explainable. */
export interface FieldComparison {
  readonly code: string;
  readonly label: string;
  readonly values: readonly {
    readonly sourceId: string;
    readonly contributor: string | null;
    readonly value: FactValue;
    readonly evidenceId: EvidenceId;
  }[];
  /** Absolute spread between the extreme values, when the field is numeric. */
  readonly spread: FactValue | null;
  readonly isConflict: boolean;
}

/** Attribution and licence for one source, rendered in the footer and on `/methodology`. */
export interface Attribution {
  readonly sourceId: string;
  readonly name: string;
  readonly homepage: string | null;
  readonly licence: string;
  readonly attributionText: string;
  readonly termsUrl: string | null;
  /** The provider's own disclaimer, shown verbatim where the terms require it. */
  readonly disclaimer: string | null;
}

/** A geometry attached to an observation or event, with its role and whether it is a forecast. */
export interface GeometryView {
  readonly role: GeometryRole;
  readonly kind: GeometryKind;
  readonly geometry: GeoJsonGeometry;
  /** For forecast geometry: the time the geometry applies to. `null` for observed geometry. */
  readonly validAt: IsoTimestamp | null;
  readonly isForecast: boolean;
  readonly evidenceIds: readonly EvidenceId[];
}

/** The freshness policy as the API exposes it, so the UI can state the expected cadence. */
export interface FreshnessPolicyView {
  readonly pollIntervalS: number;
  readonly fetchFreshWithinS: number;
  readonly fetchStaleAfterS: number;
  readonly unavailableAfterS: number;
  readonly dataCurrentWithinS: number | null;
  readonly dataStaleAfterS: number | null;
  readonly quietIsNormal: boolean;
}

/** Derived source health, serialized (docs/DOMAIN_MODEL.md §4.3). */
export interface SourceHealthView {
  readonly sourceId: string;
  readonly productId: number | null;
  readonly status: SourceHealthStatus;
  readonly lastAttemptAt: IsoTimestamp | null;
  readonly lastSuccessAt: IsoTimestamp | null;
  readonly newestObservedAt: IsoTimestamp | null;
  readonly consecutiveFailures: number;
  readonly lastErrorClass: ErrorClass | null;
  readonly reasons: readonly SourceHealthReason[];
  readonly expected: FreshnessPolicyView;
  readonly evidenceId: EvidenceId | null;
}

/** A source product (feed or sensor) as the API exposes it. */
export interface SourceProductView {
  readonly id: number;
  readonly code: string;
  readonly hazardTypes: readonly HazardType[];
  readonly capabilities: readonly SourceCapability[];
  readonly platform: string | null;
  readonly instrument: string | null;
  readonly resolutionM: number | null;
  readonly status: 'ACTIVE' | 'RETIRING' | 'RETIRED';
  readonly activeFrom: string | null;
  readonly activeTo: string | null;
  readonly health: SourceHealthView;
}

/** A committed ingestion run, summarized for the data-status page. */
export interface RunSummaryView {
  readonly id: string;
  readonly productId: number | null;
  readonly trigger: RunTrigger;
  readonly status: RunStatus;
  readonly startedAt: IsoTimestamp;
  readonly committedAt: IsoTimestamp | null;
  readonly durationMs: number | null;
  readonly counts: {
    readonly received: number;
    readonly newRecords: number;
    readonly newVersions: number;
    readonly unchanged: number;
    readonly rejected: number;
  };
  readonly newestObservedAt: IsoTimestamp | null;
  readonly errorClass: ErrorClass | null;
  readonly evidenceId: EvidenceId;
}

/**
 * The earliest replayable knowledge time, per hazard family, derived from the retention profile
 * (ADR-018). The UI refuses to replay beyond it and says why, per family.
 */
export interface ReplayHorizon {
  readonly profile: 'lean' | 'standard';
  readonly byFamily: Readonly<
    Record<HazardFamily, { readonly earliestAsOf: IsoTimestamp; readonly note: string }>
  >;
}

/** Knowledge-time context, present on every as-of-aware response. */
export interface AsOfContext {
  /** The knowledge time the response was built for. */
  readonly asOf: IsoTimestamp;
  /** True when `asOf` is materially in the past, which makes the response immutable. */
  readonly isReplay: boolean;
  readonly replayHorizon: ReplayHorizon;
  /** Per source, the last run committed at or before `asOf` — the response's data cutoff. */
  readonly sourceCutoffs: Readonly<Record<string, IsoTimestamp | null>>;
}

/** One item in a family card or event list: a hazard subject assessed for this location. */
export interface SubjectSummary {
  readonly subjectRef: SubjectRef;
  readonly hazardType: HazardType;
  readonly family: HazardFamily;
  readonly publicId: string;
  /** Deterministic, template-generated title. Never provider HTML. */
  readonly title: string;
  readonly observedAt: IsoTimestamp;
  readonly lifecycleStatus: LifecycleStatus;
  readonly providerSeverity: ProviderSeverity | null;
  /** Great-circle distance from the location on the WGS84 spheroid, in km. */
  readonly distanceKm: number;
  /** For earthquakes: hypocentral distance, which is what relevance uses. */
  readonly hypocentralDistanceKm: number | null;
  readonly facts: readonly Fact[];
  readonly relevance: RelevanceAssessment;
  readonly agreement: Agreement | null;
  readonly evidenceIds: readonly EvidenceId[];
  /**
   * Deep link target within the app — a PRODUCT §6.1 route: `/event/EQ-26-7K3F9Q` or
   * `/fire/FR-26-2B8K4M`. (The G2 example said `/events/…`, a route that never existed.)
   */
  readonly href: string;
}

/** Confidence in the data behind a family card. Never a percentage (docs/ARCHITECTURE.md §9.7). */
export interface DataConfidence {
  readonly level: DataConfidenceLevel;
  readonly reasons: readonly Reason[];
}

/** One hazard-family card. */
export interface FamilyCard {
  readonly family: HazardFamily;
  /**
   * `AVAILABLE`, `UNAVAILABLE` (a source this family needs is STALE/UNAVAILABLE) or
   * `NOT_COVERED` (no source covers this place). When not `AVAILABLE`, `items` is empty **and**
   * no count may be rendered as zero (invariant I11).
   */
  readonly availability: FamilyAvailability;
  readonly coverage: FamilyCoverage;
  readonly items: readonly SubjectSummary[];
  /** True when `items` was capped; the cap and total are in `itemsTotal`. */
  readonly truncated: boolean;
  readonly itemsTotal: number;
  readonly metrics: readonly BaselineMetricView[];
  readonly dataConfidence: DataConfidence;
  /** Sources that feed this family, with their health at `asOf`. */
  readonly sourceHealth: readonly SourceHealthView[];
  readonly caveats: readonly string[];
}

/** A baseline metric (docs/DOMAIN_MODEL.md §4.13, ARCHITECTURE §8). */
export interface BaselineMetricView {
  /** `EV:BAS:<sha>` — the metric is content-addressed by its own inputs. */
  readonly id: EvidenceId;
  readonly family: HazardFamily;
  readonly metricCode: string;
  readonly label: string;
  readonly params: Readonly<Record<string, string | number | null>>;
  readonly asOf: IsoTimestamp;
  readonly status:
    'OK' | 'RARE_ACTIVITY' | 'INSUFFICIENT_HISTORY' | 'INSUFFICIENT_COVERAGE' | 'NOT_APPLICABLE';
  readonly observedValue: FactValue;
  /** Present only when `status === 'OK'`. */
  readonly reference: BaselineReference | null;
  /** Mid-rank empirical percentile, only when `status === 'OK'`. */
  readonly percentile: number | null;
  readonly band: 'BELOW_TYPICAL' | 'TYPICAL' | 'ABOVE_TYPICAL' | 'WELL_ABOVE_TYPICAL' | null;
  /** One plain sentence stating what the number means. Always present. */
  readonly interpretation: string;
  /** The mandatory caveat whenever the band is elevated. */
  readonly caveats: readonly string[];
  readonly methodVersion: string;
  readonly evidenceIds: readonly EvidenceId[];
}

/** The empirical reference distribution behind a baseline metric. */
export interface BaselineReference {
  readonly nWindows: number;
  readonly nEvents: number;
  readonly windowDays: number;
  readonly referenceFrom: IsoTimestamp;
  readonly referenceTo: IsoTimestamp;
  readonly median: number;
  readonly p25: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
  readonly mean: number;
  readonly ratePerWindow: number;
  /** Shown only when `mean >= 1`, to avoid "7× the baseline" from a tiny denominator. */
  readonly activityRatio: number | null;
}

/** Deterministic, template-generated copy. The only prose in a v1 response. */
export interface BriefingCopy {
  readonly headline: string;
  readonly summary: readonly string[];
  readonly byFamily: Readonly<Record<HazardFamily, readonly string[]>>;
  readonly caveats: readonly string[];
  readonly templateVersion: string;
}

/** One change signal, serialized (docs/DOMAIN_MODEL.md §4.15). */
export interface ChangeSignalView {
  /** `EV:CHG:<sha>` — content-addressed by the change itself. */
  readonly id: EvidenceId;
  readonly type: ChangeType;
  readonly family: HazardFamily;
  readonly subjectRef: SubjectRef | null;
  readonly metricCode: string | null;
  readonly title: string;
  readonly detail: string | null;
  readonly before: FactValue | null;
  readonly after: FactValue | null;
  readonly fromAsOf: IsoTimestamp;
  readonly toAsOf: IsoTimestamp;
  /** 0–100, deterministic (docs/ARCHITECTURE.md §10.4). */
  readonly importance: number;
  readonly prominence: ChangeProminence;
  readonly suppressionReason:
    | 'IMMATERIAL'
    | 'AGED_OUT'
    | 'LOW_RELEVANCE_BOTH'
    | 'HYSTERESIS'
    | 'FAMILY_NOT_COVERED'
    | 'GROUPED'
    | null;
  /** True when the event happened before the window but was only reported inside it. */
  readonly lateReport: boolean;
  /** Facets of a grouped signal, e.g. "M5.1 → M5.3" plus "relevance LOW → MODERATE". */
  readonly facets: readonly ChangeFacet[];
  readonly reasonCodes: readonly string[];
  readonly evidenceIds: readonly EvidenceId[];
  readonly engineVersion: string;
}

/** One aspect of a grouped change signal. */
export interface ChangeFacet {
  readonly type: ChangeType;
  readonly label: string;
  readonly before: FactValue | null;
  readonly after: FactValue | null;
}

/** The `What Changed?` section of a briefing. */
export interface ChangeSection {
  readonly window: ChangeWindow;
  readonly fromAsOf: IsoTimestamp;
  readonly toAsOf: IsoTimestamp;
  readonly headline: readonly ChangeSignalView[];
  readonly listed: readonly ChangeSignalView[];
  readonly detail: readonly ChangeSignalView[];
  /** Suppressed signals are returned, so that "Show N minor changes" is honest. */
  readonly suppressed: readonly ChangeSignalView[];
  readonly suppressedCount: number;
  /** Rendered when nothing reached `LISTED`. */
  readonly emptyStatement: string | null;
}

/** Comparison windows the API accepts. `since` is clamped server-side. */
export const CHANGE_WINDOWS = ['6h', '24h', '7d', 'since'] as const;
export type ChangeWindow = (typeof CHANGE_WINDOWS)[number];

/** A satellite product reference, for fire summaries. */
export interface SensorRef {
  readonly productId: number;
  readonly code: string;
  readonly platform: string | null;
  readonly instrument: string | null;
  readonly resolutionM: number | null;
}

/** Normalized detection confidence, with the provider's raw value kept alongside. */
export interface ConfidenceView {
  readonly class: ConfidenceClass;
  readonly raw: string | null;
}
