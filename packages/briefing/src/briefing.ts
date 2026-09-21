/**
 * `buildBriefing` — the whole response (ARCHITECTURE §5, DOMAIN_MODEL §4.14).
 *
 * ```text
 * 1. S_now  = buildSnapshot(L, asOf)          ┐ same code path,
 * 2. S_prev = buildSnapshot(L, asOf − Δ)      ┘ different knowledge time
 * 3. signals = diff(S_prev, S_now)
 * 4. copy    = templates(S_now, signals)
 * 5. respond LocationBriefing { snapshot, changes, copy, ai?, evidence_manifest }
 * ```
 *
 * Two snapshots through **one** builder is the design, not an optimisation: "what changed" is the
 * difference between two things GeoNerva believed, and the only way to be sure the comparison is
 * fair is for both sides to have been computed by the same code at two knowledge times.
 *
 * ### Invariant I9 is enforced here, not hoped for
 *
 * Every evidence ID referenced anywhere in the response must appear in `evidenceManifest`. This
 * function is the only place that can know the full set, so it collects the IDs from every
 * contributor, resolves them, and then **checks** that nothing was referenced that the manifest
 * cannot resolve. An unresolvable citation is worse than no citation: it looks like proof.
 *
 * ### `ai` is absent unless a validated output was supplied
 *
 * The AI block is a parameter, never something this function produces. `AI_MODE=disabled` is the
 * default, the deterministic copy is the product's language, and a briefing must be complete
 * without a model having run — so the only thing that can put text in `ai` is a caller holding an
 * output that already passed the validator.
 */

import {
  attributionsFor,
  evidenceItemsAsOf,
  type AttributionRow,
  type EvidenceRow,
} from '@geonerva/db/asof';
import { diffSnapshots, type ChangeSignal, type DiffResult } from '@geonerva/changes';
import {
  READ_MODEL_SCHEMA_VERSION,
  tryParseEvidenceId,
  type AiBriefingView,
  type Attribution,
  type ChangeSection,
  type ChangeSignalView,
  type ChangeWindow,
  type EvidenceId,
  type EvidenceItem,
  type LocationBriefing,
} from '@geonerva/domain';

import { contentSha256 } from './content-hash.ts';
import { buildSnapshot, type BuildSnapshotOptions } from './snapshot.ts';
import { buildCopy } from './templates.ts';

/** Window lengths, in milliseconds. `since` is clamped by the caller before it reaches here. */
const WINDOW_MS: Readonly<Record<ChangeWindow, number>> = {
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  since: 24 * 60 * 60 * 1000,
};

export interface BuildBriefingOptions extends Omit<BuildSnapshotOptions, 'generatedAt'> {
  readonly window: ChangeWindow;
  /** For `window: 'since'`: the already-clamped start. Ignored for the fixed windows. */
  readonly sinceAsOf?: Date;
  readonly generatedAt?: Date;
  /**
   * A model output that has **already passed the deterministic validator**.
   *
   * Never produced here. `packages/ai` owns generation and validation; this function's only job is
   * to place a validated result in the response, and to leave the field `null` otherwise.
   */
  readonly ai?: AiBriefingView | null;
}

export interface BriefingBuild {
  readonly briefing: LocationBriefing;
  /** IDs that were referenced but could not be resolved. Empty in a healthy response. */
  readonly unresolvedEvidenceIds: readonly EvidenceId[];
}

/** Raised when the response would violate invariant I9. */
export class EvidenceManifestError extends Error {
  readonly missing: readonly EvidenceId[];

  constructor(missing: readonly EvidenceId[]) {
    super(`evidence manifest is missing ${String(missing.length)} referenced id(s)`);
    this.name = 'EvidenceManifestError';
    this.missing = missing;
  }
}

/**
 * Builds the briefing.
 *
 * `strictManifest` defaults to true: a referenced ID the manifest cannot resolve **throws**,
 * because shipping it would put a citation to nothing in front of a user. A caller that would
 * rather degrade than fail can pass `false` and read `unresolvedEvidenceIds`, which is what the
 * API layer will want for an endpoint that must return *something* — but the default is the
 * strict one, so the failure is loud in development and in tests.
 */
