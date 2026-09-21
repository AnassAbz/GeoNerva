/**
 * The application-service boundary (ARCHITECTURE §13, IMPLEMENTATION_PLAN P8).
 *
 * ### The choice this file exists to make, and to document
 *
 * A Next.js server component can call `buildBriefing` directly, and a route handler can call it
 * over HTTP. Doing both without care produces **two interfaces to one capability**, which drift:
 * one validates `as_of` and the other does not, one rounds coordinates and the other forgets, and
 * the difference is invisible until a replay shows the present.
 *
 * So there is exactly one contract, and it is this module. Every function here takes an
 * **already-validated** request object and returns a read model. Route handlers under
 * `app/api/v1/**` are thin adapters: parse, call, serialize, attach cache headers. Server
 * components, when P9 builds them, call the *same* functions with the same validated objects
 * rather than fetching their own API over the loopback. HTTP is a transport for this contract, not
 * the contract itself.
 *
 * Two consequences worth stating:
 *
 *  - **Validation cannot be skipped by the in-process path.** The request types here are only
 *    constructible from `params.ts`, which is where §13.2's rules live. A server component that
 *    wanted to pass a raw string would have to go through the same parser.
 *  - **Nothing in this module knows about HTTP.** No `Response`, no headers, no status codes —
 *    those belong to the adapter. It throws `ApiProblemError` for domain-level refusals, which
 *    the adapter maps.
 *
 * ### What this module must never do
 *
 * It must not read a fact except through `@geonerva/db/asof`, must not recompute relevance,
 * correlation, agreement or baselines, must not reconstruct an evidence manifest, and must not
 * write its own wording for a deterministic briefing. Each of those exists exactly once, in a
 * package that was calibrated and mutation-tested, and this layer's job is to call it. The
 * dependency rules enforce the first of those mechanically; the rest are enforced by there being
 * no other implementation to call.
 */

import { buildBriefing, replayHorizonFor, type BriefingBuild } from '@geonerva/briefing';
import {
  attributionsFor,
  clusterEvidenceAsOf,
  correlationEvidenceAsOf,
  evidenceItemsAsOf,
  healthAsOf,
  observationEvidenceAsOf,
  runEvidenceAsOf,
  runSummariesAsOf,
  runTally24hAsOf,
  sourceCatalog,
  sourceCutoffsAsOf,
  workerHeartbeatAsOf,
  type Kysely,
} from './db.ts';
import {
  HAZARD_FAMILIES,
  READ_MODEL_SCHEMA_VERSION,
  formatCoordinateKey,
  parseEvidenceId,
  tryParseEvidenceId,
  type ChangeWindow,
  type EvidenceDetail,
  type EvidenceDetailPayload,
  type EvidenceId,
  type HazardFamily,
  type LocationBriefing,
  type LocationRef,
  type ReplayHorizonResponse,
  type SourceStatus,
} from '@geonerva/domain';

import { logEvent } from './log.ts';
import {
  buildEvidenceDetail,
  clusterPayload,
  correlationPayload,
  observationPayload,
  runPayload,
  toEvidenceItem,
} from './evidence-view.ts';
import type { LocationParam } from './params.ts';
import { ApiProblemError } from './problem.ts';
import { buildSourceStatus, evidenceIdsFor } from './source-status.ts';

/** The engine version every read model is stamped with. Bumped when relevance or copy changes. */
export const ENGINE_VERSION = 'geonerva-1';

/** The retention profile the deployment runs (ADR-035). `lean` is the v1 choice (owner Q2). */
export const RETENTION_PROFILE = 'lean' as const;

export interface BriefingRequest {
  readonly location: LocationParam;
  readonly window: ChangeWindow;
  readonly asOf: Date;
  readonly now: Date;
}

export interface BriefingResult {
  readonly briefing: LocationBriefing;
  /** True when `as_of` is far enough in the past to be cached as immutable. */
  readonly isReplay: boolean;
}

/**
 * `GET /api/v1/briefing`.
 *
 * The knowledge-time guard is here rather than in the parser because the horizon is **per family**
 * and comes from the retention profile: the parser can reject a future `as_of` without knowing
 * anything, but "before the horizon" needs ADR-035's table. A request past the horizon is
 * `AS_OF_BEFORE_HORIZON` with the earliest replayable time and the families affected — which is
 * ADR-035's own rule that retention loss must be *reported*, never rendered as an empty result.
 */
