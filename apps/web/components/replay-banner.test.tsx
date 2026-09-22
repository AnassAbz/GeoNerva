import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReplayBanner } from './replay-banner.tsx';

describe('ReplayBanner', () => {
  it('states the knowledge time in UTC, that later information is hidden, and the way back', () => {
    render(<ReplayBanner asOf="2026-09-08T12:10:00.000Z" exitHref="/place/marrakech-ma-2542997" />);
    const banner = screen.getByRole('region', { name: 'Replay' });
    expect(banner).toHaveTextContent(
      'Replay — showing what GeoNerva knew at 12:10 UTC, 8 Sep 2026. Information that arrived later is hidden.',
    );
    expect(screen.getByRole('link', { name: 'Return to the present' })).toHaveAttribute(
      'href',
      '/place/marrakech-ma-2542997',
    );
  });
});
