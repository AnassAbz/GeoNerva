/**
 * The "Raw record" section of the evidence drawer (docs/PRODUCT.md §6.8, ADR-038).
 *
 * Three things are being pinned here, and the third is the one that matters most:
 *
 *  1. each of the four lifecycle states gets its own sentence a reader can act on;
 *  2. only the metadata that is actually known is rendered — a `null` capture time or expiry is an
 *     absent row, never a blank or a zero;
 *  3. the provider's bytes are never rendered, and the section offers no affordance that could go
 *     and get them. ADR-038 decided raw-payload retrieval is not part of the public contract, so a
 *     "download the payload" button here would be a product decision taken in a component.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { marrakechBriefing, observationEvidence } from '../lib/fixtures/index.ts';
import { EvidenceButton, EvidenceProvider } from './evidence.tsx';

const manifest = marrakechBriefing().evidenceManifest;
const OBS = 'EV:OBS:90211';

type State = 'AVAILABLE' | 'PRUNED' | 'NOT_CAPTURED' | 'SOURCE_UNAVAILABLE';

async function openDrawer(state: State): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(
    <EvidenceProvider
      manifest={manifest}
      details={[observationEvidence({ raw: state })]}
      timeZone="UTC"
    >
      <EvidenceButton ids={[OBS]} />
    </EvidenceProvider>,
  );
  await user.click(screen.getByRole('button', { name: /Evidence \(1\)/u }));
  return screen.getByRole('dialog', { name: 'Evidence' });
}

/** Everything the section renders, so an absence assertion covers the metadata rows too. */
function sectionText(dialog: HTMLElement): string {
  const section = dialog.querySelector('section[aria-labelledby]');
  expect(section).not.toBeNull();
  return section?.textContent ?? '';
}

/**
 * The lifecycle *sentence* alone — the first paragraph of the section.
 *
 * Read separately from `sectionText` on purpose: comparing whole sections would call two states
 * distinct merely because one of them also renders a digest, which is exactly the way a collapsed
 * message would slip past the "four different sentences" check.
 */
function lifecycleText(dialog: HTMLElement): string {
  const sentence = dialog.querySelector('section[aria-labelledby] > p');
  expect(sentence).not.toBeNull();
  return sentence?.textContent ?? '';
}

describe('the raw-record section names the payload lifecycle', () => {
  it('AVAILABLE says the record is held, and shows the digest, capture time and expiry', async () => {
    const dialog = await openDrawer('AVAILABLE');
    const detail = observationEvidence({ raw: 'AVAILABLE' }).detail;
    expect(within(dialog).getByRole('heading', { name: 'Raw record' })).toBeInTheDocument();
    expect(lifecycleText(dialog)).toMatch(/Held — GeoNerva still has the provider’s original/u);
    expect(within(dialog).getByText(/SHA-256 digest/u)).toBeInTheDocument();
    if (detail.kind !== 'OBS') throw new Error('the observation fixture changed kind');
    expect(within(dialog).getByText(detail.rawPayload.sha256 ?? '')).toBeInTheDocument();
    expect(within(dialog).getByText('Record first stored')).toBeInTheDocument();
    expect(within(dialog).getByText('Retention window ends')).toBeInTheDocument();
    expect(within(dialog).queryByText('Retention window ended')).not.toBeInTheDocument();
  });

  it('PRUNED says the record was held and deleted, with the date the window ended', async () => {
    const dialog = await openDrawer('PRUNED');
    expect(lifecycleText(dialog)).toMatch(/Pruned — GeoNerva did hold the provider’s original/u);
    expect(lifecycleText(dialog)).toMatch(/deleted it when the retention window below ended/u);
    expect(within(dialog).getByText('Retention window ended')).toBeInTheDocument();
    expect(within(dialog).queryByText('Retention window ends')).not.toBeInTheDocument();
    /* §6.8 asks for the date it expired; the fixture's window closed on 31 July 2026. */
    expect(within(dialog).getByText(/31 Jul 2026|2026-07-31|Jul 31, 2026/u)).toBeInTheDocument();
    /* The digest is the whole point of keeping the citation after the bytes are gone. */
    expect(within(dialog).getByText(/SHA-256 digest/u)).toBeInTheDocument();
  });

  it('NOT_CAPTURED says nothing was ever stored, and is not the pruned message', async () => {
    const dialog = await openDrawer('NOT_CAPTURED');
    const text = sectionText(dialog);
    expect(text).toMatch(/Never captured — GeoNerva never stored the provider’s original record/u);
    expect(text).toMatch(/nothing to prune/u);
    /* The distinction ADR-038 added a database column to preserve must survive the last step. */
    expect(text).not.toMatch(/\bdeleted\b/u);
    expect(within(dialog).queryByText(/SHA-256 digest/u)).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Record first stored')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Retention window/u)).not.toBeInTheDocument();
  });

  it('SOURCE_UNAVAILABLE reports that GeoNerva does not know, and claims no metadata', async () => {
    const dialog = await openDrawer('SOURCE_UNAVAILABLE');
    const text = sectionText(dialog);
    expect(text).toMatch(/Unknown — a stored record is referenced for this observation/u);
    expect(text).toMatch(/rather than guessing/u);
    expect(text).not.toMatch(/\bdeleted\b/u);
    expect(text).not.toMatch(/never stored/u);
    expect(within(dialog).queryByText(/SHA-256 digest/u)).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Record first stored')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Retention window/u)).not.toBeInTheDocument();
  });

  it('gives the four states four different sentences', async () => {
    const seen = new Set<string>();
    for (const state of ['AVAILABLE', 'PRUNED', 'NOT_CAPTURED', 'SOURCE_UNAVAILABLE'] as const) {
      const dialog = await openDrawer(state);
      seen.add(lifecycleText(dialog));
      cleanup();
    }
    expect(seen.size).toBe(4);
  });
});

describe('the raw-record section never exposes the provider’s bytes', () => {
  it('offers no control that could fetch or download a payload', async () => {
    const dialog = await openDrawer('AVAILABLE');
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(buttons).toEqual(['Close evidence']);
    const links = within(dialog)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href') ?? '');
    /* Only the provider's own event page — nothing addressing a payload or a raw record. */
    expect(links).toEqual(['https://earthquake.usgs.gov/earthquakes/eventpage/us7000tikb']);
    expect(dialog.textContent).not.toMatch(/download|raw payload body|view payload/iu);
  });

  it('renders no raw-record section at all when no detail was supplied', async () => {
    const user = userEvent.setup();
    render(
      <EvidenceProvider manifest={manifest} timeZone="UTC">
        <EvidenceButton ids={[OBS]} />
      </EvidenceProvider>,
    );
    await user.click(screen.getByRole('button', { name: /Evidence \(1\)/u }));
    const dialog = screen.getByRole('dialog', { name: 'Evidence' });
    expect(within(dialog).queryByRole('heading', { name: 'Raw record' })).not.toBeInTheDocument();
  });

  it('keeps the drawer’s focus contract: focus starts on close and returns to the trigger', async () => {
    const user = userEvent.setup();
    render(
      <EvidenceProvider
        manifest={manifest}
        details={[observationEvidence({ raw: 'PRUNED' })]}
        timeZone="UTC"
      >
        <EvidenceButton ids={[OBS]} />
      </EvidenceProvider>,
    );
    const trigger = screen.getByRole('button', { name: /Evidence \(1\)/u });
    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Close evidence' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
