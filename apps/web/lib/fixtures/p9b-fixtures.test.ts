/**
 * The P9b fixture variants, against the frozen read models.
 *
 * `fixtures.test.ts` already validates each fixture's default shape. These are the variants P9b
 * added — the four raw-payload lifecycles (ADR-038) and the withheld fire cluster (ADR-039) — and
 * they are validated here for the same reason: a mock that drifts from the contract makes a page
 * that was built against nothing.
 *
 * `rawPayloadViewSchema` is the strict one. It refines which fields may be populated per state, so
 * a lifecycle fixture that invented a capture time, or forgot a digest, fails here rather than
 * teaching the drawer a shape the endpoint never serves.
 */

import {
  RAW_PAYLOAD_STATES,
  evidenceDetailSchema,
  fireClusterDetailSchema,
} from '@geonerva/domain';
import { describe, expect, it } from 'vitest';

import { fireMapFeatures } from '../view/detail-map.ts';
import { fireClusterDetail, observationEvidence } from './index.ts';

describe('raw-payload lifecycle fixtures (ADR-038)', () => {
  for (const state of RAW_PAYLOAD_STATES) {
    it(`${state} is a valid EvidenceDetail`, () => {
      const detail = observationEvidence({ raw: state });
      const result = evidenceDetailSchema.safeParse(detail);
      if (!result.success) throw new Error(JSON.stringify(result.error, null, 2));
      expect(result.success).toBe(true);
    });
  }

  it('covers every state the endpoint can report', () => {
    expect(RAW_PAYLOAD_STATES).toHaveLength(4);
  });

  it('never carries a provider body, whatever the state', () => {
    for (const state of RAW_PAYLOAD_STATES) {
      const { detail } = observationEvidence({ raw: state });
      if (detail.kind !== 'OBS') throw new Error('the observation fixture changed kind');
      expect(detail.rawExcerpt).toBeNull();
      expect(detail.rawPayload.state).toBe(state);
      expect(detail.rawPayloadSha256).toBe(detail.rawPayload.sha256);
      expect(detail.rawPayloadPruned).toBe(state === 'PRUNED');
    }
  });

  it('a pruned payload’s retention window has actually closed', () => {
    const { detail } = observationEvidence({ raw: 'PRUNED' });
    if (detail.kind !== 'OBS') throw new Error('the observation fixture changed kind');
    const expiry = Date.parse(detail.rawPayload.retentionExpiresAt ?? '');
    expect(expiry).toBeLessThan(Date.parse('2026-09-22T12:10:00.000Z'));
  });

  it('a state with no captured body claims neither a capture time nor an expiry', () => {
    for (const state of ['NOT_CAPTURED', 'SOURCE_UNAVAILABLE'] as const) {
      const { detail } = observationEvidence({ raw: state });
      if (detail.kind !== 'OBS') throw new Error('the observation fixture changed kind');
      expect(detail.rawPayload.capturedAt).toBeNull();
      expect(detail.rawPayload.retentionExpiresAt).toBeNull();
    }
  });
});

describe('the withheld fire cluster (ADR-039)', () => {
  it('is a valid FireClusterDetail', () => {
    const result = fireClusterDetailSchema.safeParse(fireClusterDetail({ detections: 'withheld' }));
    if (!result.success) throw new Error(JSON.stringify(result.error, null, 2));
    expect(result.success).toBe(true);
  });

  it('withholds the sample and the daily counts while keeping the version’s count', () => {
    const detail = fireClusterDetail({ detections: 'withheld' });
    expect(detail.detections.sample).toEqual([]);
    expect(detail.detections.byDay).toEqual([]);
    expect(detail.detections.truncated).toBe(true);
    expect(detail.detections.total).toBe(detail.summary.detectionCountTotal);
  });

  it('reports no nearest-detection distance, because none was measured', () => {
    const detail = fireClusterDetail({ detections: 'withheld', withPlace: true });
    expect(detail.nearestDetectionKm).toBeNull();
  });

  it('emits no map feature for an individual detection, verified or not', () => {
    /*
     * `fireMapFeatures` is the only way a feature reaches the fire page's map, and ADR-039 forbids
     * the `fire_detection` kind until membership is bitemporal — including for a cluster whose
     * members *were* verified, because the sample is a reconstruction from the present either way.
     */
    for (const detections of ['verified', 'withheld'] as const) {
      const features = fireMapFeatures(fireClusterDetail({ detections }));
      expect(features.map((feature) => feature.kind)).toEqual(['fire_cluster']);
    }
  });
});
