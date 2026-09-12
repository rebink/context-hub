PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX artifacts_id_project_idx ON artifacts(id, project_id);

CREATE TABLE context_snapshots (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200 AND name = trim(name)),
  git_sha TEXT NOT NULL CHECK (length(git_sha) = 40 AND git_sha = lower(git_sha) AND git_sha NOT GLOB '*[^0-9a-f]*'),
  graph_version INTEGER NOT NULL CHECK (graph_version BETWEEN 1 AND 2147483647),
  graph_storage_layout TEXT NOT NULL CHECK (graph_storage_layout IN ('LEGACY_V1','ATTEMPT_V2')),
  graph_publication_id TEXT,
  graph_published_attempt INTEGER NOT NULL CHECK (graph_published_attempt BETWEEN 1 AND 2147483647),
  graph_published_lease_id TEXT NOT NULL,
  graph_storage_key TEXT NOT NULL,
  graph_upload_id TEXT NOT NULL,
  graph_checksum TEXT NOT NULL CHECK (length(graph_checksum) = 64 AND graph_checksum = lower(graph_checksum) AND graph_checksum NOT GLOB '*[^0-9a-f]*'),
  graph_byte_size INTEGER NOT NULL CHECK (graph_byte_size BETWEEN 1 AND 8388608),
  graph_content_type TEXT NOT NULL CHECK (graph_content_type = 'application/json'),
  graph_repository_provider TEXT NOT NULL,
  graph_provider_repository_id TEXT NOT NULL,
  graph_repository_owner TEXT NOT NULL,
  graph_repository_name TEXT NOT NULL,
  graph_repository_canonical_url TEXT NOT NULL,
  graphify_version TEXT NOT NULL,
  graph_adapter_version TEXT NOT NULL,
  graph_profile TEXT NOT NULL,
  graph_format_version INTEGER NOT NULL CHECK (graph_format_version >= 1),
  graph_generator TEXT NOT NULL,
  graph_generated_by TEXT NOT NULL,
  graph_generated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND substr(created_at, 11, 1) = 'T' AND substr(created_at, 24, 1) = 'Z'),
  expected_artifact_count INTEGER NOT NULL CHECK (expected_artifact_count BETWEEN 0 AND 100),
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128),
  manifest_storage_key TEXT NOT NULL UNIQUE,
  manifest_byte_size INTEGER NOT NULL CHECK (manifest_byte_size BETWEEN 1 AND 65536),
  manifest_checksum TEXT NOT NULL CHECK (length(manifest_checksum) = 64 AND manifest_checksum = lower(manifest_checksum) AND manifest_checksum NOT GLOB '*[^0-9a-f]*'),
  manifest_content_type TEXT NOT NULL CHECK (manifest_content_type = 'application/json'),
  FOREIGN KEY(project_id, graph_version) REFERENCES graph_versions(project_id, version),
  UNIQUE(project_id, id),
  UNIQUE(project_id, created_by, idempotency_key),
  CHECK (
    (graph_storage_layout = 'LEGACY_V1' AND graph_publication_id IS NULL AND
      graph_upload_id = graph_published_attempt || '.' || graph_published_lease_id AND
      graph_storage_key = 'projects/' || project_id || '/graphs/v/' || graph_version || '/graph.json') OR
    (graph_storage_layout = 'ATTEMPT_V2' AND graph_publication_id IS NOT NULL AND
      graph_upload_id = graph_publication_id AND
      graph_storage_key = 'projects/' || project_id || '/graphs/v/' || graph_version || '/attempts/' || graph_published_attempt || '/' || graph_publication_id || '/graph.json')
  ),
  CHECK (manifest_storage_key = 'projects/' || project_id || '/snapshots/' || id || '/manifest.json')
);

CREATE TABLE snapshot_artifacts (
  snapshot_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_version INTEGER NOT NULL CHECK (artifact_version BETWEEN 1 AND 2147483647),
  artifact_type TEXT NOT NULL CHECK (artifact_type IN (
    'architecture', 'adr', 'api-contract', 'coding-convention',
    'domain-knowledge', 'glossary', 'database-schema', 'runbook',
    'deployment-guide', 'ownership', 'security-rule',
    'product-requirement', 'custom'
  )),
  storage_key TEXT NOT NULL,
  upload_id TEXT NOT NULL CHECK (length(upload_id) BETWEEN 1 AND 128),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum = lower(checksum) AND checksum NOT GLOB '*[^0-9a-f]*'),
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 0 AND 1048576),
  source_commit_sha TEXT,
  change_note TEXT,
  version_created_by TEXT NOT NULL,
  version_created_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, artifact_id),
  FOREIGN KEY(project_id, snapshot_id) REFERENCES context_snapshots(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id, project_id) REFERENCES artifacts(id, project_id),
  FOREIGN KEY(artifact_id, artifact_version) REFERENCES artifact_versions(artifact_id, version),
  CHECK (storage_key = 'projects/' || project_id || '/artifacts/' || artifact_id || '/v/' || artifact_version || '/content'),
  CHECK (source_commit_sha IS NULL OR (length(source_commit_sha) BETWEEN 7 AND 64 AND source_commit_sha = lower(source_commit_sha) AND source_commit_sha NOT GLOB '*[^0-9a-f]*'))
);

