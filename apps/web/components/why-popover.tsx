'use client';

/**
 * The "Why?" affordance of a derived value (docs/PRODUCT.md §6.4).
 *
 * It is a disclosure, not a hover tooltip: a button that opens a panel listing the reasons, the
 * caveats and the evidence, operable by tap, click, Enter or Space, closed by the button again,
 * by Escape (focus returns to the button) or by a click outside. Nothing in it is reachable only
 * by hovering. The panel expands in the flow of the page rather than floating, so it can never
 * push a 320 px viewport into horizontal scroll.
 */

import type { Reason } from '@geonerva/domain';
import { useEffect, useId, useRef, useState } from 'react';

import { COPY } from '../lib/view/copy.ts';
import { EvidenceButton } from './evidence.tsx';

export interface WhyPopoverProps {
  /** What is being explained, for the accessible name: "Why? Relevance: Moderate". */
  readonly subject: string;
  readonly reasons: readonly Reason[];
  readonly caveats?: readonly string[];
  readonly evidenceIds?: readonly string[];
  readonly modelVersion?: string;
}

export function WhyPopover({
  subject,
  reasons,
  caveats = [],
  evidenceIds = [],
  modelVersion,
}: WhyPopoverProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="inline">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${COPY.derived.why} ${subject}`}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-derived/50 px-2 text-xs font-semibold text-derived hover:bg-raised md:min-h-7"
      >
        {COPY.derived.why}
      </button>
      <span
        id={panelId}
        role="region"
        aria-label={`${COPY.derived.why} ${subject}`}
        hidden={!open}
        className="mt-2 block rounded border border-line bg-raised p-3 text-sm text-fg"
      >
        <span className="block text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {COPY.derived.reasons}
        </span>
        <span className="mt-1 block">
          {reasons.map((reason) => (
            <span key={`${reason.code}:${reason.text}`} className="mt-1 block">
              {reason.text}
              {reason.evidenceIds.length > 0 ? <EvidenceButton ids={reason.evidenceIds} /> : null}
            </span>
          ))}
        </span>
        {caveats.length > 0 ? (
          <>
            <span className="mt-3 block text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {COPY.derived.caveats}
            </span>
            {caveats.map((caveat) => (
              <span key={caveat} className="mt-1 block text-fg-muted">
                {caveat}
              </span>
            ))}
          </>
        ) : null}
        <span className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
          {evidenceIds.length > 0 ? (
            <EvidenceButton ids={evidenceIds} label={COPY.evidence.openCount(evidenceIds.length)} />
          ) : null}
          {modelVersion === undefined ? null : (
            <span>
              {COPY.derived.model}: <code className="font-mono">{modelVersion}</code>
            </span>
          )}
        </span>
      </span>
    </span>
  );
}
