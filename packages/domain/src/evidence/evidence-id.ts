/**
 * Evidence-ID codec (docs/DOMAIN_MODEL.md §4.11, ADR-023).
 *
 * Evidence is a **typed reference to something immutable**, not a separately authored record.
 * Every number, level and sentence GeoNerva shows carries the evidence IDs it came from, and the
 * briefing's evidence manifest must contain every ID referenced anywhere in it (invariant I9).
 *
 * ```text
 * EV:OBS:<version_id>                  one ObservationVersion (a provider fact)
 * EV:FCV:<cluster_version_id>          one FireActivityCluster version
 * EV:FDS:<cluster_version_id>:<count>  the detection set behind a cluster version
 * EV:RUN:<run_id>                      an ingestion run (health evidence)
 * EV:COR:<link_id>                     a correlation decision
 * EV:BAS:<sha256>                      a baseline computation   (content-addressed)
 * EV:REL:<sha256>                      a relevance assessment   (content-addressed)
 * EV:CHG:<sha256>                      a change signal          (content-addressed)
 * ```
 *
 * The grammar is **strict and canonical**: exactly the prefixes above, uppercase kind, decimal
 * identifiers with no leading zeros, lowercase UUIDs and lowercase hex digests. There is exactly
 * one spelling of any given reference, so an ID can be compared, cached and used as a map key
 * without normalization, and a manifest lookup cannot be defeated by re-casing.
 */

import { z } from 'zod';

import {
  isCountString,
  isDatabaseId,
  isSha256Hex,
  isUuid,
  type DatabaseId,
  type Sha256Hex,
  type Uuid,
} from '../value-objects/ids.ts';

