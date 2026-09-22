/** Test helpers for the `components` project. */

import type { EvidenceItem } from '@geonerva/domain';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

import { EvidenceProvider } from '../components/evidence.tsx';

/** Renders inside an evidence provider, as every page does. */
export function renderWithEvidence(
  ui: ReactElement,
  manifest: readonly EvidenceItem[] = [],
): RenderResult {
  return render(
    <EvidenceProvider manifest={manifest} timeZone="UTC">
      {ui}
    </EvidenceProvider>,
  );
}
