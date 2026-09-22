/**
 * Coordinate entry: the forms a person types into the search box, and what GeoNerva does with
 * them before anything leaves the browser (ADR-015, invariant I15).
 *
 * ### Why this exists in the client at all
 *
 * `lib/server/params.ts` already holds the API's rules, and they are the rules — a coordinate
 * must be a strict finite decimal, must be in range, and must arrive **already rounded to two
 * decimals**, because "a server cannot round before the URL reaches the CDN". The consequence of
 * that rule is a client-side obligation: if the visitor types `48.856614, 2.352222`, their
 * ~10 cm position must never become a request, so it must be recognised and rounded *here*,
 * before the type-ahead fires. Sending it and letting the server refuse it would put the precise
 * position in the platform's access log, which is the exact residue the server rule exists to
 * avoid.
 *
 * So this module answers two questions for the search box:
 *
 *  - `isCoordinateEntry` — "is the visitor typing a position?" If yes, **no request is made**,
 *    whatever the text turns out to mean. It is deliberately coarse: anything made only of
 *    digits, signs, separators, degree marks and hemisphere letters counts.
 *  - `parseCoordinateEntry` — "what position, rounded?" The result is already at two decimals.
 *
 * ### The rules are the server's, and a test pins them together
 *
 * `params.ts` cannot be imported from a `'use client'` module — `server-boundary.test.ts` fails
 * the build for it, and rightly: that module reaches the validated environment and the pool. Nor
 * can it import this one, since it is not a file this change owns. So the two agree by test
 * rather than by construction: `coordinates.test.ts` feeds every coordinate this parser produces
 * through the server's own `parseLocation`, which must accept it unchanged. A divergence in
 * either direction fails there. The handoff note proposes `packages/geo` — which already owns
 * "coordinate parsing" by its own charter — as the single home for both.
 *
 * ### What is refused rather than interpreted
 *
 * Sexagesimal — `31°37'48"N`, `31:37:48 N`, degrees with decimal minutes — is reported as
 * `sexagesimal` and never guessed at. `params.ts` refuses those spellings in `q` because they
 * carry a position finer than two decimals; guessing at one here would either reproduce that
 * precision or silently mean a different place than the visitor wrote.
 */

import {
  MAX_LATITUDE,
  MAX_LONGITUDE,
  MIN_LATITUDE,
  MIN_LONGITUDE,
  USER_COORDINATE_DECIMALS,
  roundUserCoordinate,
} from '@geonerva/domain';

/** What a piece of typed text turned out to be. */
export type CoordinateEntry =
  | {
      readonly kind: 'coordinate';
      /** Already rounded to `USER_COORDINATE_DECIMALS`. */
      readonly lat: number;
      /** Already rounded, and normalized so that +180 is written as −180. */
      readonly lon: number;
      /** True when the typed value carried more precision than GeoNerva keeps. */
      readonly wasRounded: boolean;
    }
  /** A pair of numbers, but not a point on the globe. */
  | { readonly kind: 'out-of-range' }
  /** Degrees and minutes, or degrees, minutes and seconds. Reported, never interpreted. */
  | { readonly kind: 'sexagesimal' }
  /** Not a coordinate. */
  | { readonly kind: 'none' };

/**
 * True when the text is made only of the characters a position is written with.
 *
 * The search box uses this to decide whether to call the type-ahead **at all**, so it is
 * evaluated on every keystroke including the half-typed ones: `31.6315` on its own, or
 * `31.63,`, is already on the way to being a position and is not a place name. The cost of a
 * false positive is one lost type-ahead for a query like `66`; the cost of a false negative is a
 * visitor's position in a URL.
 */
