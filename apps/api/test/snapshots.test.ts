/* biome-ignore-all lint/suspicious/noExplicitAny: The SQL-aware fake models Cloudflare bindings structurally. */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { GRAPH_BUILD_IDENTITY } from "../src/graphs.js";
import { createApp } from "../src/index.js";
import { SESSION_COOKIE, sha256, sha256Bytes } from "../src/security.js";
import { handleSnapshotRoute } from "../src/snapshots.js";

type Row = Record<string, any>;

class Statement {
  args: any[] = [];
  constructor(
    private db: SnapshotD1,
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
    return {
      success: true,
      meta: { changes: this.db.run(this.sql, this.args) },
    } as unknown as D1Result;
  }
}

class SnapshotD1 {
  sessions: Row[] = [];
  users: Row[] = [];
  projects: Row[] = [{ id: "p" }, { id: "other" }];
  members: Row[] = [];
  graph: Row | null = null;
  artifacts: Row[] = [];
  versions: Row[] = [];
  snapshots: Row[] = [];
  refs: Row[] = [];
  events: Row[] = [];
  failBatch = false;
  failSuccessAudit = false;
  now = "2026-02-03T04:05:06.007Z";
  beforeManifestReferenceCheck?: (key: string) => void;

  prepare(sql: string) {
    return new Statement(this, sql);
  }
  private has(sql: string, value: string) {
    return sql.replace(/\s+/g, " ").includes(value);
  }
  async batch(statements: Statement[]) {
    if (this.failBatch) {
      this.failBatch = false;
      throw new Error("injected D1 failure");
    }
    const backup = structuredClone({
      snapshots: this.snapshots,
      refs: this.refs,
      events: this.events,
    });
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.snapshots = backup.snapshots;
      this.refs = backup.refs;
      this.events = backup.events;
      throw error;
    }
  }
  first(sql: string, args: any[]): Row | null {
    if (this.has(sql, "SELECT strftime(")) return { now: this.now };
    if (
      this.has(
        sql,
        "SELECT id FROM context_snapshots WHERE project_id = ? AND manifest_storage_key = ?",
      )
    ) {
      this.beforeManifestReferenceCheck?.(args[1]);
      return (
        this.snapshots.find(
          (row) => row.project_id === args[0] && row.manifest_storage_key === args[1],
        ) ?? null
      );
    }
    if (this.has(sql, "FROM sessions s JOIN users u")) {
      const session = this.sessions.find(
        (row) => row.token_hash === args[0] && row.expires_at > args[1],
      );
      return session ? (this.users.find((row) => row.id === session.user_id) ?? null) : null;
    }
    if (this.has(sql, "SELECT pm.role FROM project_members pm")) {
      return this.projects.some((row) => row.id === args[0])
        ? (this.members.find((row) => row.project_id === args[0] && row.user_id === args[1]) ??
            null)
        : null;
    }
    if (this.has(sql, "SELECT * FROM context_snapshots WHERE project_id = ? AND id = ?"))
      return this.snapshots.find((row) => row.project_id === args[0] && row.id === args[1]) ?? null;
    if (this.has(sql, "created_by = ? AND idempotency_key = ?"))
      return (
        this.snapshots.find(
          (row) =>
            row.project_id === args[0] &&
            row.created_by === args[1] &&
            row.idempotency_key === args[2],
        ) ?? null
      );
    if (this.has(sql, "SELECT gv.* FROM graph_versions gv")) {
      if (!this.graph || this.graph.project_id !== args[0] || this.graph.version !== args[1])
        return null;
      if (this.has(sql, "JOIN git_connections"))
        return this.graph.source_commit_sha === args[2] && this.graph.repository_matches
          ? this.graph
          : null;
      return this.graph.source_commit_sha === args[2] &&
        this.graph.storage_layout === args[3] &&
        this.graph.storage_key === args[4] &&
        this.graph.checksum === args[5]
        ? this.graph
        : null;
    }
    if (this.has(sql, "FROM artifact_versions av JOIN artifacts a")) {
      const artifact = this.artifacts.find(
        (row) => row.id === args[1] && row.project_id === args[0],
      );
      const version = this.versions.find(
        (row) => row.artifact_id === args[1] && row.version === args[2],
      );
      return artifact && version
        ? {
            ...version,
            artifact_version: version.version,
            artifact_type: artifact.type,
            version_created_by: version.created_by,
            version_created_at: version.created_at,
          }
        : null;
    }
    throw new Error(`Unhandled first SQL: ${sql}`);
  }
  all(sql: string, args: any[]): Row[] {
    if (this.has(sql, "FROM snapshot_artifacts"))
      return this.refs
        .filter((row) => row.project_id === args[0] && row.snapshot_id === args[1])
        .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
    if (this.has(sql, "FROM context_snapshots cs LEFT JOIN")) {
      const [projectId, at, , , id, limit] = args;
      return this.snapshots
        .filter(
          (row) =>
            row.project_id === projectId &&
            (!at || row.created_at < at || (row.created_at === at && row.id < id)),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map((row) => ({
          ...row,
          artifact_count: this.refs.filter((ref) => ref.snapshot_id === row.id).length,
        }));
    }
    throw new Error(`Unhandled all SQL: ${sql}`);
  }
  run(sql: string, args: any[]): number {
    if (this.has(sql, "INSERT INTO context_snapshots")) {
      const columns = sql
        .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
        .split(",")
        .map((value) => value.trim());
      const row = Object.fromEntries(columns.map((column, index) => [column, args[index]]));
      if (
        row.idempotency_key &&
        this.snapshots.some(
          (item) =>
            item.project_id === row.project_id &&
            item.created_by === row.created_by &&
            item.idempotency_key === row.idempotency_key,
        )
      )
        throw new Error("UNIQUE constraint failed");
      this.snapshots.push(row);
      return 1;
    }
    if (this.has(sql, "INSERT INTO snapshot_artifacts")) {
      const [
        snapshot_id,
        project_id,
        artifact_id,
        artifact_version,
        artifact_type,
        storage_key,
        upload_id,
        checksum,
        content_type,
        byte_size,
        source_commit_sha,
        change_note,
        version_created_by,
        version_created_at,
      ] = args;
      this.refs.push({
        snapshot_id,
        project_id,
        artifact_id,
        artifact_version,
        artifact_type,
        storage_key,
        upload_id,
        checksum,
        content_type,
        byte_size,
        source_commit_sha,
        change_note,
        version_created_by,
        version_created_at,
      });
      return 1;
    }
    if (this.has(sql, "INSERT INTO snapshot_events")) {
      if (this.failSuccessAudit && !this.has(sql, "VALUES (?, ?, NULL")) {
        this.failSuccessAudit = false;
        throw new Error("injected snapshot audit failure");
      }
      if (this.has(sql, "VALUES (?, ?, NULL")) {
        this.events.push({
          id: args[0],
          project_id: args[1],
          snapshot_id: null,
          actor_id: args[2],
          outcome: args[3],
          reason: args[4],
          created_at: args[5],
        });
      } else {
        this.events.push({
          id: args[0],
          project_id: args[1],
          snapshot_id: args[2],
          actor_id: args[3],
          outcome: "SUCCESS",
          reason: null,
          created_at: args[4],
        });
      }
      return 1;
    }
    throw new Error(`Unhandled run SQL: ${sql}`);
  }
}

