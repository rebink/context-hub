PRAGMA foreign_keys = ON;

ALTER TABLE projects ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 1 CHECK(settings_revision BETWEEN 1 AND 2147483647);
ALTER TABLE projects ADD COLUMN settings_updated_at TEXT;
ALTER TABLE projects ADD COLUMN settings_updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE artifacts ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 1 CHECK(lifecycle_revision BETWEEN 1 AND 2147483647);
ALTER TABLE artifacts ADD COLUMN archived_at TEXT;
ALTER TABLE artifacts ADD COLUMN archived_by TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE artifacts ADD COLUMN archive_reason TEXT CHECK(archive_reason IS NULL OR (length(archive_reason) BETWEEN 1 AND 500));

CREATE INDEX artifacts_project_status_created_idx ON artifacts(project_id,status,created_at DESC,id DESC);

CREATE TRIGGER artifacts_lifecycle_insert_guard
BEFORE INSERT ON artifacts
FOR EACH ROW
WHEN NEW.status <> 'ACTIVE'
  OR NEW.lifecycle_revision <> 1
  OR NEW.archived_at IS NOT NULL
  OR NEW.archived_by IS NOT NULL
  OR NEW.archive_reason IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid initial artifact lifecycle');
END;

CREATE TABLE project_administration_events (
  id TEXT PRIMARY KEY,
  transition_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('PROJECT_SETTINGS_UPDATED','ARTIFACT_ARCHIVED')),
  target_type TEXT NOT NULL CHECK(target_type IN ('PROJECT','ARTIFACT')),
  target_id TEXT NOT NULL,
  transition_revision INTEGER NOT NULL CHECK(transition_revision BETWEEN 2 AND 2147483647),
  outcome TEXT NOT NULL CHECK(outcome='SUCCEEDED'),
  before_metadata TEXT NOT NULL CHECK(length(before_metadata) BETWEEN 2 AND 4096 AND json_valid(before_metadata)),
  after_metadata TEXT NOT NULL CHECK(length(after_metadata) BETWEEN 2 AND 4096 AND json_valid(after_metadata)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX project_administration_events_project_time_idx ON project_administration_events(project_id,created_at DESC,id DESC);
CREATE INDEX project_administration_events_target_time_idx ON project_administration_events(project_id,target_type,target_id,created_at DESC,id DESC);

CREATE TRIGGER project_settings_update_guard BEFORE UPDATE OF name,slug,description,settings_revision ON projects
WHEN OLD.status<>'ACTIVE' OR NEW.status<>OLD.status OR NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR
  NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.settings_revision<>OLD.settings_revision+1 OR
  NEW.settings_updated_by IS NULL OR NEW.settings_updated_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR
  length(NEW.name) NOT BETWEEN 1 AND 100 OR NEW.name<>trim(NEW.name) OR length(NEW.slug) NOT BETWEEN 1 AND 63 OR
  NEW.slug<>trim(NEW.slug) OR NEW.slug GLOB '*[^a-z0-9-]*' OR NEW.slug LIKE '-%' OR NEW.slug LIKE '%-' OR NEW.slug LIKE '%--%' OR
  length(COALESCE(NEW.description,''))>500 OR (NEW.description IS NOT NULL AND (NEW.description='' OR NEW.description<>trim(NEW.description))) OR
  NOT EXISTS(SELECT 1 FROM project_members admin WHERE admin.project_id=OLD.id AND admin.user_id=NEW.settings_updated_by AND admin.role='ADMIN')
BEGIN SELECT RAISE(ABORT,'invalid project settings transition'); END;

CREATE TRIGGER project_settings_updated AFTER UPDATE OF name,slug,description,settings_revision ON projects
BEGIN
  INSERT INTO project_administration_events(id,transition_key,project_id,actor_user_id,action,target_type,target_id,transition_revision,outcome,before_metadata,after_metadata,created_at)
  VALUES(
    'project:'||NEW.id||':settings:'||NEW.settings_revision,
    'project:'||NEW.id||':settings:'||NEW.settings_revision,
    NEW.id,NEW.settings_updated_by,'PROJECT_SETTINGS_UPDATED','PROJECT',NEW.id,NEW.settings_revision,'SUCCEEDED',
    json_object('name',OLD.name,'slug',OLD.slug,'description',OLD.description,'revision',OLD.settings_revision),
    json_object('name',NEW.name,'slug',NEW.slug,'description',NEW.description,'revision',NEW.settings_revision),
    NEW.settings_updated_at
  );
END;

CREATE TRIGGER artifact_archive_guard BEFORE UPDATE OF status,lifecycle_revision,archived_at,archived_by,archive_reason ON artifacts
WHEN OLD.status<>'ACTIVE' OR NEW.status<>'ARCHIVED' OR NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR
  NEW.type<>OLD.type OR NEW.name<>OLD.name OR NEW.description IS NOT OLD.description OR NEW.current_version<>OLD.current_version OR
  NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at OR NEW.lifecycle_revision<>OLD.lifecycle_revision+1 OR
  NEW.archived_by IS NULL OR NEW.archived_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR
  NEW.updated_at<>NEW.archived_at OR length(NEW.archive_reason) NOT BETWEEN 1 AND 500 OR NEW.archive_reason<>trim(NEW.archive_reason) OR
  NOT EXISTS(SELECT 1 FROM projects p JOIN project_members admin ON admin.project_id=p.id
    WHERE p.id=OLD.project_id AND p.status='ACTIVE' AND admin.user_id=NEW.archived_by AND admin.role='ADMIN')
BEGIN SELECT RAISE(ABORT,'invalid artifact archive transition'); END;

CREATE TRIGGER artifact_archived AFTER UPDATE OF status,lifecycle_revision,archived_at,archived_by,archive_reason ON artifacts
WHEN OLD.status='ACTIVE' AND NEW.status='ARCHIVED'
BEGIN
  INSERT INTO project_administration_events(id,transition_key,project_id,actor_user_id,action,target_type,target_id,transition_revision,outcome,before_metadata,after_metadata,created_at)
  VALUES(
    'artifact:'||NEW.id||':archive:'||NEW.lifecycle_revision,
    'artifact:'||NEW.id||':archive:'||NEW.lifecycle_revision,
    NEW.project_id,NEW.archived_by,'ARTIFACT_ARCHIVED','ARTIFACT',NEW.id,NEW.lifecycle_revision,'SUCCEEDED',
    json_object('status',OLD.status,'currentVersion',OLD.current_version,'revision',OLD.lifecycle_revision),
    json_object('status',NEW.status,'currentVersion',NEW.current_version,'revision',NEW.lifecycle_revision,'reason',NEW.archive_reason),
    NEW.archived_at
  );
END;

CREATE TRIGGER project_administration_events_insert_guard BEFORE INSERT ON project_administration_events
WHEN NEW.id<>NEW.transition_key OR NEW.outcome<>'SUCCEEDED' OR NEW.created_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NOT (
  (NEW.action='PROJECT_SETTINGS_UPDATED' AND NEW.target_type='PROJECT' AND NEW.target_id=NEW.project_id AND
    NEW.transition_key='project:'||NEW.project_id||':settings:'||NEW.transition_revision AND EXISTS(
      SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.settings_revision=NEW.transition_revision AND
        p.settings_updated_by=NEW.actor_user_id AND p.settings_updated_at=NEW.created_at)) OR
  (NEW.action='ARTIFACT_ARCHIVED' AND NEW.target_type='ARTIFACT' AND
    NEW.transition_key='artifact:'||NEW.target_id||':archive:'||NEW.transition_revision AND EXISTS(
      SELECT 1 FROM artifacts a WHERE a.id=NEW.target_id AND a.project_id=NEW.project_id AND a.status='ARCHIVED' AND
        a.lifecycle_revision=NEW.transition_revision AND a.archived_by=NEW.actor_user_id AND a.archived_at=NEW.created_at))
)
BEGIN SELECT RAISE(ABORT,'invalid project administration event'); END;

CREATE TRIGGER project_administration_events_immutable_update BEFORE UPDATE ON project_administration_events BEGIN SELECT RAISE(ABORT,'project administration event is immutable'); END;
CREATE TRIGGER project_administration_events_immutable_delete BEFORE DELETE ON project_administration_events BEGIN SELECT RAISE(ABORT,'project administration event is immutable'); END;
CREATE TRIGGER artifact_versions_immutable_update BEFORE UPDATE ON artifact_versions BEGIN SELECT RAISE(ABORT,'artifact version is immutable'); END;
CREATE TRIGGER artifact_versions_immutable_delete BEFORE DELETE ON artifact_versions BEGIN SELECT RAISE(ABORT,'artifact version is immutable'); END;
