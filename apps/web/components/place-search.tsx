'use client';

/**
 * Place type-ahead (docs/PRODUCT.md §5 step 1): an ARIA 1.2 combobox over local suggestions.
 *
 * P9a filters a list handed over by the server; P9b swaps the source for the same-origin
 * `/api/v1/places/suggest` client, and adds submit search, coordinate entry and "Use my location".
 * Matching folds case and accents, so "Marr" and "marrakech" both find "Marrakech".
 */

import type { PlaceSuggestion } from '@geonerva/domain';
import { useId, useMemo, useState } from 'react';

import { COPY } from '../lib/view/copy.ts';
import { placeSlug } from '../lib/view/routes.ts';

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function PlaceSearch({
  suggestions,
  navigate = (href: string) => {
    window.location.assign(href);
  },
}: {
  readonly suggestions: readonly PlaceSuggestion[];
  /** Injected in tests. */
  readonly navigate?: (href: string) => void;
}) {
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const needle = fold(query.trim());
    if (needle.length < 2) return [];
    return suggestions.filter((suggestion) => fold(suggestion.label).includes(needle)).slice(0, 8);
  }, [query, suggestions]);

  const hrefOf = (suggestion: PlaceSuggestion) =>
    `/place/${placeSlug({ key: suggestion.key, label: suggestion.label, countryCode: suggestion.countryCode })}`;

  const choose = (suggestion: PlaceSuggestion | undefined) => {
    if (suggestion !== undefined) navigate(hrefOf(suggestion));
  };

  const expanded = open && matches.length > 0;
  const optionId = (index: number) => `${listId}-option-${String(index)}`;

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        choose(matches[active] ?? matches[0]);
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
          aria-activedescendant={expanded ? optionId(active) : undefined}
          autoComplete="off"
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
              setActive((index) => Math.min(index + 1, Math.max(0, matches.length - 1)));
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
        {matches.map((suggestion, index) => (
          <li
            key={suggestion.key}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            onMouseDown={(event) => {
              event.preventDefault();
              choose(suggestion);
            }}
            className={`flex min-h-11 cursor-pointer items-center px-3 ${index === active ? 'bg-raised' : ''}`}
          >
            {suggestion.label}
          </li>
        ))}
      </ul>
      {open && query.trim().length >= 2 && matches.length === 0 ? (
        <p role="status" className="mt-2 text-sm text-fg-muted">
          {COPY.home.noMatch}
        </p>
      ) : null}
    </form>
  );
}