export async function buildBriefing(
  options: BuildBriefingOptions & { readonly strictManifest?: boolean },
): Promise<BriefingBuild> {
  const { db, location, asOf, engineVersion, window } = options;
  const generatedAt = options.generatedAt ?? new Date();
  const fromAsOf =
    window === 'since' && options.sinceAsOf !== undefined
      ? options.sinceAsOf
      : new Date(asOf.getTime() - WINDOW_MS[window]);

  /*
   * Both snapshots are built with the **same** engine version, which §4.14 requires: snapshots of
   * different engine versions are never diffed, and the earlier one is recomputed under the
   * current engine rather than read from a cache written by an older one.
   *
   * They are built in parallel because neither depends on the other, and `buildSnapshot` is the
   * expensive half of a briefing.
   */
  const snapshotOptions = {
    db,
    location,
    engineVersion,
    generatedAt,
    ...(options.maxItemsPerFamily === undefined
      ? {}
      : { maxItemsPerFamily: options.maxItemsPerFamily }),
    ...(options.retentionProfile === undefined
      ? {}
      : { retentionProfile: options.retentionProfile }),
  };
  const [now, previous] = await Promise.all([
    buildSnapshot({ ...snapshotOptions, asOf }),
    buildSnapshot({ ...snapshotOptions, asOf: fromAsOf }),
  ]);

  const diff = diffSnapshots(previous.snapshot, now.snapshot, { fromAsOf, toAsOf: asOf });
  const changes = toChangeSection(diff, window, fromAsOf, asOf, engineVersion);

  const copy = buildCopy({
    location,
    snapshot: now.snapshot,
    window,
    changes: {
      headline: diff.headline.map((signal) => ({ title: signal.title, detail: signal.detail })),
      listedCount: diff.listed.length,
      suppressedCount: diff.suppressed.length,
    },
  });

  /*
   * Every ID referenced anywhere, gathered from every contributor.
   *
   * The *previous* snapshot's evidence is included, because the change section cites both states —
   * a revision's "before" value is a claim, and a claim needs a citation as much as the "after"
   * does. Leaving it out would make every `EVENT_UPDATED` half-unresolvable.
   */
  const referenced = new Set<EvidenceId>([
    ...now.evidenceIds,
    ...previous.evidenceIds,
    ...diff.all.flatMap((signal) => signal.evidenceIds),
    ...(options.ai?.evidenceIds ?? []),
  ]);

  const manifest = await resolveManifest(db, asOf, [...referenced]);
  const resolved = new Set(manifest.map((item) => item.id));
  const unresolvedEvidenceIds = [...referenced].filter((id) => !resolved.has(id)).sort(compare);

  if (unresolvedEvidenceIds.length > 0 && options.strictManifest !== false) {
    throw new EvidenceManifestError(unresolvedEvidenceIds);
  }

  const attribution = await resolveAttribution(db, manifest);

  const briefing: LocationBriefing = {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    location,
    window,
    generatedAt: generatedAt.toISOString(),
    asOfContext: now.asOfContext,
    engineVersion,
    snapshot: now.snapshot,
    changes,
    copy,
    ai: options.ai ?? null,
    evidenceManifest: manifest,
    attribution,
    /*
     * The response's hash is the **snapshot's** hash, not a hash of the whole briefing.
     *
     * `LocationBriefing.contentSha256` is documented as "hash of the snapshot content, which is
     * also the AI cache key", and that is the useful identity: the change section and the copy are
     * both functions of the snapshots, so hashing them again would produce a different number that
     * identifies the same state — and the AI cache is keyed by snapshot.
     */
    contentSha256: now.snapshot.contentSha256,
  };

  return { briefing, unresolvedEvidenceIds };
}

/** Change signals as the read model exposes them. */
function toChangeSection(
  diff: DiffResult,
  window: ChangeWindow,
  fromAsOf: Date,
  toAsOf: Date,
  engineVersion: string,
): ChangeSection {
  const view = (signal: ChangeSignal): ChangeSignalView => ({
    /*
     * `EV:CHG:<sha>` is content-addressed by the change itself, so the same difference between the
     * same two snapshots always has the same id — which is what lets a change be referenced from
     * a later briefing, and what stops a re-render inventing a new identity for an old fact.
     */
    id: changeEvidenceId(signal, fromAsOf, toAsOf, engineVersion),
    type: signal.type,
    family: signal.family,
    subjectRef: signal.subjectRef,
    metricCode: null,
    title: signal.title,
    detail: signal.detail,
    before: null,
    after: null,
    fromAsOf: fromAsOf.toISOString(),
    toAsOf: toAsOf.toISOString(),
    importance: signal.importance,
    prominence: signal.prominence,
    suppressionReason: signal.suppressionReason,
    lateReport: signal.lateReport,
    facets: signal.facets.map((facet) => ({
      type: facet.type,
      label: facet.label,
      before: facet.before === null ? null : { kind: 'text', value: facet.before },
      after: facet.after === null ? null : { kind: 'text', value: facet.after },
    })),
    reasonCodes: signal.reasonCodes,
    evidenceIds: signal.evidenceIds,
    engineVersion,
  });

  return {
    window,
    fromAsOf: fromAsOf.toISOString(),
    toAsOf: toAsOf.toISOString(),
    headline: diff.headline.map(view),
    listed: diff.listed.map(view),
    detail: diff.detail.map(view),
    suppressed: diff.suppressed.map(view),
    suppressedCount: diff.suppressed.length,
    /*
     * §10.4's sentence, present only when nothing reached `LISTED`. A `null` here means "there is
     * a list to show", so the UI never has to decide whether an empty list deserves a sentence.
     */
    emptyStatement:
      diff.headline.length === 0 && diff.listed.length === 0
        ? `No meaningful changes ${windowPhrase(window)}.`
        : null,
  };
}

