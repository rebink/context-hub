import { ContextAuthorizationError, ContextAuthorizationFence } from "./context-authorization.js";
import { ContextBudgetError, ContextEngine } from "./context-engine.js";
import { type GraphRow, loadVerifiedReadyGraph, queryGraph } from "./graphs.js";
import {
  MCP_LIMITS,
  MCP_TOOL_NAMES,
  type McpDispatchRequest,
  type McpDispatchResult,
  type McpToolName,
  WorkerMcpTransport,
} from "./mcp-transport.js";
import type { ObjectStorage } from "./object-storage.js";
import { normalizeGithubRepository } from "./repository-identity.js";
import { randomToken, sha256, sha256Bytes } from "./security.js";

export type McpEnv = { DB: D1Database; WEB_ORIGIN?: string };
export type McpHuman = { id: string };

const ID = /^[A-Za-z0-9_-]+$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const ALL_TOOLS = new Set<McpToolName>(MCP_TOOL_NAMES);
const MAX_CREDENTIAL_DAYS = 90;
const MAX_ACTIVE_PRINCIPALS = 20;
const MAX_REQUESTS_PER_MINUTE = 120;
const MAX_ACTIVE_NONCES = 1_000;

export type CredentialIdentity = {
  credential_id: string;
  principal_id: string;
  owner_user_id: string;
  repository_provider: string | null;
  provider_repository_id: string | null;
  repository_canonical_url: string | null;
};

export type AuthorizedProject = {
  id: string;
  workspace_id: string;
  role: "ADMIN" | "EDITOR" | "VIEWER";
};

type ProjectInfoRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  provider: string | null;
  provider_repository_id: string | null;
  canonical_url: string | null;
  owner: string | null;
  repository_name: string | null;
  default_branch: string | null;
  last_known_commit_sha: string | null;
};

type ArtifactRow = {
  id: string;
  project_id: string;
  type: string;
  name: string;
  description: string | null;
  current_version: number;
  version: number;
  storage_key: string;
  checksum: string;
  content_type: string;
  byte_size: number;
  source_commit_sha: string | null;
  created_at: string;
};

class McpFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

function failure(code: string, status: number): never {
  throw new McpFailure(code, status);
}

function humanHeaders(request: Request, env: McpEnv): Headers {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
  });
  if (request.headers.get("origin") === env.WEB_ORIGIN) {
    headers.set("access-control-allow-origin", env.WEB_ORIGIN ?? "");
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "origin");
  }
  return headers;
}

function humanJson(request: Request, env: McpEnv, body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: humanHeaders(request, env) });
}

async function boundedObject(
  request: Request,
  max = 8 * 1024,
): Promise<Record<string, unknown> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    return null;
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
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

function bearer(request: Request): { id: string; secret: string } | null {
  const match = /^Bearer chmcp_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1] && match[2] ? { id: match[1], secret: match[2] } : null;
}