CREATE TABLE snapshot_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action = 'snapshot-create'),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS','REJECTED','FAILED')),
  reason TEXT CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 64 AND reason NOT GLOB '*[^A-Z0-9_]*')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND substr(created_at, 11, 1) = 'T' AND substr(created_at, 24, 1) = 'Z'),
  FOREIGN KEY(project_id, snapshot_id) REFERENCES context_snapshots(project_id, id),
  CHECK ((outcome = 'SUCCESS' AND snapshot_id IS NOT NULL AND reason IS NULL) OR
         (outcome <> 'SUCCESS' AND snapshot_id IS NULL AND reason IS NOT NULL))
);

CREATE INDEX context_snapshots_project_created_idx ON context_snapshots(project_id, created_at DESC, id DESC);
CREATE INDEX snapshot_artifacts_project_snapshot_idx ON snapshot_artifacts(project_id, snapshot_id, artifact_id);
CREATE INDEX snapshot_events_project_created_idx ON snapshot_events(project_id, created_at DESC, id DESC);

CREATE TRIGGER context_snapshots_reference_guard BEFORE INSERT ON context_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM project_members pm
  JOIN graph_versions gv ON gv.project_id = NEW.project_id AND gv.version = NEW.graph_version
  JOIN git_connections gc ON gc.project_id = gv.project_id AND gc.status = 'VERIFIED'
  JOIN repository_identities ri ON ri.id = gc.repository_identity_id
  JOIN project_repositories pr ON pr.project_id = gv.project_id AND pr.repository_identity_id = gc.repository_identity_id
  WHERE pm.project_id = NEW.project_id AND pm.user_id = NEW.created_by AND pm.role IN ('ADMIN','EDITOR')
    AND gv.status IN ('READY','SUPERSEDED') AND gv.source_commit_sha = NEW.git_sha
    AND gv.repository_provider = gc.provider AND gv.provider_repository_id = gc.provider_repository_id
    AND gv.repository_owner = ri.owner AND gv.repository_name = ri.repository_name
    AND gv.repository_canonical_url = ri.canonical_url
    AND gv.storage_layout = NEW.graph_storage_layout AND gv.selected_publication_id IS NEW.graph_publication_id
    AND gv.published_attempt = NEW.graph_published_attempt AND gv.published_lease_id = NEW.graph_published_lease_id
    AND gv.storage_key = NEW.graph_storage_key AND gv.checksum = NEW.graph_checksum
    AND gv.byte_size = NEW.graph_byte_size AND gv.repository_provider = NEW.graph_repository_provider
    AND gv.provider_repository_id = NEW.graph_provider_repository_id AND gv.repository_owner = NEW.graph_repository_owner
    AND gv.repository_name = NEW.graph_repository_name AND gv.repository_canonical_url = NEW.graph_repository_canonical_url
    AND gv.graphify_version = NEW.graphify_version AND gv.adapter_version = NEW.graph_adapter_version
    AND gv.profile = NEW.graph_profile AND gv.format_version = NEW.graph_format_version
    AND gv.generator = NEW.graph_generator AND gv.generated_by = NEW.graph_generated_by
    AND gv.generated_at = NEW.graph_generated_at
    AND (gv.storage_layout = 'LEGACY_V1' OR EXISTS (
      SELECT 1 FROM graph_build_attempts gba
      WHERE gba.project_id = gv.project_id AND gba.graph_version = gv.version
        AND gba.attempt = gv.published_attempt AND gba.status = 'PUBLISHED'
        AND gba.publication_id = gv.selected_publication_id AND gba.storage_key = gv.storage_key
        AND gba.lease_id = gv.published_lease_id AND gba.checksum = gv.checksum
        AND gba.byte_size = gv.byte_size AND gba.content_type = 'application/json'
        AND gba.generated_by = gv.generated_by AND gba.published_at = gv.generated_at
    ))
)
BEGIN SELECT RAISE(ABORT, 'invalid snapshot graph reference or creator role'); END;

