'use client';

/**
 * `/event/[publicId]`'s failure boundary.
 *
 * An event that GeoNerva has no record of is `null` in `lib/view/data.ts` and a 404 on the page;
 * a superseded public id is a permanent redirect there. So what reaches here is a genuine failure,
 * and the sentence says so rather than implying the event went away.
 */

import { BoundaryFailure } from '../../../components/boundary.tsx';
import { COPY } from '../../../lib/view/copy.ts';

export default function EventError({
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
      title={COPY.failure.eventTitle}
      body={COPY.failure.eventBody}
    />
  );
}
