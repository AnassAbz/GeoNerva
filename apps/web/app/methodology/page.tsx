/**
 * `/methodology` — skeleton (P9a). The section structure of docs/PRODUCT.md §6.9, with the
 * statements that do not depend on thresholds. P9b renders every threshold from the same exported
 * configuration the code uses, so the page cannot drift from the behaviour it describes.
 */

import type { Metadata } from 'next';

import { AttributionList } from '../../components/source-health.tsx';
import { COPY } from '../../lib/view/copy.ts';
import { getSourceStatus } from '../../lib/view/data.ts';

export const metadata: Metadata = { title: 'Methodology — GeoNerva' };

const SECTIONS = [
  { id: 'sources', title: COPY.methodology.sections.sources },
  { id: 'correlation', title: COPY.methodology.sections.correlation },
  { id: 'relevance', title: COPY.methodology.sections.relevance },
  { id: 'eq-count', title: COPY.methodology.sections.baselines },
  { id: 'fire-trend', title: 'Fire activity trend' },
  { id: 'gdacs-context', title: 'GDACS event context' },
  { id: 'changes', title: COPY.methodology.sections.changes },
] as const;

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
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className="inline-flex min-h-11 items-center">
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section id="sources" aria-labelledby="sources-title" className="mt-6">
        <h2 id="sources-title" className="mb-2 text-lg font-semibold">
          {COPY.methodology.sections.sources}
        </h2>
        <ul className="space-y-2 text-sm">
          {status.sources.map((source) => (
            <li key={source.sourceId}>
              <span className="font-semibold">{source.name}.</span>{' '}
              <span className="text-fg-muted">{source.coverageNote}</span>
            </li>
          ))}
        </ul>
      </section>

      {SECTIONS.slice(1).map((section) => (
        <section
          key={section.id}
          id={section.id}
          aria-labelledby={`${section.id}-title`}
          className="mt-6"
        >
          <h2 id={`${section.id}-title`} className="mb-2 text-lg font-semibold">
            {section.title}
          </h2>
          <p className="text-sm text-fg-muted">{COPY.methodology.pending}</p>
        </section>
      ))}

      <section aria-labelledby="not-do-title" className="mt-6">
        <h2 id="not-do-title" className="mb-2 text-lg font-semibold">
          {COPY.methodology.sections.notDo}
        </h2>
        <ul className="list-inside list-disc space-y-1 text-sm">
          {COPY.methodology.notDoItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="disclaimers-title" className="mt-6">
        <h2 id="disclaimers-title" className="mb-2 text-lg font-semibold">
          {COPY.methodology.sections.disclaimers}
        </h2>
        <AttributionList attribution={status.attribution} />
      </section>
    </main>
  );
}
