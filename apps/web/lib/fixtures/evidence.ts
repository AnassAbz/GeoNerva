/**
 * `EvidenceDetail` fixtures for the resolver contract (`GET /api/v1/evidence/{id}`).
 *
 * `observationEvidence` takes the raw payload's lifecycle state (ADR-038), because all four of
 * them are reachable on the wire and the drawer renders a different sentence for each. The
 * combinations are not free-form: `rawPayloadViewSchema` ties the populated fields to the state —
 * a captured body has a digest, a capture time and an expiry, and nothing else claims either
 * time — so each variant here is the shape `rawPayloadViewOf` would actually return.
 */

import type { EvidenceDetail, RawPayloadView } from '@geonerva/domain';

import { FIXTURE_NOW, SCHEMA_VERSION, attributionFor, hex64 } from './common.ts';
import { EV, T, evidenceRegistry } from './world.ts';

function itemFor(id: string) {
  const item = evidenceRegistry(FIXTURE_NOW).get(id);
  if (item === undefined) throw new Error(`no fixture evidence item ${id}`);
  return item;
}

/** 30 days is the lean profile's live-payload window (ADR-033). */
const RETENTION_MS = 30 * 86_400_000;

/**
 * One raw-payload lifecycle, in the shape the endpoint serves it.
 *
 * `PRUNED` is dated in July so that its expiry is genuinely in the past at `FIXTURE_NOW`: the
 * state is judged against `capturedAt + window`, not against a stored flag, and a fixture whose
 * expiry had not passed would be describing an `AVAILABLE` row.
 */
function rawPayloadFixture(state: RawPayloadView['state']): RawPayloadView {
  switch (state) {
    case 'AVAILABLE':
      return {
        state,
        sha256: hex64('obs-90211-raw'),
        capturedAt: T.usgsV2Ingested,
        retentionExpiresAt: new Date(Date.parse(T.usgsV2Ingested) + RETENTION_MS).toISOString(),
      };
    case 'PRUNED':
      return {
        state,
        sha256: hex64('obs-90211-raw'),
        capturedAt: '2026-07-01T09:14:00.000Z',
        retentionExpiresAt: new Date(
          Date.parse('2026-07-01T09:14:00.000Z') + RETENTION_MS,
        ).toISOString(),
      };
    /* No raw row at all: no digest, and no times to report — nothing was ever held to prune. */
    case 'NOT_CAPTURED':
      return { state, sha256: null, capturedAt: null, retentionExpiresAt: null };
    /* The defensive state: a row is referenced and its metadata cannot be read. */
    case 'SOURCE_UNAVAILABLE':
      return { state, sha256: null, capturedAt: null, retentionExpiresAt: null };
  }
}

export function observationEvidence(
  options: { raw?: RawPayloadView['state'] } = {},
): EvidenceDetail {
  const rawPayload = rawPayloadFixture(options.raw ?? 'AVAILABLE');
  return {
    schemaVersion: SCHEMA_VERSION,
    item: itemFor(EV.usgsV2),
    detail: {
      kind: 'OBS',
      versionId: '90211',
      versionSeq: 2,
      sourceRecordPrimaryKey: 'us7000tikb',
      hazardType: 'EARTHQUAKE',
      lifecycleStatus: 'UPDATED',
      observedAt: T.eqObserved,
      validFrom: null,
      validTo: null,
      sourceUpdatedAt: T.usgsV2Updated,
      ingestedAt: T.usgsV2Ingested,
      contributor: 'us',
      contentSha256: hex64('obs-90211-normalized'),
      // ADR-038: the body is never served; its lifecycle and digest are.
      rawExcerpt: null,
      rawPayloadSha256: rawPayload.sha256,
      rawPayloadPruned: rawPayload.state === 'PRUNED',
      rawPayload,
      sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tikb',
    },
    attribution: attributionFor('usgs'),
  };
}

export function runEvidence(): EvidenceDetail {
  return {
    schemaVersion: SCHEMA_VERSION,
    item: itemFor(EV.runFirmsFailed),
    detail: {
      kind: 'RUN',
      runId: EV.runFirmsFailed.slice('EV:RUN:'.length),
      sourceId: 'firms',
      productId: 10,
      trigger: 'SCHEDULE',
      status: 'FAILED',
      startedAt: '2026-09-22T12:43:00.000Z',
      finishedAt: '2026-09-22T12:43:30.000Z',
      committedAt: '2026-09-22T12:44:00.000Z',
      httpStatus: 503,
      bytesReceived: 0,
      counts: { received: 0, newRecords: 0, newVersions: 0, unchanged: 0, rejected: 0 },
      newestObservedAt: null,
      errorClass: 'HTTP_5XX',
      errorMessage: 'Provider answered 503 Service Unavailable.',
      payloadSha256: null,
      workerVersion: '0.9.0',
    },
    attribution: attributionFor('firms'),
  };
}
