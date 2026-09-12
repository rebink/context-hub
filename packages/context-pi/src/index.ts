import { randomUUID } from "node:crypto";
import {
  connectProject,
  ensureLayout,
  localRemote,
  normalizeGithubRemote,
  projectStatus,
  readLocalGraph,
  readManifest,
  repositoryRoot,
  SyncClient,
  syncProject,
  validateApiOrigin,
} from "@context-hub/context-cli";

export const PI_COMMAND = Object.freeze({
  name: "context",
  description: "Connect, status, sync, search, graph, or inspect snapshot availability",
  subcommands: Object.freeze(["connect", "status", "sync", "search", "graph", "snapshot"]),
});

export const PI_OUTPUT_LIMITS = Object.freeze({
  notificationBytes: 16 * 1024,
  searchRequestBytes: 12 * 1024,
  mcpResponseBytes: 128 * 1024,
});

const MCP_TOKEN = /^chmcp_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;

type NotifyLevel = "info" | "warning" | "error";
type CommandContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify(message: string, level?: NotifyLevel): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    setStatus(id: string, value: string | undefined): void;
  };
};
type ExtensionApi = {
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(args: string, context: CommandContext): Promise<void>;
    },
  ): void;
  on(
    event: "session_start" | "session_shutdown",
    handler: (_event: unknown, context: CommandContext) => void | Promise<void>,
  ): void;
};

type Environment = Record<string, string | undefined>;
type Dependencies = {
  env: Environment;
  fetchImplementation: typeof fetch;
  connect: typeof connectProject;
  status: typeof projectStatus;
  sync: typeof syncProject;
  root: typeof repositoryRoot;
  remote: typeof localRemote;
  layout: typeof ensureLayout;
  localGraph: typeof readLocalGraph;
  manifest: typeof readManifest;
  makeSyncClient: (origin: string, session: string) => SyncClient;
};

type RpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

const TRUNCATION_MARKER = "\n[output truncated]";

function safeText(value: string): string {
  const redacted = value
    .replace(/chmcp_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/g, "[REDACTED]")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(redacted);
  if (bytes.byteLength <= PI_OUTPUT_LIMITS.notificationBytes) return redacted;
  const markerBytes = encoder.encode(TRUNCATION_MARKER).byteLength;
  let end = PI_OUTPUT_LIMITS.notificationBytes - markerBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return `${decoder.decode(bytes.subarray(0, end))}${TRUNCATION_MARKER}`;
    } catch {
      end -= 1;
    }
  }
  return TRUNCATION_MARKER;
}

function notify(context: CommandContext, message: string, level: NotifyLevel = "info") {
  context.ui.notify(safeText(message), level);
}

function environmentCredential(
  env: Environment,
  name: "CONTEXT_HUB_SESSION" | "CONTEXT_HUB_MCP_TOKEN",
) {
  const value = env[name];
  if (!value || value.length > 4096 || /[\r\n]/.test(value)) throw new Error(`${name}_REQUIRED`);
  if (name === "CONTEXT_HUB_MCP_TOKEN" && !MCP_TOKEN.test(value))
    throw new Error("CONTEXT_HUB_MCP_TOKEN_INVALID");
  return value;
}

function environmentOrigin(env: Environment) {
  const value = env.CONTEXT_HUB_API;
  if (!value) throw new Error("CONTEXT_HUB_API_REQUIRED");
  return validateApiOrigin(value);
}

function errorCode(error: unknown) {
  if (!(error instanceof Error)) return "INTERNAL_ERROR";
  const code = error.message;
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  return "INTERNAL_ERROR";
}

