import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { marrakechBriefing } from '../lib/fixtures/index.ts';
import { renderWithEvidence } from '../test/render.tsx';
import { ChangeItem } from './change-item.tsx';
import { WhatChanged } from './what-changed.tsx';

const briefing = marrakechBriefing();
const eqChange = briefing.changes.headline[0];

describe('ChangeItem', () => {
  it('renders the change with its link, relevance, time, Derived tag and evidence', () => {
    if (eqChange === undefined) throw new Error('fixture has a headline change');
    renderWithEvidence(
      <ul>
        <ChangeItem
          change={eqChange}
          relevance="MODERATE"
          href="/event/EQ-26-7K3F9Q"
          timeLabel="1 h 19 min ago"
          timeZone="UTC"
        />
      </ul>,
      briefing.evidenceManifest,
    );
    const link = screen.getByRole('link', { name: /New M4\.7 earthquake/u });
    expect(link).toHaveAttribute('href', '/event/EQ-26-7K3F9Q');
    expect(screen.getByText('Moderate')).toBeInTheDocument();
    expect(screen.getByText('1 h 19 min ago')).toBeInTheDocument();
    expect(screen.getByText('Derived')).toBeInTheDocument();
    expect(screen.getByText(/4\.6 → 4\.7/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Evidence \(5\)/u })).toBeInTheDocument();
    expect(screen.getByText('New:', { exact: false })).toBeInTheDocument();
  });

  it('marks a late report and states why a suppressed change was filtered out', () => {
    const suppressed = briefing.changes.suppressed[0];
    if (suppressed === undefined) throw new Error('fixture has a suppressed change');
    renderWithEvidence(
      <ul>
        <ChangeItem
          change={{ ...suppressed, lateReport: true }}
          timeZone="UTC"
          suppressionText="below the materiality threshold"
        />
      </ul>,
    );
    expect(screen.getByText('Reported late')).toBeInTheDocument();
    expect(screen.getByText(/Filtered out: below the materiality threshold/u)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('WhatChanged', () => {
  const subjects = {
    'CE:EQ-26-7K3F9Q': {
      relevance: 'MODERATE' as const,
      href: '/event/EQ-26-7K3F9Q',
      timeLabel: '1 h ago',
    },
  };

  it('lists headline then listed changes, and keeps suppressed ones behind a toggle', async () => {
    const user = userEvent.setup();
    renderWithEvidence(
      <WhatChanged
        section={briefing.changes}
        subjects={subjects}
        timeZone="UTC"
        fallbackTimeLabel="now"
      />,
      briefing.evidenceManifest,
    );
    const list = screen.getByRole('list', { name: 'What changed' });
    const items = within(list)
      .getAllByRole('listitem')
      .filter((item) => item.dataset['prominence'] !== undefined);
    expect(items[0]).toHaveAttribute('data-prominence', 'HEADLINE');
    expect(items.slice(1).every((item) => item.dataset['prominence'] === 'LISTED')).toBe(true);

    const toggle = screen.getByRole('button', { name: 'Show 3 minor changes' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('New M2.8 earthquake 118 km south')).not.toBeVisible();
    await user.click(toggle);
    expect(screen.getByText('New M2.8 earthquake 118 km south')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide minor changes' })).toBeInTheDocument();
  });

  it('shows the empty statement when nothing reached LISTED', () => {
    renderWithEvidence(
      <WhatChanged
        section={{
          ...briefing.changes,
          headline: [],
          listed: [],
          emptyStatement: 'Nothing meaningful changed in the last 6 hours.',
        }}
        subjects={{}}
        timeZone="UTC"
        fallbackTimeLabel="now"
      />,
    );
    expect(screen.getByText('Nothing meaningful changed in the last 6 hours.')).toBeInTheDocument();
  });
});