export async function getBriefing(db: Kysely, request: BriefingRequest): Promise<BriefingResult> {
  const location = await resolveLocation(db, request.location);
  assertWithinHorizon(request.asOf, request.now);

  const build: BriefingBuild = await buildBriefing({
    db,
    location,
    asOf: request.asOf,
    engineVersion: ENGINE_VERSION,
    window: request.window,
    generatedAt: request.now,
    retentionProfile: RETENTION_PROFILE,
    /*
     * The API degrades rather than failing when a citation cannot be resolved.
     *
     * `strictManifest` throwing is the right default for development and tests — it is what
     * surfaced the `EV:FDS` hole at G7 — but a user asking for a briefing should not get a 500
     * because one evidence row is unreadable. The unresolved ids are counted below and the
     * response still carries every claim; what it loses is a footnote.
     */
    strictManifest: false,
  });

  if (build.unresolvedEvidenceIds.length > 0) {
    /*
     * Logged, not returned. An unresolvable citation is a defect in GeoNerva, and the id is
     * internal — putting it in the response would invite enumeration of the evidence space for no
     * benefit to the caller.
     */
    logEvent('warn', 'api.briefing.unresolved_evidence', {
      count: build.unresolvedEvidenceIds.length,
      /* The rounded location key, which is a 1.1 km cell (ADR-015) — never the raw coordinates. */
      locationKey: location.key,
    });
  }

  return { briefing: build.briefing, isReplay: build.briefing.asOfContext.isReplay };
}

export interface EvidenceRequest {
  readonly id: string;
  readonly asOf: Date;
  readonly now: Date;
}

/**
 * `GET /api/v1/evidence/{id}`.
 *
 * Primary evidence only — `OBS`, `FCV`, `RUN`, `COR`. The content-addressed kinds (`BAS`, `REL`,
 * `CHG`) are self-contained in whichever manifest referenced them and have no row to resolve, so
 * asking for one is a `NOT_FOUND` rather than an error: there is nothing to serve, and saying so
 * is more useful than pretending the id was malformed.
 *
 * `EV:FDS` is the case G7 found the hard way. It is a real kind that nothing resolved, which broke
 * every briefing for a location with fire activity; it resolves here through its cluster version,
 * because the count travels in the id and what makes the citation trustworthy is that the version
 * it summarizes exists at this knowledge time.
 */
export async function getEvidence(db: Kysely, request: EvidenceRequest): Promise<EvidenceDetail> {
  const parsed = tryParseEvidenceId(request.id);
  if (parsed === null) {
    throw new ApiProblemError({
      code: 'VALIDATION_FAILED',
      detail: 'That is not a canonical GeoNerva evidence identifier.',
      invalidParams: [{ name: 'id', reason: 'must be a canonical evidence id, e.g. EV:OBS:41' }],
    });
  }

  if (parsed.kind === 'BAS' || parsed.kind === 'REL' || parsed.kind === 'CHG') {
    throw new ApiProblemError({
      code: 'NOT_FOUND',
      detail:
        'That evidence is a computation identified by the hash of its own inputs. It is carried in full inside the response that referenced it, and there is no separate record to fetch.',
    });
  }

  if (parsed.kind === 'FDS') {
    throw new ApiProblemError({
      code: 'NOT_FOUND',
      detail:
        'That evidence names the set of satellite detections behind a fire-cluster summary. The set has no record of its own; fetch the cluster version it belongs to, which carries the count.',
    });
  }

  const detail = await evidencePayload(db, parsed, request.asOf);
  if (detail === null) {
    throw new ApiProblemError({
      code: 'NOT_FOUND',
      detail: 'GeoNerva holds no evidence with that identifier at this knowledge time.',
    });
  }

  /*
   * The manifest entry comes from the same resolver every manifest uses, rather than being
   * assembled from the payload. The endpoint and the manifest must agree about an ID's summary and
   * its `resolvable` flag, and the cheapest way to guarantee that is for both to call one function.
   */
  const rows = await evidenceItemsAsOf(db, { asOf: request.asOf, ids: [request.id] });
  const row = rows[0];
  if (row === undefined) {
    throw new ApiProblemError({
      code: 'NOT_FOUND',
      detail: 'GeoNerva holds no evidence with that identifier at this knowledge time.',
    });
  }

  const attribution = row.source_id === null ? [] : await attributionsFor(db, [row.source_id]);

  return buildEvidenceDetail({ item: toEvidenceItem(row), detail, attribution });
}

/**
 * Reads the payload for one primary evidence kind.
 *
 * One query, chosen by kind. Every branch is bounded by `asOf` on the column that actually
 * participates in replay for that table — `ingested_at`, `as_of`, `committed_at`, `linked_at` —
 * which is why this is a switch over four reads rather than one clever join.
 */
