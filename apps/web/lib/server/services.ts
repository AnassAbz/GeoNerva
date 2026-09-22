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

import {
  buildBriefing,
  buildEventDetail,
  buildFireClusterDetail,
  buildMapFeatures,
  replayHorizonFor,
  type BriefingBuild,
} from '@geonerva/briefing';
import {
  attributionsFor,
  clusterEvidenceAsOf,
  correlationEvidenceAsOf,
  evidenceItemsAsOf,
  healthAsOf,
  observationEvidenceAsOf,
  placeByGeonameId,
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
  familyOf,
  formatCoordinateKey,
  hazardTypeOfPublicId,
  parseEvidenceId,
  roundUserCoordinate,
  tryParseEvidenceId,
  type ChangeWindow,
  type EvidenceDetail,
  type EvidenceDetailPayload,
  type EventDetail,
  type EvidenceId,
  type FireClusterDetail,
  type HazardFamily,
  type LocationBriefing,
  type LocationRef,
  type MapFeaturesResponse,
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
import type { LocationParam, ViewportParam } from './params.ts';
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
     * At **error** level, and naming the kinds.
     *
     * This is an invariant I9 violation shipping to a caller: the response carries a citation its
     * own manifest does not contain. `strictManifest: false` is still the right trade — a user
     * should not get a 500 because one footnote is unreadable, and the `EV:FDS` hole at G7 showed
     * that failing loudly in development is what finds these — but logging it at `warn` with only
     * a count made a contract violation indistinguishable from a slow request.
     *
     * The *kinds* are logged, not the ids: a kind says which resolver is broken, which is the
     * actionable part, while the ids are internal and would invite enumeration of the evidence
     * space. The response is unchanged, because dropping a citation would silently remove the
     * provenance of a claim the user can see.
     */
    logEvent('error', 'api.briefing.unresolved_evidence', {
      count: build.unresolvedEvidenceIds.length,
      kinds: [...new Set(build.unresolvedEvidenceIds.map((id) => id.split(':')[1] ?? 'UNKNOWN'))]
        .sort()
        .join(','),
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
 * `EV:FDS` is the case G7 found the hard way — a real kind that nothing resolved, which broke every
 * briefing for a location with fire activity. It is resolved *in a manifest*, by
 * `resolveManifest` in `packages/briefing`, through the cluster version it summarizes. **This
 * endpoint refuses it**, with an explanation pointing at that cluster version: the detection set
 * has no row of its own, so there is nothing to serve. An earlier version of this comment claimed
 * the opposite of the code fifteen lines below it.
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
 * A named place needs the `places` table, which `pnpm geonames:import` populates. A `p:` key
 * that is not in it resolves to `LOCATION_NOT_FOUND` rather than to a guess. Returning a placeholder label with real coordinates would be worse than a 404: the
 * briefing would be correct about a location the user did not name.
 */
async function resolveLocation(db: Kysely, location: LocationParam): Promise<LocationRef> {
  /*
   * A `c:` key is a coordinate pair, not a place: it is the exact form `formatCoordinateKey` mints
   * for the coordinate path, so `?place=c:31.63,-8.00` asks the same question as
   * `?lat=31.63&lon=-8.00`. It used to fall through to the place lookup and come back
   * `LOCATION_NOT_FOUND` blaming a missing GeoNames import, which was the wrong reason for a
   * request that needs no `places` table at all.
   */
  const asCoordinates = location.kind === 'key' ? parseCoordinateKey(location.key) : null;
  if (asCoordinates !== null) {
    return resolveLocation(db, asCoordinates);
  }

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
        'GeoNerva holds no place with that id. Place ids come from /api/v1/places/suggest, which reads the GeoNames table this deployment has loaded.',
    });
  }
  return place;
}

/**
 * A `c:<lat>,<lon>` key as a coordinate parameter, or `null` when it is not one.
 *
 * The pattern is the canonical form and nothing looser: exactly two decimals, which is what
 * `formatCoordinateKey` produces and what invariant I15 requires. A key with more precision is not
 * a key GeoNerva mints, so it is not accepted here either.
 */
