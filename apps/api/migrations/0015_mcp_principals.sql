PRAGMA foreign_keys = ON;

-- MCP/local-client identities are deliberately separate from Phase 10 CI principals.
CREATE TABLE mcp_principals (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  repository_provider TEXT CHECK(repository_provider IS NULL OR length(repository_provider) BETWEEN 1 AND 32),
  provider_repository_id TEXT CHECK(provider_repository_id IS NULL OR length(provider_repository_id) BETWEEN 1 AND 255),
  repository_canonical_url TEXT CHECK(repository_canonical_url IS NULL OR length(repository_canonical_url) BETWEEN 1 AND 512),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  CHECK((repository_provider IS NULL) = (provider_repository_id IS NULL)),
  CHECK((repository_provider IS NULL) = (repository_canonical_url IS NULL)),
  CHECK((status='ACTIVE' AND revoked_at IS NULL) OR (status='REVOKED' AND revoked_at IS NOT NULL))
);
CREATE INDEX mcp_principals_owner_issued ON mcp_principals(owner_user_id, issued_at DESC);

CREATE TABLE mcp_principal_projects (
  principal_id TEXT NOT NULL REFERENCES mcp_principals(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  PRIMARY KEY(principal_id, project_id)
);
CREATE INDEX mcp_principal_projects_project ON mcp_principal_projects(project_id, principal_id);

CREATE TABLE mcp_principal_operations (
  principal_id TEXT NOT NULL REFERENCES mcp_principals(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK(operation IN ('project_info','search_context','get_artifact','query_graph','get_sources','sync_status')),
  PRIMARY KEY(principal_id, operation)
);

CREATE TABLE mcp_credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES mcp_principals(id) ON DELETE RESTRICT,
  secret_hash TEXT NOT NULL UNIQUE CHECK(length(secret_hash)=64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  replaced_by_credential_id TEXT REFERENCES mcp_credentials(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK(expires_at > issued_at),
  CHECK((revoked_at IS NULL AND revoked_by_user_id IS NULL) OR
        (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)),
  CHECK(replaced_by_credential_id IS NULL OR revoked_at IS NOT NULL)
);
CREATE INDEX mcp_credentials_principal_issued ON mcp_credentials(principal_id, issued_at DESC);
CREATE INDEX mcp_credentials_expiry ON mcp_credentials(expires_at);
CREATE UNIQUE INDEX mcp_credentials_one_active ON mcp_credentials(principal_id) WHERE revoked_at IS NULL;

CREATE TABLE mcp_request_nonces (
  credential_id TEXT NOT NULL REFERENCES mcp_credentials(id) ON DELETE RESTRICT,
  nonce_hash TEXT NOT NULL CHECK(length(nonce_hash)=64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  operation TEXT NOT NULL CHECK(operation IN ('PROTOCOL','NEGOTIATE','INITIALIZE','LIST_TOOLS','PING','project_info','search_context','get_artifact','query_graph','get_sources','sync_status')),
  scope_hash TEXT NOT NULL CHECK(length(scope_hash)=64 AND scope_hash NOT GLOB '*[^0-9a-f]*'),
  project_count INTEGER NOT NULL CHECK(project_count BETWEEN 0 AND 20),
  consumed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY(credential_id, nonce_hash)
);
CREATE INDEX mcp_request_nonces_expiry ON mcp_request_nonces(expires_at);
CREATE INDEX mcp_request_nonces_rate ON mcp_request_nonces(credential_id, consumed_at DESC);

CREATE TABLE mcp_audit_events (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES mcp_principals(id) ON DELETE RESTRICT,
  credential_id TEXT REFERENCES mcp_credentials(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('CREDENTIAL_ISSUED','CREDENTIAL_ROTATED','CREDENTIAL_REVOKED','MCP_REQUEST')),
  operation TEXT CHECK(operation IS NULL OR operation IN ('PROTOCOL','NEGOTIATE','INITIALIZE','LIST_TOOLS','PING','project_info','search_context','get_artifact','query_graph','get_sources','sync_status')),
  outcome TEXT NOT NULL CHECK(outcome IN ('SUCCEEDED','DENIED','FAILED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((action='MCP_REQUEST' AND credential_id IS NOT NULL AND actor_user_id IS NULL AND operation IS NOT NULL) OR
        (action<>'MCP_REQUEST' AND actor_user_id IS NOT NULL AND operation IS NULL))
);
CREATE INDEX mcp_audit_project_time ON mcp_audit_events(project_id, created_at DESC);
CREATE INDEX mcp_audit_principal_time ON mcp_audit_events(principal_id, created_at DESC);

CREATE TRIGGER mcp_principal_identity_immutable BEFORE UPDATE ON mcp_principals
WHEN NEW.id<>OLD.id OR NEW.owner_user_id<>OLD.owner_user_id OR NEW.name<>OLD.name OR
  NEW.repository_provider IS NOT OLD.repository_provider OR NEW.provider_repository_id IS NOT OLD.provider_repository_id OR
  NEW.repository_canonical_url IS NOT OLD.repository_canonical_url OR NEW.created_by<>OLD.created_by OR
  NEW.issued_at<>OLD.issued_at OR OLD.status='REVOKED'
BEGIN SELECT RAISE(ABORT,'immutable mcp principal identity'); END;
CREATE TRIGGER mcp_principal_project_sealed_insert BEFORE INSERT ON mcp_principal_projects
WHEN EXISTS (SELECT 1 FROM mcp_credentials WHERE principal_id=NEW.principal_id)
BEGIN SELECT RAISE(ABORT,'mcp project scope is sealed'); END;
CREATE TRIGGER mcp_principal_project_immutable_update BEFORE UPDATE ON mcp_principal_projects
BEGIN SELECT RAISE(ABORT,'mcp project scope is immutable'); END;
CREATE TRIGGER mcp_principal_project_immutable_delete BEFORE DELETE ON mcp_principal_projects
BEGIN SELECT RAISE(ABORT,'mcp project scope is immutable'); END;
CREATE TRIGGER mcp_principal_operation_sealed_insert BEFORE INSERT ON mcp_principal_operations
WHEN EXISTS (SELECT 1 FROM mcp_credentials WHERE principal_id=NEW.principal_id)
BEGIN SELECT RAISE(ABORT,'mcp operation scope is sealed'); END;
CREATE TRIGGER mcp_principal_operation_immutable_update BEFORE UPDATE ON mcp_principal_operations
BEGIN SELECT RAISE(ABORT,'mcp operation scope is immutable'); END;
CREATE TRIGGER mcp_principal_operation_immutable_delete BEFORE DELETE ON mcp_principal_operations
BEGIN SELECT RAISE(ABORT,'mcp operation scope is immutable'); END;
CREATE TRIGGER mcp_credential_identity_immutable BEFORE UPDATE ON mcp_credentials
WHEN NEW.id<>OLD.id OR NEW.principal_id<>OLD.principal_id OR NEW.secret_hash<>OLD.secret_hash OR
  NEW.expires_at<>OLD.expires_at OR NEW.created_by<>OLD.created_by OR NEW.issued_at<>OLD.issued_at OR
  OLD.revoked_at IS NOT NULL OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL AND
    (NEW.revoked_by_user_id IS NOT OLD.revoked_by_user_id OR NEW.replaced_by_credential_id IS NOT OLD.replaced_by_credential_id)) OR
  (OLD.last_used_at IS NOT NULL AND (NEW.last_used_at IS NULL OR NEW.last_used_at<OLD.last_used_at))
BEGIN SELECT RAISE(ABORT,'immutable mcp credential identity'); END;
CREATE TRIGGER mcp_project_scope_guard BEFORE INSERT ON mcp_principal_projects
WHEN NOT EXISTS (
  SELECT 1 FROM mcp_principals mp
  JOIN projects p ON p.id=NEW.project_id
  JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=mp.owner_user_id AND pm.role='ADMIN'
  JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=mp.owner_user_id
  WHERE mp.id=NEW.principal_id
)
BEGIN SELECT RAISE(ABORT,'invalid mcp project scope'); END;
CREATE TRIGGER mcp_credential_scope_guard BEFORE INSERT ON mcp_credentials
WHEN (SELECT COUNT(*) FROM mcp_principal_projects WHERE principal_id=NEW.principal_id) NOT BETWEEN 1 AND 20
  OR (SELECT COUNT(*) FROM mcp_principal_operations WHERE principal_id=NEW.principal_id) NOT BETWEEN 1 AND 6
  OR julianday(NEW.expires_at) IS NULL
  OR julianday(NEW.expires_at) <= julianday('now')
  OR julianday(NEW.expires_at) > julianday('now','+90 days')
BEGIN SELECT RAISE(ABORT,'invalid mcp credential scope or expiry'); END;
CREATE TRIGGER mcp_credential_replacement_guard AFTER INSERT ON mcp_credentials
WHEN EXISTS (
  SELECT 1 FROM mcp_credentials old
  WHERE old.replaced_by_credential_id=NEW.id AND old.principal_id<>NEW.principal_id
)
BEGIN SELECT RAISE(ABORT,'invalid mcp credential replacement'); END;
CREATE TRIGGER mcp_nonce_expiry_guard BEFORE INSERT ON mcp_request_nonces
WHEN julianday(NEW.expires_at) IS NULL
  OR julianday(NEW.expires_at) <= julianday('now')
  OR julianday(NEW.expires_at) > julianday('now','+1 hour')
BEGIN SELECT RAISE(ABORT,'invalid mcp nonce expiry'); END;
CREATE TRIGGER mcp_nonce_immutable_update BEFORE UPDATE ON mcp_request_nonces
BEGIN SELECT RAISE(ABORT,'mcp nonce is immutable'); END;
CREATE TRIGGER mcp_nonce_immutable_delete BEFORE DELETE ON mcp_request_nonces
WHEN OLD.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
BEGIN SELECT RAISE(ABORT,'unexpired mcp nonce is immutable'); END;
CREATE TRIGGER mcp_credential_revoke_audit AFTER UPDATE OF revoked_at ON mcp_credentials
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.replaced_by_credential_id IS NULL
BEGIN
  INSERT INTO mcp_audit_events
    (id,principal_id,credential_id,actor_user_id,project_id,action,outcome)
  VALUES('mcp-revoke:' || NEW.id,NEW.principal_id,NEW.id,NEW.revoked_by_user_id,NULL,
    'CREDENTIAL_REVOKED','SUCCEEDED');
END;
CREATE TRIGGER mcp_audit_scope_guard BEFORE INSERT ON mcp_audit_events
WHEN (NEW.credential_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM mcp_credentials mc WHERE mc.id=NEW.credential_id AND mc.principal_id=NEW.principal_id
)) OR (NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM mcp_principal_projects scope
  WHERE scope.principal_id=NEW.principal_id AND scope.project_id=NEW.project_id
))
BEGIN SELECT RAISE(ABORT,'invalid mcp audit scope'); END;
CREATE TRIGGER mcp_audit_immutable_update BEFORE UPDATE ON mcp_audit_events
BEGIN SELECT RAISE(ABORT,'mcp audit is immutable'); END;
CREATE TRIGGER mcp_audit_immutable_delete BEFORE DELETE ON mcp_audit_events
BEGIN SELECT RAISE(ABORT,'mcp audit is immutable'); END;
