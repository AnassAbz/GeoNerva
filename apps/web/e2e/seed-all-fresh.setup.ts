/** Loads the `all-fresh` scenario before the main projects run (docs/TESTING.md §5). */

import { test as setup } from '@playwright/test';

import { seedScenario } from './scenario.ts';

setup('seed the all-fresh scenario', () => {
  setup.setTimeout(300_000);
  seedScenario('all-fresh');
});
