/**
 * `/methodology` renders every threshold from the exported constant the engine uses.
 *
 * This file is the guard behind the claim the page makes about itself. Each expectation builds its
 * own pattern **from the constant**, so:
 *
 *  - changing a constant moves the page, and any expectation still describing the old value fails;
 *  - a number typed into `COPY` or into `sections.tsx` fails as soon as its constant moves, which
 *    is the drift PRODUCT §6.9's page exists to prevent.
 *
 * It also pins the four mandated caveats to their exported wording, the section ids (they are
 * anchor targets — `/methodology#fire-trend` is linked from `/history` responses), and ADR-040's
 * two honest limitations of the fire trend.
 */

import { existsSync, readFileSync } from 'node:fs';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  AFTERSHOCK_CAVEAT,
  BASELINE_METHOD_VERSION,
  EARTHQUAKE_BASELINE,
  EARTHQUAKE_ELEVATED_CAVEAT,
  FIRE_TREND,
  GDACS_CONTEXT,
  RETENTION_FLOOR_MAGNITUDE,
} from '@geonerva/baselines';
import { MATERIALITY, MAX_HEADLINE, PROMINENCE_BANDS } from '@geonerva/changes';
import {
  CANDIDATE_WINDOW,
  DECISION,
  EARTHQUAKE_ALGORITHM_VERSION,
  MAGNITUDE_VETO,
  MISFIT_SCALES,
} from '@geonerva/correlation';
import {
  AUTHORITATIVE_ALERT_RADIUS_KM,
  CYCLONE_TRACK_KM,
  DEEP_FOCUS_KM,
  EARTHQUAKE_BANDS,
  FELT_REPORTS_THRESHOLD,
  FIRE_HIGH_DETECTIONS_24H,
  FIRE_HIGH_OVERPASSES_24H,
  FIRE_MID_KM,
  FIRE_NEAR_KM,
  FIRE_OUTER_KM,
  FLOOD_MODELLED_AREA_CAVEAT,
  FLOOD_OUTER_KM,
  THERMAL_DETECTION_CAVEAT,
  VOLCANO_NEAR_KM,
} from '@geonerva/relevance';

import { sourceStatusFixture } from '../../lib/fixtures/index.ts';
import { METHODOLOGY_SECTIONS, MethodologySections } from './sections.tsx';

function renderPage(): HTMLElement {
  const { container } = render(<MethodologySections sources={sourceStatusFixture().sources} />);
  return container;
}

/** The page's whole visible text, whitespace-collapsed so a wrapped sentence still matches. */
function pageText(): string {
  return renderPage().textContent.replace(/\s+/gu, ' ');
}

/**
 * The source of `lib/view/copy.ts`.
 *
 * Read from disk rather than through `import.meta.url`, which in jsdom is an http URL and not a
 * path. The two candidates cover being run from the workspace root and from `apps/web`.
 */
function readCopySource(): string {
  for (const candidate of ['apps/web/lib/view/copy.ts', 'lib/view/copy.ts']) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error('copy.ts was not found from this test’s working directory');
}

/** `1.0` must not be satisfied by a stray `1.05`: the number is bounded on both sides. */
function containsNumber(text: string, value: string): boolean {
  const escaped = value.replaceAll('.', '\\.');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`, 'u').test(text);
}

describe('the methodology page’s structure', () => {
  it('keeps the section ids that are linked as anchors', () => {
    const container = renderPage();
    for (const section of METHODOLOGY_SECTIONS) {
      expect(container.querySelector(`section#${section.id}`)).not.toBeNull();
    }
    // The one linked from a history response, named explicitly so a rename cannot pass quietly.
    expect(container.querySelector('section#fire-trend')).not.toBeNull();
  });

  it('gives every section a heading that labels it', () => {
    const container = renderPage();
    for (const section of METHODOLOGY_SECTIONS) {
      const element = container.querySelector(`section#${section.id}`);
      expect(element?.getAttribute('aria-labelledby')).toBe(`${section.id}-title`);
      expect(container.querySelector(`#${section.id}-title`)?.textContent).toBe(section.title);
    }
  });

  it('states each source’s own cadence and latency, from its health policy', () => {
    const container = renderPage();
    const firms = container.querySelector('[data-source="firms"]');
    expect(firms).not.toBeNull();
    expect(firms?.textContent).toContain('30 min');
    expect(firms?.textContent).toContain('6 h');
  });
});

