import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { marrakechBriefing } from '../lib/fixtures/index.ts';
import { renderWithEvidence } from '../test/render.tsx';
import { EvidenceButton } from './evidence.tsx';

const manifest = marrakechBriefing().evidenceManifest;
const usgs = 'EV:OBS:90211';

describe('evidence drawer', () => {
  it('opens a dialog listing the cited items with kind, source, times and original link', async () => {
    const user = userEvent.setup();
    renderWithEvidence(<EvidenceButton ids={[usgs]} />, manifest);
    await user.click(screen.getByRole('button', { name: /Evidence \(1\)/u }));
    const dialog = screen.getByRole('dialog', { name: 'Evidence' });
    expect(within(dialog).getByText('Observation')).toBeInTheDocument();
    expect(within(dialog).getByText('USGS')).toBeInTheDocument();
    expect(within(dialog).getByText(/Mww 4\.7 at 10 km depth/u)).toBeInTheDocument();
    expect(within(dialog).getByText('Observed')).toBeInTheDocument();
    expect(within(dialog).getByText('Learned by GeoNerva')).toBeInTheDocument();
    const original = within(dialog).getByRole('link', { name: /View original/u });
    expect(original).toHaveAttribute('href', expect.stringContaining('earthquake.usgs.gov'));
    expect(original).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('moves focus into the dialog, closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderWithEvidence(<EvidenceButton ids={[usgs]} />, manifest);
    const trigger = screen.getByRole('button', { name: /Evidence \(1\)/u });
    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Close evidence' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('labels a GeoNerva derivation as such, with no provider link', async () => {
    const user = userEvent.setup();
    const derived = manifest.find((item) => item.kind === 'REL');
    renderWithEvidence(<EvidenceButton ids={[derived?.id ?? '']} label="why" />, manifest);
    await user.click(screen.getByRole('button', { name: 'why' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('GeoNerva derivation')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
  });

  it('says so when an id is missing from the manifest instead of hiding it', async () => {
    const user = userEvent.setup();
    renderWithEvidence(<EvidenceButton ids={['EV:OBS:1']} label="open" />, manifest);
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByText(/not in the response’s manifest/u)).toBeInTheDocument();
  });

  it('renders nothing without ids', () => {
    const { container } = renderWithEvidence(<EvidenceButton ids={[]} />, manifest);
    expect(container.querySelector('button')).toBeNull();
  });
});
