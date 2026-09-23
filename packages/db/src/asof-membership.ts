/**
 * Cluster membership at a knowledge time (ADR-039).
 *
 * Its own module because both `asof.ts` and `asof-detail.ts` resolve membership and importing one
 * from the other is a cycle. It holds no query of its own: the SQL fragments below are the only
 * place the rules live, so that every read of who belonged to a cluster uses the same two facts
 * and cannot drift into using the mutable column they replaced.
 *
 * ### The two facts
 *
 *  - `fire_detections.cluster_assigned_at` — when the clustering run that assigned the detection
 *    committed. A detection assigned after the knowledge time had no cluster then, which is a
 *    different thing from having none at all; a `NULL` predates migration 0020, is unknowable, and
 *    is excluded rather than guessed.
 *  - `merged_at` on the absorbed cluster — a merge known by then is applied and a later one is
 *    not, so a replay of a moment before a merge still shows the two areas of activity GeoNerva
 *    was showing then.
 *
 * ### The walk, and why it is driven by the target
 *
 * The recursion goes **backwards**: it seeds on the cluster asked about, if it is still its own
 * survivor at that moment, and collects what had been absorbed into it by then. A cluster already
 * merged away seeds nothing, which matches the reads that skip it — the list read filters
 * `merged_at IS NULL OR merged_at > T`, the detail read redirects to the survivor — so one set of
 * detections is never answered for twice.
 *
 * Seeding **from the target** rather than from every surviving cluster is not only narrower, it is
 * the difference between an index scan and a sequential one. PostgreSQL cannot push a predicate
 * into a recursive CTE, so a walk seeded from `fire_clusters` with the target filtered afterwards
 * forces a hash join against every retained `fire_detections` partition — about 438,000 rows on
 * the documented profile, on every dashboard request. Driving from a one-row CTE keeps the plan a
 * nested loop over `fire_detections_membership_idx`. Measured, not assumed.
 */

import { sql } from 'kysely';

/**
 * The `WITH RECURSIVE` prefix for a read about **one** cluster at one knowledge time.
 *
 * Emits two relations for the query that follows: `target(id)`, the one row to drive from, and
 * `lineage(target_id, cluster_id)`, the clusters whose detections count as the target's. Use it
 * as the head of the statement and join in that order:
 *
 * ```sql
 * ${clusterLineageAsOf(id, asOf)}
 * SELECT …
 * FROM target t
 * JOIN lineage l ON l.target_id = t.id
 * JOIN geonerva.fire_detections d ON d.cluster_id = l.cluster_id
 * WHERE d.cluster_assigned_at IS NOT NULL AND d.cluster_assigned_at <= ${asOf}
 * ```
 */
export function clusterLineageAsOf(clusterId: string, asOf: Date) {
  return sql`
    WITH RECURSIVE target AS (SELECT ${clusterId}::uuid AS id),
    lineage(target_id, cluster_id) AS (
      SELECT c.id, c.id
      FROM geonerva.fire_clusters c
      JOIN target t ON t.id = c.id
      WHERE c.merged_into IS NULL OR c.merged_at IS NULL OR c.merged_at > ${asOf}
      UNION ALL
      SELECT l.target_id, c.id
      FROM lineage l
      JOIN geonerva.fire_clusters c
        ON c.merged_into = l.cluster_id
       AND c.merged_at IS NOT NULL
       AND c.merged_at <= ${asOf}
    )
  `;
}

/**
 * The same walk for a **batch**, where each requested cluster carries its own knowledge time.
 *
 * Seeds from a `wanted(cluster_id, known_at, …)` relation the caller has already declared, so the
 * two forms cannot disagree: the survivor test is the same test, read against each row's own
 * `known_at` instead of one shared `asOf`. Emits `lineage(target_id, known_at, cluster_id)`.
 *
 * The survivor test in the base case is load-bearing twice over. It keeps a cluster that had
 * already been absorbed by its own `known_at` from answering for detections its survivor also
 * answers for — in a batch, both rows could otherwise come back claiming the same detections — and
 * it is what makes a merge cycle terminate: two clusters merged into each other seed nothing, so
 * the walk returns no rows instead of running until the statement timeout.
 */
export function clusterLineageForWanted() {
  return sql`
    SELECT w.cluster_id, w.known_at, w.cluster_id
    FROM wanted w
    JOIN geonerva.fire_clusters c ON c.id = w.cluster_id
    WHERE c.merged_into IS NULL OR c.merged_at IS NULL OR c.merged_at > w.known_at
    UNION ALL
    SELECT l.target_id, l.known_at, c.id
    FROM lineage l
    JOIN geonerva.fire_clusters c
      ON c.merged_into = l.cluster_id
     AND c.merged_at IS NOT NULL
     AND c.merged_at <= l.known_at
  `;
}
