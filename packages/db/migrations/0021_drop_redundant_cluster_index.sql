-- 0021 — the membership index supersedes 0005's cluster index (ADR-039, follow-up to 0020).
--
-- 0005 created `fire_detections_cluster_idx ON (cluster_id) WHERE cluster_id IS NOT NULL`, and
-- 0020 created `fire_detections_membership_idx ON (cluster_id, cluster_assigned_at)` under the
-- *same* partial predicate. The older one is a strict prefix of the newer, so every lookup it
-- served — including the foreign key's — is served at the same cost by the index that replaced it.
-- Keeping both costs a second write on the highest-volume table in the schema (about 146,000 rows
-- a day) and roughly 14 MB per retained partition, to answer nothing the other cannot.
--
-- Dropped in its own migration rather than by editing 0020, which has already been applied and
-- whose checksum is recorded.

DROP INDEX IF EXISTS geonerva.fire_detections_cluster_idx;
