import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { marrakechBriefing } from '../lib/fixtures/index.ts';
import { renderWithEvidence } from '../test/render.tsx';
import { SituationStrip, overallConfidence } from './situation-strip.tsx';

function renderStrip(scenario: 'all-fresh' | 'firms-stale') {
  const briefing = marrakechBriefing({ scenario });
  renderWithEvidence(
    <SituationStrip
      overall={briefing.snapshot.overall}
      copy={briefing.copy}
      families={briefing.snapshot.families}
    />,
    briefing.evidenceManifest,
  );
  return briefing;
}

describe('SituationStrip', () => {
  it('renders the API headline verbatim, the coverage line and the confidence chip', () => {
    const briefing = renderStrip('all-fresh');
    expect(screen.getByText(briefing.copy.headline)).toBeInTheDocument();
    expect(screen.getByText('Not covered here: weather warnings.')).toBeInTheDocument();
    expect(screen.getByText('Data confidence:', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Some data is currently unavailable.')).not.toBeInTheDocument();
  });

  it('degrades to "Some data is currently unavailable" when a source is stale', () => {
    renderStrip('firms-stale');
    expect(screen.getByRole('status')).toHaveTextContent('Some data is currently unavailable.');
  });

  it('explains the confidence behind a tap-operable Why?', async () => {
    const user = userEvent.setup();
    renderStrip('all-fresh');
    await user.click(screen.getByRole('button', { name: 'Why? Data confidence' }));
    expect(screen.getByText(/complete from about M3\.1/u)).toBeVisible();
  });
});

describe('overallConfidence', () => {
  it('is the lowest confidence of the families GeoNerva could describe', () => {
    expect(overallConfidence(marrakechBriefing().snapshot.families).level).toBe('MEDIUM');
    expect(
      overallConfidence(marrakechBriefing({ scenario: 'firms-stale' }).snapshot.families).level,
    ).toBe('LOW');
  });
});
