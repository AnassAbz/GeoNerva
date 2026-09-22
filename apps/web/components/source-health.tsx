/**
 * Source health rows (docs/PRODUCT.md §6.7): status chip with a text label, last successful poll
 * against the expected cadence, newest observation against the expected latency, last error.
 */

import type { Attribution, SourceHealthView } from '@geonerva/domain';

import { COPY } from '../lib/view/copy.ts';
import { formatAgo, formatDuration } from '../lib/view/format.ts';
import { ERROR_CLASS_LABEL, sourceName } from '../lib/view/sources.ts';
import { EvidenceButton } from './evidence.tsx';
import { StatusChip } from './ui/badges.tsx';

export function HealthFacts({
  health,
  now,
}: {
  readonly health: SourceHealthView;
  readonly now: string;
}) {
  const { expected } = health;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      <dt className="text-fg-subtle">{COPY.sources.lastPoll}</dt>
      <dd className="tabular">
        {health.lastSuccessAt === null ? COPY.sources.never : formatAgo(health.lastSuccessAt, now)}{' '}
        <span className="text-fg-muted">
          ({COPY.sources.expectedCadence(formatDuration(expected.pollIntervalS))})
        </span>
      </dd>
      <dt className="text-fg-subtle">{COPY.sources.newest}</dt>
      <dd className="tabular">
        {health.newestObservedAt === null
          ? COPY.sources.never
          : formatAgo(health.newestObservedAt, now)}
        {expected.dataCurrentWithinS === null ? null : (
          <span className="text-fg-muted">
            {' '}
            ({COPY.sources.expectedLatency(formatDuration(expected.dataCurrentWithinS))})
          </span>
        )}
      </dd>
      <dt className="text-fg-subtle">{COPY.sources.lastError}</dt>
      <dd>
        {health.lastErrorClass === null
          ? COPY.sources.none
          : ERROR_CLASS_LABEL[health.lastErrorClass]}
        {health.evidenceId === null ? null : <EvidenceButton ids={[health.evidenceId]} />}
      </dd>
    </dl>
  );
}

export function SourceHealthList({
  sourceHealth,
  now,
}: {
  readonly sourceHealth: readonly SourceHealthView[];
  readonly now: string;
}) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
      {sourceHealth.map((health) => (
        <li
          key={`${health.sourceId}:${String(health.productId)}`}
          className="p-3"
          data-source={health.sourceId}
        >
          <p className="mb-2 flex flex-wrap items-center gap-2 font-semibold">
            {sourceName(health.sourceId)}
            <StatusChip status={health.status} />
          </p>
          <HealthFacts health={health} now={now} />
        </li>
      ))}
    </ul>
  );
}

export function AttributionList({ attribution }: { readonly attribution: readonly Attribution[] }) {
  return (
    <ul className="space-y-2 text-xs text-fg-muted">
      {attribution.map((entry) => (
        <li key={entry.sourceId}>
          <span className="font-semibold text-fg">{entry.name}</span> — {entry.attributionText}{' '}
          <span className="text-fg-subtle">
            ({COPY.sources.licence}: {entry.licence})
          </span>
          {entry.disclaimer === null ? null : <span className="block">{entry.disclaimer}</span>}
        </li>
      ))}
    </ul>
  );
}
