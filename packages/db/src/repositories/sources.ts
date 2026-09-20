/**
 * Sources and products: read access to the reference data, plus the few state changes that are
 * genuinely data rather than deployment (DOMAIN_MODEL §4.1, ADR-009).
 *
 * Nothing in GeoNerva branches on a source id. Callers ask "which products have
 * `POINT_DETECTIONS`?", not "is this FIRMS?", which is why adding a satellite is an INSERT and
 * retiring one is an UPDATE.
 */

import { sql, type Kysely } from 'kysely';

import {
  freshnessPolicySchema,
  pollingPolicySchema,
  type FreshnessPolicy,
  type HazardType,
  type PollingPolicy,
  type SourceCapability,
} from '@geonerva/domain';

import type { DB } from '../generated/database.ts';

export interface SourceRow {
  readonly id: string;
  readonly name: string;
  readonly homepage: string | null;
  readonly licence: string;
  readonly attributionText: string;
  readonly termsUrl: string | null;
  readonly disclaimer: string | null;
  readonly coverageNote: string | null;
  readonly hasCoverageGeometry: boolean;
  readonly enabled: boolean;
  readonly policy: unknown;
}

export interface SourceProductRow {
  readonly id: number;
  readonly sourceId: string;
  readonly code: string;
  readonly hazardTypes: readonly HazardType[];
  readonly capabilities: readonly SourceCapability[];
  readonly platform: string | null;
  readonly instrument: string | null;
  readonly resolutionM: number | null;
  readonly confidenceScale: string | null;
  readonly latencyClass: string | null;
  readonly status: 'ACTIVE' | 'RETIRING' | 'RETIRED';
  readonly activeFrom: string | null;
  readonly activeTo: string | null;
  readonly enabled: boolean;
  readonly policy: unknown;
}

/** Every source, ordered by id so that output is stable. */
export async function listSources(
  db: Kysely<DB>,
  options: { includeDisabled?: boolean } = {},
): Promise<SourceRow[]> {
  const result = await sql<{
    id: string;
    name: string;
    homepage: string | null;
    licence: string;
    attribution_text: string;
    terms_url: string | null;
    disclaimer: string | null;
    coverage_note: string | null;
    has_coverage: boolean;
    enabled: boolean;
    policy: unknown;
  }>`
    SELECT id, name, homepage, licence, attribution_text, terms_url, disclaimer, coverage_note,
           (coverage IS NOT NULL) AS has_coverage, enabled, policy
    FROM geonerva.sources
    WHERE ${options.includeDisabled === true ? sql`TRUE` : sql`enabled`}
    ORDER BY id
  `.execute(db);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    homepage: row.homepage,
    licence: row.licence,
    attributionText: row.attribution_text,
    termsUrl: row.terms_url,
    disclaimer: row.disclaimer,
    coverageNote: row.coverage_note,
    hasCoverageGeometry: row.has_coverage,
    enabled: row.enabled,
    policy: row.policy,
  }));
}

/** Every product, optionally for one source. */
export async function listSourceProducts(
  db: Kysely<DB>,
  options: { sourceId?: string; includeDisabled?: boolean; includeRetired?: boolean } = {},
): Promise<SourceProductRow[]> {
  const sourceFilter =
    options.sourceId === undefined ? sql`TRUE` : sql`p.source_id = ${options.sourceId}`;
  const enabledFilter = options.includeDisabled === true ? sql`TRUE` : sql`p.enabled`;
  const retiredFilter = options.includeRetired === true ? sql`TRUE` : sql`p.status <> 'RETIRED'`;

  const result = await sql<{
    id: number;
    source_id: string;
    code: string;
    hazard_types: string[];
    capabilities: string[];
    platform: string | null;
    instrument: string | null;
    resolution_m: number | null;
    confidence_scale: string | null;
    latency_class: string | null;
    status: string;
    active_from: Date | null;
    active_to: Date | null;
    enabled: boolean;
    policy: unknown;
  }>`
    SELECT p.id, p.source_id, p.code, p.hazard_types, p.capabilities, p.platform, p.instrument,
           p.resolution_m, p.confidence_scale, p.latency_class, p.status, p.active_from,
           p.active_to, p.enabled, p.policy
    FROM geonerva.source_products p
    WHERE ${sourceFilter} AND ${enabledFilter} AND ${retiredFilter}
    ORDER BY p.source_id, p.code
  `.execute(db);

  return result.rows.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    code: row.code,
    hazardTypes: row.hazard_types as HazardType[],
    capabilities: row.capabilities as SourceCapability[],
    platform: row.platform,
    instrument: row.instrument,
    resolutionM: row.resolution_m,
    confidenceScale: row.confidence_scale,
    latencyClass: row.latency_class,
    status: row.status as 'ACTIVE' | 'RETIRING' | 'RETIRED',
    activeFrom: row.active_from === null ? null : row.active_from.toISOString().slice(0, 10),
    activeTo: row.active_to === null ? null : row.active_to.toISOString().slice(0, 10),
    enabled: row.enabled,
    policy: row.policy,
  }));
}

