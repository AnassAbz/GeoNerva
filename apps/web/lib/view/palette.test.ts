/**
 * The palette is accessible by test, not by intent: every text colour is checked against every
 * surface it is drawn on for WCAG AA (4.5:1), and map/graphic colours for the 3:1 non-text
 * contrast of WCAG 2.2 SC 1.4.11. The CSS tokens must equal the TypeScript values the map uses.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PALETTE, type PaletteToken } from './palette.ts';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

const SURFACES: readonly PaletteToken[] = ['canvas', 'surface', 'raised'];

const TEXT: readonly PaletteToken[] = [
  'fg',
  'fg-muted',
  'fg-subtle',
  'link',
  'eq',
  'fire',
  'flood',
  'cyclone',
  'other',
  'weather',
  'critical',
  'fresh',
  'degraded',
  'stale',
  'unavailable',
  'rel-low',
  'rel-moderate',
  'rel-high',
  'rel-critical',
  'derived',
];

describe('palette contrast (WCAG AA)', () => {
  for (const surface of SURFACES) {
    for (const text of TEXT) {
      it(`${text} on ${surface} is at least 4.5:1`, () => {
        expect(contrast(PALETTE[text], PALETTE[surface])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('the focus ring is at least 3:1 against every surface', () => {
    for (const surface of SURFACES) {
      expect(contrast(PALETTE.focus, PALETTE[surface])).toBeGreaterThanOrEqual(3);
    }
  });

  it('the primary button text (canvas on link) is at least 4.5:1', () => {
    expect(contrast(PALETTE.canvas, PALETTE.link)).toBeGreaterThanOrEqual(4.5);
  });

  it('the contrast helper is correct on a known pair', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
});

describe('globals.css matches palette.ts', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../app/globals.css', import.meta.url)),
    'utf8',
  );
  const declared = new Map(
    [...css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6});/giu)].map((match) => [
      match[1] ?? '',
      (match[2] ?? '').toLowerCase(),
    ]),
  );

  for (const [token, value] of Object.entries(PALETTE)) {
    it(`--color-${token} is ${value}`, () => {
      expect(declared.get(token)).toBe(value);
    });
  }

  it('declares no colour token the palette does not know', () => {
    expect([...declared.keys()].sort()).toEqual(Object.keys(PALETTE).sort());
  });
});
