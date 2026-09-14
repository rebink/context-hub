import { classifyArtifactFreshness } from "./artifact-freshness.js";
import { readBoundedJsonObject } from "./bounded-json.js";
import type { ObjectStorage } from "./object-storage.js";
import { sha256Bytes } from "./security.js";

export type ArtifactUser = { id: string };
export type ArtifactEnv = { DB: D1Database; WEB_ORIGIN?: string };

const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 6 * MAX_CONTENT_BYTES + 64 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const TYPES = new Set([
  "architecture",
  "adr",
  "api-contract",
  "coding-convention",
  "domain-knowledge",
  "glossary",
  "database-schema",
  "runbook",
  "deployment-guide",
  "ownership",
  "security-rule",
  "product-requirement",
  "custom",
]);
const CONTENT_TYPES = new Set([
  "text/markdown",
  "text/plain",
  "application/json",
  "application/yaml",
  "text/yaml",
  "application/x-yaml",
]);
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

type Member = { role: "ADMIN" | "EDITOR" | "VIEWER" };
type FreshnessColumns = {
  source_commit_sha: string | null;
  current_repository_commit_sha: string | null;
  repository_connection_status: string | null;
};
type ArtifactRow = FreshnessColumns & {
  id: string;
  project_id: string;
  type: string;
  name: string;
  description: string | null;
  current_version: number;
  status: string;
  lifecycle_revision: number;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type VersionRow = FreshnessColumns & {
  artifact_id: string;
  version: number;
  storage_key: string;
  checksum: string;
  content_type: string;
  byte_size: number;
  change_note: string | null;
  created_by: string;
  created_at: string;
};

function headers(request: Request, env: ArtifactEnv): Headers {
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
  env: ArtifactEnv,
  value: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(value, { status, headers: headers(request, env) });
}

function fail(request: Request, env: ArtifactEnv, code: string, status: number): Response {
  return reply(request, env, { error: code }, status);
}

function freshness(row: FreshnessColumns) {
  const repositoryStatus =
    row.repository_connection_status === "VERIFIED"
      ? "VERIFIED"
      : row.repository_connection_status === "ERROR"
        ? "UNVERIFIED"
        : "DISCONNECTED";
  const currentRepositoryCommitSha =
    repositoryStatus === "VERIFIED" ? row.current_repository_commit_sha : null;
  return {
    state: classifyArtifactFreshness(row.source_commit_sha, currentRepositoryCommitSha),
    artifactSourceCommitSha: row.source_commit_sha,
    currentRepositoryCommitSha,
    repositoryStatus,
  };
}

function mapArtifact(row: ArtifactRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    name: row.name,
    description: row.description,
    currentVersion: row.current_version,
    status: row.status,
    lifecycleRevision: row.lifecycle_revision,
    archivedAt: row.archived_at,
    archivedBy: row.archived_by,
    archiveReason: row.archive_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    freshness: freshness(row),
  };
}

function mapVersion(row: VersionRow) {
  return {
    artifactId: row.artifact_id,
    version: row.version,
    checksum: row.checksum,
    contentType: row.content_type,
    byteSize: row.byte_size,
    sourceCommitSha: row.source_commit_sha,
    changeNote: row.change_note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    freshness: freshness(row),
  };
}

function parseLimit(url: URL): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_LIMIT ? value : null;
}

