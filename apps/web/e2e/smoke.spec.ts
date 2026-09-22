import { PLACE, expect, horizontalOverflow, test } from './offline.ts';

/*
 * Updated in P9a: the placeholder home page ("No live hazard data is shown yet") is replaced by
 * the landing page with search, so the first test now checks the landing page instead.
 */
test('home page renders with the search box and the not-a-warning-system note', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'GeoNerva' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Search for a place' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('not an emergency-warning system');
});

test('baseline security headers are present', async ({ request }) => {
  const response = await request.get('/');
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers['x-powered-by']).toBeUndefined();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['strict-transport-security']).toContain('max-age=');
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
});

test('the CSP allows the basemap origin only where the map needs it', async ({ request }) => {
  const csp = (await request.get(PLACE)).headers()['content-security-policy'] ?? '';
  expect(csp).toContain("connect-src 'self' https://tiles.openfreemap.org");
  expect(csp).toContain("img-src 'self' data: blob: https://tiles.openfreemap.org");
  expect(csp).toContain("worker-src 'self' blob:");
  expect(csp).toContain("object-src 'none'");
});

test('the MapLibre worker is served from this origin', async ({ request }) => {
  const response = await request.get('/maplibre/maplibre-gl-worker.mjs');
  expect(response.status()).toBe(200);
});

test('no horizontal scroll at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
