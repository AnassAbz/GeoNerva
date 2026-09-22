'use client';

/**
 * "What Changed?" (docs/PRODUCT.md §6.2 row 3): up to three HEADLINE items, then LISTED items,
 * then "Show N minor changes" — the suppressed signals with the reason each was filtered out, so
 * the filtering is visible rather than silent.
 */

import type { ChangeSection, RelevanceLevel } from '@geonerva/domain';
import { useId, useState } from 'react';

import { COPY } from '../lib/view/copy.ts';
import { ChangeItem } from './change-item.tsx';

export interface SubjectContext {
  readonly relevance: RelevanceLevel | null;
  readonly href: string | null;
  readonly timeLabel: string | null;
}

export function WhatChanged({
  section,
  subjects,
  timeZone,
  fallbackTimeLabel,
}: {
  readonly section: ChangeSection;
  /** Per subject reference: its relevance here, its page and its observation time. */
  readonly subjects: Readonly<Record<string, SubjectContext>>;
  readonly timeZone: string;
  /** Shown for changes without an assessed subject (e.g. a source going stale). */
  readonly fallbackTimeLabel: string;
}) {
  const [showSuppressed, setShowSuppressed] = useState(false);
  const suppressedId = useId();
  const headline = section.headline.slice(0, 3);
  const listed = [...section.headline.slice(3), ...section.listed];

  const contextOf = (subjectRef: string | null): SubjectContext =>
    (subjectRef === null ? undefined : subjects[subjectRef]) ?? {
      relevance: null,
      href: null,
      timeLabel: fallbackTimeLabel,
    };

  return (
    <div>
      {headline.length === 0 && listed.length === 0 ? (
        <p className="text-fg-muted">{section.emptyStatement}</p>
      ) : (
        <ul aria-label={COPY.changes.title}>
          {[...headline, ...listed].map((change) => {
            const context = contextOf(change.subjectRef);
            return (
              <ChangeItem
                key={change.id}
                change={change}
                relevance={context.relevance}
                href={context.href}
                timeLabel={context.timeLabel}
                timeZone={timeZone}
              />
            );
          })}
        </ul>
      )}
      {section.suppressedCount > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={showSuppressed}
            aria-controls={suppressedId}
            onClick={() => {
              setShowSuppressed((value) => !value);
            }}
            className="min-h-11 rounded border border-line px-3 text-sm text-fg-muted hover:bg-raised"
          >
            {showSuppressed
              ? COPY.changes.hideSuppressed
              : COPY.changes.showSuppressed(section.suppressedCount)}
          </button>
          <ul id={suppressedId} hidden={!showSuppressed} className="mt-2 opacity-90">
            {section.suppressed.map((change) => {
              const context = contextOf(change.subjectRef);
              return (
                <ChangeItem
                  key={change.id}
                  change={change}
                  relevance={context.relevance}
                  href={context.href}
                  timeLabel={null}
                  timeZone={timeZone}
                  suppressionText={
                    change.suppressionReason === null
                      ? null
                      : COPY.suppression[change.suppressionReason]
                  }
                />
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
