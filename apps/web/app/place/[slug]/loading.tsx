/**
 * The dashboard's skeleton (docs/PRODUCT.md §6.2).
 *
 * This is the one route where the wait is always visible: `page.tsx` awaits a briefing, every
 * family's history, the map's features and the cited evidence — four round trips to the database,
 * two of them sequential because a viewport needs the coordinates the briefing resolved.
 *
 * The eight regions are laid out in the order §6.2 gives them and in the grid `page.tsx` uses —
 * `max-w-7xl`, then twelve columns from `lg` with the left five holding regions 2–4 and 6–8 and
 * the right seven holding the map from row 1. The map's box repeats the panel's own
 * `h-[200px] lg:h-[min(70vh,40rem)]`. That is what keeps the page from jumping: the content
 * arrives into boxes of the height it was already occupying.
 *
 * The region headings are rendered for real, because they are the UI's own words and are true
 * before any data exists. Everything a source would have supplied — the place name, the local
 * time, the counts, the percentiles — is a grey box. A skeleton that guessed at a place name
 * would be the most convincing wrong thing on the page.
 */

import { LoadingRegion, SkeletonBlock, SkeletonCard } from '../../../components/ui/skeleton.tsx';
import { COPY } from '../../../lib/view/copy.ts';
import { FAMILY_ORDER } from '../../../lib/view/families.ts';

export default function LoadingPlace() {
  return (
    <LoadingRegion label={COPY.loading.briefing}>
      <main id="main" className="mx-auto max-w-7xl px-4 pb-8">
        {/* 1 · Header: place, local time, data as of, window selector. */}
        <header className="border-b border-line py-4">
          <SkeletonBlock className="h-8 w-3/4 max-w-sm md:h-9" />
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="h-4 w-44" />
            <div className="flex items-center gap-1">
              <SkeletonBlock className="h-11 w-14 md:h-8" />
              <SkeletonBlock className="h-11 w-14 md:h-8" />
              <SkeletonBlock className="h-11 w-14 md:h-8" />
            </div>
          </div>
        </header>

        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* 2 · Situation strip. */}
          <div className="lg:col-span-5 lg:col-start-1">
            <SkeletonCard lines={2} />
          </div>

          {/* 3 · What Changed. */}
          <section className="lg:col-span-5 lg:col-start-1">
            <h2 className="mb-2 text-lg font-semibold">{COPY.changes.title}</h2>
            <SkeletonCard lines={3} />
          </section>

          {/* 4 · One card per hazard family, in the order the dashboard renders them. */}
          <section className="space-y-3 lg:col-span-5 lg:col-start-1">
            {FAMILY_ORDER.map((family) => (
              <SkeletonCard key={family} lines={2} />
            ))}
          </section>

          {/* 5 · Map: the panel's own box, so the canvas does not push the column down. */}
          <section className="lg:col-span-7 lg:col-start-6 lg:row-span-6 lg:row-start-1">
            <div className="lg:sticky lg:top-4">
              <h2 className="mb-2 text-lg font-semibold">{COPY.map.title}</h2>
              <SkeletonBlock className="h-[200px] w-full border border-line lg:h-[min(70vh,40rem)]" />
            </div>
          </section>

          {/* 6 · Nearby list. */}
          <section className="lg:col-span-5 lg:col-start-1">
            <h2 className="mb-2 text-lg font-semibold">{COPY.nearby.title}</h2>
            <SkeletonCard lines={4} />
          </section>

          {/* 7 · Historical context. */}
          <section className="lg:col-span-5 lg:col-start-1">
            <h2 className="mb-2 text-lg font-semibold">{COPY.history.title}</h2>
            <div className="space-y-3">
              <SkeletonCard lines={3} />
              <SkeletonCard lines={3} />
            </div>
          </section>

          {/* 8 · Sources & evidence. */}
          <section className="lg:col-span-5 lg:col-start-1">
            <h2 className="mb-2 text-lg font-semibold">{COPY.sources.title}</h2>
            <SkeletonCard lines={4} />
          </section>
        </div>
      </main>
    </LoadingRegion>
  );
}