/** One product by `(source, code)`, or `null`. Used by adapters to resolve their own product id. */
export async function findProductByCode(
  db: Kysely<DB>,
  sourceId: string,
  code: string,
): Promise<SourceProductRow | null> {
  const products = await listSourceProducts(db, {
    sourceId,
    includeDisabled: true,
    includeRetired: true,
  });
  return products.find((product) => product.code === code) ?? null;
}

/**
 * Products with a given capability. This is the query the pipeline actually uses, and the reason
 * "code never branches on source names" is enforceable rather than aspirational.
 */
export async function listProductsWithCapability(
  db: Kysely<DB>,
  capability: SourceCapability,
): Promise<SourceProductRow[]> {
  const products = await listSourceProducts(db);
  return products.filter((product) => product.capabilities.includes(capability));
}

/** The freshness policy of a source, validated against the domain schema. */
export async function getSourceFreshnessPolicy(
  db: Kysely<DB>,
  sourceId: string,
): Promise<FreshnessPolicy> {
  const result = await sql<{ policy: { freshness?: unknown } | null }>`
    SELECT policy FROM geonerva.sources WHERE id = ${sourceId}
  `.execute(db);
  const raw = result.rows[0]?.policy;
  if (raw === undefined || raw === null) throw new Error(`unknown source: ${sourceId}`);
  return freshnessPolicySchema.parse(raw.freshness);
}

/**
 * The polling policy for a product, falling back to its source's.
 *
 * Read from the database rather than the adapter descriptor, so changing how often a source is
 * polled is a data change and does not need a deploy — and so the interval a worker uses and the
 * interval `/data-status` judges freshness against can never be two different numbers.
 */
export async function getPollingPolicy(
  db: Kysely<DB>,
  sourceId: string,
  productCode?: string,
): Promise<PollingPolicy> {
  const result = await sql<{ source_policy: unknown; product_policy: unknown }>`
    SELECT s.policy AS source_policy, p.policy AS product_policy
    FROM geonerva.sources s
    LEFT JOIN geonerva.source_products p
      ON p.source_id = s.id AND p.code = ${productCode ?? null}
    WHERE s.id = ${sourceId}
    LIMIT 1
  `.execute(db);

  const row = result.rows[0];
  if (row === undefined) throw new Error(`unknown source: ${sourceId}`);

  const pollingOf = (policy: unknown): PollingPolicy | null => {
    if (typeof policy !== 'object' || policy === null || !('polling' in policy)) return null;
    const parsed = pollingPolicySchema.safeParse(policy.polling);
    return parsed.success ? parsed.data : null;
  };

  const policy = pollingOf(row.product_policy) ?? pollingOf(row.source_policy);
  if (policy === null) {
    // Guessing an interval would either hammer a provider or poll so rarely that the source
    // looks stale. Neither is a safe default, so this is a configuration error.
    throw new Error(
      `no polling policy for ${sourceId}${productCode === undefined ? '' : `:${productCode}`}`,
    );
  }
  return policy;
}

/** Enables or disables a source. A data change, recorded with `updated_at`. */
export async function setSourceEnabled(
  db: Kysely<DB>,
  sourceId: string,
  enabled: boolean,
): Promise<void> {
  await sql`
    UPDATE geonerva.sources SET enabled = ${enabled}, updated_at = now() WHERE id = ${sourceId}
  `.execute(db);
}

/** Retires a product (a satellite reaching end of life), recording the date it stopped. */
export async function retireProduct(
  db: Kysely<DB>,
  productId: number,
  activeTo: Date,
): Promise<void> {
  await sql`
    UPDATE geonerva.source_products
    SET status = 'RETIRED', enabled = false, active_to = ${activeTo}::date, updated_at = now()
    WHERE id = ${productId}
  `.execute(db);
}
