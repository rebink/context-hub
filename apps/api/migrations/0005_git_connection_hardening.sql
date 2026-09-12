PRAGMA foreign_keys = ON;

-- In-flight states created before session binding cannot be safely resumed.
ALTER TABLE github_connection_states
  ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
ALTER TABLE github_connection_states
  ADD COLUMN consumed_at TEXT;

-- Existing connections remain operable through their exact legacy tuple; new rows receive an ID.
ALTER TABLE git_connections ADD COLUMN connection_id TEXT;
CREATE UNIQUE INDEX git_connections_connection_id_idx
  ON git_connections(connection_id) WHERE connection_id IS NOT NULL;
CREATE INDEX github_connection_states_session_project_idx
  ON github_connection_states(session_id, project_id);

-- Resolution now requires this link to agree with the one verified connection for the project.
DELETE FROM project_repositories
WHERE NOT EXISTS (
  SELECT 1 FROM git_connections gc
  WHERE gc.project_id = project_repositories.project_id
    AND gc.repository_identity_id = project_repositories.repository_identity_id
);
CREATE UNIQUE INDEX project_repositories_one_per_project_idx
  ON project_repositories(project_id);
