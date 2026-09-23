/**
 * A historical-context mini-chart (docs/PRODUCT.md §6.2 row 7) with honest states:
 *
 *  - `OK` — the series over the reference band (25th–75th percentile shaded, 90th as a line),
 *    the percentile statement and the caveats;
 *  - `RARE_ACTIVITY` — the rarity statement, never a percentile;
 *  - `INSUFFICIENT_HISTORY` — "Not enough history to establish a baseline.";
 *  - `INSUFFICIENT_COVERAGE` and `NOT_APPLICABLE` — the API's explanation, and no chart when
 *    there is no supportable series.
 *
 * A missing value is a gap with its reason, never a zero bar.
 */

import type { HistoryResponse, TimeSeriesPoint, TimeSeriesView } from '@geonerva/domain';

import { COPY } from '../lib/view/copy.ts';
import { FAMILY_META } from '../lib/view/families.ts';
import { formatDay, formatNumber } from '../lib/view/format.ts';
import { EvidenceButton } from './evidence.tsx';
import { DerivedTag } from './ui/badges.tsx';
import { WhyPopover } from './why-popover.tsx';

const WIDTH = 320;
const HEIGHT = 96;
const PAD = 4;

/**
 * True when the 25th–75th percentile band is wide enough to *be* a band.
 *
 * For a sparse count — an area with one earthquake in a typical 30-day window — `p25` and `p75`
 * are routinely the same number. Shading between them then draws a hairline rectangle and labels
 * it "Typical range", which is a range that is not a range (QA round 2, M-1). Half the reference
 * windows sitting on one value is a fact worth showing, so the value is drawn as a level and said
 * to be one instead.
 */
function bandHasWidth(bands: HistoryResponse['referenceBands']): boolean {
  return bands !== null && bands.p75 > bands.p25;
}

function shortDay(iso: string): string {
  return formatDay(iso, 'UTC');
}

function Bars({
  series,
  color,
  bands,
  label,
}: {
  readonly series: TimeSeriesView;
  readonly color: string;
  readonly bands: HistoryResponse['referenceBands'];
  readonly label: string;
}) {
  const points = series.points;
  const values = points.map((point) => point.value ?? 0);
  const max = Math.max(1, ...values, bands?.p95 ?? 0);
  const step = (WIDTH - PAD * 2) / Math.max(1, points.length);
  const y = (value: number) => HEIGHT - PAD - (value / max) * (HEIGHT - PAD * 2);
  const last = points.at(-1);
  const typical =
    bands === null
      ? ''
      : bandHasWidth(bands)
        ? `; typical range ${formatNumber(bands.p25, 0)} to ${formatNumber(bands.p75, 0)}`
        : `; typical level ${formatNumber(bands.p25, 0)}, with no range between the 25th and 75th percentiles`;
  const summary = `${label}. ${String(points.length)} periods; latest ${
    last?.value === null || last === undefined ? 'unknown' : formatNumber(last.value, 0)
  }${typical}.`;

  return (
    <svg
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      role="img"
      aria-label={summary}
      className="h-24 w-full"
      preserveAspectRatio="none"
    >
      {bands === null ? null : (
        <>
          {bandHasWidth(bands) ? (
            <rect
              x={PAD}
              y={y(bands.p75)}
              width={WIDTH - PAD * 2}
              height={y(bands.p25) - y(bands.p75)}
              fill="#e6edf3"
              opacity="0.1"
              data-band="range"
            />
          ) : (
            <line
              x1={PAD}
              x2={WIDTH - PAD}
              y1={y(bands.p25)}
              y2={y(bands.p25)}
              stroke="#e6edf3"
              strokeWidth="1"
              opacity="0.35"
              data-band="level"
            />
          )}
          <line
            x1={PAD}
            x2={WIDTH - PAD}
            y1={y(bands.p90)}
            y2={y(bands.p90)}
            stroke="#b3bfcc"
            strokeDasharray="4 3"
            strokeWidth="1"
          />
        </>
      )}
      {points.map((point, index) => {
        const x = PAD + index * step + step * 0.15;
        const w = step * 0.7;
        const current = index === points.length - 1;
        if (point.value === null) {
          return (
            <rect
              key={point.t}
              x={x}
              y={HEIGHT - PAD - 6}
              width={w}
              height={6}
              fill="none"
              stroke="#95a3b3"
              strokeDasharray="2 2"
              data-missing="true"
            />
          );
        }
        return (
          <rect
            key={point.t}
            x={x}
            y={y(point.value)}
            width={w}
            height={Math.max(point.value === 0 ? 1 : 2, HEIGHT - PAD - y(point.value))}
            fill={color}
            opacity={current ? 1 : 0.55}
          />
        );
      })}
    </svg>
  );
}

