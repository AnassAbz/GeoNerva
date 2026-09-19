/**
 * Supporting read models for the remaining `GET /api/v1` endpoints (docs/ARCHITECTURE.md §13.1):
 * map features, place lookup and the replay horizon.
 *
 * These are frozen alongside the main read models so that the frontend (P9a) can build the map
 * and the search box against mocks before the API lands (P8).
 */

import type { FireClusterStatus, HazardFamily, HazardType } from '../enums.ts';
import type { EvidenceId } from '../evidence/evidence-id.ts';
import type { GeoJsonGeometry } from '../value-objects/geography.ts';
import type { ProviderSeverity } from '../value-objects/provider-severity.ts';
import type { SubjectRef } from '../value-objects/subject-ref.ts';
import type { IsoTimestamp } from '../value-objects/time.ts';
import type {
  AsOfContext,
  Attribution,
  ConfidenceView,
  ReadModelSchemaVersion,
  ReplayHorizon,
} from './common.ts';

/**
 * `GET /api/v1/events` — map features for a viewport.
 *
 * Low zoom returns canonical events and fire **cluster centroids** only, never raw detections.
 * Above the cap the response says `truncated: true` rather than silently dropping features
 * (docs/ARCHITECTURE.md §7.5).
 */
export interface MapFeaturesResponse {
  readonly schemaVersion: ReadModelSchemaVersion;
  readonly asOfContext: AsOfContext;
  /** The bbox actually used, quantized to a tile-aligned grid for cache hits. */
  readonly bbox: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  };
  /** Two boxes when the viewport crosses the antimeridian. */
  readonly bboxParts: readonly {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  }[];
  readonly zoom: number;
  readonly families: readonly HazardFamily[];
  readonly features: readonly MapFeature[];
  readonly truncated: boolean;
  readonly cap: number;
  readonly total: number;
  readonly attribution: readonly Attribution[];
}

/** One map feature. Deliberately flat: the map renders it without further lookups. */
export interface MapFeature {
  readonly subjectRef: SubjectRef;
  readonly publicId: string;
  readonly kind: 'canonical_event' | 'fire_cluster' | 'fire_detection';
  readonly hazardType: HazardType;
  readonly family: HazardFamily;
  readonly geometry: GeoJsonGeometry;
  readonly observedAt: IsoTimestamp;
  readonly isActive: boolean;
  readonly providerSeverity: ProviderSeverity | null;
  /** Earthquake magnitude, cluster detection count, … — whatever sizes the symbol. */
  readonly magnitudeValue: number | null;
  readonly clusterStatus: FireClusterStatus | null;
  readonly confidence: ConfidenceView | null;
  readonly label: string;
  readonly href: string;
  readonly evidenceIds: readonly EvidenceId[];
}

/** `GET /api/v1/places/suggest` — offline type-ahead from the local GeoNames table. */
export interface PlaceSuggestResponse {
  readonly schemaVersion: ReadModelSchemaVersion;
  readonly query: string;
  readonly suggestions: readonly PlaceSuggestion[];
  readonly attribution: readonly Attribution[];
}

export interface PlaceSuggestion {
  /** A `p:<geonameid>` location key. */
  readonly key: string;
  readonly label: string;
  readonly countryCode: string | null;
  readonly admin1: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly population: number | null;
  readonly timezone: string;
}

/**
 * `GET /api/v1/places/search` and `/places/reverse` — submit-time geocoding through Nominatim,
 * server-side, cached, and globally serialized to ≤ 1 request per second (ADR-013, ADR-028).
 */
export interface PlaceSearchResponse {
  readonly schemaVersion: ReadModelSchemaVersion;
  readonly query: string;
  readonly results: readonly PlaceSearchResult[];
  /** True when the answer came from the local cache rather than from the provider. */
  readonly fromCache: boolean;
  readonly attribution: readonly Attribution[];
}

export interface PlaceSearchResult {
  /** A `p:` or `n:` location key. Reverse geocoding may return a `c:` key. */
  readonly key: string;
  readonly label: string;
  readonly countryCode: string | null;
  readonly admin1: string | null;
  /** Rounded to two decimals before it leaves the server (invariant I15). */
  readonly lat: number;
  readonly lon: number;
  readonly timezone: string;
  /** The provider's own place classification, verbatim. */
  readonly kind: string | null;
}

/** `GET /api/v1/replay/horizon` — how far back replay can go, and why (ADR-018). */
export interface ReplayHorizonResponse {
  readonly schemaVersion: ReadModelSchemaVersion;
  readonly generatedAt: IsoTimestamp;
  readonly horizon: ReplayHorizon;
}