function parseCoordinateKey(key: string): LocationParam | null {
  const parsed = /^c:(-?\d{1,3}\.\d{2}),(-?\d{1,3}\.\d{2})$/u.exec(key);
  if (parsed?.[1] === undefined || parsed[2] === undefined) return null;

  const lat = Number(parsed[1]);
  const lon = Number(parsed[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { kind: 'coordinates', lat, lon };
}

/** Reads one place. Returns `null` when the table is empty or the id is unknown. */
async function lookupPlace(db: Kysely, key: string): Promise<LocationRef | null> {
  const parsed = /^p:(\d+)$/u.exec(key);
  if (parsed?.[1] === undefined) return null;
  const row = await placeByGeonameId(db, Number(parsed[1]));
  if (row === null) return null;
  return {
    key,
    label: row.name,
    /*
     * A named place is a public place, not personal data (ADR-015) — but its coordinates are still
     * rounded to the API's two decimals so that every `LocationRef` in a response satisfies I15
     * uniformly, and so that `buildPacket`'s rounding assertion holds for every location kind.
     */
    lat: roundUserCoordinate(row.lat),
    lon: roundUserCoordinate(row.lon),
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

export interface EventsRequest {
  readonly viewport: ViewportParam;
  readonly families: readonly HazardFamily[];
  readonly asOf: Date;
  readonly now: Date;
}

/**
 * `GET /api/v1/events`.
 *
 * The map is assembled by `buildMapFeatures` in `@geonerva/briefing`, beside the snapshot whose
 * subjects it draws, so that a map and a briefing cannot describe one earthquake two ways.
 */
export async function getEvents(db: Kysely, request: EventsRequest): Promise<MapFeaturesResponse> {
  assertFamiliesWithinHorizon(request.asOf, request.now, request.families);
  return await buildMapFeatures({
    db,
    bbox: request.viewport.bbox,
    zoom: request.viewport.zoom,
    families: request.families,
    asOf: request.asOf,
    retentionProfile: RETENTION_PROFILE,
  });
}

export interface DetailRequest {
  readonly publicId: string;
  readonly asOf: Date;
  readonly now: Date;
  /** Only `/events/{publicId}` takes one (§13.1); it adds relevance and distance. */
  readonly location: LocationParam | null;
}

/** A detail, or the survivor a merged id now redirects to. */
export type DetailOutcome<T> =
  | { readonly kind: 'found'; readonly detail: T }
  | { readonly kind: 'redirect'; readonly publicId: string };

/**
 * `GET /api/v1/events/{publicId}`.
 *
 * The horizon is checked **before** the read, from the family the id itself names. After retention
 * has dropped an event's facts the read would find nothing, and answering "not found" would be the
 * empty result ADR-035 forbids: the event existed, GeoNerva no longer remembers it.
 */
export async function getEventDetail(
  db: Kysely,
  request: DetailRequest,
): Promise<DetailOutcome<EventDetail>> {
  assertFamiliesWithinHorizon(request.asOf, request.now, [familyOfPublicId(request.publicId)]);
  const location = request.location === null ? null : await resolveLocation(db, request.location);
  const result = await buildEventDetail({
    db,
    publicId: request.publicId,
    asOf: request.asOf,
    location,
    retentionProfile: RETENTION_PROFILE,
  });
  switch (result.kind) {
    case 'found':
      return { kind: 'found', detail: result.detail };
    case 'merged':
      return { kind: 'redirect', publicId: result.survivorPublicId };
    case 'not_found':
      throw new ApiProblemError({
        code: 'NOT_FOUND',
        detail:
          result.reason === 'NO_MEMBERS'
            ? 'That event has no source records at this knowledge time.'
            : 'GeoNerva holds no event with that identifier at this knowledge time.',
      });
  }
}

/** `GET /api/v1/fire-clusters/{publicId}`. The horizon rule is the event detail's. */
export async function getFireClusterDetail(
  db: Kysely,
  request: DetailRequest,
): Promise<DetailOutcome<FireClusterDetail>> {
  assertFamiliesWithinHorizon(request.asOf, request.now, [familyOfPublicId(request.publicId)]);
  const location = request.location === null ? null : await resolveLocation(db, request.location);
  const result = await buildFireClusterDetail({
    db,
    publicId: request.publicId,
    asOf: request.asOf,
    location,
    retentionProfile: RETENTION_PROFILE,
  });
  switch (result.kind) {
    case 'found':
      return { kind: 'found', detail: result.detail };
    case 'merged':
      return { kind: 'redirect', publicId: result.survivorPublicId };
    case 'not_found':
      throw new ApiProblemError({
        code: 'NOT_FOUND',
        detail:
          result.reason === 'NO_SUMMARY'
            ? 'That fire cluster has no summary computed at this knowledge time.'
            : 'GeoNerva holds no fire cluster with that identifier at this knowledge time.',
      });
  }
}

/**
 * The family a public id names. The id is already shape-checked by `parsePublicId`, so a `null`
 * here is a programming error rather than a caller's.
 */
function familyOfPublicId(publicId: string): HazardFamily {
  const hazardType = hazardTypeOfPublicId(publicId);
  if (hazardType === null) throw new Error('familyOfPublicId: not a public id');
  return familyOf(hazardType);
}

/**
 * Refuses a knowledge time that is beyond the horizon of **any** requested family.
 *
 * Stricter than the briefing's guard, and for a reason. A briefing can carry a family it no longer
 * remembers — the card says `UNAVAILABLE` with `BEYOND_REPLAY_HORIZON` — so it refuses only when
 * *every* family is gone. A map has no per-family field to say it with: `MapFeaturesResponse` is a
 * list of features, and a family whose data retention has dropped would simply be absent from it,
 * which reads as "nothing was burning". ADR-035's rule is that retention loss is reported, never
 * rendered as an empty result, so the map refuses and names the families; a caller who wants the
 * rest asks again without them. That is also the frozen code's own definition: "`as_of` is earlier
 * than the replay horizon for a requested family".
 */
function assertFamiliesWithinHorizon(
  asOf: Date,
  now: Date,
  families: readonly HazardFamily[],
): void {
  const horizon = replayHorizonFor(RETENTION_PROFILE, now);
  const beyond = families.filter(
    (family) => asOf.getTime() < Date.parse(horizon.byFamily[family].earliestAsOf),
  );
  if (beyond.length === 0) return;

  const earliest = beyond
    .map((family) => Date.parse(horizon.byFamily[family].earliestAsOf))
    .reduce((left, right) => Math.max(left, right));

  throw new ApiProblemError({
    code: 'AS_OF_BEFORE_HORIZON',
    detail:
      'That time is outside the window GeoNerva still holds data for, for at least one requested hazard type. This is a retention limit, not an absence of hazards.',
    earliestAsOf: new Date(earliest).toISOString(),
    affectedFamilies: beyond,
  });
}

/** Re-exported for the adapters, so a handler never constructs an evidence id by hand. */
export { parseEvidenceId };
export type { EvidenceId };
