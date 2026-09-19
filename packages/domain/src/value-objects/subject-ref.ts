/**
 * Subject references (docs/ARCHITECTURE.md §10.2).
 *
 * `What Changed?` diffs two snapshots by matching **subjects**, not rows: a subject is whatever a
 * statement is about — a canonical event, a fire cluster, a source, or a baseline metric. The
 * reference must therefore be stable across snapshots, printable in JSON, and usable as a map key.
 *
 * ```text
 * CE:<publicId>      a canonical event      (merge redirects are followed before matching)
 * FC:<publicId>      a fire activity cluster
 * SRC:<sourceId>     a source, for SOURCE_STALE / SOURCE_RECOVERED signals
 * MET:<metricCode>   a baseline metric, for ACTIVITY_* / ABNORMAL_ACTIVITY signals
 * ```
 */

import { z } from 'zod';

import { isPublicId } from './ids.ts';

export const SUBJECT_KINDS = ['canonical_event', 'fire_cluster', 'source', 'metric'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export type ParsedSubjectRef =
  | { readonly kind: 'canonical_event'; readonly publicId: string }
  | { readonly kind: 'fire_cluster'; readonly publicId: string }
  | { readonly kind: 'source'; readonly sourceId: string }
  | { readonly kind: 'metric'; readonly metricCode: string };

/** The canonical string form, e.g. `"CE:EQ-26-7K3F9Q"`. */
export type SubjectRef = string;

const SOURCE_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const METRIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Formats a subject reference. Throws when a part is not canonical. */
export function formatSubjectRef(subject: ParsedSubjectRef): SubjectRef {
  switch (subject.kind) {
    case 'canonical_event':
      if (!isPublicId(subject.publicId)) throw new RangeError('invalid canonical event public id');
      return `CE:${subject.publicId}`;
    case 'fire_cluster':
      if (!isPublicId(subject.publicId)) throw new RangeError('invalid fire cluster public id');
      return `FC:${subject.publicId}`;
    case 'source':
      if (!SOURCE_ID_PATTERN.test(subject.sourceId)) throw new RangeError('invalid source id');
      return `SRC:${subject.sourceId}`;
    case 'metric':
      if (!METRIC_CODE_PATTERN.test(subject.metricCode))
        throw new RangeError('invalid metric code');
      return `MET:${subject.metricCode}`;
  }
}

/** Parses a subject reference, returning `null` when it is malformed. */
export function parseSubjectRef(ref: string): ParsedSubjectRef | null {
  if (ref.length > 80) return null;
  const separator = ref.indexOf(':');
  if (separator === -1) return null;
  const tag = ref.slice(0, separator);
  const body = ref.slice(separator + 1);
  switch (tag) {
    case 'CE':
      return isPublicId(body) ? { kind: 'canonical_event', publicId: body } : null;
    case 'FC':
      return isPublicId(body) ? { kind: 'fire_cluster', publicId: body } : null;
    case 'SRC':
      return SOURCE_ID_PATTERN.test(body) ? { kind: 'source', sourceId: body } : null;
    case 'MET':
      return METRIC_CODE_PATTERN.test(body) ? { kind: 'metric', metricCode: body } : null;
    default:
      return null;
  }
}

/** True for a canonical subject reference. */
export function isSubjectRef(ref: string): boolean {
  return parseSubjectRef(ref) !== null;
}

export const subjectRefSchema = z
  .string()
  .refine(isSubjectRef, { message: 'must be a subject reference such as CE:EQ-26-7K3F9Q' });
