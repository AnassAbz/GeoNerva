/**
 * The proxy's matcher — security review of finding **F-5** (2026-09-22).
 *
 * `proxy.ts` is the only place that sets the Content-Security-Policy, so any path its matcher
 * does not match is served with **no CSP at all**. The matcher's own comment states the intent:
 * skip `_next/static`, `_next/image` and `favicon.ico`, because those are immutable build output
 * where a per-request header would defeat caching and govern nothing — and "an exclusion that is
 * not needed is only a hole, so there is none".
 *
 * These tests exercise that claim against the compiled matcher. Next.js turns the string in
 * `config.matcher` into `^<matcher>$` (path-to-regexp), which is what the regex below reproduces;
 * it was checked against the live headers of `next start` on every path named here.
 *
 * The last test **fails today**, and it is the finding: the three exclusions are written as
 * negative lookaheads over the rest of the path, not over a whole path segment, so every path
 * that merely *begins* with one of those strings escapes the proxy too. `/_next/staticX`,
 * `/_next/staticky/a.js`, `/_next/imageX` and `/favicon.icoX` are all served as HTML documents
 * (404s) with no `Content-Security-Policy`, no `frame-ancestors` and no `base-uri`.
 *
 * The smallest fix is to terminate each alternative at a segment boundary, e.g.
 * `'/((?!_next/static/|_next/image$|_next/image\\?|favicon\\.ico$).*)'` — or, more simply, to
 * match everything and skip inside the proxy on `request.nextUrl.pathname`.
 */

import { describe, expect, it } from 'vitest';

import { config } from '../proxy.ts';

/** The matcher as Next.js compiles it: one string, anchored at both ends. */
function matches(path: string): boolean {
  expect(config.matcher).toHaveLength(1);
  return new RegExp(`^${config.matcher[0]}$`, 'u').test(path);
}

describe('proxy matcher (F-5)', () => {
  it('covers every route family that renders provider text, plus 404s and the API', () => {
    for (const path of [
      '/',
      '/methodology',
      '/data-status',
      '/place/marrakech-ma-2542997',
      '/event/EQ-26-7K3F9Q',
      '/fire/FR-26-4HX2MB',
      '/no-such-page',
      '/api/v1/sources/status',
      '/api/v1/unknown-endpoint',
      '/maplibre/maplibre-gl-worker.mjs',
      '/maplibre/maplibre-gl-shared.mjs',
    ]) {
      expect(matches(path), `${path} must be covered by the CSP`).toBe(true);
    }
  });

  it('covers everything under _next that is not _next/static or _next/image', () => {
    for (const path of ['/_next/nonexistent', '/_next/data/x.json', '/_next/webpack-hmr']) {
      expect(matches(path), `${path} must be covered by the CSP`).toBe(true);
    }
  });

  it('skips exactly the three immutable-output paths it means to skip', () => {
    for (const path of ['/_next/static/chunks/a.js', '/_next/image', '/favicon.ico']) {
      expect(matches(path), `${path} is immutable build output`).toBe(false);
    }
  });

  /*
   * FINDING. Each exclusion is a prefix, not a path segment, so an unbounded family of ordinary
   * routes inherits the exemption. Measured against `next start` at Next 16.3.5: each of these
   * returns `404` with `Content-Type: text/html` and **no** `content-security-policy` header.
   */
  it('does not let a path that merely begins with an excluded prefix escape the CSP', () => {
    for (const path of [
      '/_next/staticX',
      '/_next/static',
      '/_next/staticky/a.js',
      '/_next/imageX',
      '/favicon.icoX',
    ]) {
      expect(matches(path), `${path} must be covered by the CSP`).toBe(true);
    }
  });
});