class SnapshotR2 {
  objects = new Map<string, { bytes: Uint8Array; httpMetadata: Row; customMetadata: Row }>();
  deletes: string[] = [];
  throwAfterPut = false;
  collide = false;
  collisionWithInput = false;
  async put(key: string, value: any, options: any) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
    if (this.collisionWithInput) {
      this.objects.set(key, {
        bytes: bytes.slice(),
        httpMetadata: options.httpMetadata,
        customMetadata: options.customMetadata,
      });
      return null;
    }
    if (this.collide || (this.objects.has(key) && options.onlyIf?.etagDoesNotMatch === "*"))
      return null;
    this.objects.set(key, {
      bytes: bytes.slice(),
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
    if (this.throwAfterPut) {
      this.throwAfterPut = false;
      throw new Error("lost acknowledgement");
    }
    return { key };
  }
  async head(key: string) {
    const value = this.objects.get(key);
    return value
      ? {
          size: value.bytes.byteLength,
          httpMetadata: value.httpMetadata,
          customMetadata: value.customMetadata,
        }
      : null;
  }
  async get(key: string) {
    const value = this.objects.get(key);
    return value ? { arrayBuffer: async () => value.bytes.slice().buffer } : null;
  }
  async delete(key: string) {
    this.deletes.push(key);
    this.objects.delete(key);
  }
}

function standardGraph(commit: string) {
  return {
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [
      { id: "a", label: "Alpha", file_type: "ts", source_file: "src/a.ts", source_location: "L1" },
    ],
    links: [],
    hyperedges: [],
    built_at_commit: commit,
  };
}

let db: SnapshotD1;
let bucket: SnapshotR2;
let storage: any;

async function setup() {
  db = new SnapshotD1();
  bucket = new SnapshotR2();
  storage = {
    createOnly: async (key: string, bytes: Uint8Array, metadata: Row) =>
      (await bucket.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: metadata.contentType },
        customMetadata: metadata,
      }))
        ? "created"
        : "collision",
    head: async (key: string) => {
      const value = await bucket.head(key);
      return value
        ? {
            byteSize: value.size,
            httpContentType: value.httpMetadata.contentType,
            metadata: value.customMetadata,
          }
        : null;
    },
    getBytes: async (key: string) => {
      const value = await bucket.get(key);
      return value ? new Uint8Array(await value.arrayBuffer()) : null;
    },
    compensationDelete: async (key: string) => bucket.delete(key),
  };
  db.users.push({
    id: "admin",
    session_id: "session-id",
    username: "admin",
    display_name: null,
    avatar_url: null,
  });
  db.sessions.push({
    id: "session-id",
    user_id: "admin",
    token_hash: await sha256("human-session"),
    expires_at: "2099-01-01T00:00:00.000Z",
  });
  db.members.push(
    { project_id: "p", user_id: "admin", role: "ADMIN" },
    { project_id: "p", user_id: "editor", role: "EDITOR" },
    { project_id: "p", user_id: "viewer", role: "VIEWER" },
  );
  const commit = "a".repeat(40);
  const graphBytes = new TextEncoder().encode(JSON.stringify(standardGraph(commit)));
  const graphChecksum = await sha256Bytes(graphBytes);
  const publication = "publication-00000000000000000000";
  const graphKey = `projects/p/graphs/v/1/attempts/1/${publication}/graph.json`;
  db.graph = {
    id: "g",
    project_id: "p",
    version: 1,
    repository_provider: "github",
    provider_repository_id: "repo-1",
    repository_owner: "owner",
    repository_name: "repo",
    repository_canonical_url: "github.com/owner/repo",
    source_commit_sha: commit,
    graphify_version: GRAPH_BUILD_IDENTITY.graphifyVersion,
    adapter_version: GRAPH_BUILD_IDENTITY.adapterVersion,
    profile: GRAPH_BUILD_IDENTITY.profile,
    format_version: 1,
    generator: GRAPH_BUILD_IDENTITY.generator,
    status: "READY",
    attempt: 1,
    storage_layout: "ATTEMPT_V2",
    selected_publication_id: publication,
    storage_key: graphKey,
    checksum: graphChecksum,
    byte_size: graphBytes.byteLength,
    node_count: 1,
    link_count: 0,
    hyperedge_count: 0,
    generated_by: "runner",
    published_attempt: 1,
    published_lease_id: "lease-000000000000000000000000000",
    generated_at: "2026-01-01T00:00:00.000Z",
    repository_matches: true,
  };
  bucket.objects.set(graphKey, {
    bytes: graphBytes,
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      contentType: "application/json",
      checksum: graphChecksum,
      uploadId: publication,
    },
  });
  const artifactBytes = new TextEncoder().encode("baseline\n");
  const artifactChecksum = await sha256Bytes(artifactBytes);
  const artifactKey = "projects/p/artifacts/a1/v/1/content";
  db.artifacts.push(
    { id: "a1", project_id: "p", type: "architecture" },
    { id: "foreign", project_id: "other", type: "architecture" },
  );
  db.versions.push({
    artifact_id: "a1",
    version: 1,
    storage_key: artifactKey,
    checksum: artifactChecksum,
    content_type: "text/plain",
    byte_size: artifactBytes.byteLength,
    source_commit_sha: commit,
    change_note: "initial baseline",
    created_by: "admin",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  bucket.objects.set(artifactKey, {
    bytes: artifactBytes,
    httpMetadata: { contentType: "text/plain" },
    customMetadata: {
      contentType: "text/plain",
      checksum: artifactChecksum,
      uploadId: "artifact-upload",
    },
  });
}

function request(
  path: string,
  method = "GET",
  body?: unknown,
  origin = "https://web.example",
  authenticated = false,
) {
  return new Request(`https://api.example${path}`, {
    method,
    headers: {
      origin,
      ...(authenticated ? { cookie: `${SESSION_COOKIE}=human-session` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function createBody(overrides: Row = {}) {
  return {
    name: "Feature baseline",
    gitSha: "a".repeat(40),
    graphVersion: 1,
    artifacts: [{ artifactId: "a1", version: 1 }],
    idempotencyKey: "request-1",
    ...overrides,
  };
}

beforeEach(setup);

describe("immutable snapshots", () => {
  it("creates, lists, inspects, and retrieves an exact canonical manifest for ADMIN and EDITOR", async () => {
    for (const actor of ["admin", "editor"]) {
      const created = await handleSnapshotRoute(
        request("/projects/p/snapshots", "POST", createBody({ idempotencyKey: actor })),
        { DB: db as any, WEB_ORIGIN: "https://web.example" },
        storage,
        { id: actor },
        "p",
      );
      assert.equal(created.status, 201);
      const body = (await created.json()) as any;
      const id = body.snapshot.id;
      assert.equal(db.events.at(-1)?.outcome, "SUCCESS");
      const inspected = await handleSnapshotRoute(
        request(`/projects/p/snapshots/${id}`),
        { DB: db as any },
        storage,
        { id: "viewer" },
        "p",
        id,
      );
      assert.equal(inspected.status, 200);
      const retrieved = await handleSnapshotRoute(
        request(`/projects/p/snapshots/${id}/manifest`),
        { DB: db as any },
        storage,
        { id: "viewer" },
        "p",
        id,
        true,
      );
      assert.equal(retrieved.status, 200);
      assert.equal(retrieved.headers.get("cache-control"), "private, immutable");
      const manifest = JSON.parse(await retrieved.text());
      assert.equal(manifest.gitSha, "a".repeat(40));
      assert.equal(manifest.artifacts[0].checksum, db.versions[0]?.checksum);
      assert.equal(manifest.artifacts[0].type, "architecture");
      assert.equal(manifest.artifacts[0].changeNote, "initial baseline");
      assert.equal("storageKey" in manifest.graph, false);
    }
    const listed = await handleSnapshotRoute(
      request("/projects/p/snapshots?limit=1"),
      { DB: db as any },
      storage,
      { id: "viewer" },
      "p",
    );
    const body = (await listed.json()) as any;
    assert.equal(body.snapshots.length, 1);
    assert.ok(body.nextCursor);
  });

  it("keeps exact old references reproducible after newer graph and artifact metadata exists", async () => {
    const created = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody()),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    const id = ((await created.json()) as any).snapshot.id;
    db.versions.push({ ...db.versions[0], version: 2, checksum: "f".repeat(64) });
    const retrieved = await handleSnapshotRoute(
      request(`/projects/p/snapshots/${id}/manifest`),
      { DB: db as any },
      storage,
      { id: "admin" },
      "p",
      id,
      true,
    );
    assert.equal(retrieved.status, 200);
    assert.equal(JSON.parse(await retrieved.text()).artifacts[0].version, 1);
  });

  it("enforces role and nonleaking direct-project isolation before storage access", async () => {
    assert.equal(
      (
        await handleSnapshotRoute(
          request("/projects/p/snapshots", "POST", createBody()),
          { DB: db as any, WEB_ORIGIN: "https://web.example" },
          storage,
          { id: "viewer" },
          "p",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handleSnapshotRoute(
          request("/projects/p/snapshots"),
          { DB: db as any },
          storage,
          { id: "outsider" },
          "p",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await handleSnapshotRoute(
          request("/projects/p/snapshots"),
          { DB: db as any },
          storage,
          { id: "workspace-only" },
          "p",
        )
      ).status,
      404,
    );
  });

  it("rejects malformed, duplicate, cross-project, mismatched, and corrupt references with truthful audits", async () => {
    for (const body of [
      createBody({ gitSha: "A".repeat(40) }),
      createBody({ gitSha: "b".repeat(40) }),
      createBody({
        artifacts: [
          { artifactId: "a1", version: 1 },
          { artifactId: "a1", version: 1 },
        ],
      }),
      createBody({ artifacts: [{ artifactId: "foreign", version: 1 }] }),
      createBody({ graphVersion: 2 }),
    ]) {
      const response = await handleSnapshotRoute(
        request("/projects/p/snapshots", "POST", body),
        { DB: db as any, WEB_ORIGIN: "https://web.example" },
        storage,
        { id: "admin" },
        "p",
      );
      assert.equal(response.status, 400);
      assert.equal(db.events.at(-1)?.outcome, "REJECTED");
    }
    bucket.objects.get(db.versions[0]?.storage_key)?.bytes.fill(0);
    const corrupt = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody({ idempotencyKey: "corrupt" })),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    assert.equal(corrupt.status, 400);

    await setup();
    bucket.objects.get(db.graph?.storage_key)?.bytes.fill(0);
    const corruptGraph = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody({ idempotencyKey: "corrupt-graph" })),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    assert.equal(corruptGraph.status, 400);
    assert.equal(db.events.at(-1)?.reason, "INVALID_GRAPH_REFERENCE");
  });

  it("handles collision, adopts an ambiguous matching write, and compensates D1 failure", async () => {
    bucket.collide = true;
    const collision = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody({ idempotencyKey: "collision" })),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    assert.equal(collision.status, 409);
    assert.equal(db.events.at(-1)?.reason, "STORAGE_COLLISION");
    bucket.collide = false;
    bucket.throwAfterPut = true;
    const adopted = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody()),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    assert.equal(adopted.status, 201);
    db.failBatch = true;
    const failed = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody({ idempotencyKey: "d1-failure" })),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    assert.equal(failed.status, 500);
    assert.equal(bucket.deletes.length, 1);

    db.failSuccessAudit = true;
    const auditFailed = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody({ idempotencyKey: "audit-failure" })),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    assert.equal(auditFailed.status, 500);
    assert.equal(
      db.snapshots.some((row) => row.idempotency_key === "audit-failure"),
      false,
    );
    assert.equal(
      db.refs.some((row) =>
        db.snapshots.some(
          (snapshot) =>
            snapshot.id === row.snapshot_id && snapshot.idempotency_key === "audit-failure",
        ),
      ),
      false,
    );
    assert.equal(bucket.deletes.length, 2);
  });

  it("never compensates adopted exact bytes after a D1 failure", async () => {
    for (const mode of ["collision", "ambiguous"] as const) {
      await setup();
      db.failBatch = true;
      if (mode === "collision") bucket.collisionWithInput = true;
      else bucket.throwAfterPut = true;
      const response = await handleSnapshotRoute(
        request("/projects/p/snapshots", "POST", createBody({ idempotencyKey: mode })),
        { DB: db as any, WEB_ORIGIN: "https://web.example" },
        storage,
        { id: "admin" },
        "p",
      );
      assert.equal(response.status, 500);
      assert.equal(bucket.deletes.length, 0);
      assert.equal(
        [...bucket.objects.keys()].some((key) => key.includes("/snapshots/")),
        true,
      );
    }
  });

  it("retains request-created bytes when a concurrent D1 reference wins before delete", async () => {
    db.failBatch = true;
    db.beforeManifestReferenceCheck = (key) => {
      db.snapshots.push({ id: "concurrent", project_id: "p", manifest_storage_key: key });
    };
    const response = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody({ idempotencyKey: "concurrent" })),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    assert.equal(response.status, 500);
    assert.equal(bucket.deletes.length, 0);
    assert.equal(
      [...bucket.objects.keys()].some((key) => key.includes("/snapshots/")),
      true,
    );
  });

  it("retains an orphan when compensation publication status or storage integrity is uncertain", async () => {
    let manifestHeads = 0;
    const uncertainStorage = {
      ...storage,
      head: async (key: string) => {
        if (key.includes("/snapshots/") && ++manifestHeads > 1)
          throw new Error("uncertain compensation HEAD");
        return storage.head(key);
      },
    };
    db.failBatch = true;
    const response = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody({ idempotencyKey: "orphan" })),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      uncertainStorage,
      { id: "admin" },
      "p",
    );
    assert.equal(response.status, 500);
    assert.equal(bucket.deletes.length, 0);
    assert.equal(
      [...bucket.objects.keys()].some((key) => key.includes("/snapshots/")),
      true,
    );
  });

  it("revalidates every idempotent replay, list, and inspect against all immutable bytes", async () => {
    const corruptions: Array<[string, () => void]> = [
      ["missing graph", () => bucket.objects.delete(db.graph?.storage_key)],
      ["corrupt graph", () => bucket.objects.get(db.graph?.storage_key)?.bytes.fill(0)],
      ["missing artifact", () => bucket.objects.delete(db.versions[0]?.storage_key)],
      ["corrupt artifact", () => bucket.objects.get(db.versions[0]?.storage_key)?.bytes.fill(0)],
      [
        "changed artifact type",
        () => {
          const artifact = db.artifacts.find((row) => row.id === "a1");
          if (artifact) artifact.type = "adr";
        },
      ],
      [
        "missing manifest",
        () => {
          const snapshot = db.snapshots[0];
          if (snapshot) bucket.objects.delete(snapshot.manifest_storage_key);
        },
      ],
      [
        "corrupt manifest",
        () => {
          const snapshot = db.snapshots[0];
          if (snapshot) bucket.objects.get(snapshot.manifest_storage_key)?.bytes.fill(0);
        },
      ],
    ];
    for (const [label, corrupt] of corruptions) {
      await setup();
      const created = await handleSnapshotRoute(
        request("/projects/p/snapshots", "POST", createBody()),
        { DB: db as any, WEB_ORIGIN: "https://web.example" },
        storage,
        { id: "admin" },
        "p",
      );
      const id = ((await created.json()) as any).snapshot.id;
      corrupt();
      const responses = [
        await handleSnapshotRoute(
          request("/projects/p/snapshots", "POST", createBody()),
          { DB: db as any, WEB_ORIGIN: "https://web.example" },
          storage,
          { id: "admin" },
          "p",
        ),
        await handleSnapshotRoute(
          request("/projects/p/snapshots"),
          { DB: db as any },
          storage,
          { id: "viewer" },
          "p",
        ),
        await handleSnapshotRoute(
          request(`/projects/p/snapshots/${id}`),
          { DB: db as any },
          storage,
          { id: "viewer" },
          "p",
          id,
        ),
      ];
      assert.deepEqual(
        responses.map((response) => response.status),
        [500, 500, 500],
        label,
      );
    }
  });

  it("uses D1 authoritative time even when it differs from the Worker clock", async () => {
    db.now = "1901-02-03T04:05:06.007Z";
    const created = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody()),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    assert.equal(created.status, 201);
    assert.equal(db.snapshots[0]?.created_at, db.now);
    assert.equal(db.events[0]?.created_at, db.now);

    const rejected = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody({ gitSha: "invalid" })),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    assert.equal(rejected.status, 400);
    assert.equal(db.events.at(-1)?.created_at, db.now);
  });

  it("fails closed when a stored manifest or captured reference no longer verifies", async () => {
    const created = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody()),
      { DB: db as any, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "admin" },
      "p",
    );
    const id = ((await created.json()) as any).snapshot.id;
    const manifestKey = db.snapshots[0]?.manifest_storage_key;
    bucket.objects.get(manifestKey)?.bytes.fill(0);
    assert.equal(
      (
        await handleSnapshotRoute(
          request(`/projects/p/snapshots/${id}/manifest`),
          { DB: db as any },
          storage,
          { id: "viewer" },
          "p",
          id,
          true,
        )
      ).status,
      500,
    );

    const manifest = bucket.objects.get(manifestKey);
    if (manifest) manifest.bytes = new TextEncoder().encode(`${JSON.stringify({})}\n`);
    db.versions.length = 0;
    assert.equal(
      (
        await handleSnapshotRoute(
          request(`/projects/p/snapshots/${id}/manifest`),
          { DB: db as any },
          storage,
          { id: "viewer" },
          "p",
          id,
          true,
        )
      ).status,
      500,
    );
  });

  it("enforces origin, method, media type, request size, idempotency, and authentication routing", async () => {
    const env = { DB: db as any, OBJECTS: bucket as any, WEB_ORIGIN: "https://web.example" };
    assert.equal(
      (
        await handleSnapshotRoute(
          request("/projects/p/snapshots", "POST", createBody(), "https://evil.example"),
          env,
          storage,
          { id: "admin" },
          "p",
        )
      ).status,
      403,
    );
    const wrongType = new Request("https://api.example/projects/p/snapshots", {
      method: "POST",
      headers: { origin: "https://web.example", "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(
      (await handleSnapshotRoute(wrongType, env, storage, { id: "admin" }, "p")).status,
      400,
    );
    const first = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody()),
      env,
      storage,
      { id: "admin" },
      "p",
    );
    const replay = await handleSnapshotRoute(
      request("/projects/p/snapshots", "POST", createBody()),
      env,
      storage,
      { id: "admin" },
      "p",
    );
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as any).idempotent, true);
    const oversized = new Request("https://api.example/projects/p/snapshots", {
      method: "POST",
      headers: { origin: "https://web.example", "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(33 * 1024) }),
    });
    assert.equal(
      (await handleSnapshotRoute(oversized, env, storage, { id: "admin" }, "p")).status,
      413,
    );
    assert.equal(
      (
        await handleSnapshotRoute(
          request("/projects/p/snapshots?limit=101"),
          env,
          storage,
          { id: "admin" },
          "p",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await handleSnapshotRoute(
          request("/projects/p/snapshots?cursor=bad!"),
          env,
          storage,
          { id: "admin" },
          "p",
        )
      ).status,
      400,
    );
    assert.equal(
      (await createApp().fetch(request("/projects/p/snapshots"), env as any)).status,
      401,
    );
    const method = await createApp().fetch(
      request("/projects/p/snapshots", "DELETE", undefined, "https://web.example", true),
      env as any,
    );
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET, POST");
    const routedCreate = await createApp().fetch(
      request(
        "/projects/p/snapshots",
        "POST",
        createBody({ idempotencyKey: "routed-create" }),
        "https://web.example",
        true,
      ),
      env as any,
    );
    assert.equal(routedCreate.status, 201);
  });
});
