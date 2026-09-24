/**
 * `EvidenceItem` — the evidence manifest entry, and the `GET /api/v1/evidence/{id}` response
 * (docs/DOMAIN_MODEL.md §4.11, ADR-023).
 *
 * Every response that makes a claim ships an `evidenceManifest`, and **every** evidence ID
 * referenced anywhere inside that response must appear in it (invariant I9). Primary evidence
 * (`OBS`, `FCV`, `RUN`, `COR`) additionally resolves through the evidence endpoint, which returns
 * an `EvidenceDetail`. Derived evidence (`BAS`, `REL`, `CHG`) is content-addressed and
 * self-contained in the manifest, because its ID *is* the hash of the computation.
 *
 * The AI validator checks generated text against exactly this manifest: a claim that references
 * an ID outside it, or a number that does not appear in it, is rejected
 * (docs/ARCHITECTURE.md §11, invariant I12).
 */

import type { EvidenceId, EvidenceKind } from '../evidence/evidence-id.ts';
import type { LifecycleStatus } from '../enums.ts';
import type { IsoTimestamp } from '../value-objects/time.ts';
import type { Attribution, ReadModelSchemaVersion } from './common.ts';

/** One manifest entry: what this evidence is, where it came from, and when. */
export interface EvidenceItem {
  readonly id: EvidenceId;
  readonly kind: EvidenceKind;
  /**
   * One deterministic sentence describing the evidence, e.g. "USGS ComCat version 2 of us7000tikb,
   * M5.3 at 12 km depth". Template-generated; never provider HTML and never AI text.
   */
  readonly summary: string;
  /** The provider this evidence came from, or `null` for a GeoNerva derivation. */
  readonly sourceId: string | null;
  readonly productId: number | null;
  /** When the phenomenon happened, for provider facts. `null` for runs and derivations. */
  readonly observedAt: IsoTimestamp | null;
  /**
   * When GeoNerva learned it. For content-addressed derivations this is the `as_of` the
   * computation was made for, which is the value that participates in replay.
   */
  readonly ingestedAt: IsoTimestamp;
  /** The provider's canonical URL for this record, when one exists. */
  readonly url: string | null;
  /** True for the kinds the evidence endpoint can resolve. */
  readonly resolvable: boolean;
}

/** `GET /api/v1/evidence/{id}` — a resolved primary evidence item. Immutable, cached forever. */
export interface EvidenceDetail {
  readonly schemaVersion: ReadModelSchemaVersion;
  readonly item: EvidenceItem;
  /** The typed payload, discriminated on `item.kind`. */
  readonly detail: EvidenceDetailPayload;
  readonly attribution: readonly Attribution[];
}

export type EvidenceDetailPayload =
  | ObservationEvidenceDetail
  | FireClusterVersionEvidenceDetail
  | FireDetectionSetEvidenceDetail
  | IngestionRunEvidenceDetail
  | CorrelationEvidenceDetail;

/**
 * What became of the provider's original bytes for one observation (ADR-038).
 *
 *  - `AVAILABLE` — a body was captured and, at the knowledge time, was still within retention.
 *  - `PRUNED` — a body was captured, and retention had expired by the knowledge time. The digest
 *    still proves what was ingested.
 *  - `NOT_CAPTURED` — no body was ever stored: a backfilled record keeps only its digest from the
 *    outset (ADR-033), and some versions have no raw row at all.
 *  - `SOURCE_UNAVAILABLE` — a raw row is referenced but its metadata cannot be read by the serving
 *    process. A defensive state: the endpoint degrades instead of failing.
 *
 * The body itself is never served by the public API; this is its lifecycle, not its content.
 */
export const RAW_PAYLOAD_STATES = [
  'AVAILABLE',
  'PRUNED',
  'NOT_CAPTURED',
  'SOURCE_UNAVAILABLE',
] as const;
export type RawPayloadState = (typeof RAW_PAYLOAD_STATES)[number];

export interface RawPayloadView {
  readonly state: RawPayloadState;
  /** Hex SHA-256 of the payload as received, when a raw row is readable. Kept forever. */
  readonly sha256: string | null;
  /** When the body was first stored; `null` unless one was captured. */
  readonly capturedAt: IsoTimestamp | null;
  /** When retention removes (or removed) the body; `null` unless one was captured. */
  readonly retentionExpiresAt: IsoTimestamp | null;
}

/** `EV:OBS:<id>` — one immutable observation version. */
export interface ObservationEvidenceDetail {
  readonly kind: 'OBS';
  readonly versionId: string;
  readonly versionSeq: number;
  readonly sourceRecordPrimaryKey: string;
  readonly hazardType: string;
  readonly lifecycleStatus: LifecycleStatus;
  readonly observedAt: IsoTimestamp;
  readonly validFrom: IsoTimestamp | null;
  readonly validTo: IsoTimestamp | null;
  readonly sourceUpdatedAt: IsoTimestamp | null;
  readonly ingestedAt: IsoTimestamp;
  /** Agency credited with this solution (EMSC `auth`, USGS `net`). Load-bearing for agreement. */
  readonly contributor: string | null;
  /** Hash of the **normalized** content, which is the change detector. Hex. */
  readonly contentSha256: string;
  /**
   * Always `null` from the public API (ADR-038): provider bodies are an operator artifact, read from
   * the database by someone who already has the credentials, never redistributed here.
   */
  readonly rawExcerpt: unknown;
  /** Equal to `rawPayload.sha256`. */
  readonly rawPayloadSha256: string | null;
  /** Equal to `rawPayload.state === 'PRUNED'`. */
  readonly rawPayloadPruned: boolean;
  /** The raw payload's lifecycle and integrity metadata (ADR-038, schema version 2). */
  readonly rawPayload: RawPayloadView;
  readonly sourceUrl: string | null;
}

