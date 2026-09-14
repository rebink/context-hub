/// <reference types="@cloudflare/workers-types" />

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { measureMcpTokenAudit } from "../apps/api/scripts/mcp-token-audit-lib.js";
import { ContextAuthorizationFence } from "../apps/api/src/context-authorization.js";
import { ContextEngine } from "../apps/api/src/context-engine.js";
import { queryGraph } from "../apps/api/src/graphs.js";
import { MCP_LIMITS } from "../apps/api/src/mcp-transport.js";
import type { ObjectStorage } from "../apps/api/src/object-storage.js";
import { checkMetricDocs } from "./metrics-docs.mts";
import {
  ARCHITECTURE_REQUIREMENT_SOURCE_BY_ID,
  METRIC_DIMENSION_VALUES,
  METRIC_STATUSES,
  METRICS,
  type MetricDefinition,
  PLAYBOOK_METRIC_SOURCES,
} from "./metrics-registry.mts";

const REQUIRED_IDS = [
  "CTX-001",
  "CTX-002",
  "CTX-003",
  "CTX-004",
  "REL-001",
  "REL-002",
  "REL-003",
  "REL-004",
  "REL-005",
  "REL-006",
  "REL-007",
  "REL-008",
  "DX-001",
  "DX-002",
  "DX-003",
  "INF-001",
  "INF-002",
  "INF-003",
  "INF-004",
  "PERF-001",
  "PERF-002",
  "PERF-003",
  "PERF-004",
  "PERF-005",
  "PERF-006",
  "PERF-007",
] as const;
const LIVE_ONLY = new Set([
  "REL-005",
  "INF-001",
  "INF-002",
  "INF-003",
  "INF-004",
  "PERF-001",
  "PERF-002",
  "PERF-007",
]);
const ARCHITECTURE_REQUIREMENT_SOURCES = new Set<string>(
  Object.values(ARCHITECTURE_REQUIREMENT_SOURCE_BY_ID),
);
const SENSITIVE_DIMENSION =
  /(query|content|path|credential|cookie|payload|ip|user_agent|email|label|user_id)/i;
const REQUIRED_FIELDS: Array<keyof MetricDefinition> = [
  "id",
  "name",
  "formula",
  "numerator",
  "denominator",
  "unit",
  "window",
  "inclusion",
  "exclusion",
  "source",
  "privacy",
  "retention",
  "collection",
  "baseline",
  "target",
  "threshold",
  "cadence",
  "owner",
  "status",
  "requirementSources",
];

export function validateRegistry(metrics: readonly MetricDefinition[], markdown: string) {
  assert.deepEqual(
    metrics.map((item) => item.id),
    REQUIRED_IDS,
    "registry IDs/order drifted",
  );
  assert.equal(new Set(metrics.map((item) => item.id)).size, metrics.length, "duplicate metric ID");
  for (const item of metrics) {
    for (const field of REQUIRED_FIELDS) assert.ok(item[field], `${item.id} missing ${field}`);
    assert.ok(METRIC_STATUSES.includes(item.status), `${item.id} invalid status`);
    assert.ok(item.dimensions.length > 0, `${item.id} has no dimensions contract`);
    for (const dimension of item.dimensions) {
      assert.ok(!SENSITIVE_DIMENSION.test(dimension.key), `${item.id} sensitive dimension`);
      assert.deepEqual(
        dimension.values,
        METRIC_DIMENSION_VALUES[dimension.key],
        `${item.id} dimension values drifted`,
      );
      assert.ok(dimension.values.length > 0, `${item.id} empty dimension values`);
    }
    assert.equal(
      item.requirementSources.length,
      2,
      `${item.id} must map to two exact requirement sources`,
    );
    assert.equal(
      new Set(item.requirementSources).size,
      item.requirementSources.length,
      `${item.id} duplicate requirement source`,
    );
    assert.ok(
      item.requirementSources.every(
        (source) =>
          PLAYBOOK_METRIC_SOURCES.includes(source) ||
          source === "PRD §36 Product Success Metrics" ||
          source === "Technical Architecture §35 Acceptance Criteria" ||
          ARCHITECTURE_REQUIREMENT_SOURCES.has(source),
      ),
      `${item.id} unsupported requirement source`,
    );
    assert.match(
      item.threshold,
      /(\d|Any|none|unavailable|investigate|stop|failure)/i,
      `${item.id} missing action threshold`,
    );
    if (LIVE_ONLY.has(item.id))
      assert.equal(item.status, "BLOCKED_LIVE", `${item.id} live-only status must remain blocked`);
  }
  const usedPlaybookSources = metrics
    .flatMap((item) => item.requirementSources)
    .filter((source) => source.startsWith("Playbook §36:"));
  assert.deepEqual(
    usedPlaybookSources,
    PLAYBOOK_METRIC_SOURCES,
    "15 playbook metric sources must map exactly once",
  );
  checkMetricDocs(markdown, metrics);
  assert.match(markdown, /synthetic\/local baselines are not production/i);
  assert.match(markdown, /never (?:log|collect)[^\n]*(?:query|content)/i);
}

