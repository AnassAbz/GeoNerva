import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy, generateNonce } from './csp.ts';
import { parseMapStyleUrl } from './map-style.ts';

const NONCE = 'test-nonce-0123456789';

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split('; ').map((directive) => {
      const space = directive.indexOf(' ');
      return space === -1
        ? ([directive, ''] as const)
        : ([directive.slice(0, space), directive.slice(space + 1)] as const);
    }),
  );
}

function policy(mapStyleUrl?: string): Map<string, string> {
  const { origin } = parseMapStyleUrl(mapStyleUrl);
  return directives(buildContentSecurityPolicy({ mapOrigin: origin, nonce: NONCE }));
}

describe('buildContentSecurityPolicy (F-5)', () => {
  it("falls back to default-src 'self'", () => {
    expect(policy().get('default-src')).toBe("'self'");
  });

  it('authorises scripts by nonce and strict-dynamic, never inline or eval', () => {
    const scriptSrc = policy().get('script-src');
    expect(scriptSrc).toBe(`'self' 'strict-dynamic' 'nonce-${NONCE}'`);
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    // `'strict-dynamic'` makes browsers that implement it ignore `'self'`, so a same-origin
    // script URL is not by itself a way in; `'self'` is only the CSP Level 2 fallback.
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it('never allows a wildcard, inline script or eval in any directive', () => {
    const csp = buildContentSecurityPolicy({
      mapOrigin: parseMapStyleUrl(undefined).origin,
      nonce: NONCE,
    });
    for (const [name, value] of directives(csp)) {
      expect(value.split(' '), `${name} must not use a wildcard`).not.toContain('*');
      expect(value, `${name} must not use a scheme wildcard`).not.toMatch(/https?:(?!\/\/)/u);
      if (name.startsWith('script-src')) continue;
      expect(value, `${name} must not allow eval`).not.toContain('unsafe-eval');
    }
    expect(csp).not.toContain('unsafe-eval');
  });

  it('keeps every directive the map and the baseline headers already relied on', () => {
    // These strings are asserted verbatim by e2e/smoke.spec.ts and by docs/SECURITY.md §6.
    const csp = buildContentSecurityPolicy({
      mapOrigin: 'https://tiles.example.org',
      nonce: NONCE,
    });
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("connect-src 'self' https://tiles.example.org");
    expect(csp).toContain("img-src 'self' data: blob: https://tiles.example.org");
  });

  it('carries the map origin, and only the origin, wherever the map is fetched (F-16)', () => {
    const csp = policy('https://tiles.example.org:8443/styles/dark.json?key=abc');
    expect(csp.get('connect-src')).toBe("'self' https://tiles.example.org:8443");
    expect(csp.get('img-src')).toBe("'self' data: blob: https://tiles.example.org:8443");
    // The path, the query and any wildcard form of the host stay out of the policy.
    for (const value of csp.values()) {
      expect(value).not.toContain('/styles/dark.json');
      expect(value).not.toContain('key=abc');
      expect(value).not.toContain('*.example.org');
    }
  });

  it('places the basemap origin in no directive that governs scripts', () => {
    const csp = policy('https://tiles.example.org');
    for (const name of ['default-src', 'script-src', 'worker-src', 'object-src', 'base-uri']) {
      expect(csp.get(name), name).not.toContain('tiles.example.org');
    }
  });

  it('generates a fresh nonce that CSP3 accepts as a base64-value', () => {
    const nonces = new Set(Array.from({ length: 100 }, () => generateNonce()));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) {
      // The grammar Next.js parses back out of the request header.
      expect(`'nonce-${nonce}'`).toMatch(/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/u);
      expect(nonce.length).toBeGreaterThanOrEqual(22);
    }
  });
});
