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
  | IngestionRunEvidenceDetail
  | CorrelationEvidenceDetail;

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
   * A bounded excerpt of the raw provider payload, for auditing. `null` once the retention window
   * has pruned the payload body — the hash stays forever, the body does not (§4.5).
   */
  readonly rawExcerpt: unknown;
  readonly rawPayloadSha256: string | null;
  readonly rawPayloadPruned: boolean;
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
