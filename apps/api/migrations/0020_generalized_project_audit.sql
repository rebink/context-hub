PRAGMA foreign_keys = ON;

-- Domain tables remain transition truth. These two append-only tables preserve exact
-- actors and report payloads that their mutable projections could not retain.
ALTER TABLE graph_versions ADD COLUMN transition_actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE machine_credentials ADD COLUMN revoked_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT;

CREATE TABLE graph_reservation_events (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 3 AND 384),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  graph_version INTEGER NOT NULL CHECK(graph_version BETWEEN 1 AND 2147483647),
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 2147483647),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL,
  UNIQUE(project_id,graph_version,attempt),
  FOREIGN KEY(project_id,graph_version) REFERENCES graph_versions(project_id,version) ON DELETE RESTRICT,
  CHECK(id='graph:'||project_id||':'||graph_version||':reserved:'||attempt)
);
CREATE INDEX graph_reservation_events_project_time_idx ON graph_reservation_events(project_id,occurred_at DESC,id DESC);

CREATE TABLE sync_state_events (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 3 AND 384),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES mcp_principals(id) ON DELETE RESTRICT,
  client_id TEXT NOT NULL CHECK(length(client_id)=36),
  observation_sequence INTEGER NOT NULL CHECK(observation_sequence BETWEEN 1 AND 2147483647),
  report_outcome TEXT NOT NULL CHECK(report_outcome IN ('STATUS','SYNC_SUCCEEDED','SYNC_FAILED')),
  sync_status TEXT NOT NULL CHECK(sync_status IN ('CURRENT','GRAPH_STALE','LOCAL_REPOSITORY_AHEAD','REMOTE_GRAPH_AHEAD','NO_LOCAL_GRAPH','GRAPH_BUILDING','GRAPH_FAILED','COMMIT_MISMATCH')),
  failure_code TEXT CHECK(failure_code IS NULL OR (length(failure_code) BETWEEN 2 AND 64 AND failure_code=upper(failure_code) AND failure_code NOT GLOB '*[^A-Z0-9_]*')),
  occurred_at TEXT NOT NULL,
  UNIQUE(project_id,principal_id,client_id,observation_sequence),
  CHECK(id='sync:'||project_id||':'||principal_id||':'||client_id||':'||observation_sequence),
  CHECK((report_outcome='SYNC_FAILED')=(failure_code IS NOT NULL))
);
CREATE INDEX sync_state_events_project_time_idx ON sync_state_events(project_id,occurred_at DESC,id DESC);

-- Only the latest historical sync projection is provable. Earlier observations and all
-- historical graph reservation actors are deliberately omitted rather than inferred.
INSERT INTO sync_state_events(id,project_id,principal_id,client_id,observation_sequence,report_outcome,sync_status,failure_code,occurred_at)
SELECT 'sync:'||project_id||':'||principal_id||':'||client_id||':'||observation_sequence,
  project_id,principal_id,client_id,observation_sequence,report_outcome,sync_status,failure_code,last_seen_at
FROM sync_states;

CREATE TABLE project_audit_events (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 3 AND 512),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('PROJECT','ARTIFACT','GIT','TEAM','ADMINISTRATION','GRAPH_RESERVATION','MACHINE','MCP','SNAPSHOT','SYNC_STATE')),
  source_transition_id TEXT NOT NULL CHECK(length(source_transition_id) BETWEEN 1 AND 384),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('HUMAN','MACHINE','MCP','SYSTEM')),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 255),
  action TEXT NOT NULL CHECK(action IN (
    'PROJECT_CREATED','PROJECT_SETTINGS_UPDATED','ARTIFACT_CREATED','ARTIFACT_VERSION_CREATED','ARTIFACT_ARCHIVED',
    'GIT_CONNECTED','GIT_SYNCED','GIT_DISCONNECTED','MEMBER_INVITED','INVITATION_ACCEPTED','INVITATION_REVOKED',
    'MEMBER_ROLE_CHANGED','MEMBER_REMOVED','GRAPH_BUILD_RESERVED','GRAPH_CLAIMED','GRAPH_PUBLISHED','GRAPH_FAILED',
    'SNAPSHOT_CREATED','SNAPSHOT_CREATE_REJECTED','SNAPSHOT_CREATE_FAILED','SYNC_STATE_REPORTED',
    'MACHINE_CREDENTIAL_ISSUED','MACHINE_CREDENTIAL_ROTATED','MACHINE_CREDENTIAL_REVOKED',
    'MCP_CREDENTIAL_ISSUED','MCP_CREDENTIAL_ROTATED','MCP_CREDENTIAL_REVOKED','MCP_REQUEST'
  )),
  target_type TEXT NOT NULL CHECK(target_type IN ('PROJECT','ARTIFACT','ARTIFACT_VERSION','REPOSITORY','INVITATION','MEMBER','GRAPH_VERSION','SNAPSHOT','SYNC_CLIENT','MACHINE_CREDENTIAL','MCP_CREDENTIAL','MCP_OPERATION')),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 255),
  outcome TEXT NOT NULL CHECK(outcome IN ('SUCCEEDED','DENIED','FAILED')),
  metadata_json TEXT NOT NULL CHECK(
    length(metadata_json) BETWEEN 2 AND 2048 AND json_valid(metadata_json)
    AND json_type(metadata_json)='object' AND json(metadata_json)=metadata_json
    AND lower(metadata_json) NOT LIKE '%authorization%' AND lower(metadata_json) NOT LIKE '%cookie%'
    AND lower(metadata_json) NOT LIKE '%oauth%' AND lower(metadata_json) NOT LIKE '%secret%'
    AND lower(metadata_json) NOT LIKE '%token%' AND lower(metadata_json) NOT LIKE '%password%'
    AND lower(metadata_json) NOT LIKE '%content%' AND lower(metadata_json) NOT LIKE '%payload%'
    AND lower(metadata_json) NOT LIKE '%absolute_path%' AND lower(metadata_json) NOT LIKE '%query%'
    AND lower(metadata_json) NOT LIKE '%email%' AND lower(metadata_json) NOT LIKE '%login%'
  ),
  occurred_at TEXT NOT NULL,
  UNIQUE(source_kind,source_transition_id),
  CHECK(id=lower(source_kind)||':'||source_transition_id)
);
CREATE INDEX project_audit_events_project_time_idx ON project_audit_events(project_id,occurred_at DESC,id DESC);
CREATE INDEX project_audit_events_project_actor_time_idx ON project_audit_events(project_id,actor_kind,actor_id,occurred_at DESC,id DESC);
CREATE INDEX project_audit_events_project_action_time_idx ON project_audit_events(project_id,action,occurred_at DESC,id DESC);

