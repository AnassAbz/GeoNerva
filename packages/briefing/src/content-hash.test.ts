/**
 * Canonical serialization, which is invariant I14's arithmetic.
 *
 * Each test here is a way two equal snapshots could hash differently, or two different ones could
 * hash the same. Both failures are silent from the outside: the first defeats every cache in the
 * system, and the second serves a stale briefing as current.
 */

import { describe, expect, it } from 'vitest';

import { CanonicalizationError, canonicalJson, contentSha256 } from './index.ts';

describe('the same content hashes the same way', () => {
  it('does not depend on the order keys were inserted in', () => {
    /*
     * The central property. Two code paths that build the same object in different orders —
     * which is exactly what happens when one card is assembled from a query and another from a
     * cache — must not produce two cache keys for one snapshot.
     */
    const left = { b: 1, a: 2, c: { z: 3, y: 4 } };
    const right = { c: { y: 4, z: 3 }, a: 2, b: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(contentSha256(left)).toBe(contentSha256(right));
  });

  it('keeps array order, because array order is content', () => {
    // Sorting arrays would erase a real difference: [HIGH, LOW] is not the same card as [LOW, HIGH].
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('treats -0 and 0 as the same number', () => {
    /*
     * A distance that rounds to `-0` is the same distance as one that rounds to `0`, and JSON
     * gives a reader no way to tell them apart. `JSON.stringify` already prints both as `0`; this
     * makes it deliberate rather than incidental.
     */
    expect(canonicalJson({ distanceKm: -0 })).toBe(canonicalJson({ distanceKm: 0 }));
  });

  it('sorts keys by code unit, not by locale', () => {
    /*
     * A locale-aware sort orders `a` before `B` in some collations and after it in others, so the
     * hash would depend on the machine that computed it — and CI would disagree with a laptop.
     */
    expect(canonicalJson({ B: 1, a: 2 })).toBe('{"B":1,"a":2}');
  });

  it('refuses an undefined property rather than filtering it out', () => {
    /*
     * Filtering is exactly what `JSON.stringify` does, and reason #3 for not using it:
     * `{a: 1, b: undefined}` would hash identically to `{a: 1}`, which is the "fails to vary when
     * content changes" half of the failure this module exists to prevent. The read models say a
     * missing value is an explicit `unavailable`, so an `undefined` here is a bug to fail on.
     */
    expect(() => canonicalJson({ a: 1, b: undefined })).toThrow(/undefined is never content/);
  });
});

describe('different content hashes differently', () => {
  it('separates a missing value from a zero', () => {
    /*
     * The read models say an absent value is an explicit `unavailable`, never a `0` — and the hash
     * has to agree, or a card that lost its magnitude would cache as one that measured zero.
     */
    const unknown = { value: { kind: 'unavailable', reason: 'NOT_REPORTED_BY_SOURCE' } };
    const zero = { value: { kind: 'number', value: 0, unit: null, decimals: 1 } };
    expect(contentSha256(unknown)).not.toBe(contentSha256(zero));
  });

  it('separates a number from its string spelling', () => {
    // `numeric` columns arrive as strings; one leaking through must not hash as the parsed value.
    expect(contentSha256({ magnitude: 5.1 })).not.toBe(contentSha256({ magnitude: '5.1' }));
  });

  it('separates an empty list from a missing one', () => {
    expect(contentSha256({ items: [] })).not.toBe(contentSha256({}));
  });

  it('separates null from an absent key', () => {
    expect(contentSha256({ a: null })).not.toBe(contentSha256({}));
  });
});

describe('what cannot be hashed at all', () => {
  it('refuses a bare undefined rather than hashing it as nothing', () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalizationError);
  });

  it('refuses a Date, because a read model has no Date in it', () => {
    /*
     * Accepting one and calling `toISOString()` would work and would hide the place where a
     * database row leaked into a read model still carrying its driver's type. The next such leak
     * is a `numeric` string, which has no obvious conversion at all.
     */
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(/Date is not a read-model type/);
  });

  it('refuses NaN rather than serializing it as null', () => {
    // `JSON.stringify` turns NaN into `null`, so a computation that went wrong hashes as one that
    // simply had no value.
    expect(() => canonicalJson({ distanceKm: Number.NaN })).toThrow(/not a finite number/);
    expect(() => canonicalJson({ distanceKm: Number.POSITIVE_INFINITY })).toThrow(
      /not a finite number/,
    );
  });

  it('names the path of the value it could not serialize', () => {
    // A hash failure deep inside a snapshot is unactionable without the path.
    expect(() =>
      canonicalJson({ families: { EARTHQUAKES: { items: [{ n: Number.NaN }] } } }),
    ).toThrow(/\.families\.EARTHQUAKES\.items\[0\]\.n/);
  });

  it('refuses a bigint, which is not part of the read-model contract', () => {
    expect(() => canonicalJson({ id: 1n })).toThrow(CanonicalizationError);
  });
});

describe('the hash itself', () => {
  it('is lowercase hex of the canonical form', () => {
    const value = { a: 1 };
    expect(contentSha256(value)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the SHA-256 of the canonical string, not of JSON.stringify', () => {
    /*
     * Derived independently: the digest is taken of the *canonical* bytes, so an object whose
     * `JSON.stringify` differs from its canonical form must hash as the canonical form does.
     */
    const reordered = { b: 2, a: 1 };
    expect(JSON.stringify(reordered)).not.toBe(canonicalJson(reordered));
    expect(contentSha256(reordered)).toBe(contentSha256({ a: 1, b: 2 }));
  });
});
