/**
 * `params.ts` — the validation boundary (ARCHITECTURE §13.2).
 *
 * This is where every untrusted string enters GeoNerva, so the tests below are written as
 * *attacks and mistakes* rather than as a tour of the happy path. Four properties are load-bearing
 * and each is asserted from the outside:
 *
 *  - **Nothing numeric gets in by coercion.** `NaN`, `Infinity`, `1e999`, `0x1f`, `''` and `' 1'`
 *    must be rejected, not become `0` or `Infinity` and then satisfy a range check.
 *  - **A coordinate must arrive already rounded.** Rounding it here satisfied I15 for the
 *    response body and left the caller's full-precision position in the CDN cache key and the
 *    platform's access log, which is what ADR-015's "before logging, caching" forbids.
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
  parseHistory,
  parseLimit,
  parseLocation,
  parsePublicId,
  parseQuery,
  parseViewport,
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

  /**
   * A repeated parameter is the same attack as an unknown one, and only the first was caught.
   *
   * `?window=24h&window=24h&window=24h` is one response under three CDN keys, and
   * `URLSearchParams.get` silently takes the first — so nothing downstream could notice.
   */
  it('refuses a repeated parameter', () => {
    const problem = problemOf(() => {
      rejectUnknownParams(params('lat=1&lon=2&window=24h&window=24h'), ['lat', 'lon', 'window']);
    });
    expect(problem.problem.code).toBe('VALIDATION_FAILED');
    expect(problem.problem.invalidParams).toEqual([
      { name: 'window', reason: 'must appear at most once' },
    ]);
  });

  it('reports every repeated parameter once, sorted', () => {
    const problem = problemOf(() => {
      rejectUnknownParams(params('b=1&b=2&a=1&a=2&c=1'), ['a', 'b', 'c']);
    });
    expect(problem.problem.invalidParams?.map((entry) => entry.name)).toEqual(['a', 'b']);
  });

  /* §13.1 writes it `families[]`, so it is the one parameter that may repeat. */
  it('allows families to repeat', () => {
    expect(() => {
      rejectUnknownParams(params('families=FLOODS&families=EARTHQUAKES'), ['families']);
    }).not.toThrow();
  });

  it('reports an unknown parameter before a repeated one, as the more basic mistake', () => {
    const problem = problemOf(() => {
      rejectUnknownParams(params('nope=1&lat=1&lat=2'), ['lat']);
    });
    expect(problem.problem.code).toBe('UNKNOWN_PARAMETER');
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
  it('accepts an already-rounded pair', () => {
    expect(parseLocation(params('lat=31.63&lon=-7.98'))).toEqual({
      kind: 'coordinates',
      lat: 31.63,
      lon: -7.98,
    });
  });

  /**
   * Invariant I15 from the input side, and the reason it is a *refusal* rather than a rounding.
   *
   * A server cannot round before the URL reaches the CDN: by the time this code runs,
   * `?lat=31.629512` is already the cache key and already in the platform's access log. Rounding
   * on arrival made the response body clean and left the caller's ~10 cm position at the edge for
   * two minutes. So a finer coordinate is refused, and the reason names the rule.
   */
  it.each([
    ['six decimals', 'lat=31.629512&lon=-7.981084'],
    ['three decimals', 'lat=45.501&lon=-73.57'],
    ['a precise longitude only', 'lat=45.50&lon=-73.567256'],
  ])('refuses %s rather than rounding it', (_label, query) => {
    const problem = problemOf(() => parseLocation(params(query)));
    expect(problem.problem.code).toBe('VALIDATION_FAILED');
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('decimals');
  });

  it('never echoes the precise coordinate it refused', () => {
    const problem = problemOf(() => parseLocation(params('lat=31.629512&lon=-7.981084')));
    expect(JSON.stringify(problem.problem)).not.toContain('629512');
    expect(JSON.stringify(problem.problem)).not.toContain('981084');
  });

  it('accepts a whole number and a single decimal, which are already canonical', () => {
    expect(parseLocation(params('lat=45&lon=-73'))).toEqual({
      kind: 'coordinates',
      lat: 45,
      lon: -73,
    });
    expect(parseLocation(params('lat=45.5&lon=-73.5'))).toEqual({
      kind: 'coordinates',
      lat: 45.5,
      lon: -73.5,
    });
  });

  /*
   * `-0.00` is canonical by the decimal rule and must not survive as `-0`: it serializes as `-0`
   * in JSON, which is a second spelling of one location and therefore a second cache key.
   */
  it('never returns a negative zero, which JSON renders as -0 and is a second cache key', () => {
    const location = parseLocation(params('lat=-0.00&lon=-0.00'));
    expect(location).toEqual({ kind: 'coordinates', lat: 0, lon: 0 });
    expect(Object.is((location as { lat: number }).lat, -0)).toBe(false);
    expect(JSON.stringify(location)).not.toContain('-0');
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

  /* The message must advertise only what `resolveLocation` can resolve. */
  it('names the place-key form in its failure reason', () => {
    const problem = problemOf(() => parseLocation(params('place=z:1')));
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('p:2542997');
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

  it('mentions the percent-encoded plus, because a bare + decodes to a space', () => {
    const problem = problemOf(() => parseAsOf(params('as_of=2026-09-21T09:00:00 02:00'), NOW));
    expect(problem.problem.detail).toContain('%2B');
  });

  /**
   * The tolerance, pinned as a literal.
   *
   * The previous version of this control computed its expectation from
   * `AS_OF_FUTURE_TOLERANCE_MS + 1`, so the expectation moved with the constant and the control
   * could not detect the mutation it was named for: widening 5 s to 59 s left the whole suite
   * passing. Five seconds is the documented allowance for clock skew, so five seconds is what the
   * test says.
   */
  it('allows exactly five seconds of clock skew, and not six', () => {
    expect(AS_OF_FUTURE_TOLERANCE_MS).toBe(5_000);

    const withinSkew = new Date(NOW.getTime() + 4_000).toISOString();
    expect(parseAsOf(params(`as_of=${withinSkew}`), NOW).getTime()).toBeGreaterThan(NOW.getTime());

    const pastSkew = new Date(NOW.getTime() + 6_000).toISOString();
    expect(problemOf(() => parseAsOf(params(`as_of=${pastSkew}`), NOW)).problem.code).toBe(
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

  /*
   * `?families=` used to yield `[]` — a request for no families at all, which would render as a
   * briefing with nothing in it for a reason the caller never asked for. A false zero from a typo.
   */
  it('treats an empty families parameter as every family, not as none', () => {
    expect(parseFamilies(params('families='))).toEqual(parseFamilies(params('')));
    expect(parseFamilies(params('families=,,'))).toEqual(parseFamilies(params('')));
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
  it('accepts the shape GeoNerva issues, for the kind the endpoint serves', () => {
    expect(parsePublicId('EQ-26-7K3F9Q', 'canonical_event')).toBe('EQ-26-7K3F9Q');
    expect(parsePublicId('FR-26-7K3F9Q', 'fire_cluster')).toBe('FR-26-7K3F9Q');
  });

  it.each([
    ['an unknown prefix', 'XX-26-7K3F9Q'],
    ['a four-character token', 'EQ-26-7K3F'],
    ['a letter Crockford base32 leaves out', 'EQ-26-7K3F9U'],
  ])('rejects %s, which the looser earlier pattern accepted', (_label, value) => {
    expect(problemOf(() => parsePublicId(value, 'canonical_event')).problem.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('refuses a cluster id on the event endpoint and an event id on the cluster endpoint', () => {
    const onEvents = problemOf(() => parsePublicId('FR-26-7K3F9Q', 'canonical_event'));
    expect(onEvents.problem.detail).toContain('/api/v1/fire-clusters/');
    const onClusters = problemOf(() => parsePublicId('EQ-26-7K3F9Q', 'fire_cluster'));
    expect(onClusters.problem.detail).toContain('/api/v1/events/');
  });

  it.each([
    ['lowercase', 'eq-26-7k3f9q'],
    ['a SQL fragment', "EQ-26-7K3F9Q' OR 1=1--"],
    ['a wildcard', 'EQ-26-%'],
    ['a path traversal', '../../EQ-26-7K3F9Q'],
    ['too short a suffix', 'EQ-26-7K3'],
    ['an oversized id', `EQ-26-${'A'.repeat(200)}`],
  ])('rejects %s', (_label, value) => {
    expect(problemOf(() => parsePublicId(value, 'canonical_event')).problem.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('never echoes the rejected identifier', () => {
    const problem = problemOf(() =>
      parsePublicId("EQ-26-AAAA'; DROP TABLE geonerva.sources;--", 'canonical_event'),
    );
    expect(JSON.stringify(problem.problem)).not.toContain('DROP TABLE');
  });
});

describe('parseViewport', () => {
  /*
   * At zoom 6 the grid step is 90 / 2^6 = 1.40625°, and every edge below is a multiple of it.
   * The expectations are written as literals rather than computed from `quantizationStepDegrees`,
   * so that changing the grid rule changes what these tests accept.
   */
  const MOROCCO = '-11.25,28.125,-5.625,33.75';
  const FIJI = '177.1875,-19.6875,-177.1875,-16.875';

  function viewport(bbox: string, zoom: string): ReturnType<typeof parseViewport> {
    return parseViewport(
      new URLSearchParams([
        ['bbox', bbox],
        ['zoom', zoom],
      ]),
    );
  }

  it('accepts a grid-aligned box and an integer zoom', () => {
    expect(viewport(MOROCCO, '6')).toStrictEqual({
      bbox: { west: -11.25, south: 28.125, east: -5.625, north: 33.75 },
      zoom: 6,
    });
  });

  it('accepts a box across the antimeridian, keeping west > east', () => {
    expect(viewport(FIJI, '6').bbox).toStrictEqual({
      west: 177.1875,
      south: -19.6875,
      east: -177.1875,
      north: -16.875,
    });
  });

  it('accepts the whole world at zoom 4, where the size cap no longer applies', () => {
    expect(viewport('-180,-90,180,90', '4').bbox).toStrictEqual({
      west: -180,
      south: -90,
      east: 180,
      north: 90,
    });
  });

  it('requires both parameters, naming each', () => {
    const problem = problemOf(() => parseViewport(params('')));
    expect(problem.problem.code).toBe('VALIDATION_FAILED');
    expect(problem.problem.invalidParams?.map((entry) => entry.name)).toStrictEqual([
      'bbox',
      'zoom',
    ]);
  });

  it.each(['6.5', '-1', '23', '06', '', 'x', '1e1', ' 6'])('rejects zoom=%j', (zoom) => {
    const problem = problemOf(() => viewport(MOROCCO, zoom));
    expect(problem.problem.code).toBe('VALIDATION_FAILED');
    expect(problem.problem.invalidParams?.map((entry) => entry.name)).toContain('zoom');
  });

  it('accepts the highest zoom and refuses the next one', () => {
    expect(viewport(MOROCCO, '22').zoom).toBe(22);
    expect(problemOf(() => viewport(MOROCCO, '23')).problem.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['three edges', '-11.25,28.125,-5.625'],
    ['five edges', '-11.25,28.125,-5.625,33.75,0'],
    ['an empty edge', '-11.25,,-5.625,33.75'],
    ['NaN', 'NaN,28.125,-5.625,33.75'],
    ['exponent notation', '-1.125e1,28.125,-5.625,33.75'],
    ['Infinity', '-11.25,28.125,Infinity,33.75'],
    ['a space', '-11.25, 28.125,-5.625,33.75'],
  ])('rejects %s', (_label, bbox) => {
    const problem = problemOf(() => viewport(bbox, '6'));
    expect(problem.problem.code).toBe('VALIDATION_FAILED');
    expect(problem.problem.invalidParams?.[0]?.name).toBe('bbox');
  });

  it('rejects an oversized bbox string', () => {
    const problem = problemOf(() => viewport(`${'1'.repeat(118)},0,1,1`, '6'));
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('four finite decimals');
  });

  it.each([
    ['a trailing zero', '-11.250,28.125,-5.625,33.75'],
    ['a plus sign', '-11.25,+28.125,-5.625,33.75'],
    ['negative zero', '-0,28.125,5.625,33.75'],
    ['a leading zero', '-11.25,028.125,-5.625,33.75'],
  ])('rejects %s, which would be a second cache key for one box', (_label, bbox) => {
    const problem = problemOf(() => viewport(bbox, '6'));
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('shortest form');
  });

  it.each([
    ['a western edge on +180', '180,0,-174.375,5.625', 'west must be within [-180, 180)'],
    ['an eastern edge on -180', '174.375,0,-180,5.625', 'east must be within (-180, 180]'],
    ['a western edge past -180', '-181.40625,0,5.625,5.625', 'west must be within [-180, 180)'],
    [
      'a latitude past the pole',
      '0,84.375,5.625,91.40625',
      'south and north must be within [-90, 90]',
    ],
  ])('rejects %s', (_label, bbox, reason) => {
    const problem = problemOf(() => viewport(bbox, '6'));
    expect(problem.problem.invalidParams?.map((entry) => entry.reason)).toContain(reason);
  });

  it.each([
    ['zero height', '-11.25,28.125,-5.625,28.125', 'south must be less than north'],
    ['an inverted box', '-11.25,33.75,-5.625,28.125', 'south must be less than north'],
    ['zero width', '-5.625,28.125,-5.625,33.75', 'west and east must differ'],
  ])('rejects a degenerate box: %s', (_label, bbox, reason) => {
    const problem = problemOf(() => viewport(bbox, '6'));
    expect(problem.problem.invalidParams?.map((entry) => entry.reason)).toContain(reason);
  });

  it('rejects an edge off the grid, naming the step and never the value', () => {
    // -8.07 is Marrakech's longitude: a precise position, exactly what must not become a key.
    const problem = problemOf(() => viewport('-8.07,28.125,-5.625,33.75', '6'));
    expect(problem.problem.code).toBe('VALIDATION_FAILED');
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('1.40625°');
    expect(JSON.stringify(problem.problem)).not.toContain('8.07');
  });

  it.each([
    // Controls: "south off the grid" and "north off the grid". Each edge alone, so no other
    // edge's check can be what refuses it.
    ['south', '-11.25,28.2,-5.625,33.75'],
    ['north', '-11.25,28.125,-5.625,33.7'],
  ])('rejects a %s edge off the grid', (_edge, bbox) => {
    const problem = problemOf(() => viewport(bbox, '6'));
    expect(problem.problem.code).toBe('VALIDATION_FAILED');
    expect(problem.problem.invalidParams?.[0]?.reason).toContain('1.40625°');
  });

  it('judges the grid by the zoom', () => {
    // 1.40625 is a multiple of zoom 8's 0.3515625, so the zoom-6 box is still aligned at zoom 8…
    expect(viewport(MOROCCO, '8').zoom).toBe(8);
    // …but a zoom-8 edge is not on zoom 6's coarser grid.
    expect(problemOf(() => viewport('-11.25,28.125,-5.2734375,33.75', '6')).problem.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  describe('the size cap below zoom 4 (§13.2)', () => {
    // At zoom 2 the grid step is 22.5°; at zoom 3 it is 11.25°.
    it('accepts a 45° box at zoom 2', () => {
      expect(viewport('-22.5,0,22.5,45', '2').bbox.east).toBe(22.5);
    });

    it('refuses a box wider than 60° with BBOX_TOO_LARGE', () => {
      const problem = problemOf(() => viewport('-45,0,22.5,45', '2'));
      expect(problem.problem.code).toBe('BBOX_TOO_LARGE');
      expect(problem.problem.invalidParams?.[0]?.name).toBe('bbox');
    });

    it('refuses a box taller than 60°', () => {
      expect(problemOf(() => viewport('0,-33.75,11.25,33.75', '3')).problem.code).toBe(
        'BBOX_TOO_LARGE',
      );
    });

    it('accepts 56.25°, the widest the zoom-3 grid can draw under the cap', () => {
      expect(viewport('0,0,56.25,56.25', '3').bbox.north).toBe(56.25);
    });

    it('refuses 67.5°, the next the zoom-3 grid can draw', () => {
      expect(problemOf(() => viewport('0,0,67.5,56.25', '3')).problem.code).toBe('BBOX_TOO_LARGE');
    });

    it('measures an antimeridian box the short way round', () => {
      // 157.5 → -157.5 is 45° across the Pacific, not 315°.
      expect(viewport('157.5,0,-157.5,45', '2').bbox.west).toBe(157.5);
    });

    it('lifts the cap at zoom 4', () => {
      expect(viewport('-45,0,22.5,45', '4').zoom).toBe(4);
    });
  });
});

describe('parseHistory', () => {
  function invalidParamOf(query: string): { name: string; reason: string } | undefined {
    try {
      parseHistory(params(query));
    } catch (error) {
      expect(error).toBeInstanceOf(ApiProblemError);
      return (error as ApiProblemError).problem.invalidParams?.[0];
    }
    throw new Error(`expected ${query} to be refused`);
  }

  it("defaults to the family's primary metric and that metric's default radius", () => {
    expect(parseHistory(params('family=EARTHQUAKES'))).toEqual({
      family: 'EARTHQUAKES',
      metric: 'EQ_COUNT_7D',
      radiusKm: 150,
    });
    expect(parseHistory(params('family=FLOODS'))).toEqual({
      family: 'FLOODS',
      metric: 'GDACS_CONTEXT',
      radiusKm: 300,
    });
    expect(parseHistory(params('family=FIRE_ACTIVITY'))).toEqual({
      family: 'FIRE_ACTIVITY',
      metric: 'FIRE_TREND',
      radiusKm: 100,
    });
  });

  it('accepts each calibrated radius and the secondary window', () => {
    for (const radius of [50, 150, 300]) {
      expect(
        parseHistory(params(`family=EARTHQUAKES&metric=EQ_COUNT_30D&radius_km=${String(radius)}`)),
      ).toEqual({ family: 'EARTHQUAKES', metric: 'EQ_COUNT_30D', radiusKm: radius });
    }
  });

  it('requires a family, rather than defaulting a typo to earthquakes', () => {
    expect(invalidParamOf('')?.name).toBe('family');
    expect(invalidParamOf('family=earthquakes')?.name).toBe('family');
  });

  it('refuses a family with no historical metric', () => {
    expect(invalidParamOf('family=WEATHER_ALERTS')).toEqual({
      name: 'family',
      reason: 'has no historical metric yet',
    });
  });

  it('refuses a metric that belongs to another family', () => {
    expect(invalidParamOf('family=FLOODS&metric=EQ_COUNT_7D')?.name).toBe('metric');
    expect(invalidParamOf('family=EARTHQUAKES&metric=GDACS_CONTEXT')?.name).toBe('metric');
  });

  it('refuses any radius the metric was not calibrated for, never rounding to one', () => {
    for (const radius of ['151', '0', '-150', '150.0', '1e2', '', '3000', 'abc']) {
      expect(invalidParamOf(`family=EARTHQUAKES&radius_km=${radius}`), radius).toEqual({
        name: 'radius_km',
        reason: 'must be one of: 50, 150, 300',
      });
    }
    expect(invalidParamOf('family=FLOODS&radius_km=150')?.name).toBe('radius_km');
  });

  it('does not echo a submitted value', () => {
    expect(JSON.stringify(invalidParamOf('family=EARTHQUAKES&radius_km=987'))).not.toContain('987');
    expect(JSON.stringify(invalidParamOf('family=xyzzy'))).not.toContain('xyzzy');
  });
});

describe('parseQuery: a coordinate is a position (ADR-015)', () => {
  function reasonFor(q: string): string | undefined {
    try {
      parseQuery(params(`q=${encodeURIComponent(q)}`));
    } catch (error) {
      expect(error).toBeInstanceOf(ApiProblemError);
      return (error as ApiProblemError).problem.invalidParams?.[0]?.reason;
    }
    return undefined;
  }

  it('refuses a coordinate pair with more than two decimals, without echoing it', () => {
    for (const q of ['48.856614,2.352222', '48.85 2.352', '-33.868;151.21', '+48.8566, 2.35']) {
      expect(reasonFor(q), q).toBe('must not contain a coordinate with more than 2 decimals');
    }
    expect(reasonFor('48.856614,2.352222')).not.toContain('856614');
  });

  it('accepts a rounded pair, and ordinary text with numbers in it', () => {
    for (const q of ['48.86,2.35', 'Marrakech', 'Route 66', 'Apt 12, 3.5 km', 'Paris 75001']) {
      expect(reasonFor(q), q).toBeUndefined();
    }
  });
});
