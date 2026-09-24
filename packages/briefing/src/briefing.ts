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
    /*
     * Without baselines: see `BuildSnapshotOptions.baselineMetrics`. The earlier snapshot is
     * diffed and then discarded, and `diffSnapshots` does not read `metrics`.
     */
    buildSnapshot({ ...snapshotOptions, asOf: fromAsOf, baselineMetrics: false }),
  ]);

  const diff = diffSnapshots(previous.snapshot, now.snapshot, { fromAsOf, toAsOf: asOf });
  const changes = toChangeSection(diff, window, fromAsOf, asOf, engineVersion);

  /*
   * The change signals' **own** ids are evidence ids in this response.
   *
   * `ChangeSignalView.id` is typed `EvidenceId` and is an `EV:CHG:` content address, so invariant
   * I9 covers it — and the first version of this function collected the ids each signal *cites*
   * while omitting the ids the signals *are*. Every briefing with a change therefore shipped an
   * evidence id absent from its own manifest, in the function whose docblock says it enforces I9.
   */
  const mintedChangeIds = [
    ...changes.headline,
    ...changes.listed,
    ...changes.detail,
    ...changes.suppressed,
  ].map((signal) => signal.id);

  /*
   * Every content-addressed id this build minted: the change signals above, and each card's
   * `EV:BAS:` baseline.
   *
   * `resolveManifest` synthesizes an entry for `BAS`/`REL`/`CHG` **only** for ids in this set, so
   * that a fabricated hash stays unresolvable. Its own comment named this moment — "it becomes
   * load-bearing the moment `packages/baselines` starts contributing `EV:BAS:` ids to the
   * referenced set" — and this is it. Without the baselines here, every briefing would throw
   * `EvidenceManifestError` for its own cards' citations; with them, DOMAIN_MODEL §4.11's
   * "embedded in the briefing manifest" is true for the first time, and invariant I9 covers the
   * one derivation a card shows above the fold.
   */
  const minted = new Set<EvidenceId>([...mintedChangeIds, ...now.mintedEvidenceIds]);

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
    ...minted,
  ]);

  /*
   * The manifest is resolved from the **deterministic** evidence only, and the AI block's
   * citations are then *checked against it*.
   *
   * The first version unioned `ai.evidenceIds` into `referenced` before resolving, which made I9
   * self-fulfilling for the one contributor that is model-derived: any id the model produced that
   * happened to resolve to a real row was admitted to the manifest and became its own
   * justification. A cached AI block validated against a different snapshot would then show
   * resolvable citations to evidence this snapshot never used — indistinguishable from real
   * support, which is exactly the "looks like proof" failure the strict default exists for.
   */
  const manifest = await resolveManifest(db, asOf, [...referenced], minted);
  const resolved = new Set(manifest.map((item) => item.id));
  const unresolvedEvidenceIds = [...new Set([...referenced, ...(options.ai?.evidenceIds ?? [])])]
    .filter((id) => !resolved.has(id))
    .sort(compare);

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
    /*
     * The contract types these as `FactValue | null` and they were hard-coded `null`, so a UI
     * could not render or compare a numeric revision — the values survived only inside `facets`,
     * already stringified. They are taken from the first facet that has them, which for a grouped
     * signal is the one its `type` is about.
     *
     * They are `text` values rather than typed numbers because the change engine stringifies at
     * the precision the card shows ("M5.1", "12 km"). Recovering unit and decimals means carrying
     * `FactValue` through the classifier, which is a change to a pure engine's contract and wants
     * an ADR; it is recorded in the gate report rather than done quietly here.
     */
    before: firstFacetValue(signal, 'before'),
    after: firstFacetValue(signal, 'after'),
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