function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify([createdAt, id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(value: string | null): [string, string] | null | undefined {
  if (value === null) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed: unknown = JSON.parse(atob(base64));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      ID_PATTERN.test(parsed[1])
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Invalid cursors are handled as ordinary input errors.
  }
  return undefined;
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function parseUpload(
  request: Request,
  includeArtifactFields: boolean,
): Promise<
  | {
      contentType: string;
      content: string;
      bytes: Uint8Array<ArrayBuffer>;
      sourceCommitSha: string | null;
      changeNote: string | null;
      name?: string;
      type?: string;
      description?: string | null;
      expectedVersion?: number;
    }
  | "INVALID_INPUT"
  | "PAYLOAD_TOO_LARGE"
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && !/^\d+$/.test(declaredLength)) return "INVALID_INPUT";
  if (declaredLength && Number(declaredLength) > MAX_REQUEST_BYTES) return "PAYLOAD_TOO_LARGE";
  if (
    request.headers.get("content-type")?.toLowerCase().split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    return "INVALID_INPUT";
  }
  let body: unknown;
  try {
    const requestBytes = await readBoundedBody(request);
    if (!requestBytes) return "PAYLOAD_TOO_LARGE";
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes));
  } catch {
    return "INVALID_INPUT";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return "INVALID_INPUT";
  const value = body as Record<string, unknown>;
  if (typeof value.content !== "string" || typeof value.contentType !== "string") {
    return "INVALID_INPUT";
  }
  const contentType = value.contentType.toLowerCase().replace(/\s+/g, "");
  const [mediaType, ...parameters] = contentType.split(";");
  if (
    !mediaType ||
    !CONTENT_TYPES.has(mediaType) ||
    parameters.some((parameter) => parameter !== "charset=utf-8")
  ) {
    return "INVALID_INPUT";
  }
  const bytes = new TextEncoder().encode(value.content);
  if (bytes.byteLength > MAX_CONTENT_BYTES) return "PAYLOAD_TOO_LARGE";
  if (mediaType === "application/json") {
    try {
      JSON.parse(value.content);
    } catch {
      return "INVALID_INPUT";
    }
  }
  const optional = (key: string, max: number): string | null | undefined => {
    const field = value[key];
    if (field === undefined || field === null) return null;
    if (typeof field !== "string" || field.trim().length > max) return undefined;
    return field.trim() || null;
  };
  const sourceCommitSha = optional("sourceCommitSha", 64);
  const changeNote = optional("changeNote", 500);
  if (
    sourceCommitSha === undefined ||
    (sourceCommitSha !== null && !/^[0-9a-f]{7,64}$/i.test(sourceCommitSha)) ||
    changeNote === undefined
  ) {
    return "INVALID_INPUT";
  }
  const common = {
    contentType,
    content: value.content,
    bytes,
    sourceCommitSha: sourceCommitSha?.toLowerCase() ?? null,
    changeNote,
  };
  if (includeArtifactFields) {
    const name = optional("name", 200);
    const description = optional("description", 2000);
    if (
      !name ||
      description === undefined ||
      typeof value.type !== "string" ||
      !TYPES.has(value.type)
    ) {
      return "INVALID_INPUT";
    }
    return { ...common, name, type: value.type, description };
  }
  if (
    !Number.isSafeInteger(value.expectedVersion) ||
    (value.expectedVersion as number) < 1 ||
    (value.expectedVersion as number) >= Number.MAX_SAFE_INTEGER
  ) {
    return "INVALID_INPUT";
  }
  return { ...common, expectedVersion: value.expectedVersion as number };
}

async function member(env: ArtifactEnv, projectId: string, userId: string): Promise<Member | null> {
  return (
    (await env.DB.prepare(
      `SELECT pm.role FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       WHERE pm.project_id = ? AND pm.user_id = ? AND p.status='ACTIVE'`,
    )
      .bind(projectId, userId)
      .first<Member>()) ?? null
  );
}