-- This O(1) counter is installed before backfill, so the migration transaction aborts
-- on event 100,001 while exactly 100,000 materialized events are accepted.
CREATE TABLE project_audit_event_counts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  event_count INTEGER NOT NULL CHECK(event_count BETWEEN 0 AND 100000)
);
CREATE TRIGGER project_audit_events_capacity BEFORE INSERT ON project_audit_events BEGIN
  INSERT INTO project_audit_event_counts(project_id,event_count) VALUES(NEW.project_id,1)
  ON CONFLICT(project_id) DO UPDATE SET event_count=event_count+1;
END;

-- Every generalized field is rederived from its immutable/narrow source. Exact metadata
-- equality simultaneously enforces the per-action key set, types, order, and canonical JSON.
CREATE TRIGGER project_audit_events_source_guard BEFORE INSERT ON project_audit_events
WHEN NOT (
  (NEW.source_kind='PROJECT' AND EXISTS(SELECT 1 FROM projects s WHERE s.id=NEW.source_transition_id AND NEW.project_id=s.id AND NEW.actor_kind='HUMAN' AND NEW.actor_id=s.created_by AND NEW.action='PROJECT_CREATED' AND NEW.target_type='PROJECT' AND NEW.target_id=s.id AND NEW.outcome='SUCCEEDED' AND NEW.metadata_json='{}' AND NEW.occurred_at=s.created_at)) OR
  (NEW.source_kind='ARTIFACT' AND EXISTS(SELECT 1 FROM audit_events s WHERE s.id=NEW.source_transition_id AND NEW.project_id=s.project_id AND NEW.actor_kind='HUMAN' AND NEW.actor_id=s.actor_id AND NEW.action=CASE s.event_type WHEN 'artifact-created' THEN 'ARTIFACT_CREATED' ELSE 'ARTIFACT_VERSION_CREATED' END AND NEW.target_type=CASE s.event_type WHEN 'artifact-created' THEN 'ARTIFACT' ELSE 'ARTIFACT_VERSION' END AND NEW.target_id=CASE s.event_type WHEN 'artifact-created' THEN s.artifact_id ELSE s.artifact_id||':'||s.artifact_version END AND NEW.outcome='SUCCEEDED' AND NEW.metadata_json=json_object('version',s.artifact_version) AND NEW.occurred_at=s.created_at)) OR
  (NEW.source_kind='GIT' AND EXISTS(SELECT 1 FROM git_audit_events s WHERE s.id=NEW.source_transition_id AND NEW.project_id=s.project_id AND NEW.actor_kind='HUMAN' AND NEW.actor_id=s.actor_id AND NEW.action=CASE s.event_type WHEN 'git-connected' THEN 'GIT_CONNECTED' WHEN 'git-synced' THEN 'GIT_SYNCED' ELSE 'GIT_DISCONNECTED' END AND NEW.target_type='REPOSITORY' AND NEW.target_id=s.repository_identity_id AND NEW.outcome='SUCCEEDED' AND NEW.metadata_json='{}' AND NEW.occurred_at=s.created_at)) OR
  (NEW.source_kind='TEAM' AND EXISTS(SELECT 1 FROM team_events s WHERE s.transition_key=NEW.source_transition_id AND NEW.project_id=s.project_id AND NEW.actor_kind='HUMAN' AND NEW.actor_id=s.actor_user_id AND NEW.action=s.action AND NEW.target_type=CASE WHEN s.action IN ('MEMBER_INVITED','INVITATION_ACCEPTED','INVITATION_REVOKED') THEN 'INVITATION' ELSE 'MEMBER' END AND NEW.target_id=CASE WHEN s.action IN ('MEMBER_INVITED','INVITATION_ACCEPTED','INVITATION_REVOKED') THEN s.invitation_id ELSE s.target_user_id END AND NEW.outcome='SUCCEEDED' AND NEW.metadata_json=json_object('fromRole',s.from_role,'toRole',s.to_role,'targetUserId',s.target_user_id) AND NEW.occurred_at=s.created_at)) OR
  (NEW.source_kind='ADMINISTRATION' AND EXISTS(SELECT 1 FROM project_administration_events s WHERE s.transition_key=NEW.source_transition_id AND NEW.project_id=s.project_id AND NEW.actor_kind='HUMAN' AND NEW.actor_id=s.actor_user_id AND NEW.action=s.action AND NEW.target_type=s.target_type AND NEW.target_id=s.target_id AND NEW.outcome='SUCCEEDED' AND NEW.metadata_json=json_object('revision',s.transition_revision) AND NEW.occurred_at=s.created_at)) OR
  (NEW.source_kind='GRAPH_RESERVATION' AND EXISTS(SELECT 1 FROM graph_reservation_events s WHERE s.id=NEW.source_transition_id AND NEW.project_id=s.project_id AND NEW.actor_kind='HUMAN' AND NEW.actor_id=s.actor_user_id AND NEW.action='GRAPH_BUILD_RESERVED' AND NEW.target_type='GRAPH_VERSION' AND NEW.target_id=CAST(s.graph_version AS TEXT) AND NEW.outcome='SUCCEEDED' AND NEW.metadata_json=json_object('attempt',s.attempt) AND NEW.occurred_at=s.occurred_at)) OR
  (NEW.source_kind='MACHINE' AND EXISTS(SELECT 1 FROM machine_audit_events s WHERE s.id=NEW.source_transition_id AND NEW.project_id=s.project_id AND NEW.actor_kind=CASE WHEN s.actor_user_id IS NOT NULL THEN 'HUMAN' ELSE 'MACHINE' END AND NEW.actor_id=COALESCE(s.actor_user_id,s.principal_id) AND NEW.action=CASE s.action WHEN 'CREDENTIAL_ISSUED' THEN 'MACHINE_CREDENTIAL_ISSUED' WHEN 'CREDENTIAL_ROTATED' THEN 'MACHINE_CREDENTIAL_ROTATED' WHEN 'CREDENTIAL_REVOKED' THEN 'MACHINE_CREDENTIAL_REVOKED' ELSE s.action END AND NEW.target_type=CASE WHEN s.action LIKE 'CREDENTIAL_%' THEN 'MACHINE_CREDENTIAL' ELSE 'GRAPH_VERSION' END AND NEW.target_id=CASE WHEN s.action LIKE 'CREDENTIAL_%' THEN s.credential_id ELSE CAST(s.graph_version AS TEXT) END AND NEW.outcome=CASE WHEN s.action='GRAPH_FAILED' AND s.outcome='SUCCEEDED' THEN 'FAILED' ELSE s.outcome END AND NEW.metadata_json=json_object('attempt',s.attempt) AND NEW.occurred_at=s.created_at AND ((s.action LIKE 'CREDENTIAL_%' AND EXISTS(SELECT 1 FROM machine_credentials c JOIN machine_principals p ON p.id=c.principal_id WHERE c.id=s.credential_id AND p.project_id=s.project_id)) OR (s.action LIKE 'GRAPH_%' AND EXISTS(SELECT 1 FROM graph_versions g WHERE g.project_id=s.project_id AND g.version=s.graph_version))))) OR
  (NEW.source_kind='MCP' AND EXISTS(SELECT 1 FROM mcp_audit_events s WHERE s.id=NEW.source_transition_id AND s.project_id IS NOT NULL AND NEW.project_id=s.project_id AND NEW.actor_kind=CASE WHEN s.actor_user_id IS NOT NULL THEN 'HUMAN' ELSE 'MCP' END AND NEW.actor_id=COALESCE(s.actor_user_id,s.principal_id) AND NEW.action=CASE s.action WHEN 'CREDENTIAL_ISSUED' THEN 'MCP_CREDENTIAL_ISSUED' WHEN 'CREDENTIAL_ROTATED' THEN 'MCP_CREDENTIAL_ROTATED' WHEN 'CREDENTIAL_REVOKED' THEN 'MCP_CREDENTIAL_REVOKED' ELSE 'MCP_REQUEST' END AND NEW.target_type=CASE WHEN s.action='MCP_REQUEST' THEN 'MCP_OPERATION' ELSE 'MCP_CREDENTIAL' END AND NEW.target_id=CASE WHEN s.action='MCP_REQUEST' THEN s.operation ELSE s.credential_id END AND NEW.outcome=s.outcome AND NEW.metadata_json='{}' AND NEW.occurred_at=s.created_at AND EXISTS(SELECT 1 FROM mcp_principal_projects scope WHERE scope.principal_id=s.principal_id AND scope.project_id=s.project_id))) OR
  (NEW.source_kind='SNAPSHOT' AND EXISTS(SELECT 1 FROM snapshot_events s WHERE s.id=NEW.source_transition_id AND NEW.project_id=s.project_id AND NEW.actor_kind='HUMAN' AND NEW.actor_id=s.actor_id AND NEW.action=CASE WHEN s.outcome='SUCCESS' THEN 'SNAPSHOT_CREATED' WHEN s.outcome='REJECTED' THEN 'SNAPSHOT_CREATE_REJECTED' ELSE 'SNAPSHOT_CREATE_FAILED' END AND NEW.target_type=CASE WHEN s.snapshot_id IS NULL THEN 'PROJECT' ELSE 'SNAPSHOT' END AND NEW.target_id=COALESCE(s.snapshot_id,s.project_id) AND NEW.outcome=CASE WHEN s.outcome='SUCCESS' THEN 'SUCCEEDED' WHEN s.outcome='REJECTED' THEN 'DENIED' ELSE 'FAILED' END AND NEW.metadata_json=CASE WHEN s.reason IS NULL THEN '{}' ELSE json_object('reasonCode',s.reason) END AND NEW.occurred_at=s.created_at)) OR
  (NEW.source_kind='SYNC_STATE' AND EXISTS(SELECT 1 FROM sync_state_events s WHERE s.id=NEW.source_transition_id AND NEW.project_id=s.project_id AND NEW.actor_kind='MCP' AND NEW.actor_id=s.principal_id AND NEW.action='SYNC_STATE_REPORTED' AND NEW.target_type='SYNC_CLIENT' AND NEW.target_id=s.client_id AND NEW.outcome=CASE WHEN s.report_outcome='SYNC_FAILED' THEN 'FAILED' ELSE 'SUCCEEDED' END AND NEW.metadata_json=json_object('observationSequence',s.observation_sequence,'reportOutcome',s.report_outcome,'status',s.sync_status,'failureCode',s.failure_code) AND NEW.occurred_at=s.occurred_at))
)
BEGIN SELECT RAISE(ABORT,'invalid project audit source contract'); END;