async function boundedResponseBytes(response: Response) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > PI_OUTPUT_LIMITS.mcpResponseBytes))
    throw new Error("RESPONSE_TOO_LARGE");
  if (!response.body) throw new Error("MCP_PROTOCOL_ERROR");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > PI_OUTPUT_LIMITS.mcpResponseBytes) {
      await reader.cancel();
      throw new Error("RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function validInitializeResult(value: unknown) {
  const result = record(value);
  const capabilities = result && record(result.capabilities);
  const tools = capabilities && record(capabilities.tools);
  const serverInfo = result && record(result.serverInfo);
  return Boolean(
    result &&
      exactKeys(result, ["protocolVersion", "capabilities", "serverInfo"]) &&
      result.protocolVersion === "2025-03-26" &&
      capabilities &&
      exactKeys(capabilities, ["tools"]) &&
      tools &&
      exactKeys(tools, ["listChanged"]) &&
      tools.listChanged === false &&
      serverInfo &&
      exactKeys(serverInfo, ["name", "version"]) &&
      serverInfo.name === "context-hub" &&
      typeof serverInfo.version === "string" &&
      serverInfo.version.length >= 1 &&
      serverInfo.version.length <= 100,
  );
}

class McpClient {
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly origin: string,
    private readonly credential: string,
    private readonly fetchImplementation: typeof fetch,
  ) {}

  private async request(method: string, params: Record<string, unknown>, notification = false) {
    const id = this.nextId++;
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.origin}/mcp`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.credential}`,
          "content-type": "application/json",
          "x-context-nonce": randomUUID(),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
      });
    } catch {
      throw new Error("OFFLINE");
    }
    if (response.status >= 300 && response.status < 400) throw new Error("REDIRECT_REJECTED");
    if (notification) {
      if (response.status !== 202) throw new Error("MCP_PROTOCOL_ERROR");
      return undefined;
    }
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
      throw new Error("MCP_PROTOCOL_ERROR");
    const bytes = await boundedResponseBytes(response);
    let decoded: RpcResponse;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("MCP_PROTOCOL_ERROR");
    }
    if (decoded.jsonrpc !== "2.0" || decoded.id !== id) throw new Error("MCP_PROTOCOL_ERROR");
    if (!response.ok || decoded.error)
      throw new Error(decoded.error?.message ?? "MCP_REQUEST_FAILED");
    return decoded.result;
  }

  private async initialize() {
    if (this.initialized) return;
    const result = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "context-hub-pi", version: "0.1.0" },
    });
    if (!validInitializeResult(result)) throw new Error("MCP_PROTOCOL_ERROR");
    await this.request("notifications/initialized", {}, true);
    this.initialized = true;
  }

  async call(name: "search_context" | "query_graph", args: Record<string, unknown>) {
    await this.initialize();
    const result = record(await this.request("tools/call", { name, arguments: args }));
    const content = result?.content;
    if (!Array.isArray(content) || content.length !== 1) throw new Error("MCP_PROTOCOL_ERROR");
    const item = content[0];
    if (!item || typeof item !== "object" || (item as Record<string, unknown>).type !== "text")
      throw new Error("MCP_PROTOCOL_ERROR");
    const text = (item as Record<string, unknown>).text;
    if (typeof text !== "string") throw new Error("MCP_PROTOCOL_ERROR");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("MCP_PROTOCOL_ERROR");
    }
  }
}

async function liveSelection(directory: string, dependencies: Dependencies) {
  const root = await dependencies.root(directory);
  let canonical: string | null;
  try {
    canonical = normalizeGithubRemote(await dependencies.remote(root));
  } catch {
    throw new Error("COMMIT_MISMATCH");
  }
  if (!canonical) throw new Error("COMMIT_MISMATCH");
  const layout = await dependencies.layout(root);
  const manifest = await dependencies.manifest(layout);
  if (!manifest) throw new Error("NOT_CONNECTED");
  if (manifest.repository.canonicalUrl !== canonical) throw new Error("COMMIT_MISMATCH");
  return { layout, manifest };
}

function onlineOrigin(manifestOrigin: string, dependencies: Dependencies) {
  const origin = environmentOrigin(dependencies.env);
  if (origin !== manifestOrigin) throw new Error("CREDENTIAL_ORIGIN_MISMATCH");
  return origin;
}

async function resolveCandidates(
  directory: string,
  dependencies: Dependencies,
  signal?: AbortSignal,
) {
  const root = await dependencies.root(directory);
  const remote = await dependencies.remote(root);
  if (!normalizeGithubRemote(remote)) throw new Error("INVALID_REPOSITORY");
  const client = dependencies.makeSyncClient(
    environmentOrigin(dependencies.env),
    environmentCredential(dependencies.env, "CONTEXT_HUB_SESSION"),
  );
  return { remote, result: await client.resolveCandidates(remote, signal) };
}

async function persistSelection(
  projectId: string,
  context: CommandContext,
  dependencies: Dependencies,
  signal?: AbortSignal,
) {
  const manifest = await dependencies.connect({
    directory: context.cwd,
    apiOrigin: environmentOrigin(dependencies.env),
    session: environmentCredential(dependencies.env, "CONTEXT_HUB_SESSION"),
    projectId,
    fetchImplementation: dependencies.fetchImplementation,
    signal,
  });
  notify(context, `Connected Context Hub project ${manifest.projectId}.`);
}

