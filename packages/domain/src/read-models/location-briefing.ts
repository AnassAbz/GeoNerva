/**
 * `LocationBriefing` — the response of `GET /api/v1/briefing` and the central read model of the
 * product (docs/ARCHITECTURE.md §5, §13.1).
 *
 * It is the union of three things that are deliberately kept apart:
 *
 *  - `snapshot` — what is true at `asOf`, per hazard family, with coverage, health and baselines;
 *  - `changes`  — the diff against an earlier knowledge time, which is what "What Changed?" means;
 *  - `copy`     — deterministic, template-generated sentences; and, only if it validated, `ai`.
 *
 * A briefing is reproducible: `buildSnapshot(location, asOf, engineVersion)` returns the same
 * `contentSha256` for the same database state (invariant I14). Persistence of snapshots is
 * therefore a cache, never the source of truth.
 */

import type { HazardFamily, HeadlineCode, RelevanceLevel } from '../enums.ts';
import type { EvidenceId } from '../evidence/evidence-id.ts';
import type { AiValidationStatus } from '../enums.ts';
import type { LocationRef } from '../value-objects/location.ts';
import type { IsoTimestamp } from '../value-objects/time.ts';
import type {
  AsOfContext,
  Attribution,
  BriefingCopy,
  ChangeSection,
  ChangeWindow,
  FamilyCard,
  ReadModelSchemaVersion,
  Reason,
  SourceHealthView,
} from './common.ts';
import type { EvidenceItem } from './evidence-item.ts';

/** `GET /api/v1/briefing?place=…&window=24h[&as_of=…]`. */
export interface LocationBriefing {
  readonly schemaVersion: ReadModelSchemaVersion;
  readonly location: LocationRef;
  readonly window: ChangeWindow;
  /** Wall-clock time the response was produced. Not a knowledge time; excluded from the hash. */
  readonly generatedAt: IsoTimestamp;
  readonly asOfContext: AsOfContext;
  /** Bumped whenever relevance, baseline or change logic changes (§4.14). */
  readonly engineVersion: string;
  readonly snapshot: LocationSnapshotView;
  readonly changes: ChangeSection;
  readonly copy: BriefingCopy;
  /** Present only when runtime AI ran **and** its output passed validation (ADR-012). */
  readonly ai: AiBriefingView | null;
  /** Every evidence ID referenced anywhere in this response (invariant I9). */
  readonly evidenceManifest: readonly EvidenceItem[];
  readonly attribution: readonly Attribution[];
  /** Hash of the snapshot content, which is also the AI cache key. */
  readonly contentSha256: string;
}

/** The deterministic snapshot at one knowledge time (docs/DOMAIN_MODEL.md §4.14). */
export interface LocationSnapshotView {
  readonly asOf: IsoTimestamp;
  readonly engineVersion: string;
  readonly generatedAt: IsoTimestamp;
  /** Health of every source relevant to this location, derived at `asOf`. */
  readonly sourceHealth: readonly SourceHealthView[];
  /** One card per family. Always all families: "not covered" is a result, not an omission. */
  readonly families: Readonly<Record<HazardFamily, FamilyCard>>;
  readonly overall: SnapshotOverall;
  readonly contentSha256: string;
}

/** The single answer to "is something meaningful happening here?" (docs/ARCHITECTURE.md §9.8). */
export interface SnapshotOverall {
  readonly headlineCode: HeadlineCode;
  /** The highest relevance present, or `null` when nothing was assessed. */
  readonly headlineRelevance: RelevanceLevel | null;
  /** The rendered headline sentence. */
  readonly headlineText: string;
  /** The coverage line that always follows the headline, e.g. "Weather warnings not covered here." */
  readonly coverageStatement: string;
  /** Families that could not be shown, so the headline can name them. */
  readonly unavailableFamilies: readonly HazardFamily[];
  readonly notCoveredFamilies: readonly HazardFamily[];
  readonly reasons: readonly Reason[];
  readonly evidenceIds: readonly EvidenceId[];
}

/**
 * Runtime AI output (P1, `AI_MODE` is `disabled` in production for v1 — owner decision Q4).
 *
 * The block is absent unless the model output passed the deterministic validator. A `REJECTED`
 * output is stored for evaluation and never shown, so `validationStatus` here is only ever
 * `PASSED` or `REPAIRED`.
 */
export interface AiBriefingView {
  readonly model: string;
  readonly promptVersion: string;
  readonly validationStatus: Extract<AiValidationStatus, 'PASSED' | 'REPAIRED'>;
  readonly sections: readonly AiSection[];
  /** Every evidence ID the text references; a subset of the manifest (invariant I12). */
  readonly evidenceIds: readonly EvidenceId[];
  /** Always rendered next to AI text. */
  readonly disclaimer: string;
  readonly generatedAt: IsoTimestamp;
}

export interface AiSection {
  readonly role: string;
  readonly heading: string;
  readonly text: string;
  readonly evidenceIds: readonly EvidenceId[];
}
