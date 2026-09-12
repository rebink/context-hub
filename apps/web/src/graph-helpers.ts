export type ProjectRole = "ADMIN" | "EDITOR" | "VIEWER";
export type GraphStatus = "QUEUED" | "BUILDING" | "FAILED" | "READY" | "SUPERSEDED";

export type GraphVersion = {
  projectId: string;
  version: number;
  repository: {
    provider: string;
    providerRepositoryId: string;
    owner: string;
    name: string;
    canonicalUrl: string;
  };
  sourceCommitSha: string;
  graphifyVersion: string;
  adapterVersion: string;
  profile: string;
  formatVersion: number;
  generator: string;
  generatedBy: string | null;
  status: GraphStatus;
  attempt: number;
  failureCategory: string | null;
  checksum: string | null;
  byteSize: number | null;
  nodeCount: number | null;
  linkCount: number | null;
  hyperedgeCount: number | null;
  queuedAt: string;
  buildStartedAt: string | null;
  failedAt: string | null;
  generatedAt: string | null;
  supersededAt: string | null;
  updatedAt: string;
};

export type GraphNode = {
  id: string;
  label: string | null;
  type: string | null;
  sourceFile: string | null;
  sourceLocation: string | null;
};

export type GraphLink = {
  source: string;
  target: string;
  relation: string | null;
  confidence: string | null;
  sourceFile: string | null;
  sourceLocation: string | null;
};

export type GraphQueryOperation =
  | "search"
  | "node"
  | "neighbors"
  | "callers"
  | "callees"
  | "path"
  | "sources";

export type GraphQueryResult = {
  operation: GraphQueryOperation;
  node?: GraphNode | null;
  nodeId?: string;
  nodes?: GraphNode[];
  links?: GraphLink[];
  sources?: { file: string; location: string }[];
  path?: { nodes: GraphNode[]; links: GraphLink[] } | null;
  truncated: boolean;
};

export function graphGeneratorMetadata(graph: GraphVersion): {
  generator: string;
  generatedBy: string;
} {
  return {
    generator: graph.generator,
    generatedBy: graph.generatedBy ?? "Not published",
  };
}

export function graphCapabilities(role: ProjectRole): { canBuild: boolean; label: string } {
  return role === "ADMIN"
    ? { canBuild: true, label: "Administrator / generation controls enabled" }
    : {
        canBuild: false,
        label: `${role === "VIEWER" ? "Viewer" : "Editor"} / graph access is read-only`,
      };
}

export function selectGraphState(
  graphs: readonly GraphVersion[],
  latestReady: GraphVersion | null,
): {
  graphs: GraphVersion[];
  newestAttempt: GraphVersion | null;
  currentReady: GraphVersion | null;
  selected: GraphVersion | null;
} {
  const byVersion = new Map<number, GraphVersion>();
  for (const graph of [...graphs, ...(latestReady ? [latestReady] : [])]) {
    const prior = byVersion.get(graph.version);
    if (!prior || (graph.status === "READY" && prior.status !== "READY"))
      byVersion.set(graph.version, graph);
  }
  const snapshots = [...byVersion.values()].sort((left, right) => right.version - left.version);
  const readyVersion = snapshots.find((graph) => graph.status === "READY")?.version ?? null;
  const ordered = snapshots.map((graph) =>
    graph.status === "READY" && graph.version !== readyVersion
      ? { ...graph, status: "SUPERSEDED" as const }
      : graph,
  );
  const currentReady =
    readyVersion === null
      ? null
      : (ordered.find((graph) => graph.version === readyVersion) ?? null);
  return {
    graphs: ordered,
    newestAttempt: ordered[0] ?? null,
    currentReady,
    selected: currentReady,
  };
}

export type GraphOperation = "load" | "query" | "build";

export class GraphOperationCoordinator {
  private sequence = 0;
  private readonly operations = new Map<
    GraphOperation,
    { token: number; controller: AbortController }
  >();

