'use client';

/**
 * The body of every `app/**\/error.tsx`.
 *
 * Next's contract makes an error boundary a client component, and gives it the thrown value and a
 * `reset`. Four routes need four different first sentences and the same three guarantees, so the
 * guarantees live here once:
 *
 *  1. **Nothing about the failure is rendered.** Not `error.message`, not `error.stack`, not
 *     `error.digest`. A production build has already redacted the message to a fixed sentence, but
 *     a development build has not, and the value there is the real one — an `ApiProblemError`
 *     whose text may name a code, or a driver error whose text may name a host or a relation. The
 *     component never reads it for display; it reads it only to choose between two wordings. The
 *     operator's copy of the error is the server log, which is where `problem.ts` says it belongs.
 *  2. **A retry that is real, or no retry at all.** `reset()` re-renders the segment, which is the
 *     right offer for a failure that may not recur. It is the wrong offer for a retention refusal:
 *     the records are not there and pressing a button will not bring them back, so that case gets
 *     a way back to the present instead. A control that cannot work is a lie about the system.
 *  3. **It is announced, and it does not take focus.** `FailureNotice`'s `role="alert"` announces
 *     the replacement of the content the reader was reading. Nothing calls `focus()`: moving focus
 *     here would move it again — to nowhere — the moment `reset()` unmounts the element holding
 *     it, which is precisely the loss of position this is supposed to avoid.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { COPY } from '../lib/view/copy.ts';
import { failureKind } from '../lib/view/failure.ts';
import { FAILURE_ACTION_CLASS, FailureNotice } from './ui/failure-notice.tsx';

export interface BoundaryFailureProps {
  /** Read to classify the failure and never rendered. */
  readonly error: unknown;
  readonly reset: () => void;
  /** What could not be loaded, in this route's words. */
  readonly title: string;
  readonly body: string;
  /** Off on `/data-status` itself, where a link to this page is a link to the failure. */
  readonly offerDataStatus?: boolean;
}

export function BoundaryFailure({
  error,
  reset,
  title,
  body,
  offerDataStatus = true,
}: BoundaryFailureProps) {
  /*
   * The path without its query string, which for a replay is the same page in the present. Read
   * from the router rather than assembled from a slug, so this works on whichever route threw.
   */
  const present = usePathname();

  if (failureKind(error) === 'RETENTION') {
    return (
      <FailureNotice announce title={COPY.failure.retentionTitle} body={COPY.failure.retentionBody}>
        <a href={present} className={FAILURE_ACTION_CLASS}>
          {COPY.failure.retentionExit}
        </a>
        <Link href="/" className={FAILURE_ACTION_CLASS}>
          {COPY.failure.home}
        </Link>
      </FailureNotice>
    );
  }

  return (
    <FailureNotice announce title={title} body={body}>
      <button type="button" onClick={reset} className={FAILURE_ACTION_CLASS}>
        {COPY.failure.retry}
      </button>
      {offerDataStatus ? (
        <a href="/data-status" className={FAILURE_ACTION_CLASS}>
          {COPY.failure.dataStatusLink}
        </a>
      ) : null}
      <Link href="/" className={FAILURE_ACTION_CLASS}>
        {COPY.failure.home}
      </Link>
    </FailureNotice>
  );
}