async function evidencePayload(
  db: Kysely,
  ref: NonNullable<ReturnType<typeof tryParseEvidenceId>>,
  asOf: Date,
): Promise<EvidenceDetailPayload | null> {
  switch (ref.kind) {
    case 'OBS': {
      const row = await observationEvidenceAsOf(db, { asOf, versionId: ref.versionId });
      return row === null ? null : observationPayload(row);
    }
    case 'FCV': {
      const row = await clusterEvidenceAsOf(db, {
        asOf,
        clusterVersionId: ref.clusterVersionId,
      });
      return row === null ? null : clusterPayload(row);
    }
    case 'RUN': {
      const row = await runEvidenceAsOf(db, { asOf, runId: ref.runId });
      return row === null ? null : runPayload(row);
    }
    case 'COR': {
      const row = await correlationEvidenceAsOf(db, { asOf, linkId: ref.linkId });
      return row === null ? null : correlationPayload(row);
    }
    /*
     * Refused above, and spelled out rather than swept into a `default` so that adding a ninth
     * evidence kind is a type error here instead of a silent `NOT_FOUND`.
     */
    case 'FDS':
    case 'BAS':
    case 'REL':
    case 'CHG':
      return null;
  }
}

export interface SourceStatusRequest {
  readonly asOf: Date;
  readonly now: Date;
}

/**
 * `GET /api/v1/sources/status`.
 *
 * Health is **derived, never stored** (ADR-022), so this endpoint takes `as_of` for the same
 * reason a briefing does: asking what GeoNerva knew about a source at 12:10 is the same query at
 * a different knowledge time.
 */
export async function getSourceStatus(
  db: Kysely,
  request: SourceStatusRequest,
): Promise<SourceStatus> {
  /*
   * Six reads, issued together. They are independent — none needs another's result — so the
   * endpoint costs one round trip's latency rather than six, and the only sequential step is the
   * evidence resolution below, which genuinely needs the IDs the first five produced.
   */
  const [catalog, health, cutoffs, runs, tally, worker] = await Promise.all([
    sourceCatalog(db),
    healthAsOf(db, { asOf: request.asOf }),
    sourceCutoffsAsOf(db, request.asOf),
    runSummariesAsOf(db, { asOf: request.asOf, perSource: RECENT_RUNS_PER_SOURCE }),
    runTally24hAsOf(db, request.asOf),
    workerHeartbeatAsOf(db, request.asOf),
  ]);

  const evidence = await evidenceItemsAsOf(db, {
    asOf: request.asOf,
    ids: evidenceIdsFor({
      healthBySource: health.bySource.map((entry) => ({ ...entry, productCode: null })),
      healthByProduct: health.byProduct,
      runs,
    }),
  });

  const attribution = await attributionsFor(
    db,
    catalog.sources.map((source) => source.source_id),
  );

  return buildSourceStatus({
    asOf: request.asOf,
    generatedAt: request.now,
    /*
     * Decided from the same threshold the briefing uses, and against the request's own clock —
     * not `Date.now()`. A flag that depends on when in the handler it was read is a flag that can
     * disagree with the `Cache-Control` header computed from the same pair of times.
     */
    isReplay: request.now.getTime() - request.asOf.getTime() > REPLAY_FLAG_THRESHOLD_MS,
    horizon: replayHorizonFor(RETENTION_PROFILE, request.asOf),
    cutoffs,
    sources: catalog.sources,
    products: catalog.products,
    healthBySource: health.bySource.map((entry) => ({ ...entry, productCode: null })),
    healthByProduct: health.byProduct,
    runs,
    tally,
    worker,
    attribution,
    evidence,
  });
}

/**
 * How many runs each source reports.
 *
 * Ten is what `/data-status` shows, and the bound is not cosmetic: the response is cached at the
 * edge for sixty seconds, and an unbounded run list would make its size a function of how long
 * GeoNerva has been running. `runSummariesAsOf` caps it again at fifty on its own.
 */
const RECENT_RUNS_PER_SOURCE = 10;

/**
 * Five minutes, matching `buildSnapshot`'s threshold for `asOfContext.isReplay`.
 *
 * Deliberately **not** the one-hour threshold in `cache.ts`. They answer different questions:
 * `isReplay` states that the response describes a past knowledge time, while the cache threshold
 * decides when such a response is safe to call immutable. An answer five minutes old is a replay
 * and is still refreshed often; only past an hour is it frozen. Both numbers are in §13.1 and in
 * the snapshot, and this constant exists so the API cannot drift from the briefing.
 */
