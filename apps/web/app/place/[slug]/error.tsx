'use client';

/**
 * `/place/[slug]`'s failure boundary.
 *
 * Reached when a read the dashboard depends on raised something that is not "no such subject" —
 * `lib/view/data.ts` turns those three refusals into `null` and the page into `notFound()`.
 *
 * A retention refusal normally never gets here: `page.tsx` classifies it on the server, where the
 * error is still itself, and renders the explanation as the page's own content. This boundary
 * carries the wording anyway, for the same refusal raised after the briefing succeeded — the map's
 * features and the cited evidence are read afterwards — and for a development build, where the
 * unredacted error does reach a boundary.
 */

import { BoundaryFailure } from '../../../components/boundary.tsx';
import { COPY } from '../../../lib/view/copy.ts';

export default function PlaceError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <BoundaryFailure
      error={error}
      reset={reset}
      title={COPY.failure.briefingTitle}
      body={COPY.failure.briefingBody}
    />
  );
}