CREATE TRIGGER snapshot_artifacts_reference_guard BEFORE INSERT ON snapshot_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM artifacts a JOIN artifact_versions av ON av.artifact_id = a.id
  WHERE a.project_id = NEW.project_id AND a.id = NEW.artifact_id AND av.version = NEW.artifact_version
    AND a.type = NEW.artifact_type AND av.storage_key = NEW.storage_key AND av.checksum = NEW.checksum
    AND av.content_type = NEW.content_type AND av.byte_size = NEW.byte_size
    AND av.source_commit_sha IS NEW.source_commit_sha AND av.change_note IS NEW.change_note
    AND av.created_by = NEW.version_created_by
    AND av.created_at = NEW.version_created_at
)
BEGIN SELECT RAISE(ABORT, 'invalid snapshot artifact reference'); END;

CREATE TRIGGER snapshot_artifacts_sealed_after_success BEFORE INSERT ON snapshot_artifacts
WHEN EXISTS (
  SELECT 1 FROM snapshot_events se
  WHERE se.project_id = NEW.project_id AND se.snapshot_id = NEW.snapshot_id
    AND se.action = 'snapshot-create' AND se.outcome = 'SUCCESS'
)
BEGIN SELECT RAISE(ABORT, 'snapshot artifact membership is sealed'); END;

CREATE TRIGGER snapshot_success_exact_artifact_count BEFORE INSERT ON snapshot_events
WHEN NEW.action = 'snapshot-create' AND NEW.outcome = 'SUCCESS' AND NOT EXISTS (
  SELECT 1 FROM context_snapshots cs
  WHERE cs.project_id = NEW.project_id AND cs.id = NEW.snapshot_id
    AND cs.created_by = NEW.actor_id
    AND cs.expected_artifact_count = (
      SELECT COUNT(*) FROM snapshot_artifacts sa
      WHERE sa.project_id = NEW.project_id AND sa.snapshot_id = NEW.snapshot_id
    )
)
BEGIN SELECT RAISE(ABORT, 'snapshot success requires exact artifact count'); END;

CREATE TRIGGER referenced_artifact_versions_immutable_update BEFORE UPDATE ON artifact_versions
WHEN EXISTS (
  SELECT 1 FROM snapshot_artifacts sa
  WHERE sa.artifact_id = OLD.artifact_id AND sa.artifact_version = OLD.version
) AND (
  NEW.artifact_id IS NOT OLD.artifact_id OR NEW.version IS NOT OLD.version OR
  NEW.storage_key IS NOT OLD.storage_key OR NEW.checksum IS NOT OLD.checksum OR
  NEW.content_type IS NOT OLD.content_type OR NEW.byte_size IS NOT OLD.byte_size OR
  NEW.source_commit_sha IS NOT OLD.source_commit_sha OR NEW.change_note IS NOT OLD.change_note OR
  NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'referenced artifact version is immutable'); END;

CREATE TRIGGER referenced_artifact_versions_immutable_delete BEFORE DELETE ON artifact_versions
WHEN EXISTS (
  SELECT 1 FROM snapshot_artifacts sa
  WHERE sa.artifact_id = OLD.artifact_id AND sa.artifact_version = OLD.version
)
BEGIN SELECT RAISE(ABORT, 'referenced artifact version cannot be deleted'); END;

CREATE TRIGGER snapshotted_artifacts_identity_immutable BEFORE UPDATE ON artifacts
WHEN EXISTS (SELECT 1 FROM snapshot_artifacts sa WHERE sa.artifact_id = OLD.id)
  AND (NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.type IS NOT OLD.type)
BEGIN SELECT RAISE(ABORT, 'snapshotted artifact identity is immutable'); END;

CREATE TRIGGER context_snapshots_immutable_update BEFORE UPDATE ON context_snapshots
BEGIN SELECT RAISE(ABORT, 'context snapshot is immutable'); END;
CREATE TRIGGER context_snapshots_immutable_delete BEFORE DELETE ON context_snapshots
BEGIN SELECT RAISE(ABORT, 'context snapshot is immutable'); END;
CREATE TRIGGER snapshot_artifacts_immutable_update BEFORE UPDATE ON snapshot_artifacts
BEGIN SELECT RAISE(ABORT, 'snapshot artifact reference is immutable'); END;
CREATE TRIGGER snapshot_artifacts_immutable_delete BEFORE DELETE ON snapshot_artifacts
BEGIN SELECT RAISE(ABORT, 'snapshot artifact reference is immutable'); END;
CREATE TRIGGER snapshot_events_immutable_update BEFORE UPDATE ON snapshot_events
BEGIN SELECT RAISE(ABORT, 'snapshot event is immutable'); END;
CREATE TRIGGER snapshot_events_immutable_delete BEFORE DELETE ON snapshot_events
BEGIN SELECT RAISE(ABORT, 'snapshot event is immutable'); END;
