/* biome-ignore-all lint/suspicious/noExplicitAny: The fake models Cloudflare bindings structurally. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyArtifactFreshness } from "../src/artifact-freshness.js";
import { ContextAuthorizationFence } from "../src/context-authorization.js";
import { ContextEngine } from "../src/context-engine.js";
import type { ContextProvider } from "../src/context-provider.js";
import { GRAPH_BUILD_IDENTITY } from "../src/graphs.js";
import type { ObjectStorage, StoredObjectMetadata } from "../src/object-storage.js";
import { sha256Bytes } from "../src/security.js";

type Row = Record<string, any>;

class Statement {
  args: any[] = [];
  constructor(
    private readonly db: ContextD1,
    private readonly sql: string,
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
}

class ContextD1 {
  git: Row | null = null;
  artifacts: Row[] = [];
  graph: Row | null = null;
  prepare(sql: string) {
    return new Statement(this, sql);
  }
  first(sql: string, args: any[]): Row | null {
    if (sql.includes("SELECT 1 AS authorized")) return { authorized: 1 };
    if (sql.includes("FROM git_connections"))
      return this.git?.project_id === args[0] ? this.git : null;
    if (sql.includes("FROM graph_versions"))
      return this.graph?.project_id === args[0] &&
        this.graph?.repository_provider === args[1] &&
        this.graph?.provider_repository_id === args[2] &&
        this.graph?.repository_canonical_url === args[3]
        ? this.graph
        : null;
    throw new Error(`Unhandled first SQL: ${sql}`);
  }
  all(sql: string, args: any[]): Row[] {
    if (sql.includes("FROM artifacts a JOIN artifact_versions")) {
      assert.match(sql, /context_auth_p/);
      const firstFenceCount = args.findIndex((value) => typeof value === "number");
      const limit = args.at(-1) as number;
      const searchTerms = args.slice(firstFenceCount + 1, -1) as string[];
      return this.artifacts
        .filter((row) => row.project_id === args[0] && row.status === "ACTIVE")
        .sort((left, right) => {
          const score = (row: Row) => {
            const text = `${row.name} ${row.type} ${row.description ?? ""}`.toLowerCase();
            return searchTerms.filter((term) => text.includes(term)).length;
          };
          return score(right) - score(left) || right.updated_at.localeCompare(left.updated_at);
        })
        .slice(0, limit);
    }
    throw new Error(`Unhandled all SQL: ${sql}`);
  }
}

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; head: StoredObjectMetadata }>();
  failGet = new Set<string>();
  getCalls = new Map<string, number>();
  async createOnly() {
    return "created" as const;
  }
  async head(key: string) {
    return this.objects.get(key)?.head ?? null;
  }
  async getBytes(key: string) {
    this.getCalls.set(key, (this.getCalls.get(key) ?? 0) + 1);
    if (this.failGet.has(key)) throw new Error("injected read failure");
    return this.objects.get(key)?.bytes ?? null;
  }
  async compensationDelete() {}
}

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);

async function putArtifact(db: ContextD1, storage: MemoryStorage, values: Partial<Row> = {}) {
  const id = values.id ?? `artifact-${db.artifacts.length + 1}`;
  const content =
    values.content ?? "# Refund architecture\nRefundService retries failed gateway calls.";
  const objectBytes = new TextEncoder().encode(content);
  const checksum = await sha256Bytes(objectBytes);
  const key = `projects/p/artifacts/${id}/v/1/content`;
  storage.objects.set(key, {
    bytes: objectBytes,
    head: {
      byteSize: objectBytes.byteLength,
      httpContentType: "text/markdown",
      metadata: { contentType: "text/markdown", checksum, uploadId: "u" },
    },
  });
  db.artifacts.push({
    id,
    project_id: values.project_id ?? "p",
    type: values.type ?? "architecture",
    name: values.name ?? "Refund architecture",
    description: values.description ?? "payments refunds",
    version: 1,
    storage_key: key,
    checksum,
    content_type: "text/markdown",
    byte_size: objectBytes.byteLength,
    source_commit_sha: values.source_commit_sha === undefined ? commit : values.source_commit_sha,
    status: values.status ?? "ACTIVE",
    updated_at: values.updated_at ?? "2026-01-01T00:00:00.000Z",
  });
  return { id, key, checksum };
}

async function putGraph(db: ContextD1, storage: MemoryStorage) {
  const graph = {
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [
      {
        id: "refund",
        label: "RefundService",
        file_type: "ts",
        source_file: "src/refund.ts",
        source_location: "L12",
      },
      {
        id: "gateway",
        label: "PaymentGateway",
        file_type: "ts",
        source_file: "src/gateway.ts",
        source_location: "L4",
      },
    ],
    links: [
      {
        source: "refund",
        target: "gateway",
        relation: "CALLS",
        confidence: "EXTRACTED",
        confidence_score: 1,
        weight: 1,
        source_file: "src/refund.ts",
        source_location: "L18",
      },
    ],
    hyperedges: [],
    built_at_commit: commit,
  };
  const graphBytes = new TextEncoder().encode(JSON.stringify(graph));
  const checksum = await sha256Bytes(graphBytes);
  const publication = "p".repeat(32);
  const lease = "l".repeat(32);
  const key = `projects/p/graphs/v/1/attempts/1/${publication}/graph.json`;
  storage.objects.set(key, {
    bytes: graphBytes,
    head: {
      byteSize: graphBytes.byteLength,
      httpContentType: "application/json",
      metadata: { contentType: "application/json", checksum, uploadId: publication },
    },
  });
  db.graph = {
    id: "g",
    project_id: "p",
    version: 1,
    repository_provider: "github",
    provider_repository_id: "repo-1",
    repository_owner: "o",
    repository_name: "n",
    repository_canonical_url: "github.com/o/n",
    source_commit_sha: commit,
    ...GRAPH_BUILD_IDENTITY,
    graphify_version: GRAPH_BUILD_IDENTITY.graphifyVersion,
    adapter_version: GRAPH_BUILD_IDENTITY.adapterVersion,
    format_version: 1,
    status: "READY",
    attempt: 1,
    storage_layout: "ATTEMPT_V2",
    selected_publication_id: publication,
    lease_id: null,
    lease_expires_at: null,
    failure_category: null,
    storage_key: key,
    checksum,
    byte_size: graphBytes.byteLength,
    node_count: 2,
    link_count: 1,
    hyperedge_count: 0,
    generated_by: "runner",
    published_attempt: 1,
    published_lease_id: lease,
    queued_at: "2026-01-01T00:00:00.000Z",
    build_started_at: "2026-01-01T00:00:00.000Z",
    failed_at: null,
    generated_at: "2026-01-01T00:00:00.000Z",
    superseded_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    orphan_observed_at: null,
    orphan_attempt: null,
    orphan_lease_id: null,
    orphan_checksum: null,
    orphan_byte_size: null,
    orphan_cleanup_id: null,
    orphan_cleanup_expires_at: null,
  };
}

function setup() {
  const db = new ContextD1();
  const storage = new MemoryStorage();
  db.git = {
    project_id: "p",
    provider: "github",
    provider_repository_id: "repo-1",
    owner: "o",
    repository_name: "n",
    canonical_url: "github.com/o/n",
    default_branch: "main",
    last_known_commit_sha: commit,
    status: "VERIFIED",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const provider: ContextProvider = new ContextEngine(
    db as unknown as D1Database,
    storage,
    ContextAuthorizationFence.human(["p"], "user"),
  );
  return { db, storage, provider };
}

const input = {
  projectId: "p",
  query: "add refund retry support",
  domain: "payments",
  package: "src/refund",
  budget: { maxTokens: 2_000, maxBytes: 16_000 },
};

describe("artifact freshness", () => {
  it("classifies current, stale, missing, and invalid provenance", () => {
    assert.equal(classifyArtifactFreshness(commit, commit), "CURRENT");
    assert.equal(classifyArtifactFreshness(otherCommit, commit), "STALE");
    assert.equal(classifyArtifactFreshness(null, commit), "UNKNOWN");
    assert.equal(classifyArtifactFreshness("not-a-sha", commit), "UNKNOWN");
    assert.equal(classifyArtifactFreshness(commit, null), "UNKNOWN");
  });
});

describe("ContextProvider contract", () => {
  it("ranks bounded artifact and graph evidence with exact provenance", async () => {
    const { db, storage, provider } = setup();
    const artifact = await putArtifact(db, storage);
    await putArtifact(db, storage, {
      id: "unrelated",
      type: "runbook",
      name: "Database backup",
      description: "backup",
      content: "Restore database backups.",
    });
    await putGraph(db, storage);
    const result = await provider.search(input);
    assert.equal(result.evidence[0]?.kind, "ARTIFACT");
    const artifactEvidence = result.evidence.find((item) => item.kind === "ARTIFACT");
    assert.deepEqual(artifactEvidence?.provenance, {
      projectId: "p",
      source: "ARTIFACT",
      path: `artifacts/${artifact.id}`,
      section: null,
      version: "1",
      commit,
      checksum: artifact.checksum,
    });
    assert.equal(artifactEvidence?.freshness, "CURRENT");
    const graphEvidence = result.evidence.find((item) => item.kind === "GRAPH");
    assert.equal(graphEvidence?.provenance.path, "src/refund.ts");
    assert.equal(graphEvidence?.provenance.section, "L12");
    assert.equal(
      result.evidence.some((item) => item.title === "Database backup"),
      false,
    );
    assert.ok(result.byteSize <= input.budget.maxBytes);
    assert.ok(result.tokenEstimate <= input.budget.maxTokens);
    const independentlyEstimated = result.evidence.reduce(
      (total, item) =>
        total +
        Math.max(1, Math.ceil(new TextEncoder().encode(JSON.stringify(item)).byteLength / 4)),
      0,
    );
    assert.equal(result.tokenEstimate, independentlyEstimated);
  });

  it("deduplicates before one global budget and reports truncation", async () => {
    const { db, storage, provider } = setup();
    await putArtifact(db, storage, { id: "one" });
    await putArtifact(db, storage, { id: "two" });
    const result = await provider.search({ ...input, budget: { maxTokens: 32, maxBytes: 1_200 } });
    const excerpts = result.evidence.map((item) => item.excerpt);
    assert.equal(new Set(excerpts).size, excerpts.length);
    assert.equal(result.truncated, true);
    assert.ok(result.byteSize <= 1_200);
    assert.ok(result.tokenEstimate <= 32);
  });

  it("marks stale and unknown artifacts without inventing commit provenance", async () => {
    const { db, storage, provider } = setup();
    await putArtifact(db, storage, {
      id: "stale",
      source_commit_sha: otherCommit,
      content: "# Refund architecture\nStale refund retry design.",
    });
    await putArtifact(db, storage, {
      id: "unknown",
      source_commit_sha: "invalid",
      content: "# Refund architecture\nUnknown refund retry design.",
    });
    const result = await provider.search(input);
    assert.equal(
      result.evidence.find((item) => item.provenance.path === "artifacts/stale")?.freshness,
      "STALE",
    );
    const unknown = result.evidence.find((item) => item.provenance.path === "artifacts/unknown");
    assert.equal(unknown?.freshness, "UNKNOWN");
    assert.equal(unknown?.provenance.commit, null);
  });

  it("verifies artifact HEAD metadata before reading private bytes", async () => {
    const mutations: Array<
      (stored: { bytes: Uint8Array<ArrayBuffer>; head: StoredObjectMetadata }) => void
    > = [
      (stored) => {
        stored.head.byteSize += 1;
      },
      (stored) => {
        stored.head.httpContentType = "text/plain";
      },
      (stored) => {
        stored.head.metadata.contentType = "text/plain";
      },
      (stored) => {
        stored.head.metadata.checksum = "0".repeat(64);
      },
      (stored) => {
        stored.head.byteSize = 65 * 1024;
      },
    ];
    for (const mutate of mutations) {
      const { db, storage, provider } = setup();
      const artifact = await putArtifact(db, storage);
      const stored = storage.objects.get(artifact.key);
      assert.ok(stored);
      mutate(stored);
      const result = await provider.search(input);
      assert.equal(
        result.evidence.some((item) => item.kind === "ARTIFACT"),
        false,
      );
      assert.equal(result.sourceErrors.includes("ARTIFACT_SOURCE_UNAVAILABLE"), true);
      assert.equal(storage.getCalls.get(artifact.key) ?? 0, 0);
    }
  });

  it("excludes READY graphs from a replaced repository", async () => {
    const { db, storage, provider } = setup();
    await putGraph(db, storage);
    assert.ok(db.git);
    db.git.provider_repository_id = "replacement";
    db.git.canonical_url = "github.com/o/replacement";
    const result = await provider.search(input);
    assert.equal(
      result.evidence.some((item) => item.kind === "GRAPH"),
      false,
    );
    assert.equal(result.sourceErrors.includes("GRAPH_SOURCE_UNAVAILABLE"), false);
  });

  it("retrieves an older metadata-relevant artifact before the recent cap", async () => {
    const { db, storage, provider } = setup();
    for (let index = 0; index < 24; index += 1) {
      await putArtifact(db, storage, {
        id: `recent-${index}`,
        type: "runbook",
        name: `Database backup ${index}`,
        description: "unrelated operations",
        content: "Restore a database backup.",
        updated_at: `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    }
    await putArtifact(db, storage, {
      id: "older-refund",
      type: "architecture",
      name: "Refund retry architecture",
      description: "payments refund retry",
      content: "RefundService retry details.",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    const result = await provider.search(input);
    assert.equal(
      result.evidence.some((item) => item.provenance.path === "artifacts/older-refund"),
      true,
    );
  });

  it("uses truthful built-in provenance for synthesized reference guidance", async () => {
    const { provider } = setup();
    const result = await provider.search({ ...input, query: "membership immutable payloads" });
    const reference = result.evidence.find((item) => item.kind === "REFERENCE");
    assert.ok(reference);
    assert.equal(reference.provenance.path, null);
    assert.equal(reference.provenance.commit, null);
    assert.equal(reference.provenance.version, "context-hub-reference-v1");
    assert.equal(
      reference.provenance.checksum,
      await sha256Bytes(new TextEncoder().encode(reference.excerpt)),
    );
  });

  it("fails closed on private payload corruption and reports bounded source failures", async () => {
    const { db, storage, provider } = setup();
    const artifact = await putArtifact(db, storage);
    const stored = storage.objects.get(artifact.key);
    assert.ok(stored);
    stored.bytes = new TextEncoder().encode("tampered");
    await putGraph(db, storage);
    const graphKey = db.graph?.storage_key;
    assert.equal(typeof graphKey, "string");
    const graphObject = storage.objects.get(graphKey as string);
    assert.ok(graphObject);
    graphObject.head.metadata.checksum = "0".repeat(64);
    const result = await provider.search(input);
    assert.equal(
      result.evidence.some((item) => item.kind === "ARTIFACT"),
      false,
    );
    assert.deepEqual(result.sourceErrors, [
      "ARTIFACT_SOURCE_UNAVAILABLE",
      "GRAPH_SOURCE_UNAVAILABLE",
    ]);
  });

  it("excludes archived artifacts before private storage access", async () => {
    const db = new ContextD1();
    const storage = new MemoryStorage();
    const archived = await putArtifact(db, storage, { status: "ARCHIVED" });
    const provider = new ContextEngine(
      db as unknown as D1Database,
      storage,
      ContextAuthorizationFence.human(["p"], "user"),
    );
    const result = await provider.search({ ...input, query: "refund architecture" });
    assert.equal(
      result.evidence.some((item) => item.kind === "ARTIFACT"),
      false,
    );
    assert.equal(storage.getCalls.has(archived.key), false);
  });

  it("keeps project retrieval isolated and has no shared cache", async () => {
    const { db, storage, provider } = setup();
    await putArtifact(db, storage, { id: "private-p", project_id: "p" });
    await putArtifact(db, storage, { id: "private-q", project_id: "q" });
    const first = await provider.search(input);
    const second = await new ContextEngine(
      db as unknown as D1Database,
      storage,
      ContextAuthorizationFence.human(["q"], "user"),
    ).search({ ...input, projectId: "q" });
    assert.equal(
      first.evidence.some((item) => item.provenance.path === "artifacts/private-q"),
      false,
    );
    assert.equal(
      second.evidence.some((item) => item.provenance.path === "artifacts/private-p"),
      false,
    );
  });
});