describe('every threshold on the page is the engine’s own constant', () => {
  it('renders the correlation thresholds', () => {
    const text = pageText();
    expect(containsNumber(text, String(CANDIDATE_WINDOW.maxDeltaSeconds))).toBe(true);
    expect(text).toContain(`${String(CANDIDATE_WINDOW.maxDistanceMeters / 1000)} km`);
    expect(text).toContain(`${String(MISFIT_SCALES.timeSeconds)} s`);
    expect(text).toContain(`${String(MISFIT_SCALES.distanceMeters / 1000)} km`);
    expect(containsNumber(text, MISFIT_SCALES.magnitude.toFixed(1))).toBe(true);
    expect(containsNumber(text, DECISION.matchMisfit.toFixed(1))).toBe(true);
    expect(containsNumber(text, DECISION.uniquenessGap.toFixed(1))).toBe(true);
    expect(containsNumber(text, DECISION.possibleMisfit.toFixed(1))).toBe(true);
    expect(containsNumber(text, MAGNITUDE_VETO.toFixed(1))).toBe(true);
    expect(text).toContain(EARTHQUAKE_ALGORITHM_VERSION);
  });

  it('renders every earthquake relevance band as the table says it', () => {
    const text = pageText();
    for (const band of EARTHQUAKE_BANDS) {
      expect(text).toContain(
        `M ${band.minMagnitude.toFixed(1)} or greater within ${String(band.maxDistanceKm)} km`,
      );
    }
    expect(text).toContain(`${String(DEEP_FOCUS_KM)} km deep`);
    expect(text).toContain(`${String(AUTHORITATIVE_ALERT_RADIUS_KM)} km`);
    expect(containsNumber(text, String(FELT_REPORTS_THRESHOLD))).toBe(true);
  });

  it('renders the fire, flood, cyclone and volcano distances', () => {
    const text = pageText();
    for (const value of [
      FIRE_NEAR_KM,
      FIRE_MID_KM,
      FIRE_OUTER_KM,
      FLOOD_OUTER_KM,
      CYCLONE_TRACK_KM,
      VOLCANO_NEAR_KM,
    ]) {
      expect(text).toContain(`${String(value)} km`);
    }
    expect(containsNumber(text, String(FIRE_HIGH_DETECTIONS_24H))).toBe(true);
    expect(containsNumber(text, String(FIRE_HIGH_OVERPASSES_24H))).toBe(true);
  });

  it('renders the earthquake baseline’s Mc, window, reference period and OK conditions', () => {
    const text = pageText();
    expect(text).toContain(`${String(EARTHQUAKE_BASELINE.mcReferenceRadiusKm)} km`);
    expect(containsNumber(text, EARTHQUAKE_BASELINE.mcFallback.toFixed(1))).toBe(true);
    expect(containsNumber(text, String(EARTHQUAKE_BASELINE.mcMinimumEvents))).toBe(true);
    expect(containsNumber(text, EARTHQUAKE_BASELINE.mcCorrection.toFixed(1))).toBe(true);
    expect(text).toContain(EARTHQUAKE_BASELINE.radiiKm.map(String).join(' / '));
    expect(text).toContain(`${String(EARTHQUAKE_BASELINE.primaryWindowDays)} days`);
    expect(containsNumber(text, String(EARTHQUAKE_BASELINE.referenceYears))).toBe(true);
    // The two halves of `status = OK`, which must not be reported as one condition.
    expect(containsNumber(text, String(EARTHQUAKE_BASELINE.minimumWindows))).toBe(true);
    expect(containsNumber(text, String(EARTHQUAKE_BASELINE.minimumEvents))).toBe(true);
    expect(text).toContain(`${String(EARTHQUAKE_BASELINE.abovePercentile)}th percentile`);
    expect(text).toContain(`${String(EARTHQUAKE_BASELINE.wellAbovePercentile)}th percentile`);
    expect(containsNumber(text, RETENTION_FLOOR_MAGNITUDE.toFixed(1))).toBe(true);
    expect(text).toContain(BASELINE_METHOD_VERSION);
  });

  it('renders the fire trend as 7 days against the previous 28, per covered day', () => {
    const text = pageText();
    expect(text).toContain(
      `the last ${String(FIRE_TREND.recentDays)} days against the previous ` +
        `${String(FIRE_TREND.previousDays)} days, within ${String(FIRE_TREND.radiusKm)} km`,
    );
    expect(text).toContain('per covered day');
  });

  it('renders both halves of the fire trend’s rule, and never one alone', () => {
    const text = pageText();
    const relative = `${String(Math.round(FIRE_TREND.minimumRelativeChange * 100))} %`;
    const absolute = `${String(FIRE_TREND.minimumAbsolutePerDay)} detections a day`;
    expect(text).toContain(`at least ${relative} and by at least ${absolute}`);
  });

  it('renders the GDACS context radius and span', () => {
    const text = pageText();
    expect(text).toContain(`${String(GDACS_CONTEXT.radiusKm)} km`);
    expect(text).toContain(`${String(GDACS_CONTEXT.years)} years`);
  });

  it('renders the What Changed materiality thresholds and prominence bands', () => {
    const text = pageText();
    expect(containsNumber(text, MATERIALITY.magnitude.toFixed(1))).toBe(true);
    expect(text).toContain(`${String(MATERIALITY.epicentreKm)} km`);
    expect(text).toContain(`${String(MATERIALITY.depthKm)} km`);
    expect(containsNumber(text, String(PROMINENCE_BANDS.headline))).toBe(true);
    expect(containsNumber(text, String(PROMINENCE_BANDS.listed))).toBe(true);
    expect(containsNumber(text, String(PROMINENCE_BANDS.detail))).toBe(true);
    expect(containsNumber(text, String(MAX_HEADLINE))).toBe(true);
  });
});

