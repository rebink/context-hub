PRAGMA foreign_keys = ON;

CREATE TABLE graph_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  repository_provider TEXT NOT NULL CHECK (length(repository_provider) BETWEEN 1 AND 32),
  provider_repository_id TEXT NOT NULL CHECK (length(provider_repository_id) BETWEEN 1 AND 255),
  repository_owner TEXT NOT NULL CHECK (length(repository_owner) BETWEEN 1 AND 255),
  repository_name TEXT NOT NULL CHECK (length(repository_name) BETWEEN 1 AND 255),
  repository_canonical_url TEXT NOT NULL CHECK (length(repository_canonical_url) BETWEEN 1 AND 1000),
  source_commit_sha TEXT NOT NULL CHECK (
    length(source_commit_sha) = 40 AND source_commit_sha = lower(source_commit_sha) AND
    source_commit_sha NOT GLOB '*[^0-9a-f]*'
  ),
  graphify_version TEXT NOT NULL CHECK (length(graphify_version) BETWEEN 1 AND 64),
  adapter_version TEXT NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 64),
  profile TEXT NOT NULL CHECK (length(profile) BETWEEN 1 AND 128),
  format_version INTEGER NOT NULL CHECK (format_version >= 1 AND format_version <= 2147483647),
  generator TEXT NOT NULL CHECK (length(generator) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'BUILDING', 'FAILED', 'READY', 'SUPERSEDED')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1 AND attempt <= 2147483647),
  lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) BETWEEN 32 AND 128),
  lease_expires_at TEXT,
  failure_category TEXT CHECK (
    failure_category IS NULL OR
    (length(failure_category) BETWEEN 1 AND 64 AND failure_category = upper(failure_category) AND
     failure_category NOT GLOB '*[^A-Z0-9_]*')
  ),
  storage_key TEXT CHECK (storage_key IS NULL OR length(storage_key) BETWEEN 1 AND 1000),
  checksum TEXT CHECK (
    checksum IS NULL OR
    (length(checksum) = 64 AND checksum = lower(checksum) AND checksum NOT GLOB '*[^0-9a-f]*')
  ),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size BETWEEN 1 AND 8388608),
  node_count INTEGER CHECK (node_count IS NULL OR node_count BETWEEN 0 AND 50000),
  link_count INTEGER CHECK (link_count IS NULL OR link_count BETWEEN 0 AND 100000),
  hyperedge_count INTEGER CHECK (hyperedge_count IS NULL OR hyperedge_count = 0),
  generated_by TEXT CHECK (generated_by IS NULL OR length(generated_by) BETWEEN 1 AND 255),
  published_attempt INTEGER CHECK (published_attempt IS NULL OR published_attempt >= 1),
  published_lease_id TEXT CHECK (published_lease_id IS NULL OR length(published_lease_id) BETWEEN 32 AND 128),
  queued_at TEXT NOT NULL,
  build_started_at TEXT,
  failed_at TEXT,
  generated_at TEXT,
  superseded_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, version),
  UNIQUE (
    project_id, repository_provider, provider_repository_id, repository_owner,
    repository_name, repository_canonical_url, source_commit_sha, graphify_version,
    adapter_version, profile, format_version
  ),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK (
    (status = 'QUEUED' AND lease_id IS NULL AND failure_category IS NULL AND failed_at IS NULL AND
      storage_key IS NULL AND checksum IS NULL AND byte_size IS NULL AND node_count IS NULL AND
      link_count IS NULL AND hyperedge_count IS NULL AND generated_by IS NULL AND
      published_attempt IS NULL AND published_lease_id IS NULL AND generated_at IS NULL AND superseded_at IS NULL) OR
    (status = 'BUILDING' AND lease_id IS NOT NULL AND build_started_at IS NOT NULL AND
      failure_category IS NULL AND failed_at IS NULL AND storage_key IS NULL AND checksum IS NULL AND
      byte_size IS NULL AND node_count IS NULL AND link_count IS NULL AND hyperedge_count IS NULL AND
      generated_by IS NULL AND published_attempt IS NULL AND published_lease_id IS NULL AND
      generated_at IS NULL AND superseded_at IS NULL) OR
    (status = 'FAILED' AND lease_id IS NULL AND failure_category IS NOT NULL AND failed_at IS NOT NULL AND
      storage_key IS NULL AND checksum IS NULL AND byte_size IS NULL AND node_count IS NULL AND
      link_count IS NULL AND hyperedge_count IS NULL AND generated_by IS NULL AND
      published_attempt IS NULL AND published_lease_id IS NULL AND generated_at IS NULL AND superseded_at IS NULL) OR
    (status = 'READY' AND lease_id IS NULL AND failure_category IS NULL AND failed_at IS NULL AND
      storage_key IS NOT NULL AND checksum IS NOT NULL AND byte_size IS NOT NULL AND node_count IS NOT NULL AND
      link_count IS NOT NULL AND hyperedge_count IS NOT NULL AND generated_by IS NOT NULL AND
      published_attempt IS NOT NULL AND published_lease_id IS NOT NULL AND generated_at IS NOT NULL AND superseded_at IS NULL) OR
    (status = 'SUPERSEDED' AND lease_id IS NULL AND failure_category IS NULL AND failed_at IS NULL AND
      storage_key IS NOT NULL AND checksum IS NOT NULL AND byte_size IS NOT NULL AND node_count IS NOT NULL AND
      link_count IS NOT NULL AND hyperedge_count IS NOT NULL AND generated_by IS NOT NULL AND
      published_attempt IS NOT NULL AND published_lease_id IS NOT NULL AND generated_at IS NOT NULL AND superseded_at IS NOT NULL)
  ),
  CHECK (storage_key IS NULL OR storage_key = 'projects/' || project_id || '/graphs/v/' || version || '/graph.json')
);

