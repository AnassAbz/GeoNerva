/**
 * The evidence read models: `EvidenceItem` (a manifest entry) and `EvidenceDetail` (the response
 * of `GET /api/v1/evidence/{id}`).
 *
 * ### What a manifest entry promises
 *
 * A manifest entry answers "what is this citation, and can I follow it?" — nothing more. The
 * `resolvable` flag is the only value computed rather than copied, and it is computed from the
 * **kind**, not from whether this particular lookup happened to succeed: the endpoint can resolve
 * a primary kind and cannot resolve a content-addressed one, and that is a property of the kind for
 * all time. Deciding it per row would make the same citation resolvable in one response and not in
 * another.
 *
 * `EV:FDS` is the case G7 found the hard way. It is neither primary nor content-addressed: it names
 * the detection set behind a cluster version, its count travels in the ID itself, and no row exists
 * for it. It now reports `resolvable: true`, because the endpoint reconstructs the set through
 * membership at the summary's knowledge time rather than looking for a row — resolvable without
 * being primary, which is the third category `RESOLVABLE_EVIDENCE_KINDS` exists to name.
 *
 * ### What a detail promises
 *
 * That the citation is checkable: the row it points at, at the knowledge time it is asked about,
 * with the times kept apart. `observedAt`, `validFrom`/`validTo`, `sourceUpdatedAt` and
 * `ingestedAt` are four different questions and this is the endpoint that must never collapse them
 * — it is the one place a reader can see that GeoNerva learned at 12:04 about something that
 * happened at 11:58 and that the provider last revised at 12:01.
 */

import {
  isResolvableEvidenceKind,
  evidenceId,
  parseEvidenceId,
  READ_MODEL_SCHEMA_VERSION,
  type EvidenceDetail,
  type EvidenceDetailPayload,
  type EvidenceItem,
  type EvidenceKind,
  type LifecycleStatus,
  LIVE_PAYLOAD_RETENTION_DAYS,
  type RawPayloadView,
  type RetentionProfile,
} from '@geonerva/domain';

import { toAttribution } from './attribution.ts';

import type {
  AttributionRow,
  ClusterDetectionReconstruction,
  ClusterEvidenceRow,
  CorrelationEvidenceRow,
  EvidenceRow,
  ObservationEvidenceRow,
  RunEvidenceRow,
} from './db.ts';

export function toEvidenceItem(row: EvidenceRow): EvidenceItem {
  const kind = row.kind as EvidenceKind;
  return {
    id: row.id,
    kind,
    summary: row.summary,
    sourceId: row.source_id,
    productId: row.product_id,
    observedAt: row.observed_at?.toISOString() ?? null,
    ingestedAt: row.ingested_at.toISOString(),
    /* Same scheme guard as `sourceUrl`: a manifest entry's `url` is provider-controlled too. */
    url: webUrlOrNull(row.url),
    resolvable: isResolvableKind(kind),
  };
}

/** True for every kind `GET /api/v1/evidence/{id}` can serve, row-backed or reconstructed. */
export function isResolvableKind(kind: EvidenceKind): boolean {
  return isResolvableEvidenceKind(kind);
}

/** Wraps a manifest entry and its payload into the endpoint's frozen response. */
export function buildEvidenceDetail(input: {
  readonly item: EvidenceItem;
  readonly detail: EvidenceDetailPayload;
  readonly attribution: readonly AttributionRow[];
}): EvidenceDetail {
  return {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    item: input.item,
    detail: input.detail,
    attribution: input.attribution.map(toAttribution),
  };
}

/**
 * The raw payload's lifecycle at a knowledge time (ADR-038).
 *
 * `payload_pruned` is updated in place when retention removes a body, so reading it as it is now
 * would let a replay see a pruning that happened after its knowledge time. Retention never removes
 * a body before `first_seen_at` plus the profile's window, so the state at `asOf` is judged against
 * that expiry instead: before it the body was held, after it the body is — or will be — gone.
 */
