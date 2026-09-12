PRAGMA foreign_keys = ON;

CREATE TABLE github_connection_states (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('INSTALL', 'AUTHORIZE')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL,
  owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  installation_id TEXT,
  verifier_hash TEXT CHECK (verifier_hash IS NULL OR length(verifier_hash) = 64),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (kind = 'INSTALL' AND installation_id IS NULL AND verifier_hash IS NULL) OR
    (kind = 'AUTHORIZE' AND installation_id IS NOT NULL AND verifier_hash IS NOT NULL)
  )
);

CREATE TABLE git_connections (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  repository_identity_id TEXT NOT NULL REFERENCES repository_identities(id),
  provider TEXT NOT NULL CHECK (provider = 'github'),
  installation_id TEXT NOT NULL,
  provider_repository_id TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  last_known_commit_sha TEXT NOT NULL CHECK (
    length(last_known_commit_sha) = 40 AND last_known_commit_sha = lower(last_known_commit_sha)
  ),
  status TEXT NOT NULL DEFAULT 'VERIFIED' CHECK (status IN ('VERIFIED', 'ERROR')),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE git_audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_identity_id TEXT NOT NULL REFERENCES repository_identities(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('git-connected', 'git-synced', 'git-disconnected')),
  actor_id TEXT NOT NULL REFERENCES users(id),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(metadata) <= 1000)
);

CREATE INDEX github_connection_states_expires_idx ON github_connection_states(expires_at);
CREATE INDEX github_connection_states_user_project_idx ON github_connection_states(user_id, project_id);
CREATE INDEX git_connections_repository_idx ON git_connections(repository_identity_id);
CREATE INDEX git_audit_project_created_idx ON git_audit_events(project_id, created_at DESC, id DESC);
