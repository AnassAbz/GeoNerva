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
} from './fdsn/window-planner.ts';
export type { PlannedWindow, WindowPlanOptions } from './fdsn/window-planner.ts';

export { normalizeUsgsFeature, parseIds } from './usgs/normalize.ts';
export { usgsFeatureSchema, usgsFeedSchema } from './usgs/schema.ts';
export type { UsgsFeature } from './usgs/schema.ts';

export {
  EMSC_POLL_LOOKBACK_MS,
  emscAdapter,
  emscDescriptor,
  parseEmscFeed,
} from './emsc/adapter.ts';
export {
  EMSC_HOST,
  EMSC_MAX_ROWS,
  EMSC_WINDOW_TARGET,
  emscCount,
  emscCountUrl,
  emscEndpoint,
  emscQueryUrl,
  emscUpdatedAfterUrl,
  isTruncated,
  parseEmscCount,
} from './emsc/fdsn.ts';
export { normalizeEmscFeature } from './emsc/normalize.ts';
export { emscFeatureSchema, emscFeedSchema } from './emsc/schema.ts';
export type { EmscFeature, EmscFeatureProperties } from './emsc/schema.ts';

export { assertWindow, bridgeEndtime } from './fdsn/window.ts';

export { emscHistorical } from './emsc/fdsn.ts';
export { usgsHistorical } from './usgs/fdsn.ts';
export type {
  HistoricalBody,
  HistoricalCount,
  HistoricalInterface,
  HistoricalRequestOptions,
} from './historical.ts';

export {
  GDACS_POLL_LOOKBACK_MS,
  gdacsAdapter,
  gdacsDescriptor,
  parseGdacsList,
} from './gdacs/adapter.ts';
export type { GdacsRecord } from './gdacs/adapter.ts';
export {
  GDACS_EVENT_TYPES,
  GDACS_HOST,
  GDACS_MAX_PAGES,
  GDACS_PAGE_SIZE,
  gdacsEndpoint,
  gdacsEventDataUrl,
  gdacsFetchEventData,
  gdacsFetchList,
  gdacsInstant,
  gdacsSearchUrl,
  isGdacsEventType,
} from './gdacs/api.ts';
export type { GdacsEventType, GdacsWindow } from './gdacs/api.ts';
export { GDACS_HAZARD_TYPES, gdacsPrimaryKey, normalizeGdacsFeature } from './gdacs/normalize.ts';
export { gdacsFeatureSchema, gdacsPropertiesSchema } from './gdacs/schema.ts';
export type { GdacsFeature, GdacsProperties } from './gdacs/schema.ts';
