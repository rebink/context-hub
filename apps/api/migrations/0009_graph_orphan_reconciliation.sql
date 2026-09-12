PRAGMA foreign_keys = ON;

ALTER TABLE graph_versions ADD COLUMN orphan_observed_at TEXT;
ALTER TABLE graph_versions ADD COLUMN orphan_attempt INTEGER CHECK (orphan_attempt IS NULL OR orphan_attempt >= 1);
ALTER TABLE graph_versions ADD COLUMN orphan_lease_id TEXT CHECK (orphan_lease_id IS NULL OR length(orphan_lease_id) BETWEEN 32 AND 128);
ALTER TABLE graph_versions ADD COLUMN orphan_checksum TEXT CHECK (orphan_checksum IS NULL OR (length(orphan_checksum) = 64 AND orphan_checksum NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE graph_versions ADD COLUMN orphan_byte_size INTEGER CHECK (orphan_byte_size IS NULL OR orphan_byte_size BETWEEN 1 AND 8388608);
ALTER TABLE graph_versions ADD COLUMN orphan_cleanup_id TEXT CHECK (orphan_cleanup_id IS NULL OR length(orphan_cleanup_id) BETWEEN 32 AND 128);
ALTER TABLE graph_versions ADD COLUMN orphan_cleanup_expires_at TEXT;

CREATE INDEX graph_versions_orphan_observation_idx
  ON graph_versions(status, orphan_observed_at)
  WHERE status = 'FAILED' AND orphan_observed_at IS NOT NULL;

DROP TRIGGER graph_versions_legal_transition;
CREATE TRIGGER graph_versions_legal_transition
BEFORE UPDATE ON graph_versions
WHEN NOT (
  (OLD.status = 'QUEUED' AND NEW.status = 'BUILDING' AND NEW.attempt = OLD.attempt) OR
  (OLD.status = 'BUILDING' AND NEW.status IN ('FAILED', 'READY') AND NEW.attempt = OLD.attempt) OR
  (OLD.status = 'FAILED' AND NEW.status = 'QUEUED' AND NEW.attempt = OLD.attempt + 1) OR
  (OLD.status = 'READY' AND NEW.status = 'SUPERSEDED' AND NEW.attempt = OLD.attempt) OR
  (OLD.status = 'FAILED' AND NEW.status = 'FAILED' AND NEW.attempt = OLD.attempt AND
   NEW.orphan_observed_at IS NOT NULL AND NEW.orphan_attempt = OLD.attempt AND
   NEW.orphan_lease_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'illegal graph transition');
END;