async function credentialIdentity(
  request: Request,
  env: McpEnv,
): Promise<CredentialIdentity | null> {
  const token = bearer(request);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT mc.id AS credential_id,mp.id AS principal_id,mp.owner_user_id,
       mp.repository_provider,mp.provider_repository_id,mp.repository_canonical_url
     FROM mcp_credentials mc JOIN mcp_principals mp ON mp.id=mc.principal_id
     WHERE mc.id=? AND mc.secret_hash=? AND mc.revoked_at IS NULL
       AND mc.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND mp.status='ACTIVE'`,
  )
    .bind(token.id, await sha256(token.secret))
    .first<CredentialIdentity>();
}

function stringArg(args: Record<string, unknown>, key: string, min: number, max: number) {
  const value = args[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

function integerArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = args[key];
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : null;
}

export function callerWideLimit(requested: number, projectCount: number): number | null {
  if (
    !Number.isSafeInteger(requested) ||
    !Number.isSafeInteger(projectCount) ||
    projectCount < MCP_LIMITS.scope.minProjects ||
    requested < projectCount
  )
    return null;
  return Math.floor(requested / projectCount);
}

async function resolveScope(
  env: McpEnv,
  identity: CredentialIdentity,
  args: Record<string, unknown>,
): Promise<AuthorizedProject[]> {
  const repositoryValue = args.repository;
  const projectValue = args.projectId;
  const projectsValue = args.projectIds;
  const selectors = [
    repositoryValue !== undefined,
    projectValue !== undefined,
    projectsValue !== undefined,
  ].filter(Boolean).length;
  if (selectors !== 1) failure("INVALID_SCOPE", 400);

  let requested: string[] | null = null;
  let canonical: string | null = null;
  if (repositoryValue !== undefined) {
    if (typeof repositoryValue !== "string") failure("INVALID_SCOPE", 400);
    canonical = normalizeGithubRepository(repositoryValue);
    if (!canonical) failure("INVALID_SCOPE", 400);
  } else if (projectValue !== undefined) {
    if (typeof projectValue !== "string" || !ID.test(projectValue)) failure("INVALID_SCOPE", 400);
    requested = [projectValue];
  } else {
    if (
      !Array.isArray(projectsValue) ||
      projectsValue.length < MCP_LIMITS.scope.minProjects ||
      projectsValue.length > MCP_LIMITS.scope.maxProjects ||
      projectsValue.some((value) => typeof value !== "string" || !ID.test(value)) ||
      new Set(projectsValue).size !== projectsValue.length
    )
      failure("INVALID_SCOPE", 400);
    requested = [...projectsValue].sort() as string[];
  }

  const binding = identity.repository_provider
    ? ` AND EXISTS (SELECT 1 FROM git_connections bound
          JOIN repository_identities bri ON bri.id=bound.repository_identity_id
          JOIN project_repositories bpr ON bpr.project_id=bound.project_id AND bpr.repository_identity_id=bri.id
        WHERE bound.project_id=p.id AND bound.status='VERIFIED'
          AND bound.provider=? AND bound.provider_repository_id=? AND bri.canonical_url=?)`
    : "";
  const bindingArgs = identity.repository_provider
    ? [
        identity.repository_provider,
        identity.provider_repository_id,
        identity.repository_canonical_url,
      ]
    : [];
  let sql = `SELECT p.id,p.workspace_id,pm.role FROM projects p
    JOIN mcp_principal_projects mpp ON mpp.project_id=p.id AND mpp.principal_id=?
    JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
    JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=?
    WHERE p.status='ACTIVE' AND pm.role IN ('ADMIN','EDITOR','VIEWER')${binding}`;
  const bindings: unknown[] = [
    identity.principal_id,
    identity.owner_user_id,
    identity.owner_user_id,
    ...bindingArgs,
  ];
  if (canonical) {
    sql += ` AND EXISTS (SELECT 1 FROM git_connections gc
      JOIN repository_identities ri ON ri.id=gc.repository_identity_id
      JOIN project_repositories pr ON pr.project_id=gc.project_id AND pr.repository_identity_id=ri.id
      WHERE gc.project_id=p.id AND gc.status='VERIFIED' AND ri.canonical_url=?)`;
    bindings.push(canonical);
  } else if (requested) {
    sql += ` AND p.id IN (${requested.map(() => "?").join(",")})`;
    bindings.push(...requested);
  }
  sql += ` ORDER BY p.id LIMIT ${MCP_LIMITS.scope.maxProjects + 1}`;
  const result = await env.DB.prepare(sql)
    .bind(...bindings)
    .all<AuthorizedProject>();
  if (canonical) {
    if (result.results.length === 0) failure("PROJECT_NOT_FOUND", 404);
    if (result.results.length > 1) failure("AMBIGUOUS_PROJECT", 409);
  } else if (!requested || result.results.length !== requested.length) {
    failure("PROJECT_NOT_FOUND", 404);
  }
  return result.results;
}

function protocolOperation(input: McpDispatchRequest): string {
  if (input.kind === "negotiate") return "NEGOTIATE";
  if (input.kind === "initialize" || input.kind === "initialized") return "INITIALIZE";
  if (input.kind === "list-tools") return "LIST_TOOLS";
  if (input.kind === "ping") return "PING";
  return input.name;
}

type PreflightResult = "ACCEPTED" | "DENIED" | "RATE_LIMITED";

async function consumeProtocolRequest(
  request: Request,
  env: McpEnv,
  identity: CredentialIdentity,
): Promise<PreflightResult> {
  const nonce = request.headers.get("x-context-nonce") ?? "";
  if (!NONCE.test(nonce)) return "DENIED";
  const inserted = await env.DB.prepare(
    `INSERT INTO mcp_request_nonces
       (credential_id,nonce_hash,operation,scope_hash,project_count,expires_at)
     SELECT mc.id,?,'PROTOCOL',?,0,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour')
     FROM mcp_credentials mc JOIN mcp_principals mp ON mp.id=mc.principal_id
     WHERE mc.id=? AND mc.revoked_at IS NULL AND mc.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
       AND mp.id=? AND mp.status='ACTIVE'
       AND (SELECT COUNT(*) FROM mcp_request_nonces recent WHERE recent.credential_id=mc.id
         AND recent.consumed_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')) < ${MAX_REQUESTS_PER_MINUTE}
       AND (SELECT COUNT(*) FROM mcp_request_nonces active WHERE active.credential_id=mc.id
         AND active.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) < ${MAX_ACTIVE_NONCES}
     RETURNING credential_id`,
  )
    .bind(await sha256(nonce), await sha256(""), identity.credential_id, identity.principal_id)
    .first<{ credential_id: string }>()
    .catch(() => null);
  if (!inserted) {
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM mcp_request_nonces recent WHERE recent.credential_id=?
           AND recent.consumed_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute')) AS recent_count,
         (SELECT COUNT(*) FROM mcp_request_nonces active WHERE active.credential_id=?
           AND active.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS active_count`,
    )
      .bind(identity.credential_id, identity.credential_id)
      .first<{ recent_count: number; active_count: number }>()
      .catch(() => null);
    return counts &&
      (counts.recent_count >= MAX_REQUESTS_PER_MINUTE || counts.active_count >= MAX_ACTIVE_NONCES)
      ? "RATE_LIMITED"
      : "DENIED";
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE mcp_credentials SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=? AND revoked_at IS NULL`,
    ).bind(identity.credential_id),
    env.DB.prepare(
      `DELETE FROM mcp_request_nonces WHERE credential_id=?
       AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).bind(identity.credential_id),
  ]);
  return "ACCEPTED";
}