/** `EV:FCV:<id>` — one fire-cluster summary version. */
export interface FireClusterVersionEvidenceDetail {
  readonly kind: 'FCV';
  readonly clusterVersionId: string;
  readonly clusterPublicId: string;
  readonly asOf: IsoTimestamp;
  readonly detectionCountTotal: number;
  readonly detectionCount24h: number;
  readonly distinctOverpasses24h: number;
  readonly firstDetectedAt: IsoTimestamp;
  readonly lastDetectedAt: IsoTimestamp;
  readonly frpSum24h: number | null;
  readonly frpMax: number | null;
  readonly maxConfidence: string | null;
  readonly productIds: readonly number[];
  /** `EV:FDS:<clusterVersionId>:<count>` — the detection set behind this summary. */
  readonly detectionSetEvidenceId: EvidenceId;
  readonly contentSha256: string;
}

/**
 * `EV:FDS:<clusterVersionId>:<count>` — the set of detections behind one cluster summary.
 *
 * The set has no row of its own, which is why this took a resolver rather than a query: it is
 * **reconstructed through membership** at the summarising version's own knowledge time (ADR-039),
 * which is exactly what `DOMAIN_MODEL.md` §4.11 means by "resolvable via membership". The
 * detections whose assignment was known by then, in the clusters absorbed into this one by then.
 *
 * `countClaimed` is the number the id carries and the number the summary stated. `countHeld` is how
 * many of them are still stored. They differ only when retention has dropped a daily partition
 * since — never because membership resolved differently — and `retentionIncomplete` says which
 * case a reader is looking at, so a smaller number is never mistaken for a smaller fire.
 *
 * No detection rows are served. A pixel's coordinates are the provider's data and the set is
 * potentially hundreds of thousands of rows; what makes the citation checkable is the count, the
 * daily distribution and the window it was drawn from. That is the same restraint ADR-038 applies
 * to raw payloads: the lifecycle and the integrity of a fact, not its bytes.
 */
export interface FireDetectionSetEvidenceDetail {
  readonly kind: 'FDS';
  readonly clusterVersionId: string;
  readonly clusterPublicId: string;
  /** The summarising version's knowledge time: the moment membership is resolved at. */
  readonly asOf: IsoTimestamp;
  /** The count carried in the evidence id, as the cluster summary stated it. */
  readonly countClaimed: number;
  /** How many of those detections are still held at this knowledge time. */
  readonly countHeld: number;
  /** True when `countHeld < countClaimed`, which retention explains and membership does not. */
  readonly retentionIncomplete: boolean;
  /** The acquisition window the set was drawn from. */
  readonly firstDetectedAt: IsoTimestamp;
  readonly lastDetectedAt: IsoTimestamp;
  /** Detections per acquisition day, so the shape of the set is checkable without its rows. */
  readonly byDay: readonly {
    readonly day: string;
    readonly count: number;
    readonly frpSum: number | null;
  }[];
  /** The summary this set belongs to, so a reader can compare the two. */
  readonly clusterVersionEvidenceId: EvidenceId;
}

/** `EV:RUN:<uuid>` — one ingestion run; the evidence behind every health statement. */
export interface IngestionRunEvidenceDetail {
  readonly kind: 'RUN';
  readonly runId: string;
  readonly sourceId: string;
  readonly productId: number | null;
  readonly trigger: string;
  readonly status: string;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp | null;
  readonly committedAt: IsoTimestamp | null;
  readonly httpStatus: number | null;
  readonly bytesReceived: number | null;
  readonly counts: {
    readonly received: number;
    readonly newRecords: number;
    readonly newVersions: number;
    readonly unchanged: number;
    readonly rejected: number;
  };
  readonly newestObservedAt: IsoTimestamp | null;
  readonly errorClass: string | null;
  /** Sanitized, ≤ 1 KB. Never a raw provider body and never a connection string. */
  readonly errorMessage: string | null;
  readonly payloadSha256: string | null;
  readonly workerVersion: string | null;
}

/** `EV:COR:<id>` — one correlation decision, i.e. why two records are (or are not) one event. */
export interface CorrelationEvidenceDetail {
  readonly kind: 'COR';
  readonly linkId: string;
  readonly canonicalEventPublicId: string;
  readonly sourceRecordPrimaryKey: string;
  readonly sourceId: string;
  readonly relation: 'PRIMARY' | 'SAME_EVENT' | 'DERIVED_COPY';
  readonly matchKind: 'IDENTITY_REF' | 'SPATIOTEMPORAL' | 'SEED';
  readonly confidence: number | null;
  /** The reason codes and measured misfits the decision was made on. */
  readonly reasons: unknown;
  readonly algorithmVersion: string;
  readonly linkedAt: IsoTimestamp;
  readonly unlinkedAt: IsoTimestamp | null;
  readonly unlinkReason: string | null;
}
