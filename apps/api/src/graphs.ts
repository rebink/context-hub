import {
  type GraphLink as LinkRecord,
  type GraphNode as NodeRecord,
  type ValidatedGraph as ParsedGraph,
  validateGraphFormatV1,
} from "./graph-format-v1.js";
import type { ObjectStorage, StoredObjectMetadata } from "./object-storage.js";
import { randomToken, sha256Bytes } from "./security.js";

export type GraphEnv = { DB: D1Database; WEB_ORIGIN?: string };
export type GraphUser = { id: string };

export const GRAPH_BUILD_IDENTITY = Object.freeze({
  graphifyVersion: "0.9.58",
  adapterVersion: "1.0.0",
  profile: "code-only-clustered-v1",
  formatVersion: 1,
  generator: "graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1",
});

const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_LIMIT = 25;
// Fixed projections plus this count keep explorer responses below 256 KiB.
const MAX_RESULTS = 25;
const MAX_PATH_DEPTH = 8;
const MAX_VISITED_NODES = 5_000;
const MAX_VISITED_LINKS = 20_000;
const ID = /^[A-Za-z0-9_-]+$/;
const FAILURE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ORPHAN_GRACE_MS = 5 * 60 * 1000;
const ORPHAN_CLEANUP_LEASE_MS = 60 * 1000;

type Role = "ADMIN" | "EDITOR" | "VIEWER";
export type GraphStatus = "QUEUED" | "BUILDING" | "FAILED" | "READY" | "SUPERSEDED";
export type GraphRow = {
  id: string;
  project_id: string;
  version: number;
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
  status: GraphStatus;
  attempt: number;
  storage_layout: "LEGACY_V1" | "ATTEMPT_V2";
  selected_publication_id: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  failure_category: string | null;
  storage_key: string | null;
  checksum: string | null;
  byte_size: number | null;
  node_count: number | null;
  link_count: number | null;
  hyperedge_count: number | null;
  generated_by: string | null;
  published_attempt: number | null;
  published_lease_id: string | null;
  queued_at: string;
  build_started_at: string | null;
  failed_at: string | null;
  generated_at: string | null;
  superseded_at: string | null;
  updated_at: string;
  orphan_observed_at: string | null;
  orphan_attempt: number | null;
  orphan_lease_id: string | null;
  orphan_checksum: string | null;
  orphan_byte_size: number | null;
  orphan_cleanup_id: string | null;
  orphan_cleanup_expires_at: string | null;
};

export type GraphBuildResult = {
  bytes: Uint8Array<ArrayBuffer>;
  checksum: string;
  byteSize: number;
  nodeCount: number;
  linkCount: number;
  hyperedgeCount: number;
  generator: string;
  projectId: string;
  repositoryProvider: string;
  providerRepositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryCanonicalUrl: string;
  sourceCommitSha: string;
  graphifyVersion: string;
  adapterVersion: string;
  profile: string;
  formatVersion: number;
};

export type GraphClaim = {
  projectId: string;
  version: number;
  attempt: number;
  leaseId: string;
  leaseExpiresAt: string;
  publicationId: string;
  storageKey: string;
};

type GraphAttemptRow = {
  project_id: string;
  graph_version: number;
  attempt: number;
  publication_id: string;
  storage_key: string;
  status: "BUILDING" | "FAILED" | "PUBLISHED" | "CLEANED";
  lease_id: string;
  lease_expires_at: string;
  claimed_by: string;
  checksum: string | null;
  byte_size: number | null;
  content_type: string | null;
  node_count: number | null;
  link_count: number | null;
  hyperedge_count: number | null;
  generated_by: string | null;
  published_at: string | null;
  orphan_observed_at: string | null;
  cleanup_not_before: string | null;
  cleanup_claim_id: string | null;
  cleanup_claim_expires_at: string | null;
};

export class GraphConflictError extends Error {
  constructor(readonly code: "CONFLICT" | "STALE_LEASE" | "STORAGE_COLLISION" | "INTEGRITY_ERROR") {
    super(code);
  }
}

function headers(request: Request, env: GraphEnv): Headers {
  const result = new Headers({ "content-type": "application/json; charset=utf-8" });
  const origin = request.headers.get("origin");
  if (origin && origin === env.WEB_ORIGIN) {
    result.set("access-control-allow-origin", origin);
    result.set("access-control-allow-credentials", "true");
    result.set("vary", "origin");
  }
  return result;
}

function reply(
  request: Request,
  env: GraphEnv,
  value: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(value, { status, headers: headers(request, env) });
}

function fail(request: Request, env: GraphEnv, code: string, status: number): Response {
  return reply(request, env, { error: code }, status);
}

function isConflict(value: unknown): boolean {
  return value instanceof Error && /UNIQUE constraint failed/i.test(value.message);
}

