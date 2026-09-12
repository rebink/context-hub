import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRAPH_BUILD_IDENTITY } from "../src/graphs.js";
import { handleMachineGraphRoute } from "../src/machine-graphs.js";
import type {
  ObjectStorage,
  ObjectStorageMetadata,
  StoredObjectMetadata,
} from "../src/object-storage.js";
import { sha256, sha256Bytes } from "../src/security.js";

const projectId = "project-one";
const version = "1";
const credentialId = "11111111-1111-4111-8111-111111111111";
const secret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const commit = "b".repeat(40);

type Attempt = Record<string, any>;

class Statement {
  args: unknown[] = [];
  constructor(
    private readonly db: MachineD1,
    private readonly sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async run() {
    return { success: true, meta: { changes: await this.db.run(this.sql, this.args) } } as D1Result;
  }
  async first<T>() {
    return (await this.db.first(this.sql, this.args)) as T | null;
  }
}

class MachineD1 {
  active = true;
  nonces = new Set<string>();
  deniedAudits = 0;
  failedAudits = 0;
  attempt: Attempt | null = null;
  graph: Record<string, any> = {
    project_id: projectId,
    version: 1,
    attempt: 1,
    repository_provider: "github",
    provider_repository_id: "repo-1",
    repository_owner: "owner",
    repository_name: "repository",
    repository_canonical_url: "github.com/owner/repository",
    source_commit_sha: commit,
    graphify_version: GRAPH_BUILD_IDENTITY.graphifyVersion,
    adapter_version: GRAPH_BUILD_IDENTITY.adapterVersion,
    profile: GRAPH_BUILD_IDENTITY.profile,
    format_version: GRAPH_BUILD_IDENTITY.formatVersion,
    generator: GRAPH_BUILD_IDENTITY.generator,
    status: "QUEUED",
    storage_layout: "ATTEMPT_V2",
    lease_id: null,
    lease_expires_at: null,
    selected_publication_id: null,
    storage_key: null,
    checksum: null,
    byte_size: null,
    node_count: null,
    link_count: null,
    hyperedge_count: null,
    generated_by: null,
    published_attempt: null,
    published_lease_id: null,
    generated_at: null,
  };

  prepare(sql: string) {
    return new Statement(this, sql);
  }

  async run(sql: string, _args: unknown[]) {
    if (sql.includes("DELETE FROM machine_request_nonces")) return 0;
    if (sql.includes("UPDATE graph_versions SET status='QUEUED'")) {
      if (this.graph.status !== "FAILED" || this.graph.failure_category !== "LEASE_EXPIRED")
        return 0;
      Object.assign(this.graph, {
        status: "QUEUED",
        attempt: this.graph.attempt + 1,
        failure_category: null,
        failed_at: null,
        build_started_at: null,
      });
      return 1;
    }
    if (sql.includes("INSERT INTO machine_audit_events")) {
      if (sql.includes("'DENIED'")) this.deniedAudits += 1;
      if (sql.includes("'FAILED'")) this.failedAudits += 1;
      return 1;
    }
    return 0;
  }