async function connect(args: string, context: CommandContext, dependencies: Dependencies) {
  const requested = args.trim();
  if (requested && !/^[A-Za-z0-9_-]+$/.test(requested)) throw new Error("INVALID_PROJECT_ID");
  const { result } = await resolveCandidates(context.cwd, dependencies);
  if (result.match === "none") throw new Error("PROJECT_NOT_FOUND");
  let projectId = requested;
  if (requested && !result.projects.some((project) => project.id === requested))
    throw new Error("PROJECT_NOT_FOUND");
  if (!projectId && result.match === "unique") projectId = result.projects[0]?.id ?? "";
  if (!projectId) {
    if (!context.hasUI) throw new Error("AMBIGUOUS_PROJECT");
    const labels = result.projects.map((project) => `${project.name} (${project.id})`);
    const selected = await context.ui.select("Select Context Hub project", labels);
    if (!selected) throw new Error("SELECTION_REQUIRED");
    projectId = result.projects[labels.indexOf(selected)]?.id ?? "";
  }
  await persistSelection(projectId, context, dependencies);
}

function hasNoSearchMatches(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const projects = (value as Record<string, unknown>).projects;
  return (
    Array.isArray(projects) &&
    projects.length > 0 &&
    projects.every(
      (project) =>
        project &&
        typeof project === "object" &&
        !Array.isArray(project) &&
        Array.isArray((project as Record<string, unknown>).results) &&
        ((project as Record<string, unknown>).results as unknown[]).length === 0,
    )
  );
}

function compactLocalGraph(value: unknown, needle: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const graph = value as Record<string, unknown>;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.links)) return null;
  const term = needle.toLowerCase();
  const matches = graph.nodes
    .filter((node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return false;
      const item = node as Record<string, unknown>;
      return [item.id, item.label, item.norm_label].some(
        (field) => typeof field === "string" && field.toLowerCase().includes(term),
      );
    })
    .slice(0, 10)
    .map((node) => {
      const item = node as Record<string, unknown>;
      return {
        id: item.id,
        label: item.label,
        sourceFile: item.source_file,
        sourceLocation: item.source_location,
      };
    });
  const ids = new Set(matches.map((node) => node.id));
  const links = graph.links
    .filter((link) => {
      if (!link || typeof link !== "object" || Array.isArray(link)) return false;
      const item = link as Record<string, unknown>;
      return ids.has(item.source) || ids.has(item.target);
    })
    .slice(0, 20)
    .map((link) => {
      const item = link as Record<string, unknown>;
      return { source: item.source, target: item.target, relation: item.relation };
    });
  return { offline: true, matches, links, truncated: matches.length === 10 || links.length === 20 };
}

async function localGraphQuery(
  layout: Awaited<ReturnType<typeof ensureLayout>>,
  node: string,
  dependencies: Dependencies,
) {
  const graph = await dependencies.localGraph(layout);
  if (!graph) throw new Error("NO_LOCAL_GRAPH");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(graph.bytes));
  } catch {
    throw new Error("LOCAL_CACHE_CORRUPT");
  }
  const result = compactLocalGraph(value, node);
  if (!result) throw new Error("LOCAL_CACHE_CORRUPT");
  return result;
}

function createDependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  const env = overrides.env ?? process.env;
  const fetchImplementation = overrides.fetchImplementation ?? fetch;
  return {
    env,
    fetchImplementation,
    connect: connectProject,
    status: projectStatus,
    sync: syncProject,
    root: repositoryRoot,
    remote: localRemote,
    layout: ensureLayout,
    localGraph: readLocalGraph,
    manifest: readManifest,
    makeSyncClient: (origin, session) => new SyncClient(origin, session, fetchImplementation),
    ...overrides,
  };
}

