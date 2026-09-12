PRAGMA foreign_keys = OFF;

-- 0010 converted in-flight legacy builds without firing the transition trigger. Restore
-- the immutable transition evidence before rebuilding the constrained tables.
INSERT INTO graph_events (project_id, graph_version, from_status, to_status, attempt, failure_category, created_at)
SELECT gv.project_id, gv.version, 'BUILDING', 'FAILED', gv.attempt, 'MIGRATION_RETRY',
       COALESCE(gv.failed_at, gv.updated_at)
FROM graph_versions gv
WHERE gv.status = 'FAILED' AND gv.failure_category = 'MIGRATION_RETRY'
  AND NOT EXISTS (
    SELECT 1 FROM graph_events ge
    WHERE ge.project_id = gv.project_id AND ge.graph_version = gv.version
      AND ge.from_status = 'BUILDING' AND ge.to_status = 'FAILED'
      AND ge.attempt = gv.attempt AND ge.failure_category = 'MIGRATION_RETRY'
  );

DROP TRIGGER graph_versions_insert_queued;
DROP TRIGGER graph_versions_identity_immutable;
DROP TRIGGER graph_versions_legal_transition;
DROP TRIGGER graph_versions_ready_immutable;
DROP TRIGGER graph_versions_promote_supersedes_ready;
DROP TRIGGER graph_versions_insert_event;
DROP TRIGGER graph_versions_transition_event;
DROP TRIGGER graph_events_immutable_update;
DROP TRIGGER graph_events_immutable_delete;
DROP TRIGGER graph_attempt_identity_immutable;
DROP TRIGGER graph_attempt_legal_update;
DROP TRIGGER graph_attempt_claim_version;
DROP TRIGGER graph_attempt_fail_version;
DROP TRIGGER graph_attempt_publish_guard;
DROP TRIGGER graph_attempt_publish_version;
DROP INDEX graph_versions_one_ready_per_project_idx;
DROP INDEX graph_versions_project_version_idx;
DROP INDEX graph_versions_project_status_version_idx;
DROP INDEX graph_events_project_created_idx;
DROP INDEX graph_build_attempts_project_status_idx;
DROP INDEX graph_build_attempts_cleanup_idx;

ALTER TABLE graph_events RENAME TO graph_events_v2;
ALTER TABLE graph_build_attempts RENAME TO graph_build_attempts_v2;
ALTER TABLE graph_versions RENAME TO graph_versions_v2;

-- The immutable claim owns publisher provenance. Repair any rows written before this
-- invariant was enforced, then preserve it in the rebuilt table and publish trigger.
UPDATE graph_build_attempts_v2 SET generated_by=claimed_by WHERE generated_by IS NOT NULL;
UPDATE graph_versions_v2
SET generated_by=(
  SELECT gba.claimed_by FROM graph_build_attempts_v2 gba
  WHERE gba.project_id=graph_versions_v2.project_id
    AND gba.graph_version=graph_versions_v2.version
    AND gba.attempt=graph_versions_v2.published_attempt
    AND gba.status='PUBLISHED'
)
WHERE storage_layout='ATTEMPT_V2' AND status IN ('READY','SUPERSEDED');