-- Truthful exact historical materialization.
INSERT INTO project_audit_events SELECT 'project:'||id,'PROJECT',id,id,'HUMAN',created_by,'PROJECT_CREATED','PROJECT',id,'SUCCEEDED','{}',created_at FROM projects;
INSERT INTO project_audit_events SELECT 'artifact:'||id,'ARTIFACT',id,project_id,'HUMAN',actor_id,CASE event_type WHEN 'artifact-created' THEN 'ARTIFACT_CREATED' ELSE 'ARTIFACT_VERSION_CREATED' END,CASE event_type WHEN 'artifact-created' THEN 'ARTIFACT' ELSE 'ARTIFACT_VERSION' END,CASE event_type WHEN 'artifact-created' THEN artifact_id ELSE artifact_id||':'||artifact_version END,'SUCCEEDED',json_object('version',artifact_version),created_at FROM audit_events;
INSERT INTO project_audit_events SELECT 'git:'||id,'GIT',id,project_id,'HUMAN',actor_id,CASE event_type WHEN 'git-connected' THEN 'GIT_CONNECTED' WHEN 'git-synced' THEN 'GIT_SYNCED' ELSE 'GIT_DISCONNECTED' END,'REPOSITORY',repository_identity_id,'SUCCEEDED','{}',created_at FROM git_audit_events;
INSERT INTO project_audit_events SELECT 'team:'||transition_key,'TEAM',transition_key,project_id,'HUMAN',actor_user_id,action,CASE WHEN action IN ('MEMBER_INVITED','INVITATION_ACCEPTED','INVITATION_REVOKED') THEN 'INVITATION' ELSE 'MEMBER' END,CASE WHEN action IN ('MEMBER_INVITED','INVITATION_ACCEPTED','INVITATION_REVOKED') THEN invitation_id ELSE target_user_id END,'SUCCEEDED',json_object('fromRole',from_role,'toRole',to_role,'targetUserId',target_user_id),created_at FROM team_events;
INSERT INTO project_audit_events SELECT 'administration:'||transition_key,'ADMINISTRATION',transition_key,project_id,'HUMAN',actor_user_id,action,target_type,target_id,'SUCCEEDED',json_object('revision',transition_revision),created_at FROM project_administration_events;
INSERT INTO project_audit_events SELECT 'graph_reservation:'||id,'GRAPH_RESERVATION',id,project_id,'HUMAN',actor_user_id,'GRAPH_BUILD_RESERVED','GRAPH_VERSION',CAST(graph_version AS TEXT),'SUCCEEDED',json_object('attempt',attempt),occurred_at FROM graph_reservation_events;
INSERT INTO project_audit_events SELECT 'machine:'||id,'MACHINE',id,project_id,CASE WHEN actor_user_id IS NOT NULL THEN 'HUMAN' ELSE 'MACHINE' END,COALESCE(actor_user_id,principal_id),CASE action WHEN 'CREDENTIAL_ISSUED' THEN 'MACHINE_CREDENTIAL_ISSUED' WHEN 'CREDENTIAL_ROTATED' THEN 'MACHINE_CREDENTIAL_ROTATED' WHEN 'CREDENTIAL_REVOKED' THEN 'MACHINE_CREDENTIAL_REVOKED' ELSE action END,CASE WHEN action LIKE 'CREDENTIAL_%' THEN 'MACHINE_CREDENTIAL' ELSE 'GRAPH_VERSION' END,CASE WHEN action LIKE 'CREDENTIAL_%' THEN credential_id ELSE CAST(graph_version AS TEXT) END,CASE WHEN action='GRAPH_FAILED' AND outcome='SUCCEEDED' THEN 'FAILED' ELSE outcome END,json_object('attempt',attempt),created_at FROM machine_audit_events WHERE COALESCE(actor_user_id,principal_id) IS NOT NULL AND COALESCE(credential_id,CAST(graph_version AS TEXT)) IS NOT NULL AND ((action LIKE 'CREDENTIAL_%' AND EXISTS(SELECT 1 FROM machine_credentials c JOIN machine_principals p ON p.id=c.principal_id WHERE c.id=machine_audit_events.credential_id AND p.project_id=machine_audit_events.project_id)) OR (action LIKE 'GRAPH_%' AND EXISTS(SELECT 1 FROM graph_versions g WHERE g.project_id=machine_audit_events.project_id AND g.version=machine_audit_events.graph_version)));
INSERT INTO project_audit_events SELECT 'mcp:'||id,'MCP',id,project_id,CASE WHEN actor_user_id IS NOT NULL THEN 'HUMAN' ELSE 'MCP' END,COALESCE(actor_user_id,principal_id),CASE action WHEN 'CREDENTIAL_ISSUED' THEN 'MCP_CREDENTIAL_ISSUED' WHEN 'CREDENTIAL_ROTATED' THEN 'MCP_CREDENTIAL_ROTATED' WHEN 'CREDENTIAL_REVOKED' THEN 'MCP_CREDENTIAL_REVOKED' ELSE 'MCP_REQUEST' END,CASE WHEN action='MCP_REQUEST' THEN 'MCP_OPERATION' ELSE 'MCP_CREDENTIAL' END,CASE WHEN action='MCP_REQUEST' THEN operation ELSE credential_id END,outcome,'{}',created_at FROM mcp_audit_events WHERE project_id IS NOT NULL AND COALESCE(operation,credential_id) IS NOT NULL AND EXISTS(SELECT 1 FROM mcp_principal_projects scope WHERE scope.principal_id=mcp_audit_events.principal_id AND scope.project_id=mcp_audit_events.project_id);
INSERT INTO project_audit_events SELECT 'snapshot:'||id,'SNAPSHOT',id,project_id,'HUMAN',actor_id,CASE WHEN outcome='SUCCESS' THEN 'SNAPSHOT_CREATED' WHEN outcome='REJECTED' THEN 'SNAPSHOT_CREATE_REJECTED' ELSE 'SNAPSHOT_CREATE_FAILED' END,CASE WHEN snapshot_id IS NULL THEN 'PROJECT' ELSE 'SNAPSHOT' END,COALESCE(snapshot_id,project_id),CASE WHEN outcome='SUCCESS' THEN 'SUCCEEDED' WHEN outcome='REJECTED' THEN 'DENIED' ELSE 'FAILED' END,CASE WHEN reason IS NULL THEN '{}' ELSE json_object('reasonCode',reason) END,created_at FROM snapshot_events;
INSERT INTO project_audit_events SELECT 'sync_state:'||id,'SYNC_STATE',id,project_id,'MCP',principal_id,'SYNC_STATE_REPORTED','SYNC_CLIENT',client_id,CASE WHEN report_outcome='SYNC_FAILED' THEN 'FAILED' ELSE 'SUCCEEDED' END,json_object('observationSequence',observation_sequence,'reportOutcome',report_outcome,'status',sync_status,'failureCode',failure_code),occurred_at FROM sync_state_events;

