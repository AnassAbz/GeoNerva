/**
 * The local database and **every** CI service container must be the same pinned image, otherwise
 * "works locally" and "works in CI" stop meaning the same thing, and a digest can silently drift
 * (docs/reviews/security-p1.md N-7/F-14).
 *
 * There are two CI databases now — the integration job's and the E2E job's — so the rule is that
 * they all match the compose file, not that there is exactly one of them. The same pinning rule
 * covers the worker image's base (P10), because a base image resolved by tag at build time is the
 * same silent drift one layer down.
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
    /* Both jobs that touch a database: integration, and E2E since P10. */
    expect(ci.length).toBeGreaterThanOrEqual(2);
  });

  it('is pinned by digest, not only by tag', () => {
    for (const image of [...compose, ...ci]) {
      expect(image, `${image} must be pinned by @sha256:`).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('is identical in the compose file and in every CI service', () => {
    for (const image of ci) expect(image).toBe(compose[0]);
  });
});

describe('the worker image base', () => {
  const dockerfile = read('infra/worker/Dockerfile');
  const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gmu)].map((match) => match[1] ?? '');

  it('is pinned by digest in every stage', () => {
    expect(bases.length).toBeGreaterThan(0);
    for (const base of bases) {
      expect(base, `${base} must be pinned by @sha256:`).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  /*
   * One base for both stages. A build stage on a different Node than the runtime stage would
   * install native modules against the wrong ABI and fail at run time rather than at build time.
   */
  it('is the same image in the build and runtime stages', () => {
    expect(new Set(bases).size).toBe(1);
  });

  it('matches the Node version the repository pins everywhere else', () => {
    const major = read('.nvmrc').trim();
    expect(bases[0]).toContain(`node:${major}-`);
  });
});
