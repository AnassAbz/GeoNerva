import type { HistoryResponse } from '@geonerva/domain';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FIXTURE_NOW, historyFixture } from '../lib/fixtures/index.ts';
import { renderWithEvidence } from '../test/render.tsx';
import { HistoryChart } from './history-chart.tsx';

function history(
  family: HistoryResponse['family'],
  options: { metricCode?: string; scenario?: 'all-fresh' | 'firms-stale' } = {},
): HistoryResponse {
  const response = historyFixture({ family, asOf: FIXTURE_NOW, ...options });
  if (response === null) throw new Error(`no history fixture for ${family}`);
  return response;
}

function renderChart(response: HistoryResponse) {
  const result = renderWithEvidence(<HistoryChart history={response} />, response.evidenceManifest);
  return result.container.querySelector('figure');
}

describe('HistoryChart', () => {
  it('OK: draws the series over the reference band and states the percentile', () => {
    const figure = renderChart(history('EARTHQUAKES'));
    expect(figure).toHaveAttribute('data-history-status', 'OK');
    expect(screen.getByRole('img', { name: /typical range 0 to 1/u })).toBeInTheDocument();
    expect(screen.getAllByText(/above typical for this area/u)[0]).toBeVisible();
    expect(screen.getByText('Typical range (25th–75th percentile)')).toBeInTheDocument();
    expect(screen.getAllByText(/does not by itself indicate/u)[0]).toBeVisible();
  });

  it('RARE_ACTIVITY: gives the rarity statement and no percentile or band', () => {
    const figure = renderChart(history('FLOODS'));
    expect(figure).toHaveAttribute('data-history-status', 'RARE_ACTIVITY');
    expect(screen.getByText('2 GDACS flood events within 300 km since 2021.')).toBeInTheDocument();
    expect(figure?.textContent).not.toMatch(/percentile\)/u);
    expect(screen.queryByText('Typical range (25th–75th percentile)')).not.toBeInTheDocument();
  });

  it('INSUFFICIENT_HISTORY: says there is not enough history, and draws gaps with reasons', () => {
    const figure = renderChart(history('FIRE_ACTIVITY'));
    expect(figure).toHaveAttribute('data-history-status', 'INSUFFICIENT_HISTORY');
    expect(
      screen.getAllByText('Not enough history to establish a baseline.').length,
    ).toBeGreaterThan(0);
    expect(figure?.querySelectorAll('[data-missing="true"]').length).toBe(2);
    expect(screen.getAllByText(/No satellite coverage that day/u).length).toBe(2);
    expect(figure?.textContent).not.toMatch(/\bnormal\b/iu);
  });

  it('INSUFFICIENT_COVERAGE: explains the coverage gap and draws no chart', () => {
    const figure = renderChart(history('EARTHQUAKES', { metricCode: 'EQ_COUNT_30D' }));
    expect(figure).toHaveAttribute('data-history-status', 'INSUFFICIENT_COVERAGE');
    expect(screen.getByText('Not enough data coverage to compare')).toBeInTheDocument();
    expect(screen.getAllByText(/less than 30 days/u)[0]).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('NOT_APPLICABLE: says no comparison applies', () => {
    const figure = renderChart(history('CYCLONES'));
    expect(figure).toHaveAttribute('data-history-status', 'NOT_APPLICABLE');
    expect(screen.getByText('No comparison applies here')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('links to the methodology section and carries the Derived tag', () => {
    renderChart(history('EARTHQUAKES'));
    expect(screen.getByRole('link', { name: 'How this is computed' })).toHaveAttribute(
      'href',
      '/methodology#eq-count',
    );
    expect(screen.getByText('Derived')).toBeInTheDocument();
  });
});
