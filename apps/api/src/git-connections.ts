import { callbackUrl } from "./api-origin.js";
import type { GitProvider, GitRepositoryInspection } from "./git-provider.js";
import { GitProviderError } from "./git-provider.js";
import { clearCookie, cookie, randomToken, readCookie, sha256 } from "./security.js";

export type GitRouteEnv = {
  DB: D1Database;
  APP_ENV?: string;
  WEB_ORIGIN?: string;
  API_ORIGIN?: string;
};

export type GitRouteUser = { id: string; session_id: string };

type LoadedConnection = {
  connection_id: string | null;
  repository_identity_id: string;
  installation_id: string;
  provider_repository_id: string;
  canonical_url: string;
  owner: string;
  repository_name: string;
  default_branch: string;
  last_known_commit_sha: string;
  status: string;
  verified_at: string;
  updated_at: string;
};

const STATE_TTL_SECONDS = 600;
const MAX_ACTIVE_STATES = 10_000;
const MAX_BODY_BYTES = 2048;
const PKCE_COOKIE = "context_hub_git_pkce";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function secure(env: GitRouteEnv): boolean {
  return env.APP_ENV === "production";
}

function response(request: Request, env: GitRouteEnv, value: object, status = 200): Response {
  const headers = new Headers(JSON_HEADERS);
  const origin = request.headers.get("origin");
  if (origin && origin === env.WEB_ORIGIN) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "origin");
  }
  return Response.json(value, { status, headers });
}

function failure(request: Request, env: GitRouteEnv, code: string, status: number): Response {
  return response(request, env, { error: code }, status);
}