async function artifact(
  env: ArtifactEnv,
  projectId: string,
  artifactId: string,
): Promise<ArtifactRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT a.id, a.project_id, a.type, a.name, a.description, a.current_version, a.status,
              a.lifecycle_revision,a.archived_at,a.archived_by,a.archive_reason,
              a.created_by, a.created_at, a.updated_at, av.source_commit_sha,
              CASE WHEN gc.status='VERIFIED' THEN gc.last_known_commit_sha ELSE NULL END AS current_repository_commit_sha,
              gc.status AS repository_connection_status
       FROM artifacts a
       JOIN artifact_versions av ON av.artifact_id=a.id AND av.version=a.current_version
       LEFT JOIN git_connections gc ON gc.project_id=a.project_id
       WHERE a.project_id = ? AND a.id = ?`,
    )
      .bind(projectId, artifactId)
      .first<ArtifactRow>()) ?? null
  );
}

async function compensate(
  env: ArtifactEnv,
  storage: ObjectStorage,
  projectId: string,
  artifactId: string,
  version: number,
  key: string,
): Promise<void> {
  try {
    const published = await env.DB.prepare(
      `SELECT av.storage_key FROM artifact_versions av
       JOIN artifacts a ON a.id = av.artifact_id
       WHERE a.project_id = ? AND av.artifact_id = ? AND av.version = ? AND av.storage_key = ?`,
    )
      .bind(projectId, artifactId, version, key)
      .first<{ storage_key: string }>();
    if (!published) await storage.compensationDelete(key);
  } catch {
    // An orphan is safer than deleting data whose publication status is unknown.
  }
}

async function storedObjectMatches(
  storage: ObjectStorage,
  key: string,
  byteSize: number,
  contentType: string,
  checksum: string,
  uploadId: string,
): Promise<boolean> {
  try {
    const existing = await storage.head(key);
    return Boolean(
      existing &&
        existing.byteSize === byteSize &&
        existing.httpContentType === contentType &&
        existing.metadata.contentType === contentType &&
        existing.metadata.checksum === checksum &&
        existing.metadata.uploadId === uploadId,
    );
  } catch {
    return false;
  }
}

async function putImmutable(
  storage: ObjectStorage,
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  checksum: string,
): Promise<"stored" | "collision" | "failure"> {
  // ponytail: crashed uploads can orphan a key; add grace-period cleanup if this occurs in practice.
  const uploadId = crypto.randomUUID();
  try {
    const result = await storage.createOnly(key, bytes, { checksum, contentType, uploadId });
    if (result === "created") return "stored";
    return (await storedObjectMatches(
      storage,
      key,
      bytes.byteLength,
      contentType,
      checksum,
      uploadId,
    ))
      ? "stored"
      : "collision";
  } catch {
    return (await storedObjectMatches(
      storage,
      key,
      bytes.byteLength,
      contentType,
      checksum,
      uploadId,
    ))
      ? "stored"
      : "failure";
  }
}

async function listArtifacts(request: Request, env: ArtifactEnv, projectId: string) {
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const type = url.searchParams.get("type");
  if (limit === null || cursor === undefined || (type !== null && !TYPES.has(type))) {
    return fail(request, env, "INVALID_INPUT", 400);
  }
  const cursorAt = cursor?.[0] ?? null;
  const cursorId = cursor?.[1] ?? null;
  const result = await env.DB.prepare(
    `SELECT a.id, a.project_id, a.type, a.name, a.description, a.current_version, a.status,
            a.lifecycle_revision,a.archived_at,a.archived_by,a.archive_reason,
            a.created_by, a.created_at, a.updated_at, av.source_commit_sha,
            CASE WHEN gc.status='VERIFIED' THEN gc.last_known_commit_sha ELSE NULL END AS current_repository_commit_sha,
            gc.status AS repository_connection_status
     FROM artifacts a
     JOIN artifact_versions av ON av.artifact_id=a.id AND av.version=a.current_version
     LEFT JOIN git_connections gc ON gc.project_id=a.project_id
     WHERE a.project_id = ? AND a.status='ACTIVE' AND (? IS NULL OR a.type = ?)
       AND (? IS NULL OR a.created_at < ? OR (a.created_at = ? AND a.id < ?))
     ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
  )
    .bind(projectId, type, type, cursorAt, cursorAt, cursorAt, cursorId, limit + 1)
    .all<ArtifactRow>();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return reply(request, env, {
    artifacts: rows.map(mapArtifact),
    nextCursor:
      result.results.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  });
}

