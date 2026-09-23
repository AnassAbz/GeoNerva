-- 0020 — a detection's cluster membership becomes knowable as of a time (ADR-039, accepted
-- 2026-09-23).
--
-- The owner's decision: "A historical replay at time T must not recompute fire clusters,
-- aggregates, or historical values using information, cluster membership, algorithms, or derived
-- state that became available after T." Membership was the one input that could not honour that.
--
-- `fire_detections.cluster_id` was written in place twice: once at assignment, with no record of
-- when, and again on merge, which erased where a detection had been before. So at a knowledge time
-- T in the past GeoNerva could not say whether a detection belonged to a cluster yet, or to which
-- one — and reading the column would have shown a replay the membership as it is *now*, which is
-- the leak invariant I2 exists to prevent.
--
-- Two changes make it a bitemporal fact instead:
--
--  * `cluster_assigned_at` records when the assignment became true — the clustering run's `as_of`.
--    A detection whose assignment is later than T had no cluster at T, which is a different thing
--    from having no cluster at all.
--  * A merge no longer rewrites `cluster_id`. It is already recorded on the absorbed cluster row
--    (`merged_into`, `merged_at`), so a read at T follows that chain for merges known by T and
--    stops. Before the merge the two areas of activity are still two, which is what a replay of
--    that moment should show.
--
-- `NULL` is deliberate and load-bearing: a detection assigned before this migration has a cluster
-- and no knowledge time for it, so its membership is unknowable at *any* past T and the as-of reads
-- exclude it. That withholds rather than guesses. The alternative — backfilling from the cluster
-- version that first counted each detection — would invent a timestamp GeoNerva never observed,
-- and this deployment has no history worth inventing for: the column is populated from the next
-- clustering run onward.

ALTER TABLE geonerva.fire_detections
  ADD COLUMN cluster_assigned_at timestamptz;

COMMENT ON COLUMN geonerva.fire_detections.cluster_assigned_at IS
  'When this detection''s cluster assignment became true (the clustering run''s as_of). NULL means
   the assignment predates migration 0020 and its knowledge time is unknown, so as-of reads exclude
   it rather than assume one (ADR-039).';

-- An assignment without its time, or a time without an assignment, is not a fact anything can
-- read. `NOT VALID` so the migration does not fail on rows written before the column existed;
-- every row written after it is checked.
ALTER TABLE geonerva.fire_detections
  ADD CONSTRAINT fire_detections_assignment_time_check
  CHECK ((cluster_id IS NULL) = (cluster_assigned_at IS NULL)) NOT VALID;

-- The as-of membership read: by cluster, then by the moment the assignment became known.
CREATE INDEX fire_detections_membership_idx
  ON geonerva.fire_detections (cluster_id, cluster_assigned_at)
  WHERE cluster_id IS NOT NULL;

COMMENT ON COLUMN geonerva.fire_detections.cluster_id IS
  'The cluster this detection was assigned to, and never reassigned: a merge is recorded on the
   cluster row instead, so membership at a past knowledge time is the assigned cluster followed
   through the merges known by then (ADR-039).';
