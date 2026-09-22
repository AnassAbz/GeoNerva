'use client';

/**
 * The map region (docs/PRODUCT.md §6.2 row 5, §6.5): location pin, radius rings, per-family
 * layers with keyboard-accessible toggles, and a legend using shape + pattern + colour.
 *
 * Progressive enhancement: WebGL2 is detected after hydration; without it the region shows a
 * note pointing at the Nearby list, which carries every item the map would. The canvas itself is
 * loaded with `next/dynamic` and never rendered on the server.
 *
 * Mobile: a ~200 px preview with "Open map", which opens a full-screen sheet with the layer
 * drawer. Desktop: the page layout makes this region sticky.
 */

import type { HazardFamily, MapFeature } from '@geonerva/domain';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState, type ComponentType } from 'react';

import { COPY } from '../../lib/view/copy.ts';
import { FAMILY_RING_KM, MAPPED_FAMILIES } from '../../lib/view/families.ts';
import { LayerToggles } from './layer-toggles.tsx';
import { MapLegend } from './legend.tsx';
import type { MapCanvasProps } from './map-canvas.tsx';
import { hasWebGL2 } from './webgl.ts';

const LazyMapCanvas = dynamic(() => import('./map-canvas.tsx'), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-fg-muted">{COPY.map.loading}</p>,
});

export interface MapPanelProps {
  readonly styleUrl: string;
  readonly center: { readonly lat: number; readonly lon: number };
  readonly placeLabel: string;
  readonly placeSlug?: string;
  readonly features: readonly MapFeature[];
  /** Anchor of the accessible list that replaces the map. */
  readonly listAnchor?: string;
  /** A small, fixed map without toggles or legend, for detail pages. */
  readonly compact?: boolean;
  /** Injected in tests; the default probes the browser. */
  readonly detectWebGL2?: () => boolean;
  /** Injected in tests; the default is the lazily loaded MapLibre canvas. */
  readonly Canvas?: ComponentType<MapCanvasProps>;
}

type Support = 'checking' | 'yes' | 'no';

export function MapPanel({
  styleUrl,
  center,
  placeLabel,
  placeSlug,
  features,
  listAnchor = '#nearby',
  compact = false,
  detectWebGL2 = hasWebGL2,
  Canvas = LazyMapCanvas,
}: MapPanelProps) {
  const [support, setSupport] = useState<Support>('checking');
  const [expanded, setExpanded] = useState(false);
  const [basemapFailed, setBasemapFailed] = useState(false);
  const [enabled, setEnabled] = useState<ReadonlySet<HazardFamily>>(() => new Set(MAPPED_FAMILIES));

  useEffect(() => {
    // Detection needs a real browser, so it runs after hydration and never on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a one-time probe of the browser
    setSupport(detectWebGL2() ? 'yes' : 'no');
  }, [detectWebGL2]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  const rings = useMemo(
    () =>
      MAPPED_FAMILIES.flatMap((family) => {
        const km = FAMILY_RING_KM[family];
        return km === undefined ? [] : [{ family, km }];
      }),
    [],
  );
  const enabledList = useMemo(() => [...enabled], [enabled]);

  const toggle = (family: HazardFamily, on: boolean) => {
    setEnabled((current) => {
      const next = new Set(current);
      if (on) next.add(family);
      else next.delete(family);
      return next;
    });
  };

  if (compact && support !== 'no') {
    return (
      <div
        role="region"
        aria-label={COPY.map.canvasLabel(placeLabel)}
        className="h-60 overflow-hidden rounded-lg border border-line"
        data-testid="map-panel"
      >
        {support === 'yes' ? (
          <Canvas
            styleUrl={styleUrl}
            center={center}
            placeLabel={placeLabel}
            {...(placeSlug === undefined ? {} : { placeSlug })}
            features={features}
            rings={[]}
            enabled={MAPPED_FAMILIES}
          />
        ) : (
          <p className="p-4 text-sm text-fg-muted">{COPY.map.loading}</p>
        )}
      </div>
    );
  }

  if (support === 'no') {
    return (
      <div
        role="note"
        className="rounded-lg border border-line bg-surface p-4 text-sm"
        data-testid="map-fallback"
      >
        <p>{COPY.map.webglMissing}</p>
        <a href={listAnchor} className="mt-2 inline-flex min-h-11 items-center">
          {COPY.map.listLink}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="map-panel">
      <div
        className={
          expanded ? 'fixed inset-0 z-40 flex flex-col bg-canvas p-2' : 'relative flex flex-col'
        }
      >
        {expanded ? (
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-semibold">{COPY.map.title}</p>
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
              }}
              className="min-h-11 rounded border border-line px-3 text-sm"
            >
              {COPY.map.close}
            </button>
          </div>
        ) : null}
        <div
          role="region"
          aria-label={COPY.map.canvasLabel(placeLabel)}
          className={
            expanded
              ? 'min-h-0 flex-1 overflow-hidden rounded-lg border border-line'
              : 'h-[200px] overflow-hidden rounded-lg border border-line lg:h-[min(70vh,40rem)]'
          }
        >
          {support === 'yes' ? (
            <Canvas
              styleUrl={styleUrl}
              center={center}
              placeLabel={placeLabel}
              {...(placeSlug === undefined ? {} : { placeSlug })}
              features={features}
              rings={rings}
              enabled={enabledList}
              onBasemapError={() => {
                setBasemapFailed(true);
              }}
            />
          ) : (
            <p className="p-4 text-sm text-fg-muted">{COPY.map.loading}</p>
          )}
        </div>
        {expanded ? (
          <div className="mt-2 max-h-[40vh] overflow-y-auto">
            <LayerToggles families={MAPPED_FAMILIES} enabled={enabled} onChange={toggle} />
          </div>
        ) : null}
      </div>
      {basemapFailed ? (
        <p role="status" className="text-sm text-fg-muted">
          {COPY.map.basemapFailed}
        </p>
      ) : null}
      {expanded ? null : (
        <>
          <button
            type="button"
            onClick={() => {
              setExpanded(true);
            }}
            className="min-h-11 rounded border border-line px-3 text-sm lg:hidden"
          >
            {COPY.map.open}
          </button>
          <div className="hidden lg:block">
            <LayerToggles families={MAPPED_FAMILIES} enabled={enabled} onChange={toggle} />
          </div>
        </>
      )}
      <MapLegend />
    </div>
  );
}
