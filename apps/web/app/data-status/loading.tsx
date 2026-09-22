/**
 * `/data-status`'s skeleton (docs/PRODUCT.md §6.7).
 *
 * This page's whole subject is whether a source is fresh, so its skeleton is the one that must be
 * most careful: no status chip, no success rate, no "last poll" time, not even a grey sparkline
 * that a reader could read as a run of successes. A source's name is unknown until the query
 * returns — the enabled set is a deployment fact — so the rows are boxes and their number is a
 * layout guess, stated as one here rather than implied by the page.
 *
 * The intro paragraph is the UI's own text (§6.7's framing) and is rendered for real, because it
 * is true before any source has been read and it is what tells the reader what the page is for.
 */

import { LoadingRegion, SkeletonBlock, SkeletonCard } from '../../components/ui/skeleton.tsx';
import { COPY } from '../../lib/view/copy.ts';

/** Enough rows to fill the fold at either viewport; the real count comes from the query. */
const ROWS = 4;

export default function LoadingDataStatus() {
  return (
    <LoadingRegion label={COPY.loading.dataStatus}>
      <main id="main" className="mx-auto max-w-5xl px-4 pb-8">
        <header className="border-b border-line py-4">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {COPY.dataStatus.title}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-fg-muted">{COPY.dataStatus.intro}</p>
        </header>

        <div className="mt-6 space-y-4">
          {Array.from({ length: ROWS }, (_, index) => (
            <SkeletonCard key={index} lines={4} />
          ))}
        </div>

        <section className="mt-8">
          <h2 className="mb-2 text-lg font-semibold">{COPY.dataStatus.worker}</h2>
          <SkeletonBlock className="h-4 w-56" />
        </section>

        <section className="mt-8">
          <h2 className="mb-2 text-lg font-semibold">{COPY.dataStatus.dataQuality}</h2>
          <div className="space-y-2">
            <SkeletonCard lines={1} />
            <SkeletonCard lines={1} />
          </div>
        </section>
      </main>
    </LoadingRegion>
  );
}
