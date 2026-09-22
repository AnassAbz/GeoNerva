/**
 * `/fire/[publicId]`'s skeleton.
 *
 * The one place a skeleton here departs from "shapes only": the page's mandatory thermal caveat is
 * a box like everything else, because the caveat belongs to the read model and is the provider's
 * and the engine's wording, not the UI's (`lib/view/copy.ts`'s header rule). The UI must not
 * compose a stand-in for it, and rendering a remembered one would be the UI authoring a caveat.
 * The box is sized for it so the sections below do not move when the real sentence lands.
 */

import { LoadingRegion, SkeletonBlock, SkeletonCard } from '../../../components/ui/skeleton.tsx';
import { COPY } from '../../../lib/view/copy.ts';

export default function LoadingFire() {
  return (
    <LoadingRegion label={COPY.loading.fire}>
      <main id="main" className="mx-auto max-w-4xl px-4 pb-8">
        <header className="border-b border-line py-4">
          <SkeletonBlock className="h-8 w-3/4 md:h-9" />
          <SkeletonBlock className="mt-2 h-4 w-52" />
          <SkeletonBlock className="mt-3 h-14 w-full border border-fire/50" />
        </header>

        <section className="mt-6">
          <h2 className="mb-2 text-lg font-semibold">{COPY.fire.summary}</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <SkeletonBlock className="h-10 w-full" />
            <SkeletonBlock className="h-10 w-full" />
            <SkeletonBlock className="h-10 w-full" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
        </section>

        <section className="mt-6">
          <h2 className="mb-2 text-lg font-semibold">{COPY.fire.byDay}</h2>
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
