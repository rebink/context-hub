PRAGMA foreign_keys = ON;

CREATE TABLE sync_states (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES mcp_principals(id) ON DELETE RESTRICT,
  client_id TEXT NOT NULL CHECK(
    length(client_id)=36 AND client_id=lower(client_id) AND client_id NOT GLOB '*[^0-9a-f-]*' AND
    substr(client_id,9,1)='-' AND substr(client_id,14,1)='-' AND substr(client_id,19,1)='-' AND substr(client_id,24,1)='-'
  ),
  client_kind TEXT NOT NULL CHECK(client_kind='CONTEXT_CLI'),
  client_version TEXT NOT NULL CHECK(length(client_version) BETWEEN 1 AND 32 AND client_version NOT GLOB '*[^A-Za-z0-9._-]*'),
  observation_sequence INTEGER NOT NULL CHECK(observation_sequence BETWEEN 1 AND 2147483647),
  repository_provider TEXT NOT NULL CHECK(length(repository_provider) BETWEEN 1 AND 32),
  provider_repository_id TEXT NOT NULL CHECK(length(provider_repository_id) BETWEEN 1 AND 255),
  repository_canonical_url TEXT NOT NULL CHECK(length(repository_canonical_url) BETWEEN 1 AND 512),
  local_git_sha TEXT NOT NULL CHECK(length(local_git_sha)=40 AND local_git_sha=lower(local_git_sha) AND local_git_sha NOT GLOB '*[^0-9a-f]*'),
  local_graph_version INTEGER CHECK(local_graph_version IS NULL OR local_graph_version BETWEEN 1 AND 2147483647),
  local_graph_attempt INTEGER CHECK(local_graph_attempt IS NULL OR local_graph_attempt BETWEEN 1 AND 2147483647),
  local_graph_checksum TEXT CHECK(local_graph_checksum IS NULL OR (length(local_graph_checksum)=64 AND local_graph_checksum=lower(local_graph_checksum) AND local_graph_checksum NOT GLOB '*[^0-9a-f]*')),
  local_graph_source_commit_sha TEXT CHECK(local_graph_source_commit_sha IS NULL OR (length(local_graph_source_commit_sha)=40 AND local_graph_source_commit_sha=lower(local_graph_source_commit_sha) AND local_graph_source_commit_sha NOT GLOB '*[^0-9a-f]*')),
  remote_git_sha TEXT CHECK(remote_git_sha IS NULL OR (length(remote_git_sha)=40 AND remote_git_sha=lower(remote_git_sha) AND remote_git_sha NOT GLOB '*[^0-9a-f]*')),
  remote_graph_version INTEGER CHECK(remote_graph_version IS NULL OR remote_graph_version BETWEEN 1 AND 2147483647),
  remote_graph_attempt INTEGER CHECK(remote_graph_attempt IS NULL OR remote_graph_attempt BETWEEN 1 AND 2147483647),
  remote_graph_checksum TEXT CHECK(remote_graph_checksum IS NULL OR (length(remote_graph_checksum)=64 AND remote_graph_checksum=lower(remote_graph_checksum) AND remote_graph_checksum NOT GLOB '*[^0-9a-f]*')),
  remote_graph_source_commit_sha TEXT CHECK(remote_graph_source_commit_sha IS NULL OR (length(remote_graph_source_commit_sha)=40 AND remote_graph_source_commit_sha=lower(remote_graph_source_commit_sha) AND remote_graph_source_commit_sha NOT GLOB '*[^0-9a-f]*')),
  remote_graph_status TEXT CHECK(remote_graph_status IS NULL OR remote_graph_status IN ('QUEUED','BUILDING','FAILED','READY','SUPERSEDED')),
  sync_status TEXT NOT NULL CHECK(sync_status IN ('CURRENT','GRAPH_STALE','LOCAL_REPOSITORY_AHEAD','REMOTE_GRAPH_AHEAD','NO_LOCAL_GRAPH','GRAPH_BUILDING','GRAPH_FAILED','COMMIT_MISMATCH')),
  report_outcome TEXT NOT NULL CHECK(report_outcome IN ('STATUS','SYNC_SUCCEEDED','SYNC_FAILED')),
  failure_code TEXT CHECK(failure_code IS NULL OR (length(failure_code) BETWEEN 2 AND 64 AND failure_code=upper(failure_code) AND failure_code NOT GLOB '*[^A-Z0-9_]*')),
  last_sync_at TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(project_id, principal_id, client_id),
  CHECK((local_graph_version IS NULL AND local_graph_attempt IS NULL AND local_graph_checksum IS NULL AND local_graph_source_commit_sha IS NULL) OR
        (local_graph_version IS NOT NULL AND local_graph_attempt IS NOT NULL AND local_graph_checksum IS NOT NULL AND local_graph_source_commit_sha IS NOT NULL)),
  CHECK((remote_graph_version IS NULL AND remote_graph_attempt IS NULL AND remote_graph_checksum IS NULL AND remote_graph_source_commit_sha IS NULL AND remote_graph_status IS NULL) OR
        (remote_graph_version IS NOT NULL AND remote_graph_attempt IS NOT NULL AND remote_graph_checksum IS NOT NULL AND remote_graph_source_commit_sha IS NOT NULL AND remote_graph_status='READY')),
  CHECK((report_outcome='SYNC_FAILED')=(failure_code IS NOT NULL)),
  CHECK(last_sync_at IS NULL OR last_sync_at<=last_seen_at)
);

CREATE INDEX sync_states_project_seen ON sync_states(project_id, last_seen_at DESC, principal_id, client_id);
CREATE INDEX sync_states_principal_seen ON sync_states(principal_id, last_seen_at DESC);

CREATE TRIGGER sync_states_client_bound BEFORE INSERT ON sync_states
WHEN NOT EXISTS (
  SELECT 1 FROM mcp_principal_projects scope
  WHERE scope.principal_id=NEW.principal_id AND scope.project_id=NEW.project_id
) OR (SELECT COUNT(*) FROM sync_states existing
      WHERE existing.project_id=NEW.project_id AND existing.principal_id=NEW.principal_id)>=20
BEGIN SELECT RAISE(ABORT,'invalid or exhausted sync client scope'); END;

CREATE TRIGGER sync_states_identity_guard BEFORE UPDATE ON sync_states
WHEN NEW.project_id<>OLD.project_id OR NEW.principal_id<>OLD.principal_id OR NEW.client_id<>OLD.client_id OR
     NEW.client_kind<>OLD.client_kind OR NEW.created_at<>OLD.created_at OR
     NEW.observation_sequence<OLD.observation_sequence OR NEW.last_seen_at<OLD.last_seen_at OR
     (OLD.last_sync_at IS NOT NULL AND (NEW.last_sync_at IS NULL OR NEW.last_sync_at<OLD.last_sync_at))
BEGIN SELECT RAISE(ABORT,'invalid sync state update'); END;
