import type { GraphRow } from "./graphs.js";
import { loadVerifiedReadyGraph } from "./graphs.js";
import type { ObjectStorage, StoredObjectMetadata } from "./object-storage.js";
import { sha256Bytes } from "./security.js";

export type SnapshotEnv = { DB: D1Database; WEB_ORIGIN?: string };
export type SnapshotUser = { id: string };

type Role = "ADMIN" | "EDITOR" | "VIEWER";
type ArtifactReference = {
  artifact_id: string;
  artifact_version: number;
  artifact_type: string;
  storage_key: string;
  checksum: string;
  content_type: string;
  byte_size: number;
  source_commit_sha: string | null;
  change_note: string | null;
  version_created_by: string;
  version_created_at: string;
  upload_id: string;
};
type SnapshotRow = {
  id: string;
  project_id: string;
  name: string;
  git_sha: string;
  graph_version: number;
  graph_storage_layout: "LEGACY_V1" | "ATTEMPT_V2";
  graph_publication_id: string | null;
  graph_published_attempt: number;
  graph_published_lease_id: string;
  graph_storage_key: string;
  graph_upload_id: string;
  graph_checksum: string;
  graph_byte_size: number;
  graph_content_type: string;
  graph_repository_provider: string;
  graph_provider_repository_id: string;
  graph_repository_owner: string;
  graph_repository_name: string;
  graph_repository_canonical_url: string;
  graphify_version: string;
  graph_adapter_version: string;
  graph_profile: string;
  graph_format_version: number;
  graph_generator: string;
  graph_generated_by: string;
  graph_generated_at: string;
  created_by: string;
  created_at: string;
  expected_artifact_count: number;
  idempotency_key: string | null;
  manifest_storage_key: string;
  manifest_byte_size: number;
  manifest_checksum: string;
  manifest_content_type: string;
};

type CreateInput = {
  name: string;
  gitSha: string;
  graphVersion: number;
  artifacts: Array<{ artifactId: string; version: number }>;
  idempotencyKey: string | null;
};

const ID = /^[A-Za-z0-9_-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_ARTIFACTS = 100;
const MANIFEST_CONTENT_TYPE = "application/json";

export const SNAPSHOT_GRAPH_RESPONSE_FIELDS = [
  "version",
  "sourceCommitSha",
  "storageLayout",
  "publicationId",
  "publishedAttempt",
  "publishedLeaseId",
  "uploadId",
  "checksum",
  "byteSize",
  "contentType",
  "repository.provider",
  "repository.providerRepositoryId",
  "repository.owner",
  "repository.name",
  "repository.canonicalUrl",
  "graphifyVersion",
  "adapterVersion",
  "profile",
  "formatVersion",
  "generator",
  "generatedBy",
  "generatedAt",
] as const;
export const SNAPSHOT_ARTIFACT_RESPONSE_FIELDS = [
  "artifactId",
  "version",
  "type",
  "checksum",
  "byteSize",
  "contentType",
  "uploadId",
  "sourceCommitSha",
  "changeNote",
  "createdBy",
  "createdAt",
] as const;
export const SNAPSHOT_MANIFEST_RESPONSE_FIELDS = ["checksum", "byteSize", "contentType"] as const;

function responseHeaders(request: Request, env: SnapshotEnv) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  const origin = request.headers.get("origin");
  if (origin && origin === env.WEB_ORIGIN) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "origin");
  }
  return headers;
}

function reply(request: Request, env: SnapshotEnv, value: Record<string, unknown>, status = 200) {
  return Response.json(value, { status, headers: responseHeaders(request, env) });
}

function fail(request: Request, env: SnapshotEnv, code: string, status: number) {
  return reply(request, env, { error: code }, status);
}

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
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
  return bytes as Uint8Array<ArrayBuffer>;
}

