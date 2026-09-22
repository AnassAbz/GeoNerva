/** `MapFeaturesResponse` for the Marrakech viewport, and the place suggestions for search. */

import type { MapFeature, MapFeaturesResponse, PlaceSuggestion } from '@geonerva/domain';

import { FIXTURE_NOW, SCHEMA_VERSION, asOfContext, attributionFor } from './common.ts';
import {
  EQ_PUBLIC_ID,
  EV,
  FIRE_PUBLIC_ID,
  FLOOD_PUBLIC_ID,
  GEOMETRY,
  OLDER_EQ_SUMMARY,
  T,
} from './world.ts';
import type { FixtureScenario } from './metrics.ts';

export function mapFeaturesFixture(scenario: FixtureScenario = 'all-fresh'): MapFeaturesResponse {
  const asOf = FIXTURE_NOW;
  const features: MapFeature[] = [
    {
      subjectRef: `CE:${EQ_PUBLIC_ID}`,
      publicId: EQ_PUBLIC_ID,
      kind: 'canonical_event',
      hazardType: 'EARTHQUAKE',
      family: 'EARTHQUAKES',
      geometry: {
        type: 'Point',
        coordinates: [GEOMETRY.eqEpicentre.lon, GEOMETRY.eqEpicentre.lat],
      },
      observedAt: T.eqObserved,
      isActive: true,
      providerSeverity: { scheme: 'GDACS_ALERT', value: 'Green' },
      magnitudeValue: 4.7,
      clusterStatus: null,
      confidence: null,
      label: 'M4.7 · 49 km S of Azilal, Morocco',
      href: `/events/${EQ_PUBLIC_ID}`,
      evidenceIds: [EV.usgsV2],
    },
    {
      subjectRef: OLDER_EQ_SUMMARY.subjectRef,
      publicId: OLDER_EQ_SUMMARY.publicId,
      kind: 'canonical_event',
      hazardType: 'EARTHQUAKE',
      family: 'EARTHQUAKES',
      geometry: { type: 'Point', coordinates: [-8.78, 30.98] },
      observedAt: T.olderEqObserved,
      isActive: true,
      providerSeverity: null,
      magnitudeValue: 3.4,
      clusterStatus: null,
      confidence: null,
      label: OLDER_EQ_SUMMARY.title,
      href: OLDER_EQ_SUMMARY.href,
      evidenceIds: [EV.usgsOlder],
    },
    {
      subjectRef: `CE:${FLOOD_PUBLIC_ID}`,
      publicId: FLOOD_PUBLIC_ID,
      kind: 'canonical_event',
      hazardType: 'FLOOD',
      family: 'FLOODS',
      geometry: GEOMETRY.floodArea,
      observedAt: T.floodObserved,
      isActive: true,
      providerSeverity: { scheme: 'GDACS_ALERT', value: 'Green' },
      magnitudeValue: null,
      clusterStatus: null,
      confidence: null,
      label: 'GDACS flood-event area (modelled) · Souss-Massa',
      href: `/events/${FLOOD_PUBLIC_ID}`,
      evidenceIds: [EV.gdacsFlood],
    },
  ];
  if (scenario === 'all-fresh') {
    features.push({
      subjectRef: `FC:${FIRE_PUBLIC_ID}`,
      publicId: FIRE_PUBLIC_ID,
      kind: 'fire_cluster',
      hazardType: 'THERMAL_ACTIVITY',
      family: 'FIRE_ACTIVITY',
      geometry: {
        type: 'Point',
        coordinates: [GEOMETRY.fireCentroid.lon, GEOMETRY.fireCentroid.lat],
      },
      observedAt: T.fireLast,
      isActive: true,
      providerSeverity: null,
      magnitudeValue: 14,
      clusterStatus: 'ACTIVE',
      confidence: { class: 'NOMINAL', raw: 'n' },
      label: 'Fire activity cluster · 14 thermal detections',
      href: `/fires/${FIRE_PUBLIC_ID}`,
      evidenceIds: [EV.fcv3],
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    asOfContext: asOfContext(asOf, false, scenario === 'firms-stale' ? { firms: 300 } : {}),
    bbox: { west: -11.25, south: 28.13, east: -5.63, north: 34.31 },
    bboxParts: [{ west: -11.25, south: 28.13, east: -5.63, north: 34.31 }],
    zoom: 6,
    families: ['EARTHQUAKES', 'FIRE_ACTIVITY', 'FLOODS', 'CYCLONES', 'OTHER'],
    features,
    truncated: false,
    cap: 500,
    total: features.length,
    attribution: attributionFor('usgs', 'emsc', 'gdacs', 'firms'),
  };
}

/** Local type-ahead results (GeoNames). The only curated place with a fixture briefing. */
export const PLACE_SUGGESTIONS: readonly PlaceSuggestion[] = [
  {
    key: 'p:2542997',
    label: 'Marrakech, Marrakesh-Safi, Morocco',
    countryCode: 'MA',
    admin1: 'Marrakesh-Safi',
    lat: 31.63,
    lon: -7.99,
    population: 839_296,
    timezone: 'Africa/Casablanca',
  },
];
