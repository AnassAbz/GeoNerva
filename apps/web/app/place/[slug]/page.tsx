/**
 * `/place/[slug]` — the location intelligence dashboard (docs/PRODUCT.md §6.2).
 *
 * Regions, in the order of the questions they answer: header → situation → What Changed →
 * family cards → map → nearby list → historical context → sources & evidence. Desktop (≥ 1024 px)
 * is two columns with a sticky map on the right; mobile is one column in that order.
 */

import type { HazardFamily, SubjectSummary } from '@geonerva/domain';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EvidenceButton, EvidenceProvider } from '../../../components/evidence.tsx';
import { HazardCard, leadItem } from '../../../components/hazard-card.tsx';
import { HistoryChart } from '../../../components/history-chart.tsx';
import { MapPanel } from '../../../components/map/map-panel.tsx';
import { NearbyTable, type NearbyRow } from '../../../components/nearby-table.tsx';
import { ReplayBanner } from '../../../components/replay-banner.tsx';
import { SituationStrip } from '../../../components/situation-strip.tsx';
import { AttributionList, SourceHealthList } from '../../../components/source-health.tsx';
import { WhatChanged, type SubjectContext } from '../../../components/what-changed.tsx';
import { parseMapStyleUrl } from '../../../lib/map-style.ts';
import { COPY } from '../../../lib/view/copy.ts';
import {
  getBriefing,
  getEvidenceDetails,
  getHistories,
  getMapFeatures,
  getNow,
} from '../../../lib/view/data.ts';
import { FAMILY_ORDER } from '../../../lib/view/families.ts';
import { WINDOW_LABEL, formatAgo, formatClock } from '../../../lib/view/format.ts';
import {
  PAGE_WINDOWS,
  parseAsOfParam,
  parseWindowParam,
  type SearchParams,
} from '../../../lib/view/query.ts';
import { placeHref, subjectHref } from '../../../lib/view/routes.ts';

interface PageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<SearchParams>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const briefing = await getBriefing(slug, { window: '24h' });
  return { title: briefing === null ? 'GeoNerva' : `${briefing.location.label} — GeoNerva` };
}

function isHighOrAbove(item: SubjectSummary): boolean {
  return item.relevance.level === 'HIGH' || item.relevance.level === 'CRITICAL';
}

