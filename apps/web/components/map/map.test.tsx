/**
 * The map is never required for a test to pass: WebGL detection and the canvas are injected, so
 * these tests exercise the panel, the toggles, the legend and the fallback without MapLibre.
 */

import type { HazardFamily } from '@geonerva/domain';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { mapFeaturesFixture } from '../../lib/fixtures/index.ts';
import { MAPPED_FAMILIES } from '../../lib/view/families.ts';
import { LayerToggles } from './layer-toggles.tsx';
import { MapLegend } from './legend.tsx';
import type { MapCanvasProps } from './map-canvas.tsx';
import { MapPanel } from './map-panel.tsx';
import { hasWebGL2 } from './webgl.ts';

const features = mapFeaturesFixture().features;

function FakeCanvas(props: MapCanvasProps) {
  return (
    <div data-testid="fake-canvas" data-enabled={[...props.enabled].sort().join(',')}>
      {props.features.length} features
    </div>
  );
}

function renderPanel(webgl: boolean) {
  return render(
    <MapPanel
      styleUrl="https://tiles.openfreemap.org/styles/dark"
      center={{ lat: 31.63, lon: -7.99 }}
      placeLabel="Marrakech, Morocco"
      features={features}
      detectWebGL2={() => webgl}
      Canvas={FakeCanvas}
    />,
  );
}

describe('MapPanel — WebGL2 fallback', () => {
  it('without WebGL2, shows a note pointing to the Nearby list and never mounts the canvas', () => {
    renderPanel(false);
    expect(screen.getByTestId('map-fallback')).toHaveTextContent(
      'The map needs WebGL2, which this browser does not provide.',
    );
    expect(screen.getByRole('link', { name: 'Go to the Nearby list' })).toHaveAttribute(
      'href',
      '#nearby',
    );
    expect(screen.queryByTestId('fake-canvas')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Map layers' })).not.toBeInTheDocument();
  });

  it('jsdom has no WebGL2, and the real probe says so without throwing', () => {
    expect(hasWebGL2()).toBe(false);
  });
});

describe('MapPanel — with WebGL2', () => {
  it('mounts the canvas with every family layer enabled, a legend and the toggles', () => {
    renderPanel(true);
    const canvas = screen.getByTestId('fake-canvas');
    expect(canvas).toHaveTextContent(`${String(features.length)} features`);
    expect(canvas.dataset['enabled']).toBe([...MAPPED_FAMILIES].sort().join(','));
    expect(
      screen.getByRole('region', { name: /Map of hazards near Marrakech/u }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Legend' })).toBeInTheDocument();
  });

  it('turning a layer off removes it from the canvas', async () => {
    const user = userEvent.setup();
    renderPanel(true);
    await user.click(screen.getByRole('checkbox', { name: 'Earthquakes' }));
    expect(screen.getByTestId('fake-canvas').dataset['enabled']).not.toContain('EARTHQUAKES');
  });

  it('"Open map" opens a full-screen sheet with the layer drawer, Escape closes it', async () => {
    const user = userEvent.setup();
    renderPanel(true);
    await user.click(screen.getByRole('button', { name: 'Open map' }));
    expect(screen.getByRole('button', { name: 'Close map' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Open map' })).toBeInTheDocument();
  });
});

function TogglesHarness() {
  const [enabled, setEnabled] = useState<ReadonlySet<HazardFamily>>(new Set(MAPPED_FAMILIES));
  return (
    <LayerToggles
      families={MAPPED_FAMILIES}
      enabled={enabled}
      onChange={(family, on) => {
        setEnabled((current) => {
          const next = new Set(current);
          if (on) next.add(family);
          else next.delete(family);
          return next;
        });
      }}
    />
  );
}

describe('LayerToggles — keyboard operation', () => {
  it('every family toggle is reachable with Tab and toggled with Space', async () => {
    const user = userEvent.setup();
    render(<TogglesHarness />);
    expect(screen.getByRole('group', { name: 'Map layers' })).toBeInTheDocument();
    for (const label of [
      'Earthquakes',
      'Fire activity',
      'Floods',
      'Cyclones',
      'Volcanoes & other',
    ]) {
      await user.tab();
      const box = screen.getByRole('checkbox', { name: label });
      expect(box).toHaveFocus();
      expect(box).toBeChecked();
      await user.keyboard(' ');
      expect(box).not.toBeChecked();
      await user.keyboard(' ');
      expect(box).toBeChecked();
    }
  });
});

describe('MapLegend', () => {
  it('describes every symbol in words, with shape and pattern', () => {
    render(<MapLegend />);
    for (const text of [
      'Earthquake — circle, sized by magnitude',
      'Fire activity cluster — triangle',
      'GDACS flood-event area (modelled) — hatched',
      'Cyclone track, forecast — dashed line',
      'Critical relevance — red outline',
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
});
