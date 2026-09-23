/**
 * The smoke script's arguments.
 *
 * The nine checks are HTTP against a running deployment, so the only way to exercise them is to
 * run them against one — which is exactly how three of them were found to be dead: written against
 * an imagined response shape, they could not fail, and no unit test over a mocked `fetch` would
 * have said so either. What is worth pinning *here* is the part that decides **what** gets smoked,
 * because getting that wrong means testing the wrong deployment — or testing one over plaintext
 * and believing the headers it reports.
 */

import { describe, expect, it } from 'vitest';

import { parseArgs } from './smoke.ts';

describe('the smoke arguments', () => {
  it('needs a base URL', () => {
    expect(parseArgs([])).toContain('usage');
    expect(parseArgs(['not a url'])).toContain('not a URL');
  });

  it('defaults to the five demo places, as coordinate keys', () => {
    const options = parseArgs(['https://geonerva.example']);
    expect(typeof options).not.toBe('string');
    if (typeof options === 'string') return;
    expect(options.places).toHaveLength(5);
    expect(options.places[0]).toBe('c:31.63,-8.00');
  });

  it('keeps only the origin, so a path in the argument cannot skew every check', () => {
    const options = parseArgs(['https://geonerva.example/methodology?x=1']);
    if (typeof options === 'string') throw new Error(options);
    expect(options.baseUrl).toBe('https://geonerva.example');
  });

  /*
   * Check 6 asserts HSTS and a CSP. Over plaintext those assertions would be meaningless — and
   * worse, they would pass, because the headers are set regardless of scheme. Localhost is
   * exempted because that is where the script is rehearsed.
   */
  it('refuses plaintext for anything but localhost', () => {
    expect(parseArgs(['http://geonerva.example'])).toContain('plaintext');
    expect(typeof parseArgs(['http://localhost:3000'])).not.toBe('string');
    expect(typeof parseArgs(['http://127.0.0.1:3200'])).not.toBe('string');
  });

  /* A coordinate key contains a comma, so the list separator cannot be one. */
  it('splits an explicit place list on semicolons', () => {
    const options = parseArgs([
      'https://geonerva.example',
      '--place',
      'c:31.63,-8.00; c:35.68,139.69',
    ]);
    if (typeof options === 'string') throw new Error(options);
    expect(options.places).toEqual(['c:31.63,-8.00', 'c:35.68,139.69']);
  });

  it('refuses an empty or missing place list rather than smoking nothing', () => {
    expect(parseArgs(['https://geonerva.example', '--place'])).toContain('comma-separated');
    expect(parseArgs(['https://geonerva.example', '--place', ''])).toContain('comma-separated');
    expect(parseArgs(['https://geonerva.example', '--quick'])).toContain('unknown argument');
  });
});
