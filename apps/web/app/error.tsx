'use client';

/**
 * The boundary for every route that has no closer one — today `/` and `/methodology`.
 *
 * Neither renders provider data, so a failure here is a code or a configuration fault rather than
 * a failed read, and the wording is correspondingly plain. It exists so that such a fault is still
 * an explained page with a retry instead of the framework's own blank error screen.
 *
 * `global-error.tsx` is deliberately not added: it replaces the root layout, which is where the
 * nonce-bearing document, the skip link and the "not a warning system" footer live, so a page
 * rendered without it would lose the very furniture a reader in trouble needs. A layout that
 * cannot render is a deployment failure, not a state to design for.
 */

import { BoundaryFailure } from '../components/boundary.tsx';
import { COPY } from '../lib/view/copy.ts';

export default function AppError({
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
      title={COPY.failure.pageTitle}
      body={COPY.failure.pageBody}
    />
  );
}