CREATE TRIGGER project_audit_events_immutable_update BEFORE UPDATE ON project_audit_events BEGIN SELECT RAISE(ABORT,'project audit event is immutable'); END;
CREATE TRIGGER project_audit_events_immutable_delete BEFORE DELETE ON project_audit_events BEGIN SELECT RAISE(ABORT,'project audit event is immutable'); END;
CREATE TRIGGER graph_reservation_events_immutable_update BEFORE UPDATE ON graph_reservation_events BEGIN SELECT RAISE(ABORT,'graph reservation event is immutable'); END;
CREATE TRIGGER graph_reservation_events_immutable_delete BEFORE DELETE ON graph_reservation_events BEGIN SELECT RAISE(ABORT,'graph reservation event is immutable'); END;
CREATE TRIGGER sync_state_events_immutable_update BEFORE UPDATE ON sync_state_events BEGIN SELECT RAISE(ABORT,'sync state event is immutable'); END;
CREATE TRIGGER sync_state_events_immutable_delete BEFORE DELETE ON sync_state_events BEGIN SELECT RAISE(ABORT,'sync state event is immutable'); END;
CREATE TRIGGER audit_events_immutable_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'artifact audit event is immutable'); END;
CREATE TRIGGER audit_events_immutable_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'artifact audit event is immutable'); END;
CREATE TRIGGER git_audit_events_immutable_update BEFORE UPDATE ON git_audit_events BEGIN SELECT RAISE(ABORT,'git audit event is immutable'); END;
CREATE TRIGGER git_audit_events_immutable_delete BEFORE DELETE ON git_audit_events BEGIN SELECT RAISE(ABORT,'git audit event is immutable'); END;

