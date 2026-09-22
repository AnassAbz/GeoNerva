/**
 * A hazard family card (docs/PRODUCT.md §6.3):
 *
 *   STATUS · CHANGE · CONTEXT · RELEVANCE · SOURCES, with data dots and confidence,
 *
 * and its three explicit empty states — Unavailable, Not covered, Insufficient history — none of
 * which ever renders a count (invariant I11: an unavailable source is never "0").
 *
 * Registers (§6.4): provider values appear as plain text with a source badge; GeoNerva's
 * derivations (context, relevance, changes) carry the Derived tag and a Why?.
 */

import type {
  BaselineMetricView,
  ChangeSignalView,
  ChangeWindow,
  FamilyCard,
  RelevanceLevel,
  SubjectSummary,
} from '@geonerva/domain';
import type { ReactNode } from 'react';

import { COPY } from '../lib/view/copy.ts';
import { FAMILY_META } from '../lib/view/families.ts';
import { WINDOW_LABEL, formatDistanceKm, formatFactValue } from '../lib/view/format.ts';
import { subjectHref } from '../lib/view/routes.ts';
import { unavailableStatement } from '../lib/view/sources.ts';
import { CardDisclosure } from './card-disclosure.tsx';
import { EvidenceButton } from './evidence.tsx';
import {
  ConfidenceBadge,
  DerivedTag,
  RelevanceBadge,
  SourceBadge,
  SourceDot,
} from './ui/badges.tsx';
import { FamilyGlyph } from './ui/shape.tsx';
import { WhyPopover } from './why-popover.tsx';

const RELEVANCE_RANK: Readonly<Record<RelevanceLevel, number>> = {
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** The item the card leads with: highest relevance, then nearest. */
export function leadItem(items: readonly SubjectSummary[]): SubjectSummary | undefined {
  return [...items].sort(
    (a, b) =>
      RELEVANCE_RANK[b.relevance.level] - RELEVANCE_RANK[a.relevance.level] ||
      a.distanceKm - b.distanceKm,
  )[0];
}

export interface HazardCardProps {
  readonly card: FamilyCard;
  /** `copy.byFamily[family]` from the briefing, rendered verbatim. */
  readonly statusLines: readonly string[];
  /** This family's headline and listed changes in the window. */
  readonly changes: readonly ChangeSignalView[];
  readonly window: ChangeWindow;
  readonly now: string;
  readonly timeZone: string;
  readonly placeSlug?: string;
  readonly defaultOpen?: boolean;
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-line py-2 first:border-t-0 sm:grid-cols-[6.5rem_1fr] sm:gap-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className="min-w-0 text-sm text-fg">{children}</dd>
    </div>
  );
}

function ContextRow({ metric }: { readonly metric: BaselineMetricView }) {
  const reasons = [
    {
      code: metric.metricCode,
      text: metric.interpretation,
      params: {},
      evidenceIds: metric.evidenceIds,
    },
  ];
  const insufficient = metric.status === 'INSUFFICIENT_HISTORY';
  return (
    <div data-metric-status={metric.status}>
      {insufficient ? (
        <p className="font-medium">{COPY.card.insufficientHistory}</p>
      ) : (
        <p>
          {metric.interpretation}
          {metric.status === 'OK' && metric.percentile !== null ? (
            <span className="ml-1 text-fg-muted">
              ({COPY.card.percentile(Math.round(metric.percentile))})
            </span>
          ) : null}
        </p>
      )}
      {insufficient && metric.interpretation !== COPY.card.insufficientHistory ? (
        <p className="mt-1 text-fg-muted">{metric.interpretation}</p>
      ) : null}
      {metric.caveats.map((caveat) => (
        <p key={caveat} className="mt-1 text-fg-muted">
          {caveat}
        </p>
      ))}
      <p className="mt-1 flex flex-wrap items-center gap-2">
        <DerivedTag />
        <WhyPopover
          subject={`${COPY.card.context}: ${metric.label}`}
          reasons={reasons}
          caveats={metric.caveats}
          evidenceIds={[metric.id, ...metric.evidenceIds]}
          modelVersion={metric.methodVersion}
        />
      </p>
    </div>
  );
}

function SourcesRow({
  item,
  timeZone,
}: {
  readonly item: SubjectSummary;
  readonly timeZone: string;
}) {
  const agreement = item.agreement;
  const magnitude = agreement?.comparisons.find((comparison) => comparison.code === 'magnitude');
  const magnitudeType = agreement?.comparisons.find(
    (comparison) => comparison.code === 'magnitude_type',
  );
  const evidence = [
    ...new Set(
      agreement?.comparisons.flatMap((c) => c.values.map((v) => v.evidenceId)) ?? item.evidenceIds,
    ),
  ];
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {magnitude === undefined
        ? item.facts.slice(0, 1).map((fact) => (
            <span key={fact.code}>
              {fact.label}: {formatFactValue(fact.value, timeZone)}
            </span>
          ))
        : magnitude.values.map((value) => {
            const type = magnitudeType?.values.find((entry) => entry.sourceId === value.sourceId);
            return (
              <span
                key={`${value.sourceId}:${value.evidenceId}`}
                className="inline-flex items-center gap-1"
              >
                <SourceBadge sourceId={value.sourceId} />
                <span className="tabular">
                  {type === undefined ? '' : `${formatFactValue(type.value)} `}
                  {formatFactValue(value.value)}
                </span>
              </span>
            );
          })}
      {agreement === null ? null : (
        <span className="text-fg-muted">
          · {COPY.card.agreement}: {COPY.agreement[agreement.level]} ·{' '}
          {COPY.card.independent(agreement.nIndependentSources, agreement.nSources)}
        </span>
      )}
      <EvidenceButton ids={evidence} label={COPY.evidence.open} />
    </p>
  );
}

