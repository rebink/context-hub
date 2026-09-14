import { apiOrigin, callbackUrl } from "./api-origin.js";
import { handleArtifactRoute } from "./artifacts.js";
import { type AuthProviderIdentity, AuthProviderResponseError } from "./auth-provider.js";
import { handleContextRoute } from "./context-route.js";
import { corsJsonHeaders } from "./cors.js";
import {
  beginGitConnection,
  githubAppCallback,
  githubAppSetup,
  handleGitConnection,
} from "./git-connections.js";
import { GithubAuthProvider } from "./github-auth-provider.js";
import { GithubGitProvider } from "./github-git-provider.js";
import { GithubIdentityLookupProvider } from "./github-identity-lookup-provider.js";
import { handleGraphRoute } from "./graphs.js";
import { handleCredentialRoute, handleMachineGraphRoute } from "./machine-graphs.js";
import { handleMcpCredentialRoute, handleMcpRoute } from "./mcp.js";
import type { ObjectStorage } from "./object-storage.js";
import { handleProjectAdministration } from "./project-administration.js";
import { R2ObjectStorage } from "./r2-object-storage.js";
import { normalizeGithubRepository } from "./repository-identity.js";

export { normalizeGithubRepository } from "./repository-identity.js";

import {
  clearCookie,
  cookie,
  randomToken,
  readCookie,
  SESSION_COOKIE,
  STATE_COOKIE,
  sha256,
} from "./security.js";
import { handleSnapshotRoute } from "./snapshots.js";
import { handleSyncRoute } from "./sync.js";
import { handleSyncStateRead, handleSyncStateWrite } from "./sync-states.js";
import { handleInvitationInbox, handleTeamRoute } from "./team.js";

export interface Env {
  DB: D1Database;
  OBJECTS: R2Bucket;
  APP_ENV?: string;
  WEB_ORIGIN?: string;
  API_ORIGIN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

type User = {
  id: string;
  session_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

type Project = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  settings_revision: number;
  role: string;
  member_count: number;
  artifact_count: number;
};

const STATE_TTL_SECONDS = 600;
const MAX_ACTIVE_OAUTH_STATES = 10_000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
function secureCookies(env: Env): boolean {
  return env.APP_ENV === "production";
}

function corsHeaders(request: Request, env: Env): Headers {
  return corsJsonHeaders(request, env);
}

function json(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = corsHeaders(request, env);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => {
      headers.append(key, value);
    });
  }
  return Response.json(body, { status, headers });
}

function requestUrl(request: Request): URL | null {
  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

function redirect(location: string, cookieValue?: string): Response {
  const headers = new Headers({ location });
  if (cookieValue) headers.set("set-cookie", cookieValue);
  return new Response(null, { status: 302, headers });
}

function error(request: Request, env: Env, code: string, status: number): Response {
  return json(request, env, { error: code }, status);
}

function isHostileMutation(request: Request, env: Env): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return false;
  return request.headers.get("origin") !== env.WEB_ORIGIN;
}

function isConflict(value: unknown): boolean {
  return value instanceof Error && /UNIQUE constraint failed/i.test(value.message);
}

