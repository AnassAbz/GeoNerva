/**
 * Axe on every page (no serious or critical violations) and no horizontal scroll at 320 px
 * (docs/TESTING.md §5), for every route of docs/PRODUCT.md §6.1 and the outage and replay states.
 */

import { PLACE, expect, horizontalOverflow, seriousViolations, test } from './offline.ts';

const PAGES = [
  ['home', '/'],
  ['dashboard', PLACE],
  ['dashboard, FIRMS stale', `${PLACE}?scenario=firms-stale`],
  ['dashboard, replay', `${PLACE}?as_of=2026-09-22T10:10:00Z`],
  ['event', '/event/EQ-26-7K3F9Q?place=marrakech-ma-2542997'],
  ['flood event', '/event/FL-26-9QW3TD'],
  ['fire cluster', '/fire/FR-26-4HX2MB?place=marrakech-ma-2542997'],
  ['data status', '/data-status'],
  ['methodology', '/methodology'],
  ['not found', '/place/nowhere-xx-1'],
] as const;

for (const [name, path] of PAGES) {
  test(`${name}: no serious or critical axe violations`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test(`${name}: no horizontal scroll at 320 px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
}

test('an unknown place is a 404 page, not an empty briefing', async ({ page }) => {
  const response = await page.goto('/place/nowhere-xx-1');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
});
