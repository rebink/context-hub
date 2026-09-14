/* biome-ignore-all lint/suspicious/noExplicitAny: The fakes model Cloudflare bindings structurally. */
/* biome-ignore-all lint/style/noNonNullAssertion: Assertions establish fixture presence. */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { app, type Env } from "../src/index.js";
import { SESSION_COOKIE, sha256, sha256Bytes } from "../src/security.js";

type Row = Record<string, any>;

class ArtifactStatement {
  args: any[] = [];
  constructor(
    private db: ArtifactD1,
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
    return { success: true, meta: { changes } } as unknown as D1Result;
  }
}

class ArtifactD1 {
  users: Row[] = [];
  sessions: Row[] = [];
  projects: Row[] = [];
  projectMembers: Row[] = [];
  artifacts: Row[] = [];
  versions: Row[] = [];
  audits: Row[] = [];
  repositoryCommit: string | null = null;
  repositoryStatus: "VERIFIED" | "ERROR" | null = null;
  failNextBatch = false;

  prepare(sql: string) {
    return new ArtifactStatement(this, sql);
  }
  async batch(statements: ArtifactStatement[]) {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error("injected D1 failure");
    }
    const snapshot = structuredClone({
      artifacts: this.artifacts,
      versions: this.versions,
      audits: this.audits,
    });
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.artifacts = snapshot.artifacts;
      this.versions = snapshot.versions;
      this.audits = snapshot.audits;
      throw error;
    }
  }
  private has(sql: string, value: string) {
    return sql.replace(/\s+/g, " ").includes(value);
  }
  first(sql: string, args: any[]): Row | null {
    if (this.has(sql, "FROM sessions s JOIN users u")) {
      const session = this.sessions.find(
        (row) => row.token_hash === args[0] && row.expires_at > args[1],
      );
      return session ? (this.users.find((row) => row.id === session.user_id) ?? null) : null;
    }
    if (this.has(sql, "SELECT pm.role FROM project_members pm")) {
      const project = this.projects.find((row) => row.id === args[0]);
      const membership = this.projectMembers.find(
        (row) => row.project_id === args[0] && row.user_id === args[1],
      );
      return project && membership ? { role: membership.role } : null;
    }
    if (this.has(sql, "FROM artifacts a") && this.has(sql, "WHERE a.project_id = ? AND a.id = ?")) {
      const artifact = this.artifacts.find(
        (row) => row.project_id === args[0] && row.id === args[1],
      );
      if (!artifact) return null;
      const version = this.versions.find(
        (row) => row.artifact_id === artifact.id && row.version === artifact.current_version,
      );
      return {
        ...artifact,
        source_commit_sha: version?.source_commit_sha ?? null,
        current_repository_commit_sha:
          this.repositoryStatus === "VERIFIED" ? this.repositoryCommit : null,
        repository_connection_status: this.repositoryStatus,
      };
    }
    if (this.has(sql, "SELECT av.storage_key FROM artifact_versions av")) {
      const artifact = this.artifacts.find(
        (row) => row.project_id === args[0] && row.id === args[1],
      );
      return artifact
        ? (this.versions.find(
            (row) =>
              row.artifact_id === args[1] && row.version === args[2] && row.storage_key === args[3],
          ) ?? null)
        : null;
    }
    if (
      this.has(sql, "FROM artifact_versions av JOIN artifacts a") &&
      this.has(sql, "av.version = ?")
    ) {
      const artifact = this.artifacts.find(
        (row) => row.project_id === args[0] && row.id === args[1],
      );
      const version = artifact
        ? (this.versions.find((row) => row.artifact_id === args[1] && row.version === args[2]) ??
          null)
        : null;
      return version
        ? {
            ...version,
            current_repository_commit_sha:
              this.repositoryStatus === "VERIFIED" ? this.repositoryCommit : null,
            repository_connection_status: this.repositoryStatus,
          }
        : null;
    }
    throw new Error(`Unhandled first SQL: ${sql}`);
  }
  all(sql: string, args: any[]): Row[] {
    if (this.has(sql, "FROM artifacts a") && this.has(sql, "ORDER BY a.created_at DESC")) {
      const [projectId, type, , cursorAt, , , cursorId, limit] = args;
      return this.artifacts
        .filter(
          (row) =>
            row.project_id === projectId &&
            (!type || row.type === type) &&
            (!cursorAt ||
              row.created_at < cursorAt ||
              (row.created_at === cursorAt && row.id < cursorId)),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map((artifact) => ({
          ...artifact,
          source_commit_sha:
            this.versions.find(
              (version) =>
                version.artifact_id === artifact.id && version.version === artifact.current_version,
            )?.source_commit_sha ?? null,
          current_repository_commit_sha:
            this.repositoryStatus === "VERIFIED" ? this.repositoryCommit : null,
          repository_connection_status: this.repositoryStatus,
        }));
    }
    if (this.has(sql, "FROM artifact_versions av") && this.has(sql, "ORDER BY av.version DESC")) {
      const [projectId, artifactId, cursor, , limit] = args;
      const inProject = this.artifacts.some(
        (row) => row.project_id === projectId && row.id === artifactId,
      );
      return this.versions
        .filter(
          (row) => inProject && row.artifact_id === artifactId && (!cursor || row.version < cursor),
        )
        .sort((a, b) => b.version - a.version)
        .slice(0, limit)
        .map((version) => ({
          ...version,
          current_repository_commit_sha:
            this.repositoryStatus === "VERIFIED" ? this.repositoryCommit : null,
          repository_connection_status: this.repositoryStatus,
        }));
    }
    throw new Error(`Unhandled all SQL: ${sql}`);
  }
  run(sql: string, args: any[]): number {
    if (this.has(sql, "INSERT INTO artifacts")) {
      this.artifacts.push({
        id: args[0],
        project_id: args[1],
        type: args[2],
        name: args[3],
        description: args[4],
        current_version: 1,
        status: "ACTIVE",
        created_by: args[5],
        created_at: args[6],
        updated_at: args[7],
      });
      return 1;
    }
    if (this.has(sql, "INSERT INTO artifact_versions") && this.has(sql, "VALUES (?, 1")) {
      this.versions.push({
        artifact_id: args[0],
        version: 1,
        storage_key: args[1],
        checksum: args[2],
        content_type: args[3],
        byte_size: args[4],
        source_commit_sha: args[5],
        change_note: args[6],
        created_by: args[7],
        created_at: args[8],
      });
      return 1;
    }
    if (this.has(sql, "INSERT INTO artifact_versions") && this.has(sql, "SELECT id")) {
      const artifact = this.artifacts.find(
        (row) =>
          row.id === args[9] && row.project_id === args[10] && row.current_version === args[11],
      );
      if (!artifact) return 0;
      this.versions.push({
        artifact_id: artifact.id,
        version: args[0],
        storage_key: args[1],
        checksum: args[2],
        content_type: args[3],
        byte_size: args[4],
        source_commit_sha: args[5],
        change_note: args[6],
        created_by: args[7],
        created_at: args[8],
      });
      return 1;
    }
    if (this.has(sql, "UPDATE artifacts SET current_version")) {
      const artifact = this.artifacts.find(
        (row) =>
          row.id === args[2] && row.project_id === args[3] && row.current_version === args[4],
      );
      if (!artifact) return 0;
      artifact.current_version = args[0];
      artifact.updated_at = args[1];
      return 1;
    }
    if (this.has(sql, "INSERT INTO audit_events") && this.has(sql, "VALUES")) {
      const eventType = this.has(sql, "'artifact-created'")
        ? "artifact-created"
        : "version-created";
      this.audits.push({
        id: args[0],
        project_id: args[1],
        artifact_id: args[2],
        artifact_version: 1,
        event_type: eventType,
        actor_id: args[3],
        created_at: args[4],
      });
      return 1;
    }
    if (this.has(sql, "INSERT INTO audit_events") && this.has(sql, "SELECT")) {
      const exists = this.versions.some(
        (row) =>
          row.artifact_id === args[6] && row.version === args[7] && row.storage_key === args[8],
      );
      if (!exists) return 0;
      this.audits.push({
        id: args[0],
        project_id: args[1],
        artifact_id: args[2],
        artifact_version: args[3],
        event_type: "version-created",
        actor_id: args[4],
        created_at: args[5],
      });
      return 1;
    }
    throw new Error(`Unhandled run SQL: ${sql}`);
  }
}

