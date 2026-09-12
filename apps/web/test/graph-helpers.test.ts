import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  directedResultRows,
  firstMissingGraphQueryField,
  GraphOperationCoordinator,
  type GraphQueryResult,
  type GraphVersion,
  graphCapabilities,
  graphGeneratorMetadata,
  graphResultAnnouncement,
  isCurrentGraphRequest,
  isQueryableGraph,
  normalizeGraphQuery,
  selectGraphState,
  shouldRestoreGraphFocus,
} from "../src/graph-helpers.js";

function graph(version: number, status: GraphVersion["status"]): GraphVersion {
  return {
    projectId: "project-a",
    version,
    repository: {
      provider: "github",
      providerRepositoryId: "repo-1",
      owner: "team",
      name: "service",
      canonicalUrl: "https://github.com/team/service",
    },
    sourceCommitSha: "a".repeat(40),
    graphifyVersion: "0.9.58",
    adapterVersion: "1.0.0",
    profile: "code-only-clustered-v1",
    formatVersion: 1,
    generator: "graphify/0.9.58",
    generatedBy: status === "READY" || status === "SUPERSEDED" ? "runner-safe-label" : null,
    status,
    attempt: 1,
    failureCategory: status === "FAILED" ? "TOOL_FAILED" : null,
    checksum: status === "READY" || status === "SUPERSEDED" ? "b".repeat(64) : null,
    byteSize: status === "READY" || status === "SUPERSEDED" ? 123 : null,
    nodeCount: status === "READY" || status === "SUPERSEDED" ? 3 : null,
    linkCount: status === "READY" || status === "SUPERSEDED" ? 2 : null,
    hyperedgeCount: status === "READY" || status === "SUPERSEDED" ? 0 : null,
    queuedAt: "2026-01-01T00:00:00.000Z",
    buildStartedAt: null,
    failedAt: null,
    generatedAt: status === "READY" || status === "SUPERSEDED" ? "2026-01-01T00:01:00.000Z" : null,
    supersededAt: status === "SUPERSEDED" ? "2026-01-02T00:00:00.000Z" : null,
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
}

describe("Graph response state selection", () => {
  it("separates the newest attempt from the current READY graph", () => {
    const ready = graph(2, "READY");
    const state = selectGraphState([graph(3, "FAILED"), graph(1, "SUPERSEDED"), ready], ready);
    assert.equal(state.newestAttempt?.version, 3);
    assert.equal(state.currentReady?.version, 2);
    assert.equal(state.selected?.version, 2);
  });

  it("falls back to a READY history row and represents the empty state honestly", () => {
    assert.equal(
      selectGraphState([graph(2, "QUEUED"), graph(1, "READY")], null).currentReady?.version,
      1,
    );
    assert.deepEqual(selectGraphState([], null), {
      graphs: [],
      newestAttempt: null,
      currentReady: null,
      selected: null,
    });
    assert.equal(isQueryableGraph(graph(1, "READY")), true);
    assert.equal(isQueryableGraph(graph(2, "SUPERSEDED")), true);
    assert.equal(isQueryableGraph(graph(3, "FAILED")), false);
  });

  it("chooses the highest READY version from contradictory latest/history snapshots", () => {
    const higherHistory = selectGraphState(
      [graph(4, "READY"), graph(3, "SUPERSEDED")],
      graph(2, "READY"),
    );
    assert.equal(higherHistory.currentReady?.version, 4);
    assert.equal(higherHistory.graphs.filter((item) => item.status === "READY").length, 1);
    assert.equal(higherHistory.graphs.find((item) => item.version === 2)?.status, "SUPERSEDED");
    const higherLatest = selectGraphState(
      [graph(4, "SUPERSEDED"), graph(3, "READY")],
      graph(4, "READY"),
    );
    assert.equal(higherLatest.currentReady?.version, 4);
    assert.equal(higherLatest.graphs.find((item) => item.version === 4)?.status, "READY");
    assert.equal(higherLatest.graphs.filter((item) => item.status === "READY").length, 1);
    assert.equal(higherLatest.graphs.find((item) => item.version === 3)?.status, "SUPERSEDED");
  });

  it("normalizes stale same-version snapshots without losing READY", () => {
    const state = selectGraphState([graph(5, "READY")], graph(5, "SUPERSEDED"));
    assert.equal(state.currentReady?.version, 5);
    assert.equal(state.graphs.filter((item) => item.status === "READY").length, 1);
  });
});

describe("Graph role capabilities and query payloads", () => {
  it("keeps the canonical generator separate from bounded publisher provenance", () => {
    assert.deepEqual(graphGeneratorMetadata(graph(1, "READY")), {
      generator: "graphify/0.9.58",
      generatedBy: "runner-safe-label",
    });
    assert.deepEqual(graphGeneratorMetadata(graph(2, "SUPERSEDED")), {
      generator: "graphify/0.9.58",
      generatedBy: "runner-safe-label",
    });
    assert.deepEqual(graphGeneratorMetadata(graph(3, "QUEUED")), {
      generator: "graphify/0.9.58",
      generatedBy: "Not published",
    });
  });

  it("permits generation only for project administrators", () => {
    assert.equal(graphCapabilities("ADMIN").canBuild, true);
    assert.equal(graphCapabilities("EDITOR").canBuild, false);
    assert.equal(graphCapabilities("VIEWER").canBuild, false);
    assert.match(graphCapabilities("VIEWER").label, /read-only/);
  });

  it("focuses the first missing path endpoint", () => {
    assert.equal(
      firstMissingGraphQueryField("path", { operation: "path", source: "", target: "" }),
      "source",
    );
    assert.equal(
      firstMissingGraphQueryField("path", { operation: "path", source: "a", target: "" }),
      "target",
    );
    assert.equal(
      firstMissingGraphQueryField("path", { operation: "path", source: "a", target: "b" }),
      null,
    );
  });

  it("normalizes each operation to its bounded backend payload", () => {
    assert.deepEqual(
      normalizeGraphQuery({ operation: "search", query: "  parser  ", limit: 200 }),
      {
        operation: "search",
        query: "parser",
        limit: 25,
      },
    );
    assert.deepEqual(normalizeGraphQuery({ operation: "callers", nodeId: " node-1 ", limit: 0 }), {
      operation: "callers",
      nodeId: "node-1",
      limit: 1,
    });
    assert.deepEqual(
      normalizeGraphQuery({
        operation: "path",
        source: "source",
        target: "target",
        limit: "10",
        maxDepth: 99,
      }),
      {
        operation: "path",
        source: "source",
        target: "target",
        limit: 10,
        maxDepth: 8,
      },
    );
    assert.deepEqual(normalizeGraphQuery({ operation: "sources", nodeId: " " }), {
      operation: "sources",
      limit: 25,
    });
  });
});

describe("Directed result shaping", () => {
  const link = {
    source: "caller",
    target: "callee",
    relation: "CALLS",
    confidence: "HIGH",
    sourceFile: "src/main.ts",
    sourceLocation: "12:4",
  };

  it("keeps caller and callee direction, relation, confidence, and source location", () => {
    const callers = directedResultRows({ operation: "callers", links: [link], truncated: false });
    const callees = directedResultRows({ operation: "callees", links: [link], truncated: false });
    assert.deepEqual(callers[0], {
      heading: "caller calls callee",
      detail: "CALLS / HIGH",
      source: "src/main.ts:12:4",
    });
    assert.equal(callees[0]?.heading, "caller calls callee");
  });

  it("announces backend truncation without changing result content", () => {
    const result: GraphQueryResult = { operation: "search", nodes: [], truncated: true };
    assert.equal(graphResultAnnouncement(result), "search query complete; results were truncated.");
    assert.equal(
      graphResultAnnouncement({ ...result, truncated: false }),
      "search query complete.",
    );
  });
});

describe("Graph operation coordination", () => {
  it("cancels and clears only the matching operation while preserving an in-flight build", () => {
    const coordinator = new GraphOperationCoordinator();
    const build = coordinator.begin("build");
    const query = coordinator.begin("query");
    const refresh = coordinator.begin("load");
    coordinator.abort("query");
    assert.equal(query.signal.aborted, true);
    assert.equal(build.signal.aborted, false);
    assert.equal(coordinator.isCurrent("build", build.token), true);
    assert.equal(coordinator.finish("load", refresh.token), true);
    assert.equal(coordinator.finish("build", build.token), true);
  });

  it("restores focus only to a control still connected to the current view", () => {
    assert.equal(shouldRestoreGraphFocus({ isConnected: true }), true);
    assert.equal(shouldRestoreGraphFocus({ isConnected: false }), false);
    assert.equal(shouldRestoreGraphFocus(null), false);
  });

  it("aborts an active same-version query before a replacement submit starts", () => {
    const coordinator = new GraphOperationCoordinator();
    const oldQuery = coordinator.begin("query");
    const replacement = coordinator.begin("query");
    assert.equal(oldQuery.signal.aborted, true);
    assert.equal(coordinator.finish("query", oldQuery.token), false);
    assert.equal(coordinator.isCurrent("query", replacement.token), true);
  });

  it("aborts an active query when inputs change before another query starts", () => {
    const coordinator = new GraphOperationCoordinator();
    const oldQuery = coordinator.begin("query");
    coordinator.abort("query");
    const nextQuery = coordinator.begin("query");
    assert.equal(oldQuery.signal.aborted, true);
    assert.equal(nextQuery.signal.aborted, false);
    assert.equal(coordinator.isCurrent("query", nextQuery.token), true);
  });

  it("does not let an older completion clear a replacement operation", () => {
    const coordinator = new GraphOperationCoordinator();
    const first = coordinator.begin("load");
    const second = coordinator.begin("load");
    assert.equal(first.signal.aborted, true);
    assert.equal(coordinator.finish("load", first.token), false);
    assert.equal(coordinator.isCurrent("load", second.token), true);
  });
});

describe("Graph stale request guard", () => {
  it("requires both generation and project identity to remain current", () => {
    assert.equal(isCurrentGraphRequest(4, "project-a", 4, "project-a"), true);
    assert.equal(isCurrentGraphRequest(3, "project-a", 4, "project-a"), false);
    assert.equal(isCurrentGraphRequest(4, "project-a", 4, "project-b"), false);
  });
});