function Gaps({ points }: { readonly points: readonly TimeSeriesPoint[] }) {
  const gaps = points.filter((point) => point.value === null);
  if (gaps.length === 0) return null;
  return (
    <div className="mt-1 text-xs text-fg-muted">
      <p>{COPY.history.missingPoints}</p>
      <ul className="list-inside list-disc">
        {gaps.map((gap) => (
          <li key={gap.t}>
            {shortDay(gap.t)} — {gap.missingReason}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HistoryChart({ history }: { readonly history: HistoryResponse }) {
  const { metric } = history;
  const meta = FAMILY_META[history.family];
  const series = history.series[0];
  const headingId = `history-${history.family.toLowerCase()}-${history.metricCode.toLowerCase()}`;

  /*
   * The last whole day this metric's window includes, when the metric says it has one.
   *
   * `FIRE_TREND` ends its window two days back, because ADR-040 admits a day to
   * `fire_daily_counts` only once it is final. That is why "Not enough satellite coverage in the
   * last five weeks to compare fire activity here" can sit truthfully beside a card reporting a
   * live cluster of 14 thermal detections — the two read different stores over different periods
   * — and it is the one thing the page never said (QA round 2, L-8). The date is in the metric's
   * own `params`, so this states it rather than recomputing it.
   */
  const lastDayParam = metric.params['lastDay'];
  const lastDay =
    typeof lastDayParam === 'string' && !Number.isNaN(Date.parse(lastDayParam))
      ? lastDayParam
      : null;

  return (
    <figure
      aria-labelledby={headingId}
      className="rounded-lg border border-line bg-surface p-4"
      data-history-status={metric.status}
    >
      <figcaption>
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
          <span style={{ color: meta.color }}>{meta.label}</span>
          <span className="text-fg-muted">· {metric.label}</span>
        </h3>
        <p className="mt-1 text-xs uppercase tracking-wide text-fg-subtle">
          {COPY.history.status[metric.status]}
        </p>
      </figcaption>

      {metric.status === 'INSUFFICIENT_HISTORY' ? (
        <p className="mt-2 font-medium">{COPY.card.insufficientHistory}</p>
      ) : null}

      {series !== undefined && series.points.length > 0 ? (
        <div className="mt-2">
          <Bars
            series={series}
            color={meta.color}
            bands={history.referenceBands}
            label={series.label}
          />
          {history.referenceBands === null ? null : (
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-fg-muted">
              <span>
                {bandHasWidth(history.referenceBands) ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="mr-1 inline-block h-2 w-3 bg-fg/10 align-middle"
                    />
                    {COPY.history.referenceBand}
                  </>
                ) : (
                  <>
                    <span
                      aria-hidden="true"
                      className="mr-1 inline-block w-3 border-t border-fg-muted align-middle"
                    />
                    {COPY.history.referenceLevel(formatNumber(history.referenceBands.p25, 0))}
                  </>
                )}
              </span>
              <span>
                <span
                  aria-hidden="true"
                  className="mr-1 inline-block w-3 border-t border-dashed border-fg-muted align-middle"
                />
                {COPY.history.p90}
              </span>
            </p>
          )}
          <Gaps points={series.points} />
        </div>
      ) : null}

      <p className="mt-2 text-sm">
        {metric.status === 'RARE_ACTIVITY' && history.rarity !== null
          ? history.rarity.text
          : metric.interpretation}
      </p>
      {metric.status === 'RARE_ACTIVITY' && history.rarity !== null ? (
        <p className="mt-1 text-sm text-fg-muted">{metric.interpretation}</p>
      ) : null}
      {lastDay === null ? null : (
        <p className="mt-1 text-sm text-fg-muted" data-window-ends={lastDay}>
          {COPY.history.windowEnds(formatDay(lastDay, 'UTC'))}
        </p>
      )}
      {history.largestRecent === null ? null : (
        <p className="mt-1 text-sm text-fg-muted">{history.largestRecent.text}</p>
      )}
      {history.sequenceContext === null ? null : (
        <p className="mt-1 text-sm text-fg-muted">
          {history.sequenceContext.text} {history.sequenceContext.caveat}
        </p>
      )}
      {history.completenessStatement === null ? null : (
        <p className="mt-1 text-xs text-fg-muted">{history.completenessStatement}</p>
      )}
      {history.caveats.map((caveat) => (
        <p key={caveat} className="mt-1 text-xs text-fg-muted">
          {caveat}
        </p>
      ))}
      <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <DerivedTag />
        <WhyPopover
          subject={`${COPY.history.title}: ${metric.label}`}
          reasons={[
            {
              code: metric.metricCode,
              text: metric.interpretation,
              params: {},
              evidenceIds: metric.evidenceIds,
            },
          ]}
          caveats={metric.caveats}
          evidenceIds={[metric.id, ...metric.evidenceIds]}
          modelVersion={metric.methodVersion}
        />
        <EvidenceButton ids={[metric.id, ...metric.evidenceIds]} label={COPY.evidence.open} />
        <a href={history.methodologyHref} className="inline-flex min-h-11 items-center md:min-h-0">
          {COPY.history.methodology}
        </a>
      </p>
    </figure>
  );
}
