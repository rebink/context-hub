PRAGMA foreign_keys = ON;

-- A verified connection is authoritative for its project's single repository link.
DELETE FROM project_repositories
WHERE EXISTS (
  SELECT 1 FROM git_connections gc
  WHERE gc.project_id = project_repositories.project_id
    AND gc.status = 'VERIFIED'
    AND gc.repository_identity_id <> project_repositories.repository_identity_id
);

INSERT OR IGNORE INTO project_repositories (project_id, repository_identity_id)
SELECT project_id, repository_identity_id
FROM git_connections
WHERE status = 'VERIFIED';