export function rawPayloadViewOf(
  row: ObservationEvidenceRow,
  context: { readonly asOf: Date; readonly retentionProfile: RetentionProfile },
): RawPayloadView {
  if (!row.raw_record_present) {
    return { state: 'NOT_CAPTURED', sha256: null, capturedAt: null, retentionExpiresAt: null };
  }
  if (row.raw_payload_sha256 === null || row.raw_first_seen_at === null) {
    return {
      state: 'SOURCE_UNAVAILABLE',
      sha256: null,
      capturedAt: null,
      retentionExpiresAt: null,
    };
  }
  if (row.raw_payload_captured !== true) {
    return {
      state: 'NOT_CAPTURED',
      sha256: row.raw_payload_sha256,
      capturedAt: null,
      retentionExpiresAt: null,
    };
  }
  const expiresAt = new Date(
    row.raw_first_seen_at.getTime() +
      LIVE_PAYLOAD_RETENTION_DAYS[context.retentionProfile] * 24 * 60 * 60 * 1000,
  );
  return {
    state: context.asOf.getTime() < expiresAt.getTime() ? 'AVAILABLE' : 'PRUNED',
    sha256: row.raw_payload_sha256,
    capturedAt: row.raw_first_seen_at.toISOString(),
    retentionExpiresAt: expiresAt.toISOString(),
  };
}

/**
 * `EV:OBS` — the observation version payload.
 *
 * The raw payload is described, never served (ADR-038): `rawPayload` carries its lifecycle state,
 * digest, capture time and retention expiry; `rawExcerpt` is always `null`; `rawPayloadSha256` and
 * `rawPayloadPruned` restate `rawPayload` for the fields P8 shipped with.
 *
 * `contentSha256` is the field that matters for comparison: it is the **only** change detector
 * (ADR-029), computed over the normalized content, so two versions stay comparable without either
 * payload.
 */
export function observationPayload(
  row: ObservationEvidenceRow,
  context: { readonly asOf: Date; readonly retentionProfile: RetentionProfile },
): EvidenceDetailPayload {
  const rawPayload = rawPayloadViewOf(row, context);
  return {
    kind: 'OBS',
    versionId: row.version_id,
    versionSeq: row.version_seq,
    sourceRecordPrimaryKey: row.primary_key,
    hazardType: row.hazard_type,
    lifecycleStatus: row.lifecycle_status as LifecycleStatus,
    observedAt: row.observed_at.toISOString(),
    validFrom: row.valid_from?.toISOString() ?? null,
    validTo: row.valid_to?.toISOString() ?? null,
    sourceUpdatedAt: row.source_updated_at?.toISOString() ?? null,
    ingestedAt: row.ingested_at.toISOString(),
    contributor: row.contributor,
    contentSha256: row.content_sha256,
    rawExcerpt: null,
    rawPayloadSha256: rawPayload.sha256,
    rawPayloadPruned: rawPayload.state === 'PRUNED',
    rawPayload,
    sourceUrl: webUrlOrNull(row.source_url),
  };
}

/**
 * A provider URL, or `null` when its scheme is not one a reader may safely follow.
 *
 * `source_url` is a provider-controlled string stored verbatim, and nothing on the write path
 * checks its scheme — so a feed containing `javascript:…` or `data:text/html,…` would be served
 * from a public endpoint and land in an `href`. SECURITY.md H1 puts the link-rendering control in
 * the frontend, which is the right place for GeoNerva's own UI and no help at all to any other
 * consumer of this API.
 *
 * Dropping the value rather than passing it through loses nothing a reader could use: a URL they
 * must not open is not a citation. The deeper fix belongs at normalize time, where the value could
 * be refused on arrival instead of on the way out.
 */
function webUrlOrNull(value: string | null): string | null {
  if (value === null) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value.trim())?.[1]?.toLowerCase();
  return scheme === 'https' || scheme === 'http' ? value : null;
}

/** `EV:FCV` — the cluster summary payload, plus the detection-set ID it summarizes. */
/**
 * `EV:FDS:<clusterVersionId>:<count>` — the detection set behind one cluster summary.
 *
 * The two counts are the point of this payload. `countClaimed` is what the id carries and what the
 * summary stated; `countHeld` is how many of those detections are still stored at this knowledge
 * time. They diverge only when retention has dropped a daily partition since — membership is not in
 * question (ADR-039) — and `retentionIncomplete` names that so a smaller number is never read as a
 * smaller fire.
 *
 * `byDay` is served because it makes the set checkable without serving it: a reader can see the
 * shape of the fire across acquisition days. Individual pixels are not served at all.
 */