async function authorizeDispatch(
  env: McpEnv,
  identity: CredentialIdentity,
  operation: string,
  projects: AuthorizedProject[],
): Promise<boolean> {
  const scopedIds = projects.map((project) => project.id);
  const placeholders = scopedIds.map(() => "?").join(",");
  const scopeCheck =
    scopedIds.length === 0
      ? ""
      : ` AND (SELECT COUNT(*) FROM mcp_principal_projects mpp
          JOIN projects p ON p.id=mpp.project_id AND p.status='ACTIVE'
          JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=mp.owner_user_id
          JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=mp.owner_user_id
          WHERE mpp.principal_id=mp.id AND pm.role IN ('ADMIN','EDITOR','VIEWER')
            AND p.id IN (${placeholders}))=?`;
  const bindingCheck =
    scopedIds.length === 0 || !identity.repository_provider
      ? ""
      : ` AND (SELECT COUNT(DISTINCT gc.project_id) FROM git_connections gc
          JOIN repository_identities ri ON ri.id=gc.repository_identity_id
          JOIN project_repositories pr ON pr.project_id=gc.project_id AND pr.repository_identity_id=ri.id
          WHERE gc.project_id IN (${placeholders}) AND gc.status='VERIFIED'
            AND gc.provider=? AND gc.provider_repository_id=? AND ri.canonical_url=?)=?`;
  const row = await env.DB.prepare(
    `SELECT mc.id FROM mcp_credentials mc JOIN mcp_principals mp ON mp.id=mc.principal_id
     WHERE mc.id=? AND mc.revoked_at IS NULL AND mc.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
       AND mp.id=? AND mp.status='ACTIVE'
       AND (? IN ('NEGOTIATE','INITIALIZE','LIST_TOOLS','PING') OR EXISTS (
         SELECT 1 FROM mcp_principal_operations mpo WHERE mpo.principal_id=mp.id AND mpo.operation=?))
       ${scopeCheck}${bindingCheck}`,
  )
    .bind(
      identity.credential_id,
      identity.principal_id,
      operation,
      operation,
      ...(scopedIds.length === 0 ? [] : [...scopedIds, scopedIds.length]),
      ...(scopedIds.length === 0 || !identity.repository_provider
        ? []
        : [
            ...scopedIds,
            identity.repository_provider,
            identity.provider_repository_id,
            identity.repository_canonical_url,
            scopedIds.length,
          ]),
    )
    .first<{ id: string }>();
  return Boolean(row);
}

async function auditRequest(
  env: McpEnv,
  identity: CredentialIdentity,
  operation: string,
  projects: AuthorizedProject[],
  outcome: "SUCCEEDED" | "DENIED" | "FAILED",
) {
  await env.DB.prepare(
    `INSERT INTO mcp_audit_events
       (id,principal_id,credential_id,actor_user_id,project_id,action,operation,outcome)
     VALUES (?,?,?,NULL,?,'MCP_REQUEST',?,?)`,
  )
    .bind(
      crypto.randomUUID(),
      identity.principal_id,
      identity.credential_id,
      projects.length === 1 ? projects[0]?.id : null,
      operation,
      outcome,
    )
    .run();
}

async function projectInfo(env: McpEnv, projectId: string, role: string) {
  const row = await env.DB.prepare(
    `SELECT p.id,p.workspace_id,p.name,p.slug,p.description,p.status,
       gc.provider,gc.provider_repository_id,ri.canonical_url,ri.owner,ri.repository_name,
       gc.default_branch,gc.last_known_commit_sha
     FROM projects p
     LEFT JOIN git_connections gc ON gc.project_id=p.id AND gc.status='VERIFIED'
       AND EXISTS (SELECT 1 FROM project_repositories current_pr
         WHERE current_pr.project_id=gc.project_id AND current_pr.repository_identity_id=gc.repository_identity_id)
     LEFT JOIN repository_identities ri ON ri.id=gc.repository_identity_id
     WHERE p.id=?`,
  )
    .bind(projectId)
    .first<ProjectInfoRow>();
  if (!row) failure("PROJECT_NOT_FOUND", 404);
  return {
    projectId: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    role,
    repository: row.provider
      ? {
          provider: row.provider,
          providerRepositoryId: row.provider_repository_id,
          canonicalUrl: row.canonical_url,
          owner: row.owner,
          name: row.repository_name,
          defaultBranch: row.default_branch,
          commit: row.last_known_commit_sha,
        }
      : null,
  };
}

async function currentGraph(env: McpEnv, projectId: string): Promise<GraphRow | null> {
  return env.DB.prepare(
    `SELECT gv.* FROM graph_versions gv
     JOIN git_connections gc ON gc.project_id=gv.project_id AND gc.status='VERIFIED'
       AND gc.provider=gv.repository_provider AND gc.provider_repository_id=gv.provider_repository_id
     JOIN repository_identities ri ON ri.id=gc.repository_identity_id AND ri.canonical_url=gv.repository_canonical_url
     JOIN project_repositories pr ON pr.project_id=gv.project_id AND pr.repository_identity_id=ri.id
     WHERE gv.project_id=? AND gv.status='READY' ORDER BY gv.version DESC LIMIT 1`,
  )
    .bind(projectId)
    .first<GraphRow>();
}

function graphProvenance(row: GraphRow) {
  return {
    projectId: row.project_id,
    source: "GRAPH",
    path: null,
    section: null,
    version: String(row.version),
    commit: row.source_commit_sha,
    checksum: row.checksum,
  };
}