function projectIdValid(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

async function membership(env: GitRouteEnv, userId: string, projectId: string) {
  return env.DB.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
    .bind(projectId, userId)
    .first<{ role: string }>();
}

async function boundedObject(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseCanonical(canonical: string): { owner: string; repository: string } | null {
  const match = /^github\.com\/([a-z0-9](?:[a-z0-9-]{0,38}))\/([a-z0-9_.-]{1,100})$/.exec(
    canonical,
  );
  return match?.[1] && match[2] ? { owner: match[1], repository: match[2] } : null;
}

function providerError(request: Request, env: GitRouteEnv, cause: unknown): Response {
  if (cause instanceof GitProviderError && cause.kind === "rate-limited") {
    return failure(request, env, "GIT_RATE_LIMITED", 429);
  }
  return failure(request, env, "GIT_PROVIDER_FAILED", 502);
}

function callbackRedirect(
  env: GitRouteEnv,
  projectId: string | null,
  errorCode?: string,
): Response {
  const destination = new URL(env.WEB_ORIGIN ?? "http://localhost:5173/");
  if (projectId) destination.searchParams.set("project", projectId);
  if (errorCode) destination.searchParams.set("git_error", errorCode.slice(0, 40));
  else destination.searchParams.set("git", "connected");
  return new Response(null, {
    status: 302,
    headers: {
      location: destination.toString(),
      "set-cookie": clearCookie(PKCE_COOKIE, secure(env)),
    },
  });
}

async function publishConnection(
  env: GitRouteEnv,
  userId: string,
  sessionId: string,
  stateHash: string,
  projectId: string,
  installationId: string,
  inspection: GitRepositoryInspection,
): Promise<boolean> {
  const identityId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const now = new Date().toISOString();
  const publicationPredicate = `EXISTS (
    SELECT 1 FROM github_connection_states
    WHERE state_hash = ? AND kind = 'AUTHORIZE' AND user_id = ? AND session_id = ?
      AND project_id = ? AND consumed_at IS NOT NULL AND expires_at > ?
  ) AND EXISTS (
    SELECT 1 FROM project_members
    WHERE project_id = ? AND user_id = ? AND role = 'ADMIN'
  ) AND NOT EXISTS (SELECT 1 FROM git_connections WHERE project_id = ?)`;

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO repository_identities (id, provider, canonical_url, owner, repository_name)
       SELECT ?, 'github', ?, ?, ? WHERE ${publicationPredicate}
       ON CONFLICT(canonical_url) DO NOTHING`,
    ).bind(
      identityId,
      inspection.canonicalUrl,
      inspection.owner,
      inspection.name,
      stateHash,
      userId,
      sessionId,
      projectId,
      now,
      projectId,
      userId,
      projectId,
    ),
    env.DB.prepare(
      `INSERT INTO git_connections
       (connection_id, project_id, repository_identity_id, provider, installation_id,
        provider_repository_id, default_branch, last_known_commit_sha, status, verified_at,
        created_at, updated_at)
       SELECT ?, ?, ri.id, 'github', ?, ?, ?, ?, 'VERIFIED', ?, ?, ?
       FROM repository_identities ri
       WHERE ri.provider = 'github' AND ri.canonical_url = ? AND ${publicationPredicate}`,
    ).bind(
      connectionId,
      projectId,
      installationId,
      inspection.providerRepositoryId,
      inspection.defaultBranch,
      inspection.headSha,
      now,
      now,
      now,
      inspection.canonicalUrl,
      stateHash,
      userId,
      sessionId,
      projectId,
      now,
      projectId,
      userId,
      projectId,
    ),
    env.DB.prepare(
      `INSERT INTO project_repositories (project_id, repository_identity_id)
       SELECT gc.project_id, gc.repository_identity_id FROM git_connections gc
       WHERE gc.project_id = ? AND gc.connection_id = ?`,
    ).bind(projectId, connectionId),
    env.DB.prepare(
      `INSERT INTO git_audit_events
       (id, project_id, repository_identity_id, event_type, actor_id, metadata)
       SELECT ?, gc.project_id, gc.repository_identity_id, 'git-connected', ?, ?
       FROM git_connections gc WHERE gc.project_id = ? AND gc.connection_id = ?`,
    ).bind(
      auditId,
      userId,
      JSON.stringify({ defaultBranch: inspection.defaultBranch, commitSha: inspection.headSha }),
      projectId,
      connectionId,
    ),
    env.DB.prepare(
      `DELETE FROM github_connection_states WHERE project_id = ? AND EXISTS (
         SELECT 1 FROM git_audit_events WHERE id = ? AND project_id = ?
       )`,
    ).bind(projectId, auditId, projectId),
  ]);
  return (
    Number(results[1]?.meta.changes ?? 0) === 1 &&
    Number(results[2]?.meta.changes ?? 0) === 1 &&
    Number(results[3]?.meta.changes ?? 0) === 1
  );
}

export async function beginGitConnection(
  request: Request,
  env: GitRouteEnv,
  user: GitRouteUser,
  projectId: string,
  provider: GitProvider,
  normalize: (value: string) => string | null,
): Promise<Response> {
  if (!projectIdValid(projectId)) return failure(request, env, "INVALID_INPUT", 400);
  const member = await membership(env, user.id, projectId);
  if (!member) return failure(request, env, "NOT_FOUND", 404);
  if (member.role !== "ADMIN") return failure(request, env, "FORBIDDEN", 403);
  const body = await boundedObject(request);
  const repositoryUrl = body?.repositoryUrl;
  const canonical = typeof repositoryUrl === "string" ? normalize(repositoryUrl) : null;
  const target = canonical && parseCanonical(canonical);
  if (!target) return failure(request, env, "INVALID_REPOSITORY", 400);
  const existing = await env.DB.prepare(
    "SELECT project_id FROM git_connections WHERE project_id = ?",
  )
    .bind(projectId)
    .first();
  if (existing) return failure(request, env, "GIT_ALREADY_CONNECTED", 409);
  const state = randomToken();
  const now = new Date().toISOString();
  await env.DB.prepare("DELETE FROM github_connection_states WHERE expires_at <= ?")
    .bind(now)
    .run();
  const stored = await env.DB.prepare(
    `INSERT INTO github_connection_states
     (state_hash, kind, user_id, session_id, project_id, canonical_url, owner, repository_name,
      expires_at)
     SELECT ?, 'INSTALL', ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM github_connection_states WHERE expires_at > ?) < ?
     RETURNING state_hash`,
  )
    .bind(
      await sha256(state),
      user.id,
      user.session_id,
      projectId,
      canonical,
      target.owner,
      target.repository,
      new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString(),
      now,
      MAX_ACTIVE_STATES,
    )
    .first<{ state_hash: string }>();
  if (!stored) return failure(request, env, "RATE_LIMITED", 429);
  return response(request, env, { installationUrl: provider.installationUrl(state) }, 201);
}

export async function githubAppSetup(
  _request: Request,
  env: GitRouteEnv,
  user: GitRouteUser,
  provider: GitProvider,
): Promise<Response> {
  const query = new URL(_request.url).searchParams;
  const state = query.get("state");
  const action = query.get("setup_action");
  const installationId = query.get("installation_id");
  const callback = callbackUrl(env, "/auth/github-app/callback");
  if (
    !callback ||
    !state ||
    state.length > 512 ||
    action !== "install" ||
    !installationId ||
    !/^\d{1,20}$/.test(installationId)
  ) {
    return callbackRedirect(env, null, callback ? "invalid_setup" : "invalid_configuration");
  }
  const authorizeState = randomToken();
  const verifier = randomToken(48);
  const verifierHash = await sha256(verifier);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const consumed = await env.DB.prepare(
    `UPDATE github_connection_states SET
       state_hash = ?, kind = 'AUTHORIZE', installation_id = ?, verifier_hash = ?, expires_at = ?
     WHERE state_hash = ? AND kind = 'INSTALL' AND user_id = ? AND session_id = ?
       AND consumed_at IS NULL AND expires_at > ?
     RETURNING project_id`,
  )
    .bind(
      await sha256(authorizeState),
      installationId,
      verifierHash,
      new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString(),
      await sha256(state),
      user.id,
      user.session_id,
      new Date().toISOString(),
    )
    .first<{ project_id: string }>();
  if (!consumed) return callbackRedirect(env, null, "invalid_state");
  return new Response(null, {
    status: 302,
    headers: {
      location: provider.userAuthorizationUrl(callback, authorizeState, challenge),
      "set-cookie": cookie(PKCE_COOKIE, verifier, {
        maxAge: STATE_TTL_SECONDS,
        secure: secure(env),
      }),
    },
  });
}

export async function githubAppCallback(
  request: Request,
  env: GitRouteEnv,
  user: GitRouteUser,
  provider: GitProvider,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const state = query.get("state");
  const code = query.get("code");
  const verifier = readCookie(request, PKCE_COOKIE);
  const callback = callbackUrl(env, "/auth/github-app/callback");
  if (
    !callback ||
    !state ||
    !code ||
    !verifier ||
    state.length > 512 ||
    code.length > 512 ||
    verifier.length > 128
  ) {
    return callbackRedirect(env, null, callback ? "invalid_callback" : "invalid_configuration");
  }
  const stateHash = await sha256(state);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `UPDATE github_connection_states SET consumed_at = ?
     WHERE state_hash = ? AND kind = 'AUTHORIZE' AND user_id = ? AND session_id = ?
       AND verifier_hash = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING project_id, canonical_url, owner, repository_name, installation_id`,
  )
    .bind(now, stateHash, user.id, user.session_id, await sha256(verifier), now)
    .first<{
      project_id: string;
      canonical_url: string;
      owner: string;
      repository_name: string;
      installation_id: string;
    }>();
  if (!row) return callbackRedirect(env, null, "invalid_state");
  const member = await membership(env, user.id, row.project_id);
  if (member?.role !== "ADMIN") return callbackRedirect(env, row.project_id, "forbidden");
  const identity = await env.DB.prepare(
    "SELECT provider_user_id FROM users WHERE id = ? AND provider = 'github'",
  )
    .bind(user.id)
    .first<{ provider_user_id: string }>();
  if (!identity) return callbackRedirect(env, row.project_id, "identity_mismatch");
  try {
    const authorized = await provider.authorizeAndInspect({
      code,
      codeVerifier: verifier,
      redirectUri: callback,
      installationId: row.installation_id,
      owner: row.owner,
      repository: row.repository_name,
    });
    if (
      authorized.providerUserId !== identity.provider_user_id ||
      authorized.repository.canonicalUrl !== row.canonical_url
    ) {
      return callbackRedirect(env, row.project_id, "identity_mismatch");
    }
    const published = await publishConnection(
      env,
      user.id,
      user.session_id,
      stateHash,
      row.project_id,
      row.installation_id,
      authorized.repository,
    );
    if (!published) {
      const currentMember = await membership(env, user.id, row.project_id);
      return callbackRedirect(
        env,
        row.project_id,
        currentMember?.role === "ADMIN" ? "stale_connection" : "forbidden",
      );
    }
    return callbackRedirect(env, row.project_id);
  } catch (cause) {
    if (cause instanceof GitProviderError)
      return callbackRedirect(env, row.project_id, "provider_failed");
    return callbackRedirect(env, row.project_id, "connection_failed");
  }
}

export async function handleGitConnection(
  request: Request,
  env: GitRouteEnv,
  user: GitRouteUser,
  projectId: string,
  provider: GitProvider | null,
): Promise<Response> {
  if (!projectIdValid(projectId)) return failure(request, env, "INVALID_INPUT", 400);
  const member = await membership(env, user.id, projectId);
  if (!member) return failure(request, env, "NOT_FOUND", 404);
  if (request.method !== "GET" && member.role !== "ADMIN") {
    return failure(request, env, "FORBIDDEN", 403);
  }
  if (request.method === "GET") {
    const connection = await env.DB.prepare(
      `SELECT gc.provider, ri.canonical_url, ri.owner, ri.repository_name, gc.default_branch,
              gc.last_known_commit_sha, gc.provider_repository_id, gc.status,
              gc.verified_at, gc.created_at, gc.updated_at
       FROM git_connections gc JOIN repository_identities ri ON ri.id = gc.repository_identity_id
       WHERE gc.project_id = ?`,
    )
      .bind(projectId)
      .first<Record<string, unknown>>();
    return response(request, env, { connection: connection ?? null });
  }
  const connection = await env.DB.prepare(
    `SELECT gc.connection_id, gc.repository_identity_id, gc.installation_id,
            gc.provider_repository_id, ri.canonical_url, ri.owner, ri.repository_name,
            gc.default_branch, gc.last_known_commit_sha, gc.status, gc.verified_at, gc.updated_at
     FROM git_connections gc JOIN repository_identities ri ON ri.id = gc.repository_identity_id
     WHERE gc.project_id = ?`,
  )
    .bind(projectId)
    .first<LoadedConnection>();
  if (!connection) return failure(request, env, "GIT_NOT_CONNECTED", 404);
  if (request.method === "DELETE") {
    const auditId = crypto.randomUUID();
    const adminPredicate = `EXISTS (
      SELECT 1 FROM project_members
      WHERE project_id = ? AND user_id = ? AND role = 'ADMIN'
    )`;
    const exactConnectionPredicate = `EXISTS (
      SELECT 1 FROM git_connections WHERE project_id = ? AND connection_id IS ?
        AND repository_identity_id = ? AND installation_id = ? AND provider_repository_id = ?
    )`;
    const exactArgs = [
      projectId,
      connection.connection_id,
      connection.repository_identity_id,
      connection.installation_id,
      connection.provider_repository_id,
    ];
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO git_audit_events
         (id, project_id, repository_identity_id, event_type, actor_id, metadata)
         SELECT ?, ?, ?, 'git-disconnected', ?, '{}'
         WHERE ${adminPredicate} AND ${exactConnectionPredicate}
           AND EXISTS (
             SELECT 1 FROM project_repositories
             WHERE project_id = ? AND repository_identity_id = ?
           )`,
      ).bind(
        auditId,
        projectId,
        connection.repository_identity_id,
        user.id,
        projectId,
        user.id,
        ...exactArgs,
        projectId,
        connection.repository_identity_id,
      ),
      env.DB.prepare(
        `DELETE FROM project_repositories WHERE project_id = ? AND repository_identity_id = ?
         AND ${adminPredicate} AND ${exactConnectionPredicate}`,
      ).bind(projectId, connection.repository_identity_id, projectId, user.id, ...exactArgs),
      env.DB.prepare(
        `DELETE FROM git_connections WHERE project_id = ? AND connection_id IS ?
         AND repository_identity_id = ? AND installation_id = ? AND provider_repository_id = ?
         AND ${adminPredicate} AND EXISTS (
           SELECT 1 FROM git_audit_events WHERE id = ? AND project_id = ?
         )`,
      ).bind(...exactArgs, projectId, user.id, auditId, projectId),
      env.DB.prepare(
        `DELETE FROM github_connection_states WHERE project_id = ? AND EXISTS (
           SELECT 1 FROM git_audit_events WHERE id = ? AND project_id = ?
         )`,
      ).bind(projectId, auditId, projectId),
    ]);
    if (
      Number(results[0]?.meta.changes ?? 0) !== 1 ||
      Number(results[1]?.meta.changes ?? 0) !== 1 ||
      Number(results[2]?.meta.changes ?? 0) !== 1
    ) {
      const currentMember = await membership(env, user.id, projectId);
      if (!currentMember) return failure(request, env, "NOT_FOUND", 404);
      if (currentMember.role !== "ADMIN") return failure(request, env, "FORBIDDEN", 403);
      return failure(request, env, "GIT_STALE_OPERATION", 409);
    }
    return response(request, env, { ok: true });
  }
  if (request.method !== "POST") return failure(request, env, "METHOD_NOT_ALLOWED", 405);
  if (!provider) return failure(request, env, "GIT_UNAVAILABLE", 503);
  try {
    const inspection = await provider.inspectInstallation({
      installationId: connection.installation_id,
      owner: connection.owner,
      repository: connection.repository_name,
    });
    if (
      inspection.providerRepositoryId !== connection.provider_repository_id ||
      inspection.canonicalUrl !== connection.canonical_url
    ) {
      throw new GitProviderError("repository-mismatch");
    }
    const changed =
      inspection.defaultBranch !== connection.default_branch ||
      inspection.headSha !== connection.last_known_commit_sha ||
      connection.status !== "VERIFIED";
    const now = new Date().toISOString();
    const auditId = crypto.randomUUID();
    const exactConnection = `project_id = ? AND connection_id IS ?
      AND repository_identity_id = ? AND installation_id = ? AND provider_repository_id = ?
      AND default_branch = ? AND last_known_commit_sha = ? AND status = ?
      AND verified_at = ? AND updated_at = ?`;
    const exactArgs = [
      projectId,
      connection.connection_id,
      connection.repository_identity_id,
      connection.installation_id,
      connection.provider_repository_id,
      connection.default_branch,
      connection.last_known_commit_sha,
      connection.status,
      connection.verified_at,
      connection.updated_at,
    ];
    const adminPredicate = `EXISTS (
      SELECT 1 FROM project_members
      WHERE project_id = ? AND user_id = ? AND role = 'ADMIN'
    )`;
    let results: D1Result[];
    try {
      results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE git_connections SET default_branch = ?, last_known_commit_sha = ?,
           status = 'VERIFIED', verified_at = ?, updated_at = ?
           WHERE ${exactConnection} AND ${adminPredicate}`,
        ).bind(
          inspection.defaultBranch,
          inspection.headSha,
          now,
          now,
          ...exactArgs,
          projectId,
          user.id,
        ),
        env.DB.prepare(
          `INSERT INTO git_audit_events
           (id, project_id, repository_identity_id, event_type, actor_id, metadata)
           SELECT ?, ?, ?, 'git-synced', ?, ? WHERE ${adminPredicate}
             AND EXISTS (
               SELECT 1 FROM git_connections WHERE project_id = ? AND connection_id IS ?
                 AND repository_identity_id = ? AND installation_id = ?
                 AND provider_repository_id = ? AND default_branch = ?
                 AND last_known_commit_sha = ? AND status = 'VERIFIED'
                 AND verified_at = ? AND updated_at = ?
             )`,
        ).bind(
          auditId,
          projectId,
          connection.repository_identity_id,
          user.id,
          JSON.stringify({
            changed,
            old: {
              defaultBranch: connection.default_branch,
              commitSha: connection.last_known_commit_sha,
            },
            new: { defaultBranch: inspection.defaultBranch, commitSha: inspection.headSha },
          }),
          projectId,
          user.id,
          projectId,
          connection.connection_id,
          connection.repository_identity_id,
          connection.installation_id,
          connection.provider_repository_id,
          inspection.defaultBranch,
          inspection.headSha,
          now,
          now,
        ),
      ]);
    } catch {
      return failure(request, env, "GIT_PERSISTENCE_FAILED", 500);
    }
    if (
      Number(results[0]?.meta.changes ?? 0) !== 1 ||
      Number(results[1]?.meta.changes ?? 0) !== 1
    ) {
      const currentMember = await membership(env, user.id, projectId);
      if (!currentMember) return failure(request, env, "NOT_FOUND", 404);
      if (currentMember.role !== "ADMIN") return failure(request, env, "FORBIDDEN", 403);
      return failure(request, env, "GIT_STALE_OPERATION", 409);
    }
    return response(request, env, {
      changed,
      defaultBranch: inspection.defaultBranch,
      lastKnownCommitSha: inspection.headSha,
      verifiedAt: now,
    });
  } catch (cause) {
    return providerError(request, env, cause);
  }
}