export function isCoordinateEntry(raw: string): boolean {
  const text = raw.trim();
  return text !== '' && /\d/u.test(text) && /^[\d\s+\-.,;:°˚º'’′"″NSEWnsew]+$/u.test(text);
}

/** +180 and −180 name one meridian; GeoNerva writes it −180, as `params.ts` does. */
export function normalizeLongitude(lon: number): number {
  return lon === MAX_LONGITUDE ? MIN_LONGITUDE : lon;
}

/** Marks that mean "degrees" on some keyboard, and the primes that mean minutes and seconds. */
const DEGREE_MARKS = /[º˚]/gu;
const PRIMES = /['’′"″:]/u;

/**
 * At most three integer digits and a bounded fraction — the same admissible shape as
 * `parseFiniteNumber` in `params.ts`, which exists so that `NaN`, `Infinity`, `1e999` and `0x1f`
 * never become a coordinate. A hemisphere letter may lead or trail, but not both.
 */
const PART = /^(?:([NSEW])\s*)?([+-]?)(\d{1,3})(?:\.(\d{1,12}))?\s*(?:([NSEW]))?$/u;

/**
 * Three or more unsigned numbers in a row: degrees, minutes and seconds written with nothing but
 * spaces. Used only after the decimal-pair parse has already failed, so a legitimate decimal pair
 * never reaches it.
 */
const SPACED_SEXAGESIMAL = /(?<![\d.])\d{1,3}(?:\s+\d{1,2}(?:\.\d+)?){2,}/u;

interface Part {
  readonly magnitude: number;
  readonly decimals: number;
  readonly signum: 1 | -1;
  readonly hemisphere: 'N' | 'S' | 'E' | 'W' | null;
}

export function parseCoordinateEntry(raw: string): CoordinateEntry {
  // Degree marks are unified before NFKC, which would otherwise fold `º` into a plain `o`.
  const text = raw.replace(DEGREE_MARKS, '°').normalize('NFKC').trim();
  if (text === '') return { kind: 'none' };
  if (PRIMES.test(text)) return { kind: 'sexagesimal' };

  /*
   * A degree mark is not by itself sexagesimal — `31.63°, -8.00°` is decimal degrees — so it is
   * stripped and the pair is parsed. Only when that parse fails does the mark become evidence
   * that the visitor wrote degrees and minutes, which is reported rather than guessed at.
   */
  const stripped = text.replaceAll('°', ' ').trim();
  const unparsed: CoordinateEntry =
    text.includes('°') || SPACED_SEXAGESIMAL.test(stripped)
      ? { kind: 'sexagesimal' }
      : { kind: 'none' };

  const pair = splitPair(stripped);
  if (pair === null) return unparsed;
  const first = parsePart(pair[0]);
  const second = parsePart(pair[1]);
  if (first === null || second === null) return unparsed;

  const assigned = assign(first, second);
  if (assigned === null) return unparsed;
  const { lat, lon } = assigned;

  if (lat < MIN_LATITUDE || lat > MAX_LATITUDE || lon < MIN_LONGITUDE || lon > MAX_LONGITUDE) {
    return { kind: 'out-of-range' };
  }

  /*
   * Rounded first, then normalized — the opposite order to `params.ts`, and deliberately so.
   * There the value has already been rounded by the caller, so `179.999` cannot arise; here it
   * can, and rounding it gives exactly 180, which is a longitude the domain refuses to key
   * (`isNormalizedLongitude` is half-open). Normalizing after the rounding is what keeps every
   * value this function returns a legal one.
   */
  const decimals = Math.max(first.decimals, second.decimals);
  return {
    kind: 'coordinate',
    lat: roundUserCoordinate(lat),
    lon: normalizeLongitude(roundUserCoordinate(lon)),
    wasRounded: decimals > USER_COORDINATE_DECIMALS,
  };
}

/**
 * Splits `31.63, -8`, `31.63 -8`, `48.86 N, 2.35 E` and `N 48.86 E 2.35` into two halves.
 *
 * A separator is required: `31.63-8` is two numbers with nothing between them and is refused,
 * because reading it as a pair would mean guessing where the visitor meant the second to start.
 */
function splitPair(text: string): readonly [string, string] | null {
  const byComma = text.split(/\s*[,;]\s*/u);
  if (byComma.length === 2) return [byComma[0] ?? '', byComma[1] ?? ''];
  if (byComma.length !== 1) return null;

  const words = text.split(/\s+/u);
  if (words.length === 2) return [words[0] ?? '', words[1] ?? ''];
  // A hemisphere letter standing apart from its number: four words, two per half.
  if (words.length === 4) {
    return [`${words[0] ?? ''} ${words[1] ?? ''}`, `${words[2] ?? ''} ${words[3] ?? ''}`];
  }
  return null;
}

function parsePart(raw: string): Part | null {
  const match = PART.exec(raw.trim().toUpperCase());
  if (match === null) return null;
  const [, before, sign, whole, fraction, after] = match;
  // One hemisphere letter at most, on one side or the other.
  if (before !== undefined && after !== undefined) return null;
  const hemisphere = (before ?? after ?? null) as Part['hemisphere'];
  // `-31.63 N` says two contradictory things about the same number.
  if (hemisphere !== null && sign !== undefined && sign !== '') return null;

  const magnitude = Number(`${whole ?? '0'}.${fraction ?? '0'}`);
  if (!Number.isFinite(magnitude)) return null;
  return {
    magnitude,
    decimals: (fraction ?? '').length,
    signum: sign === '-' ? -1 : 1,
    hemisphere,
  };
}

/**
 * Turns two parsed halves into latitude and longitude.
 *
 * With hemisphere letters the visitor has said which is which, so `2.35 E, 48.86 N` means what it
 * says. Without them the order is latitude first, as every mapping tool writes it. A mixture —
 * one letter and one bare number — is refused rather than half-guessed.
 */
function assign(first: Part, second: Part): { readonly lat: number; readonly lon: number } | null {
  const lettered = [first.hemisphere, second.hemisphere].filter((value) => value !== null).length;
  if (lettered === 1) return null;

  if (lettered === 0) {
    return { lat: first.signum * first.magnitude, lon: second.signum * second.magnitude };
  }

  const latPart = [first, second].find(
    (part) => part.hemisphere === 'N' || part.hemisphere === 'S',
  );
  const lonPart = [first, second].find(
    (part) => part.hemisphere === 'E' || part.hemisphere === 'W',
  );
  if (latPart === undefined || lonPart === undefined) return null;
  return {
    lat: (latPart.hemisphere === 'S' ? -1 : 1) * latPart.magnitude,
    lon: (lonPart.hemisphere === 'W' ? -1 : 1) * lonPart.magnitude,
  };
}