function mapGraph(row: GraphRow) {
  return {
    projectId: row.project_id,
    version: row.version,
    repository: {
      provider: row.repository_provider,
      providerRepositoryId: row.provider_repository_id,
      owner: row.repository_owner,
      name: row.repository_name,
      canonicalUrl: row.repository_canonical_url,
    },
    sourceCommitSha: row.source_commit_sha,
    graphifyVersion: row.graphify_version,
    adapterVersion: row.adapter_version,
    profile: row.profile,
    formatVersion: row.format_version,
    generator: row.generator,
    generatedBy: row.generated_by,
    status: row.status,
    attempt: row.attempt,
    failureCategory: row.failure_category,
    checksum: row.checksum,
    byteSize: row.byte_size,
    nodeCount: row.node_count,
    linkCount: row.link_count,
    hyperedgeCount: row.hyperedge_count,
    queuedAt: row.queued_at,
    buildStartedAt: row.build_started_at,
    failedAt: row.failed_at,
    generatedAt: row.generated_at,
    supersededAt: row.superseded_at,
    updatedAt: row.updated_at,
  };
}

async function membership(env: GraphEnv, projectId: string, userId: string): Promise<Role | null> {
  const row = await env.DB.prepare(
    `SELECT pm.role FROM project_members pm
     JOIN projects p ON p.id = pm.project_id
     WHERE pm.project_id = ? AND pm.user_id = ?`,
  )
    .bind(projectId, userId)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

async function rowByVersion(env: GraphEnv, projectId: string, version: number) {
  return (
    (await env.DB.prepare(`SELECT * FROM graph_versions WHERE project_id = ? AND version = ?`)
      .bind(projectId, version)
      .first<GraphRow>()) ?? null
  );
}

type ReserveResult =
  | { row: GraphRow }
  | { error: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT"; status: 404 | 403 | 409 };

async function reserve(env: GraphEnv, projectId: string, actorId: string): Promise<ReserveResult> {
  try {
    const inserted = await env.DB.prepare(
      `INSERT INTO graph_versions (
           id, project_id, version, repository_provider, provider_repository_id,
           repository_owner, repository_name, repository_canonical_url, source_commit_sha,
           graphify_version, adapter_version, profile, format_version, generator,
           status, attempt, queued_at, updated_at, transition_actor_user_id
         )
         SELECT ?, gc.project_id,
           COALESCE((SELECT MAX(gv.version) + 1 FROM graph_versions gv WHERE gv.project_id = gc.project_id), 1),
           gc.provider, gc.provider_repository_id, ri.owner, ri.repository_name, ri.canonical_url,
           gc.last_known_commit_sha, ?, ?, ?, ?, ?, 'QUEUED', 1,
           strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?
         FROM git_connections gc
         JOIN repository_identities ri ON ri.id = gc.repository_identity_id
         JOIN project_repositories pr ON pr.project_id = gc.project_id
           AND pr.repository_identity_id = gc.repository_identity_id
         JOIN project_members pm ON pm.project_id = gc.project_id
           AND pm.user_id = ? AND pm.role = 'ADMIN'
         WHERE gc.project_id = ? AND gc.status = 'VERIFIED'
         RETURNING *`,
    )
      .bind(
        crypto.randomUUID(),
        GRAPH_BUILD_IDENTITY.graphifyVersion,
        GRAPH_BUILD_IDENTITY.adapterVersion,
        GRAPH_BUILD_IDENTITY.profile,
        GRAPH_BUILD_IDENTITY.formatVersion,
        GRAPH_BUILD_IDENTITY.generator,
        actorId,
        actorId,
        projectId,
      )
      .first<GraphRow>();
    if (inserted) return { row: inserted };
  } catch (cause) {
    if (!isConflict(cause)) throw cause;
  }

  const existing = await env.DB.prepare(
    `SELECT gv.* FROM graph_versions gv
     JOIN git_connections gc ON gc.project_id = gv.project_id AND gc.status = 'VERIFIED'
     JOIN repository_identities ri ON ri.id = gc.repository_identity_id
     JOIN project_repositories pr ON pr.project_id = gc.project_id
       AND pr.repository_identity_id = gc.repository_identity_id
     JOIN project_members pm ON pm.project_id = gv.project_id
       AND pm.user_id = ? AND pm.role = 'ADMIN'
     WHERE gv.project_id = ? AND gv.repository_provider = gc.provider
       AND gv.provider_repository_id = gc.provider_repository_id
       AND gv.repository_owner = ri.owner AND gv.repository_name = ri.repository_name
       AND gv.repository_canonical_url = ri.canonical_url
       AND gv.source_commit_sha = gc.last_known_commit_sha
       AND gv.graphify_version = ? AND gv.adapter_version = ? AND gv.profile = ? AND gv.format_version = ?`,
  )
    .bind(
      actorId,
      projectId,
      GRAPH_BUILD_IDENTITY.graphifyVersion,
      GRAPH_BUILD_IDENTITY.adapterVersion,
      GRAPH_BUILD_IDENTITY.profile,
      GRAPH_BUILD_IDENTITY.formatVersion,
    )
    .first<GraphRow>();
  if (!existing) {
    const currentRole = await membership(env, projectId, actorId);
    if (!currentRole) return { error: "NOT_FOUND", status: 404 };
    if (currentRole !== "ADMIN") return { error: "FORBIDDEN", status: 403 };
    return { error: "CONFLICT", status: 409 };
  }
  if (existing.status !== "FAILED") return { row: existing };
  const retried = await env.DB.prepare(
    `UPDATE graph_versions SET status = 'QUEUED', attempt = attempt + 1,
         failure_category = NULL, failed_at = NULL, build_started_at = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), transition_actor_user_id = ?
       WHERE project_id = ? AND version = ? AND status = 'FAILED' AND attempt = ?
         AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = graph_versions.project_id
           AND pm.user_id = ? AND pm.role = 'ADMIN')
       RETURNING *`,
  )
    .bind(actorId, projectId, existing.version, existing.attempt, actorId)
    .first<GraphRow>();
  if (retried) return { row: retried };
  const currentRole = await membership(env, projectId, actorId);
  if (!currentRole) return { error: "NOT_FOUND", status: 404 };
  if (currentRole !== "ADMIN") return { error: "FORBIDDEN", status: 403 };
  return { error: "CONFLICT", status: 409 };
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
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

function nodeView(node: NodeRecord) {
  const text = (name: string) => (typeof node[name] === "string" ? node[name] : null);
  return {
    id: node.id,
    label: text("label"),
    type: text("type") ?? text("file_type"),
    sourceFile: text("source_file"),
    sourceLocation: text("source_location"),
  };
}

function linkView(link: LinkRecord) {
  const text = (name: string) => (typeof link[name] === "string" ? link[name] : null);
  return {
    source: link.source,
    target: link.target,
    relation: text("relation"),
    confidence: text("confidence"),
    sourceFile: text("source_file"),
    sourceLocation: text("source_location"),
  };
}

function boundedLimit(value: unknown): number | null {
  if (value === undefined) return DEFAULT_LIMIT;
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_RESULTS
    ? (value as number)
    : null;
}

export function queryGraph(graph: ParsedGraph, body: Record<string, unknown>) {
  const operation = body.operation;
  const limit = boundedLimit(body.limit);
  if (typeof operation !== "string" || limit === null) return null;
  const nodeId = typeof body.nodeId === "string" && body.nodeId.length <= 512 ? body.nodeId : null;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (operation === "search") {
    if (typeof body.query !== "string" || body.query.trim().length < 1 || body.query.length > 128)
      return null;
    const query = body.query.toLocaleLowerCase("en-US");
    const matches = graph.nodes.filter((node) =>
      [node.id, node.label, node.source_file].some(
        (value) => typeof value === "string" && value.toLocaleLowerCase("en-US").includes(query),
      ),
    );
    return {
      operation,
      nodes: matches.slice(0, limit).map(nodeView),
      truncated: matches.length > limit,
    };
  }
  if (operation === "node") {
    if (!nodeId) return null;
    const node = nodes.get(nodeId);
    return { operation, node: node ? nodeView(node) : null, truncated: false };
  }
  if (["neighbors", "callers", "callees"].includes(operation)) {
    if (!nodeId || !nodes.has(nodeId)) return null;
    const matches: LinkRecord[] = [];
    for (const link of graph.links) {
      const selected =
        operation === "callers"
          ? link.target === nodeId
          : operation === "callees"
            ? link.source === nodeId
            : link.source === nodeId || link.target === nodeId;
      if (selected) matches.push(link);
      if (matches.length > limit) break;
    }
    const selected = matches.slice(0, limit);
    const related = selected
      .map((link) => nodes.get(link.source === nodeId ? link.target : link.source))
      .filter((node): node is NodeRecord => Boolean(node));
    return {
      operation,
      nodeId,
      nodes: related.map(nodeView),
      links: selected.map(linkView),
      truncated: matches.length > limit,
    };
  }
  if (operation === "sources") {
    const selectedNodes = nodeId
      ? [nodes.get(nodeId)].filter((node): node is NodeRecord => Boolean(node))
      : graph.nodes;
    if (nodeId && selectedNodes.length === 0) return null;
    const seen = new Set<string>();
    const sources: { file: string; location: string }[] = [];
    for (const node of selectedNodes) {
      if (typeof node.source_file !== "string" || typeof node.source_location !== "string")
        continue;
      const key = `${node.source_file}\0${node.source_location}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (sources.length < limit)
        sources.push({ file: node.source_file, location: node.source_location });
    }
    return { operation, sources, truncated: seen.size > limit };
  }
  if (operation === "path") {
    const source = typeof body.source === "string" ? body.source : "";
    const target = typeof body.target === "string" ? body.target : "";
    const maxDepth = body.maxDepth === undefined ? MAX_PATH_DEPTH : body.maxDepth;
    if (
      !nodes.has(source) ||
      !nodes.has(target) ||
      !Number.isSafeInteger(maxDepth) ||
      (maxDepth as number) < 1 ||
      (maxDepth as number) > MAX_PATH_DEPTH
    )
      return null;
    const outgoing = new Map<string, LinkRecord[]>();
    let inspectedLinks = 0;
    for (const link of graph.links) {
      if (inspectedLinks >= MAX_VISITED_LINKS) break;
      const list = outgoing.get(link.source) ?? [];
      list.push(link);
      outgoing.set(link.source, list);
      inspectedLinks += 1;
    }
    const queue: { id: string; path: LinkRecord[] }[] = [{ id: source, path: [] }];
    const visited = new Set([source]);
    let found: LinkRecord[] | null = source === target ? [] : null;
    while (queue.length && !found && visited.size < MAX_VISITED_NODES) {
      const current = queue.shift();
      if (!current || current.path.length >= (maxDepth as number)) continue;
      for (const link of outgoing.get(current.id) ?? []) {
        if (visited.has(link.target)) continue;
        const path = [...current.path, link];
        if (link.target === target) {
          found = path;
          break;
        }
        if (visited.size >= MAX_VISITED_NODES) break;
        visited.add(link.target);
        queue.push({ id: link.target, path });
      }
    }
    const pathNodes = found
      ? [source, ...found.map((link) => link.target)]
          .map((id) => nodes.get(id))
          .filter((node): node is NodeRecord => Boolean(node))
          .map(nodeView)
      : [];
    return {
      operation,
      path: found ? { nodes: pathNodes, links: found.map(linkView) } : null,
      truncated: inspectedLinks < graph.links.length || visited.size >= MAX_VISITED_NODES,
    };
  }
  return null;
}

export async function loadVerifiedReadyGraph(
  storage: ObjectStorage,
  row: GraphRow,
  beforeStorageRead?: () => Promise<void>,
) {
  if (
    !row.storage_key ||
    !row.checksum ||
    row.byte_size === null ||
    !row.published_lease_id ||
    row.published_attempt === null
  )
    return null;
  const uploadId =
    row.storage_layout === "ATTEMPT_V2"
      ? row.selected_publication_id
      : `${row.published_attempt}.${row.published_lease_id}`;
  if (!uploadId) return null;
  await beforeStorageRead?.();
  const head = await storage.head(row.storage_key);
  if (
    !head ||
    head.byteSize !== row.byte_size ||
    head.httpContentType !== "application/json" ||
    head.metadata.contentType !== "application/json" ||
    head.metadata.checksum !== row.checksum ||
    head.metadata.uploadId !== uploadId
  )
    return null;
  await beforeStorageRead?.();
  const bytes = await storage.getBytes(row.storage_key);
  if (
    !bytes ||
    bytes.byteLength !== row.byte_size ||
    bytes.byteLength > MAX_GRAPH_BYTES ||
    (await sha256Bytes(bytes)) !== row.checksum
  )
    return null;
  const graph = validateGraphFormatV1(bytes, row.source_commit_sha);
  return graph && graph.nodes.length === row.node_count && graph.links.length === row.link_count
    ? { graph, bytes }
    : null;
}

export async function handleGraphRoute(
  request: Request,
  env: GraphEnv,
  storage: ObjectStorage,
  user: GraphUser,
  projectId: string,
  segment?: string,
  query = false,
): Promise<Response> {
  if (!ID.test(projectId)) return fail(request, env, "INVALID_INPUT", 400);
  const role = await membership(env, projectId, user.id);
  if (!role) return fail(request, env, "NOT_FOUND", 404);

  if (request.method === "POST" && request.headers.get("origin") !== env.WEB_ORIGIN)
    return fail(request, env, "ORIGIN_NOT_ALLOWED", 403);
  if (segment === "build") {
    if (request.method !== "POST") return fail(request, env, "METHOD_NOT_ALLOWED", 405);
    if (role !== "ADMIN") return fail(request, env, "FORBIDDEN", 403);
    if (request.body) {
      const body = await readBody(request);
      if (!body || Object.keys(body).length !== 0) return fail(request, env, "INVALID_INPUT", 400);
    }
    const reservation = await reserve(env, projectId, user.id);
    if ("error" in reservation) return fail(request, env, reservation.error, reservation.status);
    const row = reservation.row;
    return reply(
      request,
      env,
      {
        graph: mapGraph(row),
        dispatch: "MANUAL_ACTIONS_DISPATCH_REQUIRED",
      },
      row.status === "QUEUED" ? 202 : 200,
    );
  }
  if (query) {
    if (request.method !== "POST" || !segment || !/^\d+$/.test(segment))
      return fail(request, env, "METHOD_NOT_ALLOWED", 405);
    const version = Number(segment);
    if (!Number.isSafeInteger(version) || version < 1)
      return fail(request, env, "INVALID_INPUT", 400);
    const row = await rowByVersion(env, projectId, version);
    if (!row || !["READY", "SUPERSEDED"].includes(row.status))
      return fail(request, env, "NOT_FOUND", 404);
    const body = await readBody(request);
    if (!body) return fail(request, env, "INVALID_INPUT", 400);
    const loaded = await loadVerifiedReadyGraph(storage, row);
    if (!loaded) return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
    const result = queryGraph(loaded.graph, body);
    if (!result) return fail(request, env, "INVALID_INPUT", 400);
    return reply(request, env, { graph: mapGraph(row), result });
  }
  if (request.method !== "GET") return fail(request, env, "METHOD_NOT_ALLOWED", 405);
  if (segment === "latest") {
    const row = await env.DB.prepare(
      `SELECT * FROM graph_versions WHERE project_id = ? AND status = 'READY' ORDER BY version DESC LIMIT 1`,
    )
      .bind(projectId)
      .first<GraphRow>();
    return row
      ? reply(request, env, { graph: mapGraph(row) })
      : fail(request, env, "NOT_FOUND", 404);
  }
  if (segment) {
    if (!/^\d+$/.test(segment)) return fail(request, env, "INVALID_INPUT", 400);
    const version = Number(segment);
    if (!Number.isSafeInteger(version) || version < 1)
      return fail(request, env, "INVALID_INPUT", 400);
    const row = await rowByVersion(env, projectId, version);
    return row
      ? reply(request, env, { graph: mapGraph(row) })
      : fail(request, env, "NOT_FOUND", 404);
  }
  const result = await env.DB.prepare(
    `SELECT * FROM graph_versions WHERE project_id = ? ORDER BY version DESC LIMIT 51`,
  )
    .bind(projectId)
    .all<GraphRow>();
  return reply(request, env, {
    graphs: result.results.slice(0, 50).map(mapGraph),
    truncated: result.results.length > 50,
  });
}

export async function claimGraphBuild(
  env: GraphEnv,
  projectId: string,
  version: number,
  claimedBy = "internal-runner",
  leaseSeconds = 900,
): Promise<GraphClaim> {
  if (
    !ID.test(projectId) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !claimedBy ||
    claimedBy.length > 255 ||
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 60 ||
    leaseSeconds > 3600
  )
    throw new GraphConflictError("CONFLICT");
  const leaseId = randomToken(32);
  const publicationId = randomToken(32);
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  const attempt = await env.DB.prepare(
    `INSERT INTO graph_build_attempts (
       project_id, graph_version, attempt, publication_id, storage_key, status,
       lease_id, lease_expires_at, claimed_by, claimed_at
     )
     SELECT gv.project_id, gv.version, gv.attempt, ?,
       'projects/' || gv.project_id || '/graphs/v/' || gv.version || '/attempts/' || gv.attempt || '/' || ? || '/graph.json',
       'BUILDING', ?, ?, ?, ?
     FROM graph_versions gv
     WHERE gv.project_id = ? AND gv.version = ? AND gv.status = 'QUEUED'
       AND NOT EXISTS (SELECT 1 FROM graph_build_attempts gba WHERE gba.project_id=gv.project_id
         AND gba.graph_version=gv.version AND gba.attempt=gv.attempt)
     RETURNING *`,
  )
    .bind(
      publicationId,
      publicationId,
      leaseId,
      leaseExpiresAt,
      claimedBy,
      now.toISOString(),
      projectId,
      version,
    )
    .first<GraphAttemptRow>();
  if (!attempt) throw new GraphConflictError("CONFLICT");
  return {
    projectId,
    version,
    attempt: attempt.attempt,
    leaseId,
    leaseExpiresAt,
    publicationId,
    storageKey: attempt.storage_key,
  };
}

export async function claimOrReclaimExpiredGraphBuild(
  env: GraphEnv,
  projectId: string,
  version: number,
  claimedBy: string,
): Promise<GraphClaim> {
  await expireGraphBuild(env, projectId, version);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE graph_versions SET status='QUEUED',attempt=attempt+1,failure_category=NULL,
       failed_at=NULL,build_started_at=NULL,updated_at=?
     WHERE project_id=? AND version=? AND status='FAILED' AND failure_category='LEASE_EXPIRED'`,
  )
    .bind(now, projectId, version)
    .run();
  return claimGraphBuild(env, projectId, version, claimedBy);
}

export async function failGraphBuild(
  env: GraphEnv,
  claim: GraphClaim,
  failureCategory: string,
): Promise<void> {
  if (!FAILURE.test(failureCategory)) throw new GraphConflictError("CONFLICT");
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `UPDATE graph_build_attempts SET status='FAILED', failure_category=?, failed_at=?,
       orphan_observed_at=?, cleanup_not_before=?
     WHERE project_id=? AND graph_version=? AND attempt=? AND status='BUILDING'
       AND lease_id=? AND publication_id=? AND storage_key=? AND lease_expires_at>?
     RETURNING graph_version`,
  )
    .bind(
      failureCategory,
      now,
      now,
      new Date(Date.now() + ORPHAN_GRACE_MS).toISOString(),
      claim.projectId,
      claim.version,
      claim.attempt,
      claim.leaseId,
      claim.publicationId,
      claim.storageKey,
      now,
    )
    .first<{ graph_version: number }>();
  if (!row) throw new GraphConflictError("STALE_LEASE");
}

export async function expireGraphBuild(
  env: GraphEnv,
  projectId: string,
  version: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `UPDATE graph_build_attempts SET status='FAILED', failure_category='LEASE_EXPIRED',
       failed_at=?, orphan_observed_at=?, cleanup_not_before=?
     WHERE project_id=? AND graph_version=? AND status='BUILDING' AND lease_expires_at<=?
     RETURNING graph_version`,
  )
    .bind(now, now, new Date(Date.now() + ORPHAN_GRACE_MS).toISOString(), projectId, version, now)
    .first<{ graph_version: number }>();
  return Boolean(row);
}

async function releaseCleanupClaim(
  env: GraphEnv,
  projectId: string,
  version: number,
  attempt: number,
  cleanupId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE graph_build_attempts SET cleanup_claim_id=NULL, cleanup_claim_expires_at=NULL
     WHERE project_id=? AND graph_version=? AND attempt=? AND status='FAILED'
       AND cleanup_claim_id=?`,
  )
    .bind(projectId, version, attempt, cleanupId)
    .first<{ graph_version: number }>();
}

export async function cleanupFailedGraphAttempt(
  env: GraphEnv,
  storage: ObjectStorage,
  projectId: string,
  version: number,
  attempt: number,
): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const cleanupId = randomToken(32);
  let owned: GraphAttemptRow | null;
  try {
    owned = await env.DB.prepare(
      `UPDATE graph_build_attempts SET cleanup_claim_id=?, cleanup_claim_expires_at=?
       WHERE project_id=? AND graph_version=? AND attempt=? AND status='FAILED'
         AND cleanup_not_before<=? AND (cleanup_claim_id IS NULL OR cleanup_claim_expires_at<=?)
         AND checksum IS NOT NULL AND byte_size IS NOT NULL AND content_type='application/json'
       RETURNING *`,
    )
      .bind(
        cleanupId,
        new Date(now.getTime() + ORPHAN_CLEANUP_LEASE_MS).toISOString(),
        projectId,
        version,
        attempt,
        nowIso,
        nowIso,
      )
      .first<GraphAttemptRow>();
  } catch (cause) {
    await releaseCleanupClaim(env, projectId, version, attempt, cleanupId).catch(() => undefined);
    throw cause;
  }
  if (!owned) return false;
  try {
    const referenced = await env.DB.prepare(
      `SELECT version FROM graph_versions WHERE project_id=?
       AND (storage_key=? OR selected_publication_id=?) LIMIT 1`,
    )
      .bind(projectId, owned.storage_key, owned.publication_id)
      .first<{ version: number }>();
    if (referenced) {
      await releaseCleanupClaim(env, projectId, version, attempt, cleanupId);
      return false;
    }
    const head = await storage.head(owned.storage_key);
    if (
      !head ||
      head.byteSize !== owned.byte_size ||
      head.httpContentType !== owned.content_type ||
      head.metadata.contentType !== owned.content_type ||
      head.metadata.checksum !== owned.checksum ||
      head.metadata.uploadId !== owned.publication_id
    ) {
      await releaseCleanupClaim(env, projectId, version, attempt, cleanupId);
      return false;
    }
    const fresh = await env.DB.prepare(
      `SELECT gba.* FROM graph_build_attempts gba
       WHERE gba.project_id=? AND gba.graph_version=? AND gba.attempt=?
         AND gba.status='FAILED' AND gba.cleanup_claim_id=? AND gba.cleanup_claim_expires_at>?
         AND NOT EXISTS (
           SELECT 1 FROM graph_versions gv
           WHERE gv.project_id=gba.project_id AND gv.storage_key=gba.storage_key
         )
         AND NOT EXISTS (
           SELECT 1 FROM graph_versions gv
           WHERE gv.project_id=gba.project_id AND gv.selected_publication_id=gba.publication_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM graph_build_attempts other
           WHERE other.storage_key=gba.storage_key
             AND (other.project_id<>gba.project_id OR other.graph_version<>gba.graph_version OR other.attempt<>gba.attempt)
         )
         AND NOT EXISTS (
           SELECT 1 FROM graph_build_attempts other
           WHERE other.publication_id=gba.publication_id
             AND (other.project_id<>gba.project_id OR other.graph_version<>gba.graph_version OR other.attempt<>gba.attempt)
         )`,
    )
      .bind(projectId, version, attempt, cleanupId, new Date().toISOString())
      .first<GraphAttemptRow>();
    if (!fresh) {
      await releaseCleanupClaim(env, projectId, version, attempt, cleanupId);
      return false;
    }
    await storage.compensationDelete(owned.storage_key);
    if (await storage.head(owned.storage_key)) {
      await releaseCleanupClaim(env, projectId, version, attempt, cleanupId);
      return false;
    }
    // Keep the failed attempt eligible in case an eventually consistent late write
    // recreates this exact key after the successful delete.
    const reconciled = await env.DB.prepare(
      `UPDATE graph_build_attempts SET cleanup_claim_id=NULL, cleanup_claim_expires_at=NULL,
         cleanup_result='DELETED', cleanup_not_before=?
       WHERE project_id=? AND graph_version=? AND attempt=? AND status='FAILED' AND cleanup_claim_id=?
       RETURNING graph_version`,
    )
      .bind(
        new Date(Date.now() + ORPHAN_GRACE_MS).toISOString(),
        projectId,
        version,
        attempt,
        cleanupId,
      )
      .first<{ graph_version: number }>();
    return Boolean(reconciled);
  } catch {
    await releaseCleanupClaim(env, projectId, version, attempt, cleanupId).catch(() => undefined);
    return false;
  }
}

function resultMatches(row: GraphRow, claim: GraphClaim, result: GraphBuildResult) {
  return (
    result.projectId === row.project_id &&
    result.projectId === claim.projectId &&
    result.repositoryProvider === row.repository_provider &&
    result.providerRepositoryId === row.provider_repository_id &&
    result.repositoryOwner === row.repository_owner &&
    result.repositoryName === row.repository_name &&
    result.repositoryCanonicalUrl === row.repository_canonical_url &&
    result.sourceCommitSha === row.source_commit_sha &&
    result.graphifyVersion === row.graphify_version &&
    result.adapterVersion === row.adapter_version &&
    result.profile === row.profile &&
    result.formatVersion === row.format_version &&
    result.generator === row.generator
  );
}

function storedObjectMatches(
  head: StoredObjectMetadata | null,
  result: GraphBuildResult,
  uploadId: string,
): boolean {
  return Boolean(
    head &&
      head.byteSize === result.byteSize &&
      head.httpContentType === "application/json" &&
      head.metadata.contentType === "application/json" &&
      head.metadata.checksum === result.checksum &&
      head.metadata.uploadId === uploadId,
  );
}

async function attemptByClaim(env: GraphEnv, claim: GraphClaim): Promise<GraphAttemptRow | null> {
  return env.DB.prepare(
    `SELECT * FROM graph_build_attempts WHERE project_id=? AND graph_version=? AND attempt=?
       AND lease_id=? AND publication_id=? AND storage_key=?`,
  )
    .bind(
      claim.projectId,
      claim.version,
      claim.attempt,
      claim.leaseId,
      claim.publicationId,
      claim.storageKey,
    )
    .first<GraphAttemptRow>();
}

async function publicationMatches(
  storage: ObjectStorage,
  row: GraphRow,
  attempt: GraphAttemptRow,
  claim: GraphClaim,
  result: GraphBuildResult,
) {
  if (
    !["READY", "SUPERSEDED"].includes(row.status) ||
    attempt.status !== "PUBLISHED" ||
    attempt.claimed_by !== attempt.generated_by ||
    row.generated_by !== attempt.claimed_by ||
    row.published_attempt !== claim.attempt ||
    row.published_lease_id !== claim.leaseId ||
    row.selected_publication_id !== claim.publicationId ||
    row.storage_key !== claim.storageKey ||
    row.checksum !== result.checksum ||
    row.byte_size !== result.byteSize ||
    row.node_count !== result.nodeCount ||
    row.link_count !== result.linkCount ||
    row.hyperedge_count !== result.hyperedgeCount ||
    !row.storage_key
  )
    return false;
  if (
    attempt.project_id !== claim.projectId ||
    attempt.graph_version !== claim.version ||
    attempt.attempt !== claim.attempt ||
    attempt.lease_id !== claim.leaseId ||
    attempt.publication_id !== claim.publicationId ||
    attempt.storage_key !== claim.storageKey ||
    attempt.checksum !== result.checksum ||
    attempt.byte_size !== result.byteSize ||
    attempt.content_type !== "application/json" ||
    attempt.node_count !== result.nodeCount ||
    attempt.link_count !== result.linkCount ||
    attempt.hyperedge_count !== result.hyperedgeCount
  )
    return false;
  const head = await storage.head(row.storage_key);
  return storedObjectMatches(head, result, claim.publicationId);
}

export async function publishGraphBuild(
  env: GraphEnv,
  storage: ObjectStorage,
  claim: GraphClaim,
  result: GraphBuildResult,
): Promise<GraphRow> {
  if (
    result.byteSize !== result.bytes.byteLength ||
    result.byteSize < 1 ||
    result.byteSize > MAX_GRAPH_BYTES ||
    !/^[0-9a-f]{64}$/.test(result.checksum)
  )
    throw new GraphConflictError("INTEGRITY_ERROR");
  // Exact submitted bytes are authoritative even on replay; metadata alone cannot
  // shortcut validation of a tampered request body.
  const graph = validateGraphFormatV1(result.bytes, result.sourceCommitSha);
  if (
    !graph ||
    graph.nodes.length !== result.nodeCount ||
    graph.links.length !== result.linkCount ||
    result.hyperedgeCount !== 0 ||
    (await sha256Bytes(result.bytes)) !== result.checksum
  )
    throw new GraphConflictError("INTEGRITY_ERROR");
  const row = await rowByVersion(env, claim.projectId, claim.version);
  if (!row || !resultMatches(row, claim, result)) throw new GraphConflictError("CONFLICT");
  const attempt = await attemptByClaim(env, claim);
  if (!attempt) throw new GraphConflictError("STALE_LEASE");
  if (await publicationMatches(storage, row, attempt, claim, result)) return row;
  const leaseCheckAt = new Date().toISOString();
  if (
    attempt.status !== "BUILDING" ||
    row.status !== "BUILDING" ||
    row.attempt !== claim.attempt ||
    row.lease_id !== claim.leaseId ||
    !row.lease_expires_at ||
    row.lease_expires_at <= leaseCheckAt
  )
    throw new GraphConflictError("STALE_LEASE");
  const expectedKey = `projects/${claim.projectId}/graphs/v/${claim.version}/attempts/${claim.attempt}/${claim.publicationId}/graph.json`;
  if (claim.storageKey !== expectedKey) throw new GraphConflictError("CONFLICT");
  const key = claim.storageKey;
  const uploadId = claim.publicationId;
  let stored = false;
  try {
    const outcome = await storage.createOnly(key, result.bytes, {
      contentType: "application/json",
      checksum: result.checksum,
      uploadId,
    });
    stored = storedObjectMatches(await storage.head(key), result, uploadId);
    if (!stored)
      throw new GraphConflictError(
        outcome === "collision" ? "STORAGE_COLLISION" : "INTEGRITY_ERROR",
      );
  } catch (cause) {
    if (cause instanceof GraphConflictError) throw cause;
    const head = await storage.head(key).catch(() => null);
    stored = storedObjectMatches(head, result, uploadId);
    if (!stored) throw cause;
  }
  const evidenceAt = new Date().toISOString();
  const recorded = await env.DB.prepare(
    `UPDATE graph_build_attempts SET checksum=?, byte_size=?, content_type='application/json',
       node_count=?, link_count=?, hyperedge_count=?, generated_by=claimed_by
     WHERE project_id=? AND graph_version=? AND attempt=? AND status='BUILDING'
       AND lease_id=? AND publication_id=? AND storage_key=? AND lease_expires_at>?
     RETURNING graph_version`,
  )
    .bind(
      result.checksum,
      result.byteSize,
      result.nodeCount,
      result.linkCount,
      result.hyperedgeCount,
      claim.projectId,
      claim.version,
      claim.attempt,
      claim.leaseId,
      claim.publicationId,
      claim.storageKey,
      evidenceAt,
    )
    .first<{ graph_version: number }>();
  if (!recorded) throw new GraphConflictError("STALE_LEASE");

  // Upload, HEAD validation, and evidence recording consume lease time. Generate the
  // publication time immediately before the terminal D1 statement.
  const publishedAt = new Date().toISOString();
  let publishedAttempt: GraphAttemptRow | null = null;
  try {
    publishedAttempt = await env.DB.prepare(
      `UPDATE graph_build_attempts SET status='PUBLISHED', checksum=?, byte_size=?, content_type='application/json',
         node_count=?, link_count=?, hyperedge_count=?, generated_by=claimed_by, published_at=?
       WHERE project_id=? AND graph_version=? AND attempt=? AND status='BUILDING'
         AND lease_id=? AND publication_id=? AND storage_key=? AND lease_expires_at>?
       RETURNING *`,
    )
      .bind(
        result.checksum,
        result.byteSize,
        result.nodeCount,
        result.linkCount,
        result.hyperedgeCount,
        publishedAt,
        claim.projectId,
        claim.version,
        claim.attempt,
        claim.leaseId,
        claim.publicationId,
        claim.storageKey,
        publishedAt,
      )
      .first<GraphAttemptRow>();
  } catch (cause) {
    const [replay, replayAttempt] = await Promise.all([
      rowByVersion(env, claim.projectId, claim.version),
      attemptByClaim(env, claim),
    ]);
    if (
      replay &&
      replayAttempt &&
      (await publicationMatches(storage, replay, replayAttempt, claim, result))
    )
      return replay;
    throw cause;
  }
  if (publishedAttempt) {
    const published = await rowByVersion(env, claim.projectId, claim.version);
    if (
      published &&
      (await publicationMatches(storage, published, publishedAttempt, claim, result))
    )
      return published;
  }
  const [replay, replayAttempt] = await Promise.all([
    rowByVersion(env, claim.projectId, claim.version),
    attemptByClaim(env, claim),
  ]);
  if (
    replay &&
    replayAttempt &&
    (await publicationMatches(storage, replay, replayAttempt, claim, result))
  )
    return replay;
  throw new GraphConflictError("STALE_LEASE");
}
