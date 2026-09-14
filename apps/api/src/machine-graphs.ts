import {
  claimOrReclaimExpiredGraphBuild,
  failGraphBuild,
  GRAPH_BUILD_IDENTITY,
  type GraphBuildResult,
  type GraphClaim,
  GraphConflictError,
  publishGraphBuild,
} from "./graphs.js";
import type { ObjectStorage } from "./object-storage.js";
import { randomToken, sha256, sha256Bytes } from "./security.js";

const ID = /^[A-Za-z0-9_-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const FAILURE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_CREDENTIAL_DAYS = 90;
const NONCE_TTL_MINUTES = 60;

type Env = { DB: D1Database; WEB_ORIGIN?: string };
type Human = { id: string };
type MachineOperation = "CLAIM" | "PUBLISH" | "FAIL";
type MachineIdentity = {
  principal_id: string;
  credential_id: string;
  project_id: string;
  repository_provider: string;
  provider_repository_id: string;
};
type BuildRow = {
  project_id: string;
  version: number;
  attempt: number;
  repository_provider: string;
  provider_repository_id: string;
  repository_owner: string;
  repository_name: string;
  repository_canonical_url: string;
  source_commit_sha: string;
  graphify_version: string;
  adapter_version: string;
  profile: string;
  format_version: number;
  generator: string;
};

function response(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function invalid(status = 400): Response {
  return response({ error: status === 401 ? "INVALID_CREDENTIAL" : "INVALID_INPUT" }, status);
}

async function bodyObject(request: Request): Promise<Record<string, unknown> | null> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) return null;
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json" || !request.body)
    return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
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
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function humanHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (request.headers.get("origin") === env.WEB_ORIGIN) {
    headers.set("access-control-allow-origin", env.WEB_ORIGIN ?? "");
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "origin");
  }
  return headers;
}

function humanResponse(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(body, { status, headers: humanHeaders(request, env) });
}

async function directAdmin(
  env: Env,
  projectId: string,
  userId: string,
): Promise<"ADMIN" | "MEMBER" | null> {
  const row = await env.DB.prepare(
    "SELECT role FROM project_members WHERE project_id=? AND user_id=?",
  )
    .bind(projectId, userId)
    .first<{ role: string }>();
  return row?.role === "ADMIN" ? "ADMIN" : row ? "MEMBER" : null;
}