async function getArtifact(
  env: McpEnv,
  storage: ObjectStorage,
  projectId: string,
  args: Record<string, unknown>,
  resultByteLimit: number,
) {
  const artifactId = stringArg(args, "artifactId", 1, 100);
  const version = integerArg(args, "version", 0, 1, 2_147_483_647);
  if (!artifactId || !ID.test(artifactId) || version === null) failure("INVALID_ARGUMENTS", 400);
  const row = await env.DB.prepare(
    `SELECT a.id,a.project_id,a.type,a.name,a.description,a.current_version,
       av.version,av.storage_key,av.checksum,av.content_type,av.byte_size,av.source_commit_sha,av.created_at
     FROM artifacts a JOIN artifact_versions av ON av.artifact_id=a.id
     WHERE a.project_id=? AND a.id=? AND a.status='ACTIVE'
       AND av.version=CASE WHEN ?=0 THEN a.current_version ELSE ? END`,
  )
    .bind(projectId, artifactId, version, version)
    .first<ArtifactRow>();
  if (!row) failure("ARTIFACT_NOT_FOUND", 404);
  const expectedKey = `projects/${projectId}/artifacts/${artifactId}/v/${row.version}/content`;
  if (row.storage_key !== expectedKey) failure("SOURCE_UNAVAILABLE", 503);
  const head = await storage.head(row.storage_key);
  if (
    !head ||
    head.byteSize !== row.byte_size ||
    head.httpContentType !== row.content_type ||
    head.metadata.contentType !== row.content_type ||
    head.metadata.checksum !== row.checksum
  )
    failure("SOURCE_UNAVAILABLE", 503);
  const bytes = await storage.getBytes(row.storage_key);
  if (!bytes || bytes.byteLength !== row.byte_size || (await sha256Bytes(bytes)) !== row.checksum)
    failure("SOURCE_UNAVAILABLE", 503);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failure("SOURCE_UNAVAILABLE", 503);
  }
  const bounded = bytes.byteLength > resultByteLimit;
  const excerpt = bounded
    ? new TextDecoder("utf-8").decode(bytes.slice(0, resultByteLimit - 4))
    : content;
  return {
    projectId,
    artifact: {
      id: row.id,
      type: row.type,
      name: row.name,
      description: row.description,
      version: row.version,
      currentVersion: row.current_version,
      contentType: row.content_type,
      byteSize: row.byte_size,
      content: excerpt,
      truncated: bounded,
      provenance: {
        projectId,
        source: "ARTIFACT",
        path: null,
        section: null,
        version: String(row.version),
        commit: row.source_commit_sha,
        checksum: row.checksum,
      },
    },
  };
}

