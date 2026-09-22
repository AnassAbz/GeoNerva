/**
 * One "What Changed?" item (docs/PRODUCT.md §6.2 row 3): an arrow or icon, the change text, the
 * relevance of its subject, the time, and the evidence behind it. Changes are GeoNerva's own
 * derivation, so the item carries the Derived tag.
 */

import type { ChangeSignalView, ChangeType, RelevanceLevel } from '@geonerva/domain';

import { COPY } from '../lib/view/copy.ts';
import { FAMILY_META } from '../lib/view/families.ts';
import { formatFactValue } from '../lib/view/format.ts';
import { EvidenceButton } from './evidence.tsx';
import { DerivedTag, RelevanceBadge } from './ui/badges.tsx';

type Direction = 'up' | 'down' | 'new' | 'update' | 'source-bad' | 'source-good' | 'conflict';

const DIRECTION: Readonly<Record<ChangeType, Direction>> = {
  NEW_EVENT: 'new',
  EVENT_UPDATED: 'update',
  EVENT_ESCALATED: 'up',
  EVENT_DEESCALATED: 'down',
  EVENT_RESOLVED: 'down',
  ACTIVITY_INCREASE: 'up',
  ACTIVITY_DECREASE: 'down',
  ABNORMAL_ACTIVITY: 'up',
  SOURCE_STALE: 'source-bad',
  SOURCE_RECOVERED: 'source-good',
  SOURCE_CONFLICT: 'conflict',
  RELEVANCE_INCREASE: 'up',
  RELEVANCE_DECREASE: 'down',
  ENTERED_AREA: 'up',
  LEFT_AREA: 'down',
};

const DIRECTION_WORD: Readonly<Record<Direction, string>> = {
  up: 'Increase',
  down: 'Decrease',
  new: 'New',
  update: 'Updated',
  'source-bad': 'Source problem',
  'source-good': 'Source recovered',
  conflict: 'Sources disagree',
};

function DirectionIcon({ direction }: { readonly direction: Direction }) {
  const paths: Readonly<Record<Direction, string>> = {
    up: 'M8 3 13 9H10v4H6V9H3Z',
    down: 'M8 13 3 7h3V3h4v4h3Z',
    new: 'M7 3h2v4h4v2H9v4H7V9H3V7h4Z',
    update: 'M8 3a5 5 0 1 1-4.6 3H5.6A3 3 0 1 0 8 5v2L5 4.5 8 2Z',
    'source-bad': 'M7 2h2v8H7Zm0 10h2v2H7Z',
    'source-good': 'M6.5 11.5 3 8l1.4-1.4 2.1 2.1 5.1-5.1L13 5Z',
    conflict: 'M3 5h7V3l3 3-3 3V7H3Zm10 6H6v2l-3-3 3-3v2h7Z',
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className="mt-0.5 shrink-0"
    >
      <path d={paths[direction]} fill="currentColor" />
    </svg>
  );
}

export interface ChangeItemProps {
  readonly change: ChangeSignalView;
  /** Relevance of the change's subject for this place, when the subject is assessed. */
  readonly relevance?: RelevanceLevel | null;
  /** Link to the subject's page, when it has one. */
  readonly href?: string | null;
  /** Preformatted time, e.g. "1 h 19 min ago". */
  readonly timeLabel?: string | null;
  readonly timeZone: string;
  /** Shown for suppressed items. */
  readonly suppressionText?: string | null;
}

export function ChangeItem({
  change,
  relevance = null,
  href = null,
  timeLabel = null,
  timeZone,
  suppressionText = null,
}: ChangeItemProps) {
  const direction = DIRECTION[change.type];
  const meta = FAMILY_META[change.family];
  return (
    <li
      className="flex gap-3 border-b border-line py-3 last:border-b-0"
      data-prominence={change.prominence}
    >
      <span style={{ color: meta.color }}>
        <DirectionIcon direction={direction} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">
          <span className="sr-only">{DIRECTION_WORD[direction]}: </span>
          {href === null ? (
            change.title
          ) : (
            <a
              href={href}
              className="text-fg underline decoration-line underline-offset-4 hover:decoration-link"
            >
              {change.title}
            </a>
          )}
        </p>
        {change.detail === null ? null : <p className="text-sm text-fg-muted">{change.detail}</p>}
        {change.facets.length > 0 ? (
          <ul className="mt-1 text-sm text-fg-muted">
            {change.facets.map((facet) => (
              <li key={`${facet.type}:${facet.label}`}>
                {facet.label}
                {facet.before !== null && facet.after !== null ? (
                  <span className="tabular">
                    {': '}
                    {formatFactValue(facet.before, timeZone)} →{' '}
                    {formatFactValue(facet.after, timeZone)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
          <span className="font-medium" style={{ color: meta.color }}>
            {meta.label}
          </span>
          {relevance === null ? null : <RelevanceBadge level={relevance} />}
          {timeLabel === null ? null : <span className="tabular">{timeLabel}</span>}
          {change.lateReport ? (
            <span className="rounded-sm border border-line px-1">{COPY.changes.lateReport}</span>
          ) : null}
          <DerivedTag />
          <EvidenceButton ids={[change.id, ...change.evidenceIds]} />
        </p>
        {suppressionText === null ? null : (
          <p className="mt-1 text-xs text-fg-subtle">
            {COPY.changes.suppressedBecause} {suppressionText}
          </p>
        )}
      </div>
    </li>
  );
}
