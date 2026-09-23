import type { FamilyCard, HazardFamily } from '@geonerva/domain';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { FIXTURE_NOW, marrakechBriefing } from '../lib/fixtures/index.ts';
import { renderWithEvidence } from '../test/render.tsx';
import { HazardCard } from './hazard-card.tsx';

function renderCard(
  family: HazardFamily,
  options: {
    scenario?: 'all-fresh' | 'firms-stale';
    card?: FamilyCard;
    defaultOpen?: boolean;
  } = {},
) {
  const briefing = marrakechBriefing({ scenario: options.scenario ?? 'all-fresh' });
  const card = options.card ?? briefing.snapshot.families[family];
  const changes = [...briefing.changes.headline, ...briefing.changes.listed].filter(
    (change) => change.family === family,
  );
  const result = renderWithEvidence(
    <HazardCard
      card={card}
      statusLines={briefing.copy.byFamily[family]}
      changes={changes}
      window="24h"
      now={FIXTURE_NOW}
      timeZone="Africa/Casablanca"
      placeSlug="marrakech-ma-2542997"
      defaultOpen={options.defaultOpen ?? false}
    />,
    briefing.evidenceManifest,
  );
  return { ...result, article: screen.getByRole('article') };
}

describe('HazardCard — normal state', () => {
  it('shows STATUS, CHANGE, CONTEXT, RELEVANCE and SOURCES for earthquakes', () => {
    const { article } = renderCard('EARTHQUAKES');
    for (const label of ['Status', 'Change', 'Context', 'Relevance', 'Sources']) {
      expect(within(article).getByText(label)).toBeInTheDocument();
    }
    expect(article.querySelector('[data-state="available"]')).not.toBeNull();
    expect(within(article).getByText(/1 change in the last 24 h/u)).toBeInTheDocument();
    expect(within(article).getByText(/\(91st percentile\)/u)).toBeInTheDocument();
  });

  /*
   * This asserted `'Mww 4.7'` and `'mb 4.6'` — a magnitude *type* beside each value — and passed,
   * against a mock that supplied a `magnitude_type` comparison the API has never produced. The
   * capability being tested did not exist: `snapshot.ts` reads `magnitude_type` into the member
   * solutions and drops it, so no reader has ever seen a scale named on a card. That is QA round
   * 2's H-3, and it is open.
   *
   * What the card must do, and now does, is show **both** sources' magnitudes rather than one
   * number under "sources agree" (H-2). That is what is asserted, per source, so the test still
   * fails if either value or either attribution disappears. When H-3 lands and a
   * `MAGNITUDE_TYPE` comparison exists, the types belong back in this assertion.
   */
  it('shows per-source observed values and the agreement', () => {
    const { article } = renderCard('EARTHQUAKES');
    const sources = within(article).getByText('Sources').closest('div')?.parentElement;
    expect(sources).not.toBeNull();
    expect(within(article).getByText('4.7')).toBeInTheDocument();
    expect(within(article).getByText('4.6')).toBeInTheDocument();
    expect(within(article).getAllByText('USGS').length).toBeGreaterThanOrEqual(1);
    expect(within(article).getAllByText('EMSC').length).toBeGreaterThanOrEqual(1);
    expect(within(article).getByText(/minor differences/u)).toBeInTheDocument();
    expect(within(article).getByText(/2 independent of 3 sources/u)).toBeInTheDocument();
  });

  it('carries the Derived tag and a Why? on its derivations', () => {
    const { article } = renderCard('EARTHQUAKES');
    expect(within(article).getAllByText('Derived').length).toBeGreaterThanOrEqual(2);
    expect(within(article).getByRole('button', { name: /^Why\? Relevance:/u })).toBeInTheDocument();
  });

  it('shows source health in words, never a bare dot', () => {
    const { article } = renderCard('EARTHQUAKES');
    expect(within(article).getAllByText('Fresh').length).toBe(3);
  });

  it('links the lead item to the product route, not the API href', () => {
    const { article } = renderCard('EARTHQUAKES');
    const link = within(article).getByRole('link', { name: /M4\.7/u });
    expect(link).toHaveAttribute('href', '/event/EQ-26-7K3F9Q?place=marrakech-ma-2542997');
  });
});