export function HazardCard({
  card,
  statusLines,
  changes,
  window,
  now,
  timeZone,
  placeSlug,
  defaultOpen = false,
}: HazardCardProps) {
  const meta = FAMILY_META[card.family];
  const headingId = `card-${card.family.toLowerCase()}`;
  const lead = leadItem(card.items);
  const metric = card.metrics[0];

  let summary: ReactNode;
  let body: ReactNode;

  if (card.availability === 'NOT_COVERED') {
    summary = COPY.families.notCoveredTitle;
    body = (
      <div data-state="not-covered">
        <p className="font-medium">
          {COPY.card.notCovered(meta.words.charAt(0).toUpperCase() + meta.words.slice(1))}
        </p>
        {card.coverage.note === null ? null : (
          <p className="mt-1 text-sm text-fg-muted">{card.coverage.note}</p>
        )}
      </div>
    );
  } else if (card.availability === 'UNAVAILABLE') {
    const statement = unavailableStatement(card.family, card.sourceHealth, now);
    summary = COPY.families.unavailableTitle;
    body = (
      <div data-state="unavailable">
        <p className="font-medium text-stale">{statement.title}</p>
        <p className="mt-1 text-sm text-fg">{statement.detail}</p>
        {card.dataConfidence.reasons.map((reason) => (
          <p key={reason.code} className="mt-1 text-sm text-fg-muted">
            {reason.text}
            <EvidenceButton ids={reason.evidenceIds} />
          </p>
        ))}
        {card.caveats.map((caveat) => (
          <p key={caveat} className="mt-1 text-xs text-fg-subtle">
            {caveat}
          </p>
        ))}
      </div>
    );
  } else {
    summary =
      lead === undefined ? COPY.card.noItems : <RelevanceBadge level={lead.relevance.level} />;
    const firstChange = changes[0];
    const href = lead === undefined ? null : subjectHref(lead.subjectRef, placeSlug);
    body = (
      <dl data-state="available">
        <Row label={COPY.card.status}>
          {statusLines.map((line) => (
            <p key={line} className="first:text-fg [&:not(:first-child)]:text-fg-muted">
              {line}
            </p>
          ))}
        </Row>
        <Row label={COPY.card.change}>
          {firstChange === undefined ? (
            <p className="text-fg-muted">{COPY.card.noChange}</p>
          ) : (
            <p>
              <span className="tabular font-semibold">
                {COPY.card.changeCount(changes.length, WINDOW_LABEL[window])}
              </span>
              {' — '}
              {firstChange.title}
              <EvidenceButton ids={[firstChange.id, ...firstChange.evidenceIds]} />
            </p>
          )}
        </Row>
        <Row label={COPY.card.context}>
          {metric === undefined ? (
            <p className="text-fg-muted">{COPY.card.insufficientHistory}</p>
          ) : (
            <ContextRow metric={metric} />
          )}
        </Row>
        {lead === undefined ? null : (
          <Row label={COPY.card.relevance}>
            <p className="flex flex-wrap items-center gap-2">
              <RelevanceBadge level={lead.relevance.level} />
              <span className="tabular">
                {formatDistanceKm(lead.distanceKm)} {COPY.card.km}
              </span>
              {href === null ? (
                <span>{lead.title}</span>
              ) : (
                <a href={href} className="min-w-0 break-words">
                  {lead.title}
                </a>
              )}
            </p>
            {lead.relevance.caveats.map((caveat) => (
              <p key={caveat} className="mt-1 text-xs text-fg-muted">
                {caveat}
              </p>
            ))}
            <p className="mt-1 flex flex-wrap items-center gap-2">
              <DerivedTag />
              <WhyPopover
                subject={`${COPY.card.relevance}: ${lead.title}`}
                reasons={lead.relevance.reasons}
                caveats={lead.relevance.caveats}
                evidenceIds={lead.relevance.evidenceIds}
                modelVersion={lead.relevance.modelVersion}
              />
            </p>
          </Row>
        )}
        {lead === undefined ? null : (
          <Row label={COPY.card.sources}>
            <SourcesRow item={lead} timeZone={timeZone} />
          </Row>
        )}
      </dl>
    );
  }

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-lg border border-line bg-surface p-4"
      data-family={card.family}
      data-availability={card.availability}
    >
      <CardDisclosure
        headingId={headingId}
        defaultOpen={defaultOpen}
        summary={summary}
        title={
          <>
            <FamilyGlyph shape={meta.shape} pattern={meta.pattern} color={meta.color} />
            <span className="uppercase tracking-wide">{meta.label}</span>
          </>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
            {COPY.card.data}
          </span>
          {card.sourceHealth.map((health) => (
            <SourceDot
              key={`${health.sourceId}:${String(health.productId)}`}
              sourceId={health.sourceId}
              status={health.status}
            />
          ))}
          <span className="flex items-center gap-1">
            <ConfidenceBadge level={card.dataConfidence.level} />
            {card.dataConfidence.reasons.length > 0 && card.availability === 'AVAILABLE' ? (
              <WhyPopover
                subject={`${COPY.situation.confidence}: ${meta.label}`}
                reasons={card.dataConfidence.reasons}
              />
            ) : null}
          </span>
        </div>
        {body}
      </CardDisclosure>
    </article>
  );
}
