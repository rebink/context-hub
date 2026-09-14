import { readBoundedJsonObject } from "./bounded-json.js";
import { corsJsonHeaders } from "./cors.js";
import type {
  IdentityLookupProvider,
  ResolvedProviderIdentity,
} from "./identity-lookup-provider.js";
import type { Env } from "./index.js";

type User = { id: string };
type Role = "ADMIN" | "EDITOR" | "VIEWER";
type Membership = { role: Role };

const ROLES = new Set<Role>(["ADMIN", "EDITOR", "VIEWER"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const MAX_BODY_BYTES = 2 * 1024;

function response(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
  status = 200,
  extra?: HeadersInit,
): Response {
  const headers = corsJsonHeaders(request, env);
  if (extra) {
    new Headers(extra).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return Response.json(body, { status, headers });
}

function failure(
  request: Request,
  env: Env,
  code: string,
  status: number,
  extra?: HeadersInit,
): Response {
  return response(request, env, { error: code }, status, extra);
}

function mutationAllowed(request: Request, env: Env): boolean {
  return request.headers.get("origin") === env.WEB_ORIGIN;
}

async function bodyObject(request: Request, env: Env): Promise<Record<string, unknown> | Response> {
  const result = await readBoundedJsonObject(request, MAX_BODY_BYTES);
  if (result.ok) return result.value;
  const status =
    result.error === "UNSUPPORTED_MEDIA_TYPE"
      ? 415
      : result.error === "PAYLOAD_TOO_LARGE"
        ? 413
        : 400;
  return failure(request, env, result.error, status);
}

function exactKeys(body: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function role(value: unknown): Role | null {
  return typeof value === "string" && ROLES.has(value as Role) ? (value as Role) : null;
}

function revision(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647
    ? Number(value)
    : null;
}

async function authorize(env: Env, projectId: string, userId: string): Promise<Membership | null> {
  if (!ID_PATTERN.test(projectId)) return null;
  return (
    (await env.DB.prepare(
      `SELECT pm.role FROM projects p
       JOIN project_members pm ON pm.project_id=p.id
       WHERE p.id=? AND p.status='ACTIVE' AND pm.user_id=?`,
    )
      .bind(projectId, userId)
      .first<Membership>()) ?? null
  );
}

async function expireInvitations(env: Env, predicate: string, value: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE project_invitations SET status='EXPIRED'
     WHERE ${predicate}=? AND status='PENDING' AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  )
    .bind(value)
    .run();
}

export async function handleInvitationInbox(
  request: Request,
  env: Env,
  user: User,
  invitationId?: string,
): Promise<Response> {
  if (invitationId) {
    if (request.method !== "POST")
      return failure(request, env, "METHOD_NOT_ALLOWED", 405, { allow: "POST" });
    if (!ID_PATTERN.test(invitationId)) return failure(request, env, "NOT_FOUND", 404);
    if (!mutationAllowed(request, env)) return failure(request, env, "ORIGIN_NOT_ALLOWED", 403);
    const parsed = await bodyObject(request, env);
    if (parsed instanceof Response) return parsed;
    if (!exactKeys(parsed, [])) return failure(request, env, "INVALID_INPUT", 400);
    try {
      const result = await env.DB.prepare(
        `UPDATE project_invitations
         SET status='ACCEPTED',accepted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),accepted_by_user_id=?
         WHERE id=? AND invitee_user_id=? AND status='PENDING'
           AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
           AND EXISTS(SELECT 1 FROM projects p WHERE p.id=project_invitations.project_id AND p.status='ACTIVE')
         RETURNING id,project_id,role,accepted_at`,
      )
        .bind(user.id, invitationId, user.id)
        .first<{ id: string; project_id: string; role: Role; accepted_at: string }>();
      if (!result) return failure(request, env, "INVITATION_UNAVAILABLE", 409);
      return response(request, env, { invitation: result });
    } catch {
      return failure(request, env, "INVITATION_UNAVAILABLE", 409);
    }
  }

  if (request.method !== "GET")
    return failure(request, env, "METHOD_NOT_ALLOWED", 405, { allow: "GET" });
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => key !== "limit" && key !== "cursor")) {
    return failure(request, env, "INVALID_INPUT", 400);
  }
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? 50 : Number(limitText);
  const cursor = url.searchParams.get("cursor");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (cursor !== null && !ID_PATTERN.test(cursor))
  ) {
    return failure(request, env, "INVALID_INPUT", 400);
  }
  await expireInvitations(env, "invitee_user_id", user.id);
  const result = await env.DB.prepare(
    `SELECT i.id,i.project_id,p.name AS project_name,i.role,i.issued_at,i.expires_at,u.username AS inviter_username
     FROM project_invitations i JOIN projects p ON p.id=i.project_id
     JOIN users u ON u.id=i.inviter_user_id
     WHERE i.invitee_user_id=? AND i.status='PENDING' AND p.status='ACTIVE'
       AND (? IS NULL OR i.issued_at<(SELECT c.issued_at FROM project_invitations c WHERE c.id=? AND c.invitee_user_id=?)
         OR (i.issued_at=(SELECT c.issued_at FROM project_invitations c WHERE c.id=? AND c.invitee_user_id=?) AND i.id<?))
     ORDER BY i.issued_at DESC,i.id DESC LIMIT ?`,
  )
    .bind(user.id, cursor, cursor, user.id, cursor, user.id, cursor, limit + 1)
    .all<{ id: string }>();
  const invitations = result.results.slice(0, limit);
  return response(request, env, {
    invitations,
    nextCursor: result.results.length > limit ? invitations.at(-1)?.id : null,
  });
}

