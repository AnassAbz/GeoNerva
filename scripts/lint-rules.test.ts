/**
 * Regression tests for the security-relevant lint rules (docs/SECURITY.md C2, H1, M1;
 * docs/reviews/security-p1.md F-1, F-3, F-4, F-9). Each case lints an in-memory snippet
 * against the real repository configuration and asserts which rules fire.
 */
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('..', import.meta.url)) });

async function firedRules(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  if (result === undefined) throw new Error('no lint result');
  const fatal = result.messages.filter((m) => m.fatal === true);
  if (fatal.length > 0) throw new Error(`parse error: ${fatal.map((m) => m.message).join('; ')}`);
  return result.messages.map((m) => m.ruleId ?? '(none)');
}

// Untyped files keep these tests fast and independent of the TypeScript project service.
const WEB_JSX = 'apps/web/app/__probe__.jsx';
const WEB_MJS = 'apps/web/app/__probe__.mjs';
const PURE_ENGINE = 'packages/geo/src/__probe__.mjs';
const WORKER = 'apps/worker/src/__probe__.mjs';
const SCRIPT = 'scripts/__probe__.mjs';

describe('NEXT_PUBLIC_* is denied in every syntactic form (F-1)', () => {
  it.each([
    ['dot access', 'export const v = process.env.NEXT_PUBLIC_DB_URL;'],
    ['bracket access', "export const v = process.env['NEXT_PUBLIC_PROBE_SECRET_KEY'];"],
    [
      'destructuring',
      'const { NEXT_PUBLIC_API_TOKEN } = process.env; export { NEXT_PUBLIC_API_TOKEN };',
    ],
    ['template literal', 'export const v = process.env[`NEXT_PUBLIC_X`];'],
    ['innocent-looking name', 'export const v = process.env.NEXT_PUBLIC_MAP_STYLE;'],
  ])('%s', async (_label, code) => {
    expect(await firedRules(code, WEB_MJS)).toContain('no-restricted-syntax');
  });

  it('also applies outside the web app', async () => {
    expect(await firedRules("export const v = process.env['NEXT_PUBLIC_X'];", WORKER)).toContain(
      'no-restricted-syntax',
    );
  });

  it('forbids the next.config `env` key, which inlines variables regardless of prefix', async () => {
    expect(
      await firedRules('export default { env: { DB: "x" } };', 'apps/web/next.config.mjs'),
    ).toContain('no-restricted-syntax');
  });

  it('allows ordinary server-side environment access', async () => {
    expect(await firedRules("export const v = process.env['DATABASE_URL'];", WORKER)).toEqual([]);
  });
});

describe('raw HTML sinks are forbidden (F-3)', () => {
  it.each([
    ['JSX prop', 'export const A = (p) => <div dangerouslySetInnerHTML={{ __html: p.h }} />;'],
    [
      'createElement',
      "import { createElement } from 'react'; export const A = (p) => createElement('div', { dangerouslySetInnerHTML: { __html: p.h } });",
    ],
    ['innerHTML assignment', 'export function f(el, h) { el.innerHTML = h; }'],
    ['bracket innerHTML', "export function f(el, h) { el['innerHTML'] = h; }"],
    ['outerHTML', 'export function f(el, h) { el.outerHTML = h; }'],
    ['insertAdjacentHTML', "export function f(el, h) { el.insertAdjacentHTML('beforeend', h); }"],
    ['document.write', 'export function f(h) { document.write(h); }'],
    [
      'createContextualFragment',
      'export function f(r, h) { return r.createContextualFragment(h); }',
    ],
  ])('%s', async (_label, code) => {
    expect(await firedRules(code, WEB_JSX)).toContain('no-restricted-syntax');
  });

  it('lints .jsx files in the web app', async () => {
    expect(await firedRules('export const A = () => <div>ok</div>;', WEB_JSX)).toEqual([]);
  });
});

describe('direct network access is confined to @geonerva/http (F-4, F-9)', () => {
  it('forbids fetch in pure engines, the worker and web server code', async () => {
    expect(
      await firedRules("export const r = fetch('https://example.org');", PURE_ENGINE),
    ).toContain('no-restricted-globals');
    expect(await firedRules("export const r = fetch('https://example.org');", WORKER)).toContain(
      'no-restricted-globals',
    );
    expect(
      await firedRules(
        "export const r = fetch('https://example.org');",
        'apps/web/lib/server/x.mjs',
      ),
    ).toContain('no-restricted-globals');
  });

  it('forbids process in pure engines', async () => {
    expect(await firedRules("export const v = process.env['X'];", PURE_ENGINE)).toContain(
      'no-restricted-globals',
    );
  });

  it('allows same-origin fetch from browser code and fetch in operational scripts', async () => {
    expect(await firedRules("export const r = fetch('/api/v1/sources/status');", WEB_MJS)).toEqual(
      [],
    );
    expect(await firedRules("export const r = fetch('https://example.org');", SCRIPT)).toEqual([]);
  });
});
