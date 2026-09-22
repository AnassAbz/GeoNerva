'use client';

/**
 * Place search (docs/PRODUCT.md §4.1 capability 1, §5 step 1) — the product's entry point, and
 * the four ways in that capability names, behind one ARIA 1.2 combobox.
 *
 *  1. **Type-ahead** from `/api/v1/places/suggest`: the local GeoNames table, debounced, with
 *     every superseded request aborted. Nominatim's policy forbids autocomplete, so a keystroke
 *     reaches no provider — it reaches GeoNerva's own database and stops there.
 *  2. **Submit search** through `/api/v1/places/search` when nothing local matches: one cached,
 *     globally rate-limited geocoder call, and only on an explicit submit.
 *  3. **Coordinate entry**, parsed in the browser and rounded to two decimals *before* the first
 *     request. See below — this is the reason the type-ahead is suppressed for numeric input.
 *  4. **"Use my location"**, on a click and never on load, through `lib/client/geolocation.ts`.
 *
 * ### The one rule that shapes the component
 *
 * Invariant I15 and ADR-015: a visitor's position is held to two decimals — about 1.1 km —
 * *before* it reaches a log line, a cache key or a query. `params.ts` states why a server cannot
 * do this on the caller's behalf: by the time a handler runs, the precise value is already the
 * CDN cache key and already in the platform's access log. So `31.6315, -8.0089` must never
 * become a request at all, and it does not: `isCoordinateEntry` recognises numeric input on
 * every keystroke and the type-ahead is skipped entirely for it. The visitor is offered the
 * rounded pair as the single option, and told it was rounded.
 *
 * ### Failure is a sentence, never a dead end
 *
 * Every path the network or the browser can refuse — a suggest call that cannot be reached, a
 * geocoder the provider is rate-limiting, a declined location prompt — ends in one line in the
 * status region, with the box still usable and the other three routes still open.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { ApiClientError, isAborted } from '../lib/client/api-client.ts';
import {
  isCoordinateEntry,
  parseCoordinateEntry,
  type CoordinateEntry,
} from '../lib/client/coordinates.ts';
import {
  GeolocationRefused,
  currentCoordinate,
  type GeolocationFailure,
} from '../lib/client/geolocation.ts';
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  hrefForCoordinate,
  hrefForSearchResult,
  hrefForSuggestion,
  places as apiPlaces,
  type PlacesClient,
} from '../lib/client/places.ts';
import { COPY } from '../lib/view/copy.ts';

/**
 * Long enough that a typed word is one request rather than five, short enough to feel immediate.
 * The suggest endpoint is local and cheap; this bounds the *rate*, not the cost.
 */
export const SUGGEST_DEBOUNCE_MS = 200;

