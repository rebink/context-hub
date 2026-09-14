import {
  isProjectAuditAction,
  type ProjectAuditAction,
} from "../../../packages/project-audit-contract.js";
import { corsJsonHeaders } from "./cors.js";

export interface ActivityEnv {
  DB: D1Database;
  WEB_ORIGIN?: string;
}

export interface ActivityUser {
  id: string;
}

type ActivityRow = {
  id: string;
  actor_kind: "HUMAN" | "MACHINE" | "MCP" | "SYSTEM";
  actor_id: string;
  action: ProjectAuditAction;
  target_type: string;
  target_id: string;
  outcome: "SUCCEEDED" | "DENIED" | "FAILED";
  metadata_json: string;
  occurred_at: string;
};

type Filters = {
  from: string;
  to: string;
  action: ProjectAuditAction | null;
  actorKind: string | null;
  actorId: string | null;
};

type Cursor = { occurredAt: string; id: string; filters: Filters };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACTOR_KINDS = new Set(["HUMAN", "MACHINE", "MCP", "SYSTEM"]);
const MAX_PAGE_SIZE = 50;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function reply(
  request: Request,
  env: ActivityEnv,
  body: Record<string, unknown>,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = corsJsonHeaders(request, env);
  new Headers(headers).forEach((value, key) => {
    responseHeaders.set(key, value);
  });
  return Response.json(body, { status, headers: responseHeaders });
}