function publicCredential(row: Record<string, unknown>) {
  return {
    id: row.id,
    principalId: row.principal_id,
    name: row.name,
    repositoryProvider: row.repository_provider,
    providerRepositoryId: row.provider_repository_id,
    scope: row.scope,
    status: row.credential_status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

async function issueCredential(
  request: Request,
  env: Env,
  user: Human,
  projectId: string,
): Promise<Response> {
  const body = await bodyObject(request);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const expiresInDays = body?.expiresInDays;
  if (
    !body ||
    Object.keys(body).some((key) => !["name", "expiresInDays"].includes(key)) ||
    name.length < 1 ||
    new TextEncoder().encode(name).byteLength > 80 ||
    !Number.isSafeInteger(expiresInDays) ||
    (expiresInDays as number) < 1 ||
    (expiresInDays as number) > MAX_CREDENTIAL_DAYS
  )
    return humanResponse(request, env, { error: "INVALID_INPUT" }, 400);

  const principalId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const secret = randomToken(32);
  const secretHash = await sha256(secret);
  const auditId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO machine_principals
       (id,project_id,name,repository_provider,provider_repository_id,created_by)
       SELECT ?,gc.project_id,?,gc.provider,gc.provider_repository_id,?
       FROM git_connections gc
       JOIN project_repositories pr ON pr.project_id=gc.project_id
         AND pr.repository_identity_id=gc.repository_identity_id
       JOIN project_members pm ON pm.project_id=gc.project_id
       WHERE gc.project_id=? AND gc.status='VERIFIED' AND pm.user_id=? AND pm.role='ADMIN'
         AND (SELECT COUNT(*) FROM machine_principals existing
           WHERE existing.project_id=gc.project_id AND existing.status='ACTIVE') < 20`,
    ).bind(principalId, name, user.id, projectId, user.id),
    env.DB.prepare(
      `INSERT INTO machine_credentials (id,principal_id,secret_hash,expires_at,created_by)
       SELECT ?,mp.id,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || ? || ' days'),?
       FROM machine_principals mp WHERE mp.id=? AND mp.project_id=?`,
    ).bind(credentialId, secretHash, expiresInDays, user.id, principalId, projectId),
    env.DB.prepare(
      `INSERT INTO machine_audit_events
        (id,project_id,principal_id,credential_id,actor_user_id,action,outcome,created_at)
        SELECT ?,mp.project_id,NULL,mc.id,?,'CREDENTIAL_ISSUED','SUCCEEDED',mc.created_at
        FROM machine_credentials mc JOIN machine_principals mp ON mp.id=mc.principal_id
       WHERE mc.id=? AND mp.id=?`,
    ).bind(auditId, user.id, credentialId, principalId),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1)
    return humanResponse(request, env, { error: "NOT_FOUND" }, 404);
  const row = await credentialRow(env, projectId, credentialId);
  if (!row) return humanResponse(request, env, { error: "CONFLICT" }, 409);
  return humanResponse(
    request,
    env,
    { credential: publicCredential(row), token: `chm_${credentialId}.${secret}` },
    201,
  );
}

async function credentialRow(env: Env, projectId: string, credentialId: string) {
  return env.DB.prepare(
    `SELECT mc.id,mc.principal_id,mp.name,mp.repository_provider,mp.provider_repository_id,
       mp.scope,CASE WHEN mp.status='REVOKED' OR mc.revoked_at IS NOT NULL THEN 'REVOKED'
         WHEN mc.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'EXPIRED' ELSE 'ACTIVE' END AS credential_status,
       mc.expires_at,mc.created_at,mc.revoked_at
     FROM machine_credentials mc JOIN machine_principals mp ON mp.id=mc.principal_id
     WHERE mp.project_id=? AND mc.id=?`,
  )
    .bind(projectId, credentialId)
    .first<Record<string, unknown>>();
}

async function rotateCredential(
  request: Request,
  env: Env,
  user: Human,
  projectId: string,
  oldId: string,
): Promise<Response> {
  const body = await bodyObject(request);
  const expiresInDays = body?.expiresInDays;
  if (
    !body ||
    Object.keys(body).some((key) => key !== "expiresInDays") ||
    !Number.isSafeInteger(expiresInDays) ||
    (expiresInDays as number) < 1 ||
    (expiresInDays as number) > MAX_CREDENTIAL_DAYS
  )
    return humanResponse(request, env, { error: "INVALID_INPUT" }, 400);
  const newId = crypto.randomUUID();
  const secret = randomToken(32);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE machine_credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         replaced_by_credential_id=?,revoked_by_user_id=?
       WHERE id=? AND revoked_at IS NULL AND EXISTS (
         SELECT 1 FROM machine_principals mp JOIN project_members pm ON pm.project_id=mp.project_id
         WHERE mp.id=machine_credentials.principal_id AND mp.project_id=? AND mp.status='ACTIVE'
           AND pm.user_id=? AND pm.role='ADMIN')`,
    ).bind(newId, user.id, oldId, projectId, user.id),
    env.DB.prepare(
      `INSERT INTO machine_credentials (id,principal_id,secret_hash,expires_at,created_by,created_at)
       SELECT ?,mc.principal_id,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || ? || ' days'),?,mc.revoked_at
       FROM machine_credentials mc JOIN machine_principals mp ON mp.id=mc.principal_id
       JOIN project_members pm ON pm.project_id=mp.project_id
       WHERE mc.id=? AND mc.revoked_at IS NOT NULL AND mc.replaced_by_credential_id=?
         AND mp.project_id=? AND mp.status='ACTIVE' AND pm.user_id=? AND pm.role='ADMIN'`,
    ).bind(newId, await sha256(secret), expiresInDays, user.id, oldId, newId, projectId, user.id),
    env.DB.prepare(
      `INSERT INTO machine_audit_events
       (id,project_id,principal_id,credential_id,actor_user_id,action,outcome,created_at)
       SELECT ?,mp.project_id,NULL,mc.id,?,'CREDENTIAL_ROTATED','SUCCEEDED',mc.created_at
       FROM machine_credentials mc JOIN machine_principals mp ON mp.id=mc.principal_id
       WHERE mc.id=? AND mp.project_id=?`,
    ).bind(crypto.randomUUID(), user.id, newId, projectId),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1)
    return humanResponse(request, env, { error: "NOT_FOUND" }, 404);
  const row = await credentialRow(env, projectId, newId);
  return humanResponse(request, env, {
    credential: publicCredential(row ?? {}),
    token: `chm_${newId}.${secret}`,
  });
}