describe('no threshold is typed into the methodology copy', () => {
  /**
   * The strongest form of the guarantee, and the one that fails *today* rather than on the next
   * change to a constant: there is no numeric literal anywhere in `COPY.methodology`.
   *
   * Digits that are part of an identifier — `FIRE_HIGH_DETECTIONS_24H`, `dec2` — are not literals
   * and are skipped by the lookarounds. Everything else is a number someone typed into the copy
   * instead of reading it from the engine, which is exactly what this page must not contain.
   */
  it('contains no numeric literal at all', () => {
    const source = readCopySource();
    const open = source.indexOf('\n  methodology: {');
    const close = source.indexOf('\n  notFound: {');
    // If the block cannot be located the scan would pass vacuously, so both anchors are asserted.
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);

    const block = source.slice(open, close);
    const literals = block.match(/(?<![A-Za-z_])\d+(?![A-Za-z_])/gu) ?? [];
    expect(literals).toEqual([]);
  });

  it('the scan catches a number typed in (it is not vacuous)', () => {
    const planted = '\n  methodology: {\n    value: `within 100 km`,\n  },\n  notFound: {';
    const open = planted.indexOf('\n  methodology: {');
    const close = planted.indexOf('\n  notFound: {');
    const literals = planted.slice(open, close).match(/(?<![A-Za-z_])\d+(?![A-Za-z_])/gu) ?? [];
    expect(literals).toEqual(['100']);
  });
});

describe('the mandated caveats appear in the engine’s own wording', () => {
  it('renders the thermal-detection and modelled-flood caveats verbatim', () => {
    renderPage();
    expect(screen.getAllByText(THERMAL_DETECTION_CAVEAT).length).toBeGreaterThan(0);
    expect(screen.getAllByText(FLOOD_MODELLED_AREA_CAVEAT).length).toBeGreaterThan(0);
  });

  it('renders the elevated-activity and aftershock caveats verbatim', () => {
    renderPage();
    expect(screen.getByText(EARTHQUAKE_ELEVATED_CAVEAT)).toBeInTheDocument();
    expect(screen.getByText(AFTERSHOCK_CAVEAT)).toBeInTheDocument();
  });
});

describe('ADR-040’s two honest limitations of the fire trend', () => {
  it('says an unread day is excluded rather than counted as zero', () => {
    const text = pageText();
    expect(text).toMatch(/did not read every hour of is excluded from both means/u);
    expect(text).toMatch(/rather than counted as zero/u);
  });

  it('says a cell counts by its centre, so the circle’s edge is approximate', () => {
    const text = pageText();
    expect(text).toContain(
      `a cell counts when its centre lies within ${String(FIRE_TREND.radiusKm)} km`,
    );
    expect(text).toMatch(/approximate by up to half a cell/u);
  });
});
