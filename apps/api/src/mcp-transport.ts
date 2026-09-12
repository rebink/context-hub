export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_TOOL_NAMES = Object.freeze([
  "project_info",
  "search_context",
  "get_artifact",
  "query_graph",
  "get_sources",
  "sync_status",
] as const);
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type McpDispatchRequest =
  | { kind: "negotiate" }
  | { kind: "initialize"; protocolVersion: typeof MCP_PROTOCOL_VERSION }
  | { kind: "initialized" }
  | { kind: "list-tools" }
  | { kind: "ping" }
  | { kind: "call-tool"; name: McpToolName; arguments: Record<string, unknown> };

export type McpDispatchResult =
  | { ok: true; value?: unknown }
  | { ok: false; code: string; status: number };

export type McpDispatch = (request: McpDispatchRequest) => Promise<McpDispatchResult>;

/** Bounded MCP wire decoding/encoding only; authentication and tool behavior are caller-owned. */
export interface McpTransport {
  handle(request: Request, dispatch: McpDispatch): Promise<Response>;
}

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

type JsonRpcId = string | number;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method: string;
  params?: unknown;
};

function scopeSchema(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      repository: { type: "string", minLength: 1, maxLength: 512 },
      projectId: { type: "string", minLength: 1, maxLength: 100 },
      projectIds: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 100 },
      },
      ...properties,
    },
    required,
    oneOf: [
      { required: ["repository"] },
      { required: ["projectId"] },
      { required: ["projectIds"] },
    ],
  };
}

const inputSchemas: Record<McpToolName, Record<string, unknown>> = {
  project_info: scopeSchema(),
  search_context: scopeSchema(
    {
      query: { type: "string", minLength: 2, maxLength: 500 },
      domain: { type: "string", minLength: 1, maxLength: 100 },
      package: { type: "string", minLength: 1, maxLength: 160 },
      maxTokens: { type: "integer", minimum: 32, maximum: 8000 },
      maxBytes: { type: "integer", minimum: 512, maximum: 65536 },
    },
    ["query"],
  ),
  get_artifact: scopeSchema(
    {
      artifactId: { type: "string", minLength: 1, maxLength: 100 },
      version: { type: "integer", minimum: 1, maximum: 2147483647 },
    },
    ["artifactId"],
  ),
  query_graph: scopeSchema(
    {
      operation: {
        type: "string",
        enum: ["search", "node", "neighbors", "callers", "callees", "sources", "path"],
      },
      query: { type: "string", minLength: 1, maxLength: 128 },
      nodeId: { type: "string", minLength: 1, maxLength: 512 },
      source: { type: "string", minLength: 1, maxLength: 512 },
      target: { type: "string", minLength: 1, maxLength: 512 },
      maxDepth: { type: "integer", minimum: 1, maximum: 8 },
      limit: { type: "integer", minimum: 1, maximum: 25 },
    },
    ["operation"],
  ),
  get_sources: scopeSchema({ limit: { type: "integer", minimum: 1, maximum: 50 } }),
  sync_status: scopeSchema(),
};

export const MCP_TOOLS = Object.freeze(
  MCP_TOOL_NAMES.map((name) => ({
    name,
    description: {
      project_info: "Return bounded project and repository metadata.",
      search_context: "Search bounded source-backed project context.",
      get_artifact: "Read one bounded immutable artifact version.",
      query_graph: "Run one bounded query against the current verified graph.",
      get_sources: "List bounded source and provenance metadata.",
      sync_status: "Return repository and graph synchronization status.",
    }[name],
    inputSchema: inputSchemas[name],
  })),
);

function json(value: unknown, status = 200, extra?: HeadersInit): Response {
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > MAX_RESPONSE_BYTES) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32603, message: "RESPONSE_TOO_LARGE" } },
      { status: 500, headers: JSON_HEADERS },
    );
  }
  const headers = new Headers(JSON_HEADERS);
  new Headers(extra).forEach((value, key) => {
    headers.set(key, value);
  });
  return new Response(encoded, { status, headers });
}

function acceptedNotification(): Response {
  const headers = new Headers(JSON_HEADERS);
  headers.delete("content-type");
  return new Response(null, { status: 202, headers });
}

function rpcError(id: JsonRpcId | null, code: number, message: string, status = 400): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

async function readJson(request: Request): Promise<unknown | null> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declared = request.headers.get("content-length");
  if (
    contentType !== "application/json" ||
    (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) ||
    !request.body
  )
    return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function requestShape(value: unknown): JsonRpcRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.jsonrpc !== "2.0" || typeof input.method !== "string") return null;
  if (
    input.id === null ||
    (input.id !== undefined &&
      typeof input.id !== "string" &&
      (typeof input.id !== "number" || !Number.isFinite(input.id)))
  )
    return null;
  return input as JsonRpcRequest;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function requiredRequestId(input: JsonRpcRequest): JsonRpcId | null {
  return input.id !== undefined && input.id !== null ? input.id : null;
}

