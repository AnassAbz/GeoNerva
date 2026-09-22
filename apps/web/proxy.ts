/**
 * Sets the Content-Security-Policy on every document and API response (security finding F-5).
 *
 * The policy carries a per-request nonce, so it cannot come from `next.config.ts`, whose
 * `headers()` is a build-time constant; `lib/csp.ts` records why a nonce is the mechanism and why
 * hashes and `experimental.sri` are not. Next.js reads the nonce back off the **request's** CSP
 * header (`dist/server/app-render/get-script-nonce-from-header.js`) and stamps it onto the inline
 * bootstrap and flight-data scripts it injects, which is why the header is set on both the
 * forwarded request and the response.
 *
 * `next.config.ts` still owns every header that does not vary per request, and this file must
 * stay the only place that sets `Content-Security-Policy`: two CSP headers are enforced as an
 * intersection, so a second, nonce-less copy would block the very scripts this one authorises.
 *
 * Named `proxy.ts` because Next 16 deprecated the `middleware.ts` convention in favour of it.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { buildContentSecurityPolicy, generateNonce } from './lib/csp.ts';
import { parseMapStyleUrl } from './lib/map-style.ts';

export default function proxy(request: NextRequest): NextResponse {
  const { origin } = parseMapStyleUrl(process.env['MAP_STYLE_URL']);
  const csp = buildContentSecurityPolicy({ mapOrigin: origin, nonce: generateNonce() });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  /*
   * Every document and every API response, including 404s. Only `_next/static` and `_next/image`
   * are skipped: they are immutable build output, a per-request header there would defeat their
   * caching, and a CSP on a `.js` or image response governs nothing.
   *
   * `/maplibre/*` is deliberately **not** skipped. A dedicated worker created from a same-origin
   * URL takes its CSP from its own response, so the worker inherits `'strict-dynamic'`, and the
   * concern was that it would block the worker's static `import` of `maplibre-gl-shared.mjs`.
   * Measured against Chromium with the basemap style stubbed so the worker actually starts: the
   * worker was created and both `maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` were
   * fetched, with no CSP violation and no console error. An exclusion that is not needed is only
   * a hole, so there is none.
   */
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
