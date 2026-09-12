import { createHash } from "node:crypto";
import {
  MCP_LIMITS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  type McpDispatch,
  WorkerMcpTransport,
} from "../src/mcp-transport.js";

const encoder = new TextEncoder();

export const estimateTokens = (value: string): number =>
  Math.max(1, Math.ceil(encoder.encode(value).byteLength / 4));

const byteLength = (value: string): number => encoder.encode(value).byteLength;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function request(body: unknown): Request {
  return new Request("https://api.example/mcp", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function contextResult(projectId: string, suffix: string) {
  const commit = suffix.repeat(40).slice(0, 40);
  const checksum = suffix.repeat(64).slice(0, 64);
  const evidence = [
    {
      kind: "ARTIFACT",
      title: "Payment retry architecture",
      excerpt:
        "Retries use an idempotency key, capped exponential backoff, and a terminal dead-letter state.",
      relevanceReason: "matches task terms; architecture evidence; domain payments",
      tokenEstimate: 92,
      freshness: "CURRENT",
      provenance: {
        projectId,
        source: "ARTIFACT",
        path: "artifacts/architecture-retries",
        section: "Retry policy",
        version: "3",
        commit,
        checksum,
      },
    },
    {
      kind: "GRAPH",
      title: "RetryPayment",
      excerpt:
        '{"node":{"id":"RetryPayment","source_file":"src/payments/retry.ts","source_location":"L42"},"relationships":[{"source":"RetryPayment","target":"PaymentGateway","relation":"calls"}]}',
      relevanceReason: "task-matched Graphify node with bounded relationships",
      tokenEstimate: 108,
      freshness: null,
      provenance: {
        projectId,
        source: "GRAPH",
        path: "src/payments/retry.ts",
        section: "L42",
        version: "7",
        commit,
        checksum,
      },
    },
  ];
  const base = {
    projectId,
    evidence,
    tokenEstimate: 200,
    byteSize: 0,
    truncated: false,
    sourceErrors: [],
  };
  let measured = byteLength(JSON.stringify(base));
  while (base.byteSize !== measured) {
    base.byteSize = measured;
    measured = byteLength(JSON.stringify(base));
  }
  return base;
}

function successFixture(projectIds: string[]) {
  const projects = projectIds.map((projectId, index) =>
    contextResult(projectId, String.fromCharCode(97 + index)),
  );
  return {
    projects,
    budget: {
      maxTokens: MCP_LIMITS.searchContext.maxTokens,
      maxBytes: MCP_LIMITS.searchContext.maxBytes,
    },
    tokenEstimate: projects.reduce((sum, project) => sum + project.tokenEstimate, 0),
    byteSize: projects.reduce((sum, project) => sum + project.byteSize, 0),
    truncated: false,
  };
}

async function encodedResponse(
  id: string,
  dispatch: McpDispatch,
  argumentsValue: Record<string, unknown>,
): Promise<{ wire: string; modelText: string | null; status: number }> {
  const response = await new WorkerMcpTransport().handle(
    request({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "search_context", arguments: argumentsValue },
    }),
    dispatch,
  );
  const wire = await response.text();
  const parsed = JSON.parse(wire) as {
    result?: { content?: Array<{ type?: string; text?: string }> };
  };
  const text = parsed.result?.content?.[0]?.text;
  return { wire, modelText: typeof text === "string" ? text : null, status: response.status };
}

export type McpTokenAudit = Awaited<ReturnType<typeof measureMcpTokenAudit>>;

export async function measureMcpTokenAudit() {
  const schemaJson = JSON.stringify(MCP_TOOLS);
  const schemaRuns = [];
  for (const projectCount of [1, 10, 100]) {
    const authorizedProjects = Array.from(
      { length: projectCount },
      (_, index) => `authorized-project-${index + 1}`,
    );
    const response = await new WorkerMcpTransport().handle(
      request({ jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} }),
      async (input) => {
        if (input.kind !== "list-tools") return { ok: false, code: "INVALID_REQUEST", status: 400 };
        // The inventory is deliberately captured but never advertised by the transport.
        void authorizedProjects;
        return { ok: true };
      },
    );
    const wire = await response.text();
    const parsed = JSON.parse(wire) as { result: { tools: unknown[] } };
    const advertised = JSON.stringify(parsed.result.tools);
    schemaRuns.push({
      projectCount,
      toolCount: parsed.result.tools.length,
      schemaBytes: byteLength(advertised),
      estimatedTokens: estimateTokens(advertised),
      sha256: sha256(advertised),
      toolsListEnvelopeBytes: byteLength(wire),
      containsProjectEnumeration: authorizedProjects.some((projectId) => wire.includes(projectId)),
    });
  }

  const single = await encodedResponse(
    "single-project",
    async () => ({ ok: true, value: successFixture(["project-payments"]) }),
    {
      projectId: "project-payments",
      query: "How are payment retries bounded?",
      maxTokens: MCP_LIMITS.searchContext.maxTokens,
      maxBytes: MCP_LIMITS.searchContext.maxBytes,
    },
  );
  const two = await encodedResponse(
    "two-project",
    async () => ({
      ok: true,
      value: successFixture(["project-payments", "project-identity"]),
    }),
    {
      projectIds: ["project-payments", "project-identity"],
      query: "How do payment retries use identity?",
      maxTokens: MCP_LIMITS.searchContext.maxTokens,
      maxBytes: MCP_LIMITS.searchContext.maxBytes,
    },
  );
  const rejected = await encodedResponse(
    "partially-unauthorized",
    async () => ({ ok: false, code: "PROJECT_NOT_FOUND", status: 404 }),
    {
      projectIds: ["project-payments", "project-private-mobile"],
      query: "Return cross-project architecture",
      maxTokens: MCP_LIMITS.searchContext.maxTokens,
      maxBytes: MCP_LIMITS.searchContext.maxBytes,
    },
  );

  const scenarios = [
    { name: "single-project", ...single },
    { name: "explicit-two-project", ...two },
    { name: "rejected-partially-unauthorized", ...rejected },
  ].map(({ name, wire, modelText, status }) => ({
    name,
    status,
    envelopeBytes: byteLength(wire),
    envelopeEstimatedTokens: estimateTokens(wire),
    modelVisibleTextBytes: modelText === null ? 0 : byteLength(modelText),
    modelVisibleTextEstimatedTokens: modelText === null ? 0 : estimateTokens(modelText),
    responseSha256: sha256(wire),
    leaksRejectedProjectData:
      name === "rejected-partially-unauthorized" &&
      ["project-payments", "project-private-mobile", "provenance", "checksum", "commit"].some(
        (value) => wire.includes(value),
      ),
  }));
  const envelopeBytes = scenarios.map((scenario) => scenario.envelopeBytes);
  const modelVisibleScenarios = scenarios.filter((scenario) => scenario.modelVisibleTextBytes > 0);
  const totalWorstCaseBytes = byteLength(schemaJson) + MCP_LIMITS.transport.responseBytes;

  return {
    estimator: "max(1, ceil(UTF-8 bytes / 4)) for measured strings",
    toolNames: [...MCP_TOOL_NAMES],
    schema: {
      bytes: byteLength(schemaJson),
      estimatedTokens: estimateTokens(schemaJson),
      sha256: sha256(schemaJson),
      runs: schemaRuns,
    },
    responses: {
      scenarios,
      averageEnvelopeBytes: Math.ceil(
        envelopeBytes.reduce((sum, value) => sum + value, 0) / envelopeBytes.length,
      ),
      averageEnvelopeEstimatedTokens: Math.ceil(
        scenarios.reduce((sum, value) => sum + value.envelopeEstimatedTokens, 0) / scenarios.length,
      ),
      averageModelVisibleTextBytes: Math.ceil(
        modelVisibleScenarios.reduce((sum, value) => sum + value.modelVisibleTextBytes, 0) /
          modelVisibleScenarios.length,
      ),
      averageModelVisibleTextEstimatedTokens: Math.ceil(
        modelVisibleScenarios.reduce(
          (sum, value) => sum + value.modelVisibleTextEstimatedTokens,
          0,
        ) / modelVisibleScenarios.length,
      ),
      largestMeasuredEnvelopeBytes: Math.max(...envelopeBytes),
      largestMeasuredModelVisibleTextBytes: Math.max(
        ...modelVisibleScenarios.map((scenario) => scenario.modelVisibleTextBytes),
      ),
    },
    limits: MCP_LIMITS,
    worstCase: {
      schemaPlusMaximumResponseBytes: totalWorstCaseBytes,
      estimatedTokens: estimateTokens("x".repeat(totalWorstCaseBytes)),
    },
  };
}
