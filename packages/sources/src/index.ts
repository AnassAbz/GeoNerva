/**
 * @geonerva/sources — Provider adapters (fetch, parse, normalize). The only package that knows
 * provider field names. No database access.
 *
 * See docs/ARCHITECTURE.md §3 for this package's responsibility and allowed dependencies.
 */

export {
  NormalizationError,
  batchVerdict,
  canonicalJson,
  contentHash,
  createSourceClient,
  payloadHash,
} from './contract.ts';
export type {
  FetchContext,
  FetchResult,
  NormalizeContext,
  NormalizedRecord,
  ParseContext,
  ParseResult,
  RejectedRecord,
  SourceAdapter,
  SourceDescriptor,
} from './contract.ts';

export {
  DEFAULT_USGS_FEED,
  USGS_FEEDS,
  isUsgsFeed,
  parseUsgsFeed,
  usgsAdapter,
  usgsDescriptor,
  usgsFeedUrl,
} from './usgs/adapter.ts';
export type { UsgsFeed } from './usgs/adapter.ts';

export {
  FDSN_MAX_ROWS,
  FdsnQueryError,
  fdsnCount,
  fdsnCountUrl,
  fdsnEndpoint,
  fdsnFetch,
  fdsnQueryUrl,
  fdsnWindowSchema,
  isWindowTooLarge,
  parseDeletionSweep,
  parseFdsnCount,
} from './usgs/fdsn.ts';
export type {
  DeletionSweep,
  FdsnBody,
  FdsnCount,
  FdsnFetchOptions,
  FdsnMode,
  FdsnWindow,
  IdentifiedDeletion,
} from './usgs/fdsn.ts';

export {
  DEFAULT_WINDOW_PLAN,
  WindowPlanError,
  describePlanDefect,
  planCoverageMs,
  planWindows,
  splitWindow,
} from './usgs/window-planner.ts';
export type { PlannedWindow, WindowPlanOptions } from './usgs/window-planner.ts';

export { normalizeUsgsFeature, parseIds } from './usgs/normalize.ts';
export { usgsFeatureSchema, usgsFeedSchema } from './usgs/schema.ts';
export type { UsgsFeature } from './usgs/schema.ts';