export default async function PlacePage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const search = await searchParams;
  const now = await getNow();
  const window = parseWindowParam(search['window']);
  const asOf = parseAsOfParam(search['as_of'], now);
  const query = { window, ...(asOf === undefined ? {} : { asOf }) };

  const [briefing, histories] = await Promise.all([
    getBriefing(slug, query),
    getHistories(slug, query),
  ]);
  if (briefing === null) notFound();

  const { location, snapshot, changes } = briefing;
  /*
   * After the briefing rather than beside it: a viewport needs the location's coordinates, and
   * only the briefing has resolved them (`lib/view/data.ts`, note 3). The evidence details are
   * bounded there too, and keyed off the manifest this response carried.
   */
  const [mapFeatures, evidenceDetails] = await Promise.all([
    getMapFeatures(location, asOf === undefined ? {} : { asOf }),
    getEvidenceDetails(
      briefing.evidenceManifest.map((item) => item.id),
      asOf === undefined ? {} : { asOf },
    ),
  ]);
  const timeZone = location.timezone;
  const families = snapshot.families;
  const mapStyle = parseMapStyleUrl(process.env['MAP_STYLE_URL']);

  const allItems = FAMILY_ORDER.flatMap((family) => families[family].items);
  const dataAsOf = Object.values(briefing.asOfContext.sourceCutoffs)
    .filter((cutoff): cutoff is string => cutoff !== null)
    .sort()
    .at(-1);

  const subjects: Record<string, SubjectContext> = {};
  for (const item of allItems) {
    subjects[item.subjectRef] = {
      relevance: item.relevance.level,
      href: subjectHref(item.subjectRef, slug),
      timeLabel: formatAgo(item.observedAt, now),
    };
  }

  const nearby: NearbyRow[] = allItems.map((item) => ({
    id: item.subjectRef,
    title: item.title,
    href: subjectHref(item.subjectRef, slug),
    family: item.family,
    level: item.relevance.level,
    distanceKm: item.distanceKm,
    observedAt: item.observedAt,
    timeLabel: formatAgo(item.observedAt, now),
    sourceCount: item.agreement?.nSources ?? 1,
  }));

  const expandedFamily: HazardFamily | undefined = FAMILY_ORDER.find((family) => {
    const lead = leadItem(families[family].items);
    return lead !== undefined && isHighOrAbove(lead);
  });

  const visibleChanges = [...changes.headline, ...changes.listed];
  const exitHref = placeHref(slug, { window });

  return (
    <EvidenceProvider
      manifest={briefing.evidenceManifest}
      details={evidenceDetails}
      timeZone={timeZone}
    >
      {briefing.asOfContext.isReplay ? (
        <ReplayBanner asOf={briefing.asOfContext.asOf} exitHref={exitHref} />
      ) : null}
      <main id="main" className="mx-auto max-w-7xl px-4 pb-8">
        <header className="border-b border-line py-4">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{location.label}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-fg-muted">
            <p>
              {COPY.header.localTime}{' '}
              <time dateTime={now} className="tabular text-fg">
                {formatClock(asOf ?? now, timeZone)}
              </time>
            </p>
            {dataAsOf === undefined ? null : (
              <p>
                {COPY.header.dataAsOf}{' '}
                <time dateTime={dataAsOf} className="tabular text-fg">
                  {formatClock(dataAsOf, timeZone)} local
                </time>
                {asOf === undefined ? <> · {formatAgo(dataAsOf, now)}</> : null}
              </p>
            )}
            <nav aria-label={COPY.header.windowLabel} className="flex items-center gap-1">
              <span className="mr-1">{COPY.header.windowLabel}</span>
              {PAGE_WINDOWS.map((option) => (
                <a
                  key={option}
                  href={placeHref(slug, {
                    window: option,
                    ...(asOf === undefined ? {} : { asOf }),
                  })}
                  aria-current={option === window ? 'page' : undefined}
                  className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded border px-2 no-underline md:min-h-8 ${
                    option === window
                      ? 'border-link bg-raised font-semibold text-fg'
                      : 'border-line text-fg-muted hover:text-fg'
                  }`}
                >
                  {WINDOW_LABEL[option]}
                </a>
              ))}
            </nav>
          </div>
        </header>

        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-5 lg:col-start-1">
            <SituationStrip overall={snapshot.overall} copy={briefing.copy} families={families} />
          </div>

          <section aria-labelledby="changes-title" className="lg:col-span-5 lg:col-start-1">
            <h2 id="changes-title" className="mb-2 text-lg font-semibold">
              {COPY.changes.title}{' '}
              <span className="text-sm font-normal text-fg-muted">· {WINDOW_LABEL[window]}</span>
            </h2>
            <div className="rounded-lg border border-line bg-surface px-4 py-1">
              <WhatChanged
                section={changes}
                subjects={subjects}
                timeZone={timeZone}
                fallbackTimeLabel={formatAgo(changes.toAsOf, now)}
              />
            </div>
          </section>

          <section aria-label="Hazard families" className="space-y-3 lg:col-span-5 lg:col-start-1">
            {FAMILY_ORDER.map((family) => (
              <HazardCard
                key={family}
                card={families[family]}
                statusLines={briefing.copy.byFamily[family]}
                changes={visibleChanges.filter((change) => change.family === family)}
                window={window}
                now={now}
                timeZone={timeZone}
                placeSlug={slug}
                defaultOpen={family === expandedFamily}
              />
            ))}
          </section>

          <section
            aria-labelledby="map-title"
            className="lg:col-span-7 lg:col-start-6 lg:row-span-6 lg:row-start-1"
          >
            <div className="lg:sticky lg:top-4">
              <h2 id="map-title" className="mb-2 text-lg font-semibold">
                {COPY.map.title}
              </h2>
              <MapPanel
                styleUrl={mapStyle.url}
                center={{ lat: location.lat, lon: location.lon }}
                placeLabel={location.label}
                placeSlug={slug}
                features={mapFeatures?.features ?? []}
              />
            </div>
          </section>

          <section
            id="nearby"
            aria-labelledby="nearby-title"
            className="lg:col-span-5 lg:col-start-1"
          >
            <h2 id="nearby-title" className="mb-2 text-lg font-semibold">
              {COPY.nearby.title}
            </h2>
            <NearbyTable rows={nearby} />
          </section>

          <section aria-labelledby="history-title" className="lg:col-span-5 lg:col-start-1">
            <h2 id="history-title" className="mb-2 text-lg font-semibold">
              {COPY.history.title}
            </h2>
            <div className="space-y-3">
              {histories.map((history) => (
                <HistoryChart key={`${history.family}:${history.metricCode}`} history={history} />
              ))}
            </div>
          </section>

          <section aria-labelledby="sources-title" className="lg:col-span-5 lg:col-start-1">
            <h2 id="sources-title" className="mb-2 text-lg font-semibold">
              {COPY.sources.title}
            </h2>
            <SourceHealthList sourceHealth={snapshot.sourceHealth} now={now} />
            <p className="mt-3 flex items-center gap-2 text-sm">
              {COPY.sources.evidenceList}
              <EvidenceButton
                ids={briefing.evidenceManifest.map((item) => item.id)}
                label={COPY.evidence.openCount(briefing.evidenceManifest.length)}
              />
            </p>
            <div className="mt-3">
              <h3 className="mb-1 text-sm font-semibold">{COPY.sources.attribution}</h3>
              <AttributionList attribution={briefing.attribution} />
            </div>
          </section>
        </div>
      </main>
    </EvidenceProvider>
  );
}
