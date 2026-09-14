PRAGMA foreign_keys = ON;

ALTER TABLE project_members ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 2147483647);
ALTER TABLE project_members ADD COLUMN role_updated_at TEXT;
ALTER TABLE project_members ADD COLUMN role_updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE project_members ADD COLUMN previous_role TEXT CHECK(previous_role IS NULL OR previous_role IN ('ADMIN','EDITOR','VIEWER'));

CREATE TABLE project_invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invitee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK(role IN ('ADMIN','EDITOR','VIEWER')),
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at TEXT,
  revoked_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  CHECK(julianday(expires_at) IS NOT NULL AND expires_at > issued_at),
  CHECK((status='PENDING' AND accepted_at IS NULL AND accepted_by_user_id IS NULL AND revoked_at IS NULL AND revoked_by_user_id IS NULL) OR
        (status='ACCEPTED' AND accepted_at IS NOT NULL AND accepted_by_user_id=invitee_user_id AND revoked_at IS NULL AND revoked_by_user_id IS NULL) OR
        (status='REVOKED' AND accepted_at IS NULL AND accepted_by_user_id IS NULL AND revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL) OR
        (status='EXPIRED' AND accepted_at IS NULL AND accepted_by_user_id IS NULL AND revoked_at IS NULL AND revoked_by_user_id IS NULL))
);
CREATE UNIQUE INDEX project_invitations_one_pending ON project_invitations(project_id,invitee_user_id) WHERE status='PENDING';
CREATE INDEX project_invitations_project_status_time ON project_invitations(project_id,status,issued_at DESC,id);
CREATE INDEX project_invitations_invitee_status_time ON project_invitations(invitee_user_id,status,issued_at DESC,id);
CREATE INDEX project_invitations_expiry ON project_invitations(status,expires_at);

CREATE TABLE team_member_removals (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 2 AND 2147483647),
  role TEXT NOT NULL CHECK(role IN ('ADMIN','EDITOR','VIEWER')),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  removed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(project_id,user_id,revision)
);

CREATE TABLE team_events (
  id TEXT PRIMARY KEY,
  transition_key TEXT NOT NULL UNIQUE,
  transition_revision INTEGER NOT NULL CHECK(transition_revision BETWEEN 1 AND 2147483647),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('MEMBER_INVITED','INVITATION_ACCEPTED','INVITATION_REVOKED','MEMBER_ROLE_CHANGED','MEMBER_REMOVED')),
  invitation_id TEXT REFERENCES project_invitations(id) ON DELETE RESTRICT,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  from_role TEXT CHECK(from_role IS NULL OR from_role IN ('ADMIN','EDITOR','VIEWER')),
  to_role TEXT CHECK(to_role IS NULL OR to_role IN ('ADMIN','EDITOR','VIEWER')),
  outcome TEXT NOT NULL CHECK(outcome='SUCCEEDED'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX team_events_project_time ON team_events(project_id,created_at DESC,id);

CREATE TRIGGER project_invitation_insert_guard BEFORE INSERT ON project_invitations
WHEN NEW.status<>'PENDING' OR NEW.issued_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR
  julianday(NEW.expires_at)>julianday('now','+7 days','+1 second') OR
  NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND status='ACTIVE') OR
  NEW.invitee_user_id=NEW.inviter_user_id OR
  EXISTS(SELECT 1 FROM project_members WHERE project_id=NEW.project_id AND user_id=NEW.invitee_user_id) OR
  NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=NEW.project_id AND user_id=NEW.inviter_user_id AND role='ADMIN') OR
  (SELECT COUNT(*) FROM project_invitations WHERE project_id=NEW.project_id AND status='PENDING' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))>=100
BEGIN SELECT RAISE(ABORT,'invalid team invitation'); END;

