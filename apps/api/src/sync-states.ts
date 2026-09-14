import { sha256 } from "./security.js";

export type SyncStateEnv = { DB: D1Database; WEB_ORIGIN?: string };
export type SyncStateUser = { id: string };

type SyncRow = {
  project_id: string;
  principal_id: string;
  client_id: string;
  client_kind: "CONTEXT_CLI";
  client_version: string;
  observation_sequence: number;
  repository_provider: string;
  provider_repository_id: string;
  repository_canonical_url: string;
  local_git_sha: string;
  local_graph_version: number | null;
  local_graph_attempt: number | null;
  local_graph_checksum: string | null;
  local_graph_source_commit_sha: string | null;
  remote_git_sha: string | null;
  remote_graph_version: number | null;
  remote_graph_attempt: number | null;
  remote_graph_checksum: string | null;
  remote_graph_source_commit_sha: string | null;
  remote_graph_status: string | null;
  sync_status: string;
  report_outcome: string;
  failure_code: string | null;
  last_sync_at: string | null;
  last_seen_at: string;
  created_at: string;
};

const ID = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const STATES = new Set([
  "CURRENT",
  "GRAPH_STALE",
  "LOCAL_REPOSITORY_AHEAD",
  "REMOTE_GRAPH_AHEAD",
  "NO_LOCAL_GRAPH",
  "GRAPH_BUILDING",
  "GRAPH_FAILED",
  "COMMIT_MISMATCH",
]);
const OUTCOMES = new Set(["STATUS", "SYNC_SUCCEEDED", "SYNC_FAILED"]);

function response(
  request: Request,
  env: SyncStateEnv,
  value: Record<string, unknown>,
  status = 200,
) {
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
  return Response.json(value, { status, headers });
}

function fail(request: Request, env: SyncStateEnv, code: string, status: number) {
  return response(request, env, { error: code }, status);
}

function mapRow(row: SyncRow) {
  return {
    projectId: row.project_id,
    clientId: row.client_id,
    clientKind: row.client_kind,
    clientVersion: row.client_version,
    observationSequence: row.observation_sequence,
    repository: {
      provider: row.repository_provider,
      providerRepositoryId: row.provider_repository_id,
      canonicalUrl: row.repository_canonical_url,
    },
    local: {
      gitSha: row.local_git_sha,
      graph:
        row.local_graph_version === null
          ? null
          : {
              version: row.local_graph_version,
              attempt: row.local_graph_attempt,
              checksum: row.local_graph_checksum,
              sourceCommitSha: row.local_graph_source_commit_sha,
            },
    },
    remote: {
      gitSha: row.remote_git_sha,
      graph:
        row.remote_graph_version === null
          ? null
          : {
              version: row.remote_graph_version,
              attempt: row.remote_graph_attempt,
              checksum: row.remote_graph_checksum,
              sourceCommitSha: row.remote_graph_source_commit_sha,
              status: row.remote_graph_status,
            },
    },
    status: row.sync_status,
    reportOutcome: row.report_outcome,
    failureCode: row.failure_code,
    lastSyncAt: row.last_sync_at,
    lastSeenAt: row.last_seen_at,
  };
}

async function boundedBody(request: Request): Promise<Record<string, unknown> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") return null;
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 4096) {
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
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function nullable<T>(value: unknown, predicate: (item: unknown) => item is T): value is T | null {
  return value === null || predicate(value);
}
const isSha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);
const isChecksum = (value: unknown): value is string =>
  typeof value === "string" && CHECKSUM.test(value);
const isInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2147483647;