/** One row of the listbox, whatever produced it. */
interface Option {
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

/**
 * What the box has to say, and the exact text it was said about.
 *
 * The term is carried with the answer rather than cleared by an effect. A result for a term the
 * visitor has already typed past is simply not the current answer, so it is never displayed and
 * never has to be cleaned up — which is what lets the whole component derive its output from
 * `query` during render instead of synchronizing state in an effect.
 */
interface Answer {
  readonly term: string;
  readonly options: readonly Option[];
  readonly notice: string;
}

const SILENT: Pick<Answer, 'options' | 'notice'> = { options: [], notice: '' };

export function PlaceSearch({
  places = apiPlaces,
  locate = currentCoordinate,
  navigate = (href: string) => {
    window.location.assign(href);
  },
}: {
  /** Injected in tests. */
  readonly places?: PlacesClient;
  /** Injected in tests. Resolves with an already-rounded position. */
  readonly locate?: () => Promise<{ readonly lat: number; readonly lon: number }>;
  /** Injected in tests. */
  readonly navigate?: (href: string) => void;
}) {
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const term = query.trim();

  /* Read after an await, to drop an answer the visitor has already typed past. */
  const latest = useRef(term);
  useEffect(() => {
    latest.current = term;
  }, [term]);

  /*
   * Numeric input is answered here, during render, and never reaches the network.
   * `isCoordinateEntry` is deliberately coarser than the parser: `31.6315` and `31.63,` are
   * half-typed positions rather than place names, so they are kept local whether or not they
   * parse yet. This is the invariant I15 control on this surface.
   */
  const coordinate = useMemo(
    () => (isCoordinateEntry(term) ? parseCoordinateEntry(term) : null),
    [term],
  );

  useEffect(() => {
    if (coordinate !== null || term.length < MIN_QUERY_LENGTH) return undefined;

    let live = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void places
        .suggest(term, { signal: controller.signal })
        .then((response) => {
          if (!live) return;
          setAnswer({
            term,
            options: response.suggestions.map((suggestion) => ({
              id: suggestion.key,
              label: suggestion.label,
              href: hrefForSuggestion(suggestion),
            })),
            notice: response.suggestions.length === 0 ? COPY.home.noMatch : '',
          });
        })
        .catch((error: unknown) => {
          if (!live || isAborted(error)) return;
          setAnswer({ term, ...SILENT, notice: COPY.home.suggestUnavailable });
        });
    }, SUGGEST_DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
      // Aborts the request the next keystroke has superseded, in flight or not yet sent.
      controller.abort();
    };
  }, [term, coordinate, places]);

  const runSearch = useCallback(
    async (searched: string) => {
      setBusy(true);
      setAnswer({ term: searched, ...SILENT, notice: COPY.home.searching });
      try {
        const response = await places.search(searched);
        if (latest.current !== searched) return;
        const results = response.results;
        const only = results.length === 1 ? results[0] : undefined;
        if (only !== undefined) {
          setAnswer({ term: searched, ...SILENT });
          navigate(hrefForSearchResult(only));
          return;
        }
        if (results.length === 0) {
          setAnswer({ term: searched, ...SILENT, notice: COPY.home.searchNoResult });
          return;
        }
        setAnswer({
          term: searched,
          options: results.map((result, index) => ({
            id: `${result.key}-${String(index)}`,
            label: result.label,
            href: hrefForSearchResult(result),
          })),
          notice: COPY.home.searchChoose(results.length),
        });
        setActive(0);
        setOpen(true);
      } catch (error: unknown) {
        setAnswer({ term: searched, ...SILENT, notice: noticeForSearchError(error) });
      } finally {
        setBusy(false);
      }
    },
    [navigate, places],
  );

  const useMyLocation = useCallback(() => {
    setOpen(false);
    const asked = latest.current;
    setAnswer({ term: asked, ...SILENT, notice: COPY.home.locating });
    void (async () => {
      try {
        // Already rounded when it arrives; `hrefForCoordinate` rounds again and cannot widen it.
        const point = await locate();
        setAnswer({ term: asked, ...SILENT });
        navigate(hrefForCoordinate(point.lat, point.lon));
      } catch (error: unknown) {
        setAnswer({ term: asked, ...SILENT, notice: noticeForLocationError(error) });
      }
    })();
  }, [locate, navigate]);

  /*
   * Everything below is derived from `query` and the one answer that is still about it. A stale
   * answer is invisible rather than cleared, and the active index is clamped rather than reset,
   * so no effect ever has to write state back just to keep the view consistent.
   */
  const current = answer !== null && answer.term === term ? answer : null;
  const options =
    coordinate?.kind === 'coordinate' ? [coordinateOption(coordinate)] : (current?.options ?? []);
  const notice = current?.notice ?? noticeForCoordinate(coordinate);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  const expanded = open && options.length > 0;
  const optionId = (index: number) => `${listId}-option-${String(index)}`;

  return (
    <form
      role="search"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        const chosen = options[activeIndex];
        if (chosen !== undefined) {
          navigate(chosen.href);
          return;
        }
        // A coordinate that did not parse already has its own explanation in the status line.
        if (coordinate !== null) return;
        if (term.length < MIN_QUERY_LENGTH) {
          setAnswer({ term, ...SILENT, notice: COPY.home.searchTooShort });
          return;
        }
        void runSearch(term);
      }}
      className="relative"
    >
      <label htmlFor={inputId} className="mb-1 block text-sm font-medium">
        {COPY.home.searchLabel}
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded ? optionId(activeIndex) : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={MAX_QUERY_LENGTH}
          placeholder={COPY.home.searchPlaceholder}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActive((index) => Math.min(index + 1, Math.max(0, options.length - 1)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
          onBlur={() => {
            // Leave time for a click on an option to land before the list closes.
            setTimeout(() => {
              setOpen(false);
            }, 150);
          }}
          className="min-h-11 min-w-0 flex-1 rounded border border-line bg-raised px-3 text-fg placeholder:text-fg-subtle"
        />
        <button type="submit" className="min-h-11 rounded bg-link px-4 font-semibold text-canvas">
          {COPY.home.searchSubmit}
        </button>
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label={COPY.home.searchLabel}
        hidden={!expanded}
        className="absolute inset-x-0 z-10 mt-1 rounded border border-line bg-surface shadow-lg"
      >
        {options.map((option, index) => (
          <li
            key={option.id}
            id={optionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => {
              event.preventDefault();
              navigate(option.href);
            }}
            className={`flex min-h-11 cursor-pointer items-center px-3 ${index === activeIndex ? 'bg-raised' : ''}`}
          >
            {option.label}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={useMyLocation}
          className="inline-flex min-h-11 items-center rounded border border-line px-3 text-sm"
        >
          {COPY.home.useMyLocation}
        </button>
        <p role="status" className="text-sm text-fg-muted">
          {notice}
        </p>
      </div>
    </form>
  );
}

/** The one option a parsed position offers: the rounded pair, and the route it leads to. */
function coordinateOption(entry: Extract<CoordinateEntry, { kind: 'coordinate' }>): Option {
  const point = `${entry.lat.toFixed(2)}, ${entry.lon.toFixed(2)}`;
  return {
    id: 'coordinate',
    label: COPY.home.coordinateOption(point),
    href: hrefForCoordinate(entry.lat, entry.lon),
  };
}

/**
 * What to say about numeric input. A pair that parsed says nothing unless it had to be rounded,
 * in which case the visitor is told so — the position GeoNerva uses is not the one they typed,
 * and that is a fact about their privacy, not a detail.
 */
function noticeForCoordinate(entry: CoordinateEntry | null): string {
  if (entry === null) return '';
  switch (entry.kind) {
    case 'coordinate':
      return entry.wasRounded ? COPY.home.coordinateRounded : '';
    case 'out-of-range':
      return COPY.home.coordinateOutOfRange;
    case 'sexagesimal':
      return COPY.home.coordinateSexagesimal;
    case 'none':
      return '';
  }
}

/**
 * The API's own `detail` when there is one, because it is written by GeoNerva, is displayable by
 * contract, and says the useful thing — "the provider is asking GeoNerva to slow down" reads far
 * better than a generic failure. Anything else falls back to this file's own sentence.
 */
function noticeForSearchError(error: unknown): string {
  if (error instanceof ApiClientError && error.problem !== null) {
    const detail = error.problem.detail;
    if (detail !== null && detail.trim() !== '') return detail;
  }
  return COPY.home.searchFailed;
}

function noticeForLocationError(error: unknown): string {
  const failure: GeolocationFailure =
    error instanceof GeolocationRefused ? error.failure : 'UNAVAILABLE';
  switch (failure) {
    case 'DENIED':
      return COPY.home.locationDenied;
    case 'TIMED_OUT':
      return COPY.home.locationTimedOut;
    case 'UNSUPPORTED':
      return COPY.home.locationUnsupported;
    case 'UNAVAILABLE':
      return COPY.home.locationUnavailable;
  }
}