CREATE TRIGGER project_invitation_created AFTER INSERT ON project_invitations
BEGIN
  INSERT INTO team_events(id,transition_key,transition_revision,project_id,actor_user_id,action,invitation_id,target_user_id,to_role,outcome)
  VALUES('invite:'||NEW.id||':issued','invite:'||NEW.id||':issued',1,NEW.project_id,NEW.inviter_user_id,'MEMBER_INVITED',NEW.id,NEW.invitee_user_id,NEW.role,'SUCCEEDED');
END;

CREATE TRIGGER project_invitation_transition_guard BEFORE UPDATE ON project_invitations
WHEN NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.invitee_user_id<>OLD.invitee_user_id OR
  NEW.role<>OLD.role OR NEW.inviter_user_id<>OLD.inviter_user_id OR NEW.issued_at<>OLD.issued_at OR NEW.expires_at<>OLD.expires_at OR
  OLD.status<>'PENDING' OR
  (NEW.status IN ('ACCEPTED','REVOKED') AND NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id AND status='ACTIVE')) OR
  (NEW.status='ACCEPTED' AND (NEW.accepted_by_user_id<>OLD.invitee_user_id OR NEW.accepted_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR julianday(OLD.expires_at)<=julianday('now') OR
    EXISTS(SELECT 1 FROM project_members WHERE project_id=OLD.project_id AND user_id=OLD.invitee_user_id) OR
    (SELECT COUNT(*) FROM project_members WHERE project_id=OLD.project_id)>=100)) OR
  (NEW.status='REVOKED' AND (NEW.revoked_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=OLD.project_id AND user_id=NEW.revoked_by_user_id AND role='ADMIN'))) OR
  (NEW.status='EXPIRED' AND julianday(OLD.expires_at)>julianday('now')) OR
  NEW.status='PENDING'
BEGIN SELECT RAISE(ABORT,'invalid invitation transition'); END;

CREATE TRIGGER project_invitation_accepted AFTER UPDATE OF status ON project_invitations
WHEN OLD.status='PENDING' AND NEW.status='ACCEPTED'
BEGIN
  INSERT INTO workspace_members(workspace_id,user_id,role,invited_by)
    SELECT p.workspace_id,NEW.invitee_user_id,'VIEWER',NEW.inviter_user_id FROM projects p WHERE p.id=NEW.project_id
    ON CONFLICT(workspace_id,user_id) DO NOTHING;
  INSERT INTO project_members(project_id,user_id,role,invited_by,revision,role_updated_at,role_updated_by)
    VALUES(NEW.project_id,NEW.invitee_user_id,NEW.role,NEW.inviter_user_id,1,NEW.accepted_at,NEW.accepted_by_user_id);
  INSERT INTO team_events(id,transition_key,transition_revision,project_id,actor_user_id,action,invitation_id,target_user_id,to_role,outcome)
    VALUES('invite:'||NEW.id||':accepted','invite:'||NEW.id||':accepted',2,NEW.project_id,NEW.accepted_by_user_id,'INVITATION_ACCEPTED',NEW.id,NEW.invitee_user_id,NEW.role,'SUCCEEDED');
END;

CREATE TRIGGER project_invitation_revoked AFTER UPDATE OF status ON project_invitations
WHEN OLD.status='PENDING' AND NEW.status='REVOKED'
BEGIN
  INSERT INTO team_events(id,transition_key,transition_revision,project_id,actor_user_id,action,invitation_id,target_user_id,to_role,outcome)
    VALUES('invite:'||NEW.id||':revoked','invite:'||NEW.id||':revoked',2,NEW.project_id,NEW.revoked_by_user_id,'INVITATION_REVOKED',NEW.id,NEW.invitee_user_id,NEW.role,'SUCCEEDED');
END;

