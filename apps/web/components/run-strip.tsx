/**
 * The 24 h poll sparkline of `/data-status`: one mark per recent run, oldest to newest. A failed
 * run is a hollow, lowered mark — distinct in shape, not only in colour — and the summary
 * sentence next to it states the count in words.
 */

import type { RunSummaryView } from '@geonerva/domain';

import { PALETTE } from '../lib/view/palette.ts';

export function RunStrip({ runs }: { readonly runs: readonly RunSummaryView[] }) {
  const ordered = [...runs].reverse();
  const failed = ordered.filter((run) => run.status === 'FAILED').length;
  if (ordered.length === 0) return null;
  const width = Math.max(ordered.length * 6, 6);
  return (
    <svg
      viewBox={`0 0 ${String(width)} 16`}
      className="mt-1 h-4 w-full max-w-xs"
      role="img"
      aria-label={`${String(ordered.length)} recent polls, ${String(failed)} failed`}
      preserveAspectRatio="none"
    >
      {ordered.map((run, index) =>
        run.status === 'FAILED' ? (
          <rect
            key={run.id}
            x={index * 6 + 1}
            y={9}
            width={4}
            height={6}
            fill="none"
            stroke={PALETTE.stale}
            strokeWidth={1}
          />
        ) : (
          <rect key={run.id} x={index * 6 + 1} y={1} width={4} height={14} fill={PALETTE.fresh} />
        ),
      )}
    </svg>
  );
}
