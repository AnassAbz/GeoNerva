/**
 * The basemap style URL (ADR-014) and the origin the Content-Security-Policy allows for it.
 *
 * Security finding F-16: `MAP_STYLE_URL` must never be pasted into a CSP directive as a raw
 * string — `https://tiles.example.org/s.json;script-src *` would inject a directive. The CSP is
 * therefore built only from the parsed URL's `origin`, and a value containing whitespace, `;` or
 * `,` is refused outright rather than repaired.
 *
 * Pure: the callers (`next.config.ts` and server components) read the environment and pass it.
 */

/** OpenFreeMap's dark style; the same default as `@geonerva/config`. */
export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

export interface MapStyle {
  readonly url: string;
  /** Scheme + host (+ port), e.g. `https://tiles.openfreemap.org`. Safe to place in a CSP. */
  readonly origin: string;
}

export class MapStyleUrlError extends Error {
  constructor(reason: string) {
    super(`MAP_STYLE_URL is invalid: ${reason}`);
    this.name = 'MapStyleUrlError';
  }
}

export function parseMapStyleUrl(raw: string | undefined): MapStyle {
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_MAP_STYLE_URL : raw.trim();
  if (/[\s;,'"]/u.test(value)) {
    throw new MapStyleUrlError('it must not contain whitespace, quotes, ";" or ","');
  }
  if (!URL.canParse(value)) throw new MapStyleUrlError('it is not a URL');
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new MapStyleUrlError('it must be an https:// URL');
  if (url.username !== '' || url.password !== '') {
    throw new MapStyleUrlError('it must not carry credentials');
  }
  return { url: url.href, origin: url.origin };
}
