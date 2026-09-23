/**
 * QA round 2 — what the hazard card renders from a **real** briefing (docs/reviews/qa-round-2.md).
 *
 * `hazard-card.test.tsx` beside this file passes, and it is not wrong: it renders
 * `marrakechBriefing()`, the P9a mock in `lib/fixtures/world.ts`. That mock gives each family a
 * `BaselineMetricView` and spells its `FieldComparison` codes `magnitude` / `magnitude_type`.
 * Since commit 12567bf ("the pages read the database, not fixtures") the production read models
 * emit neither: `packages/briefing/src/snapshot.ts` returns `metrics: []` unconditionally, and
 * `fieldComparison` builds only `MAGNITUDE` and `DEPTH`, in capitals, with no magnitude type at
 * all. `FieldComparison.code` is `z.string()`, so no contract test and no typecheck catches the
 * difference.
 *
 * The result is a component suite that is green against a shape the API no longer produces. This
 * file renders the **shape the API actually returns** — copied from
 * `GET /api/v1/briefing?place=p:2542997` against the seeded `all-fresh` scenario at
 * `GEONERVA_FAKE_NOW=2026-09-22T13:06:00.000Z` — and asserts what the page must then say.
 *
 * **These specs are expected to fail.** They are findings, not regressions to protect.
 */

import type { FamilyCard, SubjectSummary } from '@geonerva/domain';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FIXTURE_NOW, marrakechBriefing } from '../lib/fixtures/index.ts';
import { renderWithEvidence } from '../test/render.tsx';
import { HazardCard } from './hazard-card.tsx';

const EV = ['EV:COR:5', 'EV:COR:6', 'EV:OBS:6', 'EV:OBS:7'] as const;

/**
 * The M5.4 item exactly as the briefing service returns it.
 *
 * USGS reports **mww 5.4** and EMSC reports **mb 5.3**. When this round was written the response
 * carried neither type and compared the two numbers as a 0.1 spread under `level: 'AGREE'`; the
 * fix for H-3 emits the scales as their own comparison and withholds the spread, because the
 * difference between two scales is not a discrepancy. This fixture now carries what the service
 * returns, which is what makes the assertions below a test of the product rather than of a mock.
 * The codes are capitals, because that is what `fieldComparison` emits.
 */
const REAL_ITEM = {
  subjectRef: 'CE:EQ-26-8TD4XH',
  hazardType: 'EARTHQUAKE',
  family: 'EARTHQUAKES',
  publicId: 'EQ-26-8TD4XH',
  title: 'M5.4 earthquake',
  observedAt: '2026-09-22T07:06:00.000Z',
  lifecycleStatus: 'ACTIVE',
  providerSeverity: null,
  distanceKm: 45.1,
  hypocentralDistanceKm: 46,
  facts: [
    {
      code: 'MAGNITUDE',
      label: 'Magnitude',
      value: { kind: 'number', value: 5.4, unit: null, decimals: 1 },
      evidenceIds: [...EV],
    },
    {
      code: 'DEPTH',
      label: 'Depth',
      value: { kind: 'number', value: 9, unit: 'km', decimals: 0 },
      evidenceIds: [...EV],
    },
  ],
  relevance: {
    level: 'HIGH',
    reasons: [
      {
        code: 'DISTANCE',
        text: 'About 45 km away.',
        params: { epicentralDistanceKm: 45, hypocentralDistanceKm: 46 },
        evidenceIds: [...EV],
      },
    ],
    authoritativeBasis: null,
    caveats: [],
    evidenceIds: [...EV],
    modelVersion: 'eq-1',
  },
  agreement: {
    level: 'AGREE',
    nSources: 2,
    nIndependentSources: 2,
    reasons: [
      {
        code: 'MAGNITUDE_SPREAD',
        text: 'Magnitudes differ by 0.1 across 2 independent sources.',
        params: { nSources: 2, nIndependentSources: 2, deltaMagnitude: 0.1 },
        evidenceIds: [...EV],
      },
    ],
    comparisons: [
      {
        code: 'MAGNITUDE',
        label: 'Magnitude',
        values: [
          {
            sourceId: 'usgs',
            contributor: 'us',
            value: { kind: 'number', value: 5.4, unit: null, decimals: 1 },
            evidenceId: 'EV:OBS:6',
          },
          {
            sourceId: 'emsc',
            contributor: 'EMSC',
            value: { kind: 'number', value: 5.3, unit: null, decimals: 1 },
            evidenceId: 'EV:OBS:7',
          },
        ],
        /* Withheld: `mww` and `mb` are different scales, so the difference measures nothing. */
        spread: null,
        isConflict: false,
      },
      {
        code: 'MAGNITUDE_TYPE',
        label: 'Magnitude type',
        values: [
          {
            sourceId: 'usgs',
            contributor: 'us',
            value: { kind: 'text', value: 'mww' },
            evidenceId: 'EV:OBS:6',
          },
          {
            sourceId: 'emsc',
            contributor: 'EMSC',
            value: { kind: 'text', value: 'mb' },
            evidenceId: 'EV:OBS:7',
          },
        ],
        spread: null,
        isConflict: false,
      },
    ],
  },
  evidenceIds: [...EV],
  href: '/event/EQ-26-8TD4XH',
} as unknown as SubjectSummary;

