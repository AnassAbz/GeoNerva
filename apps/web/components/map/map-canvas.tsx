'use client';

/**
 * The MapLibre canvas. Loaded only on the client, only after WebGL2 was detected, through
 * `next/dynamic` — so neither the server render nor any test needs WebGL, and the ~1 MB library
 * is not in the page's first bundle.
 *
 * Symbols follow the legend: earthquakes as circles sized by magnitude, fire activity clusters as
 * triangles, GDACS flood areas hatched and labelled "modelled", cyclone tracks as lines, volcano
 * and drought events as diamonds, and dotted analysis rings around the location.
 */

import type { HazardFamily, MapFeature } from '@geonerva/domain';
import {
  Layer,
  Map as MapGL,
  Marker,
  NavigationControl,
  Popup,
  Source,
  type MapLayerMouseEvent,
} from '@vis.gl/react-maplibre';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCallback, useMemo, useState } from 'react';

import { COPY } from '../../lib/view/copy.ts';
import { FAMILY_META } from '../../lib/view/families.ts';
import { circleRing } from '../../lib/view/geo.ts';
import { PALETTE } from '../../lib/view/palette.ts';
import { subjectHref } from '../../lib/view/routes.ts';

/*
 * MapLibre v6 is ESM-only and resolves its worker relative to its own module URL, which a bundler
 * rewrites. The worker and the chunk it imports are served from this origin by the prerendered
 * route `app/maplibre/[file]/route.ts`.
 */
maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');

export interface MapCanvasProps {
  readonly styleUrl: string;
  readonly center: { readonly lat: number; readonly lon: number };
  readonly placeLabel: string;
  readonly placeSlug?: string;
  readonly features: readonly MapFeature[];
  readonly rings: readonly { readonly family: HazardFamily; readonly km: number }[];
  readonly enabled: readonly HazardFamily[];
  readonly onBasemapError?: () => void;
}

type ShapeName = 'triangle' | 'diamond';

/** Draws a small solid icon for a symbol layer; MapLibre needs raster images for symbols. */
function shapeImage(shape: ShapeName, color: string): ImageData | null {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.fillStyle = color;
  context.strokeStyle = PALETTE.canvas;
  context.lineWidth = 2;
  context.beginPath();
  if (shape === 'triangle') {
    context.moveTo(12, 2);
    context.lineTo(22, 21);
    context.lineTo(2, 21);
  } else {
    context.moveTo(12, 1);
    context.lineTo(23, 12);
    context.lineTo(12, 23);
    context.lineTo(1, 12);
  }
  context.closePath();
  context.fill();
  context.stroke();
  return context.getImageData(0, 0, size, size);
}

/** A diagonal hatch, for GDACS modelled flood areas. */
function hatchImage(color: string): ImageData | null {
  const size = 8;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(0, size);
  context.lineTo(size, 0);
  context.stroke();
  return context.getImageData(0, 0, size, size);
}

/**
 * A GeoJSON FeatureCollection. MapLibre types its source data with the ambient `GeoJSON`
 * namespace of @types/geojson, which this app does not depend on directly, so the collection is
 * described locally and handed over through `sourceData`.
 */
interface FeatureCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly {
    readonly type: 'Feature';
    readonly geometry: unknown;
    readonly properties: Readonly<Record<string, string | number>>;
  }[];
}

/** The one cast between the contract's GeoJSON and MapLibre's ambient GeoJSON type. */
const sourceData = (collection: FeatureCollection) => collection as never;

function toCollection(
  features: readonly MapFeature[],
  placeSlug: string | undefined,
): FeatureCollection {
  return {
    type: 'FeatureCollection' as const,
    features: features.map((feature) => ({
      type: 'Feature' as const,
      geometry: feature.geometry,
      properties: {
        publicId: feature.publicId,
        family: feature.family,
        kind: feature.kind,
        label: feature.label,
        magnitude: feature.magnitudeValue ?? 0,
        href: subjectHref(feature.subjectRef, placeSlug) ?? '',
      },
    })),
  };
}

const visibility = (on: boolean) => (on ? 'visible' : 'none');

