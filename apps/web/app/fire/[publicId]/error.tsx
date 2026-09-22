'use client';

/**
 * `/fire/[publicId]`'s failure boundary.
 *
 * The page's own subject is satellite thermal detections, so the failure sentence is explicit that
 * a page GeoNerva could not build says nothing about what the satellites saw. The alternative
 * reading — an empty page as an absence of detections — is the one error this route must never
 * invite (PRODUCT §6.7, ADR-020).
 */

import { BoundaryFailure } from '../../../components/boundary.tsx';
import { COPY } from '../../../lib/view/copy.ts';

export default function FireError({
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
      title={COPY.failure.fireTitle}
      body={COPY.failure.fireBody}
    />
  );
}