async function parseObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function requiredString(body: Record<string, unknown>, key: string, max: number): string | null {
  const value = body[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function validSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 63;
}

async function authenticate(request: Request, env: Env): Promise<User | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(
    `SELECT u.id, s.id AS session_id, u.username, u.display_name, u.avatar_url
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(tokenHash, new Date().toISOString())
    .first<User>();
  return user ?? null;
}

async function health(request: Request, env: Env, storage: ObjectStorage): Promise<Response> {
  try {
    const [database] = await Promise.all([
      env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>(),
      storage.head("__healthcheck__"),
    ]);
    if (database?.ok !== 1) throw new Error("D1 health check failed");
    return json(request, env, {
      service: "context-hub-api",
      status: "ok",
      environment: env.APP_ENV ?? "development",
    });
  } catch {
    return json(request, env, { service: "context-hub-api", status: "unavailable" }, 503);
  }
}

async function beginGithub(
  request: Request,
  env: Env,
  outboundFetch: typeof fetch,
): Promise<Response> {
  const callback = callbackUrl(env, "/auth/github/callback");
  if (!env.GITHUB_CLIENT_ID || !callback) return error(request, env, "AUTH_UNAVAILABLE", 503);
  const state = randomToken();
  const stateHash = await sha256(state);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(now).run();
  const stored = await env.DB.prepare(
    `INSERT INTO oauth_states (state_hash, provider, expires_at)
     SELECT ?, 'github', ?
     WHERE (SELECT COUNT(*) FROM oauth_states WHERE expires_at > ?) < ?
     RETURNING state_hash`,
  )
    .bind(stateHash, expires, now, MAX_ACTIVE_OAUTH_STATES)
    .first<{ state_hash: string }>();
  if (!stored) return error(request, env, "RATE_LIMITED", 429);
  const provider = new GithubAuthProvider(
    { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET ?? "" },
    outboundFetch,
  );
  return redirect(
    provider.authorizationUrl(callback, state),
    cookie(STATE_COOKIE, state, { maxAge: STATE_TTL_SECONDS, secure: secureCookies(env) }),
  );
}

async function githubCallback(
  request: Request,
  env: Env,
  outboundFetch: typeof fetch,
): Promise<Response> {
  const clearState = clearCookie(STATE_COOKIE, secureCookies(env));
  if (
    !env.GITHUB_CLIENT_ID ||
    !env.GITHUB_CLIENT_SECRET ||
    !callbackUrl(env, "/auth/github/callback")
  ) {
    return error(request, env, "AUTH_UNAVAILABLE", 503);
  }
  const url = requestUrl(request);
  if (!url) return error(request, env, "INVALID_REQUEST_URL", 400);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const stateCookie = readCookie(request, STATE_COOKIE);
  if (!state || !code || !stateCookie || state !== stateCookie) {
    return json(request, env, { error: "INVALID_OAUTH_STATE" }, 400, { "set-cookie": clearState });
  }
  const consumed = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE state_hash = ? AND provider = 'github' AND expires_at > ? RETURNING state_hash",
  )
    .bind(await sha256(state), new Date().toISOString())
    .first<{ state_hash: string }>();
  if (!consumed) {
    return json(request, env, { error: "INVALID_OAUTH_STATE" }, 400, { "set-cookie": clearState });
  }

  const provider = new GithubAuthProvider(
    { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    outboundFetch,
  );
  let identity: AuthProviderIdentity;
  try {
    identity = await provider.exchangeCode(code);
  } catch (cause) {
    if (cause instanceof AuthProviderResponseError) return error(request, env, "AUTH_FAILED", 502);
    throw cause;
  }

  const userId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, provider, provider_user_id, username, display_name, avatar_url, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_user_id) DO UPDATE SET
       username = excluded.username, display_name = excluded.display_name,
       avatar_url = excluded.avatar_url, last_login_at = excluded.last_login_at`,
  )
    .bind(
      userId,
      identity.provider,
      identity.providerUserId,
      identity.username,
      identity.displayName,
      identity.avatarUrl,
      new Date().toISOString(),
    )
    .run();
  const user = await env.DB.prepare(
    "SELECT id FROM users WHERE provider = ? AND provider_user_id = ?",
  )
    .bind(identity.provider, identity.providerUserId)
    .first<{ id: string }>();
  if (!user) return error(request, env, "AUTH_FAILED", 502);

  const sessionToken = randomToken();
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      user.id,
      await sha256(sessionToken),
      new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
    )
    .run();
  const sessionCookie = cookie(SESSION_COOKIE, sessionToken, {
    maxAge: SESSION_TTL_SECONDS,
    secure: secureCookies(env),
  });
  const destination = env.WEB_ORIGIN ?? url.origin;
  const headers = new Headers({ location: destination });
  headers.append("set-cookie", clearState);
  headers.append("set-cookie", sessionCookie);
  return new Response(null, { status: 302, headers });
}

async function session(request: Request, env: Env): Promise<Response> {
  const user = await authenticate(request, env);
  if (!user) return error(request, env, "UNAUTHENTICATED", 401);
  const { session_id: _sessionId, ...publicUser } = user;
  return json(request, env, { user: publicUser }, 200);
}

async function logout(request: Request, env: Env): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await sha256(token))
      .run();
  }
  return json(request, env, { ok: true }, 200, {
    "set-cookie": clearCookie(SESSION_COOKIE, secureCookies(env)),
  });
}