async function createArtifact(
  request: Request,
  env: ArtifactEnv,
  storage: ObjectStorage,
  projectId: string,
  user: ArtifactUser,
) {
  const parsed = await parseUpload(request, true);
  if (typeof parsed === "string") {
    return fail(request, env, parsed, parsed === "PAYLOAD_TOO_LARGE" ? 413 : 400);
  }
  const artifactId = crypto.randomUUID();
  const key = `projects/${projectId}/artifacts/${artifactId}/v/1/content`;
  const checksum = await sha256Bytes(parsed.bytes);
  const stored = await putImmutable(storage, key, parsed.bytes, parsed.contentType, checksum);
  if (stored === "collision") return fail(request, env, "CONFLICT", 409);
  if (stored === "failure") return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO artifacts
         (id, project_id, type, name, description, current_version, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', ?, ?, ?)`,
      ).bind(
        artifactId,
        projectId,
        parsed.type,
        parsed.name,
        parsed.description,
        user.id,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO artifact_versions
         (artifact_id, version, storage_key, checksum, content_type, byte_size,
          source_commit_sha, change_note, created_by, created_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        artifactId,
        key,
        checksum,
        parsed.contentType,
        parsed.bytes.byteLength,
        parsed.sourceCommitSha,
        parsed.changeNote,
        user.id,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
         (id, project_id, artifact_id, artifact_version, event_type, actor_id, created_at)
         VALUES (?, ?, ?, 1, 'artifact-created', ?, ?)`,
      ).bind(crypto.randomUUID(), projectId, artifactId, user.id, now),
      env.DB.prepare(
        `INSERT INTO audit_events
         (id, project_id, artifact_id, artifact_version, event_type, actor_id, created_at)
         VALUES (?, ?, ?, 1, 'version-created', ?, ?)`,
      ).bind(crypto.randomUUID(), projectId, artifactId, user.id, now),
    ]);
  } catch (cause) {
    await compensate(env, storage, projectId, artifactId, 1, key);
    throw cause;
  }
  const created = await artifact(env, projectId, artifactId);
  return reply(
    request,
    env,
    { artifact: created && mapArtifact(created), version: 1, checksum },
    201,
  );
}

async function listVersions(
  request: Request,
  env: ArtifactEnv,
  projectId: string,
  artifactId: string,
) {
  const url = new URL(request.url);
  const limit = parseLimit(url);
  const rawCursor = url.searchParams.get("cursor");
  const cursor =
    rawCursor === null ? null : /^\d+$/.test(rawCursor) ? Number(rawCursor) : undefined;
  if (
    limit === null ||
    cursor === undefined ||
    (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1))
  ) {
    return fail(request, env, "INVALID_INPUT", 400);
  }
  const result = await env.DB.prepare(
    `SELECT av.artifact_id, av.version, av.storage_key, av.checksum, av.content_type, av.byte_size,
            av.source_commit_sha, av.change_note, av.created_by, av.created_at,
            CASE WHEN gc.status='VERIFIED' THEN gc.last_known_commit_sha ELSE NULL END AS current_repository_commit_sha,
            gc.status AS repository_connection_status
     FROM artifact_versions av JOIN artifacts a ON a.id = av.artifact_id
     LEFT JOIN git_connections gc ON gc.project_id=a.project_id
     WHERE a.project_id = ? AND av.artifact_id = ? AND (? IS NULL OR av.version < ?)
     ORDER BY av.version DESC LIMIT ?`,
  )
    .bind(projectId, artifactId, cursor, cursor, limit + 1)
    .all<VersionRow>();
  const rows = result.results.slice(0, limit);
  return reply(request, env, {
    versions: rows.map(mapVersion),
    nextCursor: result.results.length > limit ? String(rows.at(-1)?.version) : null,
  });
}

async function createVersion(
  request: Request,
  env: ArtifactEnv,
  storage: ObjectStorage,
  projectId: string,
  current: ArtifactRow,
  user: ArtifactUser,
) {
  const parsed = await parseUpload(request, false);
  if (typeof parsed === "string") {
    return fail(request, env, parsed, parsed === "PAYLOAD_TOO_LARGE" ? 413 : 400);
  }
  if (parsed.expectedVersion !== current.current_version) {
    return reply(request, env, { error: "CONFLICT", currentVersion: current.current_version }, 409);
  }
  const version = parsed.expectedVersion + 1;
  const key = `projects/${projectId}/artifacts/${current.id}/v/${version}/content`;
  const checksum = await sha256Bytes(parsed.bytes);
  const stored = await putImmutable(storage, key, parsed.bytes, parsed.contentType, checksum);
  if (stored !== "stored") {
    if (stored === "failure") return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
    const latest = await artifact(env, projectId, current.id);
    return reply(
      request,
      env,
      { error: "CONFLICT", currentVersion: latest?.current_version ?? current.current_version },
      409,
    );
  }
  const now = new Date().toISOString();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO artifact_versions
         (artifact_id, version, storage_key, checksum, content_type, byte_size,
          source_commit_sha, change_note, created_by, created_at)
         SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM artifacts
         WHERE id = ? AND project_id = ? AND status='ACTIVE' AND current_version = ?
           AND EXISTS(SELECT 1 FROM projects p JOIN project_members pm ON pm.project_id=p.id
             WHERE p.id=artifacts.project_id AND p.status='ACTIVE' AND pm.user_id=? AND pm.role IN ('ADMIN','EDITOR'))`,
      ).bind(
        version,
        key,
        checksum,
        parsed.contentType,
        parsed.bytes.byteLength,
        parsed.sourceCommitSha,
        parsed.changeNote,
        user.id,
        now,
        current.id,
        projectId,
        parsed.expectedVersion,
        user.id,
      ),
      env.DB.prepare(
        `UPDATE artifacts SET current_version = ?, updated_at = ?
         WHERE id = ? AND project_id = ? AND status='ACTIVE' AND current_version = ?
           AND EXISTS(SELECT 1 FROM projects p JOIN project_members pm ON pm.project_id=p.id
             WHERE p.id=artifacts.project_id AND p.status='ACTIVE' AND pm.user_id=? AND pm.role IN ('ADMIN','EDITOR'))`,
      ).bind(version, now, current.id, projectId, parsed.expectedVersion, user.id),
      env.DB.prepare(
        `INSERT INTO audit_events
         (id, project_id, artifact_id, artifact_version, event_type, actor_id, created_at)
         SELECT ?, ?, ?, ?, 'version-created', ?, ?
         WHERE changes() = 1 AND EXISTS (
           SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND version = ? AND storage_key = ?
         )`,
      ).bind(
        crypto.randomUUID(),
        projectId,
        current.id,
        version,
        user.id,
        now,
        current.id,
        version,
        key,
      ),
    ]);
    const changes = Number(results[0]?.meta?.changes ?? 0);
    if (changes !== 1) {
      await compensate(env, storage, projectId, current.id, version, key);
      const latest = await artifact(env, projectId, current.id);
      return reply(
        request,
        env,
        { error: "CONFLICT", currentVersion: latest?.current_version ?? current.current_version },
        409,
      );
    }
  } catch (cause) {
    await compensate(env, storage, projectId, current.id, version, key);
    throw cause;
  }
  return reply(
    request,
    env,
    {
      version: {
        ...mapVersion({
          artifact_id: current.id,
          version,
          storage_key: key,
          checksum,
          content_type: parsed.contentType,
          byte_size: parsed.bytes.byteLength,
          source_commit_sha: parsed.sourceCommitSha,
          change_note: parsed.changeNote,
          created_by: user.id,
          created_at: now,
          current_repository_commit_sha: current.current_repository_commit_sha,
          repository_connection_status: current.repository_connection_status,
        }),
      },
    },
    201,
  );
}