function parseReport(value: Record<string, unknown>) {
  const keys = [
    "clientId",
    "clientKind",
    "clientVersion",
    "observationSequence",
    "repository",
    "localGitSha",
    "localGraphVersion",
    "localGraphAttempt",
    "localGraphChecksum",
    "localGraphSourceCommitSha",
    "remoteGitSha",
    "remoteGraphVersion",
    "remoteGraphAttempt",
    "remoteGraphChecksum",
    "remoteGraphSourceCommitSha",
    "remoteGraphStatus",
    "status",
    "reportOutcome",
    "failureCode",
  ];
  if (!exactKeys(value, keys)) return null;
  const repository = value.repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) return null;
  const repo = repository as Record<string, unknown>;
  if (!exactKeys(repo, ["provider", "providerRepositoryId", "canonicalUrl"])) return null;
  const localNull =
    value.localGraphVersion === null &&
    value.localGraphAttempt === null &&
    value.localGraphChecksum === null &&
    value.localGraphSourceCommitSha === null;
  const localFull =
    isInteger(value.localGraphVersion) &&
    isInteger(value.localGraphAttempt) &&
    isChecksum(value.localGraphChecksum) &&
    isSha(value.localGraphSourceCommitSha);
  const remoteNull =
    value.remoteGraphVersion === null &&
    value.remoteGraphAttempt === null &&
    value.remoteGraphChecksum === null &&
    value.remoteGraphSourceCommitSha === null &&
    value.remoteGraphStatus === null;
  const remoteFull =
    isInteger(value.remoteGraphVersion) &&
    isInteger(value.remoteGraphAttempt) &&
    isChecksum(value.remoteGraphChecksum) &&
    isSha(value.remoteGraphSourceCommitSha) &&
    value.remoteGraphStatus === "READY";
  if (
    typeof value.clientId !== "string" ||
    !UUID.test(value.clientId) ||
    value.clientKind !== "CONTEXT_CLI" ||
    typeof value.clientVersion !== "string" ||
    !VERSION.test(value.clientVersion) ||
    !isInteger(value.observationSequence) ||
    repo.provider !== "github" ||
    typeof repo.providerRepositoryId !== "string" ||
    repo.providerRepositoryId.length < 1 ||
    repo.providerRepositoryId.length > 255 ||
    typeof repo.canonicalUrl !== "string" ||
    !/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.canonicalUrl) ||
    !isSha(value.localGitSha) ||
    (!localNull && !localFull) ||
    !isSha(value.remoteGitSha) ||
    (!remoteNull && !remoteFull) ||
    typeof value.status !== "string" ||
    !STATES.has(value.status) ||
    typeof value.reportOutcome !== "string" ||
    !OUTCOMES.has(value.reportOutcome) ||
    !nullable(
      value.failureCode,
      (item): item is string => typeof item === "string" && CODE.test(item),
    ) ||
    (value.reportOutcome === "SYNC_FAILED") !== (value.failureCode !== null)
  )
    return null;
  return value as {
    clientId: string;
    clientKind: string;
    clientVersion: string;
    observationSequence: number;
    repository: { provider: string; providerRepositoryId: string; canonicalUrl: string };
    localGitSha: string;
    localGraphVersion: number | null;
    localGraphAttempt: number | null;
    localGraphChecksum: string | null;
    localGraphSourceCommitSha: string | null;
    remoteGitSha: string;
    remoteGraphVersion: number | null;
    remoteGraphAttempt: number | null;
    remoteGraphChecksum: string | null;
    remoteGraphSourceCommitSha: string | null;
    remoteGraphStatus: string | null;
    status: string;
    reportOutcome: string;
    failureCode: string | null;
  };
}

async function localCredential(request: Request) {
  if (request.headers.has("cookie") || request.headers.has("origin")) return null;
  const match = /^Bearer chmcp_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1] && match[2]
    ? { credentialId: match[1], secretHash: await sha256(match[2]) }
    : null;
}

async function canRead(env: SyncStateEnv, projectId: string, userId: string) {
  return env.DB.prepare(
    `SELECT p.id FROM projects p
     JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
     JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=?
     JOIN git_connections gc ON gc.project_id=p.id AND gc.status='VERIFIED'
     JOIN repository_identities ri ON ri.id=gc.repository_identity_id
     JOIN project_repositories pr ON pr.project_id=p.id AND pr.repository_identity_id=ri.id
     WHERE p.id=? AND p.status='ACTIVE'`,
  )
    .bind(userId, userId, projectId)
    .first<{ id: string }>();
}

