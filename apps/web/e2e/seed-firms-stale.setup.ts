/**
 * Replaces the seeded world with the one in which every fire source is stale.
 *
 * It runs **after** the all-fresh projects have finished, because the two scenarios mint the same
 * public ids and cannot share a database. See `playwright.config.ts` for why that is a re-seed
 * rather than a second server.
 */

import { test as setup } from '@playwright/test';

import { seedScenario } from './scenario.ts';

setup('seed the firms-stale scenario', () => {
  setup.setTimeout(300_000);
  seedScenario('firms-stale');
});
