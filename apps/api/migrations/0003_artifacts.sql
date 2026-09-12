PRAGMA foreign_keys = ON;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'architecture', 'adr', 'api-contract', 'coding-convention',
    'domain-knowledge', 'glossary', 'database-schema', 'runbook',
    'deployment-guide', 'ownership', 'security-rule',
    'product-requirement', 'custom'
  )),
  name TEXT NOT NULL,
  description TEXT,
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  storage_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum = lower(checksum)),
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= 1048576),
  source_commit_sha TEXT,
  change_note TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  artifact_version INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('artifact-created', 'version-created')),
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX artifacts_project_created_idx ON artifacts(project_id, created_at DESC, id DESC);
CREATE INDEX artifacts_project_type_created_idx ON artifacts(project_id, type, created_at DESC, id DESC);
CREATE INDEX artifact_versions_artifact_version_idx ON artifact_versions(artifact_id, version DESC);
CREATE INDEX audit_events_project_created_idx ON audit_events(project_id, created_at DESC, id DESC);
CREATE INDEX audit_events_artifact_created_idx ON audit_events(artifact_id, created_at DESC, id DESC);