async function workspaces(request: Request, env: Env, user: User): Promise<Response> {
  if (request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT w.id, w.name, w.slug, wm.role
       FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = ? ORDER BY w.created_at, w.id`,
    )
      .bind(user.id)
      .all();
    return json(request, env, { workspaces: result.results });
  }
  const body = await parseObject(request);
  const name = body && requiredString(body, "name", 100);
  const slug = body && requiredString(body, "slug", 63);
  if (!body || !name || !slug || !validSlug(slug)) return error(request, env, "INVALID_INPUT", 400);
  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspaces (id, name, slug, created_by) VALUES (?, ?, ?, ?)",
      ).bind(id, name, slug, user.id),
      env.DB.prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'ADMIN')",
      ).bind(id, user.id),
    ]);
  } catch (cause) {
    if (isConflict(cause)) return error(request, env, "CONFLICT", 409);
    throw cause;
  }
  return json(request, env, { workspace: { id, name, slug, role: "ADMIN" } }, 201);
}

async function projects(request: Request, env: Env, user: User): Promise<Response> {
  if (request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT p.id, p.workspace_id, p.name, p.slug, p.description, p.status, p.settings_revision, pm.role,
              (SELECT COUNT(*) FROM project_members members WHERE members.project_id = p.id) AS member_count,
              (SELECT COUNT(*) FROM artifacts artifact WHERE artifact.project_id = p.id AND artifact.status='ACTIVE') AS artifact_count
       FROM projects p JOIN project_members pm ON pm.project_id = p.id
       WHERE pm.user_id = ? ORDER BY p.created_at, p.id`,
    )
      .bind(user.id)
      .all<Project>();
    return json(request, env, { projects: result.results });
  }
  const body = await parseObject(request);
  const workspaceId = body && requiredString(body, "workspaceId", 100);
  const name = body && requiredString(body, "name", 100);
  const slug = body && requiredString(body, "slug", 63);
  const descriptionValue = body?.description;
  const description =
    descriptionValue === undefined || descriptionValue === null
      ? null
      : typeof descriptionValue === "string" && descriptionValue.trim().length <= 500
        ? descriptionValue.trim() || null
        : undefined;
  if (!body || !workspaceId || !name || !slug || !validSlug(slug) || description === undefined) {
    return error(request, env, "INVALID_INPUT", 400);
  }
  const membership = await env.DB.prepare(
    "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
  )
    .bind(workspaceId, user.id)
    .first<{ role: string }>();
  if (membership?.role !== "ADMIN") return error(request, env, "NOT_FOUND", 404);
  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO projects (id, workspace_id, name, slug, description, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, workspaceId, name, slug, description, user.id),
      env.DB.prepare(
        "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'ADMIN')",
      ).bind(id, user.id),
    ]);
  } catch (cause) {
    if (isConflict(cause)) return error(request, env, "CONFLICT", 409);
    throw cause;
  }
  return json(
    request,
    env,
    {
      project: {
        id,
        workspace_id: workspaceId,
        name,
        slug,
        description,
        status: "ACTIVE",
        settings_revision: 1,
        role: "ADMIN",
        member_count: 1,
        artifact_count: 0,
      },
    },
    201,
  );
}

async function resolveProject(request: Request, env: Env, user: User): Promise<Response> {
  const url = requestUrl(request);
  if (!url) return error(request, env, "INVALID_REQUEST_URL", 400);
  const repository = url.searchParams.get("repository");
  const canonical = repository && normalizeGithubRepository(repository);
  if (!canonical) return error(request, env, "INVALID_REPOSITORY", 400);
  const result = await env.DB.prepare(
    `SELECT p.id, p.workspace_id, p.name, p.slug, p.description, p.status, p.settings_revision, pm.role,
            (SELECT COUNT(*) FROM project_members members WHERE members.project_id = p.id) AS member_count,
            (SELECT COUNT(*) FROM artifacts artifact WHERE artifact.project_id = p.id AND artifact.status='ACTIVE') AS artifact_count
     FROM repository_identities ri
     JOIN project_repositories pr ON pr.repository_identity_id = ri.id
     JOIN git_connections gc ON gc.project_id = pr.project_id
       AND gc.repository_identity_id = pr.repository_identity_id
       AND gc.provider = ri.provider AND gc.status = 'VERIFIED'
     JOIN projects p ON p.id = pr.project_id
     JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
     WHERE ri.provider = 'github' AND ri.canonical_url = ?
     ORDER BY p.id LIMIT 21`,
  )
    .bind(user.id, canonical)
    .all<Project>();
  if (result.results.length === 0) return json(request, env, { match: "none", projects: [] });
  if (result.results.length === 1)
    return json(request, env, { match: "unique", project: result.results[0] });
  return json(request, env, { match: "ambiguous", projects: result.results }, 409);
}

