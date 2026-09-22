'use client';

/**
 * The accordion behaviour of a hazard card on mobile (docs/PRODUCT.md §6.2): below 768 px the
 * card header is a button that expands the body; from 768 px up the body is always shown and the
 * header is a plain heading. The first card with HIGH or CRITICAL relevance starts expanded.
 */

import { useId, useState, type ReactNode } from 'react';

export function CardDisclosure({
  headingId,
  title,
  summary,
  defaultOpen,
  children,
}: {
  readonly headingId: string;
  readonly title: ReactNode;
  /** Short state shown next to the title while collapsed, e.g. "Unavailable". */
  readonly summary: ReactNode;
  readonly defaultOpen: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <>
      <h3 id={headingId} className="text-base font-semibold">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="flex min-h-11 w-full items-center justify-between gap-2 text-left md:hidden"
        >
          <span className="flex items-center gap-2">{title}</span>
          <span className="flex items-center gap-2 text-xs font-normal text-fg-muted">
            {summary}
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden="true"
              focusable="false"
              className={open ? 'rotate-180' : ''}
            >
              <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </span>
        </button>
        <span className="hidden items-center gap-2 md:flex">{title}</span>
      </h3>
      <div id={bodyId} className={open ? 'mt-3' : 'mt-3 hidden md:block'} data-open={open}>
        {children}
      </div>
    </>
  );
}