async function readVersion(
  request: Request,
  env: ArtifactEnv,
  storage: ObjectStorage,
  projectId: string,
  artifactId: string,
  version: number,
) {
  const row = await env.DB.prepare(
    `SELECT av.artifact_id, av.version, av.storage_key, av.checksum, av.content_type, av.byte_size,
            av.source_commit_sha, av.change_note, av.created_by, av.created_at,
            CASE WHEN gc.status='VERIFIED' THEN gc.last_known_commit_sha ELSE NULL END AS current_repository_commit_sha,
            gc.status AS repository_connection_status
     FROM artifact_versions av JOIN artifacts a ON a.id = av.artifact_id
     LEFT JOIN git_connections gc ON gc.project_id=a.project_id
     WHERE a.project_id = ? AND av.artifact_id = ? AND av.version = ?`,
  )
    .bind(projectId, artifactId, version)
    .first<VersionRow>();
  if (!row) return fail(request, env, "NOT_FOUND", 404);
  try {
    const bytes = await storage.getBytes(row.storage_key);
    if (!bytes) return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
    if (bytes.byteLength !== row.byte_size || (await sha256Bytes(bytes)) !== row.checksum) {
      return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return reply(request, env, { version: mapVersion(row), content });
  } catch {
    return fail(request, env, "STORAGE_INTEGRITY_ERROR", 500);
  }
}

function isArchiveConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("invalid artifact archive transition");
}

async function archiveConflict(
  request: Request,
  env: ArtifactEnv,
  projectId: string,
  current: ArtifactRow,
): Promise<Response> {
  const latest = await artifact(env, projectId, current.id);
  return reply(
    request,
    env,
    {
      error: "CONFLICT",
      currentVersion: latest?.current_version ?? current.current_version,
      currentRevision: latest?.lifecycle_revision ?? current.lifecycle_revision,
      currentStatus: latest?.status ?? current.status,
    },
    409,
  );
}