function mappedFailure(id: JsonRpcId | null, failure: Extract<McpDispatchResult, { ok: false }>) {
  const code = failure.status === 401 ? -32001 : failure.status === 429 ? -32029 : -32000;
  return rpcError(id, code, failure.code, failure.status);
}

export class WorkerMcpTransport implements McpTransport {
  async handle(request: Request, dispatch: McpDispatch): Promise<Response> {
    if (request.method === "GET") {
      const authorized = await dispatch({ kind: "negotiate" });
      if (!authorized.ok) return mappedFailure(null, authorized);
      return rpcError(null, -32005, "SERVER_NOTIFICATIONS_UNSUPPORTED", 405);
    }
    if (request.method !== "POST") return rpcError(null, -32600, "METHOD_NOT_ALLOWED", 405);
    const accept = request.headers.get("accept");
    if (accept && !accept.includes("application/json") && !accept.includes("*/*"))
      return rpcError(null, -32600, "NOT_ACCEPTABLE", 406);
    const raw = await readJson(request);
    const input = requestShape(raw);
    if (!input) return rpcError(null, -32700, "INVALID_REQUEST", 400);
    const id = requiredRequestId(input);
    const isNotification = input.id === undefined;
    const protocolError = (code: number, message: string, status = 400) =>
      isNotification ? acceptedNotification() : rpcError(id, code, message, status);

    if (input.method === "notifications/initialized") {
      const params = input.params === undefined ? {} : object(input.params);
      if (!isNotification || !params || !exactKeys(params, []))
        return isNotification ? acceptedNotification() : rpcError(id, -32602, "INVALID_PARAMS");
      await dispatch({ kind: "initialized" });
      return acceptedNotification();
    }

    let decoded: McpDispatchRequest;
    if (input.method === "initialize") {
      const params = object(input.params);
      const clientInfo = params && object(params.clientInfo);
      if (
        !params ||
        !exactKeys(params, ["protocolVersion", "capabilities", "clientInfo"]) ||
        params.protocolVersion !== MCP_PROTOCOL_VERSION ||
        !object(params.capabilities) ||
        !clientInfo ||
        !exactKeys(clientInfo, ["name", "version"]) ||
        typeof clientInfo.name !== "string" ||
        clientInfo.name.length < 1 ||
        clientInfo.name.length > 100 ||
        typeof clientInfo.version !== "string" ||
        clientInfo.version.length < 1 ||
        clientInfo.version.length > 100
      )
        return protocolError(
          -32602,
          params?.protocolVersion === undefined ? "INVALID_PARAMS" : "UNSUPPORTED_PROTOCOL_VERSION",
        );
      decoded = { kind: "initialize", protocolVersion: MCP_PROTOCOL_VERSION };
    } else if (input.method === "ping") {
      const params = input.params === undefined ? {} : object(input.params);
      if (!params || !exactKeys(params, [])) return protocolError(-32602, "INVALID_PARAMS");
      decoded = { kind: "ping" };
    } else if (input.method === "tools/list") {
      const params = input.params === undefined ? {} : object(input.params);
      if (!params || !exactKeys(params, [])) return protocolError(-32602, "INVALID_PARAMS");
      decoded = { kind: "list-tools" };
    } else if (input.method === "tools/call") {
      const params = object(input.params);
      if (!params || !exactKeys(params, ["name", "arguments"]) || !("name" in params))
        return protocolError(-32602, "INVALID_PARAMS");
      const name = params.name;
      const args = params.arguments === undefined ? {} : object(params.arguments);
      if (typeof name !== "string" || !MCP_TOOL_NAMES.includes(name as McpToolName) || !args)
        return protocolError(-32602, "INVALID_PARAMS");
      decoded = {
        kind: "call-tool",
        name: name as McpToolName,
        arguments: args,
      };
    } else return protocolError(-32601, "METHOD_NOT_FOUND", 404);

    const result = await dispatch(decoded);
    if (isNotification) return acceptedNotification();
    if (!result.ok) return mappedFailure(id, result);
    const value =
      decoded.kind === "initialize"
        ? {
            protocolVersion: decoded.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "context-hub", version: "1.0.0" },
          }
        : decoded.kind === "list-tools"
          ? { tools: MCP_TOOLS }
          : decoded.kind === "ping"
            ? {}
            : {
                content: [{ type: "text", text: JSON.stringify(result.value ?? null) }],
                isError: false,
              };
    return json({ jsonrpc: "2.0", id, result: value });
  }
}
