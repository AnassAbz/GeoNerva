'use client';

/**
 * Evidence presentation (docs/PRODUCT.md §6.8).
 *
 * Every derived statement ends with an unobtrusive evidence affordance. It opens one drawer —
 * a side panel on desktop, a bottom sheet on mobile — listing the items from the response's own
 * evidence manifest: kind, source, observed and ingested times, the one-line summary, and the
 * provider's original URL.
 *
 * ### "Raw record" (P9b, ADR-038)
 *
 * When the caller supplies the resolved `EvidenceDetail` for an observation, the entry also
 * carries a **Raw record** section: the provider payload's lifecycle in words — held, pruned,
 * never captured, or unknown — plus the integrity and retention metadata GeoNerva actually knows.
 *
 * What it never carries is the provider's bytes, and there is no affordance here that could fetch
 * them. ADR-038 decided that normalized evidence stays durable independently of raw-payload
 * retention, that the endpoint exposes the *lifecycle state* and the digest, and that
 * "raw-payload retrieval is **not** part of the stable public contract". `rawExcerpt` is
 * permanently `null` on the wire; this component would not render it if it were not.
 *
 * The four states are four different facts and each gets its own sentence. `PRUNED` ("we held it
 * and deleted it when retention expired") and `NOT_CAPTURED` ("we never held it") are the pair
 * that must never collapse into one message: ADR-038 added the `payload_captured` column
 * precisely because `payload_pruned = true` could not tell them apart, and a UI that reunited them
 * would throw that distinction away at the last step.
 */

import type { EvidenceDetail, EvidenceItem, RawPayloadView } from '@geonerva/domain';
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
  details,
  timeZone,
  children,
}: {
  readonly manifest: readonly EvidenceItem[];
  /**
   * Resolved details for whichever cited items the caller already has, keyed by their own
   * `item.id`. Supplying none is the normal case and costs only the "Raw record" section; the
   * drawer never goes and asks for one, because a payload's lifecycle is metadata about a
   * citation the response already made, not a second request a reader should pay for.
   */
  readonly details?: readonly EvidenceDetail[];
  readonly timeZone: string;
  readonly children: ReactNode;
}) {
  const [ids, setIds] = useState<readonly string[] | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const byId = useMemo(() => new Map(manifest.map((item) => [item.id, item])), [manifest]);
  const detailById = useMemo(
    () => new Map((details ?? []).map((entry) => [entry.item.id, entry])),
    [details],
  );

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
        <EvidenceDrawer
          ids={ids}
          byId={byId}
          detailById={detailById}
          timeZone={timeZone}
          onClose={close}
        />
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
  detailById,
  timeZone,
  onClose,
}: {
  readonly ids: readonly string[];
  readonly byId: ReadonlyMap<string, EvidenceItem>;
  readonly detailById: ReadonlyMap<string, EvidenceDetail>;
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
                  <EvidenceEntry item={item} detail={detailById.get(item.id)} timeZone={timeZone} />
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
  detail,
  timeZone,
}: {
  readonly item: EvidenceItem;
  readonly detail: EvidenceDetail | undefined;
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
      {detail?.detail.kind === 'OBS' ? (
        <RawRecord view={detail.detail.rawPayload} timeZone={timeZone} />
      ) : null}
    </article>
  );
}

/**
 * User-visible strings for the raw-record section.
 *
 * Kept local to this component on purpose while `lib/view/copy.ts` is owned elsewhere; it is the
 * established home for UI copy and these belong there. `copy.test.ts` scans this file's literals
 * with the same lexicon either way, so the language rules apply here already.
 *
 * The four sentences are written so that no two of them could be mistaken for each other. "Pruned"
 * says a body existed and was deleted; "never captured" says there was nothing to delete; and the
 * defensive state says GeoNerva does not know, rather than picking the answer that reads best.
 */
const RAW_RECORD = {
  title: 'Raw record',
  lifecycle: {
    AVAILABLE:
      'Held — GeoNerva still has the provider’s original record for this observation, inside its retention window. The provider’s own bytes are not shown here.',
    PRUNED:
      'Pruned — GeoNerva did hold the provider’s original record and deleted it when the retention window below ended. The digest still identifies which bytes were ingested.',
    NOT_CAPTURED:
      'Never captured — GeoNerva never stored the provider’s original record for this observation, so there was nothing to prune. Only the normalized observation was kept.',
    SOURCE_UNAVAILABLE:
      'Unknown — a stored record is referenced for this observation, but GeoNerva cannot read its details here. It reports nothing about the provider’s bytes rather than guessing.',
  } satisfies Record<RawPayloadView['state'], string>,
  digest: 'SHA-256 digest of the provider’s record',
  captured: 'Record first stored',
  expires: 'Retention window ends',
  expired: 'Retention window ended',
} as const;

/**
 * The payload's lifecycle and the metadata that goes with it — and only the metadata that is
 * actually known: every field of `RawPayloadView` is nullable, and the schema's own refinement
 * ties which ones are populated to the state. A row rendered from a `null` would be GeoNerva
 * asserting a capture time or an expiry it does not have.
 */
function RawRecord({
  view,
  timeZone,
}: {
  readonly view: RawPayloadView;
  readonly timeZone: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-3 border-t border-line pt-2">
      <h3 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-fg">
        {RAW_RECORD.title}
      </h3>
      <p className="mt-1 text-xs text-fg-muted">{RAW_RECORD.lifecycle[view.state]}</p>
      <dl className="mt-2 space-y-1">
        {view.sha256 === null ? null : (
          <div>
            <dt className="text-[0.7rem] uppercase tracking-wide text-fg-subtle">
              {RAW_RECORD.digest}
            </dt>
            <dd className="break-all font-mono text-[0.7rem] text-fg-muted">{view.sha256}</dd>
          </div>
        )}
        {view.capturedAt === null ? null : (
          <div>
            <dt className="text-[0.7rem] uppercase tracking-wide text-fg-subtle">
              {RAW_RECORD.captured}
            </dt>
            <dd className="tabular text-xs text-fg-muted">
              {formatDateTime(view.capturedAt, timeZone)}
            </dd>
          </div>
        )}
        {view.retentionExpiresAt === null ? null : (
          <div>
            <dt className="text-[0.7rem] uppercase tracking-wide text-fg-subtle">
              {view.state === 'PRUNED' ? RAW_RECORD.expired : RAW_RECORD.expires}
            </dt>
            <dd className="tabular text-xs text-fg-muted">
              {formatDateTime(view.retentionExpiresAt, timeZone)}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
