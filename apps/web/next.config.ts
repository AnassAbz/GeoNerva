import type { NextConfig } from 'next';

import { parseMapStyleUrl } from './lib/map-style.ts';

/**
 * Where the basemap comes from (ADR-014). Only the parsed **origin** reaches the CSP, never the
 * raw configuration string (security finding F-16); an invalid value fails the build.
 */
const mapStyle = parseMapStyleUrl(process.env['MAP_STYLE_URL']);

/**
 * Baseline security headers (docs/SECURITY.md §6).
 *
 * The Content-Security-Policy is widened only as far as the map needs (P9a): MapLibre fetches the
 * style, tiles, glyphs and sprites from the basemap origin (`connect-src`), draws images from
 * `data:`/`blob:` URLs (`img-src`), and runs its tile workers from a `blob:` URL (`worker-src`).
 * The strict script policy of finding F-5 (`default-src 'self'` with hashes or `strict-dynamic`)
 * is a separate change and is not made here.
 */
const contentSecurityPolicy = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  `connect-src 'self' ${mapStyle.origin}`,
  `img-src 'self' data: blob: ${mapStyle.origin}`,
  "worker-src 'self' blob:",
].join('; ');

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(), microphone=()' },
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: securityHeaders }]);
  },
};

export default nextConfig;