CREATE UNIQUE INDEX graph_versions_one_ready_per_project_idx
  ON graph_versions(project_id) WHERE status = 'READY';
CREATE INDEX graph_versions_project_version_idx
  ON graph_versions(project_id, version DESC);
CREATE INDEX graph_versions_project_status_version_idx
  ON graph_versions(project_id, status, version DESC);
CREATE INDEX graph_versions_lease_expiry_idx
  ON graph_versions(status, lease_expires_at) WHERE status = 'BUILDING';

CREATE TABLE graph_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  graph_version INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (to_status IN ('QUEUED', 'BUILDING', 'FAILED', 'READY', 'SUPERSEDED')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  failure_category TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, graph_version) REFERENCES graph_versions(project_id, version) ON DELETE CASCADE,
  CHECK (from_status IS NULL OR from_status IN ('QUEUED', 'BUILDING', 'FAILED', 'READY'))
);
CREATE INDEX graph_events_project_created_idx ON graph_events(project_id, created_at DESC, id DESC);

CREATE TRIGGER graph_versions_insert_queued
BEFORE INSERT ON graph_versions
WHEN NEW.status <> 'QUEUED'
BEGIN
  SELECT RAISE(ABORT, 'graph version must start queued');
END;

CREATE TRIGGER graph_versions_identity_immutable
BEFORE UPDATE ON graph_versions
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.version IS NOT OLD.version OR
     NEW.repository_provider IS NOT OLD.repository_provider OR
     NEW.provider_repository_id IS NOT OLD.provider_repository_id OR
     NEW.repository_owner IS NOT OLD.repository_owner OR NEW.repository_name IS NOT OLD.repository_name OR
     NEW.repository_canonical_url IS NOT OLD.repository_canonical_url OR
     NEW.source_commit_sha IS NOT OLD.source_commit_sha OR NEW.graphify_version IS NOT OLD.graphify_version OR
     NEW.adapter_version IS NOT OLD.adapter_version OR NEW.profile IS NOT OLD.profile OR
     NEW.format_version IS NOT OLD.format_version OR NEW.generator IS NOT OLD.generator OR
     NEW.queued_at IS NOT OLD.queued_at
