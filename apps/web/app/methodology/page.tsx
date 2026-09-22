/**
 * `/methodology` (docs/PRODUCT.md §6.9).
 *
 * A server component, and the whole point of it is that it cannot drift from the behaviour it
 * describes: every threshold reaches the page from the exported constant the engine reads, through
 * `COPY.methodology` and the mandated caveats rendered verbatim in `sections.tsx`. No number on
 * this page is typed into it.
 *
 * The only thing this file still fetches is source health, which is what lets the sources section
 * state each source's real cadence and latency rather than a documented intention.
 */

import type { Metadata } from 'next';

import { AttributionList } from '../../components/source-health.tsx';
import { COPY } from '../../lib/view/copy.ts';
import { getSourceStatus } from '../../lib/view/data.ts';
import { METHODOLOGY_SECTIONS, MethodologySections } from './sections.tsx';

export const metadata: Metadata = { title: 'Methodology — GeoNerva' };

export default async function MethodologyPage() {
  const status = await getSourceStatus();
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 pb-8">
      <header className="border-b border-line py-4">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          {COPY.methodology.title}
        </h1>
        <p className="mt-2 text-sm text-fg-muted">{COPY.methodology.intro}</p>
      </header>

      <nav aria-label="On this page" className="mt-4 text-sm">
        <ul className="flex flex-wrap gap-x-4">
          {METHODOLOGY_SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className="inline-flex min-h-11 items-center">
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <MethodologySections sources={status.sources} />

      <section aria-labelledby="not-do-title" className="mt-8">
        <h2 id="not-do-title" className="mb-2 text-lg font-semibold">
          {COPY.methodology.sections.notDo}
        </h2>
        <ul className="list-outside list-disc space-y-1 pl-5 text-sm">
          {COPY.methodology.notDoItems.map((item) => (
            <li key={item} className="break-words">
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="disclaimers-title" className="mt-8">
        <h2 id="disclaimers-title" className="mb-2 text-lg font-semibold">
          {COPY.methodology.sections.disclaimers}
        </h2>
        <p className="mb-2 text-sm text-fg-muted">{COPY.methodology.disclaimersIntro}</p>
        <AttributionList attribution={status.attribution} />
      </section>
    </main>
  );
}
