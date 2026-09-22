/**
 * Page query parameters. The API validates its own parameters (`lib/server/params.ts`); these
 * are the page-side equivalents for what a page accepts, and they refuse rather than guess.
 */

import type { ChangeWindow } from '@geonerva/domain';

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

const PAGE_WINDOWS: readonly ChangeWindow[] = ['6h', '24h', '7d'];

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseWindowParam(raw: string | string[] | undefined): ChangeWindow {
  const value = first(raw);
  return PAGE_WINDOWS.find((window) => window === value) ?? '24h';
}

/**
 * An `as_of` in the past, normalized to the contract's millisecond ISO form, or `undefined`
 * when absent, malformed or not in the past (then the page shows the present).
 */
export function parseAsOfParam(
  raw: string | string[] | undefined,
  now: string,
): string | undefined {
  const value = first(raw);
  if (value === undefined || value.length > 40) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || ms >= Date.parse(now)) return undefined;
  return new Date(ms).toISOString();
}

export { PAGE_WINDOWS };
