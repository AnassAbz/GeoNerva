/**
 * The persistent replay banner (docs/PRODUCT.md §6.1, §6.10): whenever a page is rendered for an
 * `as_of` in the past, it says so at the top, in words, with the way back to the present.
 */

import { COPY } from '../lib/view/copy.ts';
import { formatUtc } from '../lib/view/format.ts';

export function ReplayBanner({
  asOf,
  exitHref,
}: {
  readonly asOf: string;
  readonly exitHref: string;
}) {
  return (
    <div
      role="region"
      aria-label="Replay"
      className="border-b border-derived/50 bg-derived/10 px-4 py-2 text-sm text-fg"
      data-testid="replay-banner"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
        <p>
          <strong className="font-semibold">
            {COPY.replay.prefix} <time dateTime={asOf}>{formatUtc(asOf)}</time>.
          </strong>{' '}
          {COPY.replay.suffix}
        </p>
        <a href={exitHref} className="inline-flex min-h-11 items-center font-medium">
          {COPY.replay.exit}
        </a>
      </div>
    </div>
  );
}