export async function handleSyncStateRead(
  request: Request,
  env: SyncStateEnv,
  user: SyncStateUser,
  projectId: string,
  current: boolean,
) {
  if (!ID.test(projectId)) return fail(request, env, "INVALID_INPUT", 400);
  if (!(await canRead(env, projectId, user.id))) return fail(request, env, "NOT_FOUND", 404);
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit") ?? "20";
  if (
    !/^\d+$/.test(rawLimit) ||
    Number(rawLimit) < 1 ||
    Number(rawLimit) > 50 ||
    (current && url.searchParams.has("cursor"))
  )
    return fail(request, env, "INVALID_INPUT", 400);
  const limit = current ? 1 : Number(rawLimit);
  const cursor = url.searchParams.get("cursor");
  let decoded: [string, string, string] | null = null;
  if (cursor) {
    try {
      const parsed: unknown = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 3 ||
        parsed.some((item) => typeof item !== "string" || item.length > 128)
      )
        throw new Error();
      decoded = parsed as [string, string, string];
    } catch {
      return fail(request, env, "INVALID_INPUT", 400);
    }
  }
  const rows = await env.DB.prepare(
    `SELECT ss.* FROM sync_states ss
     JOIN git_connections gc ON gc.project_id=ss.project_id AND gc.status='VERIFIED'
     JOIN repository_identities ri ON ri.id=gc.repository_identity_id
     WHERE ss.project_id=? AND ss.repository_provider=gc.provider
       AND ss.provider_repository_id=gc.provider_repository_id AND ss.repository_canonical_url=ri.canonical_url
       AND (? IS NULL OR ss.last_seen_at<? OR (ss.last_seen_at=? AND ss.principal_id<?) OR (ss.last_seen_at=? AND ss.principal_id=? AND ss.client_id<?))
     ORDER BY ss.last_seen_at DESC,ss.principal_id DESC,ss.client_id DESC LIMIT ?`,
  )
    .bind(
      projectId,
      decoded?.[0] ?? null,
      decoded?.[0] ?? null,
      decoded?.[0] ?? null,
      decoded?.[1] ?? null,
      decoded?.[0] ?? null,
      decoded?.[1] ?? null,
      decoded?.[2] ?? null,
      limit + 1,
    )
    .all<SyncRow>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.results.length > limit && last
      ? btoa(JSON.stringify([last.last_seen_at, last.principal_id, last.client_id]))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replace(/=+$/, "")
      : null;
  return response(
    request,
    env,
    current
      ? { syncState: page[0] ? mapRow(page[0]) : null }
      : { syncStates: page.map(mapRow), nextCursor },
  );
}

type SyncTruth = {
  remote_git_sha: string;
  remote_graph_version: number | null;
  remote_graph_attempt: number | null;
  remote_graph_checksum: string | null;
  remote_graph_source_commit_sha: string | null;
  newest_graph_status: string | null;
};

async function syncTruth(
  env: SyncStateEnv,
  projectId: string,
  report: NonNullable<ReturnType<typeof parseReport>>,
) {
  const truth = await env.DB.prepare(
    `SELECT gc.last_known_commit_sha AS remote_git_sha,ready.version AS remote_graph_version,
       ready.published_attempt AS remote_graph_attempt,ready.checksum AS remote_graph_checksum,
       ready.source_commit_sha AS remote_graph_source_commit_sha,
       (SELECT newest.status FROM graph_versions newest
        WHERE newest.project_id=p.id AND newest.repository_provider=gc.provider
          AND newest.provider_repository_id=gc.provider_repository_id
          AND newest.repository_canonical_url=ri.canonical_url
        ORDER BY newest.version DESC LIMIT 1) AS newest_graph_status
     FROM projects p JOIN git_connections gc ON gc.project_id=p.id AND gc.status='VERIFIED'
     JOIN repository_identities ri ON ri.id=gc.repository_identity_id
     JOIN project_repositories pr ON pr.project_id=p.id AND pr.repository_identity_id=ri.id
     LEFT JOIN graph_versions ready ON ready.project_id=p.id AND ready.status='READY'
       AND ready.repository_provider=gc.provider AND ready.provider_repository_id=gc.provider_repository_id
       AND ready.repository_canonical_url=ri.canonical_url
     WHERE p.id=? AND p.status='ACTIVE' AND gc.provider=? AND gc.provider_repository_id=? AND ri.canonical_url=?`,
  )
    .bind(
      projectId,
      report.repository.provider,
      report.repository.providerRepositoryId,
      report.repository.canonicalUrl,
    )
    .first<SyncTruth>();
  if (!truth || truth.remote_git_sha !== report.remoteGitSha) return null;
  const remoteMatches =
    truth.remote_graph_version === report.remoteGraphVersion &&
    truth.remote_graph_attempt === report.remoteGraphAttempt &&
    truth.remote_graph_checksum === report.remoteGraphChecksum &&
    truth.remote_graph_source_commit_sha === report.remoteGraphSourceCommitSha &&
    (truth.remote_graph_version === null
      ? report.remoteGraphStatus === null
      : report.remoteGraphStatus === "READY");
  if (!remoteMatches) return null;
  if (report.localGraphVersion !== null) {
    const local = await env.DB.prepare(
      `SELECT version FROM graph_versions WHERE project_id=? AND repository_provider=?
       AND provider_repository_id=? AND repository_canonical_url=? AND version=?
       AND published_attempt=? AND checksum=? AND source_commit_sha=? AND status IN ('READY','SUPERSEDED')`,
    )
      .bind(
        projectId,
        report.repository.provider,
        report.repository.providerRepositoryId,
        report.repository.canonicalUrl,
        report.localGraphVersion,
        report.localGraphAttempt,
        report.localGraphChecksum,
        report.localGraphSourceCommitSha,
      )
      .first<{ version: number }>();
    if (!local) return null;
  }
  const newest = truth.newest_graph_status;
  if (newest === "QUEUED" || newest === "BUILDING")
    return report.status === "GRAPH_BUILDING" ? truth : null;
  if (newest === "FAILED") return report.status === "GRAPH_FAILED" ? truth : null;
  if (report.localGraphVersion === null) return report.status === "NO_LOCAL_GRAPH" ? truth : null;
  if (report.remoteGraphVersion === null) return null;
  if (report.remoteGraphVersion > report.localGraphVersion)
    return report.status === "REMOTE_GRAPH_AHEAD" ? truth : null;
  if (report.localGitSha !== report.remoteGitSha)
    return ["LOCAL_REPOSITORY_AHEAD", "COMMIT_MISMATCH"].includes(report.status) ? truth : null;
  if (
    report.localGraphSourceCommitSha !== report.localGitSha ||
    report.remoteGraphSourceCommitSha !== report.remoteGitSha
  )
    return report.status === "GRAPH_STALE" ? truth : null;
  const exactCurrent =
    report.localGraphVersion === report.remoteGraphVersion &&
    report.localGraphAttempt === report.remoteGraphAttempt &&
    report.localGraphChecksum === report.remoteGraphChecksum &&
    report.localGraphSourceCommitSha === report.remoteGraphSourceCommitSha;
  return exactCurrent && report.status === "CURRENT" ? truth : null;
}

