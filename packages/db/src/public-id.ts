/**
 * Public identifier generation (`EQ-26-7K3F9Q`).
 *
 * The domain owns the *format* and its validation; generating one needs entropy, which is IO, so
 * it lives here. The alphabet is Crockford base32 without `I`, `L`, `O` and `U`, so an ID cannot
 * be misread over the phone and cannot accidentally spell a word.
 *
 * Randomness comes from `crypto.randomInt`, not `Math.random`: these IDs appear in shareable URLs,
 * and a predictable sequence would let anyone enumerate events that have not been published yet.
 */

import { randomInt } from 'node:crypto';

import {
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_TOKEN_LENGTH,
  formatPublicId,
  publicIdPrefixFor,
  type HazardType,
} from '@geonerva/domain';

/** Re-exported: the table moved to the domain, beside the format it belongs to. */
export { publicIdPrefixFor };

/** A random token from the reduced alphabet. */
function randomToken(): string {
  let token = '';
  for (let index = 0; index < PUBLIC_ID_TOKEN_LENGTH; index += 1) {
    token += PUBLIC_ID_ALPHABET.charAt(randomInt(PUBLIC_ID_ALPHABET.length));
  }
  return token;
}

/** Generates a public ID for a hazard type at a given creation time. */
export function generatePublicId(hazardType: HazardType, createdAt: Date): string {
  return formatPublicId({
    prefix: publicIdPrefixFor(hazardType),
    year: createdAt.getUTCFullYear(),
    token: randomToken(),
  });
}

/** Generates a fire-cluster public ID (`FR-…`), which is never an event ID. */
export function generateFireClusterPublicId(createdAt: Date): string {
  return formatPublicId({ prefix: 'FR', year: createdAt.getUTCFullYear(), token: randomToken() });
}