async function revokeCredential(
  request: Request,
  env: Env,
  user: Human,
  projectId: string,
  credentialId: string,
): Promise<Response> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE machine_credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revoked_by_user_id=?
       WHERE id=? AND revoked_at IS NULL AND EXISTS (
         SELECT 1 FROM machine_principals mp JOIN project_members pm ON pm.project_id=mp.project_id
         WHERE mp.id=machine_credentials.principal_id AND mp.project_id=?
           AND pm.user_id=? AND pm.role='ADMIN')`,
    ).bind(user.id, credentialId, projectId, user.id),
    env.DB.prepare(
      `UPDATE machine_principals SET status='REVOKED',
         revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE project_id=? AND status='ACTIVE' AND id=(
         SELECT principal_id FROM machine_credentials WHERE id=? AND revoked_at IS NOT NULL
       ) AND NOT EXISTS (
         SELECT 1 FROM machine_credentials active
         WHERE active.principal_id=machine_principals.id AND active.revoked_at IS NULL
       )`,
    ).bind(projectId, credentialId),
    env.DB.prepare(
      `INSERT INTO machine_audit_events
       (id,project_id,principal_id,credential_id,actor_user_id,action,outcome,created_at)
       SELECT ?,mp.project_id,NULL,mc.id,?,'CREDENTIAL_REVOKED','SUCCEEDED',mc.revoked_at
       FROM machine_credentials mc JOIN machine_principals mp ON mp.id=mc.principal_id
       WHERE mc.id=? AND mp.project_id=? AND mc.revoked_at IS NOT NULL`,
    ).bind(crypto.randomUUID(), user.id, credentialId, projectId),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1)
    return humanResponse(request, env, { error: "NOT_FOUND" }, 404);
  return new Response(null, { status: 204, headers: humanHeaders(request, env) });
}

export async function handleCredentialRoute(
  request: Request,
  env: Env,
  user: Human,
  projectId: string,
  credentialId?: string,
  rotate = false,
): Promise<Response> {
  if (!ID.test(projectId) || (credentialId && !ID.test(credentialId)))
    return humanResponse(request, env, { error: "INVALID_INPUT" }, 400);
  if (
    ["POST", "DELETE"].includes(request.method) &&
    request.headers.get("origin") !== env.WEB_ORIGIN
  )
    return humanResponse(request, env, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  const role = await directAdmin(env, projectId, user.id);
  if (!role) return humanResponse(request, env, { error: "NOT_FOUND" }, 404);
  if (role !== "ADMIN") return humanResponse(request, env, { error: "FORBIDDEN" }, 403);
  if (!credentialId && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT mc.id,mc.principal_id,mp.name,mp.repository_provider,mp.provider_repository_id,
         mp.scope,CASE WHEN mp.status='REVOKED' OR mc.revoked_at IS NOT NULL THEN 'REVOKED'
           WHEN mc.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'EXPIRED' ELSE 'ACTIVE' END AS credential_status,
         mc.expires_at,mc.created_at,mc.revoked_at
       FROM machine_credentials mc JOIN machine_principals mp ON mp.id=mc.principal_id
       WHERE mp.project_id=? ORDER BY mc.created_at DESC LIMIT 51`,
    )
      .bind(projectId)
      .all<Record<string, unknown>>();
    return humanResponse(request, env, {
      credentials: rows.results.slice(0, 50).map(publicCredential),
      truncated: rows.results.length > 50,
    });
  }
  if (!credentialId && request.method === "POST")
    return issueCredential(request, env, user, projectId);
  if (credentialId && rotate && request.method === "POST")
    return rotateCredential(request, env, user, projectId, credentialId);
  if (credentialId && !rotate && request.method === "DELETE")
    return revokeCredential(request, env, user, projectId, credentialId);
  return humanResponse(request, env, { error: "METHOD_NOT_ALLOWED" }, 405);
}

