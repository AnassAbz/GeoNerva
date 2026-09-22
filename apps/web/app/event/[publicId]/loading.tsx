/**
 * `/event/[publicId]`'s skeleton (docs/PRODUCT.md §6.6).
 *
 * The page awaits the detail and then the raw-record metadata for its cited observations, so the
 * wait is two round trips. The boxes follow the real sections in order — header, key facts per
 * source, relevance, timeline, correlation, geometry, links, evidence — inside the same
 * `max-w-4xl` column.
 *
 * The per-source table is a box rather than an empty grid: an empty table with headers invites the
 * reader to believe the columns are the sources this event actually has, and the count of sources
 * is not known until the detail arrives.
 */

import { LoadingRegion, SkeletonBlock, SkeletonCard } from '../../../components/ui/skeleton.tsx';
import { COPY } from '../../../lib/view/copy.ts';

export default function LoadingEvent() {
  return (
    <LoadingRegion label={COPY.loading.event}>
      <main id="main" className="mx-auto max-w-4xl px-4 pb-8">
        <header className="border-b border-line py-4">
          <SkeletonBlock className="h-8 w-3/4 md:h-9" />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <SkeletonBlock className="h-4 w-40" />
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-4 w-36" />
          </div>
        </header>

        <section className="mt-6">
          <h2 className="mb-2 text-lg font-semibold">{COPY.event.keyFacts}</h2>
          <SkeletonBlock className="h-48 w-full border border-line" />
        </section>

        <section className="mt-6">
          <h2 className="mb-2 text-lg font-semibold">{COPY.event.timeline}</h2>
          <SkeletonCard lines={4} />
        </section>

        <section className="mt-6">
          <h2 className="mb-2 text-lg font-semibold">{COPY.event.correlation}</h2>
          <SkeletonCard lines={3} />
        </section>

        <section className="mt-6">
          <h2 className="mb-2 text-lg font-semibold">{COPY.event.geometry}</h2>
          <SkeletonBlock className="h-[200px] w-full border border-line" />
        </section>

        <section className="mt-6">
          <h2 className="mb-2 text-lg font-semibold">{COPY.sources.title}</h2>
          <SkeletonCard lines={3} />
        </section>
      </main>
    </LoadingRegion>
  );
}