const REPLAY_FLAG_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * `GET /api/v1/replay/horizon`. Pure: the profile and the clock decide it (ADR-035).
 *
 * The frozen contract is `ReplayHorizonResponse` — the horizon *wrapped* with a schema version and
 * a generation time — not the bare `ReplayHorizon`. The wrapper is what makes the response
 * versionable like every other read model, and a client that pinned to the unwrapped shape would
 * break on the first change to either.
 */
export function getReplayHorizon(now: Date): ReplayHorizonResponse {
  return {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    horizon: replayHorizonFor(RETENTION_PROFILE, now),
  };
}

/**
 * Turns a validated location parameter into the `LocationRef` the read models carry.
 *
 * A coordinate pair is already rounded by the parser, so the key it produces is canonical and
 * `formatCoordinateKey` — which throws on an unrounded value — is the assertion that it was.
 *
 * A named place needs the `places` table, which the GeoNames import populates. That import is P8
 * task 2 and is not built, so a `p:` key currently resolves to `LOCATION_NOT_FOUND` rather than
 * to a guess. Returning a placeholder label with real coordinates would be worse than a 404: the
 * briefing would be correct about a location the user did not name.
 */
async function resolveLocation(db: Kysely, location: LocationParam): Promise<LocationRef> {
  if (location.kind === 'coordinates') {
    return {
      key: formatCoordinateKey({ lat: location.lat, lon: location.lon }),
      /*
       * The label for an ad-hoc coordinate is the rounded pair itself. It must not be reverse
       * geocoded here: that is `/places/reverse`, it costs a Nominatim call, and a briefing is not
       * the place to spend one.
       */
      label: `${location.lat.toFixed(2)}, ${location.lon.toFixed(2)}`,
      lat: location.lat,
      lon: location.lon,
      timezone: 'UTC',
      countryCode: null,
      admin1: null,
    };
  }

  const place = await lookupPlace(db, location.key);
  if (place === null) {
    throw new ApiProblemError({
      code: 'LOCATION_NOT_FOUND',
      detail:
        'GeoNerva does not hold that place. The place table is populated by the GeoNames import, which is not yet part of this deployment.',
    });
  }
  return place;
}

/** Reads one place. Returns `null` when the table is empty or the id is unknown. */
async function lookupPlace(db: Kysely, key: string): Promise<LocationRef | null> {
  const parsed = /^p:(\d+)$/u.exec(key);
  if (parsed?.[1] === undefined) return null;
  const rows = await db
    .withSchema('geonerva')
    .selectFrom('places')
    .select(['geonameid', 'name', 'lat', 'lon', 'timezone', 'country_code', 'admin1'])
    .where('geonameid', '=', Number(parsed[1]))
    .limit(1)
    .execute();

  const row = rows[0];
  if (row === undefined) return null;
  return {
    key,
    label: row.name,
    /*
     * A named place is a public place, not personal data (ADR-015) — but its coordinates are still
     * rounded to the API's two decimals so that every `LocationRef` in a response satisfies I15
     * uniformly, and so that `buildPacket`'s rounding assertion holds for every location kind.
     */
    lat: Math.round(row.lat * 100) / 100,
    lon: Math.round(row.lon * 100) / 100,
    timezone: row.timezone,
    countryCode: row.country_code,
    admin1: row.admin1,
  };
}

/**
 * Refuses a knowledge time older than the retention profile can answer for.
 *
 * ADR-035 is explicit that retention loss "must be reported as *outside the indexed window*, never
 * as an empty result". `buildSnapshot` already reports it per family through availability; this
 * refuses the request outright when **every** family is past its horizon, because at that point
 * there is no briefing to serve and a document of six unavailable cards is a worse answer than a
 * 400 that names the earliest time the caller can ask for.
 */
function assertWithinHorizon(asOf: Date, now: Date): void {
  const horizon = replayHorizonFor(RETENTION_PROFILE, now);
  const beyond: HazardFamily[] = HAZARD_FAMILIES.filter(
    (family) => asOf.getTime() < Date.parse(horizon.byFamily[family].earliestAsOf),
  );
  if (beyond.length < HAZARD_FAMILIES.length) return;

  const earliest = HAZARD_FAMILIES.map((family) =>
    Date.parse(horizon.byFamily[family].earliestAsOf),
  ).reduce((left, right) => Math.min(left, right));

  throw new ApiProblemError({
    code: 'AS_OF_BEFORE_HORIZON',
    detail:
      'That time is outside the window GeoNerva still holds data for. This is a retention limit, not an absence of hazards.',
    earliestAsOf: new Date(earliest).toISOString(),
    affectedFamilies: beyond,
  });
}

/** Re-exported for the adapters, so a handler never constructs an evidence id by hand. */
export { parseEvidenceId };
export type { EvidenceId };
