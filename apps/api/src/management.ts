import {
  isProjectAuditAction,
  type ProjectAuditAction,
} from "../../../packages/project-audit-contract.js";
import { corsJsonHeaders } from "./cors.js";

export type ManagementEnv = { DB: D1Database; WEB_ORIGIN?: string };
export type ManagementUser = {
  id: string;
  session_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

type ActivityFilters = {
  from: string;
  to: string;
  action: ProjectAuditAction | null;
  projectStatus: "ACTIVE" | "ARCHIVED" | null;
};
type ActivityCursor = {
  occurredAt: string;
  id: string;
  filters: ActivityFilters;
};
type GlobalActivityRow = {
  id: string;
  project_id: string;
  project_name: string;
  project_slug: string;
  project_status: "ACTIVE" | "ARCHIVED";
  actor_kind: "HUMAN" | "MACHINE" | "MCP" | "SYSTEM";
  actor_id: string;
  action: ProjectAuditAction;
  target_type: string;
  target_id: string;
  outcome: "SUCCEEDED" | "DENIED" | "FAILED";
  metadata_json: string;
  occurred_at: string;
};
type SettingsRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  settings_revision: number;
  role: string;
  git_provider: string | null;
  repository_url: string | null;
  repository_owner: string | null;
  repository_name: string | null;
  default_branch: string | null;
  current_commit: string | null;
  git_status: string | null;
  git_verified_at: string | null;
  graph_version: number | null;
  graph_status: string | null;
  graph_source_commit: string | null;
  sync_status: string | null;
  sync_last_seen_at: string | null;
};

const MAX_LIMIT = 50;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function reply(
  request: Request,
  env: ManagementEnv,
  body: Record<string, unknown>,
  status = 200,
  headers?: HeadersInit,
) {
  const responseHeaders = corsJsonHeaders(request, env);
  new Headers(headers).forEach((value, key) => {
    responseHeaders.set(key, value);
  });
  return Response.json(body, { status, headers: responseHeaders });
}

function iso(value: string | null): string | null {
  if (!value || value.length > 30) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function encodeCursor(value: ActivityCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value: string | null): ActivityCursor | null {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      ),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const cursor = parsed as Partial<ActivityCursor>;
    const filters = cursor.filters as Partial<ActivityFilters> | undefined;
    if (
      !iso(cursor.occurredAt ?? null) ||
      typeof cursor.id !== "string" ||
      cursor.id.length > 512 ||
      !filters ||
      !iso(filters.from ?? null) ||
      !iso(filters.to ?? null)
    )
      return null;
    if (filters.action !== null && !isProjectAuditAction(filters.action ?? "")) return null;
    if (
      filters.projectStatus !== null &&
      filters.projectStatus !== "ACTIVE" &&
      filters.projectStatus !== "ARCHIVED"
    )
      return null;
    return cursor as ActivityCursor;
  } catch {
    return null;
  }
}

function parseActivity(
  url: URL,
  now = new Date(),
): { filters: ActivityFilters; limit: number; cursor: ActivityCursor | null } | null {
  const allowed = new Set(["from", "to", "action", "projectStatus", "limit", "cursor"]);
  for (const key of url.searchParams.keys())
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue ? decodeCursor(cursorValue) : null;
  if (cursorValue && !cursor) return null;
  const to =
    iso(url.searchParams.get("to")) ??
    (url.searchParams.has("to") ? null : (cursor?.filters.to ?? now.toISOString()));
  const from =
    iso(url.searchParams.get("from")) ??
    (url.searchParams.has("from")
      ? null
      : (cursor?.filters.from ?? new Date(now.getTime() - DEFAULT_WINDOW_MS).toISOString()));
  const actionValue = url.searchParams.get("action") ?? cursor?.filters.action ?? null;
  const statusValue =
    url.searchParams.get("projectStatus") ?? cursor?.filters.projectStatus ?? null;
  const limitValue = url.searchParams.get("limit") ?? "25";
  if (
    !from ||
    !to ||
    Date.parse(from) > Date.parse(to) ||
    Date.parse(to) - Date.parse(from) > MAX_WINDOW_MS ||
    !/^\d{1,2}$/.test(limitValue)
  )
    return null;
  if (actionValue !== null && !isProjectAuditAction(actionValue)) return null;
  if (statusValue !== null && statusValue !== "ACTIVE" && statusValue !== "ARCHIVED") return null;
  const limit = Number(limitValue);
  if (limit < 1 || limit > MAX_LIMIT) return null;
  const filters: ActivityFilters = { from, to, action: actionValue, projectStatus: statusValue };
  if (cursor && JSON.stringify(cursor.filters) !== JSON.stringify(filters)) return null;
  return { filters, limit, cursor };
}