CREATE TABLE graph_versions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128) REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  repository_provider TEXT NOT NULL CHECK (length(repository_provider) BETWEEN 1 AND 32),
  provider_repository_id TEXT NOT NULL CHECK (length(provider_repository_id) BETWEEN 1 AND 255),
  repository_owner TEXT NOT NULL CHECK (length(repository_owner) BETWEEN 1 AND 255),
  repository_name TEXT NOT NULL CHECK (length(repository_name) BETWEEN 1 AND 255),
  repository_canonical_url TEXT NOT NULL CHECK (length(repository_canonical_url) BETWEEN 1 AND 1000),
  source_commit_sha TEXT NOT NULL CHECK (length(source_commit_sha)=40 AND source_commit_sha=lower(source_commit_sha) AND source_commit_sha NOT GLOB '*[^0-9a-f]*'),
  graphify_version TEXT NOT NULL CHECK (length(graphify_version) BETWEEN 1 AND 64),
  adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 64),
  profile TEXT NOT NULL CHECK (length(profile) BETWEEN 1 AND 128),
  format_version INTEGER NOT NULL CHECK (format_version BETWEEN 1 AND 2147483647),
  generator TEXT NOT NULL CHECK (length(generator) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK (status IN ('QUEUED','BUILDING','FAILED','READY','SUPERSEDED')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 2147483647),
  lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) BETWEEN 32 AND 128),
  lease_expires_at TEXT,
  failure_category TEXT CHECK (failure_category IS NULL OR (length(failure_category) BETWEEN 1 AND 64 AND failure_category=upper(failure_category) AND failure_category NOT GLOB '*[^A-Z0-9_]*')),
  storage_layout TEXT NOT NULL DEFAULT 'ATTEMPT_V2' CHECK (storage_layout IN ('LEGACY_V1','ATTEMPT_V2')),
  storage_key TEXT CHECK (storage_key IS NULL OR length(storage_key) BETWEEN 1 AND 1000),
  selected_publication_id TEXT CHECK (selected_publication_id IS NULL OR length(selected_publication_id) BETWEEN 32 AND 128),
  checksum TEXT CHECK (checksum IS NULL OR (length(checksum)=64 AND checksum=lower(checksum) AND checksum NOT GLOB '*[^0-9a-f]*')),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size BETWEEN 1 AND 8388608),
  node_count INTEGER CHECK (node_count IS NULL OR node_count BETWEEN 0 AND 50000),
  link_count INTEGER CHECK (link_count IS NULL OR link_count BETWEEN 0 AND 100000),
  hyperedge_count INTEGER CHECK (hyperedge_count IS NULL OR hyperedge_count=0),
  generated_by TEXT CHECK (generated_by IS NULL OR length(generated_by) BETWEEN 1 AND 255),
  published_attempt INTEGER CHECK (published_attempt IS NULL OR published_attempt BETWEEN 1 AND 2147483647),
  published_lease_id TEXT CHECK (published_lease_id IS NULL OR length(published_lease_id) BETWEEN 32 AND 128),
  queued_at TEXT NOT NULL, build_started_at TEXT, failed_at TEXT, generated_at TEXT, superseded_at TEXT, updated_at TEXT NOT NULL,
  orphan_observed_at TEXT,
  orphan_attempt INTEGER CHECK (orphan_attempt IS NULL OR orphan_attempt BETWEEN 1 AND 2147483647),
  orphan_lease_id TEXT CHECK (orphan_lease_id IS NULL OR length(orphan_lease_id) BETWEEN 32 AND 128),
  orphan_checksum TEXT CHECK (orphan_checksum IS NULL OR (length(orphan_checksum)=64 AND orphan_checksum=lower(orphan_checksum) AND orphan_checksum NOT GLOB '*[^0-9a-f]*')),
  orphan_byte_size INTEGER CHECK (orphan_byte_size IS NULL OR orphan_byte_size BETWEEN 1 AND 8388608),
  orphan_cleanup_id TEXT CHECK (orphan_cleanup_id IS NULL OR length(orphan_cleanup_id) BETWEEN 32 AND 128),
  orphan_cleanup_expires_at TEXT,
  UNIQUE(project_id,version),
  UNIQUE(project_id,repository_provider,provider_repository_id,repository_owner,repository_name,repository_canonical_url,source_commit_sha,graphify_version,adapter_version,profile,format_version),
  CHECK ((lease_id IS NULL)=(lease_expires_at IS NULL)),
  CHECK (
    (status='QUEUED' AND lease_id IS NULL AND build_started_at IS NULL AND failure_category IS NULL AND failed_at IS NULL AND storage_key IS NULL AND selected_publication_id IS NULL AND checksum IS NULL AND byte_size IS NULL AND node_count IS NULL AND link_count IS NULL AND hyperedge_count IS NULL AND generated_by IS NULL AND published_attempt IS NULL AND published_lease_id IS NULL AND generated_at IS NULL AND superseded_at IS NULL) OR
    (status='BUILDING' AND lease_id IS NOT NULL AND build_started_at IS NOT NULL AND failure_category IS NULL AND failed_at IS NULL AND storage_key IS NULL AND selected_publication_id IS NULL AND checksum IS NULL AND byte_size IS NULL AND node_count IS NULL AND link_count IS NULL AND hyperedge_count IS NULL AND generated_by IS NULL AND published_attempt IS NULL AND published_lease_id IS NULL AND generated_at IS NULL AND superseded_at IS NULL) OR
    (status='FAILED' AND lease_id IS NULL AND build_started_at IS NOT NULL AND failure_category IS NOT NULL AND failed_at IS NOT NULL AND storage_key IS NULL AND selected_publication_id IS NULL AND checksum IS NULL AND byte_size IS NULL AND node_count IS NULL AND link_count IS NULL AND hyperedge_count IS NULL AND generated_by IS NULL AND published_attempt IS NULL AND published_lease_id IS NULL AND generated_at IS NULL AND superseded_at IS NULL) OR
    (status='READY' AND lease_id IS NULL AND build_started_at IS NOT NULL AND failure_category IS NULL AND failed_at IS NULL AND storage_key IS NOT NULL AND checksum IS NOT NULL AND byte_size IS NOT NULL AND node_count IS NOT NULL AND link_count IS NOT NULL AND hyperedge_count=0 AND generated_by IS NOT NULL AND published_attempt IS NOT NULL AND published_lease_id IS NOT NULL AND generated_at IS NOT NULL AND superseded_at IS NULL) OR
    (status='SUPERSEDED' AND lease_id IS NULL AND build_started_at IS NOT NULL AND failure_category IS NULL AND failed_at IS NULL AND storage_key IS NOT NULL AND checksum IS NOT NULL AND byte_size IS NOT NULL AND node_count IS NOT NULL AND link_count IS NOT NULL AND hyperedge_count=0 AND generated_by IS NOT NULL AND published_attempt IS NOT NULL AND published_lease_id IS NOT NULL AND generated_at IS NOT NULL AND superseded_at IS NOT NULL)
  ),
  CHECK (storage_key IS NULL OR
    (storage_layout='LEGACY_V1' AND selected_publication_id IS NULL AND storage_key='projects/'||project_id||'/graphs/v/'||version||'/graph.json') OR
    (storage_layout='ATTEMPT_V2' AND selected_publication_id IS NOT NULL AND storage_key='projects/'||project_id||'/graphs/v/'||version||'/attempts/'||published_attempt||'/'||selected_publication_id||'/graph.json'))
);
INSERT INTO graph_versions SELECT * FROM graph_versions_v2;

