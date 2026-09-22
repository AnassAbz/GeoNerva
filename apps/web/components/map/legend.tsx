/**
 * The map legend: shape + pattern + colour for every symbol, and words for all of them
 * (docs/PRODUCT.md §6.5). Nothing on the map is distinguished by colour alone.
 */

import { COPY } from '../../lib/view/copy.ts';
import { FAMILY_META } from '../../lib/view/families.ts';
import { PALETTE } from '../../lib/view/palette.ts';
import { FamilyGlyph } from '../ui/shape.tsx';

function LineGlyph({ color, dashed }: { readonly color: string; readonly dashed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <line
        x1="1"
        y1="8"
        x2="15"
        y2="8"
        stroke={color}
        strokeWidth="2.5"
        strokeDasharray={dashed ? '3 2' : undefined}
      />
    </svg>
  );
}

function PinGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 1a5 5 0 0 1 5 5c0 3.6-5 9-5 9S3 9.6 3 6a5 5 0 0 1 5-5Z" fill={PALETTE.fg} />
      <circle cx="8" cy="6" r="2" fill={PALETTE.canvas} />
    </svg>
  );
}

function RingGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke={PALETTE['fg-muted']}
        strokeWidth="1.5"
        strokeDasharray="1 2"
      />
    </svg>
  );
}

export function MapLegend() {
  const items = [
    {
      key: 'location',
      glyph: <PinGlyph />,
      text: COPY.map.legendItems.location,
    },
    { key: 'ring', glyph: <RingGlyph />, text: COPY.map.legendItems.ring },
    {
      key: 'eq',
      glyph: <FamilyGlyph shape="circle" color={FAMILY_META.EARTHQUAKES.color} />,
      text: COPY.map.legendItems.eq,
    },
    {
      key: 'fire',
      glyph: <FamilyGlyph shape="triangle" color={FAMILY_META.FIRE_ACTIVITY.color} />,
      text: COPY.map.legendItems.fire,
    },
    {
      key: 'flood',
      glyph: <FamilyGlyph shape="square" pattern="hatched" color={FAMILY_META.FLOODS.color} />,
      text: COPY.map.legendItems.flood,
    },
    {
      key: 'cyclone-observed',
      glyph: <LineGlyph color={FAMILY_META.CYCLONES.color} dashed={false} />,
      text: COPY.map.legendItems.cycloneObserved,
    },
    {
      key: 'cyclone-forecast',
      glyph: <LineGlyph color={FAMILY_META.CYCLONES.color} dashed />,
      text: COPY.map.legendItems.cycloneForecast,
    },
    {
      key: 'other',
      glyph: <FamilyGlyph shape="diamond" color={FAMILY_META.OTHER.color} />,
      text: COPY.map.legendItems.other,
    },
    {
      key: 'critical',
      glyph: (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="5.5" fill="none" stroke={PALETTE.critical} strokeWidth="2.5" />
        </svg>
      ),
      text: COPY.map.legendItems.critical,
    },
  ];
  return (
    <section
      aria-labelledby="map-legend-title"
      className="rounded-lg border border-line bg-surface p-3"
    >
      <h3
        id="map-legend-title"
        className="text-xs font-semibold uppercase tracking-wide text-fg-subtle"
      >
        {COPY.map.legend}
      </h3>
      <ul className="mt-2 grid gap-1 text-xs text-fg-muted sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-2">
            {item.glyph}
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
