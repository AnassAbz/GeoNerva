import {
  PLACE,
  collectConsoleErrors,
  cspViolations,
  expect,
  horizontalOverflow,
  test,
} from './offline.ts';

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

/*
 * Finding F-5. The pages that render provider text are every page, so the policy is asserted on
 * each route family, on a 404 and on an API response, and the nonce must differ between requests
 * (a constant nonce would be `unsafe-inline` with extra steps).
 */
const ROUTES = [
  '/',
  '/methodology',
  '/data-status',
  PLACE,
  '/event/EQ-26-7K3F9Q',
  '/fire/FR-26-4HX2MB',
  '/no-such-page',
  '/api/v1/sources/status',
  // The MapLibre worker is inside the policy too: a same-origin worker inherits the CSP of its
  // own response, and it was measured to still load itself and its shared chunk under it.
  '/maplibre/maplibre-gl-worker.mjs',
];

test('the strict script policy holds on every route (F-5)', async ({ request }) => {
  const seen = new Set<string>();
  for (const route of ROUTES) {
    const headers = (await request.get(route)).headers();
    const csp = headers['content-security-policy'];
    expect(csp, `${route} must carry a CSP`).toBeDefined();
    const directives = new Map(
      (csp ?? '').split('; ').map((directive) => {
        const space = directive.indexOf(' ');
        return space === -1
          ? ([directive, ''] as const)
          : ([directive.slice(0, space), directive.slice(space + 1)] as const);
      }),
    );

    expect(directives.get('default-src'), route).toBe("'self'");

    const scriptSrc = directives.get('script-src') ?? '';
    expect(scriptSrc, route).not.toContain('unsafe-inline');
    expect(scriptSrc, route).not.toContain('unsafe-eval');
    expect(scriptSrc, route).toContain("'strict-dynamic'");
    const nonce = /'nonce-([^']+)'/u.exec(scriptSrc)?.[1];
    expect(nonce, `${route} must carry a nonce`).toBeDefined();
    expect(seen.has(nonce ?? ''), `${route} reused a nonce`).toBe(false);
    seen.add(nonce ?? '');

    // The basemap origin reaches the fetch directives only, exactly and without a wildcard (F-16).
    expect(directives.get('connect-src'), route).toBe("'self' https://tiles.openfreemap.org");
    expect(scriptSrc, route).not.toContain('tiles.openfreemap.org');
    expect(csp, route).not.toContain('*');
  }
});

test('no script is blocked and no CSP violation is reported in the main flows (F-5)', async ({
  page,
}) => {
  const errors = collectConsoleErrors(page);

  await page.goto('/');
  // Hydration ran: the combobox is a client component that only filters once React has taken over.
  await page.getByRole('combobox', { name: 'Search for a place' }).fill('Marr');
  await page.getByRole('option', { name: /Marrakech/u }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Marrakech, Morocco' })).toBeVisible();

  // An interactive control on a page that renders provider text.
  await page
    .getByRole('button', { name: /Evidence \(\d+\)/u })
    .last()
    .click();
  await expect(page.getByRole('dialog', { name: 'Evidence' })).toBeVisible();

  await page.goto('/methodology');
  await expect(page.getByRole('heading', { level: 1, name: /Methodology/u })).toBeVisible();
  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();

  expect(cspViolations(errors), `console errors were:\n${errors.join('\n')}`).toEqual([]);
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
