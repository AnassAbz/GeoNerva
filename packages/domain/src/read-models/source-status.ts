/**
 * `SourceStatus` — the response of `GET /api/v1/sources/status`, which backs the `/data-status`
 * page (docs/ARCHITECTURE.md §14).
 *
 * This is the read model that makes GeoNerva's central promise checkable: the product's value is
 * being *right about what it does not know*. Every source states its health, the policy that
 * health was judged against, its recent runs, its coverage limits and its licence — so a user can
 * see that "no earthquakes near you" and "we cannot currently see earthquakes near you" are
 * different answers.
 *
 * Health is derived, never stored (ADR-022), so this endpoint also accepts `as_of`: asking what
 * GeoNerva knew about a source at 12:10 is the same query with a different knowledge time.
 */

import type { HazardType, SourceCapability } from '../enums.ts';
import type { IsoTimestamp } from '../value-objects/time.ts';
import type {
  AsOfContext,
  Attribution,
  ReadModelSchemaVersion,
  RunSummaryView,
  SourceHealthView,
  SourceProductView,
} from './common.ts';
import type { EvidenceItem } from './evidence-item.ts';

export interface SourceStatus {
  readonly schemaVersion: ReadModelSchemaVersion;
  readonly asOfContext: AsOfContext;
  readonly generatedAt: IsoTimestamp;
  readonly sources: readonly SourceStatusEntry[];
  /**
   * Heartbeat of the ingestion worker.
   *
   * `null` means **GeoNerva cannot state the worker's liveness at this knowledge time** — either
   * it has never reported in, or the request is a replay. The row is a single record updated in
   * place with no history, so a past `as_of` has nothing to read; that is the one operational
   * signal in these contracts that is not replayable, and the two cases are deliberately not
   * distinguished because the honest answer to both is the same.
   */
  readonly worker: WorkerStatusView | null;
  /** Data-quality checks run after each ingestion batch (docs/TESTING.md §7). */
  readonly dataQuality: readonly DataQualityCheckView[];
  readonly evidenceManifest: readonly EvidenceItem[];
  readonly attribution: readonly Attribution[];
}

export interface SourceStatusEntry {
  readonly sourceId: string;
  readonly name: string;
  readonly homepage: string | null;
  readonly enabled: boolean;
  readonly licence: string;
  readonly attributionText: string;
  readonly termsUrl: string | null;
  /** The provider's own disclaimer, shown verbatim where the terms require it. */
  readonly disclaimer: string | null;
  /**
   * Plain-language statement of what this source does and does not cover, e.g.
   * "Canada only", "complete from about M4.5 outside the United States".
   */
  readonly coverageNote: string | null;
  /** `null` means global coverage. */
  readonly coverageGeometryAvailable: boolean;
  readonly hazardTypes: readonly HazardType[];
  readonly capabilities: readonly SourceCapability[];
  /** Rollup across products: the **worst** product status wins. */
  readonly health: SourceHealthView;
  readonly products: readonly SourceProductView[];
  /** Newest first, bounded. */
  readonly recentRuns: readonly RunSummaryView[];
  /** Share of committed runs in the last 24 h that succeeded, or `null` when there were none. */
  readonly successRate24h: number | null;
  /** Runs committed in the last 24 h, so the rate above can be read honestly. */
  readonly runCount24h: number;
}

export interface WorkerStatusView {
  readonly lastSeenAt: IsoTimestamp;
  readonly version: string | null;
  /** True when the heartbeat is older than twice its interval. */
  readonly isStale: boolean;
}

/** One runtime data-quality invariant and its current value (docs/TESTING.md §7). */
export interface DataQualityCheckView {
  readonly code: string;
  readonly label: string;
  readonly status: 'OK' | 'WARN' | 'ALARM';
  readonly value: number | null;
  readonly threshold: number | null;
  readonly detail: string | null;
  readonly checkedAt: IsoTimestamp;
}
