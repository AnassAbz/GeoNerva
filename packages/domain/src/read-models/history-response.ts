/**
 * `HistoryResponse` — the response of `GET /api/v1/history`, which backs the charts and the
 * "is this unusual here?" question (docs/ARCHITECTURE.md §8).
 *
 * Three rules from §8 shape this contract:
 *
 *  1. **Compare like with like.** Every parameter that makes two numbers comparable — radius,
 *     magnitude of completeness, window length, sensor group, reference period — is echoed in
 *     `params`, so a chart can never be read out of context.
 *  2. **Refuse statistics the data cannot support.** `status` is part of the contract, and
 *     `RARE_ACTIVITY` is a *result*, not a failure: "3 earthquakes of M4.5+ within 150 km in the
 *     past 25 years" is often the most useful context there is.
 *  3. **Never say "normal" when data is missing.** `INSUFFICIENT_HISTORY` renders as "not enough
 *     history to establish a baseline", and `series` may be empty while the response is valid.
 */

import type { HazardFamily } from '../enums.ts';
import type { EvidenceId } from '../evidence/evidence-id.ts';
import type { LocationRef } from '../value-objects/location.ts';
import type { IsoTimestamp } from '../value-objects/time.ts';
import type {
  AsOfContext,
  Attribution,
  BaselineMetricView,
  FactValue,
  ReadModelSchemaVersion,
} from './common.ts';
import type { EvidenceItem } from './evidence-item.ts';

export interface HistoryResponse {
  readonly schemaVersion: ReadModelSchemaVersion;
  readonly location: LocationRef;
  readonly family: HazardFamily;
  readonly metricCode: string;
  readonly asOfContext: AsOfContext;
  /** The metric itself, with its status, band, percentile and interpretation sentence. */
  readonly metric: BaselineMetricView;
  /** The observed series the chart draws. Empty when the metric has no supportable series. */
  readonly series: readonly TimeSeriesView[];
  /** The reference distribution as chart-ready bands, or `null` when `status !== 'OK'`. */
  readonly referenceBands: ReferenceBandsView | null;
  /** Shown instead of a percentile when `status === 'RARE_ACTIVITY'`. */
  readonly rarity: RarityStatementView | null;
  /** "Largest within 150 km since 2019", when the metric supports it. */
  readonly largestRecent: LargestRecentView | null;
  /** "Activity follows the M6.1 earthquake on 12 Sep", when a large event preceded the window. */
  readonly sequenceContext: SequenceContextView | null;
  /**
   * Completeness statement, e.g. "Counts include earthquakes of M3.1 and larger (the smallest
   * size reliably recorded here)." Always present when a completeness threshold applies.
   */
  readonly completenessStatement: string | null;
  readonly caveats: readonly string[];
  /** Deep link to the methodology page section that explains this metric. */
  readonly methodologyHref: string;
  readonly evidenceManifest: readonly EvidenceItem[];
  readonly attribution: readonly Attribution[];
}

/** One plotted series. */
export interface TimeSeriesView {
  readonly code: string;
  readonly label: string;
  readonly unit: string | null;
  /** Length of each bucket in days; `1` for daily counts, `7` for weekly windows. */
  readonly bucketDays: number;
  readonly points: readonly TimeSeriesPoint[];
}

export interface TimeSeriesPoint {
  /** Start of the bucket, UTC. */
  readonly t: IsoTimestamp;
  /** `null` where the value is genuinely unknown (e.g. no satellite coverage that day). */
  readonly value: number | null;
  /** Set when `value` is `null`, so the chart can render a gap with an explanation. */
  readonly missingReason: string | null;
}

/** Percentile bands of the reference distribution, for shading behind the series. */
export interface ReferenceBandsView {
  readonly windowDays: number;
  readonly nWindows: number;
  readonly nEvents: number;
  readonly referenceFrom: IsoTimestamp;
  readonly referenceTo: IsoTimestamp;
  readonly p25: number;
  readonly median: number;
  readonly p75: number;
  readonly p90: number;
  readonly p95: number;
  readonly mean: number;
  readonly evidenceIds: readonly EvidenceId[];
}

/** The rarity statement shown when a distribution would be meaningless. */
export interface RarityStatementView {
  readonly nEvents: number;
  readonly sinceYear: number;
  readonly radiusKm: number;
  readonly thresholdLabel: string;
  readonly text: string;
  readonly evidenceIds: readonly EvidenceId[];
}

/** "The largest in this radius since …". */
export interface LargestRecentView {
  readonly value: FactValue;
  readonly observedAt: IsoTimestamp;
  readonly subjectPublicId: string | null;
  readonly comparisonSince: IsoTimestamp;
  readonly text: string;
  readonly evidenceIds: readonly EvidenceId[];
}

/** Aftershock-sequence context. A well-established observation, never a forecast. */
export interface SequenceContextView {
  readonly triggerPublicId: string;
  readonly triggerValue: FactValue;
  readonly triggerObservedAt: IsoTimestamp;
  readonly text: string;
  readonly caveat: string;
  readonly evidenceIds: readonly EvidenceId[];
}
