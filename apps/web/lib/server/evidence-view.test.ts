/**
 * `evidence-view.ts` — manifest entries and evidence detail.
 *
 * Evidence is what makes every other number in GeoNerva checkable, so the failures that matter are
 * the ones that make a citation *look* sound:
 *
 *  - **`resolvable` lying.** `EV:FDS` is neither primary nor content-addressed: it has no row, the
 *    endpoint cannot serve it, and a manifest that marked it resolvable is what broke every
 *    briefing for a location with fire activity at G7. Its regression test is here.
 *  - **Times collapsed.** `observedAt`, `validFrom`/`validTo`, `sourceUpdatedAt` and `ingestedAt`
 *    are four different questions, and this is the one endpoint whose job is keeping them apart.
 *  - **The raw payload gap presented as certainty.** ADR-038 is unresolved; the fields must report
 *    what GeoNerva actually knows rather than a confident `false`.
 *  - **A confidence of 0 confused with no confidence.** One is a claim, the other is its absence.
 */

import { describe, expect, it } from 'vitest';

import { EVIDENCE_KINDS, type EvidenceKind } from '@geonerva/domain';

import type {
  AttributionRow,
  ClusterEvidenceRow,
  CorrelationEvidenceRow,
  EvidenceRow,
  ObservationEvidenceRow,
  RunEvidenceRow,
} from './db.ts';
import {
  buildEvidenceDetail,
  clusterPayload,
  correlationPayload,
  isResolvableKind,
  observationPayload,
  runPayload,
  toEvidenceItem,
} from './evidence-view.ts';

const RUN_UUID = '0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77';

function row(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: 'EV:OBS:41',
    kind: 'OBS',
    summary: 'usgs us7000tikb version 2',
    source_id: 'usgs',
    product_id: 1,
    observed_at: new Date('2026-09-21T11:58:00.000Z'),
    ingested_at: new Date('2026-09-21T12:04:00.000Z'),
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tikb',
    ...overrides,
  };
}

const ATTRIBUTION: AttributionRow = {
  source_id: 'usgs',
  name: 'USGS Earthquake Hazards Program',
  homepage: 'https://earthquake.usgs.gov',
  licence: 'Public domain (U.S. Government work)',
  attribution_text: 'Earthquake data courtesy of the U.S. Geological Survey.',
  terms_url: 'https://www.usgs.gov/laws',
  disclaimer: 'Magnitudes are revised as more data arrive.',
};

describe('isResolvableKind', () => {
  it.each<EvidenceKind>(['OBS', 'FCV', 'RUN', 'COR'])('resolves the primary kind %s', (kind) => {
    expect(isResolvableKind(kind)).toBe(true);
  });

  it.each<EvidenceKind>(['BAS', 'REL', 'CHG'])(
    'does not resolve the content-addressed kind %s',
    (kind) => {
      expect(isResolvableKind(kind)).toBe(false);
    },
  );

  /**
   * The G7 regression, stated as its own case.
   *
   * `EV:FDS` is in `EVIDENCE_KINDS` and in neither `PRIMARY_EVIDENCE_KINDS` nor
   * `CONTENT_ADDRESSED_EVIDENCE_KINDS`. A `resolvable` flag written as "not content-addressed"
   * would mark it `true`, the endpoint would 404 on it, and the manifest would be claiming
   * something the API cannot do — which is exactly the hole that broke the fire-activity briefing.
   */
  it('does not resolve EV:FDS, which is neither primary nor content-addressed', () => {
    expect(isResolvableKind('FDS')).toBe(false);
  });

  it('classifies every declared kind, so a ninth kind is a visible decision', () => {
    expect(EVIDENCE_KINDS.filter((kind) => isResolvableKind(kind))).toEqual([
      'OBS',
      'FCV',
      'RUN',
      'COR',
    ]);
  });
});

