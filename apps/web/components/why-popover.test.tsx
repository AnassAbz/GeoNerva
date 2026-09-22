import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderWithEvidence } from '../test/render.tsx';
import { WhyPopover } from './why-popover.tsx';

const reasons = [
  {
    code: 'EQ_DISTANCE_MAGNITUDE',
    text: 'An M4.7 earthquake 142 km away falls in the moderate band.',
    params: {},
    evidenceIds: [],
  },
];

function setup() {
  renderWithEvidence(
    <>
      <WhyPopover
        subject="Relevance: M4.7"
        reasons={reasons}
        caveats={['A caveat that is always shown.']}
        modelVersion="rel-eq-1"
      />
      <button type="button">elsewhere</button>
    </>,
  );
  return screen.getByRole('button', { name: /Why\? Relevance: M4\.7/u });
}

describe('WhyPopover', () => {
  it('starts closed, with the reasons not exposed', () => {
    const button = setup();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(reasons[0]?.text ?? '')).not.toBeVisible();
  });

  it('opens on tap/click and lists reasons, caveats and the model', async () => {
    const user = userEvent.setup();
    const button = setup();
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(reasons[0]?.text ?? '')).toBeVisible();
    expect(screen.getByText('A caveat that is always shown.')).toBeVisible();
    expect(screen.getByText('rel-eq-1')).toBeVisible();
  });

  it('is operable from the keyboard: Enter opens, Escape closes and returns focus', async () => {
    const user = userEvent.setup();
    const button = setup();
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.tab();
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });

  it('Space toggles it as well', async () => {
    const user = userEvent.setup();
    const button = setup();
    button.focus();
    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on a click outside', async () => {
    const user = userEvent.setup();
    const button = setup();
    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});