function iso(value: string | null): string | null {
  if (!value || value.length > 30) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function encodeCursor(cursor: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeActivityCursor(value: string | null): Cursor | null {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<Cursor>;
    if (
      typeof candidate.occurredAt !== "string" ||
      typeof candidate.id !== "string" ||
      !candidate.filters
    )
      return null;
    if (!iso(candidate.occurredAt) || !/^[A-Za-z0-9:_-]{3,512}$/.test(candidate.id)) return null;
    const filters = candidate.filters as Partial<Filters>;
    if (typeof filters.from !== "string" || typeof filters.to !== "string") return null;
    if (filters.action !== null && !isProjectAuditAction(filters.action ?? "")) return null;
    if (
      [filters.action, filters.actorKind, filters.actorId].some(
        (item) => item !== null && typeof item !== "string",
      )
    )
      return null;
    return candidate as Cursor;
  } catch {
    return null;
  }
}

export function activityFilters(
  url: URL,
  now = new Date(),
): { filters: Filters; limit: number } | null {
  const allowed = new Set(["from", "to", "action", "actorKind", "actorId", "limit", "cursor"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  const to = url.searchParams.has("to") ? iso(url.searchParams.get("to")) : now.toISOString();
  const from = url.searchParams.has("from")
    ? iso(url.searchParams.get("from"))
    : new Date(now.getTime() - DEFAULT_WINDOW_MS).toISOString();
  if (
    !from ||
    !to ||
    Date.parse(from) > Date.parse(to) ||
    Date.parse(to) - Date.parse(from) > MAX_WINDOW_MS
  )
    return null;
  const action = url.searchParams.get("action");
  const actorKind = url.searchParams.get("actorKind");
  const actorId = url.searchParams.get("actorId");
  if (action !== null && !isProjectAuditAction(action)) return null;
  if (actorKind !== null && !ACTOR_KINDS.has(actorKind)) return null;
  if (actorId !== null && (actorId.length < 1 || actorId.length > 255)) return null;
  if ((actorKind === null) !== (actorId === null)) return null;
  const rawLimit = url.searchParams.get("limit") ?? "25";
  if (!/^\d{1,2}$/.test(rawLimit)) return null;
  const limit = Number(rawLimit);
  if (limit < 1 || limit > MAX_PAGE_SIZE) return null;
  return { filters: { from, to, action, actorKind, actorId }, limit };
}

function mapEvent(row: ActivityRow, projectId: string): Record<string, unknown> | null {
  try {
    if (!isProjectAuditAction(row.action)) return null;
    const metadata: unknown = JSON.parse(row.metadata_json);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    return {
      id: row.id,
      projectId,
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

export async function handleActivityRoute(
  request: Request,
  env: ActivityEnv,
  user: ActivityUser,
  projectId: string,
  eventId?: string,
): Promise<Response> {
  if (
    !ID.test(projectId) ||
    (eventId !== undefined && (eventId.length < 3 || eventId.length > 512))
  ) {
    return reply(request, env, { error: "INVALID_INPUT" }, 400);
  }
  if (request.method !== "GET") {
    return reply(request, env, { error: "METHOD_NOT_ALLOWED" }, 405, { allow: "GET" });
  }
  if (request.body !== null) return reply(request, env, { error: "INVALID_INPUT" }, 400);
  const project = await env.DB.prepare(
    `SELECT p.status FROM projects p JOIN project_members pm ON pm.project_id=p.id
     WHERE p.id=? AND pm.user_id=?`,
  )
    .bind(projectId, user.id)
    .first<{ status: string }>();
  if (!project) return reply(request, env, { error: "NOT_FOUND" }, 404);

  if (eventId !== undefined) {
    if (new URL(request.url).search !== "")
      return reply(request, env, { error: "INVALID_INPUT" }, 400);
    const row = await env.DB.prepare(
      `SELECT id,actor_kind,actor_id,action,target_type,target_id,outcome,metadata_json,occurred_at
       FROM project_audit_events WHERE project_id=? AND id=?`,
    )
      .bind(projectId, eventId)
      .first<ActivityRow>();
    const event = row && mapEvent(row, projectId);
    if (!event) return reply(request, env, { error: "NOT_FOUND" }, 404);
    return reply(request, env, { event, projectStatus: project.status });
  }

  const url = new URL(request.url);
  const cursorValue = url.searchParams.get("cursor");
  const cursor = cursorValue ? decodeActivityCursor(cursorValue) : null;
  if (cursorValue && !cursor) return reply(request, env, { error: "INVALID_CURSOR" }, 400);
  if (cursor) {
    if (!url.searchParams.has("from")) url.searchParams.set("from", cursor.filters.from);
    if (!url.searchParams.has("to")) url.searchParams.set("to", cursor.filters.to);
    if (cursor.filters.action && !url.searchParams.has("action"))
      url.searchParams.set("action", cursor.filters.action);
    if (cursor.filters.actorKind && !url.searchParams.has("actorKind"))
      url.searchParams.set("actorKind", cursor.filters.actorKind);
    if (cursor.filters.actorId && !url.searchParams.has("actorId"))
      url.searchParams.set("actorId", cursor.filters.actorId);
  }
  const parsed = activityFilters(url);
  if (!parsed) return reply(request, env, { error: "INVALID_INPUT" }, 400);
  if (cursor && JSON.stringify(cursor.filters) !== JSON.stringify(parsed.filters)) {
    return reply(request, env, { error: "INVALID_CURSOR" }, 400);
  }
  const clauses = ["project_id=?", "occurred_at>=?", "occurred_at<=?"];
  const values: unknown[] = [projectId, parsed.filters.from, parsed.filters.to];
  if (parsed.filters.action) {
    clauses.push("action=?");
    values.push(parsed.filters.action);
  }
  if (parsed.filters.actorKind && parsed.filters.actorId) {
    clauses.push("actor_kind=?", "actor_id=?");
    values.push(parsed.filters.actorKind, parsed.filters.actorId);
  }
  if (cursor) {
    clauses.push("(occurred_at<? OR (occurred_at=? AND id<?))");
    values.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
  }
  values.push(parsed.limit + 1);
  const result = await env.DB.prepare(
    `SELECT id,actor_kind,actor_id,action,target_type,target_id,outcome,metadata_json,occurred_at
     FROM project_audit_events WHERE ${clauses.join(" AND ")}
     ORDER BY occurred_at DESC,id DESC LIMIT ?`,
  )
    .bind(...values)
    .all<ActivityRow>();
  const rows = result.results.slice(0, parsed.limit);
  const events = rows.map((row) => mapEvent(row, projectId));
  if (events.some((event) => event === null))
    return reply(request, env, { error: "INTERNAL_ERROR" }, 500);
  const last = rows.at(-1);
  const nextCursor =
    result.results.length > parsed.limit && last
      ? encodeCursor({ occurredAt: last.occurred_at, id: last.id, filters: parsed.filters })
      : null;
  return reply(request, env, {
    events,
    nextCursor,
    window: { from: parsed.filters.from, to: parsed.filters.to },
    projectStatus: project.status,
  });
}
