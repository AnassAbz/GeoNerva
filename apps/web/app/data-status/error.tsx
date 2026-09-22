'use client';

/**
 * `/data-status`'s failure boundary.
 *
 * `getSourceStatus` has no `null` branch at all — every failure propagates — so this is the whole
 * of what the reader sees when the health query fails. It offers no link to the data-status page,
 * which is this page, and its sentence asks the reader to treat freshness as unknown: the page
 * that tells "no data" from "no hazard" apart is exactly the page whose absence must not be read
 * as reassurance.
 */

import { BoundaryFailure } from '../../components/boundary.tsx';
import { COPY } from '../../lib/view/copy.ts';

export default function DataStatusError({
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
      offerDataStatus={false}
      title={COPY.failure.dataStatusTitle}
      body={COPY.failure.dataStatusBody}
    />
  );
}