describe('toEvidenceItem', () => {
  it('maps a manifest entry and keeps observedAt and ingestedAt apart', () => {
    expect(toEvidenceItem(row())).toEqual({
      id: 'EV:OBS:41',
      kind: 'OBS',
      summary: 'usgs us7000tikb version 2',
      sourceId: 'usgs',
      productId: 1,
      observedAt: '2026-09-21T11:58:00.000Z',
      ingestedAt: '2026-09-21T12:04:00.000Z',
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tikb',
      resolvable: true,
    });
  });

  /** A run has no observation time of its own; `null` is the honest value, not the ingest time. */
  it('reports a null observedAt rather than repeating ingestedAt', () => {
    const item = toEvidenceItem(row({ id: `EV:RUN:${RUN_UUID}`, kind: 'RUN', observed_at: null }));
    expect(item.observedAt).toBeNull();
    expect(item.ingestedAt).toBe('2026-09-21T12:04:00.000Z');
  });

  it('reports a null sourceId for a GeoNerva derivation', () => {
    expect(toEvidenceItem(row({ source_id: null, product_id: null })).sourceId).toBeNull();
  });

  /*
   * Decided from the kind, not from whether this lookup happened to succeed. The same citation
   * must be resolvable in every response that carries it.
   */
  it('marks a content-addressed entry unresolvable even though the row was read', () => {
    const item = toEvidenceItem(row({ id: `EV:BAS:${'a'.repeat(64)}`, kind: 'BAS' }));
    expect(item.resolvable).toBe(false);
  });
});

describe('observationPayload', () => {
  function observation(overrides: Partial<ObservationEvidenceRow> = {}): ObservationEvidenceRow {
    return {
      version_id: '41',
      version_seq: 2,
      source_id: 'usgs',
      product_id: 1,
      primary_key: 'us7000tikb',
      hazard_type: 'EARTHQUAKE',
      lifecycle_status: 'UPDATED',
      observed_at: new Date('2026-09-21T11:58:00.000Z'),
      valid_from: null,
      valid_to: null,
      source_updated_at: new Date('2026-09-21T12:01:00.000Z'),
      ingested_at: new Date('2026-09-21T12:04:00.000Z'),
      contributor: 'us',
      content_sha256: 'b'.repeat(64),
      source_url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tikb',
      raw_record_present: true,
      ...overrides,
    };
  }

  /**
   * The whole point of this payload: four times, four answers.
   *
   * GeoNerva learned at 12:04 about something that happened at 11:58 and that the provider last
   * revised at 12:01. A payload that reported one timestamp three times would satisfy a test that
   * only checked the fields were present.
   */
  it('reports the four time semantics as four distinct values', () => {
    const payload = observationPayload(observation());
    expect(payload).toMatchObject({
      kind: 'OBS',
      observedAt: '2026-09-21T11:58:00.000Z',
      sourceUpdatedAt: '2026-09-21T12:01:00.000Z',
      ingestedAt: '2026-09-21T12:04:00.000Z',
      validFrom: null,
      validTo: null,
    });
  });

  it('carries a validity interval when the provider gave one', () => {
    const payload = observationPayload(
      observation({
        valid_from: new Date('2026-09-21T06:00:00.000Z'),
        valid_to: new Date('2026-09-21T18:00:00.000Z'),
      }),
    );
    expect(payload).toMatchObject({
      validFrom: '2026-09-21T06:00:00.000Z',
      validTo: '2026-09-21T18:00:00.000Z',
    });
  });

  it('reports a null sourceUpdatedAt for a source with no revision time, such as FIRMS', () => {
    expect(observationPayload(observation({ source_updated_at: null }))).toMatchObject({
      sourceUpdatedAt: null,
    });
  });

  it('carries the contributor, which is load-bearing for independence (ADR-030)', () => {
    expect(observationPayload(observation({ contributor: 'nc' }))).toMatchObject({
      contributor: 'nc',
    });
    expect(observationPayload(observation({ contributor: null }))).toMatchObject({
      contributor: null,
    });
  });

  it('serves the normalized content hash, which is the only change detector (ADR-029)', () => {
    expect(observationPayload(observation())).toMatchObject({ contentSha256: 'b'.repeat(64) });
  });

  /*
   * ADR-038. The web role has no SELECT on `raw_source_records`, so the excerpt and the payload
   * digest are not available to this endpoint at all.
   */
  it('serves no raw excerpt and no payload digest', () => {
    expect(observationPayload(observation())).toMatchObject({
      rawExcerpt: null,
      rawPayloadSha256: null,
    });
  });

  /**
   * The gap reported as a gap.
   *
   * `rawPayloadPruned` is derived from `raw_record_id`: `true` means GeoNerva holds no raw row at
   * all, `false` means one exists and this endpoint does not serve its state. A hard-coded `false`
   * would be a confident claim GeoNerva cannot support, and is the mutation this asserts against.
   */
  it('derives rawPayloadPruned from whether a raw row exists', () => {
    expect(observationPayload(observation({ raw_record_present: false }))).toMatchObject({
      rawPayloadPruned: true,
    });
    expect(observationPayload(observation({ raw_record_present: true }))).toMatchObject({
      rawPayloadPruned: false,
    });
  });
});