  async first(sql: string, args: unknown[]) {
    if (sql.includes("INSERT INTO machine_request_nonces")) {
      const [
        nonceHash,
        operation,
        tokenId,
        tokenHash,
        project,
        provider,
        repositoryId,
        requestedVersion,
        sourceCommit,
      ] = args;
      const valid =
        this.active &&
        ["CLAIM", "PUBLISH", "FAIL"].includes(operation as string) &&
        tokenId === credentialId &&
        tokenHash === (await sha256(secret)) &&
        project === projectId &&
        provider === "github" &&
        repositoryId === "repo-1" &&
        requestedVersion === 1 &&
        sourceCommit === commit &&
        !this.nonces.has(nonceHash as string);
      if (!valid) return null;
      this.nonces.add(nonceHash as string);
      return {
        principal_id: "principal-1",
        credential_id: credentialId,
        project_id: projectId,
        repository_provider: "github",
        provider_repository_id: "repo-1",
      };
    }
    if (
      sql.includes(
        "UPDATE graph_build_attempts SET status='FAILED', failure_category='LEASE_EXPIRED'",
      )
    ) {
      if (!this.attempt || this.attempt.status !== "BUILDING" || !this.attempt.expired) return null;
      Object.assign(this.attempt, { status: "FAILED", failure_category: "LEASE_EXPIRED" });
      Object.assign(this.graph, { status: "FAILED", failure_category: "LEASE_EXPIRED" });
      return { graph_version: 1 };
    }
    if (sql.includes("INSERT INTO graph_build_attempts")) {
      if (
        this.graph.status !== "QUEUED" ||
        (this.attempt && this.attempt.attempt === this.graph.attempt)
      )
        return null;
      this.attempt = {
        project_id: projectId,
        graph_version: 1,
        attempt: this.graph.attempt,
        publication_id: args[0],
        storage_key: `projects/${projectId}/graphs/v/1/attempts/${this.graph.attempt}/${args[0]}/graph.json`,
        status: "BUILDING",
        lease_id: args[2],
        lease_expires_at: args[3],
        claimed_by: args[4],
        claimed_at: args[5],
        checksum: null,
        byte_size: null,
        content_type: null,
        node_count: null,
        link_count: null,
        hyperedge_count: null,
        generated_by: null,
      };
      Object.assign(this.graph, {
        status: "BUILDING",
        lease_id: args[2],
        lease_expires_at: args[3],
      });
      return this.attempt;
    }
    if (sql.includes("SELECT gv.* FROM graph_versions gv JOIN graph_build_attempts")) {
      return this.attempt &&
        this.attempt.attempt === args[2] &&
        this.attempt.lease_id === args[3] &&
        this.attempt.publication_id === args[4] &&
        this.attempt.storage_key === args[5] &&
        this.attempt.claimed_by === args[6]
        ? this.graph
        : null;
    }
    if (sql.includes("SELECT * FROM graph_build_attempts WHERE project_id=?")) {
      return this.attempt &&
        this.attempt.attempt === args[2] &&
        this.attempt.lease_id === args[3] &&
        this.attempt.publication_id === args[4] &&
        this.attempt.storage_key === args[5]
        ? this.attempt
        : null;
    }
    if (sql.includes("UPDATE graph_build_attempts SET checksum=?")) {
      if (!this.attempt || this.attempt.status !== "BUILDING") return null;
      Object.assign(this.attempt, {
        checksum: args[0],
        byte_size: args[1],
        content_type: "application/json",
        node_count: args[2],
        link_count: args[3],
        hyperedge_count: args[4],
        generated_by: this.attempt.claimed_by,
      });
      return { graph_version: 1 };
    }
    if (sql.includes("UPDATE graph_build_attempts SET status='PUBLISHED'")) {
      if (!this.attempt || this.attempt.status !== "BUILDING") return null;
      Object.assign(this.attempt, {
        status: "PUBLISHED",
        checksum: args[0],
        byte_size: args[1],
        content_type: "application/json",
        node_count: args[2],
        link_count: args[3],
        hyperedge_count: args[4],
        generated_by: this.attempt.claimed_by,
        published_at: args[5],
      });
      Object.assign(this.graph, {
        status: "READY",
        lease_id: null,
        lease_expires_at: null,
        selected_publication_id: this.attempt.publication_id,
        storage_key: this.attempt.storage_key,
        checksum: this.attempt.checksum,
        byte_size: this.attempt.byte_size,
        node_count: this.attempt.node_count,
        link_count: this.attempt.link_count,
        hyperedge_count: this.attempt.hyperedge_count,
        generated_by: this.attempt.claimed_by,
        published_attempt: this.attempt.attempt,
        published_lease_id: this.attempt.lease_id,
        generated_at: this.attempt.published_at,
      });
      return this.attempt;
    }
    if (sql.includes("UPDATE graph_build_attempts SET status='FAILED'")) {
      if (!this.attempt || this.attempt.status !== "BUILDING") return null;
      Object.assign(this.attempt, { status: "FAILED", failure_category: args[0] });
      Object.assign(this.graph, { status: "FAILED", failure_category: args[0] });
      return { graph_version: 1 };
    }
    if (sql.includes("SELECT * FROM graph_versions WHERE project_id")) return this.graph;
    return null;
  }
}

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; metadata: ObjectStorageMetadata }>();
  async createOnly(key: string, bytes: Uint8Array<ArrayBuffer>, metadata: ObjectStorageMetadata) {
    if (this.objects.has(key)) return "collision" as const;
    this.objects.set(key, { bytes, metadata });
    return "created" as const;
  }
  async head(key: string): Promise<StoredObjectMetadata | null> {
    const value = this.objects.get(key);
    return value
      ? {
          byteSize: value.bytes.byteLength,
          httpContentType: value.metadata.contentType,
          metadata: value.metadata,
        }
      : null;
  }
  async getBytes(): Promise<Uint8Array<ArrayBuffer> | null> {
    return null;
  }
  async compensationDelete(key: string) {
    this.objects.delete(key);
  }
}

