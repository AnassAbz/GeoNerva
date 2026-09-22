/**
 * The copy `@geonerva/baselines` composes, scanned against the terminology rules (ARCHITECTURE
 * §8.5, §11.4).
 *
 * Here rather than in the baselines package because the lexicon lives in this one and baselines
 * may not depend on it. Every status and band the engine can produce is exercised, including
 * `FIRE_TREND`'s, which `/history` does not serve yet (ADR-040) — so the day it is served its copy
 * is already known to be clean.
 */

import { describe, expect, it } from 'vitest';

import {
  AFTERSHOCK_CAVEAT,
  EARTHQUAKE_ELEVATED_CAVEAT,
  earthquakeCountBaseline,
  fireTrend,
  gdacsContext,
  type Completeness,
  type FireDay,
  type QuakeRecord,
} from '@geonerva/baselines';

import { isLexiconClean, scanLexicon } from './lexicon.ts';

const DAY = 24 * 60 * 60 * 1000;
const AS_OF = new Date('2026-09-21T00:00:00.000Z');
const MANDATED_CAVEATS = [EARTHQUAKE_ELEVATED_CAVEAT, AFTERSHOCK_CAVEAT];

function quakes(perWindow: readonly number[], observed: number, magnitude = 5): QuakeRecord[] {
  const events: QuakeRecord[] = [];
  const currentStart = AS_OF.getTime() - 7 * DAY;
  perWindow.forEach((count, index) => {
    for (let n = 0; n < count; n += 1) {
      events.push({
        observedAt: new Date(currentStart - (index + 0.5) * 7 * DAY),
        magnitude,
        distanceKm: 20,
        publicId: `EQ-26-R${String(index)}N${String(n)}`,
      });
    }
  });
  for (let n = 0; n < observed; n += 1) {
    events.push({
      observedAt: new Date(AS_OF.getTime() - (n + 1) * 3_600_000),
      magnitude: n === 0 ? 6.4 : magnitude,
      distanceKm: 20,
      publicId: `EQ-26-C${String(n)}`,
    });
  }
  return events;
}

function texts(
  perWindow: readonly number[],
  observed: number,
  completeness: Completeness,
): string[] {
  const result = earthquakeCountBaseline({
    asOf: AS_OF,
    radiusKm: 150,
    windowDays: 7,
    referenceFrom: new Date(AS_OF.getTime() - 7 * DAY - perWindow.length * 7 * DAY),
    completeness,
    events: quakes(perWindow, observed),
  });
  return [
    result.interpretation,
    result.completenessStatement,
    ...result.caveats,
    result.rarity?.text,
    result.largestRecent?.text,
    result.sequenceContext?.text,
    result.sequenceContext?.caveat,
  ].filter((text): text is string => text !== undefined);
}

const ones = (n: number, events: number): number[] =>
  Array.from({ length: n }, (_, index) => (index < events ? 1 : 0));

describe('baseline copy', () => {
  it('is clean for every earthquake status, band and completeness method', () => {
    const all = [
      ...texts(ones(52, 20), 0, { threshold: 4.5, method: 'FALLBACK', eventsAboveCandidate: null }),
      ...texts(ones(52, 20), 3, {
        threshold: 3.1,
        method: 'MAXIMUM_CURVATURE',
        eventsAboveCandidate: 80,
      }),
      ...texts(ones(52, 19), 1, {
        threshold: 4.5,
        method: 'RETENTION_FLOOR',
        eventsAboveCandidate: null,
      }),
      ...texts(ones(51, 0), 0, { threshold: 4.5, method: 'FALLBACK', eventsAboveCandidate: null }),
    ];
    // The mandated caveats are among them, so the exemption is exercised, not assumed.
    expect(all).toContain(EARTHQUAKE_ELEVATED_CAVEAT);
    expect(all).toContain(AFTERSHOCK_CAVEAT);
    for (const text of all) {
      expect(isLexiconClean(text, { verbatimQuotes: MANDATED_CAVEATS }), text).toBe(true);
    }
  });

  it('excuses the mandated caveat only verbatim, never a sentence GeoNerva composed', () => {
    expect(scanLexicon(EARTHQUAKE_ELEVATED_CAVEAT).map((hit) => hit.lexiconClass)).toEqual([
      'PREDICTION',
    ]);
    expect(
      isLexiconClean('A larger earthquake will occur.', { verbatimQuotes: MANDATED_CAVEATS }),
    ).toBe(false);
    expect(
      isLexiconClean(`${EARTHQUAKE_ELEVATED_CAVEAT} Another will occur soon.`, {
        verbatimQuotes: MANDATED_CAVEATS,
      }),
    ).toBe(false);
  });

  it('is clean for every fire trend band and for GDACS context', () => {
    const days = (previous: number, recent: number, covered = true): FireDay[] =>
      Array.from({ length: 35 }, (_, index) => ({
        day: `d${String(index)}`,
        detections: index < 28 ? previous : recent,
        covered: covered || index < 28,
      }));
    const all = [
      fireTrend(days(20, 30)).interpretation,
      fireTrend(days(30, 20)).interpretation,
      fireTrend(days(30, 3)).interpretation,
      fireTrend(days(5, 5)).interpretation,
      fireTrend(days(5, 5, false)).interpretation,
      gdacsContext({ asOf: AS_OF, noun: ['flood event', 'flood events'], count: 1 }).interpretation,
      gdacsContext({ asOf: AS_OF, noun: ['flood event', 'flood events'], count: 0 }).interpretation,
    ];
    for (const text of all) {
      expect(isLexiconClean(text, { thermalContext: true }), text).toBe(true);
    }
  });
});
