/**
 * `/fire/[publicId]` — fire activity cluster detail. The cluster is built from satellite thermal
 * detections; the mandatory caveat is always shown first, and nothing on the page calls it a
 * confirmed fire (docs/PRODUCT.md §7, ADR-020).
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EvidenceButton, EvidenceProvider } from '../../../components/evidence.tsx';
import { MapPanel } from '../../../components/map/map-panel.tsx';
import { DerivedTag, RelevanceBadge, SourceBadge } from '../../../components/ui/badges.tsx';
import { WhyPopover } from '../../../components/why-popover.tsx';
import { parseMapStyleUrl } from '../../../lib/map-style.ts';
import { COPY } from '../../../lib/view/copy.ts';
import { getFireCluster } from '../../../lib/view/data.ts';
import { fireMapFeatures, pointOf } from '../../../lib/view/detail-map.ts';
import { formatDateTime, formatDistanceKm, formatNumber } from '../../../lib/view/format.ts';
import { first, type SearchParams } from '../../../lib/view/query.ts';
import { placeHref } from '../../../lib/view/routes.ts';

interface PageProps {
  readonly params: Promise<{ publicId: string }>;
  readonly searchParams: Promise<SearchParams>;
}

const TIME_ZONE = 'UTC';

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { publicId } = await params;
  const detail = await getFireCluster(publicId);
  return {
    title: detail === null ? 'GeoNerva' : `Fire activity cluster ${detail.publicId} — GeoNerva`,
  };
}

export default async function FirePage({ params, searchParams }: PageProps) {
  const { publicId } = await params;
  const search = await searchParams;
  const placeSlug = first(search['place']);
  const detail = await getFireCluster(
    decodeURIComponent(publicId),
    placeSlug === undefined ? {} : { placeSlug },
  );
  if (detail === null) notFound();

  const { summary } = detail;
  const center = pointOf(detail.centroid) ?? { lat: 0, lon: 0 };
  const mapStyle = parseMapStyleUrl(process.env['MAP_STYLE_URL']);

  return (
    <EvidenceProvider manifest={detail.evidenceManifest} timeZone={TIME_ZONE}>
      <main id="main" className="mx-auto max-w-4xl px-4 pb-8">
        <header className="border-b border-line py-4">
          {placeSlug === undefined ? null : (
            <a href={placeHref(placeSlug)} className="inline-flex min-h-11 items-center text-sm">
              ← {COPY.event.backToPlace}
            </a>
          )}
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {COPY.fire.title} · <code className="font-mono">{detail.publicId}</code>
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            {COPY.event.status}: {COPY.fire.status[detail.status]}
          </p>
          <p
            role="note"
            className="mt-3 rounded border border-fire/50 bg-fire/10 px-3 py-2 text-sm text-fg"
          >
            {detail.mandatoryCaveat}
          </p>
        </header>

        <section aria-labelledby="summary-title" className="mt-6">
          <h2 id="summary-title" className="mb-2 text-lg font-semibold">
            {COPY.fire.summary}
          </h2>
          <dl className="grid gap-2 sm:grid-cols-2">
            {[
              [COPY.fire.detections24h, formatNumber(summary.detectionCount24h, 0)],
              [COPY.fire.overpasses, formatNumber(summary.distinctOverpasses24h, 0)],
              [COPY.fire.total, formatNumber(summary.detectionCountTotal, 0)],
              [
                COPY.fire.frp,
                summary.frpSum24h === null
                  ? COPY.event.notReported
                  : `${formatNumber(summary.frpSum24h, 1)} MW`,
              ],
              [
                COPY.fire.firstLast,
                `${formatDateTime(summary.firstDetectedAt, TIME_ZONE)} – ${formatDateTime(summary.lastDetectedAt, TIME_ZONE)} UTC`,
              ],
              [
                COPY.fire.sensors,
                summary.sensors
                  .map((sensor) =>
                    `${sensor.platform ?? sensor.code} ${sensor.instrument ?? ''}`.trim(),
                  )
                  .join(', '),
              ],
            ].map(([label, value]) => (
              <div key={label} className="rounded border border-line bg-surface px-3 py-2 text-sm">
                <dt className="text-xs text-fg-subtle">{label}</dt>
                <dd className="tabular">
                  {value} <SourceBadge sourceId="firms" />
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-sm">
            <EvidenceButton ids={summary.evidenceIds} label={COPY.evidence.open} />
          </p>
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
                {detail.nearestDetectionKm === null ? null : (
                  <span className="tabular">
                    {COPY.fire.nearestDetection}: {formatDistanceKm(detail.nearestDetectionKm)}
                  </span>
                )}
                <DerivedTag />
                <WhyPopover
                  subject={`${COPY.card.relevance}: ${detail.publicId}`}
                  reasons={detail.relevance.reasons}
                  caveats={detail.relevance.caveats}
                  evidenceIds={detail.relevance.evidenceIds}
                  modelVersion={detail.relevance.modelVersion}
                />
              </p>
            </div>
          )}
        </section>

        <section aria-labelledby="byday-title" className="mt-6">
          <h2 id="byday-title" className="mb-2 text-lg font-semibold">
            {COPY.fire.byDay}
          </h2>
          <ul className="space-y-1 text-sm">
            {detail.detections.byDay.map((day) => (
              <li key={day.day} className="tabular">
                {day.day}:{' '}
                {day.hasSatelliteCoverage ? formatNumber(day.count, 0) : COPY.fire.noCoverage}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="versions-title" className="mt-6">
          <h2 id="versions-title" className="mb-2 text-lg font-semibold">
            {COPY.fire.versions}
          </h2>
          <ol className="space-y-2">
            {detail.versions.map((version) => (
              <li
                key={version.clusterVersionId}
                className="rounded-lg border border-line bg-surface p-3 text-sm"
              >
                <p className="font-medium">
                  {version.summary}
                  <EvidenceButton ids={[version.evidenceId]} />
                </p>
                <p className="tabular text-xs text-fg-muted">
                  {formatDateTime(version.asOf, TIME_ZONE)} UTC
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="sample-title" className="mt-6">
          <h2 id="sample-title" className="mb-2 text-lg font-semibold">
            {COPY.fire.sample}
          </h2>
          <p className="mb-2 text-sm text-fg-muted">
            {COPY.fire.sampleNote(detail.detections.sample.length, detail.detections.total)}
            <EvidenceButton ids={[detail.detections.evidenceId]} />
          </p>
          <ul className="space-y-1 text-sm">
            {detail.detections.sample.map((detection) => (
              <li
                key={`${detection.acquiredAt}:${String(detection.lat)}:${String(detection.lon)}`}
                className="tabular text-fg-muted"
              >
                {formatDateTime(detection.acquiredAt, TIME_ZONE)} UTC · {detection.lat.toFixed(4)},{' '}
                {detection.lon.toFixed(4)} · {detection.confidence.class}
                {detection.frpMw === null ? null : <> · {formatNumber(detection.frpMw, 1)} MW</>}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="where-title" className="mt-6">
          <h2 id="where-title" className="mb-2 text-lg font-semibold">
            {COPY.event.geometry}
          </h2>
          <MapPanel
            compact
            styleUrl={mapStyle.url}
            center={center}
            placeLabel={detail.publicId}
            features={fireMapFeatures(detail)}
            listAnchor="#sample-title"
          />
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
