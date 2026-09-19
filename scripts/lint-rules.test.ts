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

  it.each([
    ['env key', 'export default { env: { DB: "x" } };'],
    ['compiler.define', 'export default { compiler: { define: { DB: "x" } } };'],
    ['env assignment', 'const c = {}; c.env = { DB: "x" }; export default c;'],
    [
      'DefinePlugin',
      'export default { webpack: (c, o) => { c.plugins.push(new o.webpack.DefinePlugin({})); return c; } };',
    ],
  ])('forbids next.config inlining channel: %s', async (_label, code) => {
    expect(await firedRules(code, 'apps/web/next.config.mjs')).toContain('no-restricted-syntax');
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
    ['window.document.write', 'export function f(h) { window.document.write(h); }'],
    ['setHTMLUnsafe', 'export function f(el, h) { el.setHTMLUnsafe(h); }'],
    [
      'Object.assign innerHTML',
      'export function f(el, h) { Object.assign(el, { innerHTML: h }); }',
    ],
    ['iframe srcDoc prop', 'export const A = (p) => <iframe title="x" srcDoc={p.h} />;'],
    ['srcdoc property', 'export function f(el, h) { el.srcdoc = h; }'],
    ['event-handler attribute', "export function f(el, h) { el.setAttribute('onclick', h); }"],
    [
      'createContextualFragment',
      'export function f(r, h) { return r.createContextualFragment(h); }',
    ],
  ])('%s', async (_label, code) => {
    expect(await firedRules(code, WEB_JSX)).toContain('no-restricted-syntax');
  });

  it.each([
    ['eval', 'export const f = (s) => eval(s);', 'no-eval'],
    ['new Function', "export const f = (s) => new Function('x', s);", 'no-new-func'],
    ['string setTimeout', "export const f = () => setTimeout('alert(1)', 1);", 'no-implied-eval'],
  ])('forbids %s', async (_label, code, rule) => {
    expect(await firedRules(code, WEB_MJS)).toContain(rule);
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

  it.each([
    ['globalThis.fetch', "export const r = globalThis.fetch('https://example.org');"],
    ['bracket global', "export const r = globalThis['fetch']('https://example.org');"],
    ['window.fetch', "export const r = window.fetch('https://example.org');"],
    ['self.XMLHttpRequest', 'export const r = new self.XMLHttpRequest();'],
  ])('forbids %s', async (_label, code) => {
    expect(await firedRules(code, WORKER)).toContain('no-restricted-properties');
  });

  it('forbids globalThis.process in pure engines', async () => {
    expect(
      await firedRules("export const v = globalThis.process.env['X'];", PURE_ENGINE),
    ).toContain('no-restricted-properties');
  });

  it('forbids fetch in all web code, including server components and client components (N-1)', async () => {
    expect(await firedRules("export const r = fetch('https://example.org');", WEB_MJS)).toContain(
      'no-restricted-globals',
    );
    expect(
      await firedRules("export const r = fetch('/api/v1/sources/status');", WEB_JSX),
    ).toContain('no-restricted-globals');
  });

  it('exempts only the same-origin API client module in the web app', async () => {
    const severity = async (file: string, rule: string): Promise<unknown> => {
      const config = (await eslint.calculateConfigForFile(file)) as {
        rules: Record<string, unknown[]>;
      };
      // ESLint keeps earlier options when a later block sets a rule to "off"; severity decides.
      return config.rules[rule]?.[0];
    };
    const client = 'apps/web/lib/client/api-client.ts';
    const neighbour = 'apps/web/lib/client/other.ts';
    for (const rule of ['no-restricted-globals', 'no-restricted-properties']) {
      expect(await severity(client, rule)).toBe(0);
      expect(await severity(neighbour, rule)).toBe(2);
    }
  });

  it('allows fetch in operational scripts', async () => {
    expect(await firedRules("export const r = fetch('https://example.org');", SCRIPT)).toEqual([]);
  });
});
