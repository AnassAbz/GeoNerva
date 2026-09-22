/**
 * The colour tokens, as values. `app/globals.css` declares the same tokens for Tailwind, and
 * `palette.test.ts` checks that the two agree and that every text pairing meets WCAG AA.
 *
 * The map needs literal colours (MapLibre paint properties cannot read CSS variables), which is
 * why the values live here rather than only in CSS.
 *
 * Family colours follow docs/PRODUCT.md §6.5: amber earthquakes, orange fire activity, blue
 * floods, violet cyclones, and red reserved for CRITICAL. Colour is never the only carrier of
 * meaning: every family also has a shape and a pattern, and every status a text label.
 */
export const PALETTE = {
  canvas: '#0b0f14',
  surface: '#121821',
  raised: '#1a2230',
  line: '#2c3748',
  fg: '#e6edf3',
  'fg-muted': '#b3bfcc',
  'fg-subtle': '#95a3b3',
  link: '#8cc8ff',
  focus: '#ffd166',

  eq: '#f2b233',
  fire: '#ff8a3d',
  flood: '#5aa9ff',
  cyclone: '#b69cff',
  other: '#4fd1c5',
  weather: '#a3b1c2',
  critical: '#ff5c5c',

  fresh: '#5fd38d',
  degraded: '#f2cc60',
  stale: '#ffa36c',
  unavailable: '#c9d1db',

  'rel-low': '#a3b1c2',
  'rel-moderate': '#f2cc60',
  'rel-high': '#ff9b6a',
  'rel-critical': '#ff5c5c',

  derived: '#9fc5ff',
} as const;

export type PaletteToken = keyof typeof PALETTE;
