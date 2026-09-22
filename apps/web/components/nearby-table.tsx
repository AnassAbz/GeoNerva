'use client';

/**
 * The Nearby list (docs/PRODUCT.md §6.2 row 6): a sortable table of every assessed item — the
 * accessible, map-independent equivalent of the map. The map never carries information that is
 * not also here (§6.5).
 */

import type { HazardFamily, RelevanceLevel } from '@geonerva/domain';
import { useMemo, useState } from 'react';

import { COPY } from '../lib/view/copy.ts';
import { FAMILY_META } from '../lib/view/families.ts';
import { formatDistanceKm } from '../lib/view/format.ts';
import { RelevanceBadge } from './ui/badges.tsx';
import { FamilyGlyph } from './ui/shape.tsx';

export interface NearbyRow {
  readonly id: string;
  readonly title: string;
  readonly href: string | null;
  readonly family: HazardFamily;
  readonly level: RelevanceLevel;
  readonly distanceKm: number;
  readonly observedAt: string;
  /** Preformatted, e.g. "1 h 19 min ago". */
  readonly timeLabel: string;
  readonly sourceCount: number;
}

type SortKey = 'title' | 'family' | 'distance' | 'level' | 'time' | 'sources';
type Direction = 'ascending' | 'descending';

const LEVEL_RANK: Readonly<Record<RelevanceLevel, number>> = {
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** The direction a column sorts in when first selected: the most useful end first. */
const FIRST_DIRECTION: Readonly<Record<SortKey, Direction>> = {
  title: 'ascending',
  family: 'ascending',
  distance: 'ascending',
  level: 'descending',
  time: 'descending',
  sources: 'descending',
};

function compare(a: NearbyRow, b: NearbyRow, key: SortKey): number {
  switch (key) {
    case 'title':
      return a.title.localeCompare(b.title);
    case 'family':
      return FAMILY_META[a.family].label.localeCompare(FAMILY_META[b.family].label);
    case 'distance':
      return a.distanceKm - b.distanceKm;
    case 'level':
      return LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    case 'time':
      return Date.parse(a.observedAt) - Date.parse(b.observedAt);
    case 'sources':
      return a.sourceCount - b.sourceCount;
  }
}

export function NearbyTable({ rows }: { readonly rows: readonly NearbyRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; direction: Direction }>({
    key: 'distance',
    direction: 'ascending',
  });

  const sorted = useMemo(() => {
    const sign = sort.direction === 'ascending' ? 1 : -1;
    return [...rows].sort((a, b) => sign * compare(a, b, sort.key) || a.distanceKm - b.distanceKm);
  }, [rows, sort]);

  if (rows.length === 0) return <p className="text-fg-muted">{COPY.nearby.empty}</p>;

  const header = (key: SortKey, label: string, numeric = false) => {
    const active = sort.key === key;
    return (
      <th
        scope="col"
        aria-sort={active ? sort.direction : 'none'}
        className={`px-2 py-1 font-semibold ${numeric ? 'text-right' : 'text-left'}`}
      >
        <button
          type="button"
          onClick={() => {
            setSort((current) =>
              current.key === key
                ? {
                    key,
                    direction: current.direction === 'ascending' ? 'descending' : 'ascending',
                  }
                : { key, direction: FIRST_DIRECTION[key] },
            );
          }}
          className="inline-flex min-h-11 min-w-11 items-center gap-1 text-xs uppercase tracking-wide text-fg-muted hover:text-fg md:min-h-8"
        >
          {label}
          <span aria-hidden="true">
            {active ? (sort.direction === 'ascending' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    );
  };

  return (
    <div
      role="region"
      aria-labelledby="nearby-caption"
      tabIndex={0}
      className="overflow-x-auto rounded-lg border border-line"
    >
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <caption id="nearby-caption" className="px-2 py-2 text-left text-xs text-fg-muted">
          {COPY.nearby.caption}
        </caption>
        <thead className="border-b border-line bg-raised">
          <tr>
            {header('title', COPY.nearby.item)}
            {header('family', COPY.nearby.type)}
            {header('distance', COPY.nearby.distance, true)}
            {header('level', COPY.nearby.relevance)}
            {header('time', COPY.nearby.time)}
            {header('sources', COPY.nearby.sources, true)}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const meta = FAMILY_META[row.family];
            return (
              <tr key={row.id} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-2 py-2 text-left font-medium">
                  {row.href === null ? row.title : <a href={row.href}>{row.title}</a>}
                </th>
                <td className="px-2 py-2">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <FamilyGlyph
                      shape={meta.shape}
                      pattern={meta.pattern}
                      color={meta.color}
                      size={14}
                    />
                    {meta.label}
                  </span>
                </td>
                <td className="tabular whitespace-nowrap px-2 py-2 text-right">
                  {formatDistanceKm(row.distanceKm)}
                </td>
                <td className="px-2 py-2">
                  <RelevanceBadge level={row.level} />
                </td>
                <td className="tabular whitespace-nowrap px-2 py-2 text-fg-muted">
                  <time dateTime={row.observedAt}>{row.timeLabel}</time>
                </td>
                <td className="tabular px-2 py-2 text-right">{row.sourceCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
