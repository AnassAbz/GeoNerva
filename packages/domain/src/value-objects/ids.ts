/**
 * Identifier value objects shared by the database layer, the API and the read models.
 *
 * Database surrogate keys are `bigserial`/`uuid`. They cross the wire and appear inside evidence
 * IDs, so the domain represents them as **strings**, never as JavaScript numbers: a `bigint` does
 * not survive `JSON.stringify`, and a `number` silently loses precision above 2^53. node-postgres
 * already returns `int8` as a decimal string, so this is also the cheapest representation.
 */

import { z } from 'zod';

/**
 * A `bigserial` primary key, as a decimal string with no leading zeros and no sign
 * (e.g. `"1"`, `"90071992547409910"`). Values are always within PostgreSQL's `bigint` range.
 */
export type DatabaseId = string;

/** Largest value a PostgreSQL `bigint` can hold. */
export const MAX_BIGINT = '9223372036854775807';

const DATABASE_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

/** True for a canonical decimal `bigserial` key within `bigint` range. Sequences start at 1. */
export function isDatabaseId(value: string): boolean {
  if (!DATABASE_ID_PATTERN.test(value)) return false;
  return value.length < MAX_BIGINT.length || value <= MAX_BIGINT;
}

/** A non-negative integer count, as a decimal string (`"0"` is allowed, `"007"` is not). */
const COUNT_PATTERN = /^(0|[1-9][0-9]{0,9})$/;

/** True for a canonical non-negative decimal integer of at most 10 digits. */
export function isCountString(value: string): boolean {
  return COUNT_PATTERN.test(value);
}

/**
 * A canonical lowercase RFC 4122 UUID, exactly as PostgreSQL renders it. Uppercase input is
 * rejected on purpose: evidence IDs embed UUIDs and must round-trip byte for byte.
 */
export type Uuid = string;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for a canonical lowercase UUID. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** A SHA-256 digest as 64 lowercase hex characters. Content addresses are always lowercase. */
export type Sha256Hex = string;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** True for 64 lowercase hex characters. */
export function isSha256Hex(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export const databaseIdSchema = z.string().refine(isDatabaseId, {
  message: 'must be a positive decimal bigint identifier',
});

export const uuidSchema = z.string().refine(isUuid, {
  message: 'must be a lowercase RFC 4122 UUID',
});

export const sha256HexSchema = z.string().refine(isSha256Hex, {
  message: 'must be 64 lowercase hexadecimal characters',
});

/**
 * Public, user-facing event identifiers (`EQ-26-7K3F9Q`).
 *
 * Shape: `<PREFIX>-<YY>-<TOKEN>` where the token uses Crockford base32 without `I`, `L`, `O` and
 * `U`, so it cannot be misread or spell words. The domain only formats and validates; generating
 * the random token needs entropy and therefore lives in `packages/db`.
 */
export const PUBLIC_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PUBLIC_ID_TOKEN_LENGTH = 6;

/** Public-ID prefixes per hazard family. `FR` is a fire *cluster*, not an official wildfire. */
export const PUBLIC_ID_PREFIXES = [
  'EQ',
  'FR',
  'WF',
  'FL',
  'TC',
  'VO',
  'DR',
  'WA',
  'TS',
  'EV',
] as const;
export type PublicIdPrefix = (typeof PUBLIC_ID_PREFIXES)[number];

const PUBLIC_ID_PATTERN = new RegExp(
  `^(${PUBLIC_ID_PREFIXES.join('|')})-[0-9]{2}-[${PUBLIC_ID_ALPHABET}]{${String(PUBLIC_ID_TOKEN_LENGTH)}}$`,
);

export interface PublicIdParts {
  readonly prefix: PublicIdPrefix;
  /** Two-digit year of creation (`26` = 2026). Not a time semantic, only a readability aid. */
  readonly year: number;
  readonly token: string;
}

/** True for a well-formed public ID. */
export function isPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}

/** Formats a public ID from its parts. Throws on an out-of-range year or malformed token. */
export function formatPublicId(parts: PublicIdParts): string {
  if (!Number.isInteger(parts.year) || parts.year < 0 || parts.year > 9999) {
    throw new RangeError(`public id year out of range: ${String(parts.year)}`);
  }
  const yy = String(parts.year % 100).padStart(2, '0');
  const id = `${parts.prefix}-${yy}-${parts.token}`;
  if (!isPublicId(id)) throw new RangeError(`malformed public id token: ${parts.token}`);
  return id;
}

/** Parses a public ID, or returns `null` when it is malformed. */
export function parsePublicId(value: string): PublicIdParts | null {
  if (!isPublicId(value)) return null;
  const [prefix, yy, token] = value.split('-');
  if (prefix === undefined || yy === undefined || token === undefined) return null;
  return { prefix: prefix as PublicIdPrefix, year: Number(yy), token };
}

export const publicIdSchema = z.string().refine(isPublicId, {
  message: 'must be a public identifier such as EQ-26-7K3F9Q',
});