CREATE TABLE graph_build_attempts (
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  graph_version INTEGER NOT NULL CHECK (graph_version BETWEEN 1 AND 2147483647),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 2147483647),
  publication_id TEXT NOT NULL UNIQUE CHECK (length(publication_id) BETWEEN 32 AND 128),
  storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 1000),
  status TEXT NOT NULL CHECK (status IN ('BUILDING','FAILED','PUBLISHED','CLEANED')),
  lease_id TEXT NOT NULL CHECK (length(lease_id) BETWEEN 32 AND 128),
  lease_expires_at TEXT NOT NULL,
  claimed_by TEXT NOT NULL CHECK (length(claimed_by) BETWEEN 1 AND 255),
  claimed_at TEXT NOT NULL,
  failure_category TEXT CHECK (failure_category IS NULL OR (length(failure_category) BETWEEN 1 AND 64 AND failure_category=upper(failure_category) AND failure_category NOT GLOB '*[^A-Z0-9_]*')),
  failed_at TEXT,
  checksum TEXT CHECK (checksum IS NULL OR (length(checksum)=64 AND checksum=lower(checksum) AND checksum NOT GLOB '*[^0-9a-f]*')),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size BETWEEN 1 AND 8388608),
  content_type TEXT CHECK (content_type IS NULL OR content_type='application/json'),
  node_count INTEGER CHECK (node_count IS NULL OR node_count BETWEEN 0 AND 50000),
  link_count INTEGER CHECK (link_count IS NULL OR link_count BETWEEN 0 AND 100000),
  hyperedge_count INTEGER CHECK (hyperedge_count IS NULL OR hyperedge_count=0),
  generated_by TEXT CHECK (generated_by IS NULL OR length(generated_by) BETWEEN 1 AND 255),
  published_at TEXT,
  orphan_observed_at TEXT, cleanup_not_before TEXT,
  cleanup_claim_id TEXT CHECK (cleanup_claim_id IS NULL OR length(cleanup_claim_id) BETWEEN 32 AND 128),
  cleanup_claim_expires_at TEXT, cleaned_at TEXT,
  cleanup_result TEXT CHECK (cleanup_result IS NULL OR cleanup_result IN ('DELETED','ABSENT','RETAINED')),
  PRIMARY KEY(project_id,graph_version,attempt),
  FOREIGN KEY(project_id,graph_version) REFERENCES graph_versions(project_id,version) ON DELETE CASCADE,
  CHECK ((cleanup_claim_id IS NULL)=(cleanup_claim_expires_at IS NULL)),
  CHECK ((checksum IS NULL AND byte_size IS NULL AND content_type IS NULL AND node_count IS NULL AND link_count IS NULL AND hyperedge_count IS NULL AND generated_by IS NULL) OR (checksum IS NOT NULL AND byte_size IS NOT NULL AND content_type='application/json' AND node_count IS NOT NULL AND link_count IS NOT NULL AND hyperedge_count=0 AND generated_by=claimed_by)),
  CHECK (
    (status='BUILDING' AND failure_category IS NULL AND failed_at IS NULL AND published_at IS NULL AND orphan_observed_at IS NULL AND cleanup_not_before IS NULL AND cleanup_claim_id IS NULL AND cleaned_at IS NULL AND cleanup_result IS NULL) OR
    (status='FAILED' AND failure_category IS NOT NULL AND failed_at IS NOT NULL AND published_at IS NULL AND orphan_observed_at IS NOT NULL AND cleanup_not_before IS NOT NULL AND cleaned_at IS NULL) OR
    (status='PUBLISHED' AND checksum IS NOT NULL AND failure_category IS NULL AND failed_at IS NULL AND published_at IS NOT NULL AND orphan_observed_at IS NULL AND cleanup_not_before IS NULL AND cleanup_claim_id IS NULL AND cleaned_at IS NULL AND cleanup_result IS NULL) OR
    (status='CLEANED' AND checksum IS NOT NULL AND failure_category IS NOT NULL AND failed_at IS NOT NULL AND published_at IS NULL AND orphan_observed_at IS NOT NULL AND cleanup_not_before IS NOT NULL AND cleanup_claim_id IS NOT NULL AND cleaned_at IS NOT NULL AND cleanup_result='DELETED')
  ),
  CHECK (storage_key='projects/'||project_id||'/graphs/v/'||graph_version||'/attempts/'||attempt||'/'||publication_id||'/graph.json')
);
INSERT INTO graph_build_attempts SELECT * FROM graph_build_attempts_v2;