class ArtifactR2 {
  objects = new Map<string, Uint8Array>();
  metadata = new Map<string, { httpMetadata: any; customMetadata: any }>();
  puts: Array<{ key: string; options: any }> = [];
  deletes: string[] = [];
  failPut = false;
  throwAfterPut = false;
  afterPut?: () => void;

  async put(key: string, value: any, options: any) {
    this.puts.push({ key, options });
    if (this.failPut) throw new Error("injected R2 failure");
    if (this.objects.has(key) && options.onlyIf?.etagDoesNotMatch === "*") return null;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
    this.objects.set(key, bytes.slice());
    this.metadata.set(key, {
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
    this.afterPut?.();
    if (this.throwAfterPut) throw new Error("injected lost R2 acknowledgement");
    return { key };
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    return bytes
      ? {
          arrayBuffer: async () => bytes.slice().buffer,
        }
      : null;
  }
  async delete(key: string) {
    this.deletes.push(key);
    this.objects.delete(key);
    this.metadata.delete(key);
  }
  async head(key: string) {
    const bytes = this.objects.get(key);
    const metadata = this.metadata.get(key);
    return bytes
      ? {
          size: bytes.byteLength,
          httpMetadata: metadata?.httpMetadata,
          customMetadata: metadata?.customMetadata,
        }
      : null;
  }
}

let db: ArtifactD1;
let r2: ArtifactR2;
let env: Env;

async function user(id: string, role?: string, projectId = "p") {
  const token = `${id}-token`;
  db.users.push({ id, username: id, display_name: null, avatar_url: null });
  db.sessions.push({
    user_id: id,
    token_hash: await sha256(token),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  if (role) db.projectMembers.push({ project_id: projectId, user_id: id, role });
  return token;
}

function apiRequest(
  path: string,
  token?: string,
  method = "GET",
  value?: unknown,
  origin = "good",
) {
  const body = value === undefined ? undefined : JSON.stringify(value);
  const headers = new Headers();
  if (token) headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
  }
  if (method === "POST" && origin !== "missing") {
    headers.set("origin", origin === "good" ? "https://app.example" : origin);
  }
  return new Request(`https://api.example${path}`, { method, headers, body });
}

async function responseBody(response: Response) {
  return response.json() as Promise<any>;
}

const createBody = {
  name: "System map",
  type: "architecture",
  description: "Current architecture",
  contentType: "text/markdown; charset=utf-8",
  content: "# Architecture\n\nHello, world.\n",
  sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
  changeNote: "Initial publication",
};

async function create(token: string, value: unknown = createBody) {
  return app.fetch(apiRequest("/projects/p/artifacts", token, "POST", value), env);
}

beforeEach(() => {
  db = new ArtifactD1();
  r2 = new ArtifactR2();
  db.projects.push({ id: "p" }, { id: "q" });
  env = {
    DB: db as unknown as D1Database,
    OBJECTS: r2 as unknown as R2Bucket,
    WEB_ORIGIN: "https://app.example",
  };
});

describe("artifact publication", () => {
  it("creates immutable v1 in R2 before atomically publishing metadata and audit events", async () => {
    const token = await user("editor", "EDITOR");
    const response = await create(token);
    assert.equal(response.status, 201);
    const result = await responseBody(response);
    const artifactId = result.artifact.id;
    const key = `projects/p/artifacts/${artifactId}/v/1/content`;
    const bytes = new TextEncoder().encode(createBody.content);
    assert.equal(result.checksum, await sha256Bytes(bytes));
    assert.deepEqual(r2.objects.get(key), bytes);
    assert.equal(db.versions[0]!.storage_key, key);
    assert.equal(db.versions[0]!.checksum, result.checksum);
    assert.equal(db.versions[0]!.created_by, "editor");
    assert.deepEqual(
      db.audits.map((event) => event.event_type),
      ["artifact-created", "version-created"],
    );
    assert.deepEqual(r2.puts[0]!.options.onlyIf, { etagDoesNotMatch: "*" });
    assert.equal(r2.puts[0]!.options.customMetadata.checksum, result.checksum);
  });

  it("reuses shared freshness semantics across commit and repository transitions without rewriting versions", async () => {
    const token = await user("editor", "EDITOR");
    db.repositoryStatus = "VERIFIED";
    db.repositoryCommit = createBody.sourceCommitSha;
    const created = await create(token);
    const artifactId = (await responseBody(created)).artifact.id;
    const immutableBefore = structuredClone(db.versions);

    const current = await app.fetch(
      apiRequest(`/projects/p/artifacts/${artifactId}/versions/1`, token),
      env,
    );
    assert.equal((await responseBody(current)).version.freshness.state, "CURRENT");

    db.repositoryCommit = "f".repeat(40);
    const stale = await app.fetch(apiRequest("/projects/p/artifacts", token), env);
    const staleBody = await responseBody(stale);
    assert.equal(staleBody.artifacts[0].freshness.state, "STALE");
    assert.equal(
      staleBody.artifacts[0].freshness.artifactSourceCommitSha,
      createBody.sourceCommitSha,
    );
    assert.equal(staleBody.artifacts[0].freshness.currentRepositoryCommitSha, "f".repeat(40));

    db.repositoryStatus = "ERROR";
    const unverified = await app.fetch(
      apiRequest(`/projects/p/artifacts/${artifactId}/versions`, token),
      env,
    );
    const unverifiedFreshness = (await responseBody(unverified)).versions[0].freshness;
    assert.equal(unverifiedFreshness.state, "UNKNOWN");
    assert.equal(unverifiedFreshness.repositoryStatus, "UNVERIFIED");
    assert.equal(unverifiedFreshness.currentRepositoryCommitSha, null);

    db.repositoryStatus = null;
    const disconnected = await app.fetch(
      apiRequest(`/projects/p/artifacts/${artifactId}`, token),
      env,
    );
    assert.equal(
      (await responseBody(disconnected)).artifact.freshness.repositoryStatus,
      "DISCONNECTED",
    );
    assert.deepEqual(db.versions, immutableBefore);

    db.repositoryStatus = "VERIFIED";
    db.repositoryCommit = createBody.sourceCommitSha;
    const unknown = await create(token, { ...createBody, sourceCommitSha: "abcdef0" });
    assert.equal((await responseBody(unknown)).artifact.freshness.state, "UNKNOWN");
  });

  it("allows ADMIN and EDITOR mutation, while VIEWER can read but cannot mutate", async () => {
    const admin = await user("admin", "ADMIN");
    const editor = await user("editor", "EDITOR");
    const viewer = await user("viewer", "VIEWER");
    assert.equal((await create(admin)).status, 201);
    const created = await responseBody(await create(editor, { ...createBody, name: "Second" }));
    const id = created.artifact.id;
    assert.equal(
      (await app.fetch(apiRequest(`/projects/p/artifacts/${id}`, viewer), env)).status,
      200,
    );
    assert.equal(
      (
        await app.fetch(
          apiRequest(`/projects/p/artifacts/${id}/versions`, viewer, "POST", {
            expectedVersion: 1,
            contentType: "text/plain",
            content: "denied",
          }),
          env,
        )
      ).status,
      403,
    );
  });

  it("does not leak artifacts to workspace-only users or through cross-project IDs", async () => {
    const editor = await user("editor", "EDITOR");
    const workspaceOnly = await user("workspace-only");
    const qViewer = await user("q-viewer", "VIEWER", "q");
    const created = await responseBody(await create(editor));
    const id = created.artifact.id;
    for (const [token, path] of [
      [workspaceOnly, "/projects/p/artifacts"],
      [qViewer, `/projects/q/artifacts/${id}`],
    ] satisfies Array<[string, string]>) {
      const response = await app.fetch(apiRequest(path, token!), env);
      assert.equal(response.status, 404);
      assert.deepEqual(await responseBody(response), { error: "NOT_FOUND" });
    }
  });

  it("preserves version history and returns checksum-verified historical content", async () => {
    const editor = await user("editor", "EDITOR");
    const viewer = await user("viewer", "VIEWER");
    const created = await responseBody(await create(editor));
    const id = created.artifact.id;
    const next = await app.fetch(
      apiRequest(`/projects/p/artifacts/${id}/versions`, editor, "POST", {
        expectedVersion: 1,
        contentType: "application/json",
        content: '{"version":2}',
        changeNote: "Second",
      }),
      env,
    );
    assert.equal(next.status, 201);
    assert.equal(db.artifacts[0]!.current_version, 2);
    assert.deepEqual(
      db.versions.map((version) => version.version),
      [1, 2],
    );
    const history = await responseBody(
      await app.fetch(apiRequest(`/projects/p/artifacts/${id}/versions`, viewer), env),
    );
    assert.deepEqual(
      history.versions.map((version: Row) => version.version),
      [2, 1],
    );
    const old = await responseBody(
      await app.fetch(apiRequest(`/projects/p/artifacts/${id}/versions/1`, viewer), env),
    );
    assert.equal(old.content, createBody.content);
    const latest = await responseBody(
      await app.fetch(apiRequest(`/projects/p/artifacts/${id}/versions/2`, viewer), env),
    );
    assert.equal(latest.content, '{"version":2}');
  });

  it("returns authorized currentVersion on stale and raced writes without creating a DB version", async () => {
    const editor = await user("editor", "EDITOR");
    const created = await responseBody(await create(editor));
    const id = created.artifact.id;
    db.artifacts[0]!.current_version = 2;
    const stale = await app.fetch(
      apiRequest(`/projects/p/artifacts/${id}/versions`, editor, "POST", {
        expectedVersion: 1,
        contentType: "text/plain",
        content: "stale",
      }),
      env,
    );
    assert.equal(stale.status, 409);
    assert.deepEqual(await responseBody(stale), { error: "CONFLICT", currentVersion: 2 });
    assert.equal(db.versions.length, 1);

    db.artifacts[0]!.current_version = 1;
    r2.afterPut = () => {
      db.artifacts[0]!.current_version = 2;
      r2.afterPut = undefined;
    };
    const raced = await app.fetch(
      apiRequest(`/projects/p/artifacts/${id}/versions`, editor, "POST", {
        expectedVersion: 1,
        contentType: "text/plain",
        content: "raced",
      }),
      env,
    );
    assert.equal(raced.status, 409);
    assert.deepEqual(await responseBody(raced), { error: "CONFLICT", currentVersion: 2 });
    assert.equal(db.versions.length, 1);
    assert.equal(r2.deletes.length, 1);
  });
});

describe("artifact boundaries and failure handling", () => {
  it("rejects unsafe version numbers and unsupported methods", async () => {
    const editor = await user("editor", "EDITOR");
    const created = await responseBody(await create(editor));
    const id = created.artifact.id;
    const unsafe = "999999999999999999999999999999";
    assert.equal(
      (await app.fetch(apiRequest(`/projects/p/artifacts/${id}/versions/${unsafe}`, editor), env))
        .status,
      400,
    );
    assert.equal(
      (
        await app.fetch(
          apiRequest(`/projects/p/artifacts/${id}/versions?cursor=${unsafe}`, editor),
          env,
        )
      ).status,
      400,
    );
    const unsupported = await app.fetch(
      apiRequest(`/projects/p/artifacts/${id}`, editor, "PUT"),
      env,
    );
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "GET");
  });

  it("rejects invalid formats, declared JSON, content size, and request size", async () => {
    const editor = await user("editor", "EDITOR");
    for (const value of [
      { ...createBody, type: "pdf" },
      { ...createBody, contentType: "application/pdf" },
      { ...createBody, contentType: "application/json", content: "{" },
    ]) {
      assert.equal((await create(editor, value)).status, 400);
    }
    assert.equal(
      (await create(editor, { ...createBody, content: "x".repeat(1024 * 1024 + 1) })).status,
      413,
    );
    const tooLargeRequest = apiRequest("/projects/p/artifacts", editor, "POST", createBody);
    tooLargeRequest.headers.set("content-length", String(7 * 1024 * 1024));
    assert.equal((await app.fetch(tooLargeRequest, env)).status, 413);
    const misleadingLength = apiRequest("/projects/p/artifacts", editor, "POST", {
      ...createBody,
      ignored: "x".repeat(7 * 1024 * 1024),
    });
    misleadingLength.headers.set("content-length", "1");
    assert.equal((await app.fetch(misleadingLength, env)).status, 413);
    const missingLength = apiRequest("/projects/p/artifacts", editor, "POST", createBody);
    missingLength.headers.delete("content-length");
    assert.equal((await app.fetch(missingLength, env)).status, 201);
    assert.equal(db.artifacts.length, 1);
    assert.equal(r2.objects.size, 1);
  });

  it("adopts a matching object when the R2 acknowledgement is lost", async () => {
    const editor = await user("editor", "EDITOR");
    r2.throwAfterPut = true;
    assert.equal((await create(editor)).status, 201);
    assert.equal(db.artifacts.length, 1);
    assert.equal(r2.objects.size, 1);
  });

  it("treats create-only collisions and R2 failures as unpublished", async () => {
    const editor = await user("editor", "EDITOR");
    r2.failPut = true;
    assert.equal((await create(editor)).status, 500);
    assert.equal(db.artifacts.length, 0);

    r2.failPut = false;
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      value: () => "fixed-artifact",
      configurable: true,
    });
    try {
      const key = "projects/p/artifacts/fixed-artifact/v/1/content";
      const bytes = new TextEncoder().encode(createBody.content);
      const contentType = "text/markdown;charset=utf-8";
      r2.objects.set(key, bytes);
      r2.metadata.set(key, {
        httpMetadata: { contentType },
        customMetadata: {
          checksum: await sha256Bytes(bytes),
          contentType,
          uploadId: "another-request",
        },
      });
      assert.equal((await create(editor)).status, 409);
      assert.equal(db.artifacts.length, 0);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });

  it("compensates definite D1 failures after staging creates and new versions", async () => {
    const editor = await user("editor", "EDITOR");
    db.failNextBatch = true;
    const failedCreate = await create(editor);
    assert.equal(failedCreate.status, 500);
    assert.equal(db.artifacts.length, 0);
    assert.equal(db.versions.length, 0);
    assert.equal(r2.objects.size, 0);
    assert.equal(r2.deletes.length, 1);

    const created = await responseBody(await create(editor));
    db.failNextBatch = true;
    const failedVersion = await app.fetch(
      apiRequest(`/projects/p/artifacts/${created.artifact.id}/versions`, editor, "POST", {
        expectedVersion: 1,
        contentType: "text/plain",
        content: "not published",
      }),
      env,
    );
    assert.equal(failedVersion.status, 500);
    assert.equal(db.artifacts[0]!.current_version, 1);
    assert.equal(db.versions.length, 1);
    assert.equal(r2.objects.size, 1);
    assert.equal(r2.deletes.length, 2);
  });

  it("paginates artifacts stably and applies the canonical type filter", async () => {
    const editor = await user("editor", "EDITOR");
    for (const [name, type] of [
      ["A", "architecture"],
      ["B", "adr"],
      ["C", "architecture"],
    ]) {
      assert.equal((await create(editor, { ...createBody, name, type })).status, 201);
    }
    const first = await responseBody(
      await app.fetch(apiRequest("/projects/p/artifacts?limit=1&type=architecture", editor), env),
    );
    assert.equal(first.artifacts.length, 1);
    assert.ok(first.nextCursor);
    const second = await responseBody(
      await app.fetch(
        apiRequest(
          `/projects/p/artifacts?limit=1&type=architecture&cursor=${encodeURIComponent(first.nextCursor)}`,
          editor,
        ),
        env,
      ),
    );
    assert.equal(second.artifacts.length, 1);
    assert.notEqual(second.artifacts[0].id, first.artifacts[0].id);
    assert.equal(second.nextCursor, null);
    assert.equal(
      (await app.fetch(apiRequest("/projects/p/artifacts?limit=101", editor), env)).status,
      400,
    );
  });

  it("authenticates artifact mutations before rejecting hostile or missing Origin", async () => {
    const editor = await user("editor", "EDITOR");
    for (const origin of ["https://evil.example", "missing"]) {
      assert.equal(
        (
          await app.fetch(
            apiRequest("/projects/p/artifacts", editor, "POST", createBody, origin),
            env,
          )
        ).status,
        403,
      );
      const unauthenticated = await app.fetch(
        apiRequest("/projects/p/artifacts", undefined, "POST", createBody, origin),
        env,
      );
      assert.equal(unauthenticated.status, 401);
      assert.deepEqual(await responseBody(unauthenticated), { error: "UNAUTHENTICATED" });
    }
  });

  it("reports generic integrity errors without exposing authorized R2 keys", async () => {
    const editor = await user("editor", "EDITOR");
    const viewer = await user("viewer", "VIEWER");
    const created = await responseBody(await create(editor));
    const id = created.artifact.id;
    const key = db.versions[0]!.storage_key;
    r2.objects.set(key, new TextEncoder().encode("tampered"));
    const response = await app.fetch(
      apiRequest(`/projects/p/artifacts/${id}/versions/1`, viewer),
      env,
    );
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(text), { error: "STORAGE_INTEGRITY_ERROR" });
    assert.equal(text.includes(key), false);

    r2.objects.delete(key);
    const missing = await app.fetch(
      apiRequest(`/projects/p/artifacts/${id}/versions/1`, viewer),
      env,
    );
    assert.equal(missing.status, 500);
    assert.deepEqual(await responseBody(missing), { error: "STORAGE_INTEGRITY_ERROR" });
  });
});
