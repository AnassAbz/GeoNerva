/**
 * Language rules (docs/PRODUCT.md §7) for the words the UI writes itself.
 *
 * Two sources of UI-authored text are scanned:
 *  1. every string in `COPY` (functions are called with sample arguments);
 *  2. every string literal and JSX text in the UI's own source — pages, components and the view
 *     layer — found with the TypeScript parser, so a sentence written inline instead of in `COPY`
 *     is still checked.
 *
 * The scanner is the repository's own (`scanLexicon` from `@geonerva/briefing`, the same one that
 * gates the templates and AI output), run with `thermalContext: true` because the UI must never
 * call anything a wildfire. §7 phrases the scanner does not cover are checked locally.
 *
 * Read-model text (headlines, reasons, provider caveats) is the API's and is not scanned here; the
 * fixtures that stand in for it are excluded.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanLexicon } from '@geonerva/briefing';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { COPY } from './copy.ts';

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** §7 rows the lexicon scanner does not already enforce. */
const LOCAL_RULES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: '"normal" (with thin data)', pattern: /\bnormal\b/iu },
  { name: 'a zero count for a failed source', pattern: /\b0 (fires|detections|earthquakes)\b/iu },
  { name: '"flooded area" for a GDACS model', pattern: /\bflooded area\b/iu },
  { name: '"N sources agree" counting copies', pattern: /\b\d+ sources agree\b/iu },
  { name: 'a single risk score', pattern: /\brisk score\b/iu },
];

/**
 * PRODUCT §7's own prescribed wording. The scanner forbids "real-time" as a substring, which is
 * right, and this is the one sentence §7 tells the UI to say instead; it is excused verbatim, by
 * the scanner's own position-sensitive exemption, and nowhere else.
 */
const SANCTIONED = ['Near-real-time; each source’s delay is shown'];

function violations(text: string): string[] {
  const hits = scanLexicon(text, { thermalContext: true, verbatimQuotes: SANCTIONED }).map(
    (hit) => `${hit.lexiconClass}: "${hit.phrase}"`,
  );
  for (const rule of LOCAL_RULES) if (rule.pattern.test(text)) hits.push(rule.name);
  return hits;
}

function copyStrings(value: unknown, path: string, out: [string, string][]): void {
  if (typeof value === 'string') out.push([path, value]);
  else if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown;
    out.push([`${path}()`, String(fn(1, 'Earthquakes'))]);
    out.push([`${path}(3)`, String(fn(3, 'Earthquakes'))]);
  } else if (Array.isArray(value))
    value.forEach((entry, index) => {
      copyStrings(entry, `${path}[${String(index)}]`, out);
    });
  else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) copyStrings(entry, `${path}.${key}`, out);
  }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(WEB_ROOT, path).replaceAll('\\', '/');
    if (statSync(path).isDirectory()) {
      if (['node_modules', '.next', 'api', 'fixtures', 'e2e', 'test'].includes(name)) continue;
      sourceFiles(path, out);
    } else if (
      /\.(ts|tsx)$/u.test(name) &&
      !/\.test\.tsx?$/u.test(name) &&
      !rel.endsWith('.d.ts')
    ) {
      out.push(path);
    }
  }
  return out;
}

/** String literals and JSX text in one file, skipping module paths and class lists. */
function uiStrings(file: string): { text: string; line: number }[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node, inClassName: boolean): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const className =
      inClassName ||
      (ts.isJsxAttribute(node) && ['className', 'd', 'viewBox'].includes(node.name.getText()));
    const text = ts.isJsxText(node)
      ? node.text
      : ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ? node.text
        : null;
    if (
      text !== null &&
      !className &&
      text.trim() !== '' &&
      !/^[A-Z0-9_:#.-]+$/u.test(text.trim())
    ) {
      found.push({ text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, (child) => {
      visit(child, className);
    });
  };
  visit(source, false);
  return found;
}

describe('the UI’s own copy obeys PRODUCT §7', () => {
  const strings: [string, string][] = [];
  copyStrings(COPY, 'COPY', strings);

  it('COPY has strings to check (the scan is not vacuous)', () => {
    expect(strings.length).toBeGreaterThan(150);
  });

  it('no string in COPY uses prohibited language', () => {
    const bad = strings.flatMap(([path, text]) =>
      violations(text).map((hit) => `${path}: ${hit} in "${text}"`),
    );
    expect(bad).toEqual([]);
  });

  const files = [
    ...sourceFiles(join(WEB_ROOT, 'app')),
    ...sourceFiles(join(WEB_ROOT, 'components')),
    ...sourceFiles(join(WEB_ROOT, 'lib', 'view')),
  ];

  it('scans the UI source files (the scan is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.endsWith('hazard-card.tsx'))).toBe(true);
  });

  it('no string literal or JSX text in the UI source uses prohibited language', () => {
    const bad = files.flatMap((file) =>
      uiStrings(file).flatMap(({ text, line }) =>
        violations(text).map(
          (hit) => `${relative(WEB_ROOT, file)}:${String(line)}: ${hit} in "${text.trim()}"`,
        ),
      ),
    );
    expect(bad).toEqual([]);
  });

  it('the checks catch what they are for', () => {
    expect(violations('You are safe here.')).not.toEqual([]);
    expect(violations('Real-time fire map')).not.toEqual([]);
    expect(violations('A wildfire 12 km away')).not.toEqual([]);
    expect(violations('Activity is normal.')).not.toEqual([]);
    expect(violations('0 fires nearby')).not.toEqual([]);
    expect(violations('Flooded area')).not.toEqual([]);
    expect(violations('3 sources agree')).not.toEqual([]);
    expect(violations('Near-real-time; each source’s delay is shown.')).toEqual([]);
    expect(violations('Near-real-time updates.')).not.toEqual([]);
  });
});