describe('clusterPayload', () => {
  function cluster(overrides: Partial<ClusterEvidenceRow> = {}): ClusterEvidenceRow {
    return {
      cluster_version_id: '904',
      cluster_public_id: 'FR-26-3K7P2A',
      as_of: new Date('2026-09-21T12:00:00.000Z'),
      n_total: 148,
      n_24h: 31,
      overpasses_24h: 4,
      first_detected_at: new Date('2026-09-18T02:11:00.000Z'),
      last_detected_at: new Date('2026-09-21T11:40:00.000Z'),
      frp_sum_24h: 812.5,
      frp_max: 96.25,
      max_confidence: 'HIGH',
      product_ids: [3, 4],
      content_sha256: 'c'.repeat(64),
      ...overrides,
    };
  }

  it('maps the summary with its detection counts and its own knowledge time', () => {
    expect(clusterPayload(cluster())).toMatchObject({
      kind: 'FCV',
      clusterVersionId: '904',
      clusterPublicId: 'FR-26-3K7P2A',
      asOf: '2026-09-21T12:00:00.000Z',
      detectionCountTotal: 148,
      detectionCount24h: 31,
      distinctOverpasses24h: 4,
      frpSum24h: 812.5,
      frpMax: 96.25,
      maxConfidence: 'HIGH',
      productIds: [3, 4],
      contentSha256: 'c'.repeat(64),
    });
  });

  /**
   * The detection-set id must be minted from the **total**, matching `snapshot.ts`.
   *
   * The two must agree character for character or the manifest lookup invariant I9 checks would
   * miss. `n_total` and `n_24h` are both plausible and only one is right, so this pins which.
   */
  it('mints the detection-set id from the total count, not the 24-hour count', () => {
    expect(clusterPayload(cluster())).toMatchObject({
      detectionSetEvidenceId: 'EV:FDS:904:148',
    });
  });

  it('reports a null FRP rather than a zero when the product did not report one', () => {
    expect(clusterPayload(cluster({ frp_sum_24h: null, frp_max: null }))).toMatchObject({
      frpSum24h: null,
      frpMax: null,
    });
  });

  it('keeps the first and last detection times apart', () => {
    const payload = clusterPayload(cluster());
    expect(payload).toMatchObject({
      firstDetectedAt: '2026-09-18T02:11:00.000Z',
      lastDetectedAt: '2026-09-21T11:40:00.000Z',
    });
  });
});