function mapGlobalEvent(row: GlobalActivityRow): Record<string, unknown> | null {
  try {
    if (!isProjectAuditAction(row.action)) return null;
    const metadata: unknown = JSON.parse(row.metadata_json);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    return {
      id: row.id,
      project: {
        id: row.project_id,
        name: row.project_name,
        slug: row.project_slug,
        status: row.project_status,
      },
      actor: { kind: row.actor_kind, id: row.actor_id },
      action: row.action,
      target: { type: row.target_type, id: row.target_id },
      outcome: row.outcome,
      metadata,
      occurredAt: row.occurred_at,
    };
  } catch {
    return null;
  }
}

export async function handleGlobalActivity(
  request: Request,
  env: ManagementEnv,
  user: ManagementUser,
): Promise<Response> {
  if (request.method !== "GET")
    return reply(request, env, { error: "METHOD_NOT_ALLOWED" }, 405, { allow: "GET" });
  if (request.body !== null) return reply(request, env, { error: "INVALID_INPUT" }, 400);
  const parsed = parseActivity(new URL(request.url));
  if (!parsed) return reply(request, env, { error: "INVALID_INPUT" }, 400);
  const clauses = ["pae.occurred_at>=?", "pae.occurred_at<=?"];
  const values: unknown[] = [user.id, parsed.filters.from, parsed.filters.to];
  if (parsed.filters.action) {
    clauses.push("pae.action=?");
    values.push(parsed.filters.action);
  }
  if (parsed.filters.projectStatus) {
    clauses.push("p.status=?");
    values.push(parsed.filters.projectStatus);
  }
  if (parsed.cursor) {
    clauses.push("(pae.occurred_at<? OR (pae.occurred_at=? AND pae.id<?))");
    values.push(parsed.cursor.occurredAt, parsed.cursor.occurredAt, parsed.cursor.id);
  }
  values.push(parsed.limit + 1);
  const result = await env.DB.prepare(
    `SELECT pae.id,pae.project_id,p.name AS project_name,p.slug AS project_slug,p.status AS project_status,
            pae.actor_kind,pae.actor_id,pae.action,pae.target_type,pae.target_id,pae.outcome,pae.metadata_json,pae.occurred_at
     FROM project_audit_events pae
     JOIN projects p ON p.id=pae.project_id
     JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
     JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=pm.user_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY pae.occurred_at DESC,pae.id DESC LIMIT ?`,
  )
    .bind(...values)
    .all<GlobalActivityRow>();
  const rows = result.results.slice(0, parsed.limit);
  const events = rows.map(mapGlobalEvent);
  if (events.some((event) => event === null))
    return reply(request, env, { error: "INTERNAL_ERROR" }, 500);
  const last = rows.at(-1);
  return reply(request, env, {
    events,
    nextCursor:
      result.results.length > parsed.limit && last
        ? encodeCursor({ occurredAt: last.occurred_at, id: last.id, filters: parsed.filters })
        : null,
    window: { from: parsed.filters.from, to: parsed.filters.to },
    projectStatusPolicy: parsed.filters.projectStatus ?? "ACTIVE_AND_ARCHIVED",
  });
}

