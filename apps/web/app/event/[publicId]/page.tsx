/**
 * `/event/[publicId]` — canonical event detail (docs/PRODUCT.md §6.6): title and status;
 * per-source values side by side with the spread and the agreement; relevance for the place the
 * reader came from; the version timeline; why these reports are one event; the geometry; the
 * official links; the evidence.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EvidenceButton, EvidenceProvider } from '../../../components/evidence.tsx';
import { MapPanel } from '../../../components/map/map-panel.tsx';
import { DerivedTag, RelevanceBadge, SourceBadge } from '../../../components/ui/badges.tsx';
import { WhyPopover } from '../../../components/why-popover.tsx';
import { parseMapStyleUrl } from '../../../lib/map-style.ts';
import { COPY } from '../../../lib/view/copy.ts';
import { getEventDetail, getEvidenceDetails } from '../../../lib/view/data.ts';
import { eventMapFeatures } from '../../../lib/view/detail-map.ts';
import {
  HAZARD_LABEL,
  LIFECYCLE_LABEL,
  formatDateTime,
  formatDistanceKm,
  formatFactValue,
} from '../../../lib/view/format.ts';
import { first, type SearchParams } from '../../../lib/view/query.ts';
import { placeHref } from '../../../lib/view/routes.ts';
import { sourceName } from '../../../lib/view/sources.ts';

interface PageProps {
  readonly params: Promise<{ publicId: string }>;
  readonly searchParams: Promise<SearchParams>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { publicId } = await params;
  const detail = await getEventDetail(publicId);
  return { title: detail === null ? 'GeoNerva' : `${detail.headline.title} — GeoNerva` };
}

const TIME_ZONE = 'UTC';

export default async function EventPage({ params, searchParams }: PageProps) {
  const { publicId } = await params;
  const search = await searchParams;
  const placeSlug = first(search['place']);
  const detail = await getEventDetail(
    decodeURIComponent(publicId),
    placeSlug === undefined ? {} : { placeSlug },
  );
  if (detail === null) notFound();

  /* ADR-038's "Raw record", for the observations this response cites (bounded in `data.ts`). */
  const evidenceDetails = await getEvidenceDetails(detail.evidenceManifest.map((item) => item.id));

  const { headline, agreement } = detail;
  /* Columns: every source that contributed a compared value, with its credited agency. */
  const columns = [
    ...new Map(
      agreement.comparisons
        .flatMap((comparison) => comparison.values)
        .map((value) => [value.sourceId, value.contributor] as const),
    ),
  ];
  const mapStyle = parseMapStyleUrl(process.env['MAP_STYLE_URL']);
  const tsunami = headline.facts.find((fact) => fact.code === 'tsunami_flag');

  return (
    <EvidenceProvider
      manifest={detail.evidenceManifest}
      details={evidenceDetails}
      timeZone={TIME_ZONE}
    >
      <main id="main" className="mx-auto max-w-4xl px-4 pb-8">
        <header className="border-b border-line py-4">
          {placeSlug === undefined ? null : (
            <a href={placeHref(placeSlug)} className="inline-flex min-h-11 items-center text-sm">
              ← {COPY.event.backToPlace}
            </a>
          )}
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{headline.title}</h1>
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted">
            <span>
              <code className="font-mono text-fg">{detail.publicId}</code>
            </span>
            <span>{HAZARD_LABEL[detail.hazardType]}</span>
            <span>
              {COPY.event.status}: {LIFECYCLE_LABEL[headline.lifecycleStatus]} ·{' '}
              {headline.isActive ? COPY.event.active : COPY.event.inactive}
            </span>
            <span className="tabular">
              <time dateTime={headline.observedAt}>
                {formatDateTime(headline.observedAt, TIME_ZONE)} UTC
              </time>
            </span>
          </p>
        </header>

        <section aria-labelledby="facts-title" className="mt-6">
          <h2 id="facts-title" className="mb-2 text-lg font-semibold">
            {COPY.event.keyFacts}
          </h2>
          <p className="mb-2 text-sm text-fg-muted">
            {headline.preferenceReason.text}
            <EvidenceButton ids={headline.preferenceReason.evidenceIds} />
          </p>
          <div
            role="region"
            aria-labelledby="facts-title"
            tabIndex={0}
            className="overflow-x-auto rounded-lg border border-line"
          >
            <table className="w-full min-w-[28rem] border-collapse text-sm">
              <thead className="border-b border-line bg-raised">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left">
                    {COPY.event.field}
                  </th>
                  {columns.map(([sourceId, contributor]) => (
                    <th key={sourceId} scope="col" className="px-3 py-2 text-left">
                      <SourceBadge sourceId={sourceId} />
                      {contributor === null ? null : (
                        <span className="ml-1 text-xs font-normal text-fg-subtle">
                          ({COPY.event.contributor}: {contributor})
                        </span>
                      )}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-left">
                    {COPY.event.spread}
                  </th>
                </tr>
              </thead>
              <tbody>
                {agreement.comparisons.map((comparison) => (
                  <tr
                    key={comparison.code}
                    className="border-b border-line last:border-b-0"
                    data-conflict={comparison.isConflict}
                  >
                    <th scope="row" className="px-3 py-2 text-left font-medium">
                      {comparison.label}
                    </th>
                    {columns.map(([sourceId]) => {
                      const value = comparison.values.find((entry) => entry.sourceId === sourceId);
                      return (
                        <td key={sourceId} className="tabular px-3 py-2">
                          {value === undefined
                            ? COPY.event.notReported
                            : formatFactValue(value.value, TIME_ZONE)}
                        </td>
                      );
                    })}
                    <td className="tabular px-3 py-2 text-fg-muted">
                      {comparison.spread === null
                        ? '—'
                        : formatFactValue(comparison.spread, TIME_ZONE)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 rounded-lg border border-line bg-surface p-3 text-sm">
            <p className="flex flex-wrap items-center gap-2 font-semibold">
              {COPY.card.agreement}: {COPY.agreement[agreement.level]}
              <span className="font-normal text-fg-muted">
                · {COPY.card.independent(agreement.nIndependentSources, agreement.nSources)}
              </span>
              <DerivedTag />
            </p>
            <ul className="mt-1 space-y-1 text-fg-muted">
              {agreement.reasons.map((reason) => (
                <li key={reason.code}>
                  {reason.text}
                  <EvidenceButton ids={reason.evidenceIds} />
                </li>
              ))}
            </ul>
          </div>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {headline.facts.map((fact) => (
              <li
                key={fact.code}
                className="rounded border border-line bg-surface px-3 py-2 text-sm"
              >
                <span className="block text-xs text-fg-subtle">{fact.label}</span>
                <span className="tabular">{formatFactValue(fact.value, TIME_ZONE)}</span>{' '}
                <SourceBadge sourceId={headline.preferredSourceId} />
                <EvidenceButton ids={fact.evidenceIds} />
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="relevance-title" className="mt-6">
          <h2 id="relevance-title" className="mb-2 text-lg font-semibold">
            {COPY.card.relevance}
          </h2>
          {detail.relevance === null || detail.distanceKm === null ? (
            <p className="text-sm text-fg-muted">{COPY.event.noPlace}</p>
          ) : (
            <div className="rounded-lg border border-line bg-surface p-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <RelevanceBadge level={detail.relevance.level} />
                <span className="tabular">
                  {formatDistanceKm(detail.distanceKm)} {COPY.card.km}
                </span>
                <DerivedTag />
                <WhyPopover
                  subject={`${COPY.card.relevance}: ${headline.title}`}
                  reasons={detail.relevance.reasons}
                  caveats={detail.relevance.caveats}
                  evidenceIds={detail.relevance.evidenceIds}
                  modelVersion={detail.relevance.modelVersion}
                />
              </p>
              <ul className="mt-2 space-y-1 text-fg-muted">
                {detail.relevance.reasons.map((reason) => (
                  <li key={reason.code}>{reason.text}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section aria-labelledby="timeline-title" className="mt-6">
          <h2 id="timeline-title" className="mb-2 text-lg font-semibold">
            {COPY.event.timeline}
          </h2>
          <ol className="space-y-2">
            {detail.timeline.map((entry) => (
              <li
                key={`${entry.sourceId}:${entry.versionId}`}
                className="rounded-lg border border-line bg-surface p-3 text-sm"
              >
                <p className="flex flex-wrap items-center gap-2">
                  <SourceBadge sourceId={entry.sourceId} />
                  <span className="font-medium">{entry.summary}</span>
                  <EvidenceButton ids={[entry.evidenceId]} />
                </p>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-fg-muted">
                  <dt>{COPY.evidence.observed}</dt>
                  <dd className="tabular">{formatDateTime(entry.observedAt, TIME_ZONE)} UTC</dd>
                  <dt>{COPY.event.sourceUpdated}</dt>
                  <dd className="tabular">
                    {entry.sourceUpdatedAt === null
                      ? '—'
                      : `${formatDateTime(entry.sourceUpdatedAt, TIME_ZONE)} UTC`}
                  </dd>
                  <dt>{COPY.evidence.ingested}</dt>
                  <dd className="tabular">{formatDateTime(entry.ingestedAt, TIME_ZONE)} UTC</dd>
                </dl>
                {entry.changes.length > 0 ? (
                  <ul className="mt-1 text-xs text-fg-muted">
                    {entry.changes.map((change) => (
                      <li key={change.code}>
                        {change.label}:{' '}
                        {change.before === null ? '—' : formatFactValue(change.before, TIME_ZONE)} →{' '}
                        {change.after === null ? '—' : formatFactValue(change.after, TIME_ZONE)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="correlation-title" className="mt-6">
          <h2 id="correlation-title" className="mb-2 text-lg font-semibold">
            {COPY.event.correlation}
          </h2>
          <ul className="space-y-2">
            {detail.correlation.decisions.map((decision) => (
              <li
                key={decision.linkId}
                className="rounded-lg border border-line bg-surface p-3 text-sm"
              >
                <p className="flex flex-wrap items-center gap-2">
                  <SourceBadge sourceId={decision.sourceId} />
                  <code className="font-mono text-xs">{decision.primaryKey}</code>
                  <span className="text-fg-muted">
                    {decision.relation === 'DERIVED_COPY'
                      ? COPY.event.derivedCopy
                      : COPY.event.independent}
                  </span>
                  <DerivedTag />
                  <EvidenceButton ids={[decision.evidenceId]} />
                </p>
                <ul className="mt-1 space-y-0.5 text-fg-muted">
                  {decision.reasons.map((reason) => (
                    <li key={reason.code}>{reason.text}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {detail.correlation.possibleMatches.length > 0 ? (
            <>
              <h3 className="mb-1 mt-4 text-sm font-semibold">{COPY.event.possibleMatches}</h3>
              <ul className="space-y-2">
                {detail.correlation.possibleMatches.map((match) => (
                  <li
                    key={match.primaryKey}
                    className="rounded-lg border border-dashed border-line p-3 text-sm text-fg-muted"
                  >
                    <SourceBadge sourceId={match.sourceId} />{' '}
                    <code className="font-mono text-xs">{match.primaryKey}</code>
                    {match.reasons.map((reason) => (
                      <p key={reason.code} className="mt-1">
                        {reason.text}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <section aria-labelledby="where-title" className="mt-6">
          <h2 id="where-title" className="mb-2 text-lg font-semibold">
            {COPY.event.geometry}
          </h2>
          <MapPanel
            compact
            styleUrl={mapStyle.url}
            center={headline.centroid}
            placeLabel={headline.title}
            features={eventMapFeatures(detail)}
            listAnchor="#facts-title"
          />
        </section>

        <section aria-labelledby="links-title" className="mt-6">
          <h2 id="links-title" className="mb-2 text-lg font-semibold">
            {COPY.event.officialLinks}
          </h2>
          <ul className="space-y-1 text-sm">
            {detail.observations
              .filter((observation) => observation.sourceUrl !== null)
              .map((observation) => (
                <li key={observation.evidenceId}>
                  <a
                    href={observation.sourceUrl ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center md:min-h-0"
                  >
                    {sourceName(observation.sourceId)} —{' '}
                    {observation.title ?? observation.primaryKey}
                  </a>
                </li>
              ))}
            {tsunami?.value.kind === 'boolean' && tsunami.value.value ? (
              <li>
                <a href="https://www.tsunami.gov/" target="_blank" rel="noopener noreferrer">
                  tsunami.gov
                </a>
              </li>
            ) : null}
          </ul>
        </section>

        <section aria-labelledby="evidence-title" className="mt-6">
          <h2 id="evidence-title" className="mb-2 text-lg font-semibold">
            {COPY.evidence.title}
          </h2>
          <ul className="space-y-1 text-sm">
            {detail.evidenceManifest.map((item) => (
              <li key={item.id} className="text-fg-muted">
                <span className="font-semibold text-fg">{COPY.evidence.kinds[item.kind]}</span> —{' '}
                {item.summary}
                <EvidenceButton ids={[item.id]} />
              </li>
            ))}
          </ul>
        </section>
      </main>
    </EvidenceProvider>
  );
}
