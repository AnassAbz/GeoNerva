/** `/` — hero, search, curated places and a short "how it works" (docs/PRODUCT.md §6.1). */

import { PlaceSearch } from '../components/place-search.tsx';
import { COPY } from '../lib/view/copy.ts';
import { getCuratedPlaces, getPlaceSuggestions } from '../lib/view/data.ts';

export default async function HomePage() {
  const [suggestions, curated] = await Promise.all([getPlaceSuggestions(), getCuratedPlaces()]);
  return (
    <main id="main" className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12 md:py-16">
      <div>
        <h1 className="text-4xl font-semibold tracking-tight">{COPY.product.name}</h1>
        <p className="mt-2 text-xl text-fg">{COPY.product.tagline}</p>
        <p className="mt-2 text-fg-muted">{COPY.product.description}</p>
      </div>

      <div>
        <PlaceSearch suggestions={suggestions} />
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <span>{COPY.home.tryLabel}</span>
          {curated.map((place) => (
            <a
              key={place.slug}
              href={`/place/${place.slug}`}
              className="inline-flex min-h-11 items-center"
            >
              {place.label}
            </a>
          ))}
        </p>
      </div>

      <section aria-labelledby="how-title">
        <h2 id="how-title" className="text-lg font-semibold">
          {COPY.home.howTitle}
        </h2>
        <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-fg-muted">
          {COPY.home.howSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <a href="/methodology" className="mt-2 inline-flex min-h-11 items-center text-sm">
          {COPY.home.methodologyLink}
        </a>
      </section>

      <p
        role="note"
        className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-fg-muted"
      >
        {COPY.product.notWarning}
      </p>
    </main>
  );
}