export async function executeMcpTool(
  env: McpEnv,
  storage: ObjectStorage,
  name: McpToolName,
  args: Record<string, unknown>,
  projects: AuthorizedProject[],
  identity?: CredentialIdentity,
): Promise<unknown> {
  const scopeKeys = ["repository", "projectId", "projectIds"];
  const toolKeys: Record<McpToolName, string[]> = {
    project_info: [],
    search_context: ["query", "domain", "package", "maxTokens", "maxBytes"],
    get_artifact: ["artifactId", "version"],
    query_graph: ["operation", "query", "nodeId", "source", "target", "maxDepth", "limit"],
    get_sources: ["limit"],
    sync_status: [],
  };
  const allowed = new Set([...scopeKeys, ...toolKeys[name]]);
  if (Object.keys(args).some((key) => !allowed.has(key))) failure("INVALID_ARGUMENTS", 400);
  if (name === "project_info") {
    return {
      projects: await Promise.all(
        projects.map((project) => projectInfo(env, project.id, project.role)),
      ),
    };
  }
  if (name === "search_context") {
    const query = stringArg(args, "query", 2, 500);
    const maxTokens = integerArg(
      args,
      "maxTokens",
      MCP_LIMITS.searchContext.defaultTokens,
      MCP_LIMITS.searchContext.minTokens,
      MCP_LIMITS.searchContext.maxTokens,
    );
    const maxBytes = integerArg(
      args,
      "maxBytes",
      MCP_LIMITS.searchContext.defaultBytes,
      MCP_LIMITS.searchContext.minBytes,
      MCP_LIMITS.searchContext.maxBytes,
    );
    if (!query || maxTokens === null || maxBytes === null) failure("INVALID_ARGUMENTS", 400);
    const domain = args.domain === undefined ? undefined : stringArg(args, "domain", 1, 100);
    const packageName = args.package === undefined ? undefined : stringArg(args, "package", 1, 160);
    if ((args.domain !== undefined && !domain) || (args.package !== undefined && !packageName))
      failure("INVALID_ARGUMENTS", 400);
    if (!identity) failure("REQUEST_DENIED", 401);
    const projectIds = projects.map((project) => project.id);
    const fence = ContextAuthorizationFence.mcp(projectIds, {
      credentialId: identity.credential_id,
      principalId: identity.principal_id,
      repositoryProvider: identity.repository_provider,
      providerRepositoryId: identity.provider_repository_id,
      repositoryCanonicalUrl: identity.repository_canonical_url,
    });
    try {
      return await new ContextEngine(env.DB, storage, fence).searchMany({
        projectIds,
        query,
        ...(domain ? { domain } : {}),
        ...(packageName ? { package: packageName } : {}),
        budget: { maxTokens, maxBytes },
      });
    } catch (cause) {
      if (cause instanceof ContextAuthorizationError) failure("PROJECT_NOT_FOUND", 404);
      if (cause instanceof ContextBudgetError) failure("INVALID_ARGUMENTS", 400);
      throw cause;
    }
  }
  if (name === "get_artifact") {
    return {
      projects: await Promise.all(
        projects.map((project) =>
          getArtifact(
            env,
            storage,
            project.id,
            args,
            Math.floor(MCP_LIMITS.artifact.contentBytes / projects.length),
          ),
        ),
      ),
    };
  }
  if (name === "query_graph") {
    const requestedLimit = integerArg(
      args,
      "limit",
      MCP_LIMITS.graph.defaultRecords,
      MCP_LIMITS.graph.minRecords,
      MCP_LIMITS.graph.maxRecords,
    );
    const perProjectLimit =
      requestedLimit === null ? null : callerWideLimit(requestedLimit, projects.length);
    if (perProjectLimit === null) failure("INVALID_ARGUMENTS", 400);
    const queryArgs = { ...args, limit: perProjectLimit };
    const results = [];
    for (const project of projects) {
      const row = await currentGraph(env, project.id);
      if (!row) failure("GRAPH_NOT_FOUND", 404);
      const loaded = await loadVerifiedReadyGraph(storage, row);
      if (!loaded) failure("SOURCE_UNAVAILABLE", 503);
      const result = queryGraph(loaded.graph, queryArgs);
      if (!result) failure("INVALID_ARGUMENTS", 400);
      results.push({
        projectId: project.id,
        graph: { version: row.version, provenance: graphProvenance(row) },
        result,
      });
    }
    return { projects: results };
  }
  if (name === "get_sources") {
    const limit = integerArg(
      args,
      "limit",
      MCP_LIMITS.sources.defaultRecords,
      MCP_LIMITS.sources.minRecords,
      MCP_LIMITS.sources.maxRecords,
    );
    const perProjectLimit = limit === null ? null : callerWideLimit(limit, projects.length);
    if (perProjectLimit === null) failure("INVALID_ARGUMENTS", 400);
    const results = [];
    for (const project of projects) {
      const artifacts = await env.DB.prepare(
        `SELECT a.id,a.type,a.name,a.current_version,av.checksum,av.source_commit_sha,av.byte_size
         FROM artifacts a JOIN artifact_versions av ON av.artifact_id=a.id AND av.version=a.current_version
         WHERE a.project_id=? AND a.status='ACTIVE' ORDER BY a.updated_at DESC,a.id DESC LIMIT ?`,
      )
        .bind(project.id, perProjectLimit + 1)
        .all<Record<string, unknown>>();
      const graph = await currentGraph(env, project.id);
      results.push({
        projectId: project.id,
        artifacts: artifacts.results.slice(0, perProjectLimit).map((row) => ({
          id: row.id,
          type: row.type,
          name: row.name,
          byteSize: row.byte_size,
          provenance: {
            projectId: project.id,
            source: "ARTIFACT",
            path: null,
            section: null,
            version: String(row.current_version),
            commit: row.source_commit_sha,
            checksum: row.checksum,
          },
        })),
        graph: graph ? { version: graph.version, provenance: graphProvenance(graph) } : null,
        truncated: artifacts.results.length > perProjectLimit,
      });
    }
    return { projects: results };
  }
  const results = [];
  for (const project of projects) {
    const info = await projectInfo(env, project.id, project.role);
    const newest = await env.DB.prepare(
      `SELECT gv.status,gv.version,gv.source_commit_sha,gv.checksum,gv.updated_at
       FROM graph_versions gv JOIN git_connections gc ON gc.project_id=gv.project_id
         AND gc.status='VERIFIED' AND gc.provider=gv.repository_provider
         AND gc.provider_repository_id=gv.provider_repository_id
       JOIN repository_identities ri ON ri.id=gc.repository_identity_id
         AND ri.canonical_url=gv.repository_canonical_url
       JOIN project_repositories pr ON pr.project_id=gv.project_id AND pr.repository_identity_id=ri.id
       WHERE gv.project_id=? ORDER BY gv.version DESC LIMIT 1`,
    )
      .bind(project.id)
      .first<Record<string, unknown>>();
    const ready = await currentGraph(env, project.id);
    results.push({
      projectId: project.id,
      repository: info.repository,
      newestGraph: newest
        ? {
            status: newest.status,
            version: newest.version,
            sourceCommitSha: newest.source_commit_sha,
            updatedAt: newest.updated_at,
          }
        : null,
      readyGraph: ready
        ? {
            status: ready.status,
            version: ready.version,
            sourceCommitSha: ready.source_commit_sha,
            checksum: ready.checksum,
            generatedAt: ready.generated_at,
            provenance: graphProvenance(ready),
          }
        : null,
    });
  }
  return { projects: results };
}

function preflightError(code: "INVALID_CREDENTIAL" | "REQUEST_DENIED" | "RATE_LIMITED") {
  const status = code === "RATE_LIMITED" ? 429 : 401;
  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: status === 429 ? -32029 : -32001, message: code },
    },
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export async function handleMcpRoute(
  request: Request,
  env: McpEnv,
  storage: ObjectStorage,
): Promise<Response> {
  const identity = await credentialIdentity(request, env).catch(() => null);
  if (!identity) return preflightError("INVALID_CREDENTIAL");
  const preflight = await consumeProtocolRequest(request, env, identity).catch(
    () => "DENIED" as const,
  );
  if (preflight !== "ACCEPTED") {
    await auditRequest(env, identity, "PROTOCOL", [], "DENIED").catch(() => undefined);
    return preflightError(preflight === "RATE_LIMITED" ? "RATE_LIMITED" : "REQUEST_DENIED");
  }

  let dispatched = false;
  const transport = new WorkerMcpTransport();
  const response = await transport.handle(request, async (input): Promise<McpDispatchResult> => {
    dispatched = true;
    const operation = protocolOperation(input);
    let projects: AuthorizedProject[] = [];
    try {
      if (input.kind === "call-tool") projects = await resolveScope(env, identity, input.arguments);
      if (!(await authorizeDispatch(env, identity, operation, projects))) {
        await auditRequest(env, identity, operation, projects, "DENIED").catch(() => undefined);
        return { ok: false, code: "REQUEST_DENIED", status: 401 };
      }
      const value =
        input.kind === "call-tool"
          ? await executeMcpTool(env, storage, input.name, input.arguments, projects, identity)
          : undefined;
      await auditRequest(env, identity, operation, projects, "SUCCEEDED");
      return { ok: true, value };
    } catch (cause) {
      await auditRequest(
        env,
        identity,
        operation,
        projects,
        cause instanceof McpFailure ? "DENIED" : "FAILED",
      ).catch(() => undefined);
      return cause instanceof McpFailure
        ? { ok: false, code: cause.code, status: cause.status }
        : { ok: false, code: "MCP_UNAVAILABLE", status: 503 };
    }
  });
  if (!dispatched)
    await auditRequest(env, identity, "PROTOCOL", [], "DENIED").catch(() => undefined);
  return response;
}

