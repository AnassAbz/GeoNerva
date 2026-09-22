import type { SourceHealthStatus } from '@geonerva/domain';

import type { FamilyPattern, FamilyShape } from '../../lib/view/families.ts';

/**
 * Small SVG glyphs. Shapes carry meaning alongside colour (a status or a family is never told
 * apart by colour alone), so they are decorative to assistive technology: the text next to them
 * is what is read.
 */

const SHAPE_PATHS: Readonly<Record<FamilyShape, string>> = {
  circle: 'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Z',
  triangle: 'M8 2 14.5 13.5h-13Z',
  square: 'M2.5 2.5h11v11h-11Z',
  diamond: 'M8 1.5 14.5 8 8 14.5 1.5 8Z',
  hexagon: 'M4.5 2h7L15 8l-3.5 6h-7L1 8Z',
  bar: 'M1.5 5.5h13v5h-13Z',
};

export function FamilyGlyph({
  shape,
  pattern = 'solid',
  color,
  size = 16,
}: {
  readonly shape: FamilyShape;
  readonly pattern?: FamilyPattern;
  readonly color: string;
  readonly size?: number;
}) {
  const id = `pattern-${shape}-${pattern}`;
  const fill = pattern === 'hatched' ? `url(#${id})` : pattern === 'solid' ? color : 'transparent';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="inline-block shrink-0"
    >
      {pattern === 'hatched' ? (
        <defs>
          <pattern
            id={id}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="4" stroke={color} strokeWidth="2" />
          </pattern>
        </defs>
      ) : null}
      <path
        d={SHAPE_PATHS[shape]}
        fill={fill}
        stroke={color}
        strokeWidth={pattern === 'solid' ? 0 : 1.5}
        strokeDasharray={pattern === 'dashed' ? '3 2' : pattern === 'dotted' ? '1 2' : undefined}
      />
    </svg>
  );
}

/** FRESH ● · DEGRADED ◐ · STALE ○ · UNAVAILABLE ✕ — distinct shapes, not only colours. */
export function StatusGlyph({
  status,
  size = 12,
}: {
  readonly status: SourceHealthStatus;
  readonly size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 12 12',
    'aria-hidden': true as const,
    focusable: false as const,
  };
  switch (status) {
    case 'FRESH':
      return (
        <svg {...common} className="inline-block shrink-0 text-fresh">
          <circle cx="6" cy="6" r="5" fill="currentColor" />
        </svg>
      );
    case 'DEGRADED':
      return (
        <svg {...common} className="inline-block shrink-0 text-degraded">
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.5a4.5 4.5 0 0 1 0 9Z" fill="currentColor" />
        </svg>
      );
    case 'STALE':
      return (
        <svg {...common} className="inline-block shrink-0 text-stale">
          <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case 'UNAVAILABLE':
      return (
        <svg {...common} className="inline-block shrink-0 text-unavailable">
          <path
            d="M2 2l8 8M10 2l-8 8"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