async function projectDetail(
  request: Request,
  env: Env,
  user: User,
  id: string,
): Promise<Response> {
  const project = await env.DB.prepare(
    `SELECT p.id, p.workspace_id, p.name, p.slug, p.description, p.status, p.settings_revision, pm.role,
            (SELECT COUNT(*) FROM project_members members WHERE members.project_id = p.id) AS member_count,
            (SELECT COUNT(*) FROM artifacts artifact WHERE artifact.project_id = p.id AND artifact.status='ACTIVE') AS artifact_count
     FROM projects p JOIN project_members pm ON pm.project_id = p.id
     WHERE p.id = ? AND pm.user_id = ?`,
  )
    .bind(id, user.id)
    .first<Project>();
  if (!project) return error(request, env, "NOT_FOUND", 404);
  return json(request, env, { project });
}

function gitProvider(env: Env, outboundFetch: typeof fetch): GithubGitProvider | null {
  if (
    !env.GITHUB_APP_ID ||
    !env.GITHUB_APP_SLUG ||
    !env.GITHUB_APP_CLIENT_ID ||
    !env.GITHUB_APP_CLIENT_SECRET ||
    !env.GITHUB_APP_PRIVATE_KEY
  ) {
    return null;
  }
  return new GithubGitProvider(
    {
      appId: env.GITHUB_APP_ID,
      appSlug: env.GITHUB_APP_SLUG,
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    },
    outboundFetch,
  );
}

async function options(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== env.WEB_ORIGIN) return error(request, env, "ORIGIN_NOT_ALLOWED", 403);
  const headers = corsHeaders(request, env);
  headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
}

