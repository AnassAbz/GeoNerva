/**
 * Fire clustering: turning thermal detections into areas of activity (ARCHITECTURE §7.4).
 *
 * The algorithm itself is not decided here — §7.4 and ADR-011 settled it, and `singleLinkage` in
 * `@geonerva/geo` implements the geometry. What this file owns is **identity over time**: which
 * connected component is which cluster, when a membership became true, and what a merge means.
 * All of that is bitemporal bookkeeping, and all of it is where the subtle mistakes live.
 *
 * ### Why already-assigned detections are read back
 *
 * The clustering is *incremental*: a new pixel must be able to see the cluster its neighbours are
 * already in. Reading only unassigned rows would open a fresh cluster beside every existing fire on
 * every pass — the same fire, a new public id each run, and a cluster page whose history restarted
 * every minute. So the working set is every detection in the window, assigned or not, and the
 * component's existing cluster ids are what carry identity forward.
 *
 * ### Three rules that keep a replay honest (ADR-039)
 *
 *  1. **An assignment carries its knowledge time.** `cluster_assigned_at` is the run's own `as_of`,
 *     so a replay of a moment before this run sees the detection in no cluster — which is what
 *     GeoNerva actually knew then.
 *  2. **A merge never re-points a detection.** It is recorded on the absorbed cluster and resolved
 *     at read time, so a replay from before the merge still shows the two areas of activity that
 *     were on the page at the time.
 *  3. **A detection is assigned once.** `assignDetectionsToCluster` updates only rows where
 *     `cluster_id IS NULL`, so a second run, a concurrent run, or a retry cannot move history.
 *
 * ### Why the oldest cluster survives a merge
 *
 * Because its public id is the one a reader may already have open, and its history is the longer
 * one. Ties break on the id itself, so the choice cannot depend on row order.
 */

import { createHash, randomUUID } from 'node:crypto';

import {
  assignDetectionsToCluster,
  buildClusterHull,
  clusterDetectionStatsAsOf,
  clusterIdentities,
  createCluster,
  detectionsForClustering,
  finishAnalysisRun,
  generateFireClusterPublicId,
  insertClusterVersionIfChanged,
  mergeClusters,
  startAnalysisRun,
  type DB,
} from '@geonerva/db';
import { singleLinkage, type LinkablePoint } from '@geonerva/geo';
import { sql, type Kysely } from 'kysely';

/**
 * The algorithm's identity, recorded on every analysis run.
 *
 * It changes when the *partition* would change — epsilon, the time window, the linkage rule — so
 * that a cluster summary can always be traced to the rules that produced it.
 */
export const FIRE_CLUSTER_ALGORITHM_VERSION = 'fire-cluster-1';

/** ARCHITECTURE §7.4. Two detections link within 1.5 km and 48 h of each other. */
export const CLUSTER_EPSILON_M = 1_500;
export const CLUSTER_MAX_DELTA_MS = 48 * 60 * 60 * 1000;
export const CLUSTER_CELL_DEGREES = 0.02;

/** §7.4's working set: the last 72 hours of detections. */
export const CLUSTER_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * The storage lifecycle (DOMAIN_MODEL §4.10), which is **not** the relevance model's vocabulary.
 *
 * `fireClusterState` in `@geonerva/relevance` answers a user-facing question and calls the third
 * state `DORMANT`; `fire_clusters.status` is the record's own lifecycle and calls it `INACTIVE`.
 * The hours are the same because they describe the same satellite behaviour, but the words are not
 * interchangeable and neither package may import the other's.
 */
const ACTIVE_HOURS = 24;
const COOLING_HOURS = 72;

/**
 * How many detections one run will consider.
 *
 * A global 72-hour window is roughly 400k rows at current FIRMS volumes. The cap is well above
 * that so it never bites in normal operation, and it exists only so that a runaway backfill cannot
 * pull an unbounded result set into the worker's heap. When it *does* bite the run says so rather
 * than quietly clustering a fragment.
 */
export const CLUSTER_DETECTION_LIMIT = 1_000_000;

export interface ClusterFireOptions {
  /** The run's knowledge time. Every assignment and merge is stamped with it. */
  readonly asOf?: Date;
  readonly windowMs?: number;
  readonly limit?: number;
}

export interface ClusterFireResult {
  readonly runId: string;
  readonly considered: number;
  readonly assigned: number;
  readonly clustersCreated: number;
  readonly clustersMerged: number;
  readonly versionsWritten: number;
  /** True when the detection cap bit, so the working set was a fragment of the window. */
  readonly capped: boolean;
}

function statusFor(lastDetectedAt: Date, asOf: Date): 'ACTIVE' | 'COOLING' | 'INACTIVE' {
  const hours = (asOf.getTime() - lastDetectedAt.getTime()) / (60 * 60 * 1000);
  if (hours <= ACTIVE_HOURS) return 'ACTIVE';
  if (hours <= COOLING_HOURS) return 'COOLING';
  return 'INACTIVE';
}

