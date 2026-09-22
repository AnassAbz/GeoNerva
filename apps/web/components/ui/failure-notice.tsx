/**
 * The panel a failed or refused page renders instead of its content.
 *
 * Deliberately not a client module: the same component is rendered by the `error.tsx` boundaries,
 * which are client components by Next's contract, and by `/place/[slug]` when it classifies a
 * retention refusal on the server. One component, so the two paths cannot drift into saying the
 * same thing two ways.
 *
 * It renders its own `<main id="main">` because it *is* the page: the header's skip link targets
 * that id, and a failure page the skip link cannot reach is one more thing broken for the reader
 * least able to work around it.
 *
 * `announce` is the difference between the two callers. A boundary replaces content the reader was
 * already looking at, so its notice is a live `role="alert"` — the reader must be told that what
 * they were reading is gone. The retention notice is the page's own content on a fresh navigation,
 * announced by the document load like any other page, and marking it as an alert would be a second
 * announcement of something that is not an alarm. Neither path moves focus.
 */

import type { ReactNode } from 'react';

export function FailureNotice({
  title,
  body,
  announce = false,
  children,
}: {
  readonly title: string;
  readonly body: string;
  readonly announce?: boolean;
  /** The affordances: a retry, a way back. Each one is its own ≥ 44 px target. */
  readonly children?: ReactNode;
}) {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-16">
      <div {...(announce ? { role: 'alert' } : {})}>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-fg-muted">{body}</p>
      </div>
      {children === undefined ? null : (
        <div className="mt-6 flex flex-wrap items-center gap-3">{children}</div>
      )}
    </main>
  );
}

/** A ≥ 44 px control, so the retry and the way back are the same size at 320 px. */
export const FAILURE_ACTION_CLASS =
  'inline-flex min-h-11 items-center rounded border border-line bg-raised px-4 text-fg no-underline';
