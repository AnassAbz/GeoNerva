/**
 * The local database and the CI service container must be the same pinned image, otherwise
 * "works locally" and "works in CI" stop meaning the same thing, and a digest can silently
 * drift (docs/reviews/security-p1.md N-7/F-14).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = new URL('..', import.meta.url);

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, repoRoot)), 'utf8');
}

function postgisImages(content: string): string[] {
  return [...content.matchAll(/image:\s*(postgis\/postgis:\S+)/g)].map((match) => match[1] ?? '');
}

describe('PostGIS image pinning', () => {
  const compose = postgisImages(read('infra/docker-compose.yml'));
  const ci = postgisImages(read('.github/workflows/ci.yml'));

  it('is used in both places', () => {
    expect(compose).toHaveLength(1);
    expect(ci).toHaveLength(1);
  });

  it('is pinned by digest, not only by tag', () => {
    for (const image of [...compose, ...ci]) {
      expect(image, `${image} must be pinned by @sha256:`).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('is identical in the compose file and in CI', () => {
    expect(ci[0]).toBe(compose[0]);
  });
});