/** The three-letter kind tag of an evidence ID. */
export const EVIDENCE_KINDS = ['OBS', 'FCV', 'FDS', 'RUN', 'COR', 'BAS', 'REL', 'CHG'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * Kinds the API resolves through `GET /api/v1/evidence/{id}`: they point at a stored row that can
 * be shown with its raw excerpt and source URL.
 */
export const PRIMARY_EVIDENCE_KINDS = ['OBS', 'FCV', 'RUN', 'COR'] as const;
export type PrimaryEvidenceKind = (typeof PRIMARY_EVIDENCE_KINDS)[number];

/**
 * Kinds whose identity **is** the hash of the computation that produced them. They are
 * self-contained in the manifest and are not resolvable endpoints.
 */
export const CONTENT_ADDRESSED_EVIDENCE_KINDS = ['BAS', 'REL', 'CHG'] as const;
export type ContentAddressedEvidenceKind = (typeof CONTENT_ADDRESSED_EVIDENCE_KINDS)[number];

/**
 * Every kind `GET /api/v1/evidence/{id}` can serve.
 *
 * Not the same list as the primary kinds, and the difference is `FDS`. A primary kind names a
 * **row**; `FDS` names the *set of detections* behind a cluster summary, which has no row and is
 * reconstructed through membership at that summary's knowledge time (ADR-039). It is therefore
 * resolvable without being primary, which is exactly what `DOMAIN_MODEL.md` means by "resolvable
 * via membership" — and reporting it `resolvable: false` while the endpoint served it was the last
 * place that contract and this code disagreed.
 */
export const RESOLVABLE_EVIDENCE_KINDS = [...PRIMARY_EVIDENCE_KINDS, 'FDS'] as const;
export type ResolvableEvidenceKind = (typeof RESOLVABLE_EVIDENCE_KINDS)[number];

/** The canonical string form, e.g. `"EV:OBS:41"`. */
export type EvidenceId = string;

/** A parsed evidence reference. */
export type EvidenceRef =
  | { readonly kind: 'OBS'; readonly versionId: DatabaseId }
  | { readonly kind: 'FCV'; readonly clusterVersionId: DatabaseId }
  | { readonly kind: 'FDS'; readonly clusterVersionId: DatabaseId; readonly count: number }
  | { readonly kind: 'RUN'; readonly runId: Uuid }
  | { readonly kind: 'COR'; readonly linkId: DatabaseId }
  | { readonly kind: 'BAS'; readonly sha256: Sha256Hex }
  | { readonly kind: 'REL'; readonly sha256: Sha256Hex }
  | { readonly kind: 'CHG'; readonly sha256: Sha256Hex };

/** Raised when an evidence ID cannot be parsed. The message never echoes untrusted length. */
export class EvidenceIdError extends Error {
  readonly input: string;

  constructor(input: string, reason: string) {
    super(`invalid evidence id (${reason})`);
    this.name = 'EvidenceIdError';
    this.input = input;
  }
}

const PREFIX = 'EV';

/**
 * Longest legal evidence ID, used as a cheap guard before any parsing work. The longest form is
 * a content address: `EV:BAS:` + 64 hex characters = 71. (`EV:RUN:` + a UUID is 43;
 * `EV:FDS:` + a 19-digit id + `:` + a 10-digit count is 37.)
 */
const MAX_EVIDENCE_ID_LENGTH = 'EV:BAS:'.length + 64;

/** Formats an evidence reference into its single canonical string form. */
export function formatEvidenceId(ref: EvidenceRef): EvidenceId {
  switch (ref.kind) {
    case 'OBS':
      return joinChecked(ref.kind, ref.versionId, isDatabaseId, 'version id');
    case 'FCV':
      return joinChecked(ref.kind, ref.clusterVersionId, isDatabaseId, 'cluster version id');
    case 'FDS': {
      if (!isDatabaseId(ref.clusterVersionId)) {
        throw new EvidenceIdError(ref.clusterVersionId, 'malformed cluster version id');
      }
      if (!Number.isInteger(ref.count) || ref.count < 0 || ref.count > 9_999_999_999) {
        throw new EvidenceIdError(String(ref.count), 'malformed detection count');
      }
      return `${PREFIX}:FDS:${ref.clusterVersionId}:${String(ref.count)}`;
    }
    case 'RUN':
      return joinChecked(ref.kind, ref.runId, isUuid, 'run uuid');
    case 'COR':
      return joinChecked(ref.kind, ref.linkId, isDatabaseId, 'link id');
    case 'BAS':
    case 'REL':
    case 'CHG':
      return joinChecked(ref.kind, ref.sha256, isSha256Hex, 'sha256 digest');
  }
}

function joinChecked(
  kind: EvidenceKind,
  body: string,
  valid: (value: string) => boolean,
  what: string,
): EvidenceId {
  if (!valid(body)) throw new EvidenceIdError(body, `malformed ${what}`);
  return `${PREFIX}:${kind}:${body}`;
}

/**
 * Parses an evidence ID. Throws `EvidenceIdError` on anything that is not exactly canonical:
 * wrong prefix, lowercase kind, unknown kind, leading zeros, uppercase hex, surrounding
 * whitespace, missing or extra segments.
 */
export function parseEvidenceId(id: string): EvidenceRef {
  const ref = tryParseEvidenceId(id);
  if (ref === null) throw new EvidenceIdError(id, 'not a canonical evidence id');
  return ref;
}

/** Parses an evidence ID, returning `null` instead of throwing. */
export function tryParseEvidenceId(id: string): EvidenceRef | null {
  if (id.length === 0 || id.length > MAX_EVIDENCE_ID_LENGTH) return null;

  const segments = id.split(':');
  if (segments.length < 3) return null;

  const [prefix, kind, body, extra] = segments;
  if (prefix !== PREFIX || kind === undefined || body === undefined) return null;
  if (!isEvidenceKind(kind)) return null;

  if (kind === 'FDS') {
    if (segments.length !== 4 || extra === undefined) return null;
    if (!isDatabaseId(body) || !isCountString(extra)) return null;
    return { kind, clusterVersionId: body, count: Number(extra) };
  }

  if (segments.length !== 3) return null;

  switch (kind) {
    case 'OBS':
      return isDatabaseId(body) ? { kind, versionId: body } : null;
    case 'FCV':
      return isDatabaseId(body) ? { kind, clusterVersionId: body } : null;
    case 'COR':
      return isDatabaseId(body) ? { kind, linkId: body } : null;
    case 'RUN':
      return isUuid(body) ? { kind, runId: body } : null;
    case 'BAS':
    case 'REL':
    case 'CHG':
      return isSha256Hex(body) ? { kind, sha256: body } : null;
  }
}

/** True when the string is a canonical evidence ID of any kind. */
export function isEvidenceId(value: string): boolean {
  return tryParseEvidenceId(value) !== null;
}

/** The kind tag of a canonical evidence ID, or `null` when it is malformed. */
export function evidenceIdKind(value: string): EvidenceKind | null {
  return tryParseEvidenceId(value)?.kind ?? null;
}

function isEvidenceKind(value: string): value is EvidenceKind {
  return (EVIDENCE_KINDS as readonly string[]).includes(value);
}

/** True for the kinds that name a stored row. `FDS` is resolvable but is **not** one of them. */
export function isPrimaryEvidenceKind(kind: EvidenceKind): kind is PrimaryEvidenceKind {
  return (PRIMARY_EVIDENCE_KINDS as readonly EvidenceKind[]).includes(kind);
}

/** True for kinds resolvable through `GET /api/v1/evidence/{id}`. */
export function isResolvableEvidenceKind(kind: EvidenceKind): kind is ResolvableEvidenceKind {
  return (RESOLVABLE_EVIDENCE_KINDS as readonly EvidenceKind[]).includes(kind);
}

/** True for kinds whose ID is the hash of the computation behind them. */
export function isContentAddressedEvidenceKind(
  kind: EvidenceKind,
): kind is ContentAddressedEvidenceKind {
  return (CONTENT_ADDRESSED_EVIDENCE_KINDS as readonly EvidenceKind[]).includes(kind);
}

/** Convenience constructors, so that callers never assemble an evidence ID by hand. */
export const evidenceId = {
  observation: (versionId: DatabaseId): EvidenceId => formatEvidenceId({ kind: 'OBS', versionId }),
  fireClusterVersion: (clusterVersionId: DatabaseId): EvidenceId =>
    formatEvidenceId({ kind: 'FCV', clusterVersionId }),
  detectionSet: (clusterVersionId: DatabaseId, count: number): EvidenceId =>
    formatEvidenceId({ kind: 'FDS', clusterVersionId, count }),
  ingestionRun: (runId: Uuid): EvidenceId => formatEvidenceId({ kind: 'RUN', runId }),
  correlation: (linkId: DatabaseId): EvidenceId => formatEvidenceId({ kind: 'COR', linkId }),
  baseline: (sha256: Sha256Hex): EvidenceId => formatEvidenceId({ kind: 'BAS', sha256 }),
  relevance: (sha256: Sha256Hex): EvidenceId => formatEvidenceId({ kind: 'REL', sha256 }),
  change: (sha256: Sha256Hex): EvidenceId => formatEvidenceId({ kind: 'CHG', sha256 }),
} as const;

/** Zod schema accepting a canonical evidence ID and producing the parsed reference. */
export const evidenceIdSchema = z
  .string()
  .refine(isEvidenceId, { message: 'must be a canonical evidence id such as EV:OBS:41' });

/** Zod schema that parses straight to an `EvidenceRef`. */
export const evidenceRefSchema = evidenceIdSchema.transform((value): EvidenceRef =>
  parseEvidenceId(value),
);
