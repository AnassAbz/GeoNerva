/**
 * `/data-status` — source health, cadence, latency, recent runs and attribution
 * (docs/PRODUCT.md §6.7). This is where "no data" and "no hazard" are told apart publicly.
 */

import type { Metadata } from 'next';

import { EvidenceProvider } from '../../components/evidence.tsx';
import { HealthFacts } from '../../components/source-health.tsx';
import { RunStrip } from '../../components/run-strip.tsx';
import { StatusChip } from '../../components/ui/badges.tsx';
import { COPY } from '../../lib/view/copy.ts';
import { getNow, getSourceStatus } from '../../lib/view/data.ts';
import { HAZARD_LABEL, formatAgo, formatDateTime } from '../../lib/view/format.ts';

export const metadata: Metadata = { title: 'Data status — GeoNerva' };

const TIME_ZONE = 'UTC';

export default async function DataStatusPage() {
  const [status, now] = await Promise.all([getSourceStatus(), getNow()]);

  return (
    <EvidenceProvider manifest={status.evidenceManifest} timeZone={TIME_ZONE}>
      <main id="main" className="mx-auto max-w-5xl px-4 pb-8">
        <header className="border-b border-line py-4">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {COPY.dataStatus.title}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-fg-muted">{COPY.dataStatus.intro}</p>
        </header>

        <ul className="mt-6 space-y-4">
          {status.sources.map((source) => (
            <li
              key={source.sourceId}
              className="rounded-lg border border-line bg-surface p-4"
              data-source={source.sourceId}
            >
              <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                {source.name}
                <StatusChip status={source.health.status} />
                {source.enabled ? null : (
                  <span className="text-sm font-normal text-fg-muted">
                    {COPY.dataStatus.disabled}
                  </span>
                )}
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                {source.hazardTypes.map((type) => HAZARD_LABEL[type]).join(' · ')}
              </p>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                <HealthFacts health={source.health} now={now} />
                <div>
                  <p className="text-sm text-fg-subtle">{COPY.sources.runs}</p>
                  <RunStrip runs={source.recentRuns} />
                  <p className="mt-1 text-sm">
                    {source.successRate24h === null
                      ? COPY.sources.noRuns
                      : COPY.sources.runsSummary(
                          Math.round(source.successRate24h * source.runCount24h),
                          source.runCount24h,
                        )}
                  </p>
                </div>
              </div>
              {source.products.length > 1 ? (
                <div className="mt-3">
                  <p className="text-sm text-fg-subtle">{COPY.dataStatus.products}</p>
                  <ul className="mt-1 flex flex-wrap gap-2 text-sm">
                    {source.products.map((product) => (
                      <li
                        key={product.id}
                        className="flex items-center gap-2 rounded border border-line px-2 py-1"
                      >
                        <code className="font-mono text-xs">{product.code}</code>
                        <StatusChip status={product.health.status} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                {source.coverageNote === null ? null : (
                  <>
                    <dt className="text-fg-subtle">{COPY.sources.coverage}</dt>
                    <dd>{source.coverageNote}</dd>
                  </>
                )}
                <dt className="text-fg-subtle">{COPY.sources.attribution}</dt>
                <dd className="text-fg-muted">{source.attributionText}</dd>
                <dt className="text-fg-subtle">{COPY.sources.licence}</dt>
                <dd>
                  {source.termsUrl === null ? (
                    source.licence
                  ) : (
                    <a href={source.termsUrl} target="_blank" rel="noopener noreferrer">
                      {source.licence}
                    </a>
                  )}
                </dd>
                {source.disclaimer === null ? null : (
                  <>
                    <dt className="text-fg-subtle">{COPY.sources.disclaimer}</dt>
                    <dd className="text-fg-muted">{source.disclaimer}</dd>
                  </>
                )}
              </dl>
            </li>
          ))}
        </ul>

        <section aria-labelledby="worker-title" className="mt-8">
          <h2 id="worker-title" className="mb-2 text-lg font-semibold">
            {COPY.dataStatus.worker}
          </h2>
          {status.worker === null ? (
            <p className="text-sm text-fg-muted">{COPY.dataStatus.workerUnknown}</p>
          ) : (
            <p className="text-sm">
              {COPY.dataStatus.workerLastSeen}: {formatAgo(status.worker.lastSeenAt, now)}
              {status.worker.version === null ? null : (
                <span className="text-fg-muted"> · v{status.worker.version}</span>
              )}
            </p>
          )}
        </section>

        <section aria-labelledby="quality-title" className="mt-8">
          <h2 id="quality-title" className="mb-2 text-lg font-semibold">
            {COPY.dataStatus.dataQuality}
          </h2>
          {status.dataQuality.length === 0 ? (
            <p className="text-sm text-fg-muted">{COPY.dataStatus.noDataQuality}</p>
          ) : null}
          <ul className="space-y-2 text-sm">
            {status.dataQuality.map((check) => (
              <li
                key={check.code}
                className="rounded border border-line bg-surface p-3"
                data-check={check.status}
              >
                <p className="font-medium">
                  {check.label}: <span className="font-semibold">{check.status}</span>
                  {check.value === null ? null : (
                    <span className="tabular text-fg-muted">
                      {' '}
                      ({check.value}
                      {check.threshold === null ? '' : ` / ${String(check.threshold)}`})
                    </span>
                  )}
                </p>
                {check.detail === null ? null : <p className="text-fg-muted">{check.detail}</p>}
                <p className="tabular text-xs text-fg-subtle">
                  {formatDateTime(check.checkedAt, TIME_ZONE)} UTC
                </p>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </EvidenceProvider>
  );
}