describe('HazardCard — the three empty states', () => {
  it('Unavailable: states the outage in the PRODUCT §6.3 form and never renders a count', () => {
    const { article } = renderCard('FIRE_ACTIVITY', { scenario: 'firms-stale' });
    const body = article.querySelector('[data-state="unavailable"]');
    expect(body).not.toBeNull();
    expect(
      within(article).getByText(
        'Fire activity data unavailable — NASA FIRMS last updated 5 h ago (expected ≤ 3 h).',
      ),
    ).toBeInTheDocument();
    expect(
      within(article).getByText('Absence of thermal detections cannot be confirmed.'),
    ).toBeInTheDocument();
    expect(body?.textContent).not.toMatch(/\b0\b/u);
    expect(within(article).getByText('Stale')).toBeInTheDocument();
    expect(within(article).queryByText('Relevance')).not.toBeInTheDocument();
  });

  it('Not covered: uses the exact copy and the coverage note', () => {
    const { article } = renderCard('WEATHER_ALERTS');
    expect(article.querySelector('[data-state="not-covered"]')).not.toBeNull();
    expect(
      within(article).getByText('Weather warnings are not covered for this location.'),
    ).toBeInTheDocument();
    expect(within(article).getByText(/no weather-warning source for Morocco/u)).toBeInTheDocument();
  });

  it('Insufficient history: uses the exact copy, never "normal"', () => {
    const { article } = renderCard('FIRE_ACTIVITY');
    expect(
      within(article).getByText('Not enough history to establish a baseline.'),
    ).toBeInTheDocument();
    expect(article.querySelector('[data-metric-status="INSUFFICIENT_HISTORY"]')).not.toBeNull();
    expect(article.textContent).not.toMatch(/\bnormal\b/iu);
  });
});

describe('HazardCard — mobile accordion', () => {
  it('is collapsed by default and expands from its header button', async () => {
    const user = userEvent.setup();
    const { article } = renderCard('FLOODS');
    const toggle = within(article).getByRole('button', { name: /^Floods/u });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('starts expanded when asked (first card with HIGH+ relevance)', () => {
    const { article } = renderCard('FLOODS', { defaultOpen: true });
    expect(within(article).getByRole('button', { name: /^Floods/u })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

/*
 * QA round 2's two LOW findings that live on this card.
 *
 * L-3 is grammar: the family's verb comes from the family's own number, so a card can no longer
 * say "Fire activity are not covered". L-5 is the distance basis: "144 km away" is measured to
 * something, that something differs by family, and for an event two agencies located differently
 * it moves when the preferred solution does. The event page said both; the card said neither.
 */
describe('HazardCard — QA round 2, L-3 and L-5', () => {
  it('L-3: the not-covered verb agrees with the family, not with the sentence', () => {
    const briefing = marrakechBriefing({ scenario: 'all-fresh' });
    const { article } = renderCard('FIRE_ACTIVITY', {
      card: {
        ...briefing.snapshot.families.FIRE_ACTIVITY,
        availability: 'NOT_COVERED',
        items: [],
        itemsTotal: 0,
        coverage: {
          level: 'NOT_COVERED',
          note: 'No fire-detection source covers this location.',
        },
      },
    });
    expect(
      within(article).getByText('Fire activity is not covered for this location.'),
    ).toBeInTheDocument();
    expect(article.textContent).not.toMatch(/Fire activity are/u);
  });

  it('L-5: states what the distance is measured to, and that it can move', () => {
    const { article } = renderCard('EARTHQUAKES');
    const basis = article.querySelector('[data-distance-basis="EARTHQUAKES"]');
    expect(basis?.textContent).toMatch(/^Measured to the epicentre\./u);
    expect(basis?.textContent).toMatch(/follows the solution GeoNerva currently prefers/u);
  });

  it('L-5: does not claim the distance can move when one source placed the item', () => {
    const { article } = renderCard('FLOODS');
    const basis = article.querySelector('[data-distance-basis="FLOODS"]');
    expect(basis?.textContent).toBe('Measured to the flood area GDACS modelled.');
    expect(article.textContent).not.toMatch(/currently prefers/u);
  });
});