/** The first facet value of a grouped signal, as the read model's `FactValue`. */
function firstFacetValue(
  signal: ChangeSignal,
  side: 'before' | 'after',
): ChangeSignalView['before'] {
  for (const facet of signal.facets) {
    const value = side === 'before' ? facet.before : facet.after;
    if (value !== null) return { kind: 'text', value };
  }
  return null;
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
 *
 * **The stability this gives, stated precisely.** Two builds of the same `(asOf, window, engine)`
 * over the same database state produce the same id. Two builds at *different* knowledge times do
 * not, because `from` and `to` are part of the identity — which is correct, since a different
 * window is a different comparison, but it is weaker than "an old fact keeps its id forever". A
 * change cannot yet be referenced across windows; doing that needs an identity that excludes the
 * boundaries, and deciding whether that is even the right notion is a product question.
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
  mintedDerivedIds: ReadonlySet<EvidenceId>,
): Promise<EvidenceItem[]> {
  const byKind = new Map<string, EvidenceId[]>();
  for (const id of ids) {
    const kind = tryParseEvidenceId(id)?.kind;
    if (kind === undefined) continue;
    const bucket = byKind.get(kind);
    if (bucket === undefined) byKind.set(kind, [id]);
    else bucket.push(id);
  }

  /*
   * Row-backed kinds are the ones that point at an immutable row: an observation version, a
   * correlation link, an ingestion run, a cluster version. Anything else is *derived*, and the
   * distinction matters because a derived id cannot be checked against a table.
   */
  const rowBacked = [
    ...(byKind.get('OBS') ?? []),
    ...(byKind.get('COR') ?? []),
    ...(byKind.get('RUN') ?? []),
    ...(byKind.get('FCV') ?? []),
  ];
  const rows = await evidenceItemsAsOf(db, { asOf, ids: rowBacked });
  const items: EvidenceItem[] = rows.map(toEvidenceItem);
  const resolvedClusterVersions = new Set(
    rows.filter((row) => row.kind === 'FCV').map((row) => row.id),
  );

  /*
   * `EV:FDS:<clusterVersionId>:<count>` — the detection set behind a cluster version.
   *
   * It is neither a primary kind (there is no row for "the set of detections") nor
   * content-addressed, and an earlier version of this function routed it to a query that has no
   * branch for it. The id then resolved to nothing, and because `strictManifest` defaults to
   * true, **every briefing with a fire cluster threw** — the family whose evidence ids were
   * designed in P4 was the one that could not be served. The int tests seeded only earthquakes,
   * which is why they were green.
   *
   * It is resolvable exactly when its cluster version is: the count travels in the id, and the
   * thing that makes the citation trustworthy is that the version it summarizes exists at this
   * knowledge time. **`resolvable` is true**, because the evidence endpoint now reconstructs the
   * set through membership rather than refusing it; the manifest and the endpoint have to agree
   * about that flag, and they disagreed with `DOMAIN_MODEL.md` between them until it did.
   */
  for (const id of byKind.get('FDS') ?? []) {
    const ref = tryParseEvidenceId(id);
    if (ref?.kind !== 'FDS') continue;
    const parent = `EV:FCV:${ref.clusterVersionId}`;
    if (!resolvedClusterVersions.has(parent)) continue;
    const version = rows.find((row) => row.id === parent);
    items.push({
      id,
      kind: 'FDS',
      summary: `The ${String(ref.count)} detections behind fire cluster version ${ref.clusterVersionId}.`,
      sourceId: version?.source_id ?? null,
      productId: version?.product_id ?? null,
      observedAt: version?.observed_at?.toISOString() ?? null,
      ingestedAt: version?.ingested_at.toISOString() ?? asOf.toISOString(),
      url: null,
      resolvable: true,
    });
  }

  /*
   * Content-addressed kinds are synthesized rather than looked up — their id *is* the hash of the
   * computation — but **only when this engine minted them**.
   *
   * Synthesizing an entry for any well-formed `BAS`/`REL`/`CHG` id made the strict-manifest gate
   * vacuous for three of the eight kinds: a citation to `EV:REL:` plus 64 arbitrary hex characters
   * was silently admitted and never appeared in `unresolvedEvidenceIds`. The gate could not fail
   * for precisely the ids a model is most able to fabricate.
   *
   * **Currently unreachable, deliberately kept.** Since the AI block's citations are now *checked*
   * rather than merged, the only derived ids reaching this function are the change ids this build
   * minted — so the guard cannot fail today, and a mutation control confirms no test distinguishes
   * it. It becomes load-bearing the moment `packages/baselines` starts contributing `EV:BAS:` ids
   * to the referenced set, which is the next thing to do so. Elsewhere in this codebase a
   * predicate no test can distinguish has been deleted; this one is the exception because the
   * caller it guards against is a phase away rather than hypothetical.
   */
  for (const kind of ['BAS', 'REL', 'CHG'] as const) {
    for (const id of byKind.get(kind) ?? []) {
      if (!mintedDerivedIds.has(id)) continue;
      items.push({
        id,
        kind,
        summary: summaryForDerived(kind),
        sourceId: null,
        productId: null,
        observedAt: null,
        /*
         * For a derivation the knowledge time *is* the `as_of` it was computed for — the value
         * that participates in replay, which is why `EvidenceItem` documents it that way.
         */
        ingestedAt: asOf.toISOString(),
        url: null,
        resolvable: false,
      });
    }
  }

  return items.sort((left, right) => compare(left.id, right.id));
}

/**
 * The manifest for a response that mints no derived evidence of its own — a detail view.
 *
 * The same resolver the briefing uses, so an id resolves to the same entry wherever it is cited.
 */
export async function resolveEvidenceManifest(
  db: BuildSnapshotOptions['db'],
  asOf: Date,
  ids: readonly EvidenceId[],
  /** Content-addressed ids this response computed itself — a baseline's `EV:BAS:`, say. */
  minted: ReadonlySet<EvidenceId> = new Set(),
): Promise<EvidenceItem[]> {
  return await resolveManifest(db, asOf, [...new Set(ids)], minted);
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

export function toAttribution(row: AttributionRow): Attribution {
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