CREATE TABLE graph_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  graph_version INTEGER NOT NULL CHECK (graph_version BETWEEN 1 AND 2147483647),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('QUEUED','BUILDING','FAILED','READY')),
  to_status TEXT NOT NULL CHECK (to_status IN ('QUEUED','BUILDING','FAILED','READY','SUPERSEDED')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 2147483647),
  failure_category TEXT CHECK (failure_category IS NULL OR (length(failure_category) BETWEEN 1 AND 64 AND failure_category=upper(failure_category) AND failure_category NOT GLOB '*[^A-Z0-9_]*')),
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,graph_version) REFERENCES graph_versions(project_id,version) ON DELETE CASCADE,
  CHECK ((to_status='FAILED')=(failure_category IS NOT NULL)),
  CHECK ((from_status IS NULL AND to_status='QUEUED') OR (from_status='QUEUED' AND to_status='BUILDING') OR (from_status='BUILDING' AND to_status IN ('FAILED','READY')) OR (from_status='FAILED' AND to_status='QUEUED') OR (from_status='READY' AND to_status='SUPERSEDED'))
);
INSERT INTO graph_events SELECT * FROM graph_events_v2;

DROP TABLE graph_events_v2;
DROP TABLE graph_build_attempts_v2;
DROP TABLE graph_versions_v2;

CREATE UNIQUE INDEX graph_versions_one_ready_per_project_idx ON graph_versions(project_id) WHERE status='READY';
CREATE INDEX graph_versions_project_version_idx ON graph_versions(project_id,version DESC);
CREATE INDEX graph_versions_project_status_version_idx ON graph_versions(project_id,status,version DESC);
CREATE INDEX graph_events_project_created_idx ON graph_events(project_id,created_at DESC,id DESC);
CREATE INDEX graph_build_attempts_project_status_idx ON graph_build_attempts(project_id,status,graph_version,attempt);
CREATE INDEX graph_build_attempts_cleanup_idx ON graph_build_attempts(status,cleanup_not_before) WHERE status='FAILED';

