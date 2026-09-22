/**
 * Setup for the `components` Vitest project (jsdom). Adds the Testing Library DOM matchers and
 * unmounts every rendered tree between tests. Nothing here touches the network or WebGL: the map
 * is never required for a component test to pass.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
