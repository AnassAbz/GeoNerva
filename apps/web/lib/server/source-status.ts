/**
 * Assembles `SourceStatus`, the response of `GET /api/v1/sources/status`.
 *
 * ### Why this is a separate module from `services.ts`
 *
 * This is the largest pure assembly in the API layer — five reads joined into one frozen contract —
 * and none of it touches the database. Keeping it here means `services.ts` stays a readable list of
 * the application's capabilities, and means this mapping can be unit-tested against fabricated rows
 * without a Postgres container: every rule below ("worst product wins", "a rate without a
 * denominator is not a rate", "an unknown enum value is dropped, not coerced") is a claim that
 * deserves a test, and tests that need a database do not get written as thoroughly.
 *
 * ### The honesty rules this endpoint exists to serve
 *
 * `/data-status` is where GeoNerva's central promise becomes checkable: the product's value is
 * being right about what it does not know. Three consequences are load-bearing here.
 *
 *  1. **A source with no runs is not a healthy source.** It reports whatever `deriveSourceHealth`
 *     says (ADR-022) — never `FRESH` by omission — and `successRate24h` is `null` rather than `0`
 *     or `1`, because there is no rate to state.
 *  2. **The rollup takes the worst product, not the average.** `aggregateSourceHealth` already
 *     does this; the entry simply carries its answer. A source whose earthquake feed is fine and
 *     whose tsunami feed is dead is not "mostly fine".
 *  3. **Nothing here invents a status.** Every `SourceHealthView` in the response comes from the
 *     derivation, mapped by the one shared mapper in `packages/domain`. This module chooses no
 *     thresholds and compares no timestamps against a policy.
 */

import {
  HAZARD_TYPES,
  READ_MODEL_SCHEMA_VERSION,
  SOURCE_CAPABILITIES,
  ERROR_CLASSES,
  RUN_STATUSES,
  RUN_TRIGGERS,
  evidenceId,
  toSourceHealthView,
  type AsOfContext,
  type ErrorClass,
  type EvidenceId,
  type EvidenceItem,
  type HazardType,
  type ReplayHorizon,
  type RunStatus,
  type RunTrigger,
  type RunSummaryView,
  type SourceCapability,
  type SourceHealthView,
  type SourceProductView,
  type SourceStatus,
  type SourceStatusEntry,
  type WorkerStatusView,
} from '@geonerva/domain';

import { toAttribution } from './attribution.ts';

import type {
  AttributionRow,
  EvidenceRow,
  RunSummaryRow,
  RunTallyRow,
  SourceHealthAsOf,
  SourceProductRow,
  SourceRow,
  WorkerHeartbeatRow,
} from './db.ts';
import { toEvidenceItem } from './evidence-view.ts';

/**
 * The heartbeat cadence, from ARCHITECTURE §14 ("updated every minute").
 *
 * `WorkerStatusView.isStale` is defined as "older than twice its interval", so the threshold is
 * two minutes. It is a constant here rather than a configuration value because the writer's
 * interval is also hard-coded; the day one becomes configurable, both must move together, and a
 * named constant beside the rule is the cheapest way to make that visible.
 */
export const WORKER_HEARTBEAT_INTERVAL_S = 60;
export const WORKER_HEARTBEAT_STALE_AFTER_S = WORKER_HEARTBEAT_INTERVAL_S * 2;

/** Everything the assembly needs. All of it already read, none of it re-read here. */
export interface SourceStatusInput {
  readonly asOf: Date;
  readonly generatedAt: Date;
  readonly isReplay: boolean;
  readonly horizon: ReplayHorizon;
  readonly cutoffs: Readonly<Record<string, Date | null>>;
  readonly sources: readonly SourceRow[];
  readonly products: readonly SourceProductRow[];
  readonly healthBySource: readonly SourceHealthAsOf[];
  readonly healthByProduct: readonly SourceHealthAsOf[];
  readonly runs: readonly RunSummaryRow[];
  readonly tally: readonly RunTallyRow[];
  readonly worker: WorkerHeartbeatRow | null;
  readonly attribution: readonly AttributionRow[];
  readonly evidence: readonly EvidenceRow[];
}

