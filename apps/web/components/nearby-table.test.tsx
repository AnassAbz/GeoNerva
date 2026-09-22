import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { NearbyTable, type NearbyRow } from './nearby-table.tsx';

const rows: NearbyRow[] = [
  {
    id: 'CE:EQ-26-7K3F9Q',
    title: 'M4.7 · 49 km S of Azilal',
    href: '/event/EQ-26-7K3F9Q',
    family: 'EARTHQUAKES',
    level: 'MODERATE',
    distanceKm: 142.3,
    observedAt: '2026-09-22T11:47:12.000Z',
    timeLabel: '1 h 19 min ago',
    sourceCount: 3,
  },
  {
    id: 'FC:FR-26-4HX2MB',
    title: 'Fire activity cluster',
    href: '/fire/FR-26-4HX2MB',
    family: 'FIRE_ACTIVITY',
    level: 'LOW',
    distanceKm: 38.9,
    observedAt: '2026-09-22T02:14:00.000Z',
    timeLabel: '10 h 52 min ago',
    sourceCount: 1,
  },
  {
    id: 'CE:FL-26-9QW3TD',
    title: 'GDACS flood event',
    href: null,
    family: 'FLOODS',
    level: 'LOW',
    distanceKm: 171.4,
    observedAt: '2026-09-20T06:00:00.000Z',
    timeLabel: '2 d ago',
    sourceCount: 1,
  },
];

function rowTitles(): string[] {
  const table = screen.getByRole('table');
  return within(table)
    .getAllByRole('rowheader')
    .map((cell) => cell.textContent);
}

describe('NearbyTable', () => {
  it('sorts by distance by default and says so with aria-sort', () => {
    render(<NearbyTable rows={rows} />);
    expect(rowTitles()).toEqual([
      'Fire activity cluster',
      'M4.7 · 49 km S of Azilal',
      'GDACS flood event',
    ]);
    expect(screen.getByRole('columnheader', { name: /Distance/u })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('sorts by relevance, highest first, and reverses on a second press', async () => {
    const user = userEvent.setup();
    render(<NearbyTable rows={rows} />);
    const button = screen.getByRole('button', { name: /Relevance/u });
    await user.click(button);
    expect(rowTitles()[0]).toBe('M4.7 · 49 km S of Azilal');
    expect(screen.getByRole('columnheader', { name: /Relevance/u })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await user.click(button);
    expect(rowTitles().at(-1)).toBe('M4.7 · 49 km S of Azilal');
  });

  it('is operable from the keyboard', async () => {
    const user = userEvent.setup();
    render(<NearbyTable rows={rows} />);
    screen.getByRole('button', { name: /Time/u }).focus();
    await user.keyboard('{Enter}');
    expect(rowTitles()[0]).toBe('M4.7 · 49 km S of Azilal');
    expect(screen.getByRole('columnheader', { name: /Time/u })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('links items that have a page and states types in words', () => {
    render(<NearbyTable rows={rows} />);
    expect(screen.getByRole('link', { name: 'Fire activity cluster' })).toHaveAttribute(
      'href',
      '/fire/FR-26-4HX2MB',
    );
    expect(screen.getByText('Floods')).toBeInTheDocument();
  });

  it('says there is nothing rather than rendering an empty table', () => {
    render(<NearbyTable rows={[]} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing assessed near this location/u)).toBeInTheDocument();
  });
});