export default function MapCanvas({
  styleUrl,
  center,
  placeLabel,
  placeSlug,
  features,
  rings,
  enabled,
  onBasemapError,
}: MapCanvasProps) {
  const [imagesReady, setImagesReady] = useState(false);
  const [selected, setSelected] = useState<{
    lon: number;
    lat: number;
    label: string;
    href: string;
  } | null>(null);
  const on = useMemo(() => new Set(enabled), [enabled]);
  const data = useMemo(() => toCollection(features, placeSlug), [features, placeSlug]);
  const ringData = useMemo(
    (): FeatureCollection => ({
      type: 'FeatureCollection' as const,
      features: rings.map((ring) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: circleRing(center.lat, center.lon, ring.km),
        },
        properties: { family: ring.family },
      })),
    }),
    [rings, center.lat, center.lon],
  );

  const onLoad = useCallback((event: { target: maplibregl.Map }) => {
    const map = event.target;
    const images: [string, ImageData | null][] = [
      ['shape-fire', shapeImage('triangle', FAMILY_META.FIRE_ACTIVITY.color)],
      ['shape-other', shapeImage('diamond', FAMILY_META.OTHER.color)],
      ['hatch-flood', hatchImage(FAMILY_META.FLOODS.color)],
    ];
    for (const [name, image] of images) {
      if (image !== null && !map.hasImage(name)) map.addImage(name, image);
    }
    setImagesReady(true);
  }, []);

  const onClick = useCallback((event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    if (feature === undefined) {
      setSelected(null);
      return;
    }
    const properties = feature.properties as { label?: string; href?: string };
    setSelected({
      lon: event.lngLat.lng,
      lat: event.lngLat.lat,
      label: properties.label ?? '',
      href: properties.href ?? '',
    });
  }, []);

  const ringFilter = [
    'in',
    ['get', 'family'],
    ['literal', rings.map((ring) => ring.family).filter((family) => on.has(family))],
  ] as unknown as maplibregl.FilterSpecification;

  return (
    <MapGL
      initialViewState={{ longitude: center.lon, latitude: center.lat, zoom: 5.4 }}
      mapStyle={styleUrl}
      style={{ width: '100%', height: '100%' }}
      onLoad={onLoad}
      onError={() => {
        onBasemapError?.();
      }}
      onClick={onClick}
      interactiveLayerIds={['eq-circles', 'fire-symbols', 'flood-fill', 'other-symbols']}
      cooperativeGestures
      attributionControl={{ compact: true }}
    >
      <NavigationControl position="top-right" showCompass={false} />
      <Source id="rings" type="geojson" data={sourceData(ringData)}>
        <Layer
          id="rings-line"
          type="line"
          filter={ringFilter}
          paint={{ 'line-color': PALETTE['fg-muted'], 'line-width': 1.2, 'line-dasharray': [1, 2] }}
        />
      </Source>
      <Source id="hazards" type="geojson" data={sourceData(data)}>
        <Layer
          id="flood-fill"
          type="fill"
          filter={['==', ['get', 'family'], 'FLOODS']}
          layout={{ visibility: visibility(on.has('FLOODS') && imagesReady) }}
          paint={{ 'fill-pattern': 'hatch-flood', 'fill-opacity': 0.9 }}
        />
        <Layer
          id="flood-line"
          type="line"
          filter={['==', ['get', 'family'], 'FLOODS']}
          layout={{ visibility: visibility(on.has('FLOODS')) }}
          paint={{ 'line-color': FAMILY_META.FLOODS.color, 'line-width': 1.5 }}
        />
        <Layer
          id="cyclone-line"
          type="line"
          filter={[
            'all',
            ['==', ['get', 'family'], 'CYCLONES'],
            ['==', ['geometry-type'], 'LineString'],
          ]}
          layout={{ visibility: visibility(on.has('CYCLONES')) }}
          paint={{ 'line-color': FAMILY_META.CYCLONES.color, 'line-width': 2.5 }}
        />
        <Layer
          id="cyclone-area"
          type="fill"
          filter={[
            'all',
            ['==', ['get', 'family'], 'CYCLONES'],
            ['==', ['geometry-type'], 'Polygon'],
          ]}
          layout={{ visibility: visibility(on.has('CYCLONES')) }}
          paint={{ 'fill-color': FAMILY_META.CYCLONES.color, 'fill-opacity': 0.15 }}
        />
        <Layer
          id="eq-circles"
          type="circle"
          filter={['==', ['get', 'family'], 'EARTHQUAKES']}
          layout={{ visibility: visibility(on.has('EARTHQUAKES')) }}
          paint={{
            'circle-color': FAMILY_META.EARTHQUAKES.color,
            'circle-opacity': 0.85,
            'circle-radius': ['interpolate', ['linear'], ['get', 'magnitude'], 2, 4, 5, 10, 7, 18],
            'circle-stroke-color': PALETTE.canvas,
            'circle-stroke-width': 1.5,
          }}
        />
        <Layer
          id="fire-symbols"
          type="symbol"
          filter={['==', ['get', 'family'], 'FIRE_ACTIVITY']}
          layout={{
            visibility: visibility(on.has('FIRE_ACTIVITY') && imagesReady),
            'icon-image': 'shape-fire',
            'icon-allow-overlap': true,
          }}
        />
        <Layer
          id="other-symbols"
          type="symbol"
          filter={['==', ['get', 'family'], 'OTHER']}
          layout={{
            visibility: visibility(on.has('OTHER') && imagesReady),
            'icon-image': 'shape-other',
            'icon-allow-overlap': true,
          }}
        />
      </Source>
      <Marker longitude={center.lon} latitude={center.lat} anchor="bottom">
        <svg
          width="24"
          height="24"
          viewBox="0 0 16 16"
          role="img"
          aria-label={`${COPY.map.location}: ${placeLabel}`}
        >
          <path
            d="M8 1a5 5 0 0 1 5 5c0 3.6-5 9-5 9S3 9.6 3 6a5 5 0 0 1 5-5Z"
            fill={PALETTE.fg}
            stroke={PALETTE.canvas}
          />
          <circle cx="8" cy="6" r="2" fill={PALETTE.canvas} />
        </svg>
      </Marker>
      {selected === null ? null : (
        <Popup
          longitude={selected.lon}
          latitude={selected.lat}
          onClose={() => {
            setSelected(null);
          }}
          closeOnClick={false}
        >
          {/* The popup is white; its text and link use dark colours that pass AA on it. */}
          <p style={{ color: PALETTE.canvas, margin: 0 }}>
            {selected.href === '' ? (
              selected.label
            ) : (
              <a href={selected.href} style={{ color: '#0b4a8f' }}>
                {selected.label}
              </a>
            )}
          </p>
        </Popup>
      )}
    </MapGL>
  );
}