export async function handleSyncStateWrite(request: Request, env: SyncStateEnv, projectId: string) {
  if (!ID.test(projectId)) return fail(request, env, "INVALID_INPUT", 400);
  const report = parseReport((await boundedBody(request)) ?? {});
  const credential = await localCredential(request);
  if (!report) return fail(request, env, "INVALID_INPUT", 400);
  if (!credential) return fail(request, env, "NOT_FOUND", 404);
  const truth = await syncTruth(env, projectId, report);
  if (!truth) return fail(request, env, "NOT_FOUND", 404);
  const fields = [
    projectId,
    report.clientId,
    report.clientKind,
    report.clientVersion,
    report.observationSequence,
    report.repository.provider,
    report.repository.providerRepositoryId,
    report.repository.canonicalUrl,
    report.localGitSha,
    report.localGraphVersion,
    report.localGraphAttempt,
    report.localGraphChecksum,
    report.localGraphSourceCommitSha,
    report.remoteGitSha,
    report.remoteGraphVersion,
    report.remoteGraphAttempt,
    report.remoteGraphChecksum,
    report.remoteGraphSourceCommitSha,
    report.remoteGraphStatus,
    report.status,
    report.reportOutcome,
    report.failureCode,
    report.reportOutcome,
  ];
  const result = await env.DB.prepare(
    `INSERT INTO sync_states(project_id,principal_id,client_id,client_kind,client_version,observation_sequence,
       repository_provider,provider_repository_id,repository_canonical_url,local_git_sha,local_graph_version,
       local_graph_attempt,local_graph_checksum,local_graph_source_commit_sha,remote_git_sha,remote_graph_version,
       remote_graph_attempt,remote_graph_checksum,remote_graph_source_commit_sha,remote_graph_status,sync_status,
       report_outcome,failure_code,last_sync_at)
     SELECT ?,mp.id,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
       CASE WHEN ?='SYNC_SUCCEEDED' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END
     FROM mcp_credentials mc JOIN mcp_principals mp ON mp.id=mc.principal_id
     JOIN mcp_principal_projects scope ON scope.principal_id=mp.id AND scope.project_id=?
     JOIN projects p ON p.id=scope.project_id AND p.status='ACTIVE'
     JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=mp.owner_user_id
     JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=mp.owner_user_id
     JOIN mcp_principal_operations operation ON operation.principal_id=mp.id AND operation.operation='sync_status'
     JOIN git_connections gc ON gc.project_id=p.id AND gc.status='VERIFIED'
     JOIN repository_identities ri ON ri.id=gc.repository_identity_id
     JOIN project_repositories pr ON pr.project_id=p.id AND pr.repository_identity_id=ri.id
     LEFT JOIN graph_versions ready ON ready.project_id=p.id AND ready.status='READY'
       AND ready.repository_provider=gc.provider AND ready.provider_repository_id=gc.provider_repository_id
       AND ready.repository_canonical_url=ri.canonical_url
     WHERE mc.id=? AND mc.secret_hash=? AND mc.revoked_at IS NULL
       AND mc.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND mp.status='ACTIVE'
       AND gc.provider=? AND gc.provider_repository_id=? AND ri.canonical_url=?
       AND gc.last_known_commit_sha=?
       AND ready.version IS ? AND ready.published_attempt IS ? AND ready.checksum IS ? AND ready.source_commit_sha IS ?
       AND COALESCE((SELECT newest.status FROM graph_versions newest WHERE newest.project_id=p.id
         AND newest.repository_provider=gc.provider AND newest.provider_repository_id=gc.provider_repository_id
         AND newest.repository_canonical_url=ri.canonical_url ORDER BY newest.version DESC LIMIT 1),'NONE')=?
       AND (? IS NULL OR EXISTS (SELECT 1 FROM graph_versions local WHERE local.project_id=p.id
         AND local.repository_provider=gc.provider AND local.provider_repository_id=gc.provider_repository_id
         AND local.repository_canonical_url=ri.canonical_url AND local.version=? AND local.published_attempt=?
         AND local.checksum=? AND local.source_commit_sha=? AND local.status IN ('READY','SUPERSEDED')))
       AND (mp.repository_provider IS NULL OR (mp.repository_provider=gc.provider
         AND mp.provider_repository_id=gc.provider_repository_id AND mp.repository_canonical_url=ri.canonical_url))
     ON CONFLICT(project_id,principal_id,client_id) DO UPDATE SET
       client_version=excluded.client_version,observation_sequence=excluded.observation_sequence,
       repository_provider=excluded.repository_provider,provider_repository_id=excluded.provider_repository_id,
       repository_canonical_url=excluded.repository_canonical_url,local_git_sha=excluded.local_git_sha,
       local_graph_version=excluded.local_graph_version,local_graph_attempt=excluded.local_graph_attempt,
       local_graph_checksum=excluded.local_graph_checksum,local_graph_source_commit_sha=excluded.local_graph_source_commit_sha,
       remote_git_sha=excluded.remote_git_sha,remote_graph_version=excluded.remote_graph_version,
       remote_graph_attempt=excluded.remote_graph_attempt,remote_graph_checksum=excluded.remote_graph_checksum,
       remote_graph_source_commit_sha=excluded.remote_graph_source_commit_sha,remote_graph_status=excluded.remote_graph_status,
       sync_status=excluded.sync_status,report_outcome=excluded.report_outcome,failure_code=excluded.failure_code,
       last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_sync_at=CASE
         WHEN excluded.report_outcome='SYNC_SUCCEEDED' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE sync_states.last_sync_at END
     WHERE excluded.observation_sequence>sync_states.observation_sequence OR
       (excluded.observation_sequence=sync_states.observation_sequence AND
        excluded.local_git_sha=sync_states.local_git_sha AND excluded.sync_status=sync_states.sync_status AND
        excluded.report_outcome=sync_states.report_outcome AND excluded.failure_code IS sync_states.failure_code)
     RETURNING project_id,principal_id,client_id`,
  )
    .bind(
      ...fields,
      projectId,
      credential.credentialId,
      credential.secretHash,
      report.repository.provider,
      report.repository.providerRepositoryId,
      report.repository.canonicalUrl,
      report.remoteGitSha,
      report.remoteGraphVersion,
      report.remoteGraphAttempt,
      report.remoteGraphChecksum,
      report.remoteGraphSourceCommitSha,
      truth.newest_graph_status ?? "NONE",
      report.localGraphVersion,
      report.localGraphVersion,
      report.localGraphAttempt,
      report.localGraphChecksum,
      report.localGraphSourceCommitSha,
    )
    .run()
    .catch(() => null);
  const returned = result?.results as
    | Array<{ project_id?: unknown; principal_id?: unknown; client_id?: unknown }>
    | undefined;
  if (
    returned?.length !== 1 ||
    returned[0]?.project_id !== projectId ||
    typeof returned[0]?.principal_id !== "string" ||
    returned[0].principal_id.length < 1 ||
    returned[0]?.client_id !== report.clientId
  )
    return fail(request, env, "NOT_FOUND", 404);
  const row = await env.DB.prepare(
    `SELECT ss.* FROM sync_states ss JOIN mcp_credentials mc ON mc.principal_id=ss.principal_id
     WHERE ss.project_id=? AND ss.client_id=? AND mc.id=?`,
  )
    .bind(projectId, report.clientId, credential.credentialId)
    .first<SyncRow>();
  if (!row || row.principal_id !== returned[0].principal_id)
    return fail(request, env, "NOT_FOUND", 404);
  return response(request, env, { syncState: mapRow(row) }, 200);
}