export function createApp(outboundFetch: typeof fetch = fetch) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        const { pathname } = new URL(request.url);
        const storage = new R2ObjectStorage(env.OBJECTS);
        if (request.method === "OPTIONS") return options(request, env);

        if (pathname === "/mcp") return handleMcpRoute(request, env, storage);

        const mcpCredentialCollection = pathname === "/mcp-credentials";
        const mcpCredentialRotate = /^\/mcp-credentials\/([^/]+)\/rotate$/.exec(pathname);
        const mcpCredentialDetail = /^\/mcp-credentials\/([^/]+)$/.exec(pathname);
        if (mcpCredentialCollection || mcpCredentialRotate || mcpCredentialDetail) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          return handleMcpCredentialRoute(
            request,
            env,
            user,
            mcpCredentialRotate?.[1] ?? mcpCredentialDetail?.[1],
            Boolean(mcpCredentialRotate),
          );
        }

        const machineGraph =
          /^\/machine\/projects\/([^/]+)\/graphs\/([^/]+)\/(claim|publish|fail)$/.exec(pathname);
        if (machineGraph) {
          return handleMachineGraphRoute(
            request,
            env,
            storage,
            machineGraph[1] ?? "",
            machineGraph[2] ?? "",
            machineGraph[3] as "claim" | "publish" | "fail",
          );
        }

        const credentialCollection = /^\/projects\/([^/]+)\/machine-credentials$/.exec(pathname);
        const credentialRotate = /^\/projects\/([^/]+)\/machine-credentials\/([^/]+)\/rotate$/.exec(
          pathname,
        );
        const credentialDetail = /^\/projects\/([^/]+)\/machine-credentials\/([^/]+)$/.exec(
          pathname,
        );
        const credentialRoute = credentialRotate ?? credentialDetail ?? credentialCollection;
        if (credentialRoute) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          return handleCredentialRoute(
            request,
            env,
            user,
            credentialRoute[1] ?? "",
            credentialRoute[2],
            Boolean(credentialRotate),
          );
        }

        const invitationAccept = /^\/invitations\/([^/]+)\/accept$/.exec(pathname);
        if (pathname === "/invitations" || invitationAccept) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          return handleInvitationInbox(request, env, user, invitationAccept?.[1]);
        }

        const teamInvitation = /^\/projects\/([^/]+)\/team\/invitations\/([^/]+)$/.exec(pathname);
        const teamMember = /^\/projects\/([^/]+)\/team\/members\/([^/]+)$/.exec(pathname);
        const teamCollection = /^\/projects\/([^/]+)\/team$/.exec(pathname);
        const teamRoute = teamInvitation ?? teamMember ?? teamCollection;
        if (teamRoute) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          return handleTeamRoute(
            request,
            env,
            user,
            teamRoute[1] ?? "",
            new GithubIdentityLookupProvider(outboundFetch),
            teamMember?.[2],
            teamInvitation?.[2],
          );
        }

        const syncStateCurrent = /^\/projects\/([^/]+)\/sync-states\/current$/.exec(pathname);
        const syncStateCollection = /^\/projects\/([^/]+)\/sync-states$/.exec(pathname);
        const syncStateRoute = syncStateCurrent ?? syncStateCollection;
        if (syncStateRoute) {
          if (request.method === "PUT" && syncStateCurrent) {
            return handleSyncStateWrite(request, env, syncStateRoute[1] ?? "");
          }
          if (request.method !== "GET") {
            return error(request, env, "METHOD_NOT_ALLOWED", 405);
          }
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          return handleSyncStateRead(
            request,
            env,
            user,
            syncStateRoute[1] ?? "",
            Boolean(syncStateCurrent),
          );
        }

        const syncMetadata = /^\/projects\/([^/]+)\/sync$/.exec(pathname);
        const syncDownload = /^\/projects\/([^/]+)\/sync\/graph\/([^/]+)$/.exec(pathname);
        const syncRoute = syncDownload ?? syncMetadata;
        if (syncRoute) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          return handleSyncRoute(
            request,
            env,
            storage,
            user,
            syncRoute[1] ?? "",
            syncDownload?.[2],
          );
        }

        const contextSearch = /^\/projects\/([^/]+)\/context\/search$/.exec(pathname);
        if (contextSearch) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          return handleContextRoute(request, env, storage, user, contextSearch[1] ?? "");
        }

        const graphCollection = /^\/projects\/([^/]+)\/graphs$/.exec(pathname);
        const graphSegment = /^\/projects\/([^/]+)\/graphs\/([^/]+)$/.exec(pathname);
        const graphQuery = /^\/projects\/([^/]+)\/graphs\/([^/]+)\/query$/.exec(pathname);
        const graphRoute = graphQuery ?? graphSegment ?? graphCollection;
        if (graphRoute) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          return handleGraphRoute(
            request,
            env,
            storage,
            user,
            graphRoute[1] ?? "",
            graphRoute[2],
            Boolean(graphQuery),
          );
        }

        const snapshotCollection = /^\/projects\/([^/]+)\/snapshots$/.exec(pathname);
        const snapshotManifest = /^\/projects\/([^/]+)\/snapshots\/([^/]+)\/manifest$/.exec(
          pathname,
        );
        const snapshotDetail = /^\/projects\/([^/]+)\/snapshots\/([^/]+)$/.exec(pathname);
        const snapshotRoute = snapshotManifest ?? snapshotDetail ?? snapshotCollection;
        if (snapshotRoute) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          const allowed = snapshotCollection
            ? ["GET", "POST"].includes(request.method)
            : request.method === "GET";
          if (!allowed) {
            return json(request, env, { error: "METHOD_NOT_ALLOWED" }, 405, {
              allow: snapshotCollection ? "GET, POST" : "GET",
            });
          }
          return handleSnapshotRoute(
            request,
            env,
            storage,
            user,
            snapshotRoute[1] ?? "",
            snapshotRoute[2],
            Boolean(snapshotManifest),
          );
        }

        const artifactCollection = /^\/projects\/([^/]+)\/artifacts$/.exec(pathname);
        const artifactDetail = /^\/projects\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
        const versionCollection = /^\/projects\/([^/]+)\/artifacts\/([^/]+)\/versions$/.exec(
          pathname,
        );
        const versionDetail = /^\/projects\/([^/]+)\/artifacts\/([^/]+)\/versions\/([^/]+)$/.exec(
          pathname,
        );
        const artifactRoute =
          versionDetail ?? versionCollection ?? artifactDetail ?? artifactCollection;
        const artifactMethodAllowed =
          (artifactCollection && ["GET", "POST"].includes(request.method)) ||
          (artifactDetail && ["GET", "DELETE"].includes(request.method)) ||
          (versionCollection && ["GET", "POST"].includes(request.method)) ||
          (versionDetail && request.method === "GET");
        if (artifactRoute) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          if (!artifactMethodAllowed) {
            const allow = artifactDetail ? "GET, DELETE" : versionDetail ? "GET" : "GET, POST";
            return json(request, env, { error: "METHOD_NOT_ALLOWED" }, 405, { allow });
          }
          return await handleArtifactRoute(
            request,
            env,
            storage,
            user,
            artifactRoute[1] ?? "",
            artifactRoute[2],
            versionDetail?.[3],
          );
        }

        const projectSettings =
          request.method === "PATCH" ? /^\/projects\/([^/]+)$/.exec(pathname) : null;
        if (projectSettings) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          return await handleProjectAdministration(request, env, user, projectSettings[1] ?? "");
        }

        if (isHostileMutation(request, env)) return error(request, env, "ORIGIN_NOT_ALLOWED", 403);

        if (pathname === "/api/health") {
          if (request.method !== "GET") return error(request, env, "METHOD_NOT_ALLOWED", 405);
          return health(request, env, storage);
        }
        if (pathname === "/auth/github" && request.method === "GET")
          return beginGithub(request, env, outboundFetch);
        if (pathname === "/auth/github/callback" && request.method === "GET") {
          return await githubCallback(request, env, outboundFetch);
        }
        if (
          (pathname === "/auth/github-app/setup" || pathname === "/auth/github-app/callback") &&
          request.method === "GET"
        ) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          const provider = gitProvider(env, outboundFetch);
          if (!provider || !apiOrigin(env)) return error(request, env, "GIT_UNAVAILABLE", 503);
          return pathname.endsWith("/setup")
            ? githubAppSetup(request, env, user, provider)
            : githubAppCallback(request, env, user, provider);
        }
        if (pathname === "/auth/session" && request.method === "GET") return session(request, env);
        if (pathname === "/auth/logout" && request.method === "POST") return logout(request, env);

        const gitMatch = /^\/projects\/([^/]+)\/git$/.exec(pathname);
        const gitSyncMatch = /^\/projects\/([^/]+)\/git\/sync$/.exec(pathname);
        if (gitMatch || gitSyncMatch) {
          const methodAllowed = gitSyncMatch
            ? request.method === "POST"
            : ["GET", "POST", "DELETE"].includes(request.method);
          if (!methodAllowed) return error(request, env, "METHOD_NOT_ALLOWED", 405);
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          const provider = gitProvider(env, outboundFetch);
          const projectId = (gitMatch ?? gitSyncMatch)?.[1] ?? "";
          if (gitMatch && request.method === "POST") {
            if (!provider) return error(request, env, "GIT_UNAVAILABLE", 503);
            return beginGitConnection(
              request,
              env,
              user,
              projectId,
              provider,
              normalizeGithubRepository,
            );
          }
          return handleGitConnection(request, env, user, projectId, provider);
        }

        const isWorkspaceRoute =
          pathname === "/workspaces" && ["GET", "POST"].includes(request.method);
        const isProjectsRoute =
          pathname === "/projects" && ["GET", "POST"].includes(request.method);
        const isResolveRoute = pathname === "/projects/resolve" && request.method === "GET";
        const projectPath = /^\/projects\/([^/]+)$/.exec(pathname);
        const detailMatch = request.method === "GET" ? projectPath : null;
        if (isWorkspaceRoute || isProjectsRoute || isResolveRoute || detailMatch) {
          const user = await authenticate(request, env);
          if (!user) return error(request, env, "UNAUTHENTICATED", 401);
          if (isWorkspaceRoute) return workspaces(request, env, user);
          if (isProjectsRoute) return projects(request, env, user);
          if (isResolveRoute) return resolveProject(request, env, user);
          if (detailMatch) {
            const id = detailMatch[1];
            if (!id || !/^[A-Za-z0-9_-]+$/.test(id))
              return error(request, env, "INVALID_INPUT", 400);
            return projectDetail(request, env, user, id);
          }
        }
        return error(request, env, "NOT_FOUND", 404);
      } catch {
        return error(request, env, "INTERNAL_ERROR", 500);
      }
    },
  };
}

export const app = createApp();
export default app;