export async function handleGlobalSettings(
  request: Request,
  env: ManagementEnv,
  user: ManagementUser,
): Promise<Response> {
  if (request.method !== "GET")
    return reply(request, env, { error: "METHOD_NOT_ALLOWED" }, 405, { allow: "GET" });
  if (new URL(request.url).search || request.body !== null)
    return reply(request, env, { error: "INVALID_INPUT" }, 400);
  const session = await env.DB.prepare(
    `SELECT u.provider,u.provider_user_id,u.username,u.display_name,u.avatar_url,u.created_at,u.last_login_at,
            s.created_at AS session_created_at,s.expires_at AS session_expires_at
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.id=? AND s.user_id=? AND s.expires_at>?`,
  )
    .bind(user.session_id, user.id, new Date().toISOString())
    .first<Record<string, unknown>>();
  if (!session) return reply(request, env, { error: "UNAUTHENTICATED" }, 401);
  const result = await env.DB.prepare(
    `SELECT p.id,p.name,p.slug,p.status,p.settings_revision,pm.role,
            gc.provider AS git_provider,ri.canonical_url AS repository_url,ri.owner AS repository_owner,
            ri.repository_name,gc.default_branch,gc.last_known_commit_sha AS current_commit,
            gc.status AS git_status,gc.verified_at AS git_verified_at,
            (SELECT gv.version FROM graph_versions gv JOIN git_connections vgc ON vgc.project_id=gv.project_id AND vgc.status='VERIFIED'
               JOIN repository_identities vri ON vri.id=vgc.repository_identity_id WHERE gv.project_id=p.id AND gv.repository_provider=vgc.provider
               AND gv.provider_repository_id=vgc.provider_repository_id AND gv.repository_owner=vri.owner AND gv.repository_name=vri.repository_name
               AND gv.repository_canonical_url=vri.canonical_url ORDER BY gv.version DESC LIMIT 1) AS graph_version,
            (SELECT gv.status FROM graph_versions gv JOIN git_connections vgc ON vgc.project_id=gv.project_id AND vgc.status='VERIFIED'
               JOIN repository_identities vri ON vri.id=vgc.repository_identity_id WHERE gv.project_id=p.id AND gv.repository_provider=vgc.provider
               AND gv.provider_repository_id=vgc.provider_repository_id AND gv.repository_owner=vri.owner AND gv.repository_name=vri.repository_name
               AND gv.repository_canonical_url=vri.canonical_url ORDER BY gv.version DESC LIMIT 1) AS graph_status,
            (SELECT gv.source_commit_sha FROM graph_versions gv JOIN git_connections vgc ON vgc.project_id=gv.project_id AND vgc.status='VERIFIED'
               JOIN repository_identities vri ON vri.id=vgc.repository_identity_id WHERE gv.project_id=p.id AND gv.repository_provider=vgc.provider
               AND gv.provider_repository_id=vgc.provider_repository_id AND gv.repository_owner=vri.owner AND gv.repository_name=vri.repository_name
               AND gv.repository_canonical_url=vri.canonical_url ORDER BY gv.version DESC LIMIT 1) AS graph_source_commit,
            (SELECT ss.sync_status FROM sync_states ss JOIN git_connections sgc ON sgc.project_id=ss.project_id AND sgc.status='VERIFIED'
               JOIN repository_identities sri ON sri.id=sgc.repository_identity_id WHERE ss.project_id=p.id AND ss.repository_provider=sgc.provider
               AND ss.provider_repository_id=sgc.provider_repository_id AND ss.repository_canonical_url=sri.canonical_url
               ORDER BY ss.last_seen_at DESC,ss.principal_id DESC,ss.client_id DESC LIMIT 1) AS sync_status,
            (SELECT ss.last_seen_at FROM sync_states ss JOIN git_connections sgc ON sgc.project_id=ss.project_id AND sgc.status='VERIFIED'
               JOIN repository_identities sri ON sri.id=sgc.repository_identity_id WHERE ss.project_id=p.id AND ss.repository_provider=sgc.provider
               AND ss.provider_repository_id=sgc.provider_repository_id AND ss.repository_canonical_url=sri.canonical_url
               ORDER BY ss.last_seen_at DESC,ss.principal_id DESC,ss.client_id DESC LIMIT 1) AS sync_last_seen_at
     FROM projects p
     JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
     JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=pm.user_id
     LEFT JOIN git_connections gc ON gc.project_id=p.id
     LEFT JOIN repository_identities ri ON ri.id=gc.repository_identity_id
     ORDER BY p.name,p.id LIMIT 101`,
  )
    .bind(user.id)
    .all<SettingsRow>();
  const rows = result.results.slice(0, 100);
  return reply(request, env, {
    account: {
      id: user.id,
      provider: session.provider,
      providerUserId: session.provider_user_id,
      username: session.username,
      displayName: session.display_name,
      avatarUrl: session.avatar_url,
      createdAt: session.created_at,
      lastLoginAt: session.last_login_at,
    },
    session: {
      createdAt: session.session_created_at,
      expiresAt: session.session_expires_at,
    },
    projects: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      settingsRevision: row.settings_revision,
      role: row.role,
      git: row.git_provider
        ? {
            provider: row.git_provider,
            repository: {
              canonicalUrl: row.repository_url,
              owner: row.repository_owner,
              name: row.repository_name,
            },
            defaultBranch: row.default_branch,
            currentCommitSha: row.current_commit,
            status: row.git_status,
            verifiedAt: row.git_verified_at,
          }
        : null,
      graph:
        row.graph_version === null
          ? null
          : {
              version: row.graph_version,
              status: row.graph_status,
              sourceCommitSha: row.graph_source_commit,
            },
      sync:
        row.sync_status === null
          ? null
          : { status: row.sync_status, lastSeenAt: row.sync_last_seen_at },
    })),
    truncated: result.results.length > 100,
    readOnly: true,
  });
}
