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

  it('shows per-source observed values and the agreement', () => {
    const { article } = renderCard('EARTHQUAKES');
    expect(within(article).getByText('Mww 4.7')).toBeInTheDocument();
    expect(within(article).getByText('mb 4.6')).toBeInTheDocument();
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