async function parseCreate(request: Request): Promise<CreateInput | "INVALID_INPUT" | "TOO_LARGE"> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return "INVALID_INPUT";
  const bytes = await readBody(request);
  if (!bytes) return "TOO_LARGE";
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return "INVALID_INPUT";
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return "INVALID_INPUT";
  const body = decoded as Record<string, unknown>;
  const allowed = new Set(["name", "gitSha", "graphVersion", "artifacts", "idempotencyKey"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return "INVALID_INPUT";
  if (
    typeof body.name !== "string" ||
    body.name !== body.name.trim() ||
    body.name.length < 1 ||
    body.name.length > 200
  )
    return "INVALID_INPUT";
  if (typeof body.gitSha !== "string" || !SHA.test(body.gitSha)) return "INVALID_INPUT";
  if (
    !Number.isSafeInteger(body.graphVersion) ||
    (body.graphVersion as number) < 1 ||
    (body.graphVersion as number) > 2_147_483_647
  )
    return "INVALID_INPUT";
  if (!Array.isArray(body.artifacts) || body.artifacts.length > MAX_ARTIFACTS)
    return "INVALID_INPUT";
  const artifacts: CreateInput["artifacts"] = [];
  const ids = new Set<string>();
  for (const item of body.artifacts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "INVALID_INPUT";
    const value = item as Record<string, unknown>;
    if (Object.keys(value).length !== 2 || !("artifactId" in value) || !("version" in value))
      return "INVALID_INPUT";
    if (
      typeof value.artifactId !== "string" ||
      !ID.test(value.artifactId) ||
      ids.has(value.artifactId)
    )
      return "INVALID_INPUT";
    if (
      !Number.isSafeInteger(value.version) ||
      (value.version as number) < 1 ||
      (value.version as number) > 2_147_483_647
    )
      return "INVALID_INPUT";
    ids.add(value.artifactId);
    artifacts.push({ artifactId: value.artifactId, version: value.version as number });
  }
  artifacts.sort((a, b) =>
    a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0,
  );
  const idempotencyKey = body.idempotencyKey === undefined ? null : body.idempotencyKey;
  if (
    idempotencyKey !== null &&
    (typeof idempotencyKey !== "string" || !IDEMPOTENCY.test(idempotencyKey))
  )
    return "INVALID_INPUT";
  return {
    name: body.name,
    gitSha: body.gitSha,
    graphVersion: body.graphVersion as number,
    artifacts,
    idempotencyKey,
  };
}

async function membership(env: SnapshotEnv, projectId: string, userId: string) {
  const row = await env.DB.prepare(
    `SELECT pm.role FROM project_members pm JOIN projects p ON p.id = pm.project_id
     WHERE pm.project_id = ? AND pm.user_id = ?`,
  )
    .bind(projectId, userId)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

function parseLimit(url: URL) {
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_LIMIT ? value : null;
}

function encodeCursor(createdAt: string, id: string) {
  return btoa(JSON.stringify([createdAt, id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(raw: string | null): [string, string] | null | undefined {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/")));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      ID.test(value[1])
    )
      return [value[0], value[1]];
  } catch {
    // Invalid cursors are ordinary bounded input failures.
  }
  return undefined;
}

function graphEvidence(row: SnapshotRow) {
  return {
    version: row.graph_version,
    sourceCommitSha: row.git_sha,
    storageLayout: row.graph_storage_layout,
    publicationId: row.graph_publication_id,
    publishedAttempt: row.graph_published_attempt,
    publishedLeaseId: row.graph_published_lease_id,
    uploadId: row.graph_upload_id,
    checksum: row.graph_checksum,
    byteSize: row.graph_byte_size,
    contentType: row.graph_content_type,
    repository: {
      provider: row.graph_repository_provider,
      providerRepositoryId: row.graph_provider_repository_id,
      owner: row.graph_repository_owner,
      name: row.graph_repository_name,
      canonicalUrl: row.graph_repository_canonical_url,
    },
    graphifyVersion: row.graphify_version,
    adapterVersion: row.graph_adapter_version,
    profile: row.graph_profile,
    formatVersion: row.graph_format_version,
    generator: row.graph_generator,
    generatedBy: row.graph_generated_by,
    generatedAt: row.graph_generated_at,
  };
}

function artifactEvidence(row: ArtifactReference) {
  return {
    artifactId: row.artifact_id,
    version: row.artifact_version,
    type: row.artifact_type,
    checksum: row.checksum,
    byteSize: row.byte_size,
    contentType: row.content_type,
    uploadId: row.upload_id,
    sourceCommitSha: row.source_commit_sha,
    changeNote: row.change_note,
    createdBy: row.version_created_by,
    createdAt: row.version_created_at,
  };
}

function manifestBytes(row: SnapshotRow, artifacts: ArtifactReference[]) {
  const value = {
    formatVersion: 1,
    snapshotId: row.id,
    projectId: row.project_id,
    name: row.name,
    gitSha: row.git_sha,
    graph: graphEvidence(row),
    artifacts: artifacts.map(artifactEvidence),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`) as Uint8Array<ArrayBuffer>;
}

function matchesRequest(row: SnapshotRow, refs: ArtifactReference[], input: CreateInput) {
  return (
    row.name === input.name &&
    row.git_sha === input.gitSha &&
    row.graph_version === input.graphVersion &&
    refs.length === input.artifacts.length &&
    refs.every(
      (ref, index) =>
        ref.artifact_id === input.artifacts[index]?.artifactId &&
        ref.artifact_version === input.artifacts[index]?.version,
    )
  );
}

function snapshotView(row: SnapshotRow, artifactCount?: number) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    gitSha: row.git_sha,
    graph: graphEvidence(row),
    artifactCount: artifactCount ?? row.expected_artifact_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
    manifest: {
      checksum: row.manifest_checksum,
      byteSize: row.manifest_byte_size,
      contentType: row.manifest_content_type,
    },
  };
}

async function snapshotRow(env: SnapshotEnv, projectId: string, snapshotId: string) {
  return (
    (await env.DB.prepare(`SELECT * FROM context_snapshots WHERE project_id = ? AND id = ?`)
      .bind(projectId, snapshotId)
      .first<SnapshotRow>()) ?? null
  );
}

async function snapshotArtifacts(env: SnapshotEnv, projectId: string, snapshotId: string) {
  const result = await env.DB.prepare(
    `SELECT artifact_id, artifact_version, artifact_type, storage_key, upload_id, checksum, content_type,
            byte_size, source_commit_sha, change_note, version_created_by, version_created_at
     FROM snapshot_artifacts WHERE project_id = ? AND snapshot_id = ? ORDER BY artifact_id`,
  )
    .bind(projectId, snapshotId)
    .all<ArtifactReference>();
  return result.results;
}

async function databaseNow(env: SnapshotEnv) {
  const row = await env.DB.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`).first<{
    now: string;
  }>();
  if (!row?.now) throw new Error("D1 time unavailable");
  return row.now;
}

async function recordAttempt(
  env: SnapshotEnv,
  projectId: string,
  actorId: string,
  outcome: "REJECTED" | "FAILED",
  reason: string,
) {
  await env.DB.prepare(
    `INSERT INTO snapshot_events (id, project_id, snapshot_id, actor_id, action, outcome, reason, created_at)
     VALUES (?, ?, NULL, ?, 'snapshot-create', ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), projectId, actorId, outcome, reason, await databaseNow(env))
    .run();
}

async function verifiedArtifact(
  env: SnapshotEnv,
  storage: ObjectStorage,
  projectId: string,
  requested: { artifactId: string; version: number },
  allowArchived = false,
) {
  const row = await env.DB.prepare(
    `SELECT av.artifact_id, av.version AS artifact_version, a.type AS artifact_type, av.storage_key,
            av.checksum, av.content_type, av.byte_size, av.source_commit_sha, av.change_note,
            av.created_by AS version_created_by, av.created_at AS version_created_at
     FROM artifact_versions av JOIN artifacts a ON a.id = av.artifact_id
     WHERE a.project_id = ? AND av.artifact_id = ? AND av.version = ?
       AND (? = 1 OR a.status='ACTIVE')`,
  )
    .bind(projectId, requested.artifactId, requested.version, allowArchived ? 1 : 0)
    .first<Omit<ArtifactReference, "upload_id">>();
  if (
    !row ||
    row.storage_key !==
      `projects/${projectId}/artifacts/${requested.artifactId}/v/${requested.version}/content`
  )
    return null;
  const head = await storage.head(row.storage_key);
  if (
    !head ||
    head.byteSize !== row.byte_size ||
    head.httpContentType !== row.content_type ||
    head.metadata.contentType !== row.content_type ||
    head.metadata.checksum !== row.checksum ||
    !head.metadata.uploadId
  )
    return null;
  const bytes = await storage.getBytes(row.storage_key);
  if (!bytes || bytes.byteLength !== row.byte_size || (await sha256Bytes(bytes)) !== row.checksum)
    return null;
  return { ...row, upload_id: head.metadata.uploadId };
}

function exactBytes(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function storedManifestMatches(
  head: StoredObjectMetadata | null,
  bytes: Uint8Array<ArrayBuffer>,
  checksum: string,
  snapshotId: string,
) {
  return Boolean(
    head &&
      head.byteSize === bytes.byteLength &&
      head.httpContentType === MANIFEST_CONTENT_TYPE &&
      head.metadata.contentType === MANIFEST_CONTENT_TYPE &&
      head.metadata.checksum === checksum &&
      head.metadata.uploadId === snapshotId,
  );
}

type ManifestPublication = "CREATED" | "ADOPTED" | "COLLISION" | "FAILURE";

async function verifiedManifestObject(
  storage: ObjectStorage,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  checksum: string,
  snapshotId: string,
) {
  const head = await storage.head(key);
  const stored = await storage.getBytes(key);
  return Boolean(
    storedManifestMatches(head, bytes, checksum, snapshotId) &&
      stored &&
      exactBytes(stored, bytes) &&
      (await sha256Bytes(stored)) === checksum,
  );
}

async function publishManifest(
  storage: ObjectStorage,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  checksum: string,
  snapshotId: string,
): Promise<ManifestPublication> {
  try {
    const outcome = await storage.createOnly(key, bytes, {
      contentType: MANIFEST_CONTENT_TYPE,
      checksum,
      uploadId: snapshotId,
    });
    if (!(await verifiedManifestObject(storage, key, bytes, checksum, snapshotId))) {
      return outcome === "collision" ? "COLLISION" : "FAILURE";
    }
    return outcome === "created" ? "CREATED" : "ADOPTED";
  } catch {
    return (await verifiedManifestObject(storage, key, bytes, checksum, snapshotId).catch(
      () => false,
    ))
      ? "ADOPTED"
      : "FAILURE";
  }
}

async function compensateCreatedManifest(
  env: SnapshotEnv,
  storage: ObjectStorage,
  row: SnapshotRow,
) {
  try {
    const head = await storage.head(row.manifest_storage_key);
    const bytes = await storage.getBytes(row.manifest_storage_key);
    if (
      head?.metadata.uploadId !== row.id ||
      head.metadata.checksum !== row.manifest_checksum ||
      head.byteSize !== row.manifest_byte_size ||
      bytes?.byteLength !== row.manifest_byte_size ||
      (await sha256Bytes(bytes)) !== row.manifest_checksum
    ) {
      return;
    }
    // This is intentionally the final operation before delete: any uncertainty or
    // concurrent publication keeps the object.
    const referenced = await env.DB.prepare(
      `SELECT id FROM context_snapshots WHERE project_id = ? AND manifest_storage_key = ?`,
    )
      .bind(row.project_id, row.manifest_storage_key)
      .first<{ id: string }>();
    if (!referenced) await storage.compensationDelete(row.manifest_storage_key);
  } catch {
    // Publication uncertainty retains an orphan rather than risking referenced bytes.
  }
}

async function listSnapshots(
  request: Request,
  env: SnapshotEnv,
  storage: ObjectStorage,
  projectId: string,
) {
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  if (limit === null || cursor === undefined) return fail(request, env, "INVALID_INPUT", 400);
  const at = cursor?.[0] ?? null;
  const id = cursor?.[1] ?? null;
  const result = await env.DB.prepare(
    `SELECT cs.*, COUNT(sa.artifact_id) AS artifact_count
     FROM context_snapshots cs LEFT JOIN snapshot_artifacts sa ON sa.snapshot_id = cs.id AND sa.project_id = cs.project_id
     WHERE cs.project_id = ? AND (? IS NULL OR cs.created_at < ? OR (cs.created_at = ? AND cs.id < ?))
     GROUP BY cs.id ORDER BY cs.created_at DESC, cs.id DESC LIMIT ?`,
  )
    .bind(projectId, at, at, at, id, limit + 1)
    .all<SnapshotRow & { artifact_count: number }>();
  const rows = result.results.slice(0, limit);
  const verified = await Promise.all(rows.map((row) => verifySnapshotIntegrity(env, storage, row)));
  if (verified.some((item) => !item)) return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
  const last = rows.at(-1);
  return reply(request, env, {
    snapshots: rows.map((row, index) => snapshotView(row, verified[index]?.refs.length)),
    nextCursor:
      result.results.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  });
}

async function inspectSnapshot(
  request: Request,
  env: SnapshotEnv,
  storage: ObjectStorage,
  projectId: string,
  snapshotId: string,
) {
  const row = await snapshotRow(env, projectId, snapshotId);
  if (!row) return fail(request, env, "NOT_FOUND", 404);
  const verified = await verifySnapshotIntegrity(env, storage, row);
  if (!verified) return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
  return reply(request, env, {
    snapshot: snapshotView(row, verified.refs.length),
    artifacts: verified.refs.map(artifactEvidence),
  });
}

async function createSnapshot(
  request: Request,
  env: SnapshotEnv,
  storage: ObjectStorage,
  projectId: string,
  user: SnapshotUser,
) {
  const parsed = await parseCreate(request);
  if (typeof parsed === "string") {
    const code = parsed === "TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "INVALID_INPUT";
    await recordAttempt(env, projectId, user.id, "REJECTED", code);
    return fail(request, env, code, parsed === "TOO_LARGE" ? 413 : 400);
  }
  if (parsed.idempotencyKey) {
    const existing = await env.DB.prepare(
      `SELECT * FROM context_snapshots WHERE project_id = ? AND created_by = ? AND idempotency_key = ?`,
    )
      .bind(projectId, user.id, parsed.idempotencyKey)
      .first<SnapshotRow>();
    if (existing) {
      const refs = await snapshotArtifacts(env, projectId, existing.id);
      if (matchesRequest(existing, refs, parsed)) {
        const verified = await verifySnapshotIntegrity(env, storage, existing);
        if (!verified) return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
        return reply(request, env, {
          snapshot: snapshotView(existing, verified.refs.length),
          idempotent: true,
        });
      }
      await recordAttempt(env, projectId, user.id, "REJECTED", "IDEMPOTENCY_CONFLICT");
      return fail(request, env, "CONFLICT", 409);
    }
  }
  const graph = await env.DB.prepare(
    `SELECT gv.* FROM graph_versions gv
     JOIN git_connections gc ON gc.project_id = gv.project_id AND gc.status = 'VERIFIED'
     JOIN repository_identities ri ON ri.id = gc.repository_identity_id
     JOIN project_repositories pr ON pr.project_id = gv.project_id AND pr.repository_identity_id = gc.repository_identity_id
     WHERE gv.project_id = ? AND gv.version = ? AND gv.status IN ('READY','SUPERSEDED')
       AND gv.source_commit_sha = ? AND gv.repository_provider = gc.provider
       AND gv.provider_repository_id = gc.provider_repository_id
       AND gv.repository_owner = ri.owner AND gv.repository_name = ri.repository_name
       AND gv.repository_canonical_url = ri.canonical_url
       AND (gv.storage_layout = 'LEGACY_V1' OR EXISTS (
         SELECT 1 FROM graph_build_attempts gba
         WHERE gba.project_id = gv.project_id AND gba.graph_version = gv.version
           AND gba.attempt = gv.published_attempt AND gba.status = 'PUBLISHED'
           AND gba.publication_id = gv.selected_publication_id AND gba.storage_key = gv.storage_key
           AND gba.lease_id = gv.published_lease_id AND gba.checksum = gv.checksum
           AND gba.byte_size = gv.byte_size AND gba.content_type = 'application/json'
           AND gba.generated_by = gv.generated_by AND gba.published_at = gv.generated_at
       ))`,
  )
    .bind(projectId, parsed.graphVersion, parsed.gitSha)
    .first<GraphRow>();
  if (!graph || !(await loadVerifiedReadyGraph(storage, graph))) {
    await recordAttempt(env, projectId, user.id, "REJECTED", "INVALID_GRAPH_REFERENCE");
    return fail(request, env, "INVALID_REFERENCE", 400);
  }
  const artifacts: ArtifactReference[] = [];
  for (const requested of parsed.artifacts) {
    const ref = await verifiedArtifact(env, storage, projectId, requested);
    if (!ref) {
      await recordAttempt(env, projectId, user.id, "REJECTED", "INVALID_ARTIFACT_REFERENCE");
      return fail(request, env, "INVALID_REFERENCE", 400);
    }
    artifacts.push(ref);
  }
  const id = crypto.randomUUID();
  const createdAt = await databaseNow(env);
  const key = `projects/${projectId}/snapshots/${id}/manifest.json`;
  const uploadId =
    graph.storage_layout === "ATTEMPT_V2"
      ? graph.selected_publication_id
      : `${graph.published_attempt}.${graph.published_lease_id}`;
  if (
    !graph.storage_key ||
    !graph.checksum ||
    graph.byte_size === null ||
    graph.published_attempt === null ||
    !graph.published_lease_id ||
    !graph.generated_by ||
    !graph.generated_at ||
    !uploadId
  ) {
    await recordAttempt(env, projectId, user.id, "REJECTED", "INVALID_GRAPH_REFERENCE");
    return fail(request, env, "INVALID_REFERENCE", 400);
  }
  const draft = {
    id,
    project_id: projectId,
    name: parsed.name,
    git_sha: parsed.gitSha,
    graph_version: graph.version,
    graph_storage_layout: graph.storage_layout,
    graph_publication_id: graph.selected_publication_id,
    graph_published_attempt: graph.published_attempt,
    graph_published_lease_id: graph.published_lease_id,
    graph_storage_key: graph.storage_key,
    graph_upload_id: uploadId,
    graph_checksum: graph.checksum,
    graph_byte_size: graph.byte_size,
    graph_content_type: MANIFEST_CONTENT_TYPE,
    graph_repository_provider: graph.repository_provider,
    graph_provider_repository_id: graph.provider_repository_id,
    graph_repository_owner: graph.repository_owner,
    graph_repository_name: graph.repository_name,
    graph_repository_canonical_url: graph.repository_canonical_url,
    graphify_version: graph.graphify_version,
    graph_adapter_version: graph.adapter_version,
    graph_profile: graph.profile,
    graph_format_version: graph.format_version,
    graph_generator: graph.generator,
    graph_generated_by: graph.generated_by,
    graph_generated_at: graph.generated_at,
    created_by: user.id,
    created_at: createdAt,
    expected_artifact_count: artifacts.length,
    idempotency_key: parsed.idempotencyKey,
    manifest_storage_key: key,
    manifest_byte_size: 0,
    manifest_checksum: "",
    manifest_content_type: MANIFEST_CONTENT_TYPE,
  } satisfies SnapshotRow;
  const bytes = manifestBytes(draft, artifacts);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    await recordAttempt(env, projectId, user.id, "REJECTED", "MANIFEST_TOO_LARGE");
    return fail(request, env, "PAYLOAD_TOO_LARGE", 413);
  }
  draft.manifest_byte_size = bytes.byteLength;
  draft.manifest_checksum = await sha256Bytes(bytes);
  const publication = await publishManifest(storage, key, bytes, draft.manifest_checksum, id);
  if (publication === "COLLISION" || publication === "FAILURE") {
    await recordAttempt(
      env,
      projectId,
      user.id,
      "FAILED",
      publication === "COLLISION" ? "STORAGE_COLLISION" : "STORAGE_FAILURE",
    );
    return fail(
      request,
      env,
      publication === "COLLISION" ? "CONFLICT" : "STORAGE_INTEGRITY_ERROR",
      publication === "COLLISION" ? 409 : 500,
    );
  }
  const statements = [
    env.DB.prepare(
      `INSERT INTO context_snapshots
       (id,project_id,name,git_sha,graph_version,graph_storage_layout,graph_publication_id,graph_published_attempt,
        graph_published_lease_id,graph_storage_key,graph_upload_id,graph_checksum,graph_byte_size,graph_content_type,
        graph_repository_provider,graph_provider_repository_id,graph_repository_owner,graph_repository_name,
        graph_repository_canonical_url,graphify_version,graph_adapter_version,graph_profile,graph_format_version,
        graph_generator,graph_generated_by,graph_generated_at,created_by,created_at,expected_artifact_count,
        idempotency_key,manifest_storage_key,manifest_byte_size,manifest_checksum,manifest_content_type)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(...Object.values(draft)),
    ...artifacts.map((ref) =>
      env.DB.prepare(
        `INSERT INTO snapshot_artifacts
       (snapshot_id,project_id,artifact_id,artifact_version,artifact_type,storage_key,upload_id,checksum,
        content_type,byte_size,source_commit_sha,change_note,version_created_by,version_created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        projectId,
        ref.artifact_id,
        ref.artifact_version,
        ref.artifact_type,
        ref.storage_key,
        ref.upload_id,
        ref.checksum,
        ref.content_type,
        ref.byte_size,
        ref.source_commit_sha,
        ref.change_note,
        ref.version_created_by,
        ref.version_created_at,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO snapshot_events (id,project_id,snapshot_id,actor_id,action,outcome,reason,created_at)
       VALUES (?,?,?,?,'snapshot-create','SUCCESS',NULL,?)`,
    ).bind(crypto.randomUUID(), projectId, id, user.id, createdAt),
  ];
  try {
    await env.DB.batch(statements);
  } catch {
    if (publication === "CREATED") await compensateCreatedManifest(env, storage, draft);
    if (parsed.idempotencyKey) {
      const existing = await env.DB.prepare(
        `SELECT * FROM context_snapshots WHERE project_id = ? AND created_by = ? AND idempotency_key = ?`,
      )
        .bind(projectId, user.id, parsed.idempotencyKey)
        .first<SnapshotRow>();
      if (existing) {
        const refs = await snapshotArtifacts(env, projectId, existing.id);
        if (matchesRequest(existing, refs, parsed)) {
          const verified = await verifySnapshotIntegrity(env, storage, existing);
          if (!verified) return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
          return reply(request, env, {
            snapshot: snapshotView(existing, verified.refs.length),
            idempotent: true,
          });
        }
        await recordAttempt(env, projectId, user.id, "REJECTED", "IDEMPOTENCY_CONFLICT");
        return fail(request, env, "CONFLICT", 409);
      }
    }
    return fail(request, env, "INTERNAL_ERROR", 500);
  }
  return reply(request, env, { snapshot: snapshotView(draft, artifacts.length) }, 201);
}

async function verifySnapshotIntegrity(
  env: SnapshotEnv,
  storage: ObjectStorage,
  row: SnapshotRow,
): Promise<{ refs: ArtifactReference[]; manifest: Uint8Array<ArrayBuffer> } | null> {
  try {
    const refs = await snapshotArtifacts(env, row.project_id, row.id);
    if (refs.length !== row.expected_artifact_count) return null;
    const graph = await env.DB.prepare(
      `SELECT gv.* FROM graph_versions gv WHERE gv.project_id = ? AND gv.version = ?
         AND gv.status IN ('READY','SUPERSEDED') AND gv.source_commit_sha = ? AND gv.storage_layout = ?
         AND gv.storage_key = ? AND gv.checksum = ? AND gv.byte_size = ? AND gv.published_attempt = ?
         AND gv.published_lease_id = ? AND gv.selected_publication_id IS ?
         AND gv.repository_provider = ? AND gv.provider_repository_id = ? AND gv.repository_owner = ?
         AND gv.repository_name = ? AND gv.repository_canonical_url = ? AND gv.graphify_version = ?
         AND gv.adapter_version = ? AND gv.profile = ? AND gv.format_version = ? AND gv.generator = ?
         AND gv.generated_by = ? AND gv.generated_at = ?
         AND (gv.storage_layout = 'LEGACY_V1' OR EXISTS (
           SELECT 1 FROM graph_build_attempts gba
           WHERE gba.project_id = gv.project_id AND gba.graph_version = gv.version
             AND gba.attempt = gv.published_attempt AND gba.status = 'PUBLISHED'
             AND gba.publication_id = gv.selected_publication_id AND gba.storage_key = gv.storage_key
             AND gba.lease_id = gv.published_lease_id AND gba.checksum = gv.checksum
             AND gba.byte_size = gv.byte_size AND gba.content_type = 'application/json'
             AND gba.generated_by = gv.generated_by AND gba.published_at = gv.generated_at
         ))`,
    )
      .bind(
        row.project_id,
        row.graph_version,
        row.git_sha,
        row.graph_storage_layout,
        row.graph_storage_key,
        row.graph_checksum,
        row.graph_byte_size,
        row.graph_published_attempt,
        row.graph_published_lease_id,
        row.graph_publication_id,
        row.graph_repository_provider,
        row.graph_provider_repository_id,
        row.graph_repository_owner,
        row.graph_repository_name,
        row.graph_repository_canonical_url,
        row.graphify_version,
        row.graph_adapter_version,
        row.graph_profile,
        row.graph_format_version,
        row.graph_generator,
        row.graph_generated_by,
        row.graph_generated_at,
      )
      .first<GraphRow>();
    if (!graph || !(await loadVerifiedReadyGraph(storage, graph))) return null;
    for (const ref of refs) {
      const current = await verifiedArtifact(
        env,
        storage,
        row.project_id,
        {
          artifactId: ref.artifact_id,
          version: ref.artifact_version,
        },
        true,
      );
      if (
        !current ||
        JSON.stringify(artifactEvidence(current)) !== JSON.stringify(artifactEvidence(ref))
      )
        return null;
    }
    const expected = manifestBytes(row, refs);
    if (
      expected.byteLength !== row.manifest_byte_size ||
      (await sha256Bytes(expected)) !== row.manifest_checksum
    )
      return null;
    const head = await storage.head(row.manifest_storage_key);
    const stored = await storage.getBytes(row.manifest_storage_key);
    if (
      !storedManifestMatches(head, expected, row.manifest_checksum, row.id) ||
      !stored ||
      !exactBytes(stored, expected) ||
      (await sha256Bytes(stored)) !== row.manifest_checksum
    )
      return null;
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { refs, manifest: stored };
  } catch {
    return null;
  }
}

async function retrieveManifest(
  request: Request,
  env: SnapshotEnv,
  storage: ObjectStorage,
  projectId: string,
  snapshotId: string,
) {
  const row = await snapshotRow(env, projectId, snapshotId);
  if (!row) return fail(request, env, "NOT_FOUND", 404);
  const verified = await verifySnapshotIntegrity(env, storage, row);
  if (!verified) return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
  const headers = responseHeaders(request, env);
  headers.set("content-type", MANIFEST_CONTENT_TYPE);
  headers.set("content-length", String(verified.manifest.byteLength));
  headers.set("x-content-sha256", row.manifest_checksum);
  headers.set("cache-control", "private, immutable");
  return new Response(verified.manifest, { status: 200, headers });
}

export async function handleSnapshotRoute(
  request: Request,
  env: SnapshotEnv,
  storage: ObjectStorage,
  user: SnapshotUser,
  projectId: string,
  snapshotId?: string,
  retrieve = false,
): Promise<Response> {
  if (!ID.test(projectId) || (snapshotId !== undefined && !ID.test(snapshotId)))
    return fail(request, env, "INVALID_INPUT", 400);
  const role = await membership(env, projectId, user.id);
  if (!role) return fail(request, env, "NOT_FOUND", 404);
  if (request.method === "POST") {
    if (role === "VIEWER") return fail(request, env, "FORBIDDEN", 403);
    if (request.headers.get("origin") !== env.WEB_ORIGIN)
      return fail(request, env, "ORIGIN_NOT_ALLOWED", 403);
  }
  if (!snapshotId)
    return request.method === "POST"
      ? createSnapshot(request, env, storage, projectId, user)
      : listSnapshots(request, env, storage, projectId);
  return retrieve
    ? retrieveManifest(request, env, storage, projectId, snapshotId)
    : inspectSnapshot(request, env, storage, projectId, snapshotId);
}
