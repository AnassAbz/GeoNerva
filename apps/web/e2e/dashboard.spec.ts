/**
 * Flows of docs/TESTING.md §5 that P9a can run against the fixture read models. The seeded
 * scenario database, the fixed clock and the live API arrive with P9b.
 */

import { PLACE, disableWebGL2, expect, test } from './offline.ts';

test('search "Marr" → suggestion → dashboard with headline, What Changed and cards', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Search for a place' }).fill('Marr');
  await page.getByRole('option', { name: /Marrakech/u }).click();
  await expect(page).toHaveURL(/\/place\/marrakech-ma-2542997$/u);
  await expect(page.getByRole('heading', { level: 1, name: 'Marrakech, Morocco' })).toBeVisible();
  await expect(page.getByText(/currently needs your attention/u).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /What changed/u })).toBeVisible();
  for (const family of [
    'Earthquakes',
    'Fire activity',
    'Floods',
    'Cyclones',
    'Volcanoes & other',
    'Weather alerts',
  ]) {
    await expect(page.getByRole('article', { name: new RegExp(family, 'iu') })).toBeAttached();
  }
});

test('open the event from What Changed → per-source values, agreement, timeline, evidence', async ({
  page,
}) => {
  await page.goto(PLACE);
  await page.getByRole('link', { name: /New M4\.7 earthquake/u }).click();
  await expect(page).toHaveURL(/\/event\/EQ-26-7K3F9Q\?place=marrakech-ma-2542997$/u);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('M4.7 earthquake');
  const facts = page.getByRole('table');
  await expect(facts).toContainText('Mww');
  await expect(facts).toContainText('4.7');
  await expect(facts).toContainText('mb');
  await expect(facts).toContainText('4.6');
  await expect(page.getByText('Agreement: minor differences')).toBeVisible();
  await expect(page.getByText('Headline value from USGS (reviewed).')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Timeline of versions' })).toBeVisible();
  await expect(
    page.getByText(/USGS revised the magnitude from mb 4\.6 to Mww 4\.7/u),
  ).toBeVisible();
  await page
    .getByRole('button', { name: /Evidence/u })
    .first()
    .click();
  const drawer = page.getByRole('dialog', { name: 'Evidence' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('evidence drawer / bottom sheet opens from a derived statement and lists provider links', async ({
  page,
}) => {
  await page.goto(PLACE);
  await page
    .getByRole('button', { name: /Evidence \(\d+\)/u })
    .last()
    .click();
  const drawer = page.getByRole('dialog', { name: 'Evidence' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('link', { name: /View original/u }).first()).toHaveAttribute(
    'href',
    /^https:\/\//u,
  );
  await drawer.getByRole('button', { name: 'Close evidence' }).click();
  await expect(drawer).toBeHidden();
});

test('FIRMS stale → the fire card says unavailable and never shows 0', async ({ page }) => {
  await page.goto(`${PLACE}?scenario=firms-stale`);
  await expect(
    page.getByRole('status').filter({ hasText: 'Some data is currently unavailable.' }),
  ).toBeVisible();
  const card = page.getByRole('article', { name: /Fire activity/iu });
  const header = card.getByRole('button', { name: /Fire activity/iu });
  if (await header.isVisible()) await header.click();
  const body = card.locator('[data-state="unavailable"]');
  await expect(body).toContainText(
    'Fire activity data unavailable — NASA FIRMS last updated 5 h ago',
  );
  await expect(body).toContainText('Absence of thermal detections cannot be confirmed.');
  expect(await body.innerText()).not.toMatch(/\b0\b/u);
});

test('as_of shows the replay banner and hides later data', async ({ page }) => {
  await page.goto(`${PLACE}?as_of=2026-09-22T10:10:00Z`);
  await expect(page.getByTestId('replay-banner')).toContainText(
    'Replay — showing what GeoNerva knew at 10:10 UTC, 22 Sep 2026.',
  );
  await expect(page.getByTestId('replay-banner')).toContainText(
    'Information that arrived later is hidden.',
  );
  await expect(page.getByRole('table')).not.toContainText('Azilal');
  await page.getByRole('link', { name: 'Return to the present' }).click();
  await expect(page.getByTestId('replay-banner')).toHaveCount(0);
});

test.describe('desktop only', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop flows (docs/TESTING.md §5)');

  test('not-covered state (weather) and insufficient-history state', async ({ page }) => {
    await page.goto(PLACE);
    await expect(
      page.getByText('Weather warnings are not covered for this location.'),
    ).toBeVisible();
    const fire = page.getByRole('article', { name: /Fire activity/iu });
    await expect(fire.getByText('Not enough history to establish a baseline.')).toBeVisible();
  });

  test('the window selector 6 h / 24 h / 7 d changes the diff', async ({ page }) => {
    await page.goto(PLACE);
    const changes = page.getByRole('list', { name: 'What changed' }).locator(':scope > li');
    await expect(changes).toHaveCount(3);
    await page.getByRole('link', { name: '6 h' }).click();
    await expect(page).toHaveURL(/window=6h/u);
    await expect(changes).toHaveCount(1);
    await expect(page.getByRole('link', { name: '6 h' })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('link', { name: '7 d' }).click();
    await expect(changes).toHaveCount(4);
  });

  test('map layers toggle from the keyboard alone', async ({ page }) => {
    await page.goto(PLACE);
    const toggles = page.getByRole('group', { name: 'Map layers' });
    await expect(toggles).toBeVisible();
    const earthquakes = toggles.getByRole('checkbox', { name: 'Earthquakes' });
    await earthquakes.focus();
    await expect(earthquakes).toBeChecked();
    await page.keyboard.press('Space');
    await expect(earthquakes).not.toBeChecked();
    await page.keyboard.press('Tab');
    await expect(toggles.getByRole('checkbox', { name: 'Fire activity' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggles.getByRole('checkbox', { name: 'Fire activity' })).not.toBeChecked();
  });

  test('WebGL disabled → the page stays fully usable through the Nearby list', async ({ page }) => {
    await disableWebGL2(page);
    await page.goto(PLACE);
    await expect(page.getByTestId('map-fallback')).toContainText('The map needs WebGL2');
    await page.getByRole('link', { name: 'Go to the Nearby list' }).click();
    const table = page.getByRole('table');
    await expect(table.getByRole('rowheader')).toHaveCount(4);
    await table.getByRole('button', { name: /Relevance/u }).click();
    await expect(table.getByRole('rowheader').first()).toContainText('Azilal');
    await table.getByRole('link', { name: /Fire activity cluster/u }).click();
    await expect(page).toHaveURL(/\/fire\/FR-26-4HX2MB/u);
    await expect(page.getByRole('note').first()).toContainText('They are not confirmed wildfires.');
  });

  test('the Why? popover opens and closes from the keyboard', async ({ page }) => {
    await page.goto(PLACE);
    const why = page.getByRole('button', { name: /^Why\? Relevance: M4\.7/u });
    await why.focus();
    await page.keyboard.press('Enter');
    await expect(why).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('region', { name: /^Why\? Relevance: M4\.7/u })).toContainText(
      'moderate band',
    );
    await page.keyboard.press('Escape');
    await expect(why).toHaveAttribute('aria-expanded', 'false');
    await expect(why).toBeFocused();
  });
});

test.describe('mobile only', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile flows (docs/TESTING.md §5)');

  test('cards are an accordion and the map opens as a full-screen sheet', async ({ page }) => {
    await page.goto(PLACE);
    const header = page.getByRole('button', { name: /^Earthquakes/u });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'Open map' }).click();
    await expect(page.getByRole('button', { name: 'Close map' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Map layers' })).toBeVisible();
    await page.getByRole('button', { name: 'Close map' }).click();
    await expect(page.getByRole('button', { name: 'Open map' })).toBeVisible();
  });

  test('touch targets of buttons are at least 44 px', async ({ page }) => {
    await page.goto(PLACE);
    const small = await page
      .locator('main button:visible, main [role="combobox"]:visible')
      .evaluateAll((elements) =>
        elements
          .map((element) => {
            const box = element.getBoundingClientRect();
            return {
              label: element.textContent.trim().slice(0, 40),
              width: box.width,
              height: box.height,
            };
          })
          .filter((box) => box.height < 44 || box.width < 44),
      );
    expect(small).toEqual([]);
  });
});