function mutationTraps(markdown: string) {
  const expectFailure = (mutate: (copy: MetricDefinition[]) => void) => {
    const copy = METRICS.map((item) => ({
      ...item,
      dimensions: item.dimensions.map((dimension) => ({
        ...dimension,
        values: [...dimension.values],
      })),
      requirementSources: [...item.requirementSources],
    }));
    mutate(copy);
    assert.throws(() => validateRegistry(copy, markdown));
  };
  const mutateField = (index: number, field: keyof MetricDefinition, value: unknown) =>
    expectFailure((copy) => {
      const current = copy[index];
      assert.ok(current);
      copy[index] = { ...current, [field]: value } as MetricDefinition;
    });
  expectFailure((copy) => copy.pop());
  mutateField(0, "formula", "detached formula");
  mutateField(0, "privacy", "public");
  mutateField(8, "status", "MEASURED_LOCAL");
  mutateField(0, "target", "detached target");
  mutateField(0, "threshold", "detached threshold");
  mutateField(0, "source", "detached source");
  mutateField(1, "id", "CTX-001");
  expectFailure((copy) => {
    const current = copy[0];
    assert.ok(current);
    copy[0] = {
      ...current,
      dimensions: [{ key: "environment", values: ["query"] }],
    } as MetricDefinition;
  });
}

class EmptyStatement {
  constructor(private readonly sql: string) {}
  bind() {
    return this;
  }
  async first<T>() {
    if (this.sql.includes("SELECT 1 AS authorized")) return { authorized: 1 } as T;
    return null;
  }
  async all<T>() {
    // SAFETY: this audit's empty fixture uses no D1 metadata fields and returns no rows.
    return { success: true, results: [], meta: {} } as unknown as D1Result<T>;
  }
}
class EmptyD1 {
  prepare(sql: string) {
    return new EmptyStatement(sql);
  }
}
class EmptyStorage implements ObjectStorage {
  async createOnly() {
    return "created" as const;
  }
  async head() {
    return null;
  }
  async getBytes() {
    return null;
  }
  async compensationDelete() {}
}

function percentile(sorted: number[], fraction: number) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function graphFixture() {
  const nodes = Array.from({ length: 100 }, (_, index) => ({
    id: `node-${index}`,
    label: `Refund service ${index}`,
    type: "function",
    source_file: `src/refund-${index}.ts`,
    source_location: `L${index + 1}`,
  }));
  const links = Array.from({ length: 200 }, (_, index) => ({
    source: `node-${index % 100}`,
    target: `node-${(index + 1) % 100}`,
    relation: "calls",
    confidence: "high",
    source_file: `src/refund-${index % 100}.ts`,
    source_location: `L${index + 1}`,
  }));
  return { directed: false, multigraph: false, graph: {}, nodes, links, hyperedges: [] };
}

const markdown = await readFile(new URL("../docs/ai/metrics.md", import.meta.url), "utf8");
validateRegistry(METRICS, markdown);
mutationTraps(markdown);