/** Builds the response. Pure: same input, same bytes. */
export function buildSourceStatus(input: SourceStatusInput): SourceStatus {
  const healthBySourceId = new Map(input.healthBySource.map((entry) => [entry.sourceId, entry]));
  const productsBySource = groupBy(input.products, (row) => row.source_id);
  const runsBySource = groupBy(input.runs, (row) => row.source_id);
  const healthByProductKey = new Map(
    input.healthByProduct.map((entry) => [productKey(entry.sourceId, entry.productId), entry]),
  );
  const tallyBySource = new Map(input.tally.map((row) => [row.source_id, row]));

  const sources: SourceStatusEntry[] = input.sources.map((source) => {
    const products = productsBySource.get(source.source_id) ?? [];
    const tally = tallyBySource.get(source.source_id);
    const rollup = healthBySourceId.get(source.source_id);

    return {
      sourceId: source.source_id,
      name: source.name,
      homepage: source.homepage,
      enabled: source.enabled,
      licence: source.licence,
      attributionText: source.attribution_text,
      termsUrl: source.terms_url,
      disclaimer: source.disclaimer,
      coverageNote: source.coverage_note,
      coverageGeometryAvailable: source.coverage_geometry_available,
      /*
       * The source-level lists are the union over its products, sorted. A source does not declare
       * its own hazard types — its products do (ADR-009, so that retiring a sensor is a data
       * change) — and a reader asking "can this source see floods?" is asking about the union.
       */
      hazardTypes: unionHazardTypes(products),
      capabilities: unionCapabilities(products),
      health: sourceHealthOf(rollup, source.source_id),
      products: products.map((product) =>
        toProductView(
          product,
          healthByProductKey.get(productKey(product.source_id, product.product_id)),
        ),
      ),
      recentRuns: (runsBySource.get(source.source_id) ?? []).map(toRunSummary),
      /*
       * `null`, not `0`, when nothing ran. A zero here would read as "every run failed", which is
       * the false-negative this whole page exists to prevent.
       */
      successRate24h:
        tally === undefined || tally.total === 0 ? null : tally.succeeded / tally.total,
      runCount24h: tally?.total ?? 0,
    };
  });

  return {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    asOfContext: asOfContextOf(input),
    generatedAt: input.generatedAt.toISOString(),
    sources,
    worker: toWorkerStatus(input.worker, input.asOf),
    /*
     * Empty, and empty means "GeoNerva reports no data-quality checks", not "all checks pass".
     *
     * docs/TESTING.md §7 defines five runtime invariants (future `observed_at`, feed truncation,
     * suspicious empties, ambiguous-correlation rate, unresolved GDACS references) and places
     * them explicitly "in the worker", computed after each run. The worker does not compute them
     * yet and there is no table to read them from, so there is nothing to report. Fabricating
     * five `status: 'OK'` rows from a query written here would be the exact inversion of this
     * endpoint's purpose: a green light with nothing behind it.
     */
    dataQuality: [],
    evidenceManifest: manifestFor(sources, input.evidence),
    attribution: input.attribution.map(toAttribution),
  };
}

function asOfContextOf(input: SourceStatusInput): AsOfContext {
  return {
    asOf: input.asOf.toISOString(),
    isReplay: input.isReplay,
    replayHorizon: input.horizon,
    sourceCutoffs: Object.fromEntries(
      Object.entries(input.cutoffs)
        .sort(([left], [right]) => compare(left, right))
        .map(([sourceId, at]) => [sourceId, at === null ? null : at.toISOString()]),
    ),
  };
}

/**
 * The manifest (invariant I9): every evidence ID the response references, resolved.
 *
 * Built by walking the assembled response rather than by collecting IDs while assembling it. That
 * is deliberate — a manifest gathered alongside the work drifts the moment someone adds a field
 * that cites something, and the resulting response cites an ID that is not in its own manifest.
 * Walking the finished object cannot drift, because the thing it walks *is* what shipped.
 *
 * An ID whose row could not be read at this knowledge time is **omitted**, which surfaces as a
 * manifest gap. That is the honest outcome: the alternative is a manifest entry invented from the
 * ID itself, which would make an unresolvable citation look resolvable.
 */