describe('runPayload', () => {
  function run(overrides: Partial<RunEvidenceRow> = {}): RunEvidenceRow {
    return {
      run_id: RUN_UUID,
      source_id: 'usgs',
      product_id: 1,
      trigger: 'SCHEDULE',
      status: 'SUCCEEDED',
      started_at: new Date('2026-09-21T11:55:00.000Z'),
      finished_at: new Date('2026-09-21T11:55:04.000Z'),
      committed_at: new Date('2026-09-21T11:55:05.000Z'),
      http_status: 200,
      bytes_received: 182_344,
      n_received: 230,
      n_new_records: 3,
      n_new_versions: 5,
      n_unchanged: 222,
      n_rejected: 0,
      newest_observed_at: new Date('2026-09-21T11:40:00.000Z'),
      error_class: null,
      error_message: null,
      payload_sha256: 'd'.repeat(64),
      worker_version: 'worker-1',
      ...overrides,
    };
  }

  it('maps the run with its three timestamps and its counts', () => {
    expect(runPayload(run())).toEqual({
      kind: 'RUN',
      runId: RUN_UUID,
      sourceId: 'usgs',
      productId: 1,
      trigger: 'SCHEDULE',
      status: 'SUCCEEDED',
      startedAt: '2026-09-21T11:55:00.000Z',
      finishedAt: '2026-09-21T11:55:04.000Z',
      committedAt: '2026-09-21T11:55:05.000Z',
      httpStatus: 200,
      bytesReceived: 182_344,
      counts: { received: 230, newRecords: 3, newVersions: 5, unchanged: 222, rejected: 0 },
      newestObservedAt: '2026-09-21T11:40:00.000Z',
      errorClass: null,
      errorMessage: null,
      payloadSha256: 'd'.repeat(64),
      workerVersion: 'worker-1',
    });
  });

  /*
   * `error_message` is served here, unlike in `runSummariesAsOf`, because the frozen contract
   * declares it and the write path earns it: every path that closes a failed run passes the detail
   * through `sanitizeDetail`, and the one path that could see a driver error substitutes the
   * SQLSTATE and constraint name instead of the message.
   */
  it('serves the sanitized error message and class for a failed run', () => {
    expect(
      runPayload(
        run({
          status: 'FAILED',
          error_class: 'HTTP_5XX',
          error_message: 'USGS returned 503 for comcat_all_day',
          committed_at: new Date('2026-09-21T11:55:05.000Z'),
        }),
      ),
    ).toMatchObject({
      status: 'FAILED',
      errorClass: 'HTTP_5XX',
      errorMessage: 'USGS returned 503 for comcat_all_day',
    });
  });

  it('reports a null duration input honestly: a run with no finish has none', () => {
    expect(runPayload(run({ finished_at: null }))).toMatchObject({ finishedAt: null });
  });

  it('reports a source-level run with no product', () => {
    expect(runPayload(run({ product_id: null }))).toMatchObject({ productId: null });
  });

  /*
   * A batch refused after partial receipt still records how many records arrived. Reporting zero
   * would make a schema-drift event indistinguishable from a feed that returned nothing.
   */
  it('keeps the received and rejected counts of a refused batch', () => {
    expect(
      runPayload(run({ status: 'FAILED', n_received: 230, n_rejected: 230, n_new_versions: 0 })),
    ).toMatchObject({
      counts: { received: 230, newRecords: 3, newVersions: 0, unchanged: 222, rejected: 230 },
    });
  });
});

