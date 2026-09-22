import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PLACE_SUGGESTIONS } from '../lib/fixtures/index.ts';
import { PlaceSearch } from './place-search.tsx';

describe('PlaceSearch', () => {
  it('suggests Marrakech for "Marr" and navigates to its slug with the keyboard', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(<PlaceSearch suggestions={PLACE_SUGGESTIONS} navigate={navigate} />);
    const box = screen.getByRole('combobox', { name: 'Search for a place' });
    await user.type(box, 'Marr');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('option', { name: /Marrakech/u })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.keyboard('{Enter}');
    expect(navigate).toHaveBeenCalledWith('/place/marrakech-ma-2542997');
  });

  it('folds accents and case', async () => {
    const user = userEvent.setup();
    render(<PlaceSearch suggestions={PLACE_SUGGESTIONS} navigate={vi.fn()} />);
    await user.type(screen.getByRole('combobox'), 'MARRÂK');
    expect(screen.getByRole('option', { name: /Marrakech/u })).toBeInTheDocument();
  });

  it('says when nothing matches', async () => {
    const user = userEvent.setup();
    render(<PlaceSearch suggestions={PLACE_SUGGESTIONS} navigate={vi.fn()} />);
    await user.type(screen.getByRole('combobox'), 'Zz');
    expect(screen.getByRole('status')).toHaveTextContent('No matching place in the local list.');
  });
});