/**
 * The content hash that decides whether a summary is new.
 *
 * Every field the version states is in it, in a fixed order, so that "this cluster changed" means
 * the summary changed rather than that a run happened. Dates are ISO strings and numbers are
 * stringified, because a hash over a JSON object would depend on key order.
 */
function summaryHash(parts: readonly (string | number | null)[]): Buffer {
  return createHash('sha256')
    .update(parts.map((part) => String(part)).join('\u0000'), 'utf8')
    .digest();
}

/**
 * Resolves each cluster to the cluster it has been merged into, following the chain to its end.
 *
 * A component can easily contain detections from two clusters that were already merged into a
 * third by an earlier run; treating them as distinct survivors would try to merge a cluster into
 * itself, which `mergeClusters` guards against but which would also mean this run had miscounted
 * what it was looking at.
 */
function survivorOf(clusterId: string, mergedInto: ReadonlyMap<string, string | null>): string {
  const seen = new Set<string>();
  let current = clusterId;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const next = mergedInto.get(current);
    if (next === null || next === undefined) return current;
    current = next;
  }
}

/**
 * One clustering pass over the window.
 *
 * Idempotent by construction: the partition is a function of the detections, assignment only
 * touches unassigned rows, a merge is refused when either side has already merged, and a version
 * is written only when its content hash is new. Running it twice over unchanged data does nothing
 * the second time.
 */
export async function clusterFireDetections(
  db: Kysely<DB>,
  options: ClusterFireOptions = {},
): Promise<ClusterFireResult> {
  const asOf = options.asOf ?? new Date();
  const windowMs = options.windowMs ?? CLUSTER_WINDOW_MS;
  const limit = options.limit ?? CLUSTER_DETECTION_LIMIT;

  const runId = await startAnalysisRun(db, {
    kind: 'CLUSTERING',
    asOf,
    engineVersion: FIRE_CLUSTER_ALGORITHM_VERSION,
    startedAt: new Date(),
  });

  const stats = {
    considered: 0,
    assigned: 0,
    clustersCreated: 0,
    clustersMerged: 0,
    versionsWritten: 0,
  };
  let capped = false;

  try {
    const detections = await detectionsForClustering(db, {
      asOf,
      acquiredAfter: new Date(asOf.getTime() - windowMs),
      limit,
    });
    stats.considered = detections.length;
    capped = detections.length >= limit;

    if (detections.length > 0) {
      const points: LinkablePoint[] = detections.map((detection) => ({
        id: detection.id,
        lat: detection.lat,
        lon: detection.lon,
        atMs: detection.acquiredAt.getTime(),
      }));
      const components = singleLinkage(points, {
        epsilonMeters: CLUSTER_EPSILON_M,
        maxDeltaMs: CLUSTER_MAX_DELTA_MS,
        cellDegrees: CLUSTER_CELL_DEGREES,
      });

      const byId = new Map(detections.map((detection) => [detection.id, detection]));

      /*
       * Every cluster mentioned by the working set, read once. The merge chains matter: a
       * component may hold detections from clusters that an earlier run already merged.
       */
      const mentioned = [
        ...new Set(
          detections
            .map((detection) => detection.clusterId)
            .filter((id): id is string => id !== null),
        ),
      ];
      const identities = await clusterIdentities(db, mentioned);
      const mergedInto = new Map(identities.map((row) => [row.id, row.mergedInto]));
      const createdAt = new Map(identities.map((row) => [row.id, row.createdAt]));

      /*
       * Clusters whose summary this run must rewrite, in a stable order.
       *
       * A `Set` alongside the array rather than `touched.includes(...)`: a global pass over one
       * sensor's daily file produces tens of thousands of components, and a linear membership
       * check inside that loop is quadratic — the kind of cost that is invisible in a test with
       * three detections and dominates the run with ninety thousand.
       */
      const touched: string[] = [];
      const touchedSet = new Set<string>();
      const markTouched = (clusterId: string): void => {
        if (touchedSet.has(clusterId)) return;
        touchedSet.add(clusterId);
        touched.push(clusterId);
      };

      for (const component of components) {
        const members = component
          .map((id) => byId.get(id))
          .filter(
            (detection): detection is NonNullable<typeof detection> => detection !== undefined,
          );
        if (members.length === 0) continue;

        const unassigned = members.filter((member) => member.clusterId === null).map((m) => m.id);
        const survivors = [
          ...new Set(
            members.flatMap((member) =>
              member.clusterId === null ? [] : [survivorOf(member.clusterId, mergedInto)],
            ),
          ),
        ];

        if (survivors.length === 0) {
          /*
           * A component of entirely new detections: a new area of activity. `createdAt` is the
           * run's knowledge time, which is what makes "the oldest cluster survives" a comparison
           * between knowledge times rather than between wall clocks.
           */
          const clusterId = randomUUID();
          await createCluster(db, {
            id: clusterId,
            publicId: generateFireClusterPublicId(asOf),
            createdAt: asOf,
            status: 'ACTIVE',
          });
          stats.clustersCreated += 1;
          stats.assigned += await assignDetectionsToCluster(db, clusterId, unassigned, asOf);
          markTouched(clusterId);
          continue;
        }

        /*
         * The survivor is the oldest, with the id as the tiebreak so that two clusters created in
         * the same run cannot have their fate decided by row order.
         */
        const ordered = [...survivors].sort((left, right) => {
          const leftAt = createdAt.get(left)?.getTime() ?? 0;
          const rightAt = createdAt.get(right)?.getTime() ?? 0;
          return leftAt - rightAt || (left < right ? -1 : left > right ? 1 : 0);
        });
        const survivor = ordered[0];
        if (survivor === undefined) continue;
        const absorbed = ordered.slice(1);

        if (absorbed.length > 0) {
          await db.transaction().execute(async (trx) => {
            stats.clustersMerged += await mergeClusters(trx, survivor, absorbed, asOf);
          });
          /*
           * The chain is updated in memory too, so a later component in this same run resolves
           * these ids to the survivor rather than to a cluster that no longer leads anywhere.
           */
          for (const id of absorbed) mergedInto.set(id, survivor);
          /*
           * The absorbed clusters get **no new version**, and that is not an oversight.
           *
           * Their membership now resolves through the survivor's lineage, so a summary written for
           * one at this knowledge time would have no detections to describe — `buildClusterHull`
           * says so by throwing. What they keep is the version they already had, which is exactly
           * what a replay of a moment before the merge must show. `mergeClusters` has already set
           * their head to MERGED; the history stands untouched beneath it.
           */
        }

        stats.assigned += await assignDetectionsToCluster(db, survivor, unassigned, asOf);
        markTouched(survivor);
      }

      for (const clusterId of touched) {
        const written = await writeClusterVersion(db, clusterId, asOf, runId);
        if (written) stats.versionsWritten += 1;
      }
    }

    await finishAnalysisRun(db, { id: runId, status: 'SUCCEEDED', stats: { ...stats } });
  } catch (error) {
    await finishAnalysisRun(db, {
      id: runId,
      status: 'FAILED',
      stats: { ...stats },
      errorClass: 'INTERNAL',
    });
    throw error;
  }

  return { runId, ...stats, capped };
}

