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
import { readFileSync, readdirSync } from 'node:fs';
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

describe('the worker image ships the dependency closure and no more', () => {
  /*
   * A production image should contain what the process imports and nothing else. The first version
   * copied the whole `packages` directory, which put 4.6 MB of captured provider payloads
   * (`test-fixtures`) into it — weight, but also provider data with its own licensing, sitting
   * somewhere nobody would think to look for it.
   *
   * The closure is recomputed from the manifests rather than restated here, so adding a workspace
   * dependency to the worker fails this test instead of failing the container.
   */
  function workspaceClosure(): string[] {
    const manifests = new Map<string, { dir: string; deps: string[] }>();
    for (const dir of readdirSync(fileURLToPath(new URL('packages', repoRoot)))) {
      const parsed = JSON.parse(read(`packages/${dir}/package.json`)) as {
        name: string;
        dependencies?: Record<string, string>;
      };
      manifests.set(parsed.name, { dir, deps: Object.keys(parsed.dependencies ?? {}) });
    }

    const worker = JSON.parse(read('apps/worker/package.json')) as {
      dependencies?: Record<string, string>;
    };
    const seen = new Set<string>();
    const queue = Object.keys(worker.dependencies ?? {});
    while (queue.length > 0) {
      const name = queue.shift();
      if (name === undefined || !name.startsWith('@geonerva/') || seen.has(name)) continue;
      seen.add(name);
      queue.push(...(manifests.get(name)?.deps ?? []));
    }
    return [...seen]
      .map((name) => manifests.get(name)?.dir)
      .filter((dir): dir is string => dir !== undefined)
      .sort();
  }

  const dockerfile = read('infra/worker/Dockerfile');
  const copied = [...dockerfile.matchAll(/^COPY packages\/([\w-]+) packages\/\1$/gmu)]
    .map((match) => match[1] ?? '')
    .sort();

  it('copies exactly the packages the worker depends on, transitively', () => {
    expect(copied).toEqual(workspaceClosure());
  });

  it('does not copy the whole packages directory', () => {
    expect(dockerfile).not.toMatch(/^COPY packages packages$/mu);
  });
});
