import { corsJsonHeaders } from "./cors.js";

export interface MetricsEnv {
  DB: D1Database;
  WEB_ORIGIN?: string;
}

export interface MetricsUser {
  id: string;
}

type ProjectRow = { status: string; role: "ADMIN" | "EDITOR" | "VIEWER" };
type AuditAggregateRow = Record<string, number | string | null>;
type InventoryRow = Record<string, number | string | null>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const WINDOWS = new Set([7, 30, 90]);

export const METRICS_AUDIT_SQL = `SELECT COUNT(*) AS audit_events,MIN(occurred_at) AS first_event_at,MAX(occurred_at) AS last_event_at,
  SUM(CASE WHEN action='SYNC_STATE_REPORTED' AND outcome='SUCCEEDED' AND json_extract(metadata_json,'$.reportOutcome')='SYNC_SUCCEEDED' THEN 1 ELSE 0 END) AS sync_succeeded,
  SUM(CASE WHEN action='SYNC_STATE_REPORTED' AND outcome='FAILED' THEN 1 ELSE 0 END) AS sync_failed,
  SUM(CASE WHEN action='SNAPSHOT_CREATED' AND outcome='SUCCEEDED' THEN 1 ELSE 0 END) AS snapshot_succeeded,
  SUM(CASE WHEN action IN ('SNAPSHOT_CREATE_REJECTED','SNAPSHOT_CREATE_FAILED') THEN 1 ELSE 0 END) AS snapshot_failed,
  SUM(CASE WHEN action IN ('MEMBER_INVITED','INVITATION_ACCEPTED','INVITATION_REVOKED','MEMBER_ROLE_CHANGED','MEMBER_REMOVED') THEN 1 ELSE 0 END) AS team_events,
  SUM(CASE WHEN action IN ('ARTIFACT_CREATED','ARTIFACT_VERSION_CREATED','ARTIFACT_ARCHIVED') THEN 1 ELSE 0 END) AS artifact_events,
  SUM(CASE WHEN action='PROJECT_CREATED' THEN 1 ELSE 0 END) AS projects_created,
  SUM(CASE WHEN action='GIT_CONNECTED' THEN 1 ELSE 0 END) AS git_connected,
  SUM(CASE WHEN action='MEMBER_INVITED' THEN 1 ELSE 0 END) AS members_invited,
  SUM(CASE WHEN action='INVITATION_ACCEPTED' THEN 1 ELSE 0 END) AS invitations_accepted
 FROM project_audit_events WHERE project_id=? AND occurred_at>=? AND occurred_at<?`;

export const METRICS_INVENTORY_SQL = `SELECT
  (SELECT COUNT(*) FROM artifact_versions av JOIN artifacts a ON a.id=av.artifact_id WHERE a.project_id=?) AS artifact_versions,
  (SELECT COALESCE(SUM(av.byte_size),0) FROM artifact_versions av JOIN artifacts a ON a.id=av.artifact_id WHERE a.project_id=?) AS artifact_bytes,
  (SELECT COUNT(*) FROM graph_versions WHERE project_id=? AND status IN ('READY','SUPERSEDED')) AS graph_versions,
  (SELECT COALESCE(SUM(byte_size),0) FROM graph_versions WHERE project_id=? AND status IN ('READY','SUPERSEDED')) AS graph_bytes,
  (SELECT COUNT(*) FROM context_snapshots WHERE project_id=?) AS snapshots,
  (SELECT COALESCE(SUM(manifest_byte_size),0) FROM context_snapshots WHERE project_id=?) AS snapshot_bytes,
  (SELECT COUNT(*) FROM graph_build_attempts WHERE project_id=? AND status='PUBLISHED' AND published_at>=? AND published_at<?) AS graph_published,
  (SELECT COUNT(*) FROM graph_build_attempts WHERE project_id=? AND status IN ('FAILED','CLEANED') AND failed_at>=? AND failed_at<?) AS graph_failed,
  (SELECT COUNT(*) FROM graph_build_attempts WHERE project_id=? AND status IN ('PUBLISHED','FAILED','CLEANED') AND (CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)>=? AND (CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)<?) AS graph_duration_samples,
  (SELECT AVG((julianday(CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)-julianday(claimed_at))*86400000.0) FROM graph_build_attempts WHERE project_id=? AND status IN ('PUBLISHED','FAILED','CLEANED') AND (CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)>=? AND (CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)<?) AS graph_duration_avg_ms,
  (SELECT MIN((julianday(CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)-julianday(claimed_at))*86400000.0) FROM graph_build_attempts WHERE project_id=? AND status IN ('PUBLISHED','FAILED','CLEANED') AND (CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)>=? AND (CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)<?) AS graph_duration_min_ms,
  (SELECT MAX((julianday(CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)-julianday(claimed_at))*86400000.0) FROM graph_build_attempts WHERE project_id=? AND status IN ('PUBLISHED','FAILED','CLEANED') AND (CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)>=? AND (CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END)<?) AS graph_duration_max_ms`;

