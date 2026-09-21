/**
 * `params.ts` — the validation boundary (ARCHITECTURE §13.2).
 *
 * This is where every untrusted string enters GeoNerva, so the tests below are written as
 * *attacks and mistakes* rather than as a tour of the happy path. Four properties are load-bearing
 * and each is asserted from the outside:
 *
 *  - **Nothing numeric gets in by coercion.** `NaN`, `Infinity`, `1e999`, `0x1f`, `''` and `' 1'`
 *    must be rejected, not become `0` or `Infinity` and then satisfy a range check.
 *  - **Coordinates are rounded before anything else sees them** (ADR-015, invariant I15).
 *  - **Unknown parameters are refused**, because a tolerated one is a cache-busting primitive.
 *  - **No failure message echoes a submitted value**, because the message reaches logs and CDNs.
 */

import { describe, expect, it } from 'vitest';

import {
  AS_OF_FUTURE_TOLERANCE_MS,
  MAX_QUERY_LENGTH,
  parseAsOf,
  parseFamilies,
  parseFiniteNumber,
  parseLimit,
  parseLocation,
  parsePublicId,
  parseQuery,
  parseWindow,
  rejectUnknownParams,
} from './params.ts';
import { ApiProblemError } from './problem.ts';

const NOW = new Date('2026-09-21T12:00:00.000Z');

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

/** The thrown problem, or a failure if nothing was thrown. */
function problemOf(run: () => unknown): ApiProblemError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiProblemError) return error;
    throw error;
  }
  throw new Error('expected an ApiProblemError, but the call returned');
}

describe('parseFiniteNumber', () => {
  it.each([
    ['0', 0],
    ['-90', -90],
    ['31.63', 31.63],
    ['+7.5', 7.5],
    ['-0.0001', -0.0001],
  ])('accepts %s', (raw, expected) => {
    expect(parseFiniteNumber(raw)).toBe(expected);
  });

  /*
   * Every one of these is a value `Number()` would accept. `Number('')` and `Number(' ')` are 0,
   * which is a valid latitude; `Number('1e999')` is Infinity, which passes `> -90` and fails
   * `< 90` only by luck of operator order. The parser must refuse them before any comparison.
   */
  it.each([
    ['empty', ''],
    ['whitespace', ' '],
    ['leading space', ' 1'],
    ['trailing space', '1 '],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['exponent', '1e999'],
    ['small exponent', '1e2'],
    ['hex', '0x1f'],
    ['comma decimal', '1,5'],
    ['two dots', '1.2.3'],
    ['bare sign', '-'],
    ['underscore separator', '1_0'],
    ['full-width digits', '１２'],
    ['too many integer digits', '1234567890123'],
    ['too many fraction digits', '1.1234567890123'],
  ])('rejects %s', (_label, raw) => {
    expect(parseFiniteNumber(raw)).toBeNull();
  });

  /**
   * A mutation control for the regex, not for `Number`.
   *
   * If the pattern were relaxed to `/^[+-]?[\d.eE+-]+$/` — the shape a "just allow scientific
   * notation" edit produces — then `1e2` parses to 100 and `1e999` to `Infinity`. The finiteness
   * test alone catches the second and **not** the first, so a test that only checked `Infinity`
   * would pass against the broken pattern. This asserts the narrower rule: an exponent is not a
   * coordinate GeoNerva accepts at all.
   */
  it('rejects exponent notation even where the value is finite', () => {
    expect(parseFiniteNumber('1e2')).toBeNull();
    expect(Number('1e2')).toBe(100);
  });
});

describe('rejectUnknownParams', () => {
  it('accepts a request using only declared parameters', () => {
    expect(() => {
      rejectUnknownParams(params('lat=1&lon=2'), ['lat', 'lon', 'as_of']);
    }).not.toThrow();
  });

  it('refuses an undeclared parameter with UNKNOWN_PARAMETER', () => {
    const problem = problemOf(() => {
      rejectUnknownParams(params('lat=1&cachebust=99'), ['lat']);
    });
    expect(problem.problem.code).toBe('UNKNOWN_PARAMETER');
    expect(problem.problem.invalidParams?.map((entry) => entry.name)).toEqual(['cachebust']);
  });

  it('reports every undeclared parameter once, sorted', () => {
    const problem = problemOf(() => {
      rejectUnknownParams(params('b=1&a=2&b=3&c=4'), []);
    });
    expect(problem.problem.invalidParams?.map((entry) => entry.name)).toEqual(['a', 'b', 'c']);
  });

  /*
   * The parameter *name* is attacker-controlled too. It is echoed because it is what the caller
   * needs to fix the request, so it must be capped — an unbounded name would reach the log line
   * and the CDN-cached error body.
   */
  it('caps a hostile parameter name', () => {
    const problem = problemOf(() => {
      rejectUnknownParams(params(`${'x'.repeat(5000)}=1`), []);
    });
    const name = problem.problem.invalidParams?.[0]?.name ?? '';
    expect(name.length).toBeLessThanOrEqual(41);
  });

  it('never echoes the value of an undeclared parameter', () => {
    const secret = 'S3CRET-31.629512,-7.981084';
    const problem = problemOf(() => {
      rejectUnknownParams(params(`token=${encodeURIComponent(secret)}`), []);
    });
    expect(JSON.stringify(problem.problem)).not.toContain('S3CRET');
    expect(JSON.stringify(problem.problem)).not.toContain('31.6295');
  });
});

