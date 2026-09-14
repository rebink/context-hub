/* biome-ignore-all lint/suspicious/noExplicitAny: The fake models Cloudflare D1 structurally. */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { sha256 } from "../src/security.js";
import {
  handleSyncStateRead,
  handleSyncStateWrite,
  type SyncStateEnv,
} from "../src/sync-states.js";

type Row = Record<string, any>;

class Statement {
  args: any[] = [];
  constructor(
    private db: SyncD1,
    readonly sql: string,
  ) {}
  bind(...args: any[]) {
    this.args = args;
    return this;
  }
  async first<T>() {
    return this.db.first(this.sql, this.args) as T | null;
  }
  async all<T>() {
    return { success: true, results: this.db.all(this.sql, this.args), meta: {} } as D1Result<T>;
  }
  async run() {
    const changes = this.db.run(this.sql, this.args);
    return {
      success: true,
      results:
        changes === 1
          ? Array.from({ length: this.db.returningCopies }, () => ({
              project_id: this.args[0],
              principal_id: this.db.principalId,
              client_id: this.args[1],
            }))
          : [],
      meta: { changes },
    } as unknown as D1Result;
  }
}

class SyncD1 {
  now = "2030-01-02T03:04:05.678Z";
  member = true;
  workspaceMember = true;
  projectActive = true;
  repositoryVerified = true;
  principalActive = true;
  credentialActive = true;
  scoped = true;
  operation = true;
  credentialId = "11111111-1111-4111-8111-111111111111";
  principalId = "principal-1";
  secretHash = "";
  repository = { provider: "github", id: "99", canonical: "github.com/acme/repo" };
  remoteGitSha = "a".repeat(40);
  remoteGraph = { version: 4, attempt: 2, checksum: "c".repeat(64), source: "a".repeat(40) };
  newestStatus = "READY";
  localGraphValid = true;
  afterTruth?: () => void;
  returningCopies = 1;
  rows: Row[] = [];

