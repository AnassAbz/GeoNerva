/**
 * `EvidenceDetail` fixtures for the resolver contract (`GET /api/v1/evidence/{id}`).
 *
 * The pages do not render these in P9a: the raw-record view belongs to P9b, because the
 * observation payload is being extended by an approved ADR. They exist so that the contract is
 * exercised by a validated mock from the start.
 */

import type { EvidenceDetail } from '@geonerva/domain';

import { FIXTURE_NOW, SCHEMA_VERSION, attributionFor, hex64 } from './common.ts';
import { EV, T, evidenceRegistry } from './world.ts';

function itemFor(id: string) {
  const item = evidenceRegistry(FIXTURE_NOW).get(id);
  if (item === undefined) throw new Error(`no fixture evidence item ${id}`);
  return item;
}

export function observationEvidence(): EvidenceDetail {
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
      rawPayloadSha256: hex64('obs-90211-raw'),
      rawPayloadPruned: false,
      rawPayload: {
        state: 'AVAILABLE',
        sha256: hex64('obs-90211-raw'),
        capturedAt: T.usgsV2Ingested,
        retentionExpiresAt: new Date(Date.parse(T.usgsV2Ingested) + 30 * 86_400_000).toISOString(),
      },
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
