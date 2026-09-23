/**
 * `FireClusterDetail` — the response of `GET /api/v1/fire-clusters/{publicId}`.
 *
 * Terminology is enforced by the type system (ADR-020, docs/DOMAIN_MODEL.md §4.10): this is a
 * **fire activity cluster** built from satellite **thermal detections**. It is not a wildfire, it
 * has no perimeter, and a detection is "the centre of a pixel flagged as containing one or more
 * fires" — not a fire count and not an area. `mandatoryCaveat` is always rendered, because
 * gas flares, industrial sites and volcanoes appear as detections too
 * (docs/ARCHITECTURE.md §9.2, docs/DATA_SOURCES.md §3.4).
 *
 * Detections are immutable and have no revisions, so history here is a sequence of **summary
 * versions**: a new version exists only where the summary actually changed (§4.10).
 */

import type { FireClusterStatus } from '../enums.ts';
import type { EvidenceId } from '../evidence/evidence-id.ts';
import type { GeoJsonGeometry } from '../value-objects/geography.ts';
import type { SubjectRef } from '../value-objects/subject-ref.ts';
import type { IsoTimestamp } from '../value-objects/time.ts';
import type {
  AsOfContext,
  Attribution,
  ConfidenceView,
  Fact,
  ReadModelSchemaVersion,
  RelevanceAssessment,
  SensorRef,
} from './common.ts';
import type { EvidenceItem } from './evidence-item.ts';
import type { RelatedEventRef } from './event-detail.ts';

export interface FireClusterDetail {
  readonly schemaVersion: ReadModelSchemaVersion;
  readonly publicId: string;
  readonly subjectRef: SubjectRef;
  readonly asOfContext: AsOfContext;

  /** `ACTIVE` (detection ≤ 24 h) → `COOLING` (24–72 h) → `INACTIVE` (> 72 h). */
  readonly status: FireClusterStatus;
  readonly createdAt: IsoTimestamp;
  readonly summary: FireClusterSummaryView;
  /** Convex hull of the member detections, buffered by half a pixel. Not a fire perimeter. */
  readonly hull: GeoJsonGeometry | null;
  readonly centroid: GeoJsonGeometry;

  /** Present only when the request supplied a location. */
  readonly relevance: RelevanceAssessment | null;
  /** Distance to the cluster centroid, in km. */
  readonly distanceKm: number | null;
  /** Distance to the **nearest detection**, which is what the relevance model uses. */
  readonly nearestDetectionKm: number | null;

  /** Summary versions, newest first. One per clustering run where the summary changed. */
  readonly versions: readonly FireClusterVersionView[];
  readonly detections: FireClusterDetectionsView;

  /** When this cluster was merged into another, the survivor's public ID. */
  readonly mergedIntoPublicId: string | null;
  readonly mergedAt: IsoTimestamp | null;
  readonly mergedFromPublicIds: readonly string[];

  /** For example an official GDACS `WILDFIRE_EVENT` nearby. Related, never "the same". */
  readonly relatedEvents: readonly RelatedEventRef[];

  /**
   * "Satellite thermal detections can include non-vegetation heat sources (e.g. gas flares,
   * industrial sites, volcanoes). They are not confirmed wildfires." Always present.
   */
  readonly mandatoryCaveat: string;
  readonly evidenceManifest: readonly EvidenceItem[];
  readonly attribution: readonly Attribution[];
}

/** The cluster summary at `asOf`, i.e. the latest version with `as_of ≤ T`. */
export interface FireClusterSummaryView {
  readonly clusterVersionId: string;
  /** When this summary version was computed. */
  readonly asOf: IsoTimestamp;
  /**
   * The end of the 24-hour window the rolling figures below cover.
   *
   * It is **not** always `asOf`. Those figures are a rolling window the worker computed when it
   * last clustered, and a reader arriving hours later was shown them as "the last 24 hours" —
   * eight detections where the rows held five, because three had fallen out of the window
   * (QA round 2, M-2). For a live read they are recounted to the knowledge time and this says so;
   * for a replay they are the version's own, and this is the version's `asOf`. Either way the
   * reader can be told which twenty-four hours they are.
   */
  readonly countedTo: IsoTimestamp;
  readonly detectionCountTotal: number;
  readonly detectionCount24h: number;
  /**
   * Distinct satellite overpasses in the last 24 h (distinct `(product, acquired_at)` within
   * 10 minutes). Two overpasses mean two independent looks, which is why it drives relevance.
   */
  readonly distinctOverpasses24h: number;
  readonly firstDetectedAt: IsoTimestamp;
  readonly lastDetectedAt: IsoTimestamp;
  /** Sum of fire radiative power over the last 24 h, in megawatts. */
  readonly frpSum24h: number | null;
  readonly frpMax: number | null;
  readonly maxConfidence: ConfidenceView | null;
  readonly sensors: readonly SensorRef[];
  readonly facts: readonly Fact[];
  readonly evidenceIds: readonly EvidenceId[];
}

/** One historical summary version. */
export interface FireClusterVersionView {
  readonly clusterVersionId: string;
  readonly asOf: IsoTimestamp;
  readonly detectionCountTotal: number;
  readonly detectionCount24h: number;
  readonly distinctOverpasses24h: number;
  readonly frpSum24h: number | null;
  readonly frpMax: number | null;
  readonly lastDetectedAt: IsoTimestamp;
  /** What changed versus the previous version, e.g. "detections 12 → 31". */
  readonly summary: string;
  readonly evidenceId: EvidenceId;
}

/**
 * The detections behind the cluster. Never the full set: raw detections are capped, and the
 * response says so rather than silently truncating (docs/ARCHITECTURE.md §7.5).
 */
export interface FireClusterDetectionsView {
  readonly total: number;
  readonly truncated: boolean;
  readonly cap: number;
  readonly sample: readonly FireDetectionView[];
  /** Daily counts, which is how fire activity is compared — never per satellite pass (§10.3). */
  readonly byDay: readonly {
    readonly day: string;
    readonly count: number;
    readonly frpSum: number | null;
    /** False when FIRMS `missing_data` says there was no satellite coverage that day. */
    readonly hasSatelliteCoverage: boolean;
  }[];
  /** `EV:FDS:<clusterVersionId>:<count>` for the set as a whole. */
  readonly evidenceId: EvidenceId;
}

/** One immutable thermal detection. */
export interface FireDetectionView {
  readonly acquiredAt: IsoTimestamp;
  readonly lat: number;
  readonly lon: number;
  readonly productId: number;
  readonly confidence: ConfidenceView;
  readonly frpMw: number | null;
  readonly brightnessTi4K: number | null;
  readonly brightnessTi5K: number | null;
  readonly daynight: 'D' | 'N' | null;
  /** Along-scan and along-track pixel size in km: the pixel grows off-nadir. */
  readonly scanKm: number | null;
  readonly trackKm: number | null;
  readonly distanceKm: number | null;
}