export function detectionSetPayload(
  ref: { readonly clusterVersionId: string; readonly count: number },
  row: ClusterEvidenceRow,
  reconstruction: ClusterDetectionReconstruction,
): EvidenceDetailPayload {
  return {
    kind: 'FDS',
    clusterVersionId: row.cluster_version_id,
    clusterPublicId: row.cluster_public_id,
    asOf: row.as_of.toISOString(),
    countClaimed: ref.count,
    countHeld: reconstruction.count,
    retentionIncomplete: reconstruction.count < ref.count,
    firstDetectedAt: row.first_detected_at.toISOString(),
    lastDetectedAt: row.last_detected_at.toISOString(),
    byDay: reconstruction.byDay.map((entry) => ({
      day: entry.day,
      count: entry.count,
      frpSum: entry.frp_sum,
    })),
    clusterVersionEvidenceId: evidenceId.fireClusterVersion(row.cluster_version_id),
  };
}

export function clusterPayload(row: ClusterEvidenceRow): EvidenceDetailPayload {
  return {
    kind: 'FCV',
    clusterVersionId: row.cluster_version_id,
    clusterPublicId: row.cluster_public_id,
    asOf: row.as_of.toISOString(),
    detectionCountTotal: row.n_total,
    detectionCount24h: row.n_24h,
    distinctOverpasses24h: row.overpasses_24h,
    firstDetectedAt: row.first_detected_at.toISOString(),
    lastDetectedAt: row.last_detected_at.toISOString(),
    frpSum24h: row.frp_sum_24h,
    frpMax: row.frp_max,
    maxConfidence: row.max_confidence,
    productIds: [...row.product_ids],
    /*
     * The total, not the 24-hour count — matching `snapshot.ts`, which is the module that mints
     * this ID when a briefing cites a cluster. The two must agree character for character or the
     * manifest lookup that invariant I9 checks would miss.
     */
    detectionSetEvidenceId: evidenceId.detectionSet(row.cluster_version_id, row.n_total),
    contentSha256: row.content_sha256,
  };
}

/** `EV:RUN` — the ingestion-run payload. */
export function runPayload(row: RunEvidenceRow): EvidenceDetailPayload {
  return {
    kind: 'RUN',
    runId: row.run_id,
    sourceId: row.source_id,
    productId: row.product_id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    committedAt: row.committed_at?.toISOString() ?? null,
    httpStatus: row.http_status,
    bytesReceived: row.bytes_received,
    counts: {
      received: row.n_received,
      newRecords: row.n_new_records,
      newVersions: row.n_new_versions,
      unchanged: row.n_unchanged,
      rejected: row.n_rejected,
    },
    newestObservedAt: row.newest_observed_at?.toISOString() ?? null,
    errorClass: row.error_class,
    /*
     * `null`, not the column. The contract promises "never a raw provider body and never a
     * connection string", and the write path does not deliver that: `sanitizeDetail` is a length
     * cap, and `SourceFetchError.describe()` puts the provider's host and path in the column. The
     * class is the part a reader can act on and is a closed enumeration; the message is free text
     * from a provider. See `runEvidenceAsOf` for the full reasoning.
     */
    errorMessage: null,
    payloadSha256: row.payload_sha256,
    workerVersion: row.worker_version,
  };
}

/** `EV:COR` — the correlation-decision payload. */
export function correlationPayload(row: CorrelationEvidenceRow): EvidenceDetailPayload {
  return {
    kind: 'COR',
    linkId: row.link_id,
    canonicalEventPublicId: row.canonical_event_public_id,
    sourceRecordPrimaryKey: row.source_record_primary_key,
    sourceId: row.source_id,
    relation: row.relation as 'PRIMARY' | 'SAME_EVENT' | 'DERIVED_COPY',
    matchKind: row.match_kind as 'IDENTITY_REF' | 'SPATIOTEMPORAL' | 'SEED',
    /*
     * `numeric(4,3)` arrives as a string, and an unparseable one becomes `null` rather than zero.
     * A confidence of 0 is a real value meaning "no confidence"; `null` means GeoNerva has none to
     * report. Collapsing the two would turn a missing number into a maximally negative claim.
     */
    confidence: numberOf(row.confidence),
    reasons: row.reasons,
    algorithmVersion: row.algorithm_version,
    linkedAt: row.linked_at.toISOString(),
    unlinkedAt: row.unlinked_at?.toISOString() ?? null,
    unlinkReason: row.unlink_reason,
  };
}

function numberOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Re-exported so a handler never hand-rolls the grammar. */
export { parseEvidenceId };