async function archiveArtifact(
  request: Request,
  env: ArtifactEnv,
  projectId: string,
  current: ArtifactRow,
  user: ArtifactUser,
): Promise<Response> {
  const parsed = await readBoundedJsonObject(request, 2 * 1024);
  if (!parsed.ok) {
    const status =
      parsed.error === "UNSUPPORTED_MEDIA_TYPE"
        ? 415
        : parsed.error === "PAYLOAD_TOO_LARGE"
          ? 413
          : 400;
    return fail(request, env, parsed.error, status);
  }
  const keys = Object.keys(parsed.value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "expectedRevision" ||
    keys[1] !== "expectedVersion" ||
    keys[2] !== "reason"
  ) {
    return fail(request, env, "INVALID_INPUT", 400);
  }
  const expectedVersion = parsed.value.expectedVersion;
  const expectedRevision = parsed.value.expectedRevision;
  const reasonValue = parsed.value.reason;
  const reason = typeof reasonValue === "string" ? reasonValue.trim() : "";
  if (
    !Number.isInteger(expectedVersion) ||
    Number(expectedVersion) < 1 ||
    Number(expectedVersion) > 2_147_483_647 ||
    !Number.isInteger(expectedRevision) ||
    Number(expectedRevision) < 1 ||
    Number(expectedRevision) >= 2_147_483_647 ||
    reason.length < 1 ||
    reason.length > 500
  ) {
    return fail(request, env, "INVALID_INPUT", 400);
  }
  if (
    current.status !== "ACTIVE" ||
    current.current_version !== expectedVersion ||
    current.lifecycle_revision !== expectedRevision
  ) {
    return reply(
      request,
      env,
      {
        error: "CONFLICT",
        currentVersion: current.current_version,
        currentRevision: current.lifecycle_revision,
        currentStatus: current.status,
      },
      409,
    );
  }
  let archived: { lifecycle_revision: number; archived_at: string } | null;
  try {
    archived = await env.DB.prepare(
      `UPDATE artifacts SET status='ARCHIVED',lifecycle_revision=lifecycle_revision+1,
         archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),archived_by=?,archive_reason=?,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=? AND project_id=? AND status='ACTIVE' AND current_version=? AND lifecycle_revision=?
         AND EXISTS(SELECT 1 FROM projects p JOIN project_members admin ON admin.project_id=p.id
           WHERE p.id=artifacts.project_id AND p.status='ACTIVE' AND admin.user_id=? AND admin.role='ADMIN')
       RETURNING lifecycle_revision,archived_at`,
    )
      .bind(user.id, reason, current.id, projectId, expectedVersion, expectedRevision, user.id)
      .first();
  } catch (error) {
    if (!isArchiveConflict(error)) throw error;
    return archiveConflict(request, env, projectId, current);
  }
  if (!archived) return archiveConflict(request, env, projectId, current);
  return reply(request, env, {
    artifact: {
      ...mapArtifact(current),
      status: "ARCHIVED",
      lifecycleRevision: archived.lifecycle_revision,
      archivedAt: archived.archived_at,
      archivedBy: user.id,
      archiveReason: reason,
      updatedAt: archived.archived_at,
    },
  });
}

export async function handleArtifactRoute(
  request: Request,
  env: ArtifactEnv,
  storage: ObjectStorage,
  user: ArtifactUser,
  projectId: string,
  artifactId?: string,
  versionSegment?: string,
): Promise<Response> {
  if (!ID_PATTERN.test(projectId) || (artifactId !== undefined && !ID_PATTERN.test(artifactId))) {
    return fail(request, env, "INVALID_INPUT", 400);
  }
  const membership = await member(env, projectId, user.id);
  if (!membership) return fail(request, env, "NOT_FOUND", 404);
  const mutation = request.method === "POST" || request.method === "DELETE";
  if (request.method === "DELETE" && membership.role !== "ADMIN")
    return fail(request, env, "FORBIDDEN", 403);
  if (request.method === "POST" && membership.role === "VIEWER")
    return fail(request, env, "FORBIDDEN", 403);
  if (mutation && request.headers.get("origin") !== env.WEB_ORIGIN) {
    return fail(request, env, "ORIGIN_NOT_ALLOWED", 403);
  }
  if (!artifactId) {
    return request.method === "GET"
      ? listArtifacts(request, env, projectId)
      : createArtifact(request, env, storage, projectId, user);
  }
  const current = await artifact(env, projectId, artifactId);
  if (!current) return fail(request, env, "NOT_FOUND", 404);
  if (versionSegment !== undefined) {
    const version = /^\d+$/.test(versionSegment) ? Number(versionSegment) : Number.NaN;
    if (!Number.isSafeInteger(version) || version < 1) {
      return fail(request, env, "INVALID_INPUT", 400);
    }
    return readVersion(request, env, storage, projectId, artifactId, version);
  }
  if (new URL(request.url).pathname.endsWith("/versions")) {
    return request.method === "GET"
      ? listVersions(request, env, projectId, artifactId)
      : createVersion(request, env, storage, projectId, current, user);
  }
  if (request.method === "DELETE") return archiveArtifact(request, env, projectId, current, user);
  if (current.status !== "ACTIVE") return fail(request, env, "NOT_FOUND", 404);
  return reply(request, env, { artifact: mapArtifact(current) });
}
