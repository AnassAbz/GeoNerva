/**
 * The situation strip (docs/PRODUCT.md §6.2 row 2): "Is something meaningful happening, and how
 * sure are we?" One headline sentence, the overall data-confidence chip with its reasons behind a
 * tap-operable Why?, and the coverage line. When a relevant source is STALE or UNAVAILABLE the
 * strip says so first.
 *
 * The overall confidence is the lowest confidence among the families GeoNerva could describe;
 * the read model has no single overall confidence, and taking the minimum never overstates it.
 */

import type {
  BriefingCopy,
  DataConfidenceLevel,
  FamilyCard,
  HazardFamily,
  Reason,
  SnapshotOverall,
} from '@geonerva/domain';

import { COPY } from '../lib/view/copy.ts';
import { FAMILY_ORDER } from '../lib/view/families.ts';
import { EvidenceButton } from './evidence.tsx';
import { ConfidenceBadge } from './ui/badges.tsx';
import { WhyPopover } from './why-popover.tsx';

const CONFIDENCE_RANK: Readonly<Record<DataConfidenceLevel, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
};

export function overallConfidence(families: Readonly<Record<HazardFamily, FamilyCard>>): {
  readonly level: DataConfidenceLevel;
  readonly reasons: readonly Reason[];
} {
  const described = FAMILY_ORDER.map((family) => families[family]).filter(
    (card) => card.availability !== 'NOT_COVERED',
  );
  if (described.length === 0) return { level: 'LOW', reasons: [] };
  const level = described.reduce<DataConfidenceLevel>(
    (lowest, card) =>
      CONFIDENCE_RANK[card.dataConfidence.level] < CONFIDENCE_RANK[lowest]
        ? card.dataConfidence.level
        : lowest,
    'HIGH',
  );
  const seen = new Set<string>();
  const reasons = described
    .filter((card) => card.dataConfidence.level === level)
    .flatMap((card) => card.dataConfidence.reasons)
    .filter((reason) => {
      if (seen.has(reason.text)) return false;
      seen.add(reason.text);
      return true;
    });
  return { level, reasons };
}

export function SituationStrip({
  overall,
  copy,
  families,
}: {
  readonly overall: SnapshotOverall;
  readonly copy: Pick<BriefingCopy, 'headline' | 'summary'>;
  readonly families: Readonly<Record<HazardFamily, FamilyCard>>;
}) {
  const confidence = overallConfidence(families);
  const degraded = overall.unavailableFamilies.length > 0;
  return (
    <section
      aria-labelledby="situation-title"
      className="rounded-lg border border-line bg-surface p-4"
    >
      <h2 id="situation-title" className="sr-only">
        {COPY.situation.title}
      </h2>
      {degraded ? (
        <p
          role="status"
          className="mb-3 flex items-start gap-2 rounded border border-stale/60 bg-stale/10 px-3 py-2 text-sm font-semibold text-stale"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            className="mt-0.5 shrink-0"
          >
            <path d="M8 1.5 15 14H1Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7.25 6h1.5v4h-1.5Zm0 5h1.5v1.5h-1.5Z" fill="currentColor" />
          </svg>
          {COPY.situation.degraded}
        </p>
      ) : null}
      <p className="text-lg font-semibold leading-snug text-fg md:text-xl">
        {copy.headline}
        <EvidenceButton ids={overall.evidenceIds} />
      </p>
      {copy.summary.length > 0 ? (
        <div className="mt-2 space-y-1 text-sm text-fg-muted">
          {copy.summary.map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ConfidenceBadge level={confidence.level} />
        {confidence.reasons.length > 0 ? (
          <WhyPopover subject={COPY.situation.confidence} reasons={confidence.reasons} />
        ) : null}
      </div>
      <p className="mt-3 text-sm text-fg-muted">{overall.coverageStatement}</p>
    </section>
  );
}
