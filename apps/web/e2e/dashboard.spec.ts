/**
 * The flows of docs/TESTING.md §5 that run against the **all-fresh** seeded scenario.
 *
 * P9b replaced the fixture read models with the service layer, so every assertion here is now
 * against what the engines actually produce from the seeded database. Where a P9a assertion is
 * gone it is because the mock and the engine disagreed and the engine was right — the clearest
 * case being the headline: `packages/test-fixtures/scenarios/marrakech.ts` says so at length, and
 * the seed carries an M5.4 45 km away precisely so that "What Changed" has something the relevance
 * table really ranks that way.
 *
 * Two flows of §5 are **not** here: coordinate entry and "Use my location". They belong to the
 * landing-search deliverable and are another agent's work.
 *
 * The outage flow lives in `outage.spec.ts`, which runs against the other scenario.
 */

import { PLACE, disableWebGL2, expect, test } from './offline.ts';

/** Both spellings resolve: a slug's trailing GeoNames id is what is read, the name is decoration. */
const PLACE_URL = /\/place\/marrak\w*-ma-2542997$/u;

test('search "Marr" → suggestion → dashboard with headline, What Changed and cards', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Search for a place' }).fill('Marr');
  await page.getByRole('option', { name: /Marrak/u }).click();
  await expect(page).toHaveURL(PLACE_URL);
  await expect(page.getByRole('heading', { level: 1, name: 'Marrakesh' })).toBeVisible();
  await expect(page.getByText(/worth your attention/u).first()).toBeVisible();
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
  await page
    .getByRole('list', { name: 'What changed' })
    .getByRole('link', { name: /M5\.4 earthquake/u })
    .click();
  await expect(page).toHaveURL(/\/event\/EQ-26-8TD4XH\?place=marrakech-ma-2542997$/u);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('M5.4 earthquake');

  /* Two sources side by side, each with its own value, and the spread between them. */
  const facts = page.getByRole('table');
  await expect(facts).toContainText('5.4');
  await expect(facts).toContainText('5.3');
  await expect(facts).toContainText('9 km');
  await expect(facts).toContainText('11 km');
  await expect(page.getByText('Agreement: sources agree')).toBeVisible();
  await expect(page.getByText(/2 independent sources/u).first()).toBeVisible();
  await expect(
    page.getByText(/values are shown because a reviewed USGS solution comes first/u),
  ).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Timeline of versions' })).toBeVisible();
  await expect(page.getByText(/first reported it as M5\.4/u)).toBeVisible();

  await page
    .getByRole('button', { name: /Evidence/u })
    .first()
    .click();
  const drawer = page.getByRole('dialog', { name: 'Evidence' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('an event revised by its source shows both values and what changed between them', async ({
  page,
}) => {
  /* The M4.7 the two-source revision belongs to, reached the way a reader reaches it. */
  await page.goto(PLACE);
  await page.getByRole('table').getByRole('link', { name: 'M4.7 earthquake' }).click();
  await expect(page).toHaveURL(/\/event\/EQ-26-7K3F9Q\?place=marrakech-ma-2542997$/u);
  await expect(
    page.getByText(/revised the magnitude from M4\.6 to M4\.7 and marked it reviewed/u),
  ).toBeVisible();
  await expect(page.getByText(/2 independent of 3 sources/u).first()).toBeVisible();
});

test('the evidence drawer opens from a derived statement and its provider links resolve', async ({
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
  /*
   * ADR-038's "Raw record". The seeded scenario stores no provider bodies — the scenario writes
   * through the repositories and never captures a payload — so every observation reports the one
   * lifecycle that is true of it. That the section is here at all is what P9b's evidence-detail
   * seam buys: the drawer never fetches, so without the page resolving the details this is blank.
   */
  await expect(drawer.getByText('Raw record').first()).toBeVisible();
  await expect(drawer.getByText(/Never captured/u).first()).toBeVisible();
  await drawer.getByRole('button', { name: 'Close evidence' }).click();
  await expect(drawer).toBeHidden();
});

test('as_of shows the replay banner and hides later data', async ({ page }) => {
  /* 10:10 is before the M4.7 was ingested (11:58) and before the clustering run that summarized
   * the fire cluster, so both are absent — which is the point of the flow. */
  await page.goto(`${PLACE}?as_of=2026-09-22T10:10:00Z`);
  await expect(page.getByTestId('replay-banner')).toContainText(
    'Replay — showing what GeoNerva knew at 10:10 UTC, 22 Sep 2026.',
  );
  await expect(page.getByTestId('replay-banner')).toContainText(
    'Information that arrived later is hidden.',
  );
  await expect(page.getByRole('table')).not.toContainText('M4.7 earthquake');
  /* And it is there in the present, so the absence above is the knowledge time and not the seed. */
  await page.goto(PLACE);
  await expect(page.getByRole('table')).toContainText('M4.7 earthquake');
});

/*
 * The other half of the replay flow, and the one that caught a real bug: `asOfContextFor` decided
 * `isReplay` from `Date.now()` rather than from the request's own clock, so under
 * `GEONERVA_FAKE_NOW` — an instant by construction in the past of the wall clock — every live
 * briefing was flagged as a replay and this link went nowhere. Fixed by threading the caller's
 * present through; this is what would notice it coming back.
 */
test('"Return to the present" clears the replay banner', async ({ page }) => {
  await page.goto(`${PLACE}?as_of=2026-09-22T10:10:00Z`);
  await page.getByRole('link', { name: 'Return to the present' }).click();
  await expect(page.getByTestId('replay-banner')).toHaveCount(0);
});

test.describe('desktop only', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop flows (docs/TESTING.md §5)');

  test('not-covered state (weather) and the refusal states beside a real one', async ({ page }) => {
    await page.goto(PLACE);
    await expect(
      page.getByText('Weather warnings are not covered for this location.'),
    ).toBeVisible();

    /*
     * The fire card names the reason it cannot compare, and it is coverage, not history: the
     * aggregate needs 35 read days (ADR-040) and the seeded world has days it did not read. This
     * used to read "Not enough history to establish a baseline" on *every* card, including one
     * the same page gave 259 reference windows — QA round 2's H-1.
     */
    const fire = page.getByRole('article', { name: /Fire activity/iu });
    // The sentence appears in the card's context row and again in its disclosure; either will do.
    await expect(
      fire.getByText('Not enough satellite coverage in the last five weeks').first(),
    ).toBeVisible();

    /* And the other half of that finding: a card with a baseline states it, on the card. */
    const quakes = page.getByRole('article', { name: /Earthquakes/iu });
    await expect(quakes.getByText(/above typical/iu).first()).toBeVisible();
    await expect(quakes.getByText('Not enough history to establish a baseline.')).toHaveCount(0);
  });

  /**
   * The window selector changes the diff.
   *
   * Not by a count: the seeded world has one material change in every window — the M5.4, six hours
   * old — so 6 h, 24 h and 7 d all list one item, and asserting "3, then 1, then 4" would be
   * asserting the P9a mock rather than the engine. What the window does change is the diff itself:
   * the period it is computed over, the wording of the signal at the shorter window, and the
   * sentence the situation strip summarizes it with.
   */
  test('the window selector 6 h / 24 h / 7 d changes the diff', async ({ page }) => {
    await page.goto(PLACE);
    const changes = page.getByRole('list', { name: 'What changed' }).locator(':scope > li');
    await expect(changes).toHaveCount(1);
    await expect(page.getByText('1 change in the last 24 hours.')).toBeVisible();

    await page.getByRole('link', { name: '6 h' }).click();
    await expect(page).toHaveURL(/window=6h/u);
    await expect(page.getByRole('link', { name: '6 h' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('1 change in the last 6 hours.')).toBeVisible();
    await expect(changes.first()).toContainText('newly reported');

    await page.getByRole('link', { name: '7 d' }).click();
    await expect(page).toHaveURL(/window=7d/u);
    await expect(page.getByRole('link', { name: '7 d' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: /What changed/u })).toContainText('7 d');
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
    /* Seven assessed subjects: five earthquakes, the fire cluster and the flood. */
    await expect(table.getByRole('rowheader')).toHaveCount(7);
    await table.getByRole('button', { name: /Relevance/u }).click();
    await expect(table.getByRole('rowheader').first()).toContainText('M5.4 earthquake');
    await table.getByRole('link', { name: 'Fire activity' }).click();
    await expect(page).toHaveURL(/\/fire\/FR-26-4HX2MB/u);
    await expect(page.getByRole('note').first()).toContainText('They are not confirmed wildfires.');
  });

  test('the Why? popover opens and closes from the keyboard', async ({ page }) => {
    await page.goto(PLACE);
    const why = page.getByRole('button', { name: /^Why\? Relevance: M5\.4/u }).first();
    await why.focus();
    await page.keyboard.press('Enter');
    await expect(why).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page.getByRole('region', { name: /^Why\? Relevance: M5\.4/u }).first(),
    ).toContainText('About 45 km away.');
    await page.keyboard.press('Escape');
    await expect(why).toHaveAttribute('aria-expanded', 'false');
    await expect(why).toBeFocused();
  });
});

test.describe('mobile only', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile flows (docs/TESTING.md §5)');

  test('cards are an accordion and the map opens as a full-screen sheet', async ({ page }) => {
    await page.goto(PLACE);
    /* "The first card with HIGH or CRITICAL relevance starts expanded" — here, earthquakes. */
    await expect(page.getByRole('button', { name: /^Earthquakes/u })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const header = page.getByRole('button', { name: /^Floods/u });
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
