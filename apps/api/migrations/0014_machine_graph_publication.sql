PRAGMA foreign_keys = ON;

CREATE TABLE machine_principals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  repository_provider TEXT NOT NULL CHECK(length(repository_provider) BETWEEN 1 AND 32),
  provider_repository_id TEXT NOT NULL CHECK(length(provider_repository_id) BETWEEN 1 AND 255),
  scope TEXT NOT NULL DEFAULT 'GRAPH_CLAIM_PUBLISH_FAIL' CHECK(scope='GRAPH_CLAIM_PUBLISH_FAIL'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  CHECK((status='ACTIVE' AND revoked_at IS NULL) OR (status='REVOKED' AND revoked_at IS NOT NULL))
);
CREATE INDEX machine_principals_project_created ON machine_principals(project_id, created_at DESC);
CREATE INDEX machine_principals_repository ON machine_principals(project_id, repository_provider, provider_repository_id);

CREATE TABLE machine_credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES machine_principals(id) ON DELETE RESTRICT,
  secret_hash TEXT NOT NULL UNIQUE CHECK(length(secret_hash)=64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  replaced_by_credential_id TEXT REFERENCES machine_credentials(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK(replaced_by_credential_id IS NULL OR revoked_at IS NOT NULL)
);
CREATE INDEX machine_credentials_principal_created ON machine_credentials(principal_id, created_at DESC);
CREATE INDEX machine_credentials_expiry ON machine_credentials(expires_at);
CREATE UNIQUE INDEX machine_credentials_one_active ON machine_credentials(principal_id) WHERE revoked_at IS NULL;

CREATE TABLE machine_request_nonces (
  credential_id TEXT NOT NULL REFERENCES machine_credentials(id) ON DELETE RESTRICT,
  nonce_hash TEXT NOT NULL CHECK(length(nonce_hash)=64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
  operation TEXT NOT NULL CHECK(operation IN ('CLAIM','PUBLISH','FAIL')),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  graph_version INTEGER NOT NULL CHECK(graph_version >= 1),
  expires_at TEXT NOT NULL,
  consumed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(credential_id, nonce_hash)
);
CREATE INDEX machine_request_nonces_expiry ON machine_request_nonces(expires_at);
CREATE INDEX machine_request_nonces_project_time ON machine_request_nonces(project_id, consumed_at DESC);

CREATE TABLE machine_audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  principal_id TEXT REFERENCES machine_principals(id) ON DELETE RESTRICT,
  credential_id TEXT REFERENCES machine_credentials(id) ON DELETE RESTRICT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('CREDENTIAL_ISSUED','CREDENTIAL_ROTATED','CREDENTIAL_REVOKED','GRAPH_CLAIMED','GRAPH_PUBLISHED','GRAPH_FAILED')),
  outcome TEXT NOT NULL CHECK(outcome IN ('SUCCEEDED','DENIED','FAILED')),
  graph_version INTEGER CHECK(graph_version IS NULL OR graph_version >= 1),
  attempt INTEGER CHECK(attempt IS NULL OR attempt >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((actor_user_id IS NULL) <> (principal_id IS NULL))
);
CREATE INDEX machine_audit_project_time ON machine_audit_events(project_id, created_at DESC);
CREATE INDEX machine_audit_principal_time ON machine_audit_events(principal_id, created_at DESC);

CREATE TRIGGER machine_principal_identity_immutable BEFORE UPDATE ON machine_principals
WHEN NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.name<>OLD.name OR
  NEW.repository_provider<>OLD.repository_provider OR NEW.provider_repository_id<>OLD.provider_repository_id OR
  NEW.scope<>OLD.scope OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR
  OLD.status='REVOKED' OR (OLD.status='ACTIVE' AND NEW.status NOT IN ('ACTIVE','REVOKED'))
BEGIN SELECT RAISE(ABORT,'immutable machine principal identity'); END;

CREATE TRIGGER machine_credential_identity_immutable BEFORE UPDATE ON machine_credentials
WHEN NEW.id<>OLD.id OR NEW.principal_id<>OLD.principal_id OR NEW.secret_hash<>OLD.secret_hash OR
  NEW.expires_at<>OLD.expires_at OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR
  OLD.revoked_at IS NOT NULL OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL AND NEW.replaced_by_credential_id IS NOT OLD.replaced_by_credential_id)
BEGIN SELECT RAISE(ABORT,'immutable machine credential identity'); END;

CREATE TRIGGER machine_nonce_immutable_update BEFORE UPDATE ON machine_request_nonces
BEGIN SELECT RAISE(ABORT,'machine nonce is immutable'); END;
CREATE TRIGGER machine_nonce_immutable_delete BEFORE DELETE ON machine_request_nonces
WHEN OLD.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
BEGIN SELECT RAISE(ABORT,'unexpired machine nonce is immutable'); END;
CREATE TRIGGER machine_audit_immutable_update BEFORE UPDATE ON machine_audit_events
BEGIN SELECT RAISE(ABORT,'machine audit is immutable'); END;
CREATE TRIGGER machine_audit_immutable_delete BEFORE DELETE ON machine_audit_events
BEGIN SELECT RAISE(ABORT,'machine audit is immutable'); END;