describe('parseLocation', () => {
  it('rounds a coordinate pair to two decimals', () => {
    expect(parseLocation(params('lat=31.629512&lon=-7.981084'))).toEqual({
      kind: 'coordinates',
      lat: 31.63,
      lon: -7.98,
    });
  });

  /**
   * Invariant I15 from the input side: the precise value must not survive the parser.
   *
   * A parser that returned the raw number and left rounding to the serializer would pass a test
   * that only checked the response, because the precise value would still have reached the cache
   * key and the query. This asserts the rounding happens *here*.
   */
  it('discards precision beyond two decimals rather than carrying it forward', () => {
    const location = parseLocation(params('lat=45.501899&lon=-73.567256'));
    expect(location).toEqual({ kind: 'coordinates', lat: 45.5, lon: -73.57 });
    expect(JSON.stringify(location)).not.toContain('5018');
  });

  it('never returns a negative zero, which JSON renders as 0 but !== 0 under Object.is', () => {
    const location = parseLocation(params('lat=-0.001&lon=-0.004'));
    expect(location).toEqual({ kind: 'coordinates', lat: 0, lon: 0 });
    expect(Object.is((location as { lat: number }).lat, -0)).toBe(false);
  });

  it('folds +180 onto -180 so one meridian is one cache key', () => {
    expect(parseLocation(params('lat=0&lon=180'))).toEqual({
      kind: 'coordinates',
      lat: 0,
      lon: -180,
    });
  });

  it('accepts the poles and the antimeridian inclusively', () => {
    expect(parseLocation(params('lat=90&lon=-180'))).toEqual({
      kind: 'coordinates',
      lat: 90,
      lon: -180,
    });
    expect(parseLocation(params('lat=-90&lon=179.99'))).toEqual({
      kind: 'coordinates',
      lat: -90,
      lon: 179.99,
    });
  });

  it.each([
    ['latitude above the pole', 'lat=90.01&lon=0'],
    ['latitude below the pole', 'lat=-91&lon=0'],
    ['longitude past the antimeridian', 'lat=0&lon=180.01'],
    ['longitude below the antimeridian', 'lat=0&lon=-180.5'],
  ])('rejects %s', (_label, query) => {
    expect(problemOf(() => parseLocation(params(query))).problem.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['NaN latitude', 'lat=NaN&lon=0'],
    ['Infinite longitude', 'lat=0&lon=Infinity'],
    ['empty latitude', 'lat=&lon=0'],
    ['exponent latitude', 'lat=1e1&lon=0'],
  ])('rejects %s as malformed rather than clamping it', (_label, query) => {
    const problem = problemOf(() => parseLocation(params(query)));
    expect(problem.problem.code).toBe('VALIDATION_FAILED');
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('finite decimal');
  });

  it('requires both halves of a coordinate pair', () => {
    expect(problemOf(() => parseLocation(params('lat=31.63'))).problem.invalidParams).toEqual([
      { name: 'lon', reason: 'is required when lat is supplied' },
    ]);
    expect(problemOf(() => parseLocation(params('lon=-8'))).problem.invalidParams).toEqual([
      { name: 'lat', reason: 'is required when lon is supplied' },
    ]);
  });

  /*
   * Refused, not resolved by precedence. Choosing one silently would let a caller be shown a
   * briefing for a location they did not ask about — the one mistake this endpoint cannot make.
   */
  it('refuses a request that names a place and a coordinate pair', () => {
    const problem = problemOf(() => parseLocation(params('place=p:2542997&lat=0&lon=0')));
    expect(problem.problem.invalidParams).toEqual([
      { name: 'place', reason: 'cannot be combined with lat and lon' },
    ]);
  });

  it('requires a location', () => {
    expect(problemOf(() => parseLocation(params(''))).problem.invalidParams).toEqual([
      { name: 'place', reason: 'is required, or supply lat and lon' },
    ]);
  });

  it('accepts the documented location-key forms', () => {
    expect(parseLocation(params('place=p:2542997'))).toEqual({ kind: 'key', key: 'p:2542997' });
  });

  it.each([
    ['an unknown prefix', 'place=z:1'],
    ['a bare number', 'place=2542997'],
    ['a path traversal', 'place=../../etc/passwd'],
    ['a SQL fragment', "place=p:1' OR '1'='1"],
  ])('rejects %s as a location key', (_label, query) => {
    expect(problemOf(() => parseLocation(params(query))).problem.code).toBe('VALIDATION_FAILED');
  });

  it('caps the length of a location key before any pattern work', () => {
    const problem = problemOf(() => parseLocation(params(`place=p:${'9'.repeat(4000)}`)));
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('at most');
  });
});

describe('parseAsOf', () => {
  it('defaults to the request clock when absent', () => {
    expect(parseAsOf(params(''), NOW)).toEqual(NOW);
  });

  it('accepts an instant with Z or an explicit offset', () => {
    expect(parseAsOf(params('as_of=2026-09-21T09:00:00Z'), NOW).toISOString()).toBe(
      '2026-09-21T09:00:00.000Z',
    );
    expect(parseAsOf(params('as_of=2026-09-21T11:00:00%2B02:00'), NOW).toISOString()).toBe(
      '2026-09-21T09:00:00.000Z',
    );
  });

  /*
   * An instant without an offset is ambiguous, and `new Date('2026-09-21T09:00:00')` is parsed in
   * the *server's* local zone — so the same request would mean different knowledge times on two
   * machines. Refused rather than assumed to be UTC.
   */
  it('rejects an instant with no offset', () => {
    expect(problemOf(() => parseAsOf(params('as_of=2026-09-21T09:00:00'), NOW)).problem.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it.each([
    ['a date alone', 'as_of=2026-09-21'],
    ['a relative word', 'as_of=now'],
    ['a unix timestamp', 'as_of=1789000000'],
    ['an oversized string', `as_of=${'2026-09-21T09:00:00Z'.repeat(10)}`],
  ])('rejects %s', (_label, query) => {
    expect(problemOf(() => parseAsOf(params(query), NOW)).problem.code).toBe('VALIDATION_FAILED');
  });

  /** Matches the grammar but is not a real instant. The two checks are both needed. */
  it('rejects an impossible date that matches the pattern', () => {
    expect(problemOf(() => parseAsOf(params('as_of=2026-13-45T09:00:00Z'), NOW)).problem.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('refuses the future with AS_OF_IN_FUTURE rather than clamping to now', () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const problem = problemOf(() => parseAsOf(params(`as_of=${future}`), NOW));
    expect(problem.problem.code).toBe('AS_OF_IN_FUTURE');
  });

  it('absorbs clock skew up to the documented tolerance', () => {
    const skewed = new Date(NOW.getTime() + AS_OF_FUTURE_TOLERANCE_MS - 1).toISOString();
    expect(parseAsOf(params(`as_of=${skewed}`), NOW).getTime()).toBeGreaterThan(NOW.getTime());
  });

  /**
   * A mutation control for the tolerance.
   *
   * If the tolerance were widened to a minute, the test above would still pass. This one pins the
   * boundary from the other side: one millisecond past the tolerance must be refused, so an edit
   * that turns a 5-second allowance into a 5-minute one fails here.
   */
  it('refuses a value one millisecond past the tolerance', () => {
    const past = new Date(NOW.getTime() + AS_OF_FUTURE_TOLERANCE_MS + 1).toISOString();
    expect(problemOf(() => parseAsOf(params(`as_of=${past}`), NOW)).problem.code).toBe(
      'AS_OF_IN_FUTURE',
    );
  });

  it('accepts a knowledge time in the past without bound, leaving the horizon to the service', () => {
    expect(parseAsOf(params('as_of=2019-01-01T00:00:00Z'), NOW).getUTCFullYear()).toBe(2019);
  });
});

describe('parseWindow', () => {
  it('defaults to 24h', () => {
    expect(parseWindow(params(''))).toBe('24h');
  });

  it.each([['6h'], ['24h'], ['7d']])('accepts %s', (value) => {
    expect(parseWindow(params(`window=${value}`))).toBe(value);
  });

  it.each([['1h'], ['30d'], ['24H'], ['']])('rejects %s', (value) => {
    expect(problemOf(() => parseWindow(params(`window=${value}`))).problem.code).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('parseFamilies', () => {
  it('defaults to every family', () => {
    expect(parseFamilies(params('')).length).toBeGreaterThan(1);
  });

  /** Sorted output is what makes two spellings of one request a single CDN key (§13.3). */
  it('returns a canonical order regardless of the order asked for', () => {
    const one = parseFamilies(params('families=FLOODS,EARTHQUAKES'));
    const other = parseFamilies(params('families=EARTHQUAKES&families=FLOODS'));
    expect(one).toEqual(other);
  });

  it('deduplicates', () => {
    expect(parseFamilies(params('families=FLOODS,FLOODS,FLOODS'))).toEqual(['FLOODS']);
  });

  it('rejects a family outside the enum', () => {
    expect(problemOf(() => parseFamilies(params('families=VOLCANOES'))).problem.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('rejects a mixture of valid and invalid families rather than silently dropping one', () => {
    expect(
      problemOf(() => parseFamilies(params('families=EARTHQUAKES,VOLCANOES'))).problem.code,
    ).toBe('VALIDATION_FAILED');
  });
});

describe('parseLimit', () => {
  it('uses the fallback when absent', () => {
    expect(parseLimit(params(''), { max: 50, fallback: 20 })).toBe(20);
  });

  it('accepts the boundaries', () => {
    expect(parseLimit(params('limit=1'), { max: 50, fallback: 20 })).toBe(1);
    expect(parseLimit(params('limit=50'), { max: 50, fallback: 20 })).toBe(50);
  });

  /*
   * A 400, not a clamp. A silent clamp lets a caller believe they received 5,000 results and read
   * a truncated list as a complete one — the pagination-abuse case and a correctness case at once.
   */
  it('refuses a limit above the maximum instead of clamping it', () => {
    const problem = problemOf(() => parseLimit(params('limit=5000'), { max: 50, fallback: 20 }));
    expect(problem.problem.code).toBe('VALIDATION_FAILED');
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('[1, 50]');
  });

  it.each([['0'], ['-1'], ['1.5'], ['1e3'], ['abc'], ['99999'], ['']])('rejects %s', (value) => {
    expect(
      problemOf(() => parseLimit(params(`limit=${value}`), { max: 50, fallback: 20 })).problem.code,
    ).toBe('VALIDATION_FAILED');
  });
});

describe('parseQuery', () => {
  it('trims and returns a usable term', () => {
    expect(parseQuery(params('q=%20Marrakech%20'))).toBe('Marrakech');
  });

  it('requires at least two characters', () => {
    expect(problemOf(() => parseQuery(params('q=a'))).problem.code).toBe('VALIDATION_FAILED');
    expect(problemOf(() => parseQuery(params(''))).problem.code).toBe('VALIDATION_FAILED');
  });

  it('caps the length', () => {
    const problem = problemOf(() => parseQuery(params(`q=${'a'.repeat(MAX_QUERY_LENGTH + 1)}`)));
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('at most');
  });

  /*
   * Rejected rather than stripped. Stripping maps two different requests onto one cache key and
   * hides that the input was malformed; a zero-width joiner in a place name search is not a typo.
   */
  it.each([
    ['a null byte', 'Marra\u0000kech'],
    ['a newline', 'Marra\nkech'],
    ['a zero-width joiner', 'Marra‍kech'],
    ['a right-to-left override', 'Marra‮kech'],
  ])('rejects %s', (_label, value) => {
    const problem = problemOf(() => parseQuery(params(`q=${encodeURIComponent(value)}`)));
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('control characters');
  });
});

describe('parsePublicId', () => {
  it('accepts the shape GeoNerva issues', () => {
    expect(parsePublicId('EQ-26-7K3F9Q')).toBe('EQ-26-7K3F9Q');
  });

  it.each([
    ['lowercase', 'eq-26-7k3f9q'],
    ['a SQL fragment', "EQ-26-7K3F9Q' OR 1=1--"],
    ['a wildcard', 'EQ-26-%'],
    ['a path traversal', '../../EQ-26-7K3F9Q'],
    ['too short a suffix', 'EQ-26-7K3'],
    ['an oversized id', `EQ-26-${'A'.repeat(200)}`],
  ])('rejects %s', (_label, value) => {
    expect(problemOf(() => parsePublicId(value)).problem.code).toBe('VALIDATION_FAILED');
  });

  it('never echoes the rejected identifier', () => {
    const problem = problemOf(() => parsePublicId("EQ-26-AAAA'; DROP TABLE geonerva.sources;--"));
    expect(JSON.stringify(problem.problem)).not.toContain('DROP TABLE');
  });
});
