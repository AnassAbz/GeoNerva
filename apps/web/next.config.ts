import type { NextConfig } from 'next';

import { parseMapStyleUrl } from './lib/map-style.ts';

/**
 * Where the basemap comes from (ADR-014). Only the parsed **origin** reaches the CSP, never the
 * raw configuration string (security finding F-16); an invalid value fails the build.
 *
 * The value is used at request time, in `proxy.ts`, because the Content-Security-Policy now
 * carries a per-request nonce (finding F-5) and can no longer be a build-time constant. This call
 * is what keeps F-16's second half true: a `MAP_STYLE_URL` that would inject a directive, or is
 * not an `https://` URL, throws here and fails `next build` rather than the first request.
 */
parseMapStyleUrl(process.env['MAP_STYLE_URL']);

/**
 * Baseline security headers (docs/SECURITY.md §6) — every header that does not vary per request.
 *
 * `Content-Security-Policy` is deliberately absent: it is set in `proxy.ts`, which is the only
 * place allowed to set it. Two CSP headers are enforced as an intersection, so a nonce-less copy
 * here would block the inline scripts the nonce authorises.
 */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(), microphone=()' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: securityHeaders }]);
  },
};

export default nextConfig;
