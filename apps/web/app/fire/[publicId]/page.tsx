/**
 * `/fire/[publicId]` — fire activity cluster detail. The cluster is built from satellite thermal
 * detections; the mandatory caveat is always shown first, and nothing on the page calls it a
 * confirmed fire (docs/PRODUCT.md §7, ADR-020).
 *
 * ### When the members cannot be verified (ADR-039, Proposed and binding while Proposed)
 *
 * A cluster's summary versions are clean facts at a knowledge time. Its *member* detections are
 * not: `fire_detections.cluster_id` is written in place at assignment and rewritten on merge, with
 * no record of when. So the read model rebuilds the member set from the present and accepts it
 * only when its size equals the version's `n_total` — the one count that is a fact at that
 * knowledge time. When it does not match, the builder withholds the sample and the daily counts
 * and sets `truncated: true`, and `total` stays the version's own count.
 *
 * This page renders that withholding as a withholding. It says which figure it still stands behind
 * (the version's count), what it is not showing (the per-day counts and the individual
 * detections), and why — because the alternative, a plausible subset presented as the cluster, is
 * the replay leak in its most convincing form.
 *
 * ### The map draws no detections, at any zoom
 *
 * `fireMapFeatures` emits one `fire_cluster` feature for the centroid and nothing else. ADR-039
 * forbids emitting a `fire_detection` feature for the same reason: a detection's only possible
 * subject is its cluster, and that membership is not knowable as of a past time. Nothing is added
 * here at zoom ≥ 8, which leaves docs/PRODUCT.md §6.5's "detections at zoom ≥ 8" stale pending the
 * owner's decision on ADR-039 — a documentation gap, not a silent omission: the map never claims
 * to show detections.
 */

import type { FireClusterDetail } from '@geonerva/domain';
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
  const withheld = detectionsWithheld(detail.detections);

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

        <DetectionsByDaySection detections={detail.detections} />

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

        <DetectionSampleSection detections={detail.detections} timeZone={TIME_ZONE} />

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
            /*
             * The accessible substitute for the map. It must point at a list that is actually on
             * the page: with the members withheld there is no detection list, and the summary is
             * what carries every figure the centroid stands for.
             */
            listAnchor={withheld ? '#summary-title' : '#sample-title'}
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

type Detections = FireClusterDetail['detections'];

/**
 * True when the read model is **withholding** the cluster's members, rather than capping a sample.
 *
 * `truncated` alone cannot tell those apart: the builder sets it to `n_total > sample.length`,
 * which is equally true of a 900-detection cluster whose sample stopped at its cap of 500. The
 * distinguishing fact is that a withholding builder also empties `byDay`, and it does that in one
 * case only — the rebuilt member set did not match the version's `n_total` (ADR-039). Reading the
 * two signals together is what keeps a capped sample from being explained away as unverifiable,
 * and an unverifiable one from being shown as a sample.
 */
export function detectionsWithheld(detections: Detections): boolean {
  return detections.truncated && detections.sample.length === 0 && detections.byDay.length === 0;
}

/**
 * The withholding copy, local to this page while `lib/view/copy.ts` is owned elsewhere; it is the
 * established home for UI strings and these belong there.
 *
 * The sentence names the figure the page still stands behind, the two things it is not showing,
 * and the reason — in that order, because a reader who stops after the first line should still
 * have been told the count is sound and the list is missing.
 */
const WITHHELD = {
  heading: 'The individual detections cannot be verified for this cluster',
  body: (total: string) =>
    `GeoNerva counted ${total} thermal detections in this cluster at the knowledge time of the summary above, and that is the figure it stands behind. It cannot confirm which individual detections made up that count: a detection’s membership of a cluster is stored without the time it was decided, so a list rebuilt from today’s records need not be the list the summary counted. Rather than show part of the cluster as though it were the whole of it, the per-day counts and the sample of detections are left out here.`,
  sample: 'No individual detections are listed for this cluster.',
  why: 'Why these are not listed',
} as const;

/** Thermal detections per day — or the reason there are none to show. */
export function DetectionsByDaySection({ detections }: { readonly detections: Detections }) {
  return (
    <section aria-labelledby="byday-title" className="mt-6">
      <h2 id="byday-title" className="mb-2 text-lg font-semibold">
        {COPY.fire.byDay}
      </h2>
      {detectionsWithheld(detections) ? (
        <div
          id="detections-withheld"
          className="rounded-lg border border-line bg-surface p-3 text-sm"
        >
          <p className="font-medium">{WITHHELD.heading}</p>
          <p className="mt-1 text-fg-muted">{WITHHELD.body(formatNumber(detections.total, 0))}</p>
        </div>
      ) : (
        <ul className="space-y-1 text-sm">
          {detections.byDay.map((day) => (
            <li key={day.day} className="tabular">
              {day.day}:{' '}
              {day.hasSatelliteCoverage ? formatNumber(day.count, 0) : COPY.fire.noCoverage}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A sample of the cluster's detections — or, when the member set could not be verified, a line
 * saying none is listed and a link to the explanation above. The section keeps its heading and its
 * citation either way: the detection-set evidence id still names the count that *is* a fact.
 */
export function DetectionSampleSection({
  detections,
  timeZone,
}: {
  readonly detections: Detections;
  readonly timeZone: string;
}) {
  if (detectionsWithheld(detections)) {
    return (
      <section aria-labelledby="sample-title" className="mt-6">
        <h2 id="sample-title" className="mb-2 text-lg font-semibold">
          {COPY.fire.sample}
        </h2>
        <p className="text-sm text-fg-muted">
          {WITHHELD.sample}{' '}
          <a href="#detections-withheld" className="inline-flex min-h-11 items-center text-sm">
            {WITHHELD.why}
          </a>
          <EvidenceButton ids={[detections.evidenceId]} />
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="sample-title" className="mt-6">
      <h2 id="sample-title" className="mb-2 text-lg font-semibold">
        {COPY.fire.sample}
      </h2>
      <p className="mb-2 text-sm text-fg-muted">
        {COPY.fire.sampleNote(detections.sample.length, detections.total)}
        <EvidenceButton ids={[detections.evidenceId]} />
      </p>
      <ul className="space-y-1 text-sm">
        {detections.sample.map((detection) => (
          <li
            key={`${detection.acquiredAt}:${String(detection.lat)}:${String(detection.lon)}`}
            className="tabular text-fg-muted"
          >
            {formatDateTime(detection.acquiredAt, timeZone)} UTC · {detection.lat.toFixed(4)},{' '}
            {detection.lon.toFixed(4)} · {detection.confidence.class}
            {detection.frpMw === null ? null : <> · {formatNumber(detection.frpMw, 1)} MW</>}
          </li>
        ))}
      </ul>
    </section>
  );
}