function validTools(value: unknown): value is McpToolName[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= ALL_TOOLS.size &&
    value.every((item) => typeof item === "string" && ALL_TOOLS.has(item as McpToolName)) &&
    new Set(value).size === value.length
  );
}

function publicPrincipal(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    status: row.credential_status,
    projectIds:
      typeof row.project_ids === "string" ? row.project_ids.split(",").filter(Boolean) : [],
    operations: typeof row.operations === "string" ? row.operations.split(",").filter(Boolean) : [],
    repository: row.repository_provider
      ? {
          provider: row.repository_provider,
          providerRepositoryId: row.provider_repository_id,
          canonicalUrl: row.repository_canonical_url,
        }
      : null,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    rotatedToCredentialId: row.replaced_by_credential_id,
  };
}

async function lifecycleRow(env: McpEnv, userId: string, credentialId: string) {
  return env.DB.prepare(
    `SELECT mp.id,mp.name,mp.repository_provider,mp.provider_repository_id,mp.repository_canonical_url,
       mc.id AS credential_id,mc.issued_at,mc.expires_at,mc.last_used_at,mc.revoked_at,mc.replaced_by_credential_id,
       CASE WHEN mp.status='REVOKED' OR mc.revoked_at IS NOT NULL THEN 'REVOKED'
         WHEN mc.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'EXPIRED' ELSE 'ACTIVE' END credential_status,
       (SELECT group_concat(project_id,',') FROM (SELECT project_id FROM mcp_principal_projects WHERE principal_id=mp.id ORDER BY project_id)) project_ids,
       (SELECT group_concat(operation,',') FROM (SELECT operation FROM mcp_principal_operations WHERE principal_id=mp.id ORDER BY operation)) operations
     FROM mcp_credentials mc JOIN mcp_principals mp ON mp.id=mc.principal_id
       WHERE mc.id=? AND mp.owner_user_id=?
       AND NOT EXISTS (SELECT 1 FROM mcp_principal_projects scope
         JOIN projects p ON p.id=scope.project_id
         WHERE scope.principal_id=mp.id AND (NOT EXISTS (SELECT 1 FROM project_members pm
           WHERE pm.project_id=scope.project_id AND pm.user_id=? AND pm.role='ADMIN')
           OR NOT EXISTS (SELECT 1 FROM workspace_members wm
             WHERE wm.workspace_id=p.workspace_id AND wm.user_id=?)))`,
  )
    .bind(credentialId, userId, userId, userId)
    .first<Record<string, unknown>>();
}