  prepare(sql: string) {
    return new Statement(this, sql);
  }
  private has(sql: string, value: string) {
    return sql.replace(/\s+/g, " ").includes(value);
  }
  first(sql: string, args: any[]): Row | null {
    if (this.has(sql, "SELECT gc.last_known_commit_sha AS remote_git_sha")) {
      assert.match(sql, /ready\.published_attempt/);
      const [projectId, provider, repositoryId, canonical] = args;
      const result =
        projectId === "p" &&
        provider === this.repository.provider &&
        repositoryId === this.repository.id &&
        canonical === this.repository.canonical &&
        this.projectActive &&
        this.repositoryVerified
          ? {
              remote_git_sha: this.remoteGitSha,
              remote_graph_version: this.remoteGraph.version,
              remote_graph_attempt: this.remoteGraph.attempt,
              remote_graph_checksum: this.remoteGraph.checksum,
              remote_graph_source_commit_sha: this.remoteGraph.source,
              newest_graph_status: this.newestStatus,
            }
          : null;
      const afterTruth = this.afterTruth;
      this.afterTruth = undefined;
      afterTruth?.();
      return result;
    }
    if (this.has(sql, "SELECT version FROM graph_versions")) {
      assert.match(sql, /status IN \('READY','SUPERSEDED'\)/);
      return this.localGraphValid &&
        args[4] === this.remoteGraph.version &&
        args[5] === this.remoteGraph.attempt &&
        args[6] === this.remoteGraph.checksum &&
        args[7] === this.remoteGraph.source
        ? { version: args[4] }
        : null;
    }
    if (this.has(sql, "SELECT p.id FROM projects p")) {
      assert.match(sql, /JOIN project_members/);
      assert.match(sql, /JOIN workspace_members/);
      assert.match(sql, /gc\.status='VERIFIED'/);
      return args[0] === "reader" &&
        args[1] === "reader" &&
        args[2] === "p" &&
        this.member &&
        this.workspaceMember &&
        this.projectActive &&
        this.repositoryVerified
        ? { id: "p" }
        : null;
    }
    if (this.has(sql, "SELECT ss.* FROM sync_states ss JOIN mcp_credentials")) {
      return (
        this.rows.find(
          (row) =>
            row.project_id === args[0] &&
            row.client_id === args[1] &&
            args[2] === this.credentialId,
        ) ?? null
      );
    }
    throw new Error(`Unhandled first SQL: ${sql}`);
  }
  all(sql: string, args: any[]) {
    if (!this.has(sql, "SELECT ss.* FROM sync_states ss"))
      throw new Error(`Unhandled all SQL: ${sql}`);
    assert.match(sql, /ss\.repository_provider=gc\.provider/);
    assert.match(sql, /ORDER BY ss\.last_seen_at DESC/);
    const projectId = args[0];
    const cursorAt = args[1] as string | null;
    const cursorPrincipal = args[4] as string | null;
    const cursorClient = args[7] as string | null;
    const limit = args[8] as number;
    return this.rows
      .filter(
        (row) =>
          row.project_id === projectId &&
          row.repository_provider === this.repository.provider &&
          row.provider_repository_id === this.repository.id &&
          row.repository_canonical_url === this.repository.canonical &&
          (!cursorAt ||
            row.last_seen_at < cursorAt ||
            (row.last_seen_at === cursorAt && row.principal_id < (cursorPrincipal ?? "")) ||
            (row.last_seen_at === cursorAt &&
              row.principal_id === cursorPrincipal &&
              row.client_id < (cursorClient ?? ""))),
      )
      .sort(
        (a, b) =>
          b.last_seen_at.localeCompare(a.last_seen_at) ||
          b.principal_id.localeCompare(a.principal_id) ||
          b.client_id.localeCompare(a.client_id),
      )
      .slice(0, limit);
  }
  run(sql: string, args: any[]) {
    if (!this.has(sql, "INSERT INTO sync_states")) throw new Error(`Unhandled run SQL: ${sql}`);
    assert.match(sql, /ON CONFLICT\(project_id,principal_id,client_id\)/);
    assert.match(sql, /excluded\.observation_sequence>sync_states\.observation_sequence/);
    assert.match(sql, /INSERT INTO sync_states[\s\S]*SELECT \?,mp\.id/);
    assert.match(sql, /JOIN project_members/);
    assert.match(sql, /JOIN workspace_members/);
    assert.match(sql, /operation\.operation='sync_status'/);
    assert.match(sql, /gc\.last_known_commit_sha=\?/);
    const [
      projectId,
      clientId,
      clientKind,
      clientVersion,
      sequence,
      provider,
      repositoryId,
      canonical,
      localGitSha,
      localGraphVersion,
      localGraphAttempt,
      localGraphChecksum,
      localGraphSourceCommitSha,
      remoteGitSha,
      remoteGraphVersion,
      remoteGraphAttempt,
      remoteGraphChecksum,
      remoteGraphSourceCommitSha,
      remoteGraphStatus,
      status,
      reportOutcome,
      failureCode,
    ] = args;
    const principalId = this.principalId;
    if (
      !this.member ||
      !this.workspaceMember ||
      !this.projectActive ||
      !this.repositoryVerified ||
      !this.principalActive ||
      !this.credentialActive ||
      !this.scoped ||
      !this.operation ||
      args[24] !== this.credentialId ||
      args[25] !== this.secretHash ||
      args[26] !== this.repository.provider ||
      args[27] !== this.repository.id ||
      args[28] !== this.repository.canonical ||
      args[29] !== this.remoteGitSha ||
      args[30] !== this.remoteGraph.version ||
      args[31] !== this.remoteGraph.attempt ||
      args[32] !== this.remoteGraph.checksum ||
      args[33] !== this.remoteGraph.source
    )
      return 0;
    const existing = this.rows.find(
      (row) =>
        row.project_id === projectId &&
        row.principal_id === principalId &&
        row.client_id === clientId,
    );
    if (existing && sequence < existing.observation_sequence) return 0;
    if (
      existing &&
      sequence === existing.observation_sequence &&
      (existing.local_git_sha !== localGitSha ||
        existing.sync_status !== status ||
        existing.report_outcome !== reportOutcome ||
        existing.failure_code !== failureCode)
    )
      return 0;
    const row = {
      project_id: projectId,
      principal_id: principalId,
      client_id: clientId,
      client_kind: clientKind,
      client_version: clientVersion,
      observation_sequence: sequence,
      repository_provider: provider,
      provider_repository_id: repositoryId,
      repository_canonical_url: canonical,
      local_git_sha: localGitSha,
      local_graph_version: localGraphVersion,
      local_graph_attempt: localGraphAttempt,
      local_graph_checksum: localGraphChecksum,
      local_graph_source_commit_sha: localGraphSourceCommitSha,
      remote_git_sha: remoteGitSha,
      remote_graph_version: remoteGraphVersion,
      remote_graph_attempt: remoteGraphAttempt,
      remote_graph_checksum: remoteGraphChecksum,
      remote_graph_source_commit_sha: remoteGraphSourceCommitSha,
      remote_graph_status: remoteGraphStatus,
      sync_status: status,
      report_outcome: reportOutcome,
      failure_code: failureCode,
      last_sync_at:
        reportOutcome === "SYNC_SUCCEEDED" ? this.now : (existing?.last_sync_at ?? null),
      last_seen_at: this.now,
      created_at: existing?.created_at ?? this.now,
    };
    if (existing) Object.assign(existing, row);
    else this.rows.push(row);
    return 1;
  }
}