CREATE TRIGGER project_member_role_guard BEFORE UPDATE OF role ON project_members
WHEN NEW.project_id<>OLD.project_id OR NEW.user_id<>OLD.user_id OR NEW.invited_by IS NOT OLD.invited_by OR NEW.created_at<>OLD.created_at OR
  NEW.revision<>OLD.revision+1 OR NEW.role_updated_by IS NULL OR NEW.role_updated_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR
  (NEW.role<>OLD.role AND NEW.previous_role IS NOT OLD.role) OR (NEW.role=OLD.role AND NEW.previous_role IS NOT OLD.previous_role) OR
  NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id AND status='ACTIVE') OR
  (NEW.role<>OLD.role AND NEW.user_id=NEW.role_updated_by) OR
  NOT EXISTS(SELECT 1 FROM project_members admin WHERE admin.project_id=OLD.project_id AND admin.user_id=NEW.role_updated_by AND admin.role='ADMIN') OR
  (OLD.role='ADMIN' AND NEW.role<>'ADMIN' AND (SELECT COUNT(*) FROM project_members WHERE project_id=OLD.project_id AND role='ADMIN')<=1)
BEGIN SELECT RAISE(ABORT,'invalid project member role transition'); END;

CREATE TRIGGER project_member_role_changed AFTER UPDATE OF role ON project_members
WHEN OLD.role<>NEW.role
BEGIN
  INSERT INTO team_events(id,transition_key,transition_revision,project_id,actor_user_id,action,target_user_id,from_role,to_role,outcome)
    VALUES('member:'||NEW.project_id||':'||NEW.user_id||':role:'||NEW.revision,'member:'||NEW.project_id||':'||NEW.user_id||':role:'||NEW.revision,NEW.revision,NEW.project_id,NEW.role_updated_by,'MEMBER_ROLE_CHANGED',NEW.user_id,OLD.role,NEW.role,'SUCCEEDED');
END;

CREATE TRIGGER project_member_delete_guard BEFORE DELETE ON project_members
WHEN NOT EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id AND status='ACTIVE') OR OLD.role_updated_by IS NULL OR
  NOT EXISTS(SELECT 1 FROM project_members admin WHERE admin.project_id=OLD.project_id AND admin.user_id=OLD.role_updated_by AND admin.role='ADMIN') OR
  (OLD.role='ADMIN' AND (SELECT COUNT(*) FROM project_members WHERE project_id=OLD.project_id AND role='ADMIN')<=1)
BEGIN SELECT RAISE(ABORT,'invalid project member removal'); END;

CREATE TRIGGER project_member_removal_evidence BEFORE DELETE ON project_members
BEGIN
  INSERT INTO team_member_removals(project_id,user_id,revision,role,actor_user_id)
  VALUES(OLD.project_id,OLD.user_id,OLD.revision,OLD.role,OLD.role_updated_by);
END;

CREATE TRIGGER project_member_removed AFTER DELETE ON project_members
BEGIN
  INSERT INTO team_events(id,transition_key,transition_revision,project_id,actor_user_id,action,target_user_id,from_role,outcome)
    VALUES('member:'||OLD.project_id||':'||OLD.user_id||':removed:'||OLD.revision,'member:'||OLD.project_id||':'||OLD.user_id||':removed:'||OLD.revision,OLD.revision,OLD.project_id,OLD.role_updated_by,'MEMBER_REMOVED',OLD.user_id,OLD.role,'SUCCEEDED');
END;

CREATE TRIGGER team_member_removals_insert_guard BEFORE INSERT ON team_member_removals
WHEN NEW.removed_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR
  NOT EXISTS(SELECT 1 FROM projects p JOIN project_members member ON member.project_id=p.id
    JOIN project_members admin ON admin.project_id=p.id
    WHERE p.id=NEW.project_id AND p.status='ACTIVE' AND member.user_id=NEW.user_id AND member.role=NEW.role AND member.revision=NEW.revision
      AND member.role_updated_by=NEW.actor_user_id AND admin.user_id=NEW.actor_user_id AND admin.role='ADMIN')
BEGIN SELECT RAISE(ABORT,'invalid member removal evidence'); END;