/**
 * Writes one cluster's summary, if it changed.
 *
 * Both halves resolve membership through the merge lineage at `asOf`, so the hull, the counts and
 * the read paths cannot disagree about which detections belong to this cluster.
 */
async function writeClusterVersion(
  db: Kysely<DB>,
  clusterId: string,
  asOf: Date,
  runId: string,
): Promise<boolean> {
  /*
   * The stats are read **before** the hull, not alongside it. A cluster with no members visible at
   * this knowledge time has nothing to summarise, and `buildClusterHull` reports that by throwing;
   * running both at once would turn a legitimately empty cluster into a failed clustering run.
   */
  const stats = await clusterDetectionStatsAsOf(db, clusterId, asOf);
  if (stats.firstDetectedAt === null || stats.lastDetectedAt === null || stats.nTotal === 0) {
    return false;
  }
  const hull = await buildClusterHull(db, clusterId, asOf);

  const centroid = JSON.parse(hull.centroidGeoJson) as { coordinates: [number, number] };
  const hullGeoJson = hull.hullGeoJson === null ? null : (JSON.parse(hull.hullGeoJson) as unknown);
  const status = statusFor(stats.lastDetectedAt, asOf);

  const result = await insertClusterVersionIfChanged(db, {
    clusterId,
    analysisRunId: runId,
    asOf,
    nTotal: stats.nTotal,
    n24h: stats.n24h,
    overpasses24h: stats.overpasses24h,
    firstDetectedAt: stats.firstDetectedAt,
    lastDetectedAt: stats.lastDetectedAt,
    frpSum24h: stats.frpSum24h,
    frpMax: stats.frpMax,
    maxConfidence: stats.maxConfidence,
    productIds: stats.productIds,
    hullGeoJson,
    centroid: { lat: centroid.coordinates[1], lon: centroid.coordinates[0] },
    contentSha256: summaryHash([
      stats.nTotal,
      stats.n24h,
      stats.overpasses24h,
      stats.firstDetectedAt.toISOString(),
      stats.lastDetectedAt.toISOString(),
      stats.frpSum24h,
      stats.frpMax,
      stats.maxConfidence,
      stats.productIds.join(','),
      status,
      hull.hullGeoJson,
      hull.centroidGeoJson,
    ]),
    status,
  });
  return result.inserted;
}

/** The gate's other half: is there an unassigned detection this run could actually place? */
export async function hasUnclusteredDetections(
  db: Kysely<DB>,
  asOf: Date,
  windowMs = CLUSTER_WINDOW_MS,
): Promise<boolean> {
  const result = await sql<{ present: number }>`
    SELECT 1 AS present
    FROM geonerva.fire_detections d
    WHERE d.cluster_id IS NULL
      AND d.ingested_at <= ${asOf}
      AND d.acquired_at >= ${new Date(asOf.getTime() - windowMs)}
      AND d.acquired_at <= ${asOf}
    LIMIT 1
  `.execute(db);
  return result.rows.length > 0;
}
