/**
 * `FireClusterDetail` for FR-26-4HX2MB: 14 VIIRS thermal detections 39 km south-west.
 *
 * Two shapes, because the endpoint serves two (ADR-039):
 *
 *  - `detections: 'verified'` (the default) — the member set rebuilt from the present matched the
 *    version's `n_total`, so the sample and the daily counts are the set the summary counted.
 *  - `detections: 'withheld'` — it did not match, so the builder publishes `truncated: true` with
 *    an empty sample and no daily counts, and `total` stays the version's own count. The place is
 *    dropped in that variant too: with no verified detections the builder measures to the buffered
 *    hull instead, and `FIRE_RELEVANCE`'s reason text names a nearest *detection*, which is
 *    exactly the claim this state cannot make.
 */

import type { FireClusterDetail, FireDetectionView } from '@geonerva/domain';

import {
  FIXTURE_NOW,
  PRODUCT,
  SCHEMA_VERSION,
  asOfContext,
  attributionFor,
  manifestFor,
} from './common.ts';
import {
  EV,
  FIRE_PUBLIC_ID,
  FIRE_RELEVANCE,
  FIRE_SUMMARY,
  GEOMETRY,
  T,
  THERMAL_CAVEAT,
  evidenceRegistry,
} from './world.ts';

const SAMPLE: readonly FireDetectionView[] = [
  {
    acquiredAt: T.fireLast,
    lat: 31.4032,
    lon: -8.2871,
    productId: PRODUCT.firmsNoaa21,
    confidence: { class: 'NOMINAL', raw: 'n' },
    frpMw: 9.8,
    brightnessTi4K: 338.1,
    brightnessTi5K: 296.4,
    daynight: 'N',
    scanKm: 0.41,
    trackKm: 0.37,
    distanceKm: 37.2,
  },
  {
    acquiredAt: T.fireLast,
    lat: 31.3987,
    lon: -8.2954,
    productId: PRODUCT.firmsNoaa21,
    confidence: { class: 'NOMINAL', raw: 'n' },
    frpMw: 6.1,
    brightnessTi4K: 331.7,
    brightnessTi5K: 294.9,
    daynight: 'N',
    scanKm: 0.41,
    trackKm: 0.37,
    distanceKm: 38.0,
  },
  {
    acquiredAt: '2026-09-21T13:36:00.000Z',
    lat: 31.4011,
    lon: -8.3012,
    productId: PRODUCT.firmsNoaa20,
    confidence: { class: 'LOW', raw: 'l' },
    frpMw: 3.4,
    brightnessTi4K: 329.5,
    brightnessTi5K: 305.2,
    daynight: 'D',
    scanKm: 0.52,
    trackKm: 0.42,
    distanceKm: 38.4,
  },
];

export function fireClusterDetail(
  options: { withPlace?: boolean; detections?: 'verified' | 'withheld' } = {},
): FireClusterDetail {
  const verified = (options.detections ?? 'verified') === 'verified';
  const withPlace = verified && (options.withPlace ?? true);
  const asOf = FIXTURE_NOW;
  const detail: FireClusterDetail = {
    schemaVersion: SCHEMA_VERSION,
    publicId: FIRE_PUBLIC_ID,
    subjectRef: `FC:${FIRE_PUBLIC_ID}`,
    asOfContext: asOfContext(asOf, false),
    status: 'ACTIVE',
    createdAt: T.fcv1,
    summary: {
      clusterVersionId: '7781',
      asOf: T.fcv3,
      countedTo: T.fcv3,
      detectionCountTotal: 14,
      detectionCount24h: 8,
      distinctOverpasses24h: 2,
      firstDetectedAt: T.fireFirst,
      lastDetectedAt: T.fireLast,
      frpSum24h: 41.7,
      frpMax: 9.8,
      maxConfidence: { class: 'NOMINAL', raw: 'n' },
      sensors: [
        {
          productId: PRODUCT.firmsNoaa20,
          code: 'VIIRS_NOAA20_NRT',
          platform: 'NOAA-20',
          instrument: 'VIIRS',
          resolutionM: 375,
        },
        {
          productId: PRODUCT.firmsNoaa21,
          code: 'VIIRS_NOAA21_NRT',
          platform: 'NOAA-21',
          instrument: 'VIIRS',
          resolutionM: 375,
        },
      ],
      facts: FIRE_SUMMARY.facts,
      evidenceIds: [EV.fcv3, EV.fds3],
    },
    hull: GEOMETRY.fireHull,
    centroid: {
      type: 'Point',
      coordinates: [GEOMETRY.fireCentroid.lon, GEOMETRY.fireCentroid.lat],
    },
    relevance: withPlace ? FIRE_RELEVANCE : null,
    distanceKm: withPlace ? 38.9 : null,
    nearestDetectionKm: withPlace ? 37.2 : null,
    versions: [
      {
        clusterVersionId: '7781',
        asOf: T.fcv3,
        detectionCountTotal: 14,
        detectionCount24h: 8,
        distinctOverpasses24h: 2,
        frpSum24h: 41.7,
        frpMax: 9.8,
        lastDetectedAt: T.fireLast,
        summary: 'Detections 9 → 14 after a NOAA-21 overpass.',
        evidenceId: EV.fcv3,
      },
      {
        clusterVersionId: '7764',
        asOf: T.fcv2,
        detectionCountTotal: 9,
        detectionCount24h: 9,
        distinctOverpasses24h: 2,
        frpSum24h: 27.9,
        frpMax: 7.2,
        lastDetectedAt: '2026-09-21T12:48:00.000Z',
        summary: 'Detections 6 → 9 after a NOAA-20 overpass.',
        evidenceId: EV.fcv2,
      },
      {
        clusterVersionId: '7740',
        asOf: T.fcv1,
        detectionCountTotal: 6,
        detectionCount24h: 6,
        distinctOverpasses24h: 1,
        frpSum24h: 14.2,
        frpMax: 4.9,
        lastDetectedAt: T.fireFirst,
        summary: 'Cluster formed from 6 detections on one NOAA-21 overpass.',
        evidenceId: EV.fcv1,
      },
    ],
    detections: {
      /* The version's own count either way: it is the one number that is a fact at `asOf`. */
      total: 14,
      truncated: true,
      cap: 3,
      sample: verified ? SAMPLE : [],
      byDay: verified
        ? [
            { day: '2026-09-20', count: 0, frpSum: null, hasSatelliteCoverage: true },
            { day: '2026-09-21', count: 9, frpSum: 27.9, hasSatelliteCoverage: true },
            { day: '2026-09-22', count: 5, frpSum: 19.6, hasSatelliteCoverage: true },
          ]
        : [],
      evidenceId: EV.fds3,
    },
    mergedIntoPublicId: null,
    mergedAt: null,
    mergedFromPublicIds: [],
    relatedEvents: [],
    mandatoryCaveat: THERMAL_CAVEAT,
    evidenceManifest: [],
    attribution: attributionFor('firms'),
  };
  return { ...detail, evidenceManifest: manifestFor(detail, evidenceRegistry(asOf)) };
}