export function createContextExtension(overrides: Partial<Dependencies> = {}) {
  const dependencies = createDependencies(overrides);
  return function contextExtension(pi: ExtensionApi) {
    let mcp: McpClient | undefined;
    let mcpOrigin: string | undefined;
    let mcpCredential: string | undefined;
    let lifecycleGeneration = 0;
    let startupController: AbortController | undefined;
    const mcpClient = (manifestOrigin: string) => {
      const origin = onlineOrigin(manifestOrigin, dependencies);
      const credential = environmentCredential(dependencies.env, "CONTEXT_HUB_MCP_TOKEN");
      if (!mcp || mcpOrigin !== origin || mcpCredential !== credential) {
        mcp = new McpClient(origin, credential, dependencies.fetchImplementation);
        mcpOrigin = origin;
        mcpCredential = credential;
      }
      return mcp;
    };

    pi.registerCommand(PI_COMMAND.name, {
      description: PI_COMMAND.description,
      handler: async (rawArgs, context) => {
        const [subcommand = "", ...rest] = rawArgs.trim().split(/\s+/);
        const argument = rest.join(" ").trim();
        try {
          if (subcommand === "connect") await connect(argument, context, dependencies);
          else if (subcommand === "status") {
            const session = dependencies.env.CONTEXT_HUB_SESSION;
            const status = await dependencies.status({
              directory: context.cwd,
              session,
              credentialApiOrigin: session ? environmentOrigin(dependencies.env) : undefined,
              fetchImplementation: dependencies.fetchImplementation,
            });
            notify(context, JSON.stringify(status));
          } else if (subcommand === "sync") {
            const manifest = await dependencies.sync({
              directory: context.cwd,
              session: environmentCredential(dependencies.env, "CONTEXT_HUB_SESSION"),
              credentialApiOrigin: environmentOrigin(dependencies.env),
              fetchImplementation: dependencies.fetchImplementation,
            });
            notify(
              context,
              `Synced project ${manifest.projectId}; graph ${manifest.graph?.version ?? "unavailable"}.`,
            );
          } else if (subcommand === "search") {
            if (argument.length < 2 || argument.length > 500) throw new Error("QUERY_REQUIRED");
            const selection = await liveSelection(context.cwd, dependencies);
            const value = await mcpClient(selection.manifest.apiOrigin).call("search_context", {
              projectId: selection.manifest.projectId,
              query: argument,
              maxTokens: 1000,
              maxBytes: PI_OUTPUT_LIMITS.searchRequestBytes,
            });
            notify(
              context,
              hasNoSearchMatches(value) ? "No context matches found." : JSON.stringify(value),
            );
          } else if (subcommand === "graph") {
            if (!argument || argument.length > 128) throw new Error("NODE_REQUIRED");
            const selection = await liveSelection(context.cwd, dependencies);
            try {
              const value = await mcpClient(selection.manifest.apiOrigin).call("query_graph", {
                projectId: selection.manifest.projectId,
                operation: "search",
                query: argument,
                limit: 20,
              });
              notify(context, JSON.stringify(value));
            } catch (error) {
              if (
                !["OFFLINE", "CONTEXT_HUB_API_REQUIRED", "CONTEXT_HUB_MCP_TOKEN_REQUIRED"].includes(
                  errorCode(error),
                )
              )
                throw error;
              notify(
                context,
                JSON.stringify(await localGraphQuery(selection.layout, argument, dependencies)),
                "warning",
              );
            }
          } else if (subcommand === "snapshot") {
            notify(
              context,
              "Context snapshots are available through the web/API. Pi creation requires a defined mutation-auth contract; no snapshot was created.",
              "warning",
            );
          } else throw new Error("USAGE_CONTEXT_COMMAND");
        } catch (error) {
          const code = errorCode(error);
          const message =
            code === "PROJECT_NOT_FOUND"
              ? "Context Hub is not connected for this repository."
              : code === "AMBIGUOUS_PROJECT"
                ? "Multiple authorized projects match; run /context connect <project-id>."
                : code === "UNAUTHENTICATED" || code === "PROJECT_NOT_FOUND"
                  ? "Context Hub authorization failed."
                  : code;
          notify(context, message, "error");
        }
      },
    });

    pi.on("session_start", async (_event, context) => {
      const generation = ++lifecycleGeneration;
      startupController?.abort();
      const controller = new AbortController();
      startupController = controller;
      context.ui.setStatus("context-hub", "context: local");
      if (!dependencies.env.CONTEXT_HUB_SESSION || !dependencies.env.CONTEXT_HUB_API) return;
      try {
        const { result } = await resolveCandidates(context.cwd, dependencies, controller.signal);
        if (generation !== lifecycleGeneration || controller.signal.aborted) return;
        const uniqueProject = result.projects[0];
        if (result.match === "unique" && uniqueProject) {
          await persistSelection(uniqueProject.id, context, dependencies, controller.signal);
          if (generation !== lifecycleGeneration || controller.signal.aborted) return;
        } else if (result.match === "none") {
          notify(context, "Context Hub is not connected for this repository.", "warning");
        } else {
          notify(
            context,
            "Multiple authorized Context Hub projects match; use /context connect.",
            "warning",
          );
        }
      } catch (error) {
        if (generation === lifecycleGeneration && !controller.signal.aborted)
          notify(context, `${errorCode(error)}; cached context remains available.`, "warning");
      }
    });
    pi.on("session_shutdown", (_event, context) => {
      lifecycleGeneration += 1;
      startupController?.abort();
      startupController = undefined;
      mcp = undefined;
      mcpOrigin = undefined;
      mcpCredential = undefined;
      context.ui.setStatus("context-hub", undefined);
    });
  };
}

export default createContextExtension();