function request(
  operation: "claim" | "publish" | "fail",
  nonce: string,
  init: { claim?: Record<string, string>; body?: BodyInit; headers?: Record<string, string> } = {},
) {
  return new Request(`https://api.example/machine/projects/${projectId}/graphs/1/${operation}`, {
    method: operation === "publish" ? "PUT" : "POST",
    headers: {
      authorization: `Bearer chm_${credentialId}.${secret}`,
      "x-context-nonce": nonce,
      "x-context-repository-provider": "github",
      "x-context-repository-id": "repo-1",
      "x-context-source-commit": commit,
      ...init.claim,
      ...init.headers,
    },
    body: init.body,
  });
}

async function route(
  db: MachineD1,
  storage: ObjectStorage,
  operation: "claim" | "publish" | "fail",
  req: Request,
) {
  return handleMachineGraphRoute(
    req,
    { DB: db as unknown as D1Database },
    storage,
    projectId,
    version,
    operation,
  );
}

async function claim(
  db: MachineD1,
  storage = new MemoryStorage(),
  nonce = "nonce_1234567890123456",
) {
  return route(db, storage, "claim", request("claim", nonce));
}

function graphBytes() {
  return new TextEncoder().encode(
    JSON.stringify({
      directed: false,
      multigraph: false,
      graph: {},
      nodes: [
        {
          id: "a",
          label: "Alpha",
          file_type: "ts",
          source_file: "src/a.ts",
          source_location: "L1",
        },
        {
          id: "b",
          label: "Beta",
          file_type: "ts",
          source_file: "src/b.ts",
          source_location: "L2",
        },
      ],
      links: [
        {
          source: "a",
          target: "b",
          relation: "CALLS",
          confidence: "EXTRACTED",
          confidence_score: 1,
          weight: 1,
          source_file: "src/a.ts",
          source_location: "L1",
        },
      ],
      hyperedges: [],
      built_at_commit: commit,
    }),
  );
}

async function claimHeaders(response: Response) {
  const body = (await response.json()) as {
    claim: { attempt: number; leaseId: string; publicationId: string };
  };
  return {
    "x-context-attempt": String(body.claim.attempt),
    "x-context-lease-id": body.claim.leaseId,
    "x-context-publication-id": body.claim.publicationId,
  };
}

