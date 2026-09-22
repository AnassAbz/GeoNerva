'use client';

/**
 * Evidence presentation (docs/PRODUCT.md §6.8).
 *
 * Every derived statement ends with an unobtrusive evidence affordance. It opens one drawer —
 * a side panel on desktop, a bottom sheet on mobile — listing the items from the response's own
 * evidence manifest: kind, source, observed and ingested times, the one-line summary, and the
 * provider's original URL.
 *
 * The raw-record excerpt from the resolver is deliberately absent in P9a: the observation
 * payload is being extended by an approved ADR, and P9b renders it.
 */

import type { EvidenceItem } from '@geonerva/domain';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { COPY } from '../lib/view/copy.ts';
import { formatDateTime } from '../lib/view/format.ts';
import { sourceName } from '../lib/view/sources.ts';

interface EvidenceState {
  readonly open: (ids: readonly string[], trigger: HTMLElement | null) => void;
}

const EvidenceContext = createContext<EvidenceState | null>(null);

export function EvidenceProvider({
  manifest,
  timeZone,
  children,
}: {
  readonly manifest: readonly EvidenceItem[];
  readonly timeZone: string;
  readonly children: ReactNode;
}) {
  const [ids, setIds] = useState<readonly string[] | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const byId = useMemo(() => new Map(manifest.map((item) => [item.id, item])), [manifest]);

  const open = useCallback((next: readonly string[], trigger: HTMLElement | null) => {
    triggerRef.current = trigger;
    setIds(next);
  }, []);

  const close = useCallback(() => {
    setIds(null);
    triggerRef.current?.focus();
  }, []);

  const state = useMemo(() => ({ open }), [open]);

  return (
    <EvidenceContext.Provider value={state}>
      {children}
      {ids === null ? null : (
        <EvidenceDrawer ids={ids} byId={byId} timeZone={timeZone} onClose={close} />
      )}
    </EvidenceContext.Provider>
  );
}

/** The evidence affordance: "[3]" by default, or a labelled button. */
export function EvidenceButton({
  ids,
  label,
}: {
  readonly ids: readonly string[];
  readonly label?: string;
}) {
  const context = useContext(EvidenceContext);
  const unique = useMemo(() => [...new Set(ids)], [ids]);
  if (context === null || unique.length === 0) return null;
  return (
    <button
      type="button"
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded px-1 text-xs font-medium text-link underline decoration-dotted underline-offset-2 hover:decoration-solid md:min-h-6 md:min-w-6"
      onClick={(event) => {
        context.open(unique, event.currentTarget);
      }}
      aria-haspopup="dialog"
      aria-label={
        label === undefined
          ? `[${String(unique.length)}] ${COPY.evidence.openCount(unique.length)}`
          : undefined
      }
    >
      {label ?? `[${String(unique.length)}]`}
    </button>
  );
}

function EvidenceDrawer({
  ids,
  byId,
  timeZone,
  onClose,
}: {
  readonly ids: readonly string[];
  readonly byId: ReadonlyMap<string, EvidenceItem>;
  readonly timeZone: string;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || panelRef.current === null) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-canvas/80" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-xl border border-line bg-surface p-4 shadow-2xl md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:w-[28rem] md:rounded-none md:border-y-0 md:border-r-0"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id={titleId} className="text-lg font-semibold">
            {COPY.evidence.title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="min-h-11 min-w-11 rounded border border-line px-3 text-sm hover:bg-raised"
          >
            {COPY.evidence.close}
          </button>
        </div>
        <ol className="space-y-3">
          {ids.map((id) => {
            const item = byId.get(id);
            return (
              <li key={id} className="rounded border border-line bg-raised p-3 text-sm">
                {item === undefined ? (
                  <p className="text-fg-muted">
                    <code className="break-all font-mono text-xs">{id}</code> —{' '}
                    {COPY.evidence.missing}
                  </p>
                ) : (
                  <EvidenceEntry item={item} timeZone={timeZone} />
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function EvidenceEntry({
  item,
  timeZone,
}: {
  readonly item: EvidenceItem;
  readonly timeZone: string;
}) {
  return (
    <article>
      <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span className="font-semibold uppercase tracking-wide text-fg">
          {COPY.evidence.kinds[item.kind]}
        </span>
        <span className="rounded-sm bg-canvas px-1 font-semibold">
          {item.sourceId === null ? COPY.evidence.derivation : sourceName(item.sourceId)}
        </span>
      </p>
      <p className="mt-1 text-fg">{item.summary}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-fg-muted">
        {item.observedAt === null ? null : (
          <>
            <dt>{COPY.evidence.observed}</dt>
            <dd className="tabular">{formatDateTime(item.observedAt, timeZone)}</dd>
          </>
        )}
        <dt>{COPY.evidence.ingested}</dt>
        <dd className="tabular">{formatDateTime(item.ingestedAt, timeZone)}</dd>
      </dl>
      <p className="mt-1 break-all font-mono text-[0.7rem] text-fg-subtle">{item.id}</p>
      {item.url === null ? null : (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex min-h-11 items-center text-sm"
        >
          {COPY.evidence.viewOriginal}
          <span className="sr-only"> ({sourceName(item.sourceId ?? '')})</span>
        </a>
      )}
    </article>
  );
}
