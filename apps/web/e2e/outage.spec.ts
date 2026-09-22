/**
 * The source-outage flow of docs/TESTING.md §5, against the **firms-stale** scenario.
 *
 * Its own file and its own Playwright project, because the two scenarios mint the same public ids
 * and cannot share a database; `playwright.config.ts` explains the ordering. P9a drove this state
 * with `?scenario=firms-stale`, a query parameter the seeded database replaces and P9b deleted.
 *
 * "FIRMS stale" means **every** fire source stale, GDACS's wildfire feed included: `FIRE_ACTIVITY`
 * covers two hazard types and `resolveAvailability` refuses a family only when every source of it
 * is unusable. docs/TESTING.md §5 says so; the scenario stales both.
 */

import { PLACE, expect, horizontalOverflow, seriousViolations, test } from './offline.ts';

test('every fire source stale → the fire card says unavailable and never shows 0', async ({
  page,
}) => {
  await page.goto(PLACE);
  await expect(
    page.getByRole('status').filter({ hasText: 'Some data is currently unavailable.' }),
  ).toBeVisible();

  const card = page.getByRole('article', { name: /Fire activity/iu });
  const header = card.getByRole('button', { name: /Fire activity/iu });
  if (await header.isVisible()) await header.click();

  const body = card.locator('[data-state="unavailable"]');
  await expect(body).toContainText('Fire activity data unavailable');
  await expect(body).toContainText('NASA FIRMS');
  await expect(body).toContainText('Absence of thermal detections cannot be confirmed.');
  /* Invariant I11: an unavailable family is never reported as a count of zero. */
  expect(await body.innerText()).not.toMatch(/\b0\b/u);
});

test('the situation strip says what it cannot see, rather than reporting quiet', async ({
  page,
}) => {
  await page.goto(PLACE);
  await expect(page.getByText(/cannot currently report on fire activity/u).first()).toBeVisible();
  await expect(
    page.getByText(/treat the absence of that as unknown rather than as quiet/u).first(),
  ).toBeVisible();
});

test('no serious or critical axe violations while a family is unavailable', async ({ page }) => {
  await page.goto(PLACE);
  await page.waitForLoadState('networkidle');
  expect(await seriousViolations(page)).toEqual([]);
});

test('no horizontal scroll at 320 px while a family is unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(PLACE);
  await page.waitForLoadState('networkidle');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