describe("machine graph transport", () => {
  it("claims queued work with exact credential/project/repository/commit binding", async () => {
    const response = await claim(new MachineD1());
    assert.equal(response.status, 200);
    const body = (await response.json()) as { build: { sourceCommitSha: string } };
    assert.equal(body.build.sourceCommitSha, commit);
  });

  it("rejects replay, wrong bindings, inactive credentials, and human cookies without disclosure", async () => {
    const db = new MachineD1();
    assert.equal((await claim(db)).status, 200);
    const replay = await claim(db);
    assert.equal(replay.status, 401);
    assert.deepEqual(await replay.json(), { error: "INVALID_CREDENTIAL" });
    assert.equal(db.deniedAudits, 1);

    const invalidBindings: Record<string, string>[] = [
      { "x-context-repository-id": "repo-2" },
      { "x-context-source-commit": "c".repeat(40) },
    ];
    for (const headers of invalidBindings) {
      const denied = await route(
        db,
        new MemoryStorage(),
        "claim",
        request("claim", crypto.randomUUID().replaceAll("-", ""), { headers }),
      );
      assert.equal(denied.status, 401);
    }
    const inactive = new MachineD1();
    inactive.active = false;
    assert.equal((await claim(inactive)).status, 401);
    const cookie = new Request(`https://api.example/machine/projects/${projectId}/graphs/1/claim`, {
      method: "POST",
      headers: { cookie: "context_hub_session=human" },
    });
    assert.equal((await route(new MachineD1(), new MemoryStorage(), "claim", cookie)).status, 401);
  });

  it("publishes exact bytes, supports fresh-nonce replay, and rejects forged evidence", async () => {
    const db = new MachineD1();
    const storage = new MemoryStorage();
    const headers = await claimHeaders(await claim(db, storage));
    const bytes = graphBytes();
    const checksum = await sha256Bytes(bytes);
    const publishHeaders = {
      ...headers,
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
      "x-context-checksum-sha256": checksum,
      "x-context-node-count": "2",
      "x-context-link-count": "1",
      "x-context-hyperedge-count": "0",
    };
    const published = await route(
      db,
      storage,
      "publish",
      request("publish", "nonce_2234567890123456", { body: bytes, headers: publishHeaders }),
    );
    assert.equal(published.status, 200);
    assert.equal(db.graph.status, "READY");
    const replay = await route(
      db,
      storage,
      "publish",
      request("publish", "nonce_3234567890123456", { body: bytes, headers: publishHeaders }),
    );
    assert.equal(replay.status, 200);

    const forged = await route(
      db,
      storage,
      "publish",
      request("publish", "nonce_4234567890123456", {
        body: bytes,
        headers: { ...publishHeaders, "x-context-checksum-sha256": "0".repeat(64) },
      }),
    );
    assert.equal(forged.status, 400);
    assert.equal(db.failedAudits, 1);
  });

  it("separates fail authority, attempt identity, nonce, and concurrent claim ownership", async () => {
    const db = new MachineD1();
    const storage = new MemoryStorage();
    const claimResponse = await claim(db, storage);
    const headers = await claimHeaders(claimResponse);
    const badAttempt = await route(
      db,
      storage,
      "fail",
      request("fail", "nonce_5234567890123456", {
        body: JSON.stringify({ failureCategory: "RUNNER_FAILED" }),
        headers: { ...headers, "x-context-attempt": "2", "content-type": "application/json" },
      }),
    );
    assert.equal(badAttempt.status, 401);

    const failed = await route(
      db,
      storage,
      "fail",
      request("fail", "nonce_6234567890123456", {
        body: JSON.stringify({ failureCategory: "RUNNER_FAILED" }),
        headers: { ...headers, "content-type": "application/json" },
      }),
    );
    assert.equal(failed.status, 200);
    assert.equal(db.graph.status, "FAILED");

    const concurrent = new MachineD1();
    const [first, second] = await Promise.all([
      claim(concurrent, new MemoryStorage(), "nonce_7234567890123456"),
      claim(concurrent, new MemoryStorage(), "nonce_8234567890123456"),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  });

  it("reclaims an expired attempt with a distinct attempt before claiming", async () => {
    const db = new MachineD1();
    const first = await claim(db);
    assert.equal(first.status, 200);
    assert.ok(db.attempt);
    db.attempt.expired = true;
    const reclaimed = await claim(db, new MemoryStorage(), "nonce_9234567890123456");
    assert.equal(reclaimed.status, 200);
    assert.equal(db.graph.attempt, 2);
    assert.equal(db.attempt?.attempt, 2);
  });
});
