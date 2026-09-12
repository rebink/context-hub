/* biome-ignore-all lint/suspicious/noExplicitAny: Focused structural Cloudflare fakes. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphRow } from "../src/graphs.js";
import { createApp, type Env } from "../src/index.js";
import type { ObjectStorage, ObjectStorageMetadata } from "../src/object-storage.js";
import { sha256Bytes } from "../src/security.js";
import { handleSyncRoute } from "../src/sync.js";

const commit = "a".repeat(40);
const graphBytes = new TextEncoder().encode(
  JSON.stringify({
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [
      {
        id: "node",
        label: "node",
        file_type: "typescript",
        source_file: "src/index.ts",
        source_location: "L1",
      },
    ],
    links: [],
    hyperedges: [],
    built_at_commit: commit,
  }),
);

function graphRow(checksum: string): GraphRow {
  return {
    id: "graph-id",
    project_id: "project-a",
    version: 2,
    repository_provider: "github",
    provider_repository_id: "repo-1",
    repository_owner: "owner",
    repository_name: "repo",
    repository_canonical_url: "github.com/owner/repo",
    source_commit_sha: commit,
    graphify_version: "0.9.58",
    adapter_version: "1.0.0",
    profile: "code-only-clustered-v1",
    format_version: 1,
    generator: "graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1",
    status: "READY",
    attempt: 1,
    storage_layout: "ATTEMPT_V2",
    selected_publication_id: "publication",
    lease_id: null,
    lease_expires_at: null,
    failure_category: null,
    storage_key: "private-key",
    checksum,
    byte_size: graphBytes.byteLength,
    node_count: 1,
    link_count: 0,
    hyperedge_count: 0,
    generated_by: "runner",
    published_attempt: 1,
    published_lease_id: "lease",
    queued_at: "2026-01-01T00:00:00.000Z",
    build_started_at: "2026-01-01T00:00:00.000Z",
    failed_at: null,
    generated_at: "2026-01-01T00:00:01.000Z",
    superseded_at: null,
    updated_at: "2026-01-01T00:00:01.000Z",
    orphan_observed_at: null,
    orphan_attempt: null,
    orphan_lease_id: null,
    orphan_checksum: null,
    orphan_byte_size: null,
    orphan_cleanup_id: null,
    orphan_cleanup_expires_at: null,
  };
}

class SyncD1 {
  member = true;
  repositoryId = "repo-1";
  repositoryUrl = "github.com/owner/repo";
  row: GraphRow | null = null;
  prepare(sql: string) {
    return {
      bind: (...args: any[]) => ({
        first: async () => {
          if (sql.includes("FROM projects p")) {
            if (!this.member || args[1] !== "project-a") return null;
            return {
              provider: "github",
              provider_repository_id: this.repositoryId,
              owner: "owner",
              repository_name: "repo",
              canonical_url: this.repositoryUrl,
              default_branch: "main",
              last_known_commit_sha: commit,
            };
          }
          if (sql.includes("FROM graph_versions")) {
            if (
              !this.row ||
              args[0] !== this.row.project_id ||
              args[1] !== this.row.repository_provider ||
              args[2] !== this.row.provider_repository_id ||
              args[3] !== this.row.repository_canonical_url
            )
              return null;
            if (sql.includes("version = ?") && args[4] !== this.row.version) return null;
            return this.row;
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      }),
    };
  }
}

class Storage implements ObjectStorage {
  corrupt = false;
  constructor(private checksum: string) {}
  async createOnly(
    _key: string,
    _bytes: Uint8Array<ArrayBuffer>,
    _metadata: ObjectStorageMetadata,
  ): Promise<"created" | "collision"> {
    throw new Error("unused");
  }
  async head() {
    return {
      byteSize: graphBytes.byteLength,
      httpContentType: "application/json",
      metadata: {
        checksum: this.checksum,
        contentType: "application/json",
        uploadId: "publication",
      },
    };
  }
  async getBytes() {
    return this.corrupt ? new Uint8Array(graphBytes.byteLength) : graphBytes;
  }
  async compensationDelete() {
    throw new Error("unused");
  }
}

describe("local sync Worker routes", () => {
  it("returns only bounded project sync metadata to a direct member", async () => {
    const checksum = await sha256Bytes(graphBytes);
    const db = new SyncD1();
    db.row = graphRow(checksum);
    const response = await handleSyncRoute(
      new Request("https://api.example/projects/project-a/sync"),
      { DB: db as any },
      new Storage(checksum),
      { id: "member" },
      "project-a",
    );
    assert.equal(response.status, 200);
    const body = await response.json<any>();
    assert.equal(body.readyGraph.version, 2);
    assert.equal(body.repository.remoteCommitSha, commit);
    assert.equal(JSON.stringify(body).includes("private-key"), false);
    assert.equal(JSON.stringify(body).includes("publication"), false);
    assert.equal(body.readyGraph.repository.providerRepositoryId, "repo-1");
  });

  it("does not expose graphs from a replaced repository connection", async () => {
    const checksum = await sha256Bytes(graphBytes);
    const db = new SyncD1();
    db.row = graphRow(checksum);
    db.repositoryId = "repo-2";
    db.repositoryUrl = "github.com/owner/replacement";
    const response = await handleSyncRoute(
      new Request("https://api.example/projects/project-a/sync"),
      { DB: db as any },
      new Storage(checksum),
      { id: "member" },
      "project-a",
    );
    assert.equal(response.status, 200);
    const body = await response.json<any>();
    assert.equal(body.newestGraph, null);
    assert.equal(body.readyGraph, null);

    const download = await handleSyncRoute(
      new Request("https://api.example/projects/project-a/sync/graph/2"),
      { DB: db as any },
      new Storage(checksum),
      { id: "member" },
      "project-a",
      "2",
    );
    assert.equal(download.status, 404);
  });

  it("downloads exact validated bytes without a storage key or direct URL", async () => {
    const checksum = await sha256Bytes(graphBytes);
    const db = new SyncD1();
    db.row = graphRow(checksum);
    const response = await handleSyncRoute(
      new Request("https://api.example/projects/project-a/sync/graph/2"),
      { DB: db as any },
      new Storage(checksum),
      { id: "member" },
      "project-a",
      "2",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), graphBytes);
    assert.equal(response.headers.get("x-context-checksum-sha256"), checksum);
    assert.equal(response.headers.has("x-context-storage-key"), false);
  });

  it("fails closed for outsiders, other projects, and corrupt private objects", async () => {
    const checksum = await sha256Bytes(graphBytes);
    const db = new SyncD1();
    db.row = graphRow(checksum);
    db.member = false;
    const outsider = await handleSyncRoute(
      new Request("https://api.example/projects/project-a/sync"),
      { DB: db as any },
      new Storage(checksum),
      { id: "outsider" },
      "project-a",
    );
    assert.equal(outsider.status, 404);

    db.member = true;
    const isolated = await handleSyncRoute(
      new Request("https://api.example/projects/project-b/sync/graph/2"),
      { DB: db as any },
      new Storage(checksum),
      { id: "member" },
      "project-b",
      "2",
    );
    assert.equal(isolated.status, 404);

    const storage = new Storage(checksum);
    storage.corrupt = true;
    const corrupt = await handleSyncRoute(
      new Request("https://api.example/projects/project-a/sync/graph/2"),
      { DB: db as any },
      storage,
      { id: "member" },
      "project-a",
      "2",
    );
    assert.equal(corrupt.status, 500);
    assert.deepEqual(await corrupt.json(), { error: "STORAGE_INTEGRITY_ERROR" });
  });

  it("requires authentication at the public router", async () => {
    const response = await createApp().fetch(
      new Request("https://api.example/projects/project-a/sync"),
      { DB: {} as D1Database, OBJECTS: {} as R2Bucket } as Env,
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
  });
});
