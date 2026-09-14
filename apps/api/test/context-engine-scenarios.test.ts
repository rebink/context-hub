/* biome-ignore-all lint/suspicious/noExplicitAny: The fake models Cloudflare bindings structurally. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ContextAuthorizationFence } from "../src/context-authorization.js";
import { ContextBudgetError, ContextEngine } from "../src/context-engine.js";
import { GRAPH_BUILD_IDENTITY, type GraphRow } from "../src/graphs.js";
import { createApp } from "../src/index.js";
import type { ObjectStorage, StoredObjectMetadata } from "../src/object-storage.js";
import { sha256Bytes } from "../src/security.js";

type Row = Record<string, any>;
type Stored = { bytes: Uint8Array<ArrayBuffer>; head: StoredObjectMetadata };

class ScenarioStatement {
  private args: any[] = [];

  constructor(
    private readonly db: ScenarioD1,
    private readonly sql: string,
  ) {}

  bind(...args: any[]) {
    this.args = args;
    this.db.maxBoundParameters = Math.max(this.db.maxBoundParameters, args.length);
    return this;
  }

  async first<T>() {
    this.db.consumeQuery();
    return this.db.first(this.sql, this.args) as T | null;
  }

  async all<T>() {
    this.db.consumeQuery();
    return {
      success: true,
      results: this.db.all(this.sql, this.args),
      meta: {},
    } as D1Result<T>;
  }
}

class ScenarioD1 {
  git: Row[] = [];
  repositoryLinks: Row[] = [];
  artifacts: Row[] = [];
  graphs: GraphRow[] = [];
  sourceMetadataReads = 0;
  queryCount = 0;
  maxQueries = Number.POSITIVE_INFINITY;
  maxBoundParameters = 0;

  consumeQuery() {
    this.queryCount += 1;
    if (this.queryCount > this.maxQueries) throw new Error("D1 query 51");
  }

  prepare(sql: string) {
    return new ScenarioStatement(this, sql);
  }

  first(sql: string, args: any[]): Row | null {
    if (sql.includes("FROM sessions s JOIN users u"))
      return {
        id: "user",
        session_id: "session",
        username: "user",
        display_name: null,
        avatar_url: null,
      };
    if (sql.includes("SELECT COUNT(*) AS authorized_count FROM projects p"))
      return { authorized_count: args.length - 2 };
    if (sql.includes("SELECT 1 AS authorized")) return { authorized: 1 };
    if (sql.includes("FROM git_connections")) {
      this.sourceMetadataReads += 1;
      assert.match(sql, /context_auth_p/);
      assert.match(sql, /gc\.project_id = \?/);
      assert.match(sql, /gc\.status = 'VERIFIED'/);
      assert.match(sql, /pr\.project_id = gc\.project_id/);
      return (
        this.git.find(
          (row) =>
            row.project_id === args[0] &&
            row.status === "VERIFIED" &&
            this.repositoryLinks.some(
              (link) =>
                link.project_id === row.project_id &&
                link.repository_identity_id === row.repository_identity_id,
            ),
        ) ?? null
      );
    }
    if (sql.includes("FROM graph_versions")) {
      this.sourceMetadataReads += 1;
      assert.match(sql, /context_auth_p/);
      assert.match(sql, /project_id = \?/);
      assert.match(sql, /repository_provider = \?/);
      assert.match(sql, /provider_repository_id = \?/);
      assert.match(sql, /repository_canonical_url = \?/);
      assert.match(sql, /status = 'READY'/);
      assert.match(sql, /ORDER BY version DESC LIMIT 1/);
      return (
        this.graphs
          .filter(
            (row) =>
              row.project_id === args[0] &&
              row.repository_provider === args[1] &&
              row.provider_repository_id === args[2] &&
              row.repository_canonical_url === args[3] &&
              row.status === "READY",
          )
          .sort((left, right) => right.version - left.version)[0] ?? null
      );
    }
    throw new Error(`Unhandled first SQL: ${sql}`);
  }

  all(sql: string, args: any[]): Row[] {
    if (sql.includes("FROM git_connections gc")) {
      this.sourceMetadataReads += 1;
      assert.match(sql, /gc\.project_id IN/);
      assert.match(sql, /context_auth_p/);
      return this.git.filter(
        (row) =>
          row.status === "VERIFIED" &&
          this.repositoryLinks.some(
            (link) =>
              link.project_id === row.project_id &&
              link.repository_identity_id === row.repository_identity_id,
          ),
      );
    }
    if (sql.includes("FROM graph_versions gv")) {
      this.sourceMetadataReads += 1;
      assert.match(sql, /gv\.project_id IN/);
      assert.match(sql, /context_auth_p/);
      return this.graphs
        .filter((row) => row.status === "READY")
        .filter((row) => {
          const git = this.git.find((candidate) => candidate.project_id === row.project_id);
          return (
            git &&
            row.repository_provider === git.provider &&
            row.provider_repository_id === git.provider_repository_id &&
            row.repository_canonical_url === git.canonical_url
          );
        })
        .sort(
          (left, right) =>
            left.project_id.localeCompare(right.project_id) || right.version - left.version,
        )
        .filter(
          (row, index, rows) => index === 0 || rows[index - 1]?.project_id !== row.project_id,
        );
    }
    if (!sql.includes("FROM artifacts a JOIN artifact_versions")) {
      throw new Error(`Unhandled all SQL: ${sql}`);
    }
    this.sourceMetadataReads += 1;
    assert.match(sql, /a\.status ?= ?'ACTIVE'/);
    assert.match(sql, /context_auth_p/);
    assert.match(sql, /av\.artifact_id ?= ?a\.id AND av\.version ?= ?a\.current_version/);
    const consolidated = sql.includes("a.project_id IN");
    const firstFenceCount = args.findIndex((value) => typeof value === "number");
    const limit = args.at(-1) as number;
    const firstProjectId = this.git[0]?.project_id ?? this.artifacts[0]?.project_id;
    const searchTerms = consolidated
      ? args.slice(0, args.indexOf(firstProjectId))
      : (args.slice(firstFenceCount + 1, -1) as string[]);
    const score = (row: Row) => {
      const metadata = `${row.name} ${row.type} ${row.description ?? ""}`.toLowerCase();
      return searchTerms.filter((term) => metadata.includes(term)).length;
    };
    const selected = this.artifacts
      .filter(
        (row) =>
          (consolidated || row.project_id === args[0]) &&
          row.status === "ACTIVE" &&
          row.version === row.current_version,
      )
      .sort(
        (left, right) =>
          left.project_id.localeCompare(right.project_id) ||
          score(right) - score(left) ||
          right.updated_at.localeCompare(left.updated_at) ||
          right.id.localeCompare(left.id),
      );
    if (!consolidated) return selected.slice(0, limit);
    const counts = new Map<string, number>();
    return selected
      .map((row): Row & { candidate_rank: number; metadata_score: number } => {
        const rank = (counts.get(row.project_id) ?? 0) + 1;
        counts.set(row.project_id, rank);
        return { ...row, candidate_rank: rank, metadata_score: score(row) };
      })
      .sort(
        (left, right) =>
          right.metadata_score - left.metadata_score ||
          left.candidate_rank - right.candidate_rank ||
          left.project_id.localeCompare(right.project_id) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit);
  }
}

class ScenarioStorage implements ObjectStorage {
  objects = new Map<string, Stored>();
  headCalls: string[] = [];
  getCalls: string[] = [];
  private headCredits = new Map<string, number>();

  async createOnly() {
    return "created" as const;
  }

  async head(key: string) {
    this.headCalls.push(key);
    const stored = this.objects.get(key);
    if (stored) this.headCredits.set(key, (this.headCredits.get(key) ?? 0) + 1);
    return stored?.head ?? null;
  }

  async getBytes(key: string) {
    const credit = this.headCredits.get(key) ?? 0;
    assert.ok(credit > 0, `get before successful HEAD: ${key}`);
    this.headCredits.set(key, credit - 1);
    this.getCalls.push(key);
    return this.objects.get(key)?.bytes ?? null;
  }

  async compensationDelete() {}
}

const commit = "a".repeat(40);
const staleCommit = "b".repeat(40);
const encoder = new TextEncoder();
const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const evidenceTokens = (value: unknown) => Math.max(1, Math.ceil(byteLength(value) / 4));

function moveStoredObject(storage: ScenarioStorage, from: string, to: string, uploadId?: string) {
  const stored = storage.objects.get(from);
  assert.ok(stored);
  storage.objects.delete(from);
  if (uploadId) stored.head.metadata.uploadId = uploadId;
  storage.objects.set(to, stored);
}

function setup() {
  const db = new ScenarioD1();
  const storage = new ScenarioStorage();
  db.git.push({
    project_id: "p",
    repository_identity_id: "identity-p",
    provider: "github",
    provider_repository_id: "repo-p",
    owner: "team",
    repository_name: "payments",
    canonical_url: "github.com/team/payments",
    default_branch: "main",
    last_known_commit_sha: commit,
    status: "VERIFIED",
    updated_at: "2026-03-01T00:00:00.000Z",
  });
  db.repositoryLinks.push({ project_id: "p", repository_identity_id: "identity-p" });
  return {
    db,
    storage,
    engine: new ContextEngine(
      db as unknown as D1Database,
      storage,
      ContextAuthorizationFence.human(["p"], "user"),
    ),
  };
}

async function addArtifact(
  db: ScenarioD1,
  storage: ScenarioStorage,
  values: Partial<Row> & { id: string; content: string },
) {
  const projectId = values.project_id ?? "p";
  const version = values.version ?? 1;
  const bytes = encoder.encode(values.content);
  const checksum = await sha256Bytes(bytes);
  const key =
    values.storage_key ?? `projects/${projectId}/artifacts/${values.id}/v/${version}/content`;
  storage.objects.set(key, {
    bytes,
    head: {
      byteSize: bytes.byteLength,
      httpContentType: "text/markdown",
      metadata: { contentType: "text/markdown", checksum, uploadId: `upload-${values.id}` },
    },
  });
  db.artifacts.push({
    id: values.id,
    project_id: projectId,
    type: values.type ?? "architecture",
    name: values.name ?? "Refund retry architecture",
    description: values.description ?? "payments refund retry",
    status: values.status ?? "ACTIVE",
    current_version: values.current_version ?? version,
    version,
    storage_key: key,
    checksum,
    content_type: "text/markdown",
    byte_size: bytes.byteLength,
    source_commit_sha: values.source_commit_sha === undefined ? commit : values.source_commit_sha,
    updated_at: values.updated_at ?? "2026-03-01T00:00:00.000Z",
  });
  return { key, checksum };
}

async function addGraph(
  db: ScenarioD1,
  storage: ScenarioStorage,
  projectId = "p",
  overrides: Partial<GraphRow> = {},
  nodeTotal = 2,
) {
  const nodes =
    nodeTotal === 2
      ? [
          {
            id: "refund-service",
            label: "RefundService",
            file_type: "ts",
            source_file: "packages/payments/src/refund-service.ts",
            source_location: "L41",
          },
          {
            id: "payment-gateway",
            label: "PaymentGateway",
            file_type: "ts",
            source_file: "packages/payments/src/payment-gateway.ts",
            source_location: "L18",
          },
        ]
      : Array.from({ length: nodeTotal }, (_, index) => ({
          id: `refund-service-${index}`,
          label: `RefundService${index}`,
          file_type: "ts",
          source_file: `packages/payments/src/refund-${index}.ts`,
          source_location: `L${index + 1}`,
        }));
  const links =
    nodeTotal === 2
      ? [
          {
            source: "refund-service",
            target: "payment-gateway",
            relation: "CALLS",
            confidence: "EXTRACTED",
            confidence_score: 1,
            weight: 1,
            source_file: "packages/payments/src/refund-service.ts",
            source_location: "L48",
          },
        ]
      : nodes.flatMap((node, index) =>
          Array.from({ length: 5 }, (_, offset) => ({
            source: node.id,
            target: nodes[(index + offset + 1) % nodes.length]?.id ?? node.id,
            relation: "CALLS",
            confidence: "EXTRACTED",
            confidence_score: 1,
            weight: 1,
            source_file: node.source_file,
            source_location: node.source_location,
          })),
        );
  const graph = {
    directed: false,
    multigraph: false,
    graph: {},
    nodes,
    links,
    hyperedges: [],
    built_at_commit: commit,
  };
  const bytes = encoder.encode(JSON.stringify(graph));
  const checksum = await sha256Bytes(bytes);
  const publication = `${projectId === "p" ? "p" : "q"}`.repeat(32);
  const key = `projects/${projectId}/graphs/v/1/attempts/1/${publication}/graph.json`;
  storage.objects.set(key, {
    bytes,
    head: {
      byteSize: bytes.byteLength,
      httpContentType: "application/json",
      metadata: { contentType: "application/json", checksum, uploadId: publication },
    },
  });
  const row: GraphRow = {
    id: `graph-${projectId}`,
    project_id: projectId,
    version: 1,
    repository_provider: "github",
    provider_repository_id: `repo-${projectId}`,
    repository_owner: "team",
    repository_name: projectId === "p" ? "payments" : "private-q",
    repository_canonical_url: `github.com/team/${projectId === "p" ? "payments" : "private-q"}`,
    source_commit_sha: commit,
    graphify_version: GRAPH_BUILD_IDENTITY.graphifyVersion,
    adapter_version: GRAPH_BUILD_IDENTITY.adapterVersion,
    profile: GRAPH_BUILD_IDENTITY.profile,
    format_version: GRAPH_BUILD_IDENTITY.formatVersion,
    generator: GRAPH_BUILD_IDENTITY.generator,
    status: "READY",
    attempt: 1,
    storage_layout: "ATTEMPT_V2",
    selected_publication_id: publication,
    lease_id: null,
    lease_expires_at: null,
    failure_category: null,
    storage_key: key,
    checksum,
    byte_size: bytes.byteLength,
    node_count: nodes.length,
    link_count: links.length,
    hyperedge_count: 0,
    generated_by: "scenario-runner",
    published_attempt: 1,
    published_lease_id: "l".repeat(32),
    queued_at: "2026-03-01T00:00:00.000Z",
    build_started_at: "2026-03-01T00:00:00.000Z",
    failed_at: null,
    generated_at: "2026-03-01T00:00:00.000Z",
    superseded_at: null,
    updated_at: "2026-03-01T00:00:00.000Z",
    orphan_observed_at: null,
    orphan_attempt: null,
    orphan_lease_id: null,
    orphan_checksum: null,
    orphan_byte_size: null,
    orphan_cleanup_id: null,
    orphan_cleanup_expires_at: null,
    ...overrides,
  };
  db.graphs.push(row);
  return { key, checksum, row };
}

const query = {
  projectId: "p",
  query: "add refund retry support",
  domain: "payments",
  package: "packages/payments",
  budget: { maxTokens: 2_000, maxBytes: 12_000 },
};

describe("Phase 13 Context Engine acceptance scenarios", () => {
  it("combines relevant architecture, graph relationships, provenance, deduplication, and all freshness states", async () => {
    const { db, storage, engine } = setup();
    const architecture = await addArtifact(db, storage, {
      id: "refund-architecture",
      content:
        "# Refund retries\nRefundService retries PaymentGateway failures with bounded backoff.",
    });
    await addArtifact(db, storage, {
      id: "duplicate-architecture",
      content:
        "# Refund retries\nRefundService retries PaymentGateway failures with bounded backoff.",
    });
    const stale = await addArtifact(db, storage, {
      id: "stale-refund-adr",
      type: "adr",
      name: "Refund retry decision",
      content: "# Retry decision\nRefund retry ownership remains in RefundService.",
      source_commit_sha: staleCommit,
    });
    const missing = await addArtifact(db, storage, {
      id: "missing-provenance",
      type: "api-contract",
      name: "Refund retry API",
      content: "# Refund API\nRefund retry requests include an idempotency key.",
      source_commit_sha: null,
    });
    const invalid = await addArtifact(db, storage, {
      id: "invalid-provenance",
      type: "domain-knowledge",
      name: "Refund retry domain notes",
      content: "# Refund domain\nRefund retry operations belong to payments.",
      source_commit_sha: "NOT-A-COMMIT",
    });
    await addArtifact(db, storage, {
      id: "database-backups",
      type: "runbook",
      name: "Database backup rotation",
      description: "operations storage",
      content: "# Backups\nRotate database backups every seven days.",
    });
    const graph = await addGraph(db, storage);

    const result = await engine.search(query);
    const artifacts = result.evidence.filter((item) => item.kind === "ARTIFACT");
    const graphEvidence = result.evidence.find((item) => item.kind === "GRAPH");

    assert.ok(artifacts.some((item) => item.title === "Refund retry architecture"));
    assert.equal(
      result.evidence.some((item) => item.title === "Database backup rotation"),
      false,
    );
    assert.ok(graphEvidence?.excerpt.includes('"relation":"CALLS"'));
    assert.deepEqual(
      new Set(artifacts.map((item) => item.freshness)),
      new Set(["CURRENT", "STALE", "UNKNOWN"]),
    );
    assert.equal(artifacts.filter((item) => item.excerpt.includes("bounded backoff")).length, 1);
    assert.equal(new Set(result.evidence.map((item) => item.excerpt)).size, result.evidence.length);

    const current = artifacts.find((item) => item.excerpt.includes("bounded backoff"));
    const currentProvenance = current?.provenance;
    assert.ok(currentProvenance);
    assert.ok(
      ["artifacts/refund-architecture", "artifacts/duplicate-architecture"].includes(
        currentProvenance.path ?? "",
      ),
    );
    assert.deepEqual(currentProvenance, {
      projectId: "p",
      source: "ARTIFACT",
      path: currentProvenance.path,
      section: null,
      version: "1",
      commit,
      checksum: architecture.checksum,
    });
    assert.deepEqual(graphEvidence?.provenance, {
      projectId: "p",
      source: "GRAPH",
      path: "packages/payments/src/refund-service.ts",
      section: "L41",
      version: "1",
      commit,
      checksum: graph.checksum,
    });
    for (const evidence of result.evidence) {
      assert.equal(evidence.provenance.projectId, "p");
      assert.equal(evidence.provenance.source, evidence.kind);
      assert.notEqual(evidence.provenance.version, null);
      if (evidence.kind === "GIT") {
        assert.equal(evidence.provenance.path, null);
        assert.equal(evidence.provenance.commit, commit);
        assert.equal(evidence.provenance.checksum, null);
      } else {
        assert.notEqual(evidence.provenance.checksum, null);
      }
      if (evidence.kind === "ARTIFACT" || evidence.kind === "GRAPH") {
        assert.notEqual(evidence.provenance.path, null);
      }
    }
    assert.deepEqual(artifacts.find((item) => item.title === "Refund retry decision")?.provenance, {
      projectId: "p",
      source: "ARTIFACT",
      path: "artifacts/stale-refund-adr",
      section: null,
      version: "1",
      commit: staleCommit,
      checksum: stale.checksum,
    });
    assert.deepEqual(artifacts.find((item) => item.title === "Refund retry API")?.provenance, {
      projectId: "p",
      source: "ARTIFACT",
      path: "artifacts/missing-provenance",
      section: null,
      version: "1",
      commit: null,
      checksum: missing.checksum,
    });
    assert.deepEqual(
      artifacts.find((item) => item.title === "Refund retry domain notes")?.provenance,
      {
        projectId: "p",
        source: "ARTIFACT",
        path: "artifacts/invalid-provenance",
        section: null,
        version: "1",
        commit: null,
        checksum: invalid.checksum,
      },
    );
    const unknown = artifacts.filter((item) => item.freshness === "UNKNOWN");
    assert.equal(unknown.length, 2);
    assert.ok(unknown.every((item) => item.provenance.commit === null));
  });

  it("bounds Graphify nodes and relationships before the global budget", async () => {
    const { db, storage, engine } = setup();
    await addGraph(db, storage, "p", {}, 14);
    const result = await engine.search({
      ...query,
      budget: { maxTokens: 8_000, maxBytes: 64 * 1024 },
    });
    const graphEvidence = result.evidence.filter((item) => item.kind === "GRAPH");
    assert.equal(graphEvidence.length, 12);
    for (const evidence of graphEvidence) {
      const parsed = JSON.parse(evidence.excerpt) as { relationships: unknown[] };
      assert.ok(parsed.relationships.length <= 4);
      assert.ok(encoder.encode(evidence.excerpt).byteLength <= 1_200);
    }
    assert.equal(result.truncated, true);
  });

  it("applies one explicit byte and token budget after duplicate removal using independent measurements", async () => {
    const { db, storage, engine } = setup();
    const shared = "# Shared retry rule\nRefund retry uses bounded exponential backoff.";
    await addArtifact(db, storage, { id: "refund-duplicate-a", content: shared });
    await addArtifact(db, storage, { id: "refund-duplicate-b", content: shared });
    await addArtifact(db, storage, {
      id: "refund-unique",
      name: "Refund support notes",
      description: "refund support",
      content: "# Unique support\nRefund support has independently useful evidence.",
    });
    const baseline = await engine.search(query);
    const sharedEvidence = baseline.evidence.find((item) => item.excerpt.includes("bounded"));
    const uniqueEvidence = baseline.evidence.find((item) => item.title === "Refund support notes");
    assert.ok(sharedEvidence);
    assert.ok(uniqueEvidence);
    const budget = {
      maxTokens: evidenceTokens(sharedEvidence) + evidenceTokens(uniqueEvidence),
      maxBytes: 12_000,
    };
    const result = await engine.search({ ...query, budget });

    const independentlyMeasuredBytes = byteLength(result);
    const independentlyEstimatedTokens = result.evidence.reduce(
      (total, evidence) => total + evidenceTokens(evidence),
      0,
    );
    assert.ok(independentlyMeasuredBytes <= budget.maxBytes);
    assert.ok(independentlyEstimatedTokens <= budget.maxTokens);
    assert.equal(result.byteSize, independentlyMeasuredBytes);
    assert.equal(result.tokenEstimate, independentlyEstimatedTokens);
    assert.equal(result.evidence.filter((item) => item.excerpt.includes("bounded")).length, 1);
    assert.ok(result.evidence.some((item) => item.title === "Refund support notes"));
    assert.equal(new Set(result.evidence.map((item) => item.excerpt)).size, result.evidence.length);
    assert.equal(result.truncated, true);
  });

  it("isolates metadata, current-version selection, storage access, errors, response fields, and repeated uncached searches", async () => {
    const { db, storage, engine } = setup();
    const visible = await addArtifact(db, storage, {
      id: "visible-p",
      content: "# Refund architecture\nRefund retry belongs to project p.",
    });
    const privateQ = await addArtifact(db, storage, {
      id: "private-q",
      project_id: "q",
      content: "# Refund architecture\nSecret refund retry design for project q.",
    });
    const inactive = await addArtifact(db, storage, {
      id: "inactive-p",
      status: "ARCHIVED",
      content: "# Refund architecture\nArchived private design.",
    });
    const oldVersion = await addArtifact(db, storage, {
      id: "old-version-p",
      version: 1,
      current_version: 2,
      content: "# Refund architecture\nSuperseded private design.",
    });
    await addGraph(db, storage, "q");
    await addGraph(db, storage, "p", {
      id: "wrong-repository",
      version: 9,
      provider_repository_id: "other-repository",
      repository_canonical_url: "github.com/team/other",
    });
    await addGraph(db, storage, "p", { id: "non-ready", version: 8, status: "FAILED" });
    await addGraph(db, storage, "p");

    const first = await engine.search(query);
    const firstCalls = [...storage.headCalls, ...storage.getCalls];
    assert.ok(first.evidence.some((item) => item.provenance.path === "artifacts/visible-p"));
    assert.ok(first.evidence.some((item) => item.kind === "GRAPH"));
    assert.ok(first.evidence.every((item) => item.provenance.projectId === "p"));
    assert.equal(first.sourceErrors.length, 0);
    assert.ok(firstCalls.every((key) => key.startsWith("projects/p/")));
    assert.equal(firstCalls.includes(privateQ.key), false);
    assert.equal(firstCalls.includes(inactive.key), false);
    assert.equal(firstCalls.includes(oldVersion.key), false);
    assert.deepEqual(Object.keys(first).sort(), [
      "byteSize",
      "evidence",
      "projectId",
      "sourceCount",
      "sourceErrors",
      "tokenEstimate",
      "truncated",
    ]);

    const privateObject = storage.objects.get(privateQ.key);
    assert.ok(privateObject);
    privateObject.bytes = encoder.encode("changed secret from project q");
    privateObject.head.metadata.checksum = "0".repeat(64);
    const git = db.git.find((row) => row.project_id === "p");
    assert.ok(git);
    git.updated_at = "2026-03-02T00:00:00.000Z";
    const second = await engine.search(query);
    assert.notDeepEqual(second, first);
    assert.equal(
      second.evidence.find((item) => item.kind === "GIT")?.provenance.version,
      "2026-03-02T00:00:00.000Z",
    );
    assert.equal(storage.headCalls.filter((key) => key === visible.key).length, 2);
    assert.equal(storage.getCalls.filter((key) => key === visible.key).length, 2);
    assert.equal(storage.headCalls.includes(privateQ.key), false);
    assert.equal(storage.getCalls.includes(privateQ.key), false);
  });

  it("accepts exact current artifact and both supported graph storage layouts", async () => {
    const artifactFixture = setup();
    const v1 = await addArtifact(artifactFixture.db, artifactFixture.storage, {
      id: "artifact-v1",
      content: "# Refund v1\nRefund retry architecture version one.",
    });
    const v7 = await addArtifact(artifactFixture.db, artifactFixture.storage, {
      id: "artifact-v7",
      version: 7,
      current_version: 7,
      content: "# Refund v7\nRefund retry architecture current version seven.",
    });
    await artifactFixture.engine.search(query);
    assert.ok(artifactFixture.storage.headCalls.includes(v1.key));
    assert.ok(artifactFixture.storage.getCalls.includes(v1.key));
    assert.ok(artifactFixture.storage.headCalls.includes(v7.key));
    assert.ok(artifactFixture.storage.getCalls.includes(v7.key));

    const attemptFixture = setup();
    const attempt = await addGraph(attemptFixture.db, attemptFixture.storage);
    await attemptFixture.engine.search(query);
    assert.ok(attemptFixture.storage.headCalls.includes(attempt.key));
    assert.ok(attemptFixture.storage.getCalls.includes(attempt.key));

    const legacyFixture = setup();
    const legacy = await addGraph(legacyFixture.db, legacyFixture.storage);
    const legacyKey = "projects/p/graphs/v/1/graph.json";
    legacy.row.storage_layout = "LEGACY_V1";
    legacy.row.selected_publication_id = null;
    legacy.row.storage_key = legacyKey;
    moveStoredObject(
      legacyFixture.storage,
      legacy.key,
      legacyKey,
      `${legacy.row.published_attempt}.${legacy.row.published_lease_id}`,
    );
    await legacyFixture.engine.search(query);
    assert.ok(legacyFixture.storage.headCalls.includes(legacyKey));
    assert.ok(legacyFixture.storage.getCalls.includes(legacyKey));
  });

  it("rejects malformed artifact key components before any storage call", async () => {
    const cases = [
      { projectId: "p", id: "bad/id", version: 1 },
      { projectId: "p", id: "valid", version: 0 },
      { projectId: "p", id: "valid", version: 1.5 },
    ];
    for (const item of cases) {
      const { db, storage, engine } = setup();
      if (item.projectId !== "p") {
        const git = db.git[0];
        const link = db.repositoryLinks[0];
        assert.ok(git);
        assert.ok(link);
        git.project_id = item.projectId;
        link.project_id = item.projectId;
      }
      await addArtifact(db, storage, {
        id: item.id,
        project_id: item.projectId,
        version: item.version,
        current_version: item.version,
        content: "# Refund architecture\nRefund retry private source.",
      });
      const result = await engine.search({ ...query, projectId: item.projectId });
      assert.equal(result.sourceErrors.includes("ARTIFACT_SOURCE_UNAVAILABLE"), true);
      assert.deepEqual(storage.headCalls, []);
      assert.deepEqual(storage.getCalls, []);
    }
  });

  it("rejects malformed graph key components before any storage call", async () => {
    const cases: Array<(row: GraphRow) => void> = [
      (row) => {
        (row as unknown as Record<string, unknown>).storage_layout = "UNKNOWN";
      },
      (row) => {
        row.version = 1.5;
        row.storage_key = `projects/p/graphs/v/${row.version}/attempts/1/${row.selected_publication_id}/graph.json`;
      },
      (row) => {
        row.published_attempt = 0;
        row.storage_key = `projects/p/graphs/v/1/attempts/0/${row.selected_publication_id}/graph.json`;
      },
      (row) => {
        row.selected_publication_id = `x/${"a".repeat(32)}`;
        row.storage_key = `projects/p/graphs/v/1/attempts/1/${row.selected_publication_id}/graph.json`;
      },
      (row) => {
        row.storage_layout = "LEGACY_V1";
        row.storage_key = "projects/p/graphs/v/1/graph.json";
      },
    ];
    for (const mutate of cases) {
      const { db, storage, engine } = setup();
      const graph = await addGraph(db, storage);
      const originalKey = graph.key;
      mutate(graph.row);
      if (graph.row.storage_key && graph.row.storage_key !== originalKey)
        moveStoredObject(storage, originalKey, graph.row.storage_key);
      const result = await engine.search(query);
      assert.equal(result.sourceErrors.includes("GRAPH_SOURCE_UNAVAILABLE"), true);
      assert.deepEqual(storage.headCalls, []);
      assert.deepEqual(storage.getCalls, []);
    }
  });

  it("rejects cross-project artifact and graph keys before R2 HEAD or get", async () => {
    const { db, storage, engine } = setup();
    await addArtifact(db, storage, {
      id: "poisoned-key",
      storage_key: "projects/q/artifacts/private/v/1/content",
      content: "# Refund architecture\nPrivate project q content.",
    });
    const graph = await addGraph(db, storage);
    graph.row.storage_key = graph.key.replace("projects/p/", "projects/q/");

    const result = await engine.search(query);
    assert.equal(
      result.evidence.some((item) => item.kind === "ARTIFACT"),
      false,
    );
    assert.equal(
      result.evidence.some((item) => item.kind === "GRAPH"),
      false,
    );
    assert.deepEqual(result.sourceErrors, [
      "ARTIFACT_SOURCE_UNAVAILABLE",
      "GRAPH_SOURCE_UNAVAILABLE",
    ]);
    assert.deepEqual(storage.headCalls, []);
    assert.deepEqual(storage.getCalls, []);
  });
});

// Task D scenarios retain the SQL/order-aware and HEAD-before-get Phase 13 fakes.
describe("Task D explicit cross-project Context Engine scenarios", () => {
  it("globally ranks Payments and Identity fairly, preserves provenance, and is order deterministic", async () => {
    const { db, storage } = setup();
    const engine = new ContextEngine(
      db as unknown as D1Database,
      storage,
      ContextAuthorizationFence.human(["identity", "p"], "user"),
    );
    db.git.push({
      project_id: "identity",
      repository_identity_id: "identity-repository",
      provider: "github",
      provider_repository_id: "repo-identity",
      owner: "team",
      repository_name: "identity",
      canonical_url: "github.com/team/identity",
      default_branch: "main",
      last_known_commit_sha: commit,
      status: "VERIFIED",
      updated_at: "2026-03-01T00:00:00.000Z",
    });
    db.repositoryLinks.push({
      project_id: "identity",
      repository_identity_id: "identity-repository",
    });
    const shared = "# Refund identity\nRefund identity handoff uses a signed request.";
    await addArtifact(db, storage, { id: "payments-contract", content: shared });
    await addArtifact(db, storage, { id: "payments-duplicate", content: shared });
    await addArtifact(db, storage, {
      id: "payments-case-distinct",
      content: shared.replace("signed", "Signed"),
    });
    await addArtifact(db, storage, {
      id: "identity-contract",
      project_id: "identity",
      content: shared,
    });
    await addArtifact(db, storage, {
      id: "mobile-secret",
      project_id: "mobile",
      content: "# Refund identity\nMobile secret implementation detail.",
    });

    const paymentsOnly = await new ContextEngine(
      db as unknown as D1Database,
      storage,
      ContextAuthorizationFence.human(["p"], "user"),
    ).searchMany({
      projectIds: ["p"],
      query: "refund identity handoff",
      budget: { maxTokens: 2_000, maxBytes: 12_000 },
    });
    const identityOnly = await new ContextEngine(
      db as unknown as D1Database,
      storage,
      ContextAuthorizationFence.human(["identity"], "user"),
    ).searchMany({
      projectIds: ["identity"],
      query: "refund identity handoff",
      budget: { maxTokens: 2_000, maxBytes: 12_000 },
    });
    assert.deepEqual(
      new Set(paymentsOnly.evidence.map((item) => item.provenance.projectId)),
      new Set(["p"]),
    );
    assert.deepEqual(
      new Set(identityOnly.evidence.map((item) => item.provenance.projectId)),
      new Set(["identity"]),
    );
    assert.equal(paymentsOnly.evidence.filter((item) => item.excerpt === shared).length, 1);
    assert.equal(
      paymentsOnly.evidence.some((item) => item.excerpt === shared.replace("signed", "Signed")),
      true,
    );

    const request = {
      projectIds: ["p", "identity"],
      query: "refund identity handoff",
      budget: { maxTokens: 2_000, maxBytes: 12_000, maxSources: 2 },
    };
    const first = await engine.searchMany(request);
    const reversed = await engine.searchMany({
      ...request,
      projectIds: [...request.projectIds].reverse(),
    });

    assert.deepEqual(first, reversed);
    assert.deepEqual(first.projectIds, ["identity", "p"]);
    assert.equal(first.evidence.length, 2);
    assert.deepEqual(
      new Set(first.evidence.map((item) => item.provenance.projectId)),
      new Set(["identity", "p"]),
    );
    assert.equal(
      first.evidence.some((item) => item.provenance.projectId === "mobile"),
      false,
    );
    assert.equal(first.truncated, true);
    assert.ok(first.tokenEstimate <= request.budget.maxTokens);
    assert.ok(first.byteSize <= request.budget.maxBytes);
  });

  it("keeps authorized corruption bounded and project-provenance-safe", async () => {
    const { db, storage } = setup();
    const engine = new ContextEngine(
      db as unknown as D1Database,
      storage,
      ContextAuthorizationFence.human(["identity", "p"], "user"),
    );
    const corrupt = await addArtifact(db, storage, {
      id: "identity-corrupt",
      project_id: "identity",
      content: "Identity refund corruption evidence.",
    });
    const object = storage.objects.get(corrupt.key);
    assert.ok(object);
    object.bytes = encoder.encode("tampered");

    const result = await engine.searchMany({
      projectIds: ["identity", "p"],
      query: "identity refund",
      budget: { maxTokens: 1_000, maxBytes: 8_000 },
    });
    assert.deepEqual(result.sourceErrors, [
      { projectId: "identity", error: "ARTIFACT_SOURCE_UNAVAILABLE" },
    ]);
    assert.equal(
      result.evidence.some((item) => item.provenance.path === "artifacts/identity-corrupt"),
      false,
    );
  });

  it("supports canonical 1, 10, and 20 project sets with zero cache-state surface", async () => {
    const db = new ScenarioD1();
    const storage = new ScenarioStorage();
    for (const count of [1, 10, 20]) {
      const projectIds = Array.from({ length: count }, (_, index) => `project-${index}`);
      const engine = new ContextEngine(
        db as unknown as D1Database,
        storage,
        ContextAuthorizationFence.human(projectIds, "user"),
      );
      const beforeHeads = storage.headCalls.length;
      const first = await engine.searchMany({
        projectIds,
        query: "immutable project payload",
        budget: { maxTokens: 8_000, maxBytes: 64 * 1024, maxSources: 40 },
      });
      const second = await engine.searchMany({
        projectIds: [...projectIds].reverse(),
        query: "immutable project payload",
        budget: { maxTokens: 8_000, maxBytes: 64 * 1024, maxSources: 40 },
      });
      assert.deepEqual(first, second);
      assert.equal(first.projectIds.length, count);
      assert.equal(first.evidence.length, count);
      assert.equal(storage.headCalls.length, beforeHeads);
      assert.equal("cache" in first, false);
    }
  });

  it("keeps human and MCP twenty-project worst-case D1 query budgets below 50", async () => {
    const projectIds = Array.from({ length: 20 }, (_, index) => `budget-${index}`);
    const db = new ScenarioD1();
    const storage = new ScenarioStorage();
    for (const [index, projectId] of projectIds.entries()) {
      db.git.push({
        project_id: projectId,
        repository_identity_id: `identity-${index}`,
        provider: "github",
        provider_repository_id: `repo-${index}`,
        owner: "team",
        repository_name: `repository-${index}`,
        canonical_url: `github.com/team/repository-${index}`,
        default_branch: "main",
        last_known_commit_sha: commit,
        status: "VERIFIED",
        updated_at: "2026-03-01T00:00:00.000Z",
      });
      db.repositoryLinks.push({
        project_id: projectId,
        repository_identity_id: `identity-${index}`,
      });
      await addArtifact(db, storage, {
        id: `artifact-${index}`,
        project_id: projectId,
        name: index === 19 ? "term-31 strongest late project" : `candidate ${index}`,
        content: "bounded source object",
      });
      await addGraph(db, storage, projectId, {
        provider_repository_id: `repo-${index}`,
        repository_name: `repository-${index}`,
        repository_canonical_url: `github.com/team/repository-${index}`,
      });
    }
    const input = {
      projectIds,
      query: Array.from({ length: 32 }, (_, index) => `term-${index}`).join(" "),
      budget: { maxTokens: 8_000, maxBytes: 64 * 1024, maxSources: 80 },
    };
    const fences = [
      ContextAuthorizationFence.human(projectIds, "user"),
      ContextAuthorizationFence.mcp(projectIds, {
        credentialId: "credential",
        principalId: "principal",
        repositoryProvider: "github",
        providerRepositoryId: "repo-bound",
        repositoryCanonicalUrl: "github.com/team/bound",
      }),
    ];
    for (const fence of fences) {
      db.queryCount = 0;
      db.maxBoundParameters = 0;
      storage.headCalls.length = 0;
      storage.getCalls.length = 0;
      const result = await new ContextEngine(
        db as unknown as D1Database,
        storage,
        fence,
      ).searchMany(input);
      assert.equal(storage.headCalls.length, 16);
      assert.equal(storage.getCalls.length, 16);
      assert.equal(db.queryCount, 39);
      assert.ok(storage.headCalls.some((key) => key.includes("artifact-19")));
      assert.ok(result.evidence.some((item) => item.provenance.projectId === "budget-19"));
      assert.ok(storage.headCalls.some((key) => /projects\/budget-(?:1[7-9])\/graphs\//.test(key)));
      assert.ok(db.maxBoundParameters <= 100, String(db.maxBoundParameters));
    }

    db.queryCount = 0;
    db.maxQueries = 50;
    db.maxBoundParameters = 0;
    const bucket = {
      head: async (key: string) => {
        const head = await storage.head(key);
        return head
          ? {
              size: head.byteSize,
              httpMetadata: { contentType: head.httpContentType },
              customMetadata: head.metadata,
            }
          : null;
      },
      get: async (key: string) => {
        const bytes = await storage.getBytes(key);
        return bytes
          ? {
              arrayBuffer: async () =>
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            }
          : null;
      },
    };
    const routed = await createApp().fetch(
      new Request("https://api.example/context/cross-project/search", {
        method: "POST",
        headers: {
          cookie: "context_hub_session=budget-session",
          origin: "https://web.example",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      }),
      { DB: db, OBJECTS: bucket, WEB_ORIGIN: "https://web.example" } as any,
    );
    assert.equal(routed.status, 200);
    assert.equal(db.queryCount, 41);
    assert.ok(db.maxBoundParameters <= 100);
  });

  it("enforces exact complete-shell and source-error byte boundaries for 1, 10, and 20 projects", async () => {
    const ids = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
    const search = async (projectIds: string[], maxBytes: number, errors: boolean) => {
      const db = new ScenarioD1();
      const storage = new ScenarioStorage();
      if (errors) {
        for (const [index, projectId] of projectIds.entries()) {
          await addArtifact(db, storage, {
            id: `broken-${index}`,
            project_id: projectId,
            storage_key: "invalid-key",
            content: "refund boundary",
          });
        }
      }
      const engine = new ContextEngine(
        db as unknown as D1Database,
        storage,
        ContextAuthorizationFence.human(projectIds, "user"),
      );
      const result = await engine.searchMany({
        projectIds,
        query: errors ? "refund boundary" : "no matching evidence",
        budget: { maxTokens: 8_000, maxBytes, maxSources: 40 },
      });
      assert.equal(result.byteSize, byteLength(result));
      assert.ok(result.byteSize <= maxBytes);
      return { db, storage, result };
    };

    for (const count of [1, 10, 20]) {
      const projectIds = ids(count);
      const empty = await search(projectIds, 64 * 1024, false);
      const exactEmpty = await search(projectIds, empty.result.byteSize, false);
      assert.deepEqual(exactEmpty.result, empty.result);
      const tooSmallDb = new ScenarioD1();
      const tooSmallStorage = new ScenarioStorage();
      const tooSmallEngine = new ContextEngine(
        tooSmallDb as unknown as D1Database,
        tooSmallStorage,
        ContextAuthorizationFence.human(projectIds, "user"),
      );
      await assert.rejects(
        tooSmallEngine.searchMany({
          projectIds,
          query: "no matching evidence",
          budget: { maxTokens: 8_000, maxBytes: empty.result.byteSize - 1 },
        }),
        ContextBudgetError,
      );
      assert.equal(tooSmallDb.sourceMetadataReads, 0);
      assert.deepEqual(tooSmallStorage.headCalls, []);

      const errors = await search(projectIds, 64 * 1024, true);
      assert.equal(errors.result.sourceErrors.length, Math.min(count, 9));
      const exactErrors = await search(projectIds, errors.result.byteSize, true);
      assert.deepEqual(exactErrors.result, errors.result);
      const boundedErrors = await search(projectIds, errors.result.byteSize - 1, true);
      assert.equal(boundedErrors.result.truncated, true);
      assert.ok(boundedErrors.result.sourceErrors.length < count);
    }

    const twentyIds = ids(20);
    const db = new ScenarioD1();
    const storage = new ScenarioStorage();
    const engine = new ContextEngine(
      db as unknown as D1Database,
      storage,
      ContextAuthorizationFence.human(twentyIds, "user"),
    );
    await assert.rejects(
      engine.searchMany({
        projectIds: twentyIds,
        query: "refund boundary",
        budget: { maxTokens: 8_000, maxBytes: 512 },
      }),
      ContextBudgetError,
    );
    assert.equal(db.sourceMetadataReads, 0);
    assert.deepEqual(storage.headCalls, []);
    assert.deepEqual(storage.getCalls, []);
  });
});