function manifestFor(
  sources: readonly SourceStatusEntry[],
  evidence: readonly EvidenceRow[],
): readonly EvidenceItem[] {
  const referenced = new Set<EvidenceId>();
  for (const source of sources) {
    if (source.health.evidenceId !== null) referenced.add(source.health.evidenceId);
    for (const product of source.products) {
      if (product.health.evidenceId !== null) referenced.add(product.health.evidenceId);
    }
    for (const run of source.recentRuns) referenced.add(run.evidenceId);
  }

  return evidence
    .filter((row) => referenced.has(row.id))
    .map(toEvidenceItem)
    .sort((left, right) => compare(left.id, right.id));
}

/** Every evidence ID this response will cite, so the caller knows what to resolve. */
export function evidenceIdsFor(input: {
  readonly healthBySource: readonly SourceHealthAsOf[];
  readonly healthByProduct: readonly SourceHealthAsOf[];
  readonly runs: readonly RunSummaryRow[];
}): readonly EvidenceId[] {
  const ids = new Set<EvidenceId>();
  for (const entry of [...input.healthBySource, ...input.healthByProduct]) {
    if (entry.evidenceId !== null) ids.add(entry.evidenceId);
  }
  for (const run of input.runs) ids.add(evidenceId.ingestionRun(run.id));
  return [...ids].sort(compare);
}

/**
 * The health of a source that the derivation did not report on.
 *
 * `healthAsOf` returns an entry for every row in `sources`, so this branch is unreachable in
 * practice — but "unreachable" and "cannot happen" are different, and the fallback must not be a
 * `FRESH` placeholder. `UNAVAILABLE` with `DISABLED` is the safe direction: if the two
 * reads ever disagree, the page says GeoNerva cannot see the source rather than that it can.
 */
function sourceHealthOf(health: SourceHealthAsOf | undefined, sourceId: string): SourceHealthView {
  if (health !== undefined) return toSourceHealthView(health);
  return {
    sourceId,
    productId: null,
    status: 'UNAVAILABLE',
    lastAttemptAt: null,
    lastSuccessAt: null,
    newestObservedAt: null,
    consecutiveFailures: 0,
    lastErrorClass: null,
    reasons: ['DISABLED'],
    expected: {
      pollIntervalS: 0,
      fetchFreshWithinS: 0,
      fetchStaleAfterS: 0,
      unavailableAfterS: 0,
      dataCurrentWithinS: null,
      dataStaleAfterS: null,
      quietIsNormal: false,
    },
    evidenceId: null,
  };
}

function toProductView(
  product: SourceProductRow,
  health: SourceHealthAsOf | undefined,
): SourceProductView {
  return {
    id: product.product_id,
    code: product.code,
    hazardTypes: knownHazardTypes(product.hazard_types),
    capabilities: knownCapabilities(product.capabilities),
    platform: product.platform,
    instrument: product.instrument,
    resolutionM: product.resolution_m,
    status: productStatusOf(product.status),
    activeFrom: product.active_from,
    activeTo: product.active_to,
    health: sourceHealthOf(health, product.source_id),
  };
}

/**
 * The column is `text` with a `CHECK`; the read model is a union of three words.
 *
 * A value outside the union becomes `RETIRED`, which is the conservative direction: an unrecognised
 * product status must not present as `ACTIVE`, because `ACTIVE` is the one value a reader takes as
 * a promise that the feed is being polled.
 */
function productStatusOf(value: string): 'ACTIVE' | 'RETIRING' | 'RETIRED' {
  return value === 'ACTIVE' || value === 'RETIRING' ? value : 'RETIRED';
}