// SAFETY: The audit fake implements only the D1 prepare/bind/first/all subset exercised by this empty-source search.
function validateContextEvidence(value: { sourceCount: number; evidence: readonly unknown[] }) {
  assert.equal(
    value.sourceCount,
    value.evidence.length,
    "Context sourceCount must equal evidence length",
  );
}

const context = await new ContextEngine(
  // SAFETY: EmptyD1 implements the exact prepare/bind/first/all subset used by this empty-source search.
  new EmptyD1() as unknown as D1Database,
  new EmptyStorage(),
  ContextAuthorizationFence.human(["synthetic-project"], "synthetic-user"),
).search({
  projectId: "synthetic-project",
  query: "membership immutable payload",
  budget: {
    maxTokens: MCP_LIMITS.searchContext.defaultTokens,
    maxBytes: MCP_LIMITS.searchContext.defaultBytes,
  },
});
validateContextEvidence(context);
assert.throws(() => validateContextEvidence({ ...context, sourceCount: context.sourceCount + 1 }));
assert.equal(context.byteSize, new TextEncoder().encode(JSON.stringify(context)).byteLength);

const graph = graphFixture();
const projection = queryGraph(graph as never, { operation: "search", query: "refund", limit: 25 });
assert.ok(projection);
const projectionBytes = new TextEncoder().encode(JSON.stringify(projection)).byteLength;
const projectionRecords =
  "nodes" in projection && Array.isArray(projection.nodes) ? projection.nodes.length : 0;
assert.equal(projectionRecords, MCP_LIMITS.graph.maxRecords);
const graphQuery = (index: number) =>
  queryGraph(graph as never, {
    operation: "neighbors",
    nodeId: `node-${index % 100}`,
    limit: MCP_LIMITS.graph.maxRecords,
  });
const warmupSampleSize = 200;
for (let index = 0; index < warmupSampleSize; index += 1) assert.ok(graphQuery(index));
const timings: number[] = [];
for (let index = 0; index < 2_000; index += 1) {
  const started = performance.now();
  assert.ok(graphQuery(index));
  timings.push(performance.now() - started);
}
timings.sort((left, right) => left - right);
const mcp = await measureMcpTokenAudit();

const evidence = {
  result: "PASS",
  environment: {
    kind: "LOCAL_SYNTHETIC",
    node: process.version,
    platform: `${platform()} ${release()} ${arch()}`,
    production: false,
    warning: "Synthetic/local baselines are not production measurements or an SLA.",
  },
  registry: { metricCount: METRICS.length, mutationTraps: 10, liveOnlyBlocked: LIVE_ONLY.size },
  samples: {
    mcp: { sampleSize: mcp.responses.scenarios.length, scenarios: mcp.responses.scenarios },
    context: {
      sampleSize: 1,
      serializedBytes: context.byteSize,
      estimatedTokens: context.tokenEstimate,
      sourceCount: context.sourceCount,
      maxBytes: MCP_LIMITS.searchContext.defaultBytes,
      maxTokens: MCP_LIMITS.searchContext.defaultTokens,
    },
    graphProjection: {
      sampleSize: 1,
      serializedBytes: projectionBytes,
      returnedRecords: projectionRecords,
      productionMaxRecords: MCP_LIMITS.graph.maxRecords,
    },
    artifact: {
      sampleSize: 0,
      productionMcpContentMaxBytes: MCP_LIMITS.artifact.contentBytes,
      note: "Production export bound; no payload collected.",
    },
    localGraphQuery: {
      warmupSampleSize,
      sampleSize: timings.length,
      fixtureNodes: graph.nodes.length,
      fixtureLinks: graph.links.length,
      p50Milliseconds: percentile(timings, 0.5),
      p70Milliseconds: percentile(timings, 0.7),
      p85Milliseconds: percentile(timings, 0.85),
      p95Milliseconds: percentile(timings, 0.95),
    },
  },
  blocked: {
    dashboardTiming: "No reproducible browser timing harness; BLOCKED_LIVE.",
    e2eStageDurations: "Current E2E harness has no structured redacted stage timing; not invented.",
    liveAnalytics:
      "No Cloudflare/GitHub analytics receipts and no production collection performed.",
  },
};
console.log(JSON.stringify(evidence, null, 2));
