/**
 * @geonerva/briefing — Application services: location snapshots as of a time, briefings, evidence
 * manifests, deterministic copy.
 *
 * See docs/ARCHITECTURE.md §3 for this package's responsibility and allowed dependencies, and
 * ADR-036 for why it may use `packages/correlation`.
 */

export { CanonicalizationError, canonicalJson, contentSha256 } from './content-hash.ts';

export { familyWords, resolveCoverage } from './coverage.ts';
export type { FamilyCoverageResult, FamilySource } from './coverage.ts';

export { EXEMPTIBLE_CLASSES, LEXICON_CLASSES, isLexiconClean, scanLexicon } from './lexicon.ts';
export type { LexiconClass, LexiconHit, LexiconOptions } from './lexicon.ts';

export { replayHorizonFor } from './replay-horizon.ts';

export { EvidenceManifestError, buildBriefing, resolveEvidenceManifest } from './briefing.ts';

export { TIMELINE_CAP, buildEventDetail } from './event-detail.ts';
export type { BuildEventDetailOptions, EventDetailResult } from './event-detail.ts';

export {
  CLUSTER_VERSION_CAP,
  DETECTION_SAMPLE_CAP,
  buildFireClusterDetail,
} from './fire-cluster-detail.ts';
export type {
  BuildFireClusterDetailOptions,
  FireClusterDetailResult,
} from './fire-cluster-detail.ts';
export type { BriefingBuild, BuildBriefingOptions } from './briefing.ts';

export { MAP_FEATURE_CAP, buildMapFeatures } from './map-features.ts';
export type { BuildMapFeaturesOptions } from './map-features.ts';

export { TEMPLATE_VERSION, buildCopy } from './templates.ts';
export type { CopyInput } from './templates.ts';

export {
  DEFAULT_MAX_ITEMS_PER_FAMILY,
  FAMILY_SEARCH_RADIUS_KM,
  buildSnapshot,
} from './snapshot.ts';
export type { BuildSnapshotOptions, SnapshotBuild } from './snapshot.ts';