export async function handleTeamRoute(
  request: Request,
  env: Env,
  user: User,
  projectId: string,
  identityProvider: IdentityLookupProvider,
  memberUserId?: string,
  invitationId?: string,
): Promise<Response> {
  const membership = await authorize(env, projectId, user.id);
  if (!membership) return failure(request, env, "NOT_FOUND", 404);

  if (request.method === "GET" && !memberUserId && !invitationId) {
    await expireInvitations(env, "project_id", projectId);
    const members = await env.DB.prepare(
      `SELECT pm.user_id,pm.role,pm.revision,pm.created_at,u.username,u.display_name,u.avatar_url
       FROM project_members pm JOIN users u ON u.id=pm.user_id
       WHERE pm.project_id=? ORDER BY lower(u.username),pm.user_id LIMIT 100`,
    )
      .bind(projectId)
      .all();
    let invitations: unknown[] = [];
    if (membership.role === "ADMIN") {
      const pending = await env.DB.prepare(
        `SELECT i.id,i.invitee_user_id,i.role,i.issued_at,i.expires_at,u.username
         FROM project_invitations i JOIN users u ON u.id=i.invitee_user_id
         WHERE i.project_id=? AND i.status='PENDING'
         ORDER BY i.issued_at DESC,i.id DESC LIMIT 100`,
      )
        .bind(projectId)
        .all();
      invitations = pending.results;
    }
    return response(request, env, {
      members: members.results,
      invitations,
      canManage: membership.role === "ADMIN",
    });
  }

  if (!mutationAllowed(request, env)) return failure(request, env, "ORIGIN_NOT_ALLOWED", 403);
  if (membership.role !== "ADMIN") return failure(request, env, "FORBIDDEN", 403);

  if (request.method === "POST" && !memberUserId && !invitationId) {
    const parsed = await bodyObject(request, env);
    if (parsed instanceof Response) return parsed;
    if (!exactKeys(parsed, ["username", "role"]))
      return failure(request, env, "INVALID_INPUT", 400);
    const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
    const invitedRole = role(parsed.role);
    if (!LOGIN.test(username) || !invitedRole) return failure(request, env, "INVALID_INPUT", 400);
    let resolved: ResolvedProviderIdentity | null;
    try {
      resolved = await identityProvider.resolveLogin(username.toLowerCase());
    } catch {
      return failure(request, env, "IDENTITY_PROVIDER_UNAVAILABLE", 502);
    }
    if (!resolved || resolved.provider !== identityProvider.provider) {
      return failure(request, env, "INVITEE_UNAVAILABLE", 409);
    }
    const invitee = await env.DB.prepare(
      "SELECT id FROM users WHERE provider=? AND provider_user_id=? LIMIT 1",
    )
      .bind(resolved.provider, resolved.providerUserId)
      .first<{ id: string }>();
    if (!invitee) return failure(request, env, "INVITEE_UNAVAILABLE", 409);
    await expireInvitations(env, "project_id", projectId);
    try {
      const created = await env.DB.prepare(
        `INSERT INTO project_invitations(id,project_id,invitee_user_id,role,inviter_user_id,expires_at)
         SELECT ?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days')
         WHERE EXISTS(SELECT 1 FROM projects p JOIN project_members admin ON admin.project_id=p.id
           WHERE p.id=? AND p.status='ACTIVE' AND admin.user_id=? AND admin.role='ADMIN')
           AND ?<>?
           AND NOT EXISTS(SELECT 1 FROM project_members member WHERE member.project_id=? AND member.user_id=?)
           AND NOT EXISTS(SELECT 1 FROM project_invitations pending WHERE pending.project_id=? AND pending.invitee_user_id=? AND pending.status='PENDING')
         RETURNING id,invitee_user_id,role,issued_at,expires_at`,
      )
        .bind(
          crypto.randomUUID(),
          projectId,
          invitee.id,
          invitedRole,
          user.id,
          projectId,
          user.id,
          invitee.id,
          user.id,
          projectId,
          invitee.id,
          projectId,
          invitee.id,
        )
        .first();
      if (!created) return failure(request, env, "INVITEE_UNAVAILABLE", 409);
      return response(request, env, { invitation: created }, 201);
    } catch {
      return failure(request, env, "INVITEE_UNAVAILABLE", 409);
    }
  }

  if (request.method === "DELETE" && invitationId && !memberUserId) {
    if (!ID_PATTERN.test(invitationId)) return failure(request, env, "NOT_FOUND", 404);
    const parsed = await bodyObject(request, env);
    if (parsed instanceof Response) return parsed;
    if (!exactKeys(parsed, [])) return failure(request, env, "INVALID_INPUT", 400);
    const revoked = await env.DB.prepare(
      `UPDATE project_invitations SET status='REVOKED',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revoked_by_user_id=?
       WHERE id=? AND project_id=? AND status='PENDING' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
         AND EXISTS(SELECT 1 FROM projects p JOIN project_members admin ON admin.project_id=p.id
           WHERE p.id=project_invitations.project_id AND p.status='ACTIVE' AND admin.user_id=? AND admin.role='ADMIN')
       RETURNING id`,
    )
      .bind(user.id, invitationId, projectId, user.id)
      .first();
    return revoked ? response(request, env, { ok: true }) : failure(request, env, "CONFLICT", 409);
  }

  if (memberUserId && request.method === "PATCH") {
    if (!ID_PATTERN.test(memberUserId)) return failure(request, env, "NOT_FOUND", 404);
    const parsed = await bodyObject(request, env);
    if (parsed instanceof Response) return parsed;
    if (!exactKeys(parsed, ["role", "expectedRole", "expectedRevision"]))
      return failure(request, env, "INVALID_INPUT", 400);
    const nextRole = role(parsed.role);
    const expectedRole = role(parsed.expectedRole);
    const expectedRevision = revision(parsed.expectedRevision);
    if (
      !nextRole ||
      !expectedRole ||
      !expectedRevision ||
      nextRole === expectedRole ||
      memberUserId === user.id
    ) {
      return failure(request, env, "INVALID_INPUT", 400);
    }
    try {
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE project_members SET previous_role=role,role=?,revision=revision+1,
             role_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),role_updated_by=?
           WHERE project_id=? AND user_id=? AND role=? AND revision=?
             AND EXISTS(SELECT 1 FROM projects p JOIN project_members a ON a.project_id=p.id
               WHERE p.id=? AND p.status='ACTIVE' AND a.user_id=? AND a.role='ADMIN')`,
        ).bind(
          nextRole,
          user.id,
          projectId,
          memberUserId,
          expectedRole,
          expectedRevision,
          projectId,
          user.id,
        ),
        env.DB.prepare(
          `DELETE FROM sync_states WHERE project_id=? AND principal_id IN
             (SELECT id FROM mcp_principals WHERE owner_user_id=?)
           AND EXISTS(SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND role=? AND revision=?)`,
        ).bind(projectId, memberUserId, projectId, memberUserId, nextRole, expectedRevision + 1),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1) return failure(request, env, "CONFLICT", 409);
      return response(request, env, {
        member: { user_id: memberUserId, role: nextRole, revision: expectedRevision + 1 },
      });
    } catch {
      return failure(request, env, "CONFLICT", 409);
    }
  }

  if (memberUserId && request.method === "DELETE") {
    if (!ID_PATTERN.test(memberUserId)) return failure(request, env, "NOT_FOUND", 404);
    const parsed = await bodyObject(request, env);
    if (parsed instanceof Response) return parsed;
    if (!exactKeys(parsed, ["expectedRole", "expectedRevision"]))
      return failure(request, env, "INVALID_INPUT", 400);
    const expectedRole = role(parsed.expectedRole);
    const expectedRevision = revision(parsed.expectedRevision);
    if (!expectedRole || !expectedRevision) return failure(request, env, "INVALID_INPUT", 400);
    try {
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE project_members SET revision=revision+1,
             role_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),role_updated_by=?
           WHERE project_id=? AND user_id=? AND role=? AND revision=?
             AND EXISTS(SELECT 1 FROM projects p JOIN project_members a ON a.project_id=p.id
               WHERE p.id=? AND p.status='ACTIVE' AND a.user_id=? AND a.role='ADMIN')`,
        ).bind(
          user.id,
          projectId,
          memberUserId,
          expectedRole,
          expectedRevision,
          projectId,
          user.id,
        ),
        env.DB.prepare(
          `DELETE FROM project_members WHERE project_id=? AND user_id=? AND role=? AND revision=?
             AND EXISTS(SELECT 1 FROM projects p JOIN project_members a ON a.project_id=p.id
               WHERE p.id=? AND p.status='ACTIVE' AND a.user_id=? AND a.role='ADMIN')`,
        ).bind(projectId, memberUserId, expectedRole, expectedRevision + 1, projectId, user.id),
        env.DB.prepare(
          `DELETE FROM sync_states WHERE project_id=? AND principal_id IN
             (SELECT id FROM mcp_principals WHERE owner_user_id=?)
           AND NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=? AND user_id=?)`,
        ).bind(projectId, memberUserId, projectId, memberUserId),
      ]);
      if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
        return failure(request, env, "CONFLICT", 409);
      }
      return response(request, env, { ok: true });
    } catch {
      return failure(request, env, "CONFLICT", 409);
    }
  }

  const allow = memberUserId ? "PATCH, DELETE" : invitationId ? "DELETE" : "GET, POST";
  return failure(request, env, "METHOD_NOT_ALLOWED", 405, { allow });
}