  begin(operation: GraphOperation): { token: number; signal: AbortSignal } {
    this.abort(operation);
    const active = { token: ++this.sequence, controller: new AbortController() };
    this.operations.set(operation, active);
    return { token: active.token, signal: active.controller.signal };
  }

  isCurrent(operation: GraphOperation, token: number): boolean {
    return this.operations.get(operation)?.token === token;
  }

  finish(operation: GraphOperation, token: number): boolean {
    if (!this.isCurrent(operation, token)) return false;
    this.operations.delete(operation);
    return true;
  }

  abort(operation: GraphOperation): void {
    this.operations.get(operation)?.controller.abort();
    this.operations.delete(operation);
  }

  abortAll(): void {
    for (const operation of ["load", "query", "build"] as const) this.abort(operation);
  }
}

export function firstMissingGraphQueryField(
  operation: GraphQueryOperation,
  payload: Readonly<Record<string, string | number>>,
): "query" | "nodeId" | "source" | "target" | null {
  if (operation === "search") return payload.query ? null : "query";
  if (operation === "path") {
    if (!payload.source) return "source";
    return payload.target ? null : "target";
  }
  if (["node", "neighbors", "callers", "callees"].includes(operation))
    return payload.nodeId ? null : "nodeId";
  return null;
}

export function isQueryableGraph(graph: GraphVersion): boolean {
  return graph.status === "READY" || graph.status === "SUPERSEDED";
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(number)));
}

export function normalizeGraphQuery(input: {
  operation: GraphQueryOperation;
  query?: unknown;
  nodeId?: unknown;
  source?: unknown;
  target?: unknown;
  limit?: unknown;
  maxDepth?: unknown;
}): Record<string, string | number> {
  const payload: Record<string, string | number> = {
    operation: input.operation,
    limit: boundedInteger(input.limit, 25, 25),
  };
  const clean = (value: unknown, maximum: number) =>
    String(value ?? "")
      .trim()
      .slice(0, maximum);
  if (input.operation === "search") payload.query = clean(input.query, 128);
  if (["node", "neighbors", "callers", "callees"].includes(input.operation)) {
    payload.nodeId = clean(input.nodeId, 512);
  }
  if (input.operation === "sources" && clean(input.nodeId, 512)) {
    payload.nodeId = clean(input.nodeId, 512);
  }
  if (input.operation === "path") {
    payload.source = clean(input.source, 512);
    payload.target = clean(input.target, 512);
    payload.maxDepth = boundedInteger(input.maxDepth, 8, 8);
  }
  return payload;
}

export function graphResultAnnouncement(result: GraphQueryResult): string {
  return `${result.operation} query complete${result.truncated ? "; results were truncated" : ""}.`;
}

export function directedResultRows(result: GraphQueryResult): Array<{
  heading: string;
  detail: string;
  source: string;
}> {
  if (!result.links?.length) return [];
  return result.links.map((link) => {
    const direction =
      result.operation === "callers"
        ? `${link.source} calls ${link.target}`
        : result.operation === "callees"
          ? `${link.source} calls ${link.target}`
          : `${link.source} -> ${link.target}`;
    return {
      heading: direction,
      detail:
        [link.relation, link.confidence].filter(Boolean).join(" / ") ||
        "Relation metadata unavailable",
      source:
        [link.sourceFile, link.sourceLocation].filter(Boolean).join(":") ||
        "Source location unavailable",
    };
  });
}

export function shouldRestoreGraphFocus(
  control: { isConnected: boolean } | null,
): control is { isConnected: true } {
  return control?.isConnected === true;
}

export function isCurrentGraphRequest(
  requestGeneration: number,
  requestProjectId: string,
  currentGeneration: number,
  currentProjectId: string,
): boolean {
  return requestGeneration === currentGeneration && requestProjectId === currentProjectId;
}