BEGIN
  SELECT RAISE(ABORT, 'graph identity is immutable');
END;

CREATE TRIGGER graph_versions_legal_transition
BEFORE UPDATE ON graph_versions
WHEN NOT (
  (OLD.status = 'QUEUED' AND NEW.status = 'BUILDING' AND NEW.attempt = OLD.attempt) OR
  (OLD.status = 'BUILDING' AND NEW.status IN ('FAILED', 'READY') AND NEW.attempt = OLD.attempt) OR
  (OLD.status = 'FAILED' AND NEW.status = 'QUEUED' AND NEW.attempt = OLD.attempt + 1) OR
  (OLD.status = 'READY' AND NEW.status = 'SUPERSEDED' AND NEW.attempt = OLD.attempt)
)
BEGIN
  SELECT RAISE(ABORT, 'illegal graph transition');
END;

CREATE TRIGGER graph_versions_ready_immutable
BEFORE UPDATE ON graph_versions
WHEN OLD.status IN ('READY', 'SUPERSEDED') AND (
  NEW.storage_key IS NOT OLD.storage_key OR NEW.checksum IS NOT OLD.checksum OR
  NEW.byte_size IS NOT OLD.byte_size OR NEW.node_count IS NOT OLD.node_count OR
  NEW.link_count IS NOT OLD.link_count OR NEW.hyperedge_count IS NOT OLD.hyperedge_count OR
  NEW.generated_by IS NOT OLD.generated_by OR NEW.published_attempt IS NOT OLD.published_attempt OR
  NEW.published_lease_id IS NOT OLD.published_lease_id OR NEW.generated_at IS NOT OLD.generated_at OR
  NEW.build_started_at IS NOT OLD.build_started_at OR (OLD.status = 'SUPERSEDED')
)
BEGIN
  SELECT RAISE(ABORT, 'published graph is immutable');
END;

-- Promotion and replacement happen inside one SQLite statement, before the partial unique index is checked.
-- A stale lower version is ignored before it can supersede the current higher READY version.
CREATE TRIGGER graph_versions_promote_supersedes_ready
BEFORE UPDATE OF status ON graph_versions
WHEN OLD.status = 'BUILDING' AND NEW.status = 'READY'
BEGIN
  SELECT RAISE(IGNORE)
  WHERE EXISTS (
    SELECT 1 FROM graph_versions
    WHERE project_id = NEW.project_id AND status = 'READY' AND version > NEW.version
  );
  UPDATE graph_versions
  SET status = 'SUPERSEDED', superseded_at = NEW.generated_at, updated_at = NEW.generated_at
  WHERE project_id = NEW.project_id AND status = 'READY' AND version < NEW.version;
END;

CREATE TRIGGER graph_versions_insert_event
AFTER INSERT ON graph_versions
BEGIN
  INSERT INTO graph_events (project_id, graph_version, from_status, to_status, attempt, failure_category, created_at)
  VALUES (NEW.project_id, NEW.version, NULL, NEW.status, NEW.attempt, NEW.failure_category, NEW.updated_at);
END;

CREATE TRIGGER graph_versions_transition_event
AFTER UPDATE OF status ON graph_versions
BEGIN
  INSERT INTO graph_events (project_id, graph_version, from_status, to_status, attempt, failure_category, created_at)
  VALUES (NEW.project_id, NEW.version, OLD.status, NEW.status, NEW.attempt, NEW.failure_category, NEW.updated_at);
END;

CREATE TRIGGER graph_events_immutable_update
BEFORE UPDATE ON graph_events
BEGIN
  SELECT RAISE(ABORT, 'graph event is immutable');
END;