CREATE TRIGGER team_events_insert_guard BEFORE INSERT ON team_events
WHEN NEW.id<>NEW.transition_key OR NEW.created_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NEW.outcome<>'SUCCEEDED' OR NOT (
  (NEW.action='MEMBER_INVITED' AND NEW.transition_key='invite:'||NEW.invitation_id||':issued' AND NEW.transition_revision=1 AND NEW.from_role IS NULL AND EXISTS(
    SELECT 1 FROM project_invitations i WHERE i.id=NEW.invitation_id AND i.project_id=NEW.project_id AND i.inviter_user_id=NEW.actor_user_id
      AND i.invitee_user_id=NEW.target_user_id AND i.role=NEW.to_role)) OR
  (NEW.action='INVITATION_ACCEPTED' AND NEW.transition_key='invite:'||NEW.invitation_id||':accepted' AND NEW.transition_revision=2 AND NEW.from_role IS NULL AND EXISTS(
    SELECT 1 FROM project_invitations i WHERE i.id=NEW.invitation_id AND i.project_id=NEW.project_id AND i.status='ACCEPTED'
      AND i.accepted_by_user_id=NEW.actor_user_id AND i.invitee_user_id=NEW.target_user_id AND i.role=NEW.to_role AND i.accepted_at=NEW.created_at)) OR
  (NEW.action='INVITATION_REVOKED' AND NEW.transition_key='invite:'||NEW.invitation_id||':revoked' AND NEW.transition_revision=2 AND NEW.from_role IS NULL AND EXISTS(
    SELECT 1 FROM project_invitations i WHERE i.id=NEW.invitation_id AND i.project_id=NEW.project_id AND i.status='REVOKED'
      AND i.revoked_by_user_id=NEW.actor_user_id AND i.invitee_user_id=NEW.target_user_id AND i.role=NEW.to_role AND i.revoked_at=NEW.created_at)) OR
  (NEW.action='MEMBER_ROLE_CHANGED' AND NEW.invitation_id IS NULL AND NEW.transition_key='member:'||NEW.project_id||':'||NEW.target_user_id||':role:'||NEW.transition_revision AND EXISTS(
    SELECT 1 FROM project_members member WHERE member.project_id=NEW.project_id AND member.user_id=NEW.target_user_id
      AND member.revision=NEW.transition_revision AND member.previous_role=NEW.from_role AND member.role=NEW.to_role
      AND member.role_updated_by=NEW.actor_user_id AND member.role_updated_at=NEW.created_at)) OR
  (NEW.action='MEMBER_REMOVED' AND NEW.invitation_id IS NULL AND NEW.to_role IS NULL AND NEW.transition_key='member:'||NEW.project_id||':'||NEW.target_user_id||':removed:'||NEW.transition_revision
    AND NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=NEW.project_id AND user_id=NEW.target_user_id) AND EXISTS(
      SELECT 1 FROM team_member_removals removal WHERE removal.project_id=NEW.project_id AND removal.user_id=NEW.target_user_id
        AND removal.revision=NEW.transition_revision AND removal.role=NEW.from_role AND removal.actor_user_id=NEW.actor_user_id AND removal.removed_at=NEW.created_at))
)
BEGIN SELECT RAISE(ABORT,'invalid team event'); END;

CREATE TRIGGER team_member_removals_immutable_update BEFORE UPDATE ON team_member_removals BEGIN SELECT RAISE(ABORT,'member removal evidence is immutable'); END;
CREATE TRIGGER team_member_removals_immutable_delete BEFORE DELETE ON team_member_removals BEGIN SELECT RAISE(ABORT,'member removal evidence is immutable'); END;
CREATE TRIGGER team_events_immutable_update BEFORE UPDATE ON team_events BEGIN SELECT RAISE(ABORT,'team event is immutable'); END;
CREATE TRIGGER team_events_immutable_delete BEFORE DELETE ON team_events BEGIN SELECT RAISE(ABORT,'team event is immutable'); END;
CREATE TRIGGER project_invitations_immutable_delete BEFORE DELETE ON project_invitations BEGIN SELECT RAISE(ABORT,'team invitation is immutable'); END;