function bearer(request: Request): { id: string; secret: string } | null {
  const match = /^Bearer chm_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1] && match[2] ? { id: match[1], secret: match[2] } : null;
}

async function authorizeMachine(
  request: Request,
  env: Env,
  operation: MachineOperation,
  projectId: string,
  version: number,
): Promise<MachineIdentity | null> {
  const token = bearer(request);
  const nonce = request.headers.get("x-context-nonce") ?? "";
  const provider = request.headers.get("x-context-repository-provider") ?? "";
  const repositoryId = request.headers.get("x-context-repository-id") ?? "";
  const commit = request.headers.get("x-context-source-commit") ?? "";
  if (!token || !NONCE.test(nonce) || !ID.test(projectId) || !COMMIT.test(commit)) return null;
  const identity = await env.DB.prepare(
    `INSERT INTO machine_request_nonces
       (credential_id,nonce_hash,operation,project_id,graph_version,expires_at)
     SELECT mc.id,?,?,gv.project_id,gv.version,
       strftime('%Y-%m-%dT%H:%M:%fZ','now','+${NONCE_TTL_MINUTES} minutes')
     FROM machine_credentials mc JOIN machine_principals mp ON mp.id=mc.principal_id
     JOIN git_connections gc ON gc.project_id=mp.project_id
       AND gc.provider=mp.repository_provider
       AND gc.provider_repository_id=mp.provider_repository_id AND gc.status='VERIFIED'
     JOIN project_repositories pr ON pr.project_id=gc.project_id
       AND pr.repository_identity_id=gc.repository_identity_id
     JOIN graph_versions gv ON gv.project_id=mp.project_id
     WHERE mc.id=? AND mc.secret_hash=? AND mc.revoked_at IS NULL
       AND mc.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
       AND mp.status='ACTIVE' AND mp.scope='GRAPH_CLAIM_PUBLISH_FAIL'
       AND mp.project_id=? AND mp.repository_provider=? AND mp.provider_repository_id=?
       AND gv.version=? AND gv.repository_provider=mp.repository_provider
       AND gv.provider_repository_id=mp.provider_repository_id AND gv.source_commit_sha=?
       AND (SELECT COUNT(*) FROM machine_request_nonces active
         WHERE active.credential_id=mc.id
           AND active.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) < 1000
     RETURNING (SELECT principal_id FROM machine_credentials WHERE id=credential_id) AS principal_id,
       credential_id,project_id,
       (SELECT repository_provider FROM machine_principals WHERE id=(SELECT principal_id FROM machine_credentials WHERE id=credential_id)) AS repository_provider,
       (SELECT provider_repository_id FROM machine_principals WHERE id=(SELECT principal_id FROM machine_credentials WHERE id=credential_id)) AS provider_repository_id`,
  )
    .bind(
      await sha256(nonce),
      operation,
      token.id,
      await sha256(token.secret),
      projectId,
      provider,
      repositoryId,
      version,
      commit,
    )
    .first<MachineIdentity>();
  if (identity) {
    await env.DB.prepare(
      `DELETE FROM machine_request_nonces
       WHERE credential_id=? AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
      .bind(identity.credential_id)
      .run();
  }
  return identity;
}

async function claimForRequest(
  projectId: string,
  version: number,
  request: Request,
): Promise<GraphClaim | null> {
  const attempt = Number(request.headers.get("x-context-attempt"));
  const leaseId = request.headers.get("x-context-lease-id") ?? "";
  const publicationId = request.headers.get("x-context-publication-id") ?? "";
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !NONCE.test(leaseId) ||
    !NONCE.test(publicationId)
  )
    return null;
  return {
    projectId,
    version,
    attempt,
    leaseId,
    publicationId,
    leaseExpiresAt: "",
    storageKey: `projects/${projectId}/graphs/v/${version}/attempts/${attempt}/${publicationId}/graph.json`,
  };
}

async function readGraphBytes(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return null;
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_GRAPH_BYTES)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_GRAPH_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (size < 1) return null;
  const bytes = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function positiveHeader(request: Request, name: string, max: number): number | null {
  const value = request.headers.get(name) ?? "";
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
}

export async function handleMachineGraphRoute(
  request: Request,
  env: Env,
  storage: ObjectStorage,
  projectId: string,
  versionText: string,
  operation: "claim" | "publish" | "fail",
): Promise<Response> {
  const version = Number(versionText);
  const expectedMethod = operation === "publish" ? "PUT" : "POST";
  if (!Number.isSafeInteger(version) || version < 1 || request.method !== expectedMethod)
    return invalid();
  const identity = await authorizeMachine(
    request,
    env,
    operation.toUpperCase() as MachineOperation,
    projectId,
    version,
  ).catch(() => null);
  if (!identity) {
    await auditDeniedMachineRequest(env, request, projectId, version, operation).catch(
      () => undefined,
    );
    return invalid(401);
  }
  try {
    if (operation === "claim") {
      const claim = await claimOrReclaimExpiredGraphBuild(
        env,
        projectId,
        version,
        identity.principal_id,
      );
      const row = await env.DB.prepare(
        "SELECT * FROM graph_versions WHERE project_id=? AND version=?",
      )
        .bind(projectId, version)
        .first<BuildRow>();
      if (!row) {
        await auditMachineFailure(env, identity, operation, version).catch(() => undefined);
        return invalid(401);
      }
      return response({
        claim,
        build: {
          projectId: row.project_id,
          repositoryProvider: row.repository_provider,
          providerRepositoryId: row.provider_repository_id,
          repositoryIdentitySnapshot: {
            provider: row.repository_provider,
            providerRepositoryId: row.provider_repository_id,
            owner: row.repository_owner,
            name: row.repository_name,
            canonicalUrl: row.repository_canonical_url,
          },
          sourceCommitSha: row.source_commit_sha,
          ...GRAPH_BUILD_IDENTITY,
        },
      });
    }
    const claim = await claimForRequest(projectId, version, request);
    if (!claim) {
      await auditMachineFailure(env, identity, operation, version).catch(() => undefined);
      return invalid();
    }
    const owned = await env.DB.prepare(
      `SELECT gv.* FROM graph_versions gv JOIN graph_build_attempts gba
       ON gba.project_id=gv.project_id AND gba.graph_version=gv.version
       WHERE gv.project_id=? AND gv.version=? AND gba.attempt=? AND gba.lease_id=?
         AND gba.publication_id=? AND gba.storage_key=? AND gba.claimed_by=?`,
    )
      .bind(
        projectId,
        version,
        claim.attempt,
        claim.leaseId,
        claim.publicationId,
        claim.storageKey,
        identity.principal_id,
      )
      .first<BuildRow>();
    if (!owned) {
      await auditMachineFailure(env, identity, operation, version).catch(() => undefined);
      return invalid(401);
    }
    if (operation === "fail") {
      const body = await bodyObject(request);
      const category = body?.failureCategory;
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        typeof category !== "string" ||
        !FAILURE.test(category)
      ) {
        await auditMachineFailure(env, identity, operation, version).catch(() => undefined);
        return invalid();
      }
      await failGraphBuild(env, claim, category);
      return response({ status: "FAILED" });
    }
    const bytes = await readGraphBytes(request);
    const nodeCount = positiveHeader(request, "x-context-node-count", 50_000);
    const linkCount = positiveHeader(request, "x-context-link-count", 100_000);
    const hyperedgeCount = positiveHeader(request, "x-context-hyperedge-count", 0);
    const checksum = request.headers.get("x-context-checksum-sha256") ?? "";
    if (
      !bytes ||
      nodeCount === null ||
      linkCount === null ||
      hyperedgeCount !== 0 ||
      !/^[0-9a-f]{64}$/.test(checksum) ||
      (await sha256Bytes(bytes)) !== checksum
    ) {
      await auditMachineFailure(env, identity, operation, version).catch(() => undefined);
      return invalid();
    }
    const result: GraphBuildResult = {
      bytes: bytes as Uint8Array<ArrayBuffer>,
      checksum,
      byteSize: bytes.byteLength,
      nodeCount,
      linkCount,
      hyperedgeCount,
      generator: owned.generator,
      projectId,
      repositoryProvider: owned.repository_provider,
      providerRepositoryId: owned.provider_repository_id,
      repositoryOwner: owned.repository_owner,
      repositoryName: owned.repository_name,
      repositoryCanonicalUrl: owned.repository_canonical_url,
      sourceCommitSha: owned.source_commit_sha,
      graphifyVersion: owned.graphify_version,
      adapterVersion: owned.adapter_version,
      profile: owned.profile,
      formatVersion: owned.format_version,
    };
    const published = await publishGraphBuild(env, storage, claim, result);
    return response({
      graph: {
        projectId,
        version: published.version,
        status: published.status,
        checksum: published.checksum,
      },
    });
  } catch (cause) {
    await auditMachineFailure(env, identity, operation, version).catch(() => undefined);
    if (cause instanceof GraphConflictError)
      return response({ error: cause.code }, cause.code === "INTEGRITY_ERROR" ? 400 : 409);
    throw cause;
  }
}

const machineAction = (operation: "claim" | "publish" | "fail") =>
  ({ claim: "GRAPH_CLAIMED", publish: "GRAPH_PUBLISHED", fail: "GRAPH_FAILED" })[operation] as
    | "GRAPH_CLAIMED"
    | "GRAPH_PUBLISHED"
    | "GRAPH_FAILED";

async function auditDeniedMachineRequest(
  env: Env,
  request: Request,
  projectId: string,
  version: number,
  operation: "claim" | "publish" | "fail",
): Promise<void> {
  const token = bearer(request);
  if (!token) return;
  await env.DB.prepare(
    `INSERT INTO machine_audit_events
     (id,project_id,principal_id,credential_id,actor_user_id,action,outcome,graph_version)
     SELECT ?,mp.project_id,mp.id,mc.id,NULL,?,'DENIED',?
     FROM machine_credentials mc JOIN machine_principals mp ON mp.id=mc.principal_id
     WHERE mc.id=? AND mp.project_id=?`,
  )
    .bind(crypto.randomUUID(), machineAction(operation), version, token.id, projectId)
    .run();
}

async function auditMachineFailure(
  env: Env,
  identity: MachineIdentity,
  operation: "claim" | "publish" | "fail",
  version: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO machine_audit_events
     (id,project_id,principal_id,credential_id,actor_user_id,action,outcome,graph_version)
     VALUES (?,?,?,?,NULL,?,'FAILED',?)`,
  )
    .bind(
      crypto.randomUUID(),
      identity.project_id,
      identity.principal_id,
      identity.credential_id,
      machineAction(operation),
      version,
    )
    .run();
}