function reply(request: Request, env: MetricsEnv, body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsJsonHeaders(request, env) });
}

function count(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key] ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function nullableNumber(row: Record<string, unknown>, key: string): number | null {
  if (row[key] === null || row[key] === undefined) return null;
  const value = Number(row[key]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function sampledRate(successes: number, failures: number) {
  const sampleCount = successes + failures;
  return {
    successes,
    failures,
    sampleCount,
    rate: sampleCount === 0 ? null : successes / sampleCount,
  };
}

function parseWindow(request: Request, now: Date) {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => key !== "windowDays")) return null;
  if (url.searchParams.getAll("windowDays").length > 1) return null;
  const raw = url.searchParams.get("windowDays") ?? "30";
  if (!/^\d{1,2}$/.test(raw) || !WINDOWS.has(Number(raw))) return null;
  const days = Number(raw);
  return {
    days,
    from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
    to: now.toISOString(),
  };
}

export async function handleMetricsRoute(
  request: Request,
  env: MetricsEnv,
  user: MetricsUser,
  projectId: string,
  now = new Date(),
): Promise<Response> {
  if (!ID.test(projectId) || request.body !== null)
    return reply(request, env, { error: "INVALID_INPUT" }, 400);
  if (request.method !== "GET") return reply(request, env, { error: "METHOD_NOT_ALLOWED" }, 405);
  const window = parseWindow(request, now);
  if (!window) return reply(request, env, { error: "INVALID_INPUT" }, 400);

  const project = await env.DB.prepare(
    `SELECT p.status,pm.role FROM projects p JOIN project_members pm ON pm.project_id=p.id
     WHERE p.id=? AND pm.user_id=?`,
  )
    .bind(projectId, user.id)
    .first<ProjectRow>();
  if (!project) return reply(request, env, { error: "NOT_FOUND" }, 404);

  const audit =
    (await env.DB.prepare(METRICS_AUDIT_SQL)
      .bind(projectId, window.from, window.to)
      .first<AuditAggregateRow>()) ?? {};

  const inventory =
    (await env.DB.prepare(METRICS_INVENTORY_SQL)
      .bind(
        projectId,
        projectId,
        projectId,
        projectId,
        projectId,
        projectId,
        projectId,
        window.from,
        window.to,
        projectId,
        window.from,
        window.to,
        projectId,
        window.from,
        window.to,
        projectId,
        window.from,
        window.to,
        projectId,
        window.from,
        window.to,
        projectId,
        window.from,
        window.to,
      )
      .first<InventoryRow>()) ?? {};

  const artifactBytes = count(inventory, "artifact_bytes");
  const graphBytes = count(inventory, "graph_bytes");
  const snapshotBytes = count(inventory, "snapshot_bytes");
  const graph = sampledRate(count(inventory, "graph_published"), count(inventory, "graph_failed"));
  const sync = sampledRate(count(audit, "sync_succeeded"), count(audit, "sync_failed"));
  const snapshots = sampledRate(
    count(audit, "snapshot_succeeded"),
    count(audit, "snapshot_failed"),
  );

  return reply(request, env, {
    project: { id: projectId, status: project.status, role: project.role },
    window,
    coverage: {
      auditEvents: count(audit, "audit_events"),
      firstEventAt: audit.first_event_at ?? null,
      lastEventAt: audit.last_event_at ?? null,
    },
    reliability: {
      graphBuild: graph,
      sync,
      snapshots,
      failedUpdatePreservation: null,
      artifactConflictRate: null,
      apiErrors: null,
      note: "Null metrics are not derivable from retained project metadata.",
    },
    timing: {
      graphDurationMs: {
        sampleCount: count(inventory, "graph_duration_samples"),
        average: nullableNumber(inventory, "graph_duration_avg_ms"),
        minimum: nullableNumber(inventory, "graph_duration_min_ms"),
        maximum: nullableNumber(inventory, "graph_duration_max_ms"),
      },
    },
    activity: {
      artifactEvents: count(audit, "artifact_events"),
      teamEvents: count(audit, "team_events"),
    },
    onboarding: {
      projectsCreated: count(audit, "projects_created"),
      gitConnected: count(audit, "git_connected"),
      membersInvited: count(audit, "members_invited"),
      invitationsAccepted: count(audit, "invitations_accepted"),
    },
    immutableObjectMetadata: {
      artifacts: { versions: count(inventory, "artifact_versions"), knownBytes: artifactBytes },
      graphs: { versions: count(inventory, "graph_versions"), knownBytes: graphBytes },
      snapshots: { count: count(inventory, "snapshots"), knownManifestBytes: snapshotBytes },
      knownReferencedBytes: artifactBytes + graphBytes + snapshotBytes,
      orphanBytes: null,
      actualBilledStorageBytes: null,
      note: "D1-known immutable referenced bytes only; R2 inventory and billing remain external.",
    },
  });
}
