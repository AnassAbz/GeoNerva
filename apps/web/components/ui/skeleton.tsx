/**
 * The vocabulary every `loading.tsx` is built from.
 *
 * ### A skeleton is a shape, never a value
 *
 * PRODUCT §6.7's rule — a card "never shows 0" — applies with more force to a placeholder than to
 * a card, because a placeholder is what a reader sees *before* they have any reason to distrust
 * it. So the pieces here render empty boxes: no zeros, no dashes standing in for numbers, no
 * invented place name, no sample headline. What a skeleton may render is the page's own furniture
 * — the region headings of §6.2, which are the UI's words and are true before the data arrives —
 * and that is what keeps the layout from jumping when the content replaces it.
 *
 * ### How it is announced, and why this way round
 *
 * `LoadingRegion` carries a polite live region holding one sentence, and every grey shape is
 * `aria-hidden`. The alternative — `aria-busy` on the container — was rejected rather than
 * overlooked: `aria-busy` tells a screen reader that a region *already in the accessibility tree*
 * is being updated, and on an App Router navigation that is not what happens. The segment's whole
 * subtree is replaced by this fallback, so there is no prior region to mark busy, and a freshly
 * inserted `aria-busy` container is announced by nothing. A polite live region is announced on
 * insertion, once, without interrupting whatever the reader was hearing.
 *
 * Nothing here is focusable and nothing calls `focus()`. That is the other half of the
 * requirement: focus stays exactly where the reader left it — on the link they activated, or in
 * the browser's own chrome — so when the real content streams in, no position has been lost and
 * nothing has to be restored.
 */

import type { ReactNode } from 'react';

/**
 * A grey block standing in for text, a chip or a panel.
 *
 * `aria-hidden` because it is decoration: a screen reader that walked a dozen empty boxes would
 * learn less than it learns from the one sentence `LoadingRegion` announces.
 */
export function SkeletonBlock({ className = '' }: { readonly className?: string }) {
  return <div aria-hidden="true" className={`rounded bg-raised ${className}`} />;
}

/** A skeleton panel with the border and background a real card has, so the box does not move. */
export function SkeletonCard({
  className = '',
  lines = 3,
}: {
  readonly className?: string;
  readonly lines?: number;
}) {
  return (
    <div
      aria-hidden="true"
      className={`space-y-2 rounded-lg border border-line bg-surface p-4 ${className}`}
    >
      <SkeletonBlock className="h-4 w-1/3" />
      {Array.from({ length: lines }, (_, index) => (
        <SkeletonBlock key={index} className={`h-3 ${index === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

/**
 * The wrapper every route skeleton is inside.
 *
 * The pulse is a two-second opacity fade, not a flash or a sweep (§6.5), and `globals.css`
 * already reduces every animation to nothing under `prefers-reduced-motion: reduce`.
 */
export function LoadingRegion({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div data-loading="true" className="animate-pulse">
      <p role="status" className="sr-only">
        {label}
      </p>
      {children}
    </div>
  );
}
