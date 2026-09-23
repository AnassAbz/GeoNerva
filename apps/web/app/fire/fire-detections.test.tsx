/**
 * The fire-cluster page's detection sections, whole and withheld (ADR-039).
 *
 * The page is a server component, so the two sections it delegates to are exported and rendered
 * directly here. What is being pinned is the honesty of the withheld state: the page says what it
 * cannot show and why, keeps the count it *can* stand behind, and never presents an empty or
 * partial member set as the cluster.
 *
 * The test lives outside `[publicId]/` on purpose: the brackets are a glob character class, and a
 * test file inside that directory is not reliably collected.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EvidenceProvider } from '../../components/evidence.tsx';
import { fireClusterDetail } from '../../lib/fixtures/index.ts';
import {
  DetectionSampleSection,
  DetectionsByDaySection,
  detectionsWithheld,
} from './[publicId]/page.tsx';

const verified = fireClusterDetail();
const withheld = fireClusterDetail({ detections: 'withheld' });

function renderSections(detail: typeof verified) {
  return render(
    <EvidenceProvider manifest={detail.evidenceManifest} timeZone="UTC">
      <DetectionsByDaySection detections={detail.detections} />
      <DetectionSampleSection detections={detail.detections} timeZone="UTC" />
    </EvidenceProvider>,
  );
}

describe('detectionsWithheld distinguishes withholding from a capped sample', () => {
  it('is false for a verified cluster whose sample merely hit its cap', () => {
    expect(verified.detections.truncated).toBe(true);
    expect(verified.detections.sample.length).toBeGreaterThan(0);
    expect(detectionsWithheld(verified.detections)).toBe(false);
  });

  it('is true only when the sample and the daily counts are both empty', () => {
    expect(withheld.detections.truncated).toBe(true);
    expect(withheld.detections.sample).toEqual([]);
    expect(withheld.detections.byDay).toEqual([]);
    expect(detectionsWithheld(withheld.detections)).toBe(true);
  });

  it('withholding does not touch the version’s own count', () => {
    expect(withheld.detections.total).toBe(verified.detections.total);
    expect(withheld.summary.detectionCountTotal).toBe(withheld.detections.total);
  });
});

describe('a verified cluster still lists its days and its sample', () => {
  it('shows a per-day count for every day and one row per sampled detection', () => {
    renderSections(verified);
    const byDay = screen.getByRole('region', { name: 'Thermal detections per day' });
    expect(within(byDay).getAllByRole('listitem')).toHaveLength(verified.detections.byDay.length);
    const sample = screen.getByRole('region', { name: 'Sample of thermal detections' });
    expect(within(sample).getAllByRole('listitem')).toHaveLength(verified.detections.sample.length);
    expect(within(sample).getByText(/of 14 detections shown/u)).toBeInTheDocument();
  });

  it('does not show the withheld explanation', () => {
    renderSections(verified);
    expect(screen.queryByText(/cannot be shown/u)).not.toBeInTheDocument();
  });
});

describe('a withheld cluster says what it cannot show and why', () => {
  it('replaces the per-day list with a named reason rather than an empty list', () => {
    renderSections(withheld);
    const byDay = screen.getByRole('region', { name: 'Thermal detections per day' });
    expect(within(byDay).queryAllByRole('listitem')).toEqual([]);
    expect(
      within(byDay).getByText('The individual detections for this cluster cannot be shown'),
    ).toBeInTheDocument();
    const reason = within(byDay).getByText(/kept for 72 hours in this deployment/u);
    /* Both causes are named, because the response cannot say which one applies (ADR-039). */
    expect(reason.textContent).toMatch(/before GeoNerva began recording when an assignment/u);
    expect(reason).toBeInTheDocument();
    /* The count it still stands behind is named in the same breath as the withholding. */
    expect(reason.textContent).toMatch(/counted 14 thermal detections/u);
    expect(reason.textContent).toMatch(/the figure it stands behind/u);
  });

  it('says no detections are listed, instead of "0 of 14 shown", and links to the reason', () => {
    renderSections(withheld);
    const sample = screen.getByRole('region', { name: 'Sample of thermal detections' });
    expect(within(sample).queryAllByRole('listitem')).toEqual([]);
    expect(
      within(sample).getByText(/No individual detections are listed for this cluster/u),
    ).toBeInTheDocument();
    expect(sample.textContent).not.toMatch(/of 14 detections shown/u);
    const why = within(sample).getByRole('link', { name: 'Why these are not listed' });
    expect(why).toHaveAttribute('href', '#detections-withheld');
    /* The anchor the link points at is on the page, not a dead fragment. */
    expect(document.querySelector('#detections-withheld')).not.toBeNull();
  });

  it('keeps the detection-set citation, because the count is still a fact', () => {
    renderSections(withheld);
    const sample = screen.getByRole('region', { name: 'Sample of thermal detections' });
    expect(within(sample).getByRole('button', { name: /Evidence \(1\)/u })).toBeInTheDocument();
  });

  it('never presents a partial member set: nothing claims to be a detection', () => {
    renderSections(withheld);
    expect(screen.queryAllByRole('listitem')).toEqual([]);
    /* No coordinate pair, no acquisition time — the shape a detection row would have. */
    expect(document.body.textContent).not.toMatch(/31\.\d{4}, -8\.\d{4}/u);
  });
});
