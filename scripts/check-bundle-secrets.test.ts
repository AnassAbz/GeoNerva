import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SECRET_ENV_VARS,
  canaryMarker,
  canaryValue,
  findCanaries,
  markerEncodings,
} from './check-bundle-secrets.ts';

const dirs: string[] = [];
function fakeNextDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gn-next-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bundle secret canaries', () => {
  const marker = canaryMarker('RATE_LIMIT_SECRET');

  it('covers every secret variable with a distinct marker embedded in its value', () => {
    const markers = SECRET_ENV_VARS.map(canaryMarker);
    expect(new Set(markers).size).toBe(SECRET_ENV_VARS.length);
    for (const name of SECRET_ENV_VARS) expect(canaryValue(name)).toContain(canaryMarker(name));
    expect(URL.canParse(canaryValue('DATABASE_URL'))).toBe(true);
  });

  it('detects a canary in a client chunk and in prerendered HTML', () => {
    const next = fakeNextDir({
      'static/chunks/app.js': `var k="${marker}";`,
      'server/app/index.html': `<p>${marker}</p>`,
    });
    expect(findCanaries(next, [marker])).toHaveLength(2);
  });

  it('scans error pages the server serves (R-1)', () => {
    const next = fakeNextDir({ 'server/pages/500.html': `<p>${marker}</p>` });
    expect(findCanaries(next, [marker])).toHaveLength(1);
  });

  it('detects a base64-encoded canary (R-2)', () => {
    const encoded = Buffer.from(marker, 'utf8').toString('base64');
    const next = fakeNextDir({ 'static/chunks/a.js': `var k="${encoded}";` });
    expect(findCanaries(next, [marker])[0]).toContain('(encoded)');
  });

  it('reports each occurrence once, not once per equivalent encoding', () => {
    const encodings = markerEncodings(marker);
    expect(new Set(encodings).size).toBe(encodings.length);
    expect(findCanaries(fakeNextDir({ 'static/chunks/a.js': marker }), [marker])).toHaveLength(1);
  });

  it('ignores server-side JavaScript chunks, which never reach the browser', () => {
    const next = fakeNextDir({ 'server/chunks/route.js': `process.env.X="${marker}"` });
    expect(findCanaries(next, [marker])).toEqual([]);
  });

  it('passes on clean output and tolerates a missing directory', () => {
    expect(findCanaries(fakeNextDir({ 'static/a.js': 'ok' }), [marker])).toEqual([]);
    expect(findCanaries(join(tmpdir(), 'gn-does-not-exist'), [marker])).toEqual([]);
  });
});