function windowPhrase(window: ChangeWindow): string {
  switch (window) {
    case '6h':
      return 'in the last 6 hours';
    case '24h':
      return 'in the last 24 hours';
    case '7d':
      return 'in the last 7 days';
    case 'since':
      return 'since your last visit';
  }
}

/**
 * The content address of one change signal.
 *
 * Hashed over the fields that *identify* the change — the window, the subject, the type and the
 * facet values — and deliberately not over `importance` or `prominence`, which are ranking
 * decisions that a later engine version may make differently about the same underlying difference.
 */
function changeEvidenceId(
  signal: ChangeSignal,
  fromAsOf: Date,
  toAsOf: Date,
  engineVersion: string,
): EvidenceId {
  const identity = {
    engineVersion,
    from: fromAsOf.toISOString(),
    to: toAsOf.toISOString(),
    type: signal.type,
    family: signal.family,
    subjectRef: signal.subjectRef,
    facets: signal.facets.map((facet) => [facet.label, facet.before, facet.after]),
  };
  /*
   * Hashed through `contentSha256`, which sorts keys and normalizes numbers. `JSON.stringify`
   * would make the id depend on key insertion order — the same difference between the same two
   * snapshots would get two identities depending on which code path built the object, which is
   * precisely what the canonical form exists to prevent.
   */
  return `EV:CHG:${contentSha256(identity)}`;
}

/**
 * Resolves the manifest.
 *
 * Content-addressed kinds are synthesized rather than looked up: their ID *is* the hash of the
 * computation that produced them, there is no row to fetch, and DOMAIN_MODEL §4.11 says they are
 * self-contained in the manifest. Everything else is read from the immutable row it points at.
 */
async function resolveManifest(
  db: BuildSnapshotOptions['db'],
  asOf: Date,
  ids: readonly EvidenceId[],
): Promise<EvidenceItem[]> {
  const contentAddressed = ids.filter((id) => {
    const kind = tryParseEvidenceId(id)?.kind;
    return kind === 'BAS' || kind === 'REL' || kind === 'CHG';
  });
  const rowBacked = ids.filter((id) => !contentAddressed.includes(id));

  const rows = await evidenceItemsAsOf(db, { asOf, ids: rowBacked });

  const items: EvidenceItem[] = rows.map(toEvidenceItem);
  for (const id of contentAddressed) {
    const kind = tryParseEvidenceId(id)?.kind;
    if (kind !== 'BAS' && kind !== 'REL' && kind !== 'CHG') continue;
    items.push({
      id,
      kind,
      summary: summaryForDerived(kind),
      sourceId: null,
      productId: null,
      observedAt: null,
      /*
       * For a derivation the knowledge time *is* the `as_of` it was computed for — that is the
       * value that participates in replay, which is why `EvidenceItem` documents this field that
       * way rather than as an ingestion timestamp.
       */
      ingestedAt: asOf.toISOString(),
      url: null,
      resolvable: false,
    });
  }

  return items.sort((left, right) => compare(left.id, right.id));
}

function toEvidenceItem(row: EvidenceRow): EvidenceItem {
  return {
    id: row.id,
    kind: row.kind as EvidenceItem['kind'],
    summary: row.summary,
    sourceId: row.source_id,
    productId: row.product_id,
    observedAt: row.observed_at?.toISOString() ?? null,
    ingestedAt: row.ingested_at.toISOString(),
    url: row.url,
    /*
     * `OBS`, `FCV`, `RUN` and `COR` resolve through `GET /api/v1/evidence/{id}`; the derived kinds
     * do not, and saying so here is what lets the UI decide whether an evidence chip is a link.
     */
    resolvable: true,
  };
}

function summaryForDerived(kind: 'BAS' | 'REL' | 'CHG'): string {
  switch (kind) {
    case 'BAS':
      return 'A baseline computation, identified by the hash of its own inputs.';
    case 'REL':
      return 'A relevance assessment, identified by the hash of its own inputs.';
    case 'CHG':
      return 'A change signal, identified by the hash of the change itself.';
  }
}

/**
 * Attribution for every source the manifest cites.
 *
 * Derived from the manifest rather than from the source table, so the footer names exactly the
 * providers this response actually used — several providers' terms require the attribution text
 * and the disclaimer verbatim wherever their data appears.
 */
async function resolveAttribution(
  db: BuildSnapshotOptions['db'],
  manifest: readonly EvidenceItem[],
): Promise<Attribution[]> {
  const sourceIds = [
    ...new Set(manifest.map((item) => item.sourceId).filter((id): id is string => id !== null)),
  ].sort(compare);
  const rows = await attributionsFor(db, sourceIds);
  return rows.map(toAttribution);
}

function toAttribution(row: AttributionRow): Attribution {
  return {
    sourceId: row.source_id,
    name: row.name,
    homepage: row.homepage,
    licence: row.licence,
    attributionText: row.attribution_text,
    termsUrl: row.terms_url,
    disclaimer: row.disclaimer,
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
