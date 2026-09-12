import { type GraphRow, loadVerifiedReadyGraph } from "./graphs.js";
import type { ObjectStorage } from "./object-storage.js";

export type SyncEnv = { DB: D1Database; WEB_ORIGIN?: string };
export type SyncUser = { id: string };

const ID = /^[A-Za-z0-9_-]+$/;

type RepositoryRow = {
  provider: string;
  provider_repository_id: string;
  owner: string;
  repository_name: string;
  canonical_url: string;
  default_branch: string;
  last_known_commit_sha: string;
};

function json(request: Request, env: SyncEnv, body: Record<string, unknown>, status = 200) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
  });
  const origin = request.headers.get("origin");
  if (origin && origin === env.WEB_ORIGIN) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "origin");
  }
  return Response.json(body, { status, headers });
}

function fail(request: Request, env: SyncEnv, code: string, status: number) {
  return json(request, env, { error: code }, status);
}

function graphMetadata(row: GraphRow | null) {
  if (!row) return null;
  return {
    repository: {
      provider: row.repository_provider,
      providerRepositoryId: row.provider_repository_id,
      owner: row.repository_owner,
      name: row.repository_name,
      canonicalUrl: row.repository_canonical_url,
    },
    version: row.version,
    status: row.status,
    sourceCommitSha: row.source_commit_sha,
    checksum: row.checksum,
    byteSize: row.byte_size,
    nodeCount: row.node_count,
    linkCount: row.link_count,
    hyperedgeCount: row.hyperedge_count,
    graphifyVersion: row.graphify_version,
    adapterVersion: row.adapter_version,
    profile: row.profile,
    formatVersion: row.format_version,
    generator: row.generator,
    failureCategory: row.failure_category,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
  };
}

async function repositoryForMember(env: SyncEnv, projectId: string, userId: string) {
  return (
    (await env.DB.prepare(
      `SELECT gc.provider, gc.provider_repository_id, ri.owner, ri.repository_name,
              ri.canonical_url, gc.default_branch, gc.last_known_commit_sha
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       JOIN git_connections gc ON gc.project_id = p.id AND gc.status = 'VERIFIED'
       JOIN repository_identities ri ON ri.id = gc.repository_identity_id
       JOIN project_repositories pr ON pr.project_id = p.id
         AND pr.repository_identity_id = ri.id
       WHERE p.id = ?`,
    )
      .bind(userId, projectId)
      .first<RepositoryRow>()) ?? null
  );
}

async function graphRow(
  env: SyncEnv,
  projectId: string,
  repository: RepositoryRow,
  clause: string,
  version?: number,
) {
  const statement = env.DB.prepare(
    `SELECT * FROM graph_versions
     WHERE project_id = ? AND repository_provider = ? AND provider_repository_id = ?
       AND repository_canonical_url = ? AND ${clause}
     ORDER BY version DESC LIMIT 1`,
  );
  const bindings: unknown[] = [
    projectId,
    repository.provider,
    repository.provider_repository_id,
    repository.canonical_url,
  ];
  if (version !== undefined) bindings.push(version);
  return (await statement.bind(...bindings).first<GraphRow>()) ?? null;
}

export async function handleSyncRoute(
  request: Request,
  env: SyncEnv,
  storage: ObjectStorage,
  user: SyncUser,
  projectId: string,
  versionText?: string,
): Promise<Response> {
  if (!ID.test(projectId)) return fail(request, env, "INVALID_INPUT", 400);

  const repository = await repositoryForMember(env, projectId, user.id);
  if (!repository) return fail(request, env, "NOT_FOUND", 404);
  if (request.method !== "GET") return fail(request, env, "METHOD_NOT_ALLOWED", 405);

  if (versionText !== undefined) {
    if (!/^\d+$/.test(versionText)) return fail(request, env, "INVALID_INPUT", 400);
    const version = Number(versionText);
    if (!Number.isSafeInteger(version) || version < 1)
      return fail(request, env, "INVALID_INPUT", 400);
    const row = await graphRow(
      env,
      projectId,
      repository,
      "version = ? AND status = 'READY'",
      version,
    );
    if (!row) return fail(request, env, "NOT_FOUND", 404);
    const loaded = await loadVerifiedReadyGraph(storage, row);
    if (!loaded) return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
    const headers = new Headers({
      "content-type": "application/json",
      "content-length": String(loaded.bytes.byteLength),
      "cache-control": "private, no-store",
      etag: `"${row.checksum}"`,
      "x-context-graph-version": String(row.version),
      "x-context-source-commit": row.source_commit_sha,
      "x-context-checksum-sha256": row.checksum ?? "",
      "x-content-type-options": "nosniff",
    });
    return new Response(loaded.bytes, { status: 200, headers });
  }

  const [newest, ready] = await Promise.all([
    graphRow(env, projectId, repository, "1 = 1"),
    graphRow(env, projectId, repository, "status = 'READY'"),
  ]);
  return json(request, env, {
    projectId,
    repository: {
      provider: repository.provider,
      providerRepositoryId: repository.provider_repository_id,
      owner: repository.owner,
      name: repository.repository_name,
      canonicalUrl: repository.canonical_url,
      defaultBranch: repository.default_branch,
      remoteCommitSha: repository.last_known_commit_sha,
    },
    newestGraph: graphMetadata(newest),
    readyGraph: graphMetadata(ready),
  });
}
