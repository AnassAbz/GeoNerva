/**
 * The detail pages' small map draws the subject's own geometry. These adapt a detail read model
 * to the flat `MapFeature` shape the map already renders, so there is one drawing path.
 */

import type { EventDetail, FireClusterDetail, MapFeature } from '@geonerva/domain';

export function eventMapFeatures(detail: EventDetail): MapFeature[] {
  const base = {
    subjectRef: detail.subjectRef,
    publicId: detail.publicId,
    kind: 'canonical_event' as const,
    hazardType: detail.hazardType,
    family: detail.family,
    observedAt: detail.headline.observedAt,
    isActive: detail.headline.isActive,
    providerSeverity: detail.headline.providerSeverity,
    clusterStatus: null,
    confidence: null,
    label: detail.headline.title,
    href: '',
    evidenceIds: detail.headline.evidenceIds,
  };
  /*
   * `MAGNITUDE`, the code `factsOf` emits. This was `'magnitude'`, so the lookup missed on every
   * event and the detail map sized every marker as if no magnitude had been reported — the same
   * case mismatch as QA round 2's H-2, in a second reader of the same vocabulary.
   */
  const magnitude = detail.headline.facts.find((fact) => fact.code === 'MAGNITUDE');
  const magnitudeValue = magnitude?.value.kind === 'number' ? magnitude.value.value : null;
  const areas = detail.geometries
    .filter((geometry) => geometry.geometry.type !== 'Point')
    .map((geometry) => ({ ...base, geometry: geometry.geometry, magnitudeValue }));
  const point: MapFeature = {
    ...base,
    geometry: {
      type: 'Point',
      coordinates: [detail.headline.centroid.lon, detail.headline.centroid.lat],
    },
    magnitudeValue,
  };
  // An area-shaped event is drawn as its area; a point event as its point.
  return areas.length > 0 ? areas : [point];
}

export function fireMapFeatures(detail: FireClusterDetail): MapFeature[] {
  return [
    {
      subjectRef: detail.subjectRef,
      publicId: detail.publicId,
      kind: 'fire_cluster',
      hazardType: 'THERMAL_ACTIVITY',
      family: 'FIRE_ACTIVITY',
      geometry: detail.centroid,
      observedAt: detail.summary.lastDetectedAt,
      isActive: detail.status === 'ACTIVE',
      providerSeverity: null,
      magnitudeValue: detail.summary.detectionCountTotal,
      clusterStatus: detail.status,
      confidence: detail.summary.maxConfidence,
      label: detail.publicId,
      href: '',
      evidenceIds: detail.summary.evidenceIds,
    },
  ];
}

/** The [lon, lat] of a GeoJSON point, or `null`. */
export function pointOf(geometry: { type: string; coordinates?: unknown }): {
  lat: number;
  lon: number;
} | null {
  if (geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null;
  const [lon, lat] = geometry.coordinates as unknown[];
  return typeof lon === 'number' && typeof lat === 'number' ? { lat, lon } : null;
}
