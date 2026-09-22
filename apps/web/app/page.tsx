/** `/` — hero, search, curated places and a short "how it works" (docs/PRODUCT.md §6.1). */

import { PlaceSearch } from '../components/place-search.tsx';
import { COPY } from '../lib/view/copy.ts';
import { getCuratedPlaces } from '../lib/view/data.ts';

/*
 * The search box is no longer handed a list of places to filter. P0 capability 1 is "local
 * type-ahead (GeoNames)", and the endpoint that serves it — `/api/v1/places/suggest` — reads the
 * same table this page would have had to read, with the query validation, the rate limit and the
 * cache policy already around it. Rendering a copy of the list into the page was the P9a
 * stand-in for having no database; keeping it would mean two sources of suggestions that can
 * disagree, and a list that goes stale the moment the page is cached.
 */
export default async function HomePage() {
  const curated = await getCuratedPlaces();
  return (
    <main id="main" className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12 md:py-16">
      <div>
        <h1 className="text-4xl font-semibold tracking-tight">{COPY.product.name}</h1>
        <p className="mt-2 text-xl text-fg">{COPY.product.tagline}</p>
        <p className="mt-2 text-fg-muted">{COPY.product.description}</p>
      </div>

      <div>
        <PlaceSearch />
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