function renderRealCard() {
  const briefing = marrakechBriefing({ scenario: 'all-fresh' });
  const mock = briefing.snapshot.families.EARTHQUAKES;
  /* The mock card, with the two fields the production builder really returns. */
  const card = { ...mock, items: [REAL_ITEM], metrics: [] } as unknown as FamilyCard;
  const result = renderWithEvidence(
    <HazardCard
      card={card}
      statusLines={briefing.copy.byFamily.EARTHQUAKES}
      changes={[]}
      window="24h"
      now={FIXTURE_NOW}
      timeZone="Africa/Casablanca"
      placeSlug="marrakech-ma-2542997"
      defaultOpen
    />,
    briefing.evidenceManifest,
  );
  return { ...result, article: screen.getByRole('article') };
}

describe('F-1 · the card must not deny history the page reports below it', () => {
  /*
   * `card.metrics[0]` is undefined for every family, so `hazard-card.tsx` renders
   * `COPY.card.insufficientHistory`. On the same page, the Historical context section prints
   * "2 earthquakes of M4.5+ within 150 km in the past 7 days: above typical (in the top 10 % of
   * comparable periods) for this area, compared with 259 7-day periods since 2021."
   *
   * PRODUCT §7 reserves "Not enough history to establish a baseline" for thin data. Saying it
   * over 259 reference windows is a false statement about GeoNerva's own coverage, and it
   * suppresses the band and its ARCHITECTURE §8.1 mandatory caveat at card level.
   */
  it('does not say "not enough history" when the page has 259 reference windows', () => {
    const { article } = renderRealCard();
    expect(
      within(article).queryByText('Not enough history to establish a baseline.'),
    ).not.toBeInTheDocument();
  });
});

describe('F-5 · per-source magnitudes and their types', () => {
  /*
   * `SourcesRow` looks up `comparison.code === 'magnitude'` and `'magnitude_type'` in lower case;
   * the builder emits `MAGNITUDE` and `DEPTH` in capitals and no type at all. The lookup misses,
   * the component falls back to `item.facts.slice(0, 1)`, and the card prints one number —
   * "Magnitude: 5.4" — next to "Agreement: sources agree · 2 independent sources", for an event
   * whose two sources published 5.4 and 5.3 on two different magnitude scales.
   *
   * A reader is told the sources agree and is shown neither of the values that agreement is
   * about. PRODUCT §2 puts "do sources agree?" in the journalist's first five seconds.
   */
  it('shows both sources’ magnitudes when two sources published one', () => {
    const { article } = renderRealCard();
    // `getAllByText`: the value appears in the comparison and again in the item's own facts, and
    // the finding was that only *one* magnitude reached the card at all.
    expect(within(article).getAllByText(/5\.4/u).length).toBeGreaterThan(0);
    expect(within(article).getAllByText(/5\.3/u).length).toBeGreaterThan(0);
  });

  it('shows the magnitude type beside each magnitude', () => {
    /*
     * /methodology already tells the reader that "a moment magnitude and a body-wave magnitude
     * measure different things". The card compared one of each and named neither.
     *
     * Matched on the provider's own token, which is `mww` from USGS and `mb` from
     * EMSC, rather than on a seismological capitalisation GeoNerva would be authoring.
     * The finding is that the scale is named at all.
     */
    const { article } = renderRealCard();
    expect(within(article).getAllByText('mww').length).toBeGreaterThan(0);
    expect(within(article).getAllByText('mb').length).toBeGreaterThan(0);
  });
});
