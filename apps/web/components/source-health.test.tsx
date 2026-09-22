import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FIXTURE_NOW, marrakechBriefing, sourceStatusFixture } from '../lib/fixtures/index.ts';
import { renderWithEvidence } from '../test/render.tsx';
import { RunStrip } from './run-strip.tsx';
import { SourceHealthList } from './source-health.tsx';

function byTestSource(root: HTMLElement, sourceId: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-source="${sourceId}"]`);
  if (element === null) throw new Error(`no row for ${sourceId}`);
  return element;
}

describe('SourceHealthList', () => {
  it('shows status in words, the poll against its cadence and the data against its latency', () => {
    const briefing = marrakechBriefing();
    const { container } = renderWithEvidence(
      <SourceHealthList sourceHealth={briefing.snapshot.sourceHealth} now={FIXTURE_NOW} />,
      briefing.evidenceManifest,
    );
    const firms = byTestSource(container, 'firms');
    expect(within(firms).getByText('Fresh')).toBeInTheDocument();
    expect(within(firms).getByText(/22 min ago/u)).toBeInTheDocument();
    expect(within(firms).getByText(/expected every 30 min/u)).toBeInTheDocument();
    expect(within(firms).getByText(/3 h 40 min ago/u)).toBeInTheDocument();
    expect(within(firms).getByText(/expected ≤ 6 h/u)).toBeInTheDocument();
  });

  it('in an outage, names the error class and never shows a zero', () => {
    const briefing = marrakechBriefing({ scenario: 'firms-stale' });
    const { container } = renderWithEvidence(
      <SourceHealthList sourceHealth={briefing.snapshot.sourceHealth} now={FIXTURE_NOW} />,
      briefing.evidenceManifest,
    );
    const firms = byTestSource(container, 'firms');
    expect(within(firms).getByText('Stale')).toBeInTheDocument();
    expect(within(firms).getByText('Provider error (HTTP 5xx)')).toBeInTheDocument();
    const eccc = byTestSource(container, 'eccc');
    expect(within(eccc).getByText('Unavailable')).toBeInTheDocument();
    expect(within(eccc).getAllByText('Never').length).toBe(2);
  });
});

describe('RunStrip', () => {
  it('summarizes the polls for assistive technology, failures included', () => {
    const firms = sourceStatusFixture('firms-stale').sources.find(
      (source) => source.sourceId === 'firms',
    );
    renderWithEvidence(<RunStrip runs={firms?.recentRuns ?? []} />);
    expect(screen.getByRole('img', { name: '24 recent polls, 9 failed' })).toBeInTheDocument();
  });
});