async function issueMcpCredential(request: Request, env: McpEnv, user: McpHuman) {
  const body = await boundedObject(request);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const projectIds = body?.projectIds;
  const operations = body?.operations;
  const expiresInDays = body?.expiresInDays;
  const repositoryInput = body?.repository;
  if (
    !body ||
    Object.keys(body).some(
      (key) => !["name", "projectIds", "operations", "expiresInDays", "repository"].includes(key),
    ) ||
    name.length < 1 ||
    new TextEncoder().encode(name).byteLength > 80 ||
    !Array.isArray(projectIds) ||
    projectIds.length < MCP_LIMITS.scope.minProjects ||
    projectIds.length > MCP_LIMITS.scope.maxProjects ||
    projectIds.some((id) => typeof id !== "string" || !ID.test(id)) ||
    new Set(projectIds).size !== projectIds.length ||
    !validTools(operations) ||
    !Number.isSafeInteger(expiresInDays) ||
    (expiresInDays as number) < 1 ||
    (expiresInDays as number) > MAX_CREDENTIAL_DAYS ||
    (repositoryInput !== undefined && typeof repositoryInput !== "string")
  )
    return humanJson(request, env, { error: "INVALID_INPUT" }, 400);
  const sortedProjects = [...projectIds].sort() as string[];
  const canonical =
    repositoryInput === undefined ? null : normalizeGithubRepository(repositoryInput);
  if (repositoryInput !== undefined && !canonical)
    return humanJson(request, env, { error: "INVALID_INPUT" }, 400);
  let repository: {
    provider: string;
    provider_repository_id: string;
    canonical_url: string;
  } | null = null;
  const authorizedCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM project_members pm
     JOIN projects p ON p.id=pm.project_id AND p.status='ACTIVE'
     JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=pm.user_id
     WHERE pm.user_id=? AND pm.role='ADMIN' AND pm.project_id IN (${sortedProjects.map(() => "?").join(",")})`,
  )
    .bind(user.id, ...sortedProjects)
    .first<{ count: number }>();
  if (authorizedCount?.count !== sortedProjects.length)
    return humanJson(request, env, { error: "NOT_FOUND" }, 404);
  if (canonical) {
    repository = await env.DB.prepare(
      `SELECT gc.provider,gc.provider_repository_id,ri.canonical_url FROM git_connections gc
       JOIN repository_identities ri ON ri.id=gc.repository_identity_id
       JOIN project_repositories pr ON pr.project_id=gc.project_id AND pr.repository_identity_id=ri.id
       WHERE gc.status='VERIFIED' AND ri.canonical_url=? AND gc.project_id IN (${sortedProjects.map(() => "?").join(",")})
       GROUP BY gc.provider,gc.provider_repository_id,ri.canonical_url HAVING COUNT(DISTINCT gc.project_id)=?`,
    )
      .bind(canonical, ...sortedProjects, sortedProjects.length)
      .first();
    if (!repository) return humanJson(request, env, { error: "NOT_FOUND" }, 404);
  }
  const principalId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const secret = randomToken(32);
  const placeholders = sortedProjects.map(() => "?").join(",");
  const statements = [
    env.DB.prepare(
      `INSERT INTO mcp_principals
       (id,owner_user_id,name,repository_provider,provider_repository_id,repository_canonical_url,created_by)
       SELECT ?,?,?,?,?,?,? WHERE
         (SELECT COUNT(*) FROM project_members pm JOIN projects p ON p.id=pm.project_id
          JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=pm.user_id
          WHERE pm.user_id=? AND pm.role='ADMIN' AND pm.project_id IN (${placeholders}))=?
         AND (SELECT COUNT(*) FROM mcp_principals existing WHERE existing.owner_user_id=? AND existing.status='ACTIVE')<${MAX_ACTIVE_PRINCIPALS}
         AND (? IS NULL OR (SELECT COUNT(DISTINCT gc.project_id) FROM git_connections gc
           JOIN repository_identities ri ON ri.id=gc.repository_identity_id
           JOIN project_repositories pr ON pr.project_id=gc.project_id AND pr.repository_identity_id=ri.id
           WHERE gc.project_id IN (${placeholders}) AND gc.status='VERIFIED'
             AND gc.provider=? AND gc.provider_repository_id=? AND ri.canonical_url=?)=?)`,
    ).bind(
      principalId,
      user.id,
      name,
      repository?.provider ?? null,
      repository?.provider_repository_id ?? null,
      repository?.canonical_url ?? null,
      user.id,
      user.id,
      ...sortedProjects,
      sortedProjects.length,
      user.id,
      repository?.provider ?? null,
      ...sortedProjects,
      repository?.provider ?? null,
      repository?.provider_repository_id ?? null,
      repository?.canonical_url ?? null,
      sortedProjects.length,
    ),
    ...sortedProjects.map((projectId) =>
      env.DB.prepare(
        "INSERT INTO mcp_principal_projects(principal_id,project_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM mcp_principals WHERE id=?)",
      ).bind(principalId, projectId, principalId),
    ),
    ...operations.map((operation) =>
      env.DB.prepare(
        "INSERT INTO mcp_principal_operations(principal_id,operation) SELECT ?,? WHERE EXISTS (SELECT 1 FROM mcp_principals WHERE id=?)",
      ).bind(principalId, operation, principalId),
    ),
    env.DB.prepare(
      `INSERT INTO mcp_credentials(id,principal_id,secret_hash,expires_at,created_by)
       SELECT ?,id,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || ? || ' days'),?
       FROM mcp_principals WHERE id=?`,
    ).bind(credentialId, await sha256(secret), expiresInDays, user.id, principalId),
    ...sortedProjects.map((projectId) =>
      env.DB.prepare(
        `INSERT INTO mcp_audit_events(id,principal_id,credential_id,actor_user_id,project_id,action,outcome)
         SELECT ?,?, ?,?,?, 'CREDENTIAL_ISSUED','SUCCEEDED' WHERE EXISTS (SELECT 1 FROM mcp_credentials WHERE id=?)`,
      ).bind(crypto.randomUUID(), principalId, credentialId, user.id, projectId, credentialId),
    ),
  ];
  const results = await env.DB.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1)
    return humanJson(request, env, { error: "NOT_FOUND" }, 404);
  const row = await lifecycleRow(env, user.id, credentialId);
  if (!row) return humanJson(request, env, { error: "CONFLICT" }, 409);
  return humanJson(
    request,
    env,
    {
      credential: { ...publicPrincipal(row), credentialId },
      token: `chmcp_${credentialId}.${secret}`,
    },
    201,
  );
}

async function rotateMcpCredential(
  request: Request,
  env: McpEnv,
  user: McpHuman,
  credentialId: string,
) {
  const body = await boundedObject(request);
  const expiresInDays = body?.expiresInDays;
  if (
    !body ||
    Object.keys(body).some((key) => key !== "expiresInDays") ||
    !Number.isSafeInteger(expiresInDays) ||
    (expiresInDays as number) < 1 ||
    (expiresInDays as number) > MAX_CREDENTIAL_DAYS
  )
    return humanJson(request, env, { error: "INVALID_INPUT" }, 400);
  const newId = crypto.randomUUID();
  const secret = randomToken(32);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE mcp_credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         revoked_by_user_id=?,replaced_by_credential_id=?
       WHERE id=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM mcp_principals mp
         WHERE mp.id=mcp_credentials.principal_id AND mp.owner_user_id=? AND mp.status='ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM mcp_principal_projects scope JOIN projects p ON p.id=scope.project_id
           WHERE scope.principal_id=mp.id AND (NOT EXISTS (SELECT 1 FROM project_members pm
             WHERE pm.project_id=scope.project_id AND pm.user_id=? AND pm.role='ADMIN')
             OR NOT EXISTS (SELECT 1 FROM workspace_members wm
               WHERE wm.workspace_id=p.workspace_id AND wm.user_id=?))))`,
    ).bind(user.id, newId, credentialId, user.id, user.id, user.id),
    env.DB.prepare(
      `INSERT INTO mcp_credentials(id,principal_id,secret_hash,expires_at,created_by)
       SELECT ?,principal_id,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || ? || ' days'),?
       FROM mcp_credentials WHERE id=? AND revoked_at IS NOT NULL AND replaced_by_credential_id=?`,
    ).bind(newId, await sha256(secret), expiresInDays, user.id, credentialId, newId),
    env.DB.prepare(
      `INSERT INTO mcp_audit_events(id,principal_id,credential_id,actor_user_id,project_id,action,outcome)
       SELECT ? || ':' || scope.project_id,mc.principal_id,mc.id,?,scope.project_id,'CREDENTIAL_ROTATED','SUCCEEDED'
       FROM mcp_credentials mc JOIN mcp_principal_projects scope ON scope.principal_id=mc.principal_id
       WHERE mc.id=?`,
    ).bind(crypto.randomUUID(), user.id, newId),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1)
    return humanJson(request, env, { error: "NOT_FOUND" }, 404);
  const row = await lifecycleRow(env, user.id, newId);
  return humanJson(request, env, {
    credential: { ...publicPrincipal(row ?? {}), credentialId: newId },
    token: `chmcp_${newId}.${secret}`,
  });
}