function toRunSummary(row: RunSummaryRow): RunSummaryView {
  return {
    id: row.id,
    productId: row.product_id,
    trigger: knownTrigger(row.trigger),
    status: knownStatus(row.status),
    startedAt: row.started_at.toISOString(),
    committedAt: row.committed_at.toISOString(),
    /*
     * From `finished_at`, not from `committed_at`. They differ by the commit itself, and the
     * number a reader wants is how long the provider took, not how long the transaction took.
     * `null` when the run never recorded a finish, rather than a duration measured to now.
     */
    durationMs:
      row.finished_at === null ? null : row.finished_at.getTime() - row.started_at.getTime(),
    counts: {
      received: row.n_received,
      newRecords: row.n_new_records,
      newVersions: row.n_new_versions,
      unchanged: row.n_unchanged,
      rejected: row.n_rejected,
    },
    newestObservedAt: row.newest_observed_at?.toISOString() ?? null,
    errorClass: knownErrorClass(row.error_class),
    evidenceId: evidenceId.ingestionRun(row.id),
  };
}

/**
 * The worker heartbeat, or `null` when GeoNerva cannot state it.
 *
 * Staleness is measured against the **knowledge time**, not against the wall clock. For a live
 * request the two are the same; for a replay, comparing a past heartbeat to the present clock
 * would report every historical heartbeat as stale, which says nothing about the worker and
 * everything about how long ago the request is asking about.
 */
function toWorkerStatus(row: WorkerHeartbeatRow | null, asOf: Date): WorkerStatusView | null {
  if (row === null) return null;
  const ageS = (asOf.getTime() - row.last_seen_at.getTime()) / 1000;
  return {
    lastSeenAt: row.last_seen_at.toISOString(),
    version: row.version,
    isStale: ageS > WORKER_HEARTBEAT_STALE_AFTER_S,
  };
}

/*
 * ── Enum narrowing ─────────────────────────────────────────────────────────────
 *
 * Postgres columns are `text` (with `CHECK` constraints); the read models are closed unions. A
 * value the domain does not declare is **dropped** from a list and becomes `null` in a scalar
 * field. It is never passed through with a cast: a cast would put a string the frontend has no
 * branch for into a frozen contract, and the failure would surface as a blank card rather than as
 * a missing value.
 */

function knownHazardTypes(values: readonly string[]): readonly HazardType[] {
  return values.filter((value): value is HazardType =>
    (HAZARD_TYPES as readonly string[]).includes(value),
  );
}

function knownCapabilities(values: readonly string[]): readonly SourceCapability[] {
  return values.filter((value): value is SourceCapability =>
    (SOURCE_CAPABILITIES as readonly string[]).includes(value),
  );
}

function unionHazardTypes(products: readonly SourceProductRow[]): readonly HazardType[] {
  const seen = new Set<HazardType>();
  for (const product of products)
    for (const type of knownHazardTypes(product.hazard_types)) {
      seen.add(type);
    }
  return HAZARD_TYPES.filter((type) => seen.has(type));
}

function unionCapabilities(products: readonly SourceProductRow[]): readonly SourceCapability[] {
  const seen = new Set<SourceCapability>();
  for (const product of products)
    for (const value of knownCapabilities(product.capabilities)) {
      seen.add(value);
    }
  return SOURCE_CAPABILITIES.filter((value) => seen.has(value));
}

/** An unknown trigger becomes `SCHEDULE`: the column has a `CHECK`, so this is unreachable. */
function knownTrigger(value: string): RunTrigger {
  return (RUN_TRIGGERS as readonly string[]).includes(value) ? (value as RunTrigger) : 'SCHEDULE';
}

/**
 * An unknown run status becomes `FAILED`.
 *
 * The conservative direction again: a status the domain does not recognise must not be counted or
 * rendered as a success. The tally in SQL has the same property by construction — it filters *for*
 * `SUCCEEDED` rather than filtering out known failures — so an unrecognised status lowers the
 * success rate instead of being quietly excluded from it.
 */
function knownStatus(value: string): RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value) ? (value as RunStatus) : 'FAILED';
}

function knownErrorClass(value: string | null): ErrorClass | null {
  if (value === null) return null;
  return (ERROR_CLASSES as readonly string[]).includes(value) ? (value as ErrorClass) : null;
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(key(row));
    if (bucket === undefined) grouped.set(key(row), [row]);
    else bucket.push(row);
  }
  return grouped;
}

function productKey(sourceId: string, productId: number | null): string {
  return `${sourceId}\u0000${productId === null ? '' : String(productId)}`;
}

/** Explicit code-unit ordering, so the response bytes do not depend on the server's locale. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
