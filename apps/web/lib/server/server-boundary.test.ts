/**
 * Nothing that runs in a browser imports the server's modules (security finding F-8).
 *
 * §3a asks for this to be enforced by a `server-only` import, whose trick is that its package
 * exports map resolves to a module that throws during the client build. That package is not in
 * this workspace's offline store, and reaching for the network to add one dependency is a worse
 * trade than enforcing the same rule here: a scan at `pnpm check` time fails the build just as a
 * bad import would, and it states the rule in one place instead of repeating a magic import in
 * every server module.
 *
 * What it protects: `lib/server/config.ts` holds the validated environment — `DATABASE_URL`,
 * `RATE_LIMIT_SECRET`, `FIRMS_MAP_KEY` — and `lib/server/db.ts` holds the pool. Today nothing
 * reaches them from a client component, and `pnpm build:canary` confirms no secret canary appears
 * in the client bundles; this is what keeps that true after the next refactor, when a shared
 * helper quietly grows an import and Turbopack follows it into the browser.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const SKIP = new Set(['.next', 'node_modules', 'e2e']);

/** Every `.ts`/`.tsx` module of the app, excluding build output and tests. */
function sourceFiles(directory: string = WEB_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) files.push(...sourceFiles(join(directory, entry.name)));
    } else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

/** `'use client'` or `"use client"` as the module's directive, not a mention inside it. */
function isClientModule(source: string): boolean {
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*)?['"]use client['"]/u.test(source);
}

function importsServerModule(source: string): boolean {
  return (
    /from\s+['"][^'"]*\blib\/server\//u.test(source) || /lib\/server\/(config|db)\.ts/u.test(source)
  );
}

describe('the server boundary', () => {
  it('has client modules, so the scan is looking at something', () => {
    const clients = sourceFiles().filter((file) => isClientModule(readFileSync(file, 'utf8')));
    expect(clients.length).toBeGreaterThan(0);
  });

  it('is not crossed by any client module', () => {
    const offenders = sourceFiles().filter((file) => {
      const source = readFileSync(file, 'utf8');
      return isClientModule(source) && importsServerModule(source);
    });
    expect(offenders.map((file) => file.slice(WEB_ROOT.length))).toEqual([]);
  });
});