async function revokeMcpCredential(
  request: Request,
  env: McpEnv,
  user: McpHuman,
  credentialId: string,
) {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE mcp_credentials SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         revoked_by_user_id=?
       WHERE id=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM mcp_principals mp
         WHERE mp.id=mcp_credentials.principal_id AND mp.owner_user_id=?
         AND NOT EXISTS (SELECT 1 FROM mcp_principal_projects scope JOIN projects p ON p.id=scope.project_id
           WHERE scope.principal_id=mp.id AND (NOT EXISTS (SELECT 1 FROM project_members pm
             WHERE pm.project_id=scope.project_id AND pm.user_id=? AND pm.role='ADMIN')
             OR NOT EXISTS (SELECT 1 FROM workspace_members wm
               WHERE wm.workspace_id=p.workspace_id AND wm.user_id=?))))`,
    ).bind(user.id, credentialId, user.id, user.id, user.id),
    env.DB.prepare(
      `UPDATE mcp_principals SET status='REVOKED',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=(SELECT principal_id FROM mcp_credentials WHERE id=? AND revoked_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM mcp_credentials active WHERE active.principal_id=mcp_principals.id AND active.revoked_at IS NULL)`,
    ).bind(credentialId),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1)
    return humanJson(request, env, { error: "NOT_FOUND" }, 404);
  return new Response(null, { status: 204, headers: humanHeaders(request, env) });
}

export async function handleMcpCredentialRoute(
  request: Request,
  env: McpEnv,
  user: McpHuman,
  credentialId?: string,
  rotate = false,
): Promise<Response> {
  if (credentialId && !ID.test(credentialId))
    return humanJson(request, env, { error: "INVALID_INPUT" }, 400);
  if (
    ["POST", "DELETE"].includes(request.method) &&
    request.headers.get("origin") !== env.WEB_ORIGIN
  )
    return humanJson(request, env, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  if (!credentialId && request.method === "POST") return issueMcpCredential(request, env, user);
  if (!credentialId && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT mp.id,mp.name,mp.repository_provider,mp.provider_repository_id,mp.repository_canonical_url,
         mc.id AS credential_id,mc.issued_at,mc.expires_at,mc.last_used_at,mc.revoked_at,mc.replaced_by_credential_id,
         CASE WHEN mp.status='REVOKED' OR mc.revoked_at IS NOT NULL THEN 'REVOKED'
           WHEN mc.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'EXPIRED' ELSE 'ACTIVE' END credential_status,
         (SELECT group_concat(project_id,',') FROM (SELECT project_id FROM mcp_principal_projects WHERE principal_id=mp.id ORDER BY project_id)) project_ids,
         (SELECT group_concat(operation,',') FROM (SELECT operation FROM mcp_principal_operations WHERE principal_id=mp.id ORDER BY operation)) operations
       FROM mcp_credentials mc JOIN mcp_principals mp ON mp.id=mc.principal_id
       WHERE mp.owner_user_id=? AND NOT EXISTS (SELECT 1 FROM mcp_principal_projects scope
         JOIN projects p ON p.id=scope.project_id
         WHERE scope.principal_id=mp.id AND (NOT EXISTS (SELECT 1 FROM project_members pm
           WHERE pm.project_id=scope.project_id AND pm.user_id=? AND pm.role='ADMIN')
           OR NOT EXISTS (SELECT 1 FROM workspace_members wm
             WHERE wm.workspace_id=p.workspace_id AND wm.user_id=?)))
       ORDER BY mc.issued_at DESC LIMIT 51`,
    )
      .bind(user.id, user.id, user.id)
      .all<Record<string, unknown>>();
    return humanJson(request, env, {
      credentials: rows.results
        .slice(0, 50)
        .map((row) => ({ ...publicPrincipal(row), credentialId: row.credential_id })),
      truncated: rows.results.length > 50,
    });
  }
  if (credentialId && rotate && request.method === "POST")
    return rotateMcpCredential(request, env, user, credentialId);
  if (credentialId && !rotate && request.method === "DELETE")
    return revokeMcpCredential(request, env, user, credentialId);
  return humanJson(request, env, { error: "METHOD_NOT_ALLOWED" }, 405);
}