const tokenSecret = "a".repeat(43);
const clientId = "12345678-1234-4123-8123-123456789abc";
const shaA = "a".repeat(40);
const checksum = "c".repeat(64);
let db: SyncD1;
let env: SyncStateEnv;

function report(overrides: Record<string, unknown> = {}) {
  return {
    clientId,
    clientKind: "CONTEXT_CLI",
    clientVersion: "0.1.0",
    observationSequence: 1,
    repository: {
      provider: "github",
      providerRepositoryId: "99",
      canonicalUrl: "github.com/acme/repo",
    },
    localGitSha: shaA,
    localGraphVersion: 4,
    localGraphAttempt: 2,
    localGraphChecksum: checksum,
    localGraphSourceCommitSha: shaA,
    remoteGitSha: shaA,
    remoteGraphVersion: 4,
    remoteGraphAttempt: 2,
    remoteGraphChecksum: checksum,
    remoteGraphSourceCommitSha: shaA,
    remoteGraphStatus: "READY",
    status: "CURRENT",
    reportOutcome: "STATUS",
    failureCode: null,
    ...overrides,
  };
}

function writeRequest(value: unknown, headers: Record<string, string> = {}) {
  return new Request("https://api.example/projects/p/sync-states/current", {
    method: "PUT",
    headers: {
      authorization: `Bearer chmcp_${db.credentialId}.${tokenSecret}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(value),
  });
}

beforeEach(async () => {
  db = new SyncD1();
  db.secretHash = await sha256(tokenSecret);
  env = { DB: db as unknown as D1Database, WEB_ORIGIN: "https://app.example" };
});

describe("persisted local sync state", () => {
  it("creates, monotonically updates, and idempotently replays exact observations with D1 time", async () => {
    const created = await handleSyncStateWrite(writeRequest(report()), env, "p");
    assert.equal(created.status, 200);
    assert.equal(((await created.json()) as any).syncState.lastSeenAt, db.now);

    const replay = await handleSyncStateWrite(writeRequest(report()), env, "p");
    assert.equal(replay.status, 200);
    assert.equal(db.rows.length, 1);

    const updated = await handleSyncStateWrite(
      writeRequest(report({ observationSequence: 2, reportOutcome: "SYNC_SUCCEEDED" })),
      env,
      "p",
    );
    assert.equal(updated.status, 200);
    const body = (await updated.json()) as any;
    assert.equal(body.syncState.lastSyncAt, db.now);
    assert.equal(body.syncState.observationSequence, 2);

    assert.equal((await handleSyncStateWrite(writeRequest(report()), env, "p")).status, 404);
    assert.equal(
      (
        await handleSyncStateWrite(
          writeRequest(report({ observationSequence: 2, status: "GRAPH_STALE" })),
          env,
          "p",
        )
      ).status,
      404,
    );
  });

  it("fails closed unless sync-state RETURNING identifies exactly one projection row", async () => {
    for (const [copies, expectedStatus] of [
      [0, 404],
      [1, 200],
      [2, 404],
    ] as const) {
      db = new SyncD1();
      db.secretHash = await sha256(tokenSecret);
      db.returningCopies = copies;
      env = { DB: db as unknown as D1Database, WEB_ORIGIN: "https://app.example" };
      assert.equal(
        (await handleSyncStateWrite(writeRequest(report()), env, "p")).status,
        expectedStatus,
      );
    }
  });

  it("enforces Authorization-only local principals, current membership, operation, and exact repository binding", async () => {
    assert.equal(
      (
        await handleSyncStateWrite(
          writeRequest(report(), { cookie: "context_hub_session=x" }),
          env,
          "p",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await handleSyncStateWrite(
          writeRequest(report(), { origin: "https://app.example" }),
          env,
          "p",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await handleSyncStateWrite(
          writeRequest(
            report({
              repository: {
                provider: "github",
                providerRepositoryId: "other",
                canonicalUrl: "github.com/acme/other",
              },
            }),
          ),
          env,
          "p",
        )
      ).status,
      404,
    );
    for (const field of [
      "member",
      "workspaceMember",
      "projectActive",
      "repositoryVerified",
      "principalActive",
      "scoped",
      "operation",
      "credentialActive",
    ] as const) {
      db[field] = false;
      assert.equal(
        (await handleSyncStateWrite(writeRequest(report()), env, "p")).status,
        404,
        field,
      );
      db[field] = true;
    }
    for (const field of [
      "member",
      "workspaceMember",
      "projectActive",
      "principalActive",
      "credentialActive",
      "scoped",
      "operation",
    ] as const) {
      db.afterTruth = () => {
        db[field] = false;
      };
      assert.equal(
        (await handleSyncStateWrite(writeRequest(report()), env, "p")).status,
        404,
        `race:${field}`,
      );
      db[field] = true;
    }
    db.afterTruth = () => {
      db.repository.id = "replacement";
    };
    assert.equal(
      (await handleSyncStateWrite(writeRequest(report()), env, "p")).status,
      404,
      "race:repository replacement",
    );
    db.repository.id = "repo-1";
  });

  it("rejects partial, oversized, and inconsistent reports before database mutation", async () => {
    assert.equal((await handleSyncStateWrite(writeRequest({ clientId }), env, "p")).status, 400);
    assert.equal(
      (await handleSyncStateWrite(writeRequest(report({ status: "NO_LOCAL_GRAPH" })), env, "p"))
        .status,
      404,
    );
    assert.equal(
      (
        await handleSyncStateWrite(
          writeRequest(report({ remoteGraphStatus: "BUILDING", remoteGraphChecksum: checksum })),
          env,
          "p",
        )
      ).status,
      400,
    );
    assert.equal(
      (await handleSyncStateWrite(writeRequest(report({ remoteGraphAttempt: 99 })), env, "p"))
        .status,
      404,
    );
    db.localGraphValid = false;
    assert.equal((await handleSyncStateWrite(writeRequest(report()), env, "p")).status, 404);
    db.localGraphValid = true;
    db.remoteGitSha = "b".repeat(40);
    assert.equal((await handleSyncStateWrite(writeRequest(report()), env, "p")).status, 404);
    const oversized = writeRequest(report(), { "content-length": "4097" });
    assert.equal((await handleSyncStateWrite(oversized, env, "p")).status, 400);
    assert.equal(db.rows.length, 0);
  });

  it("lists and selects current state with bounded cursor pagination for every direct role", async () => {
    await handleSyncStateWrite(writeRequest(report()), env, "p");
    db.rows.push({
      ...db.rows[0],
      client_id: "22345678-1234-4123-8123-123456789abc",
      last_seen_at: "2029-01-01T00:00:00.000Z",
    });
    const first = await handleSyncStateRead(
      new Request("https://api.example/projects/p/sync-states?limit=1"),
      env,
      { id: "reader" },
      "p",
      false,
    );
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as any;
    assert.equal(firstBody.syncStates.length, 1);
    assert.equal(typeof firstBody.nextCursor, "string");
    const second = await handleSyncStateRead(
      new Request(
        `https://api.example/projects/p/sync-states?limit=1&cursor=${firstBody.nextCursor}`,
      ),
      env,
      { id: "reader" },
      "p",
      false,
    );
    assert.equal(
      ((await second.json()) as any).syncStates[0].clientId,
      "22345678-1234-4123-8123-123456789abc",
    );
    const current = await handleSyncStateRead(
      new Request("https://api.example/projects/p/sync-states/current"),
      env,
      { id: "reader" },
      "p",
      true,
    );
    assert.equal(((await current.json()) as any).syncState.clientId, clientId);
    assert.equal(
      (
        await handleSyncStateRead(
          new Request("https://api.example/projects/p/sync-states?limit=51"),
          env,
          { id: "reader" },
          "p",
          false,
        )
      ).status,
      400,
    );
    db.member = false;
    assert.equal(
      (
        await handleSyncStateRead(
          new Request("https://api.example/projects/p/sync-states"),
          env,
          { id: "reader" },
          "p",
          false,
        )
      ).status,
      404,
    );
  });
});
