/** The site header and footer shared by every page. */

import Link from 'next/link';

import { COPY } from '../lib/view/copy.ts';

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-surface">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-raised focus:px-3 focus:py-2"
      >
        {COPY.nav.skip}
      </a>
      <nav
        aria-label="Site"
        className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-1"
      >
        <Link
          href="/"
          className="inline-flex min-h-11 items-center gap-2 font-semibold text-fg no-underline"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle
              cx="10"
              cy="10"
              r="4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="2 2"
            />
            <circle cx="10" cy="10" r="1.5" fill="currentColor" />
          </svg>
          <span>{COPY.product.name}</span>
          <span className="sr-only"> — {COPY.nav.home}</span>
        </Link>
        <ul className="flex gap-3 text-sm">
          <li>
            <a href="/data-status" className="inline-flex min-h-11 items-center">
              {COPY.nav.dataStatus}
            </a>
          </li>
          <li>
            <a href="/methodology" className="inline-flex min-h-11 items-center">
              {COPY.nav.methodology}
            </a>
          </li>
        </ul>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-line bg-surface">
      <div className="mx-auto max-w-7xl px-4 py-6 text-xs text-fg-muted">
        <p>{COPY.product.notWarning}</p>
        <p className="mt-2">
          Basemap © OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors. Hazard data from
          USGS, EMSC, GDACS and NASA FIRMS; see <a href="/data-status">{COPY.nav.dataStatus}</a> for
          attribution and licences.
        </p>
      </div>
    </footer>
  );
}
