/**
 * What a failure that reached a page boundary actually was.
 *
 * `lib/view/data.ts` turns three refusals into `null` — the page's `notFound()` — and lets
 * everything else propagate. Of the things that propagate, exactly one is not a fault:
 * `AS_OF_BEFORE_HORIZON`, which means the records for that instant were not kept that long.
 * ADR-035 requires retention loss to be *reported*, so the two cases need different words and
 * this module is the one place that tells them apart.
 *
 * ### Why the check is structural rather than an `instanceof`
 *
 * The obvious implementation imports `ApiProblemError` and asks. It cannot be used here, because
 * this module is imported by an `error.tsx`, which is a client component by Next's contract, and
 * the boundary scan (`lib/server/server-boundary.test.ts`) forbids a `'use client'` module from
 * importing the server's modules — rightly: that import pulls the pool and the validated
 * environment towards the browser bundle. Reading `.problem.code` off the thrown value needs no
 * class identity and works on both sides of the boundary. The cost is that a value which merely
 * has that shape would be classified as a refusal; nothing constructs such a value, and the
 * failure mode is a truthful sentence about retention instead of a truthful sentence about a
 * fault.
 *
 * ### Why the message is also consulted
 *
 * Next redacts a server component's error message before it reaches a client boundary in a
 * production build, replacing it with a fixed sentence and a digest. So a boundary sees the real
 * `ApiProblemError` only in development. The message check is what makes the retention wording
 * appear while developing; production correctness does not rest on it, because the page that
 * accepts `as_of` classifies the refusal on the server, where the error is still itself, and
 * renders the explanation directly (`app/place/[slug]/page.tsx`).
 */

/** A failure GeoNerva caused, or a report that the data was not kept that long. */
export type FailureKind = 'RETENTION' | 'UNEXPECTED';

const RETENTION_CODE = 'AS_OF_BEFORE_HORIZON';

export function failureKind(error: unknown): FailureKind {
  if (problemCode(error) === RETENTION_CODE) return 'RETENTION';
  /* `ApiProblemError`'s message is `<code>: <detail>`, which is what a development boundary sees. */
  if (error instanceof Error && error.message.startsWith(`${RETENTION_CODE}:`)) return 'RETENTION';
  return 'UNEXPECTED';
}

/** The `code` of a thrown problem, by shape. `undefined` for anything else. */
function problemCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('problem' in error)) return undefined;
  const { problem } = error;
  if (typeof problem !== 'object' || problem === null || !('code' in problem)) return undefined;
  const { code } = problem;
  return typeof code === 'string' ? code : undefined;
}