describe('correlationPayload', () => {
  function link(overrides: Partial<CorrelationEvidenceRow> = {}): CorrelationEvidenceRow {
    return {
      link_id: '77',
      canonical_event_public_id: 'EQ-26-7K3F9Q',
      source_record_primary_key: 'us7000tikb',
      source_id: 'usgs',
      relation: 'PRIMARY',
      match_kind: 'IDENTITY_REF',
      confidence: '0.940',
      reasons: { codes: ['IDENTITY_REF_EXACT'], misfit: 0 },
      algorithm_version: 'correlate-1',
      linked_at: new Date('2026-09-21T12:05:00.000Z'),
      unlinked_at: null,
      unlink_reason: null,
      ...overrides,
    };
  }

  it('maps the decision with its reasons carried verbatim', () => {
    expect(correlationPayload(link())).toEqual({
      kind: 'COR',
      linkId: '77',
      canonicalEventPublicId: 'EQ-26-7K3F9Q',
      sourceRecordPrimaryKey: 'us7000tikb',
      sourceId: 'usgs',
      relation: 'PRIMARY',
      matchKind: 'IDENTITY_REF',
      confidence: 0.94,
      reasons: { codes: ['IDENTITY_REF_EXACT'], misfit: 0 },
      algorithmVersion: 'correlate-1',
      linkedAt: '2026-09-21T12:05:00.000Z',
      unlinkedAt: null,
      unlinkReason: null,
    });
  });

  it('parses a numeric confidence out of the string a numeric column returns', () => {
    expect(correlationPayload(link({ confidence: '0.001' }))).toMatchObject({ confidence: 0.001 });
  });

  /**
   * A confidence of 0 is a claim; `null` is the absence of one.
   *
   * Collapsing the two — the shape `Number(row.confidence) || null` produces — would turn "no
   * confidence at all" into "GeoNerva has no confidence to report", which reads as less certain
   * than it is. Both directions are asserted.
   */
  it('distinguishes a confidence of zero from no confidence', () => {
    expect(correlationPayload(link({ confidence: '0.000' }))).toMatchObject({ confidence: 0 });
    expect(correlationPayload(link({ confidence: null }))).toMatchObject({ confidence: null });
  });

  it('reports a null confidence rather than a zero for an unparseable value', () => {
    expect(correlationPayload(link({ confidence: 'NaN' }))).toMatchObject({ confidence: null });
  });

  /*
   * A closed link still resolves — it was cited while it was open — but the response says when it
   * closed and why. Hiding the closure would make a withdrawn decision look current.
   */
  it('reports a withdrawn link with its closure, not as if it were still open', () => {
    expect(
      correlationPayload(
        link({
          unlinked_at: new Date('2026-09-21T13:00:00.000Z'),
          unlink_reason: 'REVISED_SOLUTION_MOVED_OUT_OF_MISFIT',
        }),
      ),
    ).toMatchObject({
      unlinkedAt: '2026-09-21T13:00:00.000Z',
      unlinkReason: 'REVISED_SOLUTION_MOVED_OUT_OF_MISFIT',
    });
  });

  it('carries a DERIVED_COPY relation, which is how a republication is recorded', () => {
    expect(
      correlationPayload(link({ relation: 'DERIVED_COPY', match_kind: 'SPATIOTEMPORAL' })),
    ).toMatchObject({ relation: 'DERIVED_COPY', matchKind: 'SPATIOTEMPORAL' });
  });
});

describe('buildEvidenceDetail', () => {
  it('wraps the item and the payload with the schema version and attribution', () => {
    const detail = buildEvidenceDetail({
      item: toEvidenceItem(row()),
      detail: runPayload({
        run_id: RUN_UUID,
        source_id: 'usgs',
        product_id: 1,
        trigger: 'SCHEDULE',
        status: 'SUCCEEDED',
        started_at: new Date('2026-09-21T11:55:00.000Z'),
        finished_at: null,
        committed_at: new Date('2026-09-21T11:55:05.000Z'),
        http_status: 200,
        bytes_received: 1,
        n_received: 1,
        n_new_records: 0,
        n_new_versions: 0,
        n_unchanged: 1,
        n_rejected: 0,
        newest_observed_at: null,
        error_class: null,
        error_message: null,
        payload_sha256: null,
        worker_version: null,
      }),
      attribution: [ATTRIBUTION],
    });

    expect(Object.keys(detail).sort()).toEqual(['attribution', 'detail', 'item', 'schemaVersion']);
    expect(detail.schemaVersion).toBe(1);
    expect(detail.detail.kind).toBe('RUN');
  });

  /** Several providers require the disclaimer verbatim, which is why it is a field and not prose. */
  it('carries the licence and the disclaimer verbatim', () => {
    const detail = buildEvidenceDetail({
      item: toEvidenceItem(row()),
      detail: { kind: 'OBS' } as never,
      attribution: [ATTRIBUTION],
    });
    expect(detail.attribution).toEqual([
      {
        sourceId: 'usgs',
        name: 'USGS Earthquake Hazards Program',
        homepage: 'https://earthquake.usgs.gov',
        licence: 'Public domain (U.S. Government work)',
        attributionText: 'Earthquake data courtesy of the U.S. Geological Survey.',
        termsUrl: 'https://www.usgs.gov/laws',
        disclaimer: 'Magnitudes are revised as more data arrive.',
      },
    ]);
  });

  it('carries no attribution for a derivation with no source', () => {
    const detail = buildEvidenceDetail({
      item: toEvidenceItem(row({ source_id: null })),
      detail: { kind: 'OBS' } as never,
      attribution: [],
    });
    expect(detail.attribution).toEqual([]);
  });
});