CREATE TRIGGER graph_versions_insert_queued BEFORE INSERT ON graph_versions WHEN NEW.status<>'QUEUED' BEGIN SELECT RAISE(ABORT,'graph version must start queued'); END;
CREATE TRIGGER graph_versions_identity_immutable BEFORE UPDATE ON graph_versions WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.version IS NOT OLD.version OR NEW.repository_provider IS NOT OLD.repository_provider OR NEW.provider_repository_id IS NOT OLD.provider_repository_id OR NEW.repository_owner IS NOT OLD.repository_owner OR NEW.repository_name IS NOT OLD.repository_name OR NEW.repository_canonical_url IS NOT OLD.repository_canonical_url OR NEW.source_commit_sha IS NOT OLD.source_commit_sha OR NEW.graphify_version IS NOT OLD.graphify_version OR NEW.adapter_version IS NOT OLD.adapter_version OR NEW.profile IS NOT OLD.profile OR NEW.format_version IS NOT OLD.format_version OR NEW.generator IS NOT OLD.generator OR NEW.queued_at IS NOT OLD.queued_at BEGIN SELECT RAISE(ABORT,'graph identity is immutable'); END;
CREATE TRIGGER graph_versions_legal_transition BEFORE UPDATE ON graph_versions WHEN NOT ((OLD.status='QUEUED' AND NEW.status='BUILDING' AND NEW.attempt=OLD.attempt) OR (OLD.status='BUILDING' AND NEW.status IN ('FAILED','READY') AND NEW.attempt=OLD.attempt) OR (OLD.status='FAILED' AND NEW.status='QUEUED' AND NEW.attempt=OLD.attempt+1) OR (OLD.status='READY' AND NEW.status='SUPERSEDED' AND NEW.attempt=OLD.attempt)) BEGIN SELECT RAISE(ABORT,'illegal graph transition'); END;
CREATE TRIGGER graph_versions_ready_immutable BEFORE UPDATE ON graph_versions WHEN OLD.status IN ('READY','SUPERSEDED') AND (OLD.status='SUPERSEDED' OR NEW.storage_layout IS NOT OLD.storage_layout OR NEW.storage_key IS NOT OLD.storage_key OR NEW.selected_publication_id IS NOT OLD.selected_publication_id OR NEW.checksum IS NOT OLD.checksum OR NEW.byte_size IS NOT OLD.byte_size OR NEW.node_count IS NOT OLD.node_count OR NEW.link_count IS NOT OLD.link_count OR NEW.hyperedge_count IS NOT OLD.hyperedge_count OR NEW.generated_by IS NOT OLD.generated_by OR NEW.published_attempt IS NOT OLD.published_attempt OR NEW.published_lease_id IS NOT OLD.published_lease_id OR NEW.generated_at IS NOT OLD.generated_at) BEGIN SELECT RAISE(ABORT,'published graph is immutable'); END;
CREATE TRIGGER graph_versions_promote_supersedes_ready BEFORE UPDATE OF status ON graph_versions WHEN OLD.status='BUILDING' AND NEW.status='READY' BEGIN SELECT RAISE(IGNORE) WHERE EXISTS (SELECT 1 FROM graph_versions WHERE project_id=NEW.project_id AND status='READY' AND version>NEW.version); UPDATE graph_versions SET status='SUPERSEDED',superseded_at=NEW.generated_at,updated_at=NEW.generated_at WHERE project_id=NEW.project_id AND status='READY' AND version<NEW.version; END;
CREATE TRIGGER graph_versions_insert_event AFTER INSERT ON graph_versions BEGIN INSERT INTO graph_events(project_id,graph_version,from_status,to_status,attempt,failure_category,created_at) VALUES(NEW.project_id,NEW.version,NULL,NEW.status,NEW.attempt,NEW.failure_category,NEW.updated_at); END;
CREATE TRIGGER graph_versions_transition_event AFTER UPDATE OF status ON graph_versions BEGIN INSERT INTO graph_events(project_id,graph_version,from_status,to_status,attempt,failure_category,created_at) VALUES(NEW.project_id,NEW.version,OLD.status,NEW.status,NEW.attempt,NEW.failure_category,NEW.updated_at); END;
CREATE TRIGGER graph_events_immutable_update BEFORE UPDATE ON graph_events BEGIN SELECT RAISE(ABORT,'graph event is immutable'); END;
CREATE TRIGGER graph_events_immutable_delete BEFORE DELETE ON graph_events BEGIN SELECT RAISE(ABORT,'graph event is immutable'); END;
CREATE TRIGGER graph_attempt_delete_immutable BEFORE DELETE ON graph_build_attempts BEGIN SELECT RAISE(ABORT,'graph attempt is immutable'); END;
CREATE TRIGGER graph_attempt_identity_immutable BEFORE UPDATE ON graph_build_attempts WHEN NEW.project_id IS NOT OLD.project_id OR NEW.graph_version IS NOT OLD.graph_version OR NEW.attempt IS NOT OLD.attempt OR NEW.publication_id IS NOT OLD.publication_id OR NEW.storage_key IS NOT OLD.storage_key OR NEW.lease_id IS NOT OLD.lease_id OR NEW.lease_expires_at IS NOT OLD.lease_expires_at OR NEW.claimed_by IS NOT OLD.claimed_by OR NEW.claimed_at IS NOT OLD.claimed_at OR OLD.status IN ('PUBLISHED','CLEANED') BEGIN SELECT RAISE(ABORT,'graph attempt identity/outcome is immutable'); END;
CREATE TRIGGER graph_attempt_legal_update BEFORE UPDATE ON graph_build_attempts WHEN NOT ((OLD.status='BUILDING' AND NEW.status='BUILDING' AND OLD.checksum IS NULL AND NEW.checksum IS NOT NULL AND NEW.generated_by=NEW.claimed_by) OR (OLD.status='BUILDING' AND NEW.status IN ('FAILED','PUBLISHED')) OR (OLD.status='FAILED' AND NEW.status='FAILED' AND NEW.failure_category IS OLD.failure_category AND NEW.failed_at IS OLD.failed_at AND NEW.checksum IS OLD.checksum AND NEW.byte_size IS OLD.byte_size AND NEW.content_type IS OLD.content_type AND NEW.node_count IS OLD.node_count AND NEW.link_count IS OLD.link_count AND NEW.hyperedge_count IS OLD.hyperedge_count AND NEW.generated_by IS OLD.generated_by AND NEW.published_at IS OLD.published_at)) BEGIN SELECT RAISE(ABORT,'illegal graph attempt transition'); END;
CREATE TRIGGER graph_attempt_claim_version AFTER INSERT ON graph_build_attempts BEGIN UPDATE graph_versions SET status='BUILDING',lease_id=NEW.lease_id,lease_expires_at=NEW.lease_expires_at,build_started_at=NEW.claimed_at,updated_at=NEW.claimed_at WHERE project_id=NEW.project_id AND version=NEW.graph_version AND status='QUEUED' AND attempt=NEW.attempt; SELECT RAISE(ABORT,'stale graph claim') WHERE changes()<>1; END;
CREATE TRIGGER graph_attempt_fail_version AFTER UPDATE OF status ON graph_build_attempts WHEN OLD.status='BUILDING' AND NEW.status='FAILED' BEGIN UPDATE graph_versions SET status='FAILED',lease_id=NULL,lease_expires_at=NULL,failure_category=NEW.failure_category,failed_at=NEW.failed_at,updated_at=NEW.failed_at WHERE project_id=NEW.project_id AND version=NEW.graph_version AND status='BUILDING' AND attempt=NEW.attempt AND lease_id=NEW.lease_id; SELECT RAISE(ABORT,'stale graph failure') WHERE changes()<>1; END;
CREATE TRIGGER graph_attempt_publish_guard BEFORE UPDATE OF status ON graph_build_attempts WHEN OLD.status='BUILDING' AND NEW.status='PUBLISHED' BEGIN SELECT RAISE(ABORT,'publisher provenance mismatch') WHERE NEW.generated_by IS NOT NEW.claimed_by; SELECT RAISE(ABORT,'stale graph publication') WHERE NOT EXISTS (SELECT 1 FROM graph_versions gv WHERE gv.project_id=NEW.project_id AND gv.version=NEW.graph_version AND gv.status='BUILDING' AND gv.attempt=NEW.attempt AND gv.lease_id=NEW.lease_id AND gv.lease_expires_at>NEW.published_at AND NOT EXISTS (SELECT 1 FROM graph_versions newer WHERE newer.project_id=gv.project_id AND newer.status='READY' AND newer.version>gv.version)); END;
CREATE TRIGGER graph_attempt_publish_version AFTER UPDATE OF status ON graph_build_attempts WHEN OLD.status='BUILDING' AND NEW.status='PUBLISHED' BEGIN UPDATE graph_versions SET status='READY',lease_id=NULL,lease_expires_at=NULL,storage_layout='ATTEMPT_V2',storage_key=NEW.storage_key,selected_publication_id=NEW.publication_id,checksum=NEW.checksum,byte_size=NEW.byte_size,node_count=NEW.node_count,link_count=NEW.link_count,hyperedge_count=NEW.hyperedge_count,generated_by=NEW.generated_by,published_attempt=NEW.attempt,published_lease_id=NEW.lease_id,generated_at=NEW.published_at,updated_at=NEW.published_at WHERE project_id=NEW.project_id AND version=NEW.graph_version AND status='BUILDING' AND attempt=NEW.attempt AND lease_id=NEW.lease_id; END;

PRAGMA foreign_keys = ON;