-- Future directly inserted legacy evidence must prove the exact authoritative transition.
CREATE TRIGGER audit_events_insert_guard BEFORE INSERT ON audit_events WHEN NOT EXISTS(
  SELECT 1 FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.id
  WHERE a.id=NEW.artifact_id AND a.project_id=NEW.project_id AND v.version=NEW.artifact_version
    AND v.created_by=NEW.actor_id AND v.created_at=NEW.created_at
    AND (NEW.event_type='version-created' OR (NEW.event_type='artifact-created' AND NEW.artifact_version=1 AND a.created_by=NEW.actor_id AND a.created_at=NEW.created_at))
) BEGIN SELECT RAISE(ABORT,'invalid artifact audit source'); END;
CREATE TRIGGER git_audit_events_insert_guard BEFORE INSERT ON git_audit_events WHEN NOT EXISTS(
  SELECT 1 FROM projects p JOIN project_members admin ON admin.project_id=p.id
  JOIN git_connections gc ON gc.project_id=p.id JOIN project_repositories pr ON pr.project_id=p.id AND pr.repository_identity_id=gc.repository_identity_id
  WHERE p.id=NEW.project_id AND p.status='ACTIVE' AND admin.user_id=NEW.actor_id AND admin.role='ADMIN' AND gc.repository_identity_id=NEW.repository_identity_id
) BEGIN SELECT RAISE(ABORT,'invalid git audit source'); END;
CREATE TRIGGER machine_credential_revocation_actor_guard BEFORE UPDATE OF revoked_at,revoked_by_user_id ON machine_credentials
WHEN NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by_user_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM machine_principals p JOIN project_members admin ON admin.project_id=p.project_id
  WHERE p.id=NEW.principal_id AND admin.user_id=NEW.revoked_by_user_id AND admin.role='ADMIN'
)) BEGIN SELECT RAISE(ABORT,'invalid machine credential revocation actor'); END;
CREATE TRIGGER machine_credential_revocation_actor_immutable BEFORE UPDATE OF revoked_by_user_id ON machine_credentials
WHEN OLD.revoked_by_user_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable machine credential revocation actor'); END;
CREATE TRIGGER machine_audit_exact_guard BEFORE INSERT ON machine_audit_events WHEN NOT (
  (NEW.action LIKE 'CREDENTIAL_%' AND NEW.outcome='SUCCEEDED' AND NEW.actor_user_id IS NOT NULL AND NEW.principal_id IS NULL AND NEW.credential_id IS NOT NULL AND NEW.graph_version IS NULL AND NEW.attempt IS NULL AND EXISTS(SELECT 1 FROM machine_credentials c JOIN machine_principals p ON p.id=c.principal_id WHERE c.id=NEW.credential_id AND p.project_id=NEW.project_id AND ((NEW.action='CREDENTIAL_ISSUED' AND c.created_by=NEW.actor_user_id AND c.created_at=NEW.created_at AND NOT EXISTS(SELECT 1 FROM machine_credentials old WHERE old.replaced_by_credential_id=c.id)) OR (NEW.action='CREDENTIAL_ROTATED' AND c.created_by=NEW.actor_user_id AND c.created_at=NEW.created_at AND EXISTS(SELECT 1 FROM machine_credentials old WHERE old.replaced_by_credential_id=c.id AND old.revoked_at=c.created_at AND old.revoked_by_user_id=NEW.actor_user_id)) OR (NEW.action='CREDENTIAL_REVOKED' AND c.revoked_by_user_id=NEW.actor_user_id AND c.revoked_at=NEW.created_at AND c.replaced_by_credential_id IS NULL)))) OR
  (NEW.action LIKE 'GRAPH_%' AND NEW.actor_user_id IS NULL AND NEW.principal_id IS NOT NULL AND NEW.credential_id IS NOT NULL AND NEW.graph_version IS NOT NULL AND EXISTS(SELECT 1 FROM machine_credentials c JOIN machine_principals p ON p.id=c.principal_id JOIN graph_versions g ON g.project_id=p.project_id AND g.version=NEW.graph_version WHERE c.id=NEW.credential_id AND p.id=NEW.principal_id AND p.project_id=NEW.project_id))
) BEGIN SELECT RAISE(ABORT,'invalid machine audit source'); END;
CREATE TRIGGER mcp_audit_exact_guard BEFORE INSERT ON mcp_audit_events WHEN NOT (
  (NEW.action='MCP_REQUEST' AND NEW.actor_user_id IS NULL AND NEW.credential_id IS NOT NULL AND NEW.operation IS NOT NULL AND (NEW.project_id IS NULL OR EXISTS(SELECT 1 FROM mcp_principal_projects s WHERE s.principal_id=NEW.principal_id AND s.project_id=NEW.project_id))) OR
  (NEW.action<>'MCP_REQUEST' AND NEW.outcome='SUCCEEDED' AND NEW.actor_user_id IS NOT NULL AND NEW.credential_id IS NOT NULL AND NEW.operation IS NULL AND NEW.project_id IS NOT NULL AND EXISTS(SELECT 1 FROM mcp_credentials c JOIN mcp_principal_projects s ON s.principal_id=c.principal_id WHERE c.id=NEW.credential_id AND c.principal_id=NEW.principal_id AND s.project_id=NEW.project_id))
) BEGIN SELECT RAISE(ABORT,'invalid mcp audit source'); END;
CREATE TRIGGER graph_reservation_events_insert_guard BEFORE INSERT ON graph_reservation_events WHEN NOT EXISTS(
  SELECT 1 FROM graph_versions g JOIN projects p ON p.id=g.project_id JOIN project_members admin ON admin.project_id=p.id
  WHERE g.project_id=NEW.project_id AND g.version=NEW.graph_version AND g.status='QUEUED' AND g.attempt=NEW.attempt
    AND g.transition_actor_user_id=NEW.actor_user_id AND g.updated_at=NEW.occurred_at
    AND p.status='ACTIVE' AND admin.user_id=NEW.actor_user_id AND admin.role='ADMIN'
) BEGIN SELECT RAISE(ABORT,'invalid graph reservation event'); END;
CREATE TRIGGER sync_state_events_insert_guard BEFORE INSERT ON sync_state_events WHEN NOT EXISTS(
  SELECT 1 FROM sync_states s WHERE s.project_id=NEW.project_id AND s.principal_id=NEW.principal_id AND s.client_id=NEW.client_id
    AND s.observation_sequence=NEW.observation_sequence AND s.report_outcome=NEW.report_outcome AND s.sync_status=NEW.sync_status
    AND s.failure_code IS NEW.failure_code AND s.last_seen_at=NEW.occurred_at
) BEGIN SELECT RAISE(ABORT,'invalid sync state event'); END;
CREATE TRIGGER graph_transition_actor_guard BEFORE UPDATE OF transition_actor_user_id ON graph_versions
WHEN NOT (OLD.status='FAILED' AND NEW.status='QUEUED' AND NEW.transition_actor_user_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid graph transition actor'); END;

DROP TRIGGER mcp_credential_revoke_audit;
CREATE TRIGGER mcp_credential_revoke_audit AFTER UPDATE OF revoked_at ON mcp_credentials
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.replaced_by_credential_id IS NULL BEGIN
  INSERT INTO mcp_audit_events(id,principal_id,credential_id,actor_user_id,project_id,action,outcome)
  SELECT 'mcp-revoke:'||NEW.id||':'||scope.project_id,NEW.principal_id,NEW.id,NEW.revoked_by_user_id,scope.project_id,'CREDENTIAL_REVOKED','SUCCEEDED'
  FROM mcp_principal_projects scope WHERE scope.principal_id=NEW.principal_id;
END;

-- Immutable source bridges. A generalized insert failure rolls back its source transition.
CREATE TRIGGER project_audit_bridge AFTER INSERT ON projects BEGIN
  INSERT INTO project_audit_events VALUES('project:'||NEW.id,'PROJECT',NEW.id,NEW.id,'HUMAN',NEW.created_by,'PROJECT_CREATED','PROJECT',NEW.id,'SUCCEEDED','{}',NEW.created_at);
END;
CREATE TRIGGER artifact_audit_bridge AFTER INSERT ON audit_events BEGIN
  INSERT INTO project_audit_events VALUES('artifact:'||NEW.id,'ARTIFACT',NEW.id,NEW.project_id,'HUMAN',NEW.actor_id,CASE NEW.event_type WHEN 'artifact-created' THEN 'ARTIFACT_CREATED' ELSE 'ARTIFACT_VERSION_CREATED' END,CASE NEW.event_type WHEN 'artifact-created' THEN 'ARTIFACT' ELSE 'ARTIFACT_VERSION' END,CASE NEW.event_type WHEN 'artifact-created' THEN NEW.artifact_id ELSE NEW.artifact_id||':'||NEW.artifact_version END,'SUCCEEDED',json_object('version',NEW.artifact_version),NEW.created_at);
END;
CREATE TRIGGER git_audit_bridge AFTER INSERT ON git_audit_events BEGIN
  INSERT INTO project_audit_events VALUES('git:'||NEW.id,'GIT',NEW.id,NEW.project_id,'HUMAN',NEW.actor_id,CASE NEW.event_type WHEN 'git-connected' THEN 'GIT_CONNECTED' WHEN 'git-synced' THEN 'GIT_SYNCED' ELSE 'GIT_DISCONNECTED' END,'REPOSITORY',NEW.repository_identity_id,'SUCCEEDED','{}',NEW.created_at);
END;
CREATE TRIGGER team_audit_bridge AFTER INSERT ON team_events BEGIN
  INSERT INTO project_audit_events VALUES('team:'||NEW.transition_key,'TEAM',NEW.transition_key,NEW.project_id,'HUMAN',NEW.actor_user_id,NEW.action,CASE WHEN NEW.action IN ('MEMBER_INVITED','INVITATION_ACCEPTED','INVITATION_REVOKED') THEN 'INVITATION' ELSE 'MEMBER' END,CASE WHEN NEW.action IN ('MEMBER_INVITED','INVITATION_ACCEPTED','INVITATION_REVOKED') THEN NEW.invitation_id ELSE NEW.target_user_id END,'SUCCEEDED',json_object('fromRole',NEW.from_role,'toRole',NEW.to_role,'targetUserId',NEW.target_user_id),NEW.created_at);
END;
CREATE TRIGGER administration_audit_bridge AFTER INSERT ON project_administration_events BEGIN
  INSERT INTO project_audit_events VALUES('administration:'||NEW.transition_key,'ADMINISTRATION',NEW.transition_key,NEW.project_id,'HUMAN',NEW.actor_user_id,NEW.action,NEW.target_type,NEW.target_id,'SUCCEEDED',json_object('revision',NEW.transition_revision),NEW.created_at);
END;
CREATE TRIGGER graph_reservation_audit_bridge AFTER INSERT ON graph_reservation_events BEGIN
  INSERT INTO project_audit_events VALUES('graph_reservation:'||NEW.id,'GRAPH_RESERVATION',NEW.id,NEW.project_id,'HUMAN',NEW.actor_user_id,'GRAPH_BUILD_RESERVED','GRAPH_VERSION',CAST(NEW.graph_version AS TEXT),'SUCCEEDED',json_object('attempt',NEW.attempt),NEW.occurred_at);
END;
CREATE TRIGGER machine_audit_bridge AFTER INSERT ON machine_audit_events WHEN COALESCE(NEW.actor_user_id,NEW.principal_id) IS NOT NULL AND COALESCE(NEW.credential_id,CAST(NEW.graph_version AS TEXT)) IS NOT NULL AND ((NEW.action LIKE 'CREDENTIAL_%' AND EXISTS(SELECT 1 FROM machine_credentials c JOIN machine_principals p ON p.id=c.principal_id WHERE c.id=NEW.credential_id AND p.project_id=NEW.project_id)) OR (NEW.action LIKE 'GRAPH_%' AND EXISTS(SELECT 1 FROM graph_versions g WHERE g.project_id=NEW.project_id AND g.version=NEW.graph_version))) BEGIN
  INSERT INTO project_audit_events VALUES('machine:'||NEW.id,'MACHINE',NEW.id,NEW.project_id,CASE WHEN NEW.actor_user_id IS NOT NULL THEN 'HUMAN' ELSE 'MACHINE' END,COALESCE(NEW.actor_user_id,NEW.principal_id),CASE NEW.action WHEN 'CREDENTIAL_ISSUED' THEN 'MACHINE_CREDENTIAL_ISSUED' WHEN 'CREDENTIAL_ROTATED' THEN 'MACHINE_CREDENTIAL_ROTATED' WHEN 'CREDENTIAL_REVOKED' THEN 'MACHINE_CREDENTIAL_REVOKED' ELSE NEW.action END,CASE WHEN NEW.action LIKE 'CREDENTIAL_%' THEN 'MACHINE_CREDENTIAL' ELSE 'GRAPH_VERSION' END,CASE WHEN NEW.action LIKE 'CREDENTIAL_%' THEN NEW.credential_id ELSE CAST(NEW.graph_version AS TEXT) END,CASE WHEN NEW.action='GRAPH_FAILED' AND NEW.outcome='SUCCEEDED' THEN 'FAILED' ELSE NEW.outcome END,json_object('attempt',NEW.attempt),NEW.created_at);
END;
CREATE TRIGGER mcp_audit_bridge AFTER INSERT ON mcp_audit_events WHEN NEW.project_id IS NOT NULL AND COALESCE(NEW.operation,NEW.credential_id) IS NOT NULL BEGIN
  INSERT INTO project_audit_events VALUES('mcp:'||NEW.id,'MCP',NEW.id,NEW.project_id,CASE WHEN NEW.actor_user_id IS NOT NULL THEN 'HUMAN' ELSE 'MCP' END,COALESCE(NEW.actor_user_id,NEW.principal_id),CASE NEW.action WHEN 'CREDENTIAL_ISSUED' THEN 'MCP_CREDENTIAL_ISSUED' WHEN 'CREDENTIAL_ROTATED' THEN 'MCP_CREDENTIAL_ROTATED' WHEN 'CREDENTIAL_REVOKED' THEN 'MCP_CREDENTIAL_REVOKED' ELSE 'MCP_REQUEST' END,CASE WHEN NEW.action='MCP_REQUEST' THEN 'MCP_OPERATION' ELSE 'MCP_CREDENTIAL' END,CASE WHEN NEW.action='MCP_REQUEST' THEN NEW.operation ELSE NEW.credential_id END,NEW.outcome,'{}',NEW.created_at);
END;
CREATE TRIGGER snapshot_audit_bridge AFTER INSERT ON snapshot_events BEGIN
  INSERT INTO project_audit_events VALUES('snapshot:'||NEW.id,'SNAPSHOT',NEW.id,NEW.project_id,'HUMAN',NEW.actor_id,CASE WHEN NEW.outcome='SUCCESS' THEN 'SNAPSHOT_CREATED' WHEN NEW.outcome='REJECTED' THEN 'SNAPSHOT_CREATE_REJECTED' ELSE 'SNAPSHOT_CREATE_FAILED' END,CASE WHEN NEW.snapshot_id IS NULL THEN 'PROJECT' ELSE 'SNAPSHOT' END,COALESCE(NEW.snapshot_id,NEW.project_id),CASE WHEN NEW.outcome='SUCCESS' THEN 'SUCCEEDED' WHEN NEW.outcome='REJECTED' THEN 'DENIED' ELSE 'FAILED' END,CASE WHEN NEW.reason IS NULL THEN '{}' ELSE json_object('reasonCode',NEW.reason) END,NEW.created_at);
END;
CREATE TRIGGER sync_state_audit_bridge AFTER INSERT ON sync_state_events BEGIN
  INSERT INTO project_audit_events VALUES('sync_state:'||NEW.id,'SYNC_STATE',NEW.id,NEW.project_id,'MCP',NEW.principal_id,'SYNC_STATE_REPORTED','SYNC_CLIENT',NEW.client_id,CASE WHEN NEW.report_outcome='SYNC_FAILED' THEN 'FAILED' ELSE 'SUCCEEDED' END,json_object('observationSequence',NEW.observation_sequence,'reportOutcome',NEW.report_outcome,'status',NEW.sync_status,'failureCode',NEW.failure_code),NEW.occurred_at);
END;

-- Projection transitions and immutable evidence share one SQLite statement.
CREATE TRIGGER graph_reservation_source_after_insert AFTER INSERT ON graph_versions WHEN NEW.transition_actor_user_id IS NOT NULL BEGIN
  INSERT INTO graph_reservation_events(id,project_id,graph_version,attempt,actor_user_id,occurred_at)
  VALUES('graph:'||NEW.project_id||':'||NEW.version||':reserved:'||NEW.attempt,NEW.project_id,NEW.version,NEW.attempt,NEW.transition_actor_user_id,NEW.updated_at);
END;
CREATE TRIGGER graph_reservation_source_after_retry AFTER UPDATE OF status ON graph_versions WHEN OLD.status='FAILED' AND NEW.status='QUEUED' AND NEW.transition_actor_user_id IS NOT NULL BEGIN
  INSERT INTO graph_reservation_events(id,project_id,graph_version,attempt,actor_user_id,occurred_at)
  VALUES('graph:'||NEW.project_id||':'||NEW.version||':reserved:'||NEW.attempt,NEW.project_id,NEW.version,NEW.attempt,NEW.transition_actor_user_id,NEW.updated_at);
END;
CREATE TRIGGER sync_state_source_after_insert AFTER INSERT ON sync_states BEGIN
  INSERT INTO sync_state_events(id,project_id,principal_id,client_id,observation_sequence,report_outcome,sync_status,failure_code,occurred_at)
  VALUES('sync:'||NEW.project_id||':'||NEW.principal_id||':'||NEW.client_id||':'||NEW.observation_sequence,NEW.project_id,NEW.principal_id,NEW.client_id,NEW.observation_sequence,NEW.report_outcome,NEW.sync_status,NEW.failure_code,NEW.last_seen_at);
END;
CREATE TRIGGER sync_state_source_after_update AFTER UPDATE OF observation_sequence ON sync_states WHEN NEW.observation_sequence>OLD.observation_sequence BEGIN
  INSERT INTO sync_state_events(id,project_id,principal_id,client_id,observation_sequence,report_outcome,sync_status,failure_code,occurred_at)
  VALUES('sync:'||NEW.project_id||':'||NEW.principal_id||':'||NEW.client_id||':'||NEW.observation_sequence,NEW.project_id,NEW.principal_id,NEW.client_id,NEW.observation_sequence,NEW.report_outcome,NEW.sync_status,NEW.failure_code,NEW.last_seen_at);
END;
