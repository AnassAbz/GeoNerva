import type { DataConfidenceLevel, RelevanceLevel, SourceHealthStatus } from '@geonerva/domain';
import type { ReactNode } from 'react';

import { COPY } from '../../lib/view/copy.ts';
import { CONFIDENCE_LABEL, RELEVANCE_LABEL } from '../../lib/view/format.ts';
import { STATUS_LABEL, sourceName } from '../../lib/view/sources.ts';
import { StatusGlyph } from './shape.tsx';

/** Visually hidden text for assistive technology. */
export function VisuallyHidden({ children }: { readonly children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}

const RELEVANCE_CLASS: Readonly<Record<RelevanceLevel, string>> = {
  LOW: 'border-rel-low/50 text-rel-low',
  MODERATE: 'border-rel-moderate/60 text-rel-moderate',
  HIGH: 'border-rel-high/70 text-rel-high',
  CRITICAL: 'border-rel-critical bg-rel-critical/10 text-rel-critical',
};

/** Bars of increasing count carry the level alongside the colour. */
const RELEVANCE_BARS: Readonly<Record<RelevanceLevel, number>> = {
  LOW: 1,
  MODERATE: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export function RelevanceBadge({ level }: { readonly level: RelevanceLevel }) {
  const bars = RELEVANCE_BARS[level];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${RELEVANCE_CLASS[level]}`}
      data-relevance={level}
    >
      <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true" focusable="false">
        {[0, 1, 2, 3].map((index) => (
          <rect
            key={index}
            x={index * 3}
            y={8 - index * 2}
            width="2"
            height={2 + index * 2}
            fill="currentColor"
            opacity={index < bars ? 1 : 0.25}
          />
        ))}
      </svg>
      <VisuallyHidden>{COPY.relevance.label}: </VisuallyHidden>
      {RELEVANCE_LABEL[level]}
    </span>
  );
}

export function ConfidenceBadge({ level }: { readonly level: DataConfidenceLevel }) {
  return (
    <span className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted">
      {COPY.situation.confidence}:{' '}
      <span className="ml-1 font-semibold text-fg">{CONFIDENCE_LABEL[level]}</span>
    </span>
  );
}

/** "Derived" tag: marks GeoNerva's own computations (PRODUCT §6.4). */
export function DerivedTag() {
  return (
    <span className="inline-flex items-center rounded-sm border border-derived/50 px-1 text-[0.7rem] font-medium uppercase tracking-wide text-derived">
      {COPY.derived.tag}
      <VisuallyHidden>: {COPY.derived.tagTitle}</VisuallyHidden>
    </span>
  );
}

/** Source status chip with a text label and a distinct shape (PRODUCT §6.7). */
export function StatusChip({ status }: { readonly status: SourceHealthStatus }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border border-line bg-raised px-2 py-0.5 text-xs font-semibold text-fg"
      data-status={status}
    >
      <StatusGlyph status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Compact per-card source health: "USGS ● Fresh". Always with the word, never a bare dot. */
export function SourceDot({
  sourceId,
  status,
}: {
  readonly sourceId: string;
  readonly status: SourceHealthStatus;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-fg-muted" data-status={status}>
      <span className="text-fg">{sourceName(sourceId)}</span>
      <StatusGlyph status={status} size={10} />
      <span>{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** A provider-attributed value: regular text with a source badge (the Observed register). */
export function SourceBadge({ sourceId }: { readonly sourceId: string }) {
  return (
    <span className="inline-flex items-center rounded-sm bg-raised px-1 text-[0.7rem] font-semibold tracking-wide text-fg-muted">
      {sourceName(sourceId)}
    </span>
  );
}
