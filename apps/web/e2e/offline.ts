/**
 * The Playwright `test` used by every spec: the page may only talk to the app under test. Any
 * other request — the OpenFreeMap basemap in particular — is aborted, so no spec depends on the
 * network and the map is exercised in its "basemap unavailable" state.
 */

import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

export const test = base.extend({
  page: async ({ page, baseURL }, provide) => {
    const origin = new URL(baseURL ?? 'http://127.0.0.1:3100').origin;
    await page.route(
      (url) => url.origin !== origin && url.protocol.startsWith('http'),
      (route) => route.abort(),
    );
    await provide(page);
  },
});

export { expect };

export const PLACE = '/place/marrakech-ma-2542997';

/** Serious and critical axe violations, as readable strings. */
export async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.id} (${String(violation.impact)}): ${violation.nodes
          .slice(0, 3)
          .map((node) => node.target.join(' '))
          .join(', ')}`,
    );
}

/** How far the document overflows horizontally; 0 or less means no horizontal scroll. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * Starts collecting browser console errors and uncaught page errors into the returned array.
 * Call it before the first `goto`.
 *
 * This is how a Content-Security-Policy regression is caught (finding F-5): a blocked script is
 * not a build error and not an HTTP error — the document still arrives with status 200, and the
 * only signals are a `Refused to …` console error and a page that never hydrates.
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => {
    errors.push(`uncaught: ${error.message}`);
  });
  return errors;
}

/** The subset of collected console errors that the browser reported as a CSP violation. */
export function cspViolations(errors: readonly string[]): string[] {
  return errors.filter((text) => /content security policy|securitypolicyviolation/iu.test(text));
}

/** Makes `canvas.getContext('webgl2')` return null before any page script runs. */
export async function disableWebGL2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
      ?.value as (this: HTMLCanvasElement, ...args: unknown[]) => unknown;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') return null;
      return original.call(this, type, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}