CREATE TRIGGER machine_nonce_project_guard BEFORE INSERT ON machine_request_nonces
WHEN NOT EXISTS (
  SELECT 1 FROM machine_credentials mc
  JOIN machine_principals mp ON mp.id=mc.principal_id
  JOIN graph_versions gv ON gv.project_id=mp.project_id
  WHERE mc.id=NEW.credential_id AND mp.project_id=NEW.project_id
    AND gv.project_id=NEW.project_id AND gv.version=NEW.graph_version
)
BEGIN SELECT RAISE(ABORT,'invalid machine nonce scope'); END;

CREATE TRIGGER machine_audit_scope_guard BEFORE INSERT ON machine_audit_events
WHEN NEW.credential_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM machine_credentials mc
  JOIN machine_principals mp ON mp.id=mc.principal_id
  WHERE mc.id=NEW.credential_id AND mp.project_id=NEW.project_id
    AND (NEW.principal_id IS NULL OR NEW.principal_id=mp.id)
)
BEGIN SELECT RAISE(ABORT,'invalid machine audit scope'); END;

-- Lifecycle success evidence is committed in the same D1 statement as the
-- attempt transition. A failed audit insert therefore rolls back the claim,
-- failure, or publication rather than returning an unaudited success.
CREATE TRIGGER machine_graph_claim_audit AFTER INSERT ON graph_build_attempts
WHEN NEW.status='BUILDING' AND EXISTS (
  SELECT 1 FROM machine_principals WHERE id=NEW.claimed_by AND project_id=NEW.project_id
)
BEGIN
  INSERT INTO machine_audit_events
    (id,project_id,principal_id,credential_id,actor_user_id,action,outcome,graph_version,attempt)
  VALUES (
    'graph:' || NEW.project_id || ':' || NEW.graph_version || ':' || NEW.attempt || ':claim',
    NEW.project_id,NEW.claimed_by,
    (SELECT mrn.credential_id FROM machine_request_nonces mrn
      JOIN machine_credentials mc ON mc.id=mrn.credential_id
      WHERE mc.principal_id=NEW.claimed_by AND mrn.project_id=NEW.project_id
        AND mrn.graph_version=NEW.graph_version AND mrn.operation='CLAIM'
      ORDER BY mrn.consumed_at DESC LIMIT 1),
    NULL,'GRAPH_CLAIMED','SUCCEEDED',NEW.graph_version,NEW.attempt
  );
END;

CREATE TRIGGER machine_graph_fail_audit AFTER UPDATE OF status ON graph_build_attempts
WHEN OLD.status='BUILDING' AND NEW.status='FAILED' AND EXISTS (
  SELECT 1 FROM machine_principals WHERE id=NEW.claimed_by AND project_id=NEW.project_id
)
BEGIN
  INSERT INTO machine_audit_events
    (id,project_id,principal_id,credential_id,actor_user_id,action,outcome,graph_version,attempt)
  VALUES (
    'graph:' || NEW.project_id || ':' || NEW.graph_version || ':' || NEW.attempt || ':fail',
    NEW.project_id,NEW.claimed_by,
    (SELECT mrn.credential_id FROM machine_request_nonces mrn
      JOIN machine_credentials mc ON mc.id=mrn.credential_id
      WHERE mc.principal_id=NEW.claimed_by AND mrn.project_id=NEW.project_id
        AND mrn.graph_version=NEW.graph_version AND mrn.operation IN ('FAIL','CLAIM')
      ORDER BY CASE mrn.operation WHEN 'FAIL' THEN 0 ELSE 1 END, mrn.consumed_at DESC LIMIT 1),
    NULL,'GRAPH_FAILED','SUCCEEDED',NEW.graph_version,NEW.attempt
  );
END;

CREATE TRIGGER machine_graph_publish_audit AFTER UPDATE OF status ON graph_build_attempts
WHEN OLD.status='BUILDING' AND NEW.status='PUBLISHED' AND EXISTS (
  SELECT 1 FROM machine_principals WHERE id=NEW.claimed_by AND project_id=NEW.project_id
)
BEGIN
  INSERT INTO machine_audit_events
    (id,project_id,principal_id,credential_id,actor_user_id,action,outcome,graph_version,attempt)
  VALUES (
    'graph:' || NEW.project_id || ':' || NEW.graph_version || ':' || NEW.attempt || ':publish',
    NEW.project_id,NEW.claimed_by,
    (SELECT mrn.credential_id FROM machine_request_nonces mrn
      JOIN machine_credentials mc ON mc.id=mrn.credential_id
      WHERE mc.principal_id=NEW.claimed_by AND mrn.project_id=NEW.project_id
        AND mrn.graph_version=NEW.graph_version AND mrn.operation='PUBLISH'
      ORDER BY mrn.consumed_at DESC LIMIT 1),
    NULL,'GRAPH_PUBLISHED','SUCCEEDED',NEW.graph_version,NEW.attempt
  );
END;
