/**
 * Canonical serialization and the snapshot content hash (invariant I14).
 *
 * > The same database state, the same `asOf` and the same `engineVersion` produce the same
 * > `contentSha256`.
 *
 * That is not a nicety. The hash is the AI cache key, the change engine's identity for a
 * snapshot, and the unique key of `location_snapshots` — so a hash that varies for identical
 * content silently defeats every cache in the system, and a hash that *fails* to vary when
 * content changes serves a stale briefing as if it were current. Both failures are invisible from
 * the outside, which is why the rules below are strict rather than convenient.
 *
 * ### What the hash covers, and what it must not
 *
 * `generatedAt` is **excluded**. It is wall-clock time, not knowledge time: two builds of the
 * same snapshot a minute apart describe the same world and must hash identically, or the cache
 * key changes on every request and the persistence table fills with duplicates of one snapshot.
 * Everything else is included, including the reasons and the rendered sentences, because a change
 * in what GeoNerva *says* is a change in the snapshot even when the numbers behind it are equal.
 *
 * ### Why not `JSON.stringify`
 *
 * Three reasons, each of which has produced a real cache bug somewhere:
 *
 *  1. **Key order.** `JSON.stringify` preserves insertion order, so two objects with the same
 *     entries built by different code paths serialize differently. Keys are sorted here.
 *  2. **Numbers.** `-0` stringifies as `0` but is a different value; `1e21` switches to
 *     exponential notation; and a float that arrived from `numeric` as a string is not the same
 *     token as one that arrived as a number. Numbers are normalized to one spelling.
 *  3. **Absence.** `undefined` disappears from an object and becomes `null` in an array, so the
 *     same logical content hashes differently depending on where the gap sits. `undefined` is
 *     rejected outright: the read models say a missing value is an explicit `unavailable`, and
 *     anything else reaching this function is a bug worth failing on.
 */

import { createHash } from 'node:crypto';

/** Raised when a value cannot be canonically serialized. */
export class CanonicalizationError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`cannot canonicalize ${path === '' ? 'value' : path}: ${reason}`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

/**
 * Serializes a value to its single canonical JSON form.
 *
 * Object keys are sorted by UTF-16 code unit — the same ordering `Array.prototype.sort` gives —
 * rather than by locale, because a locale-aware sort would make the hash depend on the machine
 * that computed it.
 */
export function canonicalJson(value: unknown, path = ''): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalNumber(value, path);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new CanonicalizationError(path, 'undefined is never content; use an explicit null');
    case 'bigint':
      throw new CanonicalizationError(path, 'bigint is not part of the read-model contract');
    case 'function':
    case 'symbol':
      throw new CanonicalizationError(path, `${typeof value} is not serializable`);
    case 'object':
      break;
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => canonicalJson(item, `${path}[${String(index)}]`));
    return `[${items.join(',')}]`;
  }

  /*
   * A `Date` reaching here is a contract violation, not something to format.
   *
   * The read models are explicit that timestamps are `IsoTimestamp` strings in UTC. Accepting a
   * `Date` and calling `toISOString()` would work and would hide the place where a database row
   * leaked into a read model still carrying its driver's type — and the next such leak might be a
   * `numeric` string, which has no obvious conversion at all.
   */
  if (value instanceof Date) {
    throw new CanonicalizationError(path, 'Date is not a read-model type; use an ISO string');
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const parts = entries.map(
    ([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, `${path}.${key}`)}`,
  );
  return `{${parts.join(',')}}`;
}

/**
 * One spelling per number.
 *
 * `-0` becomes `0`, because they are the same quantity and JSON has no way to tell a reader
 * apart. Non-finite values are rejected rather than serialized as `null`, which is what
 * `JSON.stringify` does — a `NaN` that silently becomes `null` is a computation that went wrong
 * and then hashed as if it had not.
 */
function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(path, `${String(value)} is not a finite number`);
  }
  if (Object.is(value, -0)) return '0';
  return JSON.stringify(value);
}

/** The lowercase hex SHA-256 of a value's canonical form. */
export function contentSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
