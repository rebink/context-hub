import { createHash } from "node:crypto";
import { createContextExtension, PI_COMMAND, PI_OUTPUT_LIMITS } from "../src/index.ts";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const byteLength = (value: string) => encoder.encode(value).byteLength;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const token = `chmcp_00000000-0000-4000-8000-000000000000.${"a".repeat(43)}`;
const repository = {
  provider: "github",
  providerRepositoryId: "repo-1",
  owner: "acme",
  name: "payments",
  canonicalUrl: "github.com/acme/payments",
};
const manifest = {
  formatVersion: 1 as const,
  apiOrigin: "https://api.example.test",
  projectId: "project-one",
  repository,
  graph: null,
};
const initializeResult = {
  protocolVersion: "2025-03-26",
  capabilities: { tools: { listChanged: false } },
  serverInfo: { name: "context-hub", version: "1.0.0" },
};
const allowedEvents = new Set(["session_start", "session_shutdown"]);
const apiMutationMethods = new Set([
  "appendEntry",
  "registerProvider",
  "registerTool",
  "sendMessage",
  "sendUserMessage",
  "setActiveTools",
  "setLabel",
  "setModel",
  "setSessionName",
  "setThinkingLevel",
  "unregisterProvider",
]);
const contextMutationMethods = new Set([
  "abort",
  "compact",
  "fork",
  "navigateTree",
  "newSession",
  "reload",
  "sendMessage",
  "sendUserMessage",
  "shutdown",
  "switchSession",
]);

type Notification = { message: string; level?: string };
type CallRecord = { target: "api" | "context"; method: string };
type EvidenceRecorder = {
  calls: CallRecord[];
  eventReturns: Array<{ event: string; returnedValue: boolean }>;
};
type CommandContext = {
  cwd: string;
  hasUI: boolean;
  notifications: Notification[];
  statuses: Array<{ id: string; value: string | undefined }>;
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    setStatus(id: string, value: string | undefined): void;
  };
};
type Handler = (args: string, context: CommandContext) => Promise<void>;
type EventHandler = (_event: unknown, context: CommandContext) => void | Promise<void>;
type Candidate = { id: string; name: string };
type HarnessOptions = {
  candidates?: Candidate[];
  env?: Record<string, string | undefined>;
  fetchImplementation?: typeof fetch;
  localGraph?: unknown;
  status?: unknown;
  selection?: string;
};

function context(recorder: EvidenceRecorder, selection?: string): CommandContext {
  const notifications: Notification[] = [];
  const statuses: Array<{ id: string; value: string | undefined }> = [];
  const base: CommandContext = {
    cwd: "/repo",
    hasUI: true,
    notifications,
    statuses,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      async select() {
        return selection;
      },
      setStatus(id, value) {
        statuses.push({ id, value });
      },
    },
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property !== "string" || Reflect.has(target, property))
        return Reflect.get(target, property, receiver);
      recorder.calls.push({ target: "context", method: property });
      if (property === "getSystemPrompt") return () => "structural audit sentinel";
      if (property === "getSystemPromptOptions") return () => ({});
      return async () => undefined;
    },
  });
}

function candidateResult(candidates: Candidate[]) {
  if (candidates.length === 0) return { match: "none", projects: candidates };
  if (candidates.length === 1) return { match: "unique", projects: candidates };
  return { match: "ambiguous", projects: candidates };
}

function harness(options: HarnessOptions = {}) {
  const candidates = options.candidates ?? [];
  const handlers = new Map<string, Handler>();
  const events = new Map<string, EventHandler>();
  const registrations: Array<{ name: string; description: string }> = [];
  const recorder: EvidenceRecorder = { calls: [], eventReturns: [] };
  const extension = createContextExtension({
    env: options.env ?? {},
    fetchImplementation: options.fetchImplementation ?? fetch,
    root: async () => "/repo",
    remote: async () => "git@github.com:Acme/Payments.git",
    layout: async () => ({}) as never,
    localGraph: async () => options.localGraph as never,
    manifest: async () => manifest,
    status: async () =>
      (options.status ?? {
        state: "NO_LOCAL_GRAPH",
        offline: true,
        localCommitSha: "a".repeat(40),
        localGraphVersion: null,
        localGraphCommitSha: null,
        remoteCommitSha: null,
        remoteGraphVersion: null,
      }) as never,
    sync: async () => manifest,
    connect: async (input: { projectId?: string }) => ({
      ...manifest,
      projectId: input.projectId ?? manifest.projectId,
    }),
    makeSyncClient: () => ({ resolveCandidates: async () => candidateResult(candidates) }) as never,
  });
  const apiTarget = {
    registerCommand(name: string, value: { description: string; handler: Handler }) {
      registrations.push({ name, description: value.description });
      handlers.set(name, value.handler);
    },
    on(event: string, handler: EventHandler) {
      events.set(event, handler);
    },
  };
  const api = new Proxy(apiTarget, {
    get(target, property, receiver) {
      if (typeof property !== "string" || Reflect.has(target, property))
        return Reflect.get(target, property, receiver);
      recorder.calls.push({ target: "api", method: property });
      return async () => undefined;
    },
  });
  extension(api as never);
  const handler = handlers.get(PI_COMMAND.name);
  if (!handler) throw new Error("AUDIT_COMMAND_NOT_REGISTERED");
  return { handler, events, registrations, recorder };
}

function mutationSummary(app: ReturnType<typeof harness>) {
  const eventRegistrations = [...app.events.keys()].filter((event) => !allowedEvents.has(event));
  const apiCalls = app.recorder.calls
    .filter((call) => call.target === "api")
    .map((call) => call.method);
  const contextCalls = app.recorder.calls
    .filter((call) => call.target === "context")
    .map((call) => call.method);
  const apiMutations = apiCalls.filter((method) => apiMutationMethods.has(method));
  const contextMutations = contextCalls.filter((method) => contextMutationMethods.has(method));
  const unknownApiCalls = apiCalls.filter((method) => !apiMutationMethods.has(method));
  const unknownContextCalls = contextCalls.filter(
    (method) =>
      !contextMutationMethods.has(method) &&
      method !== "getSystemPrompt" &&
      method !== "getSystemPromptOptions",
  );
  const nonVoidEventReturns = app.recorder.eventReturns.filter((item) => item.returnedValue);
  const violations = [
    ...eventRegistrations.map((event) => `event:${event}`),
    ...apiMutations.map((method) => `api:${method}`),
    ...contextMutations.map((method) => `context:${method}`),
    ...unknownApiCalls.map((method) => `unknown-api:${method}`),
    ...unknownContextCalls.map((method) => `unknown-context:${method}`),
    ...nonVoidEventReturns.map((item) => `event-return:${item.event}`),
  ];
  if (violations.length > 0) throw new Error(`PI_CONTEXT_MUTATION:${violations.join(",")}`);
  return {
    registeredLlmTools: apiCalls.filter((method) => method === "registerTool").length,
    promptMutationRegistrations: eventRegistrations.filter((event) =>
      ["before_agent_start", "before_provider_request", "context"].includes(event),
    ).length,
    modelVisibleMessageCalls: [...apiCalls, ...contextCalls].filter((method) =>
      ["sendMessage", "sendUserMessage"].includes(method),
    ).length,
    hiddenContextEntryCalls: apiCalls.filter((method) => method === "appendEntry").length,
    providerMutationCalls: apiCalls.filter((method) =>
      ["registerProvider", "unregisterProvider"].includes(method),
    ).length,
    modelMutationCalls: apiCalls.filter((method) => method === "setModel").length,
    activeToolMutationCalls: apiCalls.filter((method) => method === "setActiveTools").length,
    thinkingMutationCalls: apiCalls.filter((method) => method === "setThinkingLevel").length,
    agentMutationCalls: [...apiCalls, ...contextCalls].filter((method) =>
      ["setActiveTools", "setThinkingLevel", "abort", "compact", "shutdown", "reload"].includes(
        method,
      ),
    ).length,
    sessionMutationCalls: [...apiCalls, ...contextCalls].filter((method) =>
      ["appendEntry", "setLabel", "setSessionName", "newSession", "fork", "switchSession"].includes(
        method,
      ),
    ).length,
    unexpectedMutationCalls: violations.length,
  };
}

async function executeLifecycle(
  app: ReturnType<typeof harness>,
  ctx: CommandContext,
  command?: () => Promise<void>,
) {
  for (const event of ["session_start", "session_shutdown"] as const) {
    const handler = app.events.get(event);
    if (!handler) throw new Error(`AUDIT_${event.toUpperCase()}_NOT_REGISTERED`);
    if (event === "session_shutdown" && command) await command();
    const result = await handler({}, ctx);
    app.recorder.eventReturns.push({ event, returnedValue: result !== undefined });
  }
}

function measuredNotification(name: string, notification: Notification) {
  const bytes = encoder.encode(notification.message);
  let validUtf8 = true;
  try {
    fatalDecoder.decode(bytes);
  } catch {
    validUtf8 = false;
  }
  return {
    name,
    level: notification.level ?? "info",
    formattedNotificationPayloadBytes: bytes.byteLength,
    containsTruncationMarker: notification.message.endsWith("\n[output truncated]"),
    containsCompleteCredential: notification.message.includes(token),
    validUtf8,
    sha256: sha256(notification.message),
  };
}

function rpcFetch(
  mode: "success" | "unauthorized" | "success-with-secret",
  wire: Array<{ request: string; response: string }>,
): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const request = String(init?.body);
    const body = JSON.parse(request) as { id?: number; method: string; params?: unknown };
    if (body.method === "notifications/initialized") {
      wire.push({ request, response: "" });
      return new Response(null, { status: 202 });
    }
    const params = body.params as { name?: string } | undefined;
    const successfulValue =
      params?.name === "query_graph"
        ? {
            projects: [
              {
                projectId: "project-one",
                graph: {
                  version: 7,
                  provenance: {
                    projectId: "project-one",
                    source: "GRAPH",
                    path: null,
                    section: null,
                    version: "7",
                    commit: "a".repeat(40),
                    checksum: "b".repeat(64),
                  },
                },
                result: {
                  operation: "search",
                  nodes: [
                    {
                      id: "RetryPayment",
                      label: "RetryPayment",
                      sourceFile: "src/payments/retry.ts",
                      sourceLocation: "L42",
                    },
                  ],
                  truncated: false,
                },
              },
            ],
          }
        : {
            projects: [
              {
                projectId: "project-one",
                evidence: [
                  {
                    kind: "ARTIFACT",
                    title: "Retry policy",
                    excerpt:
                      mode === "success-with-secret"
                        ? `Successful result accidentally included ${token}`
                        : "Retries use bounded exponential backoff.",
                    relevanceReason: "matches payment retries",
                    tokenEstimate: 48,
                    freshness: "CURRENT",
                    provenance: {
                      projectId: "project-one",
                      source: "ARTIFACT",
                      path: "docs/retries.md",
                      section: "Retry policy",
                      version: "3",
                      commit: "a".repeat(40),
                      checksum: "b".repeat(64),
                    },
                  },
                ],
                tokenEstimate: 48,
                byteSize: 512,
                truncated: false,
                sourceErrors: [],
              },
            ],
            budget: { maxTokens: 1000, maxBytes: PI_OUTPUT_LIMITS.searchRequestBytes },
            tokenEstimate: 48,
            byteSize: 512,
            truncated: false,
          };
    const payload =
      body.method === "initialize"
        ? { jsonrpc: "2.0", id: body.id, result: initializeResult }
        : mode === "unauthorized"
          ? { jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "UNAUTHENTICATED" } }
          : {
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(successfulValue) }] },
            };
    const response = JSON.stringify(payload);
    wire.push({ request, response });
    return new Response(response, {
      status: mode === "unauthorized" && body.method === "tools/call" ? 401 : 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function runCommand(name: string, args: string, options: HarnessOptions) {
  const app = harness(options);
  const ctx = context(app.recorder, options.selection);
  let notification: Notification | undefined;
  await executeLifecycle(app, ctx, async () => {
    const before = ctx.notifications.length;
    const result = await app.handler(args, ctx);
    app.recorder.eventReturns.push({
      event: `command:${name}`,
      returnedValue: result !== undefined,
    });
    notification = ctx.notifications.slice(before).at(-1);
  });
  if (!notification) throw new Error(`AUDIT_NO_NOTIFICATION_${name}`);
  return { ...measuredNotification(name, notification), mutationEvidence: mutationSummary(app) };
}

async function measurePiTokenAuditPayload() {
  const activationRuns = [];
  for (const projectCount of [1, 10, 100]) {
    const candidates = Array.from({ length: projectCount }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
    }));
    const app = harness({
      candidates,
      env: { CONTEXT_HUB_API: manifest.apiOrigin, CONTEXT_HUB_SESSION: "human-session" },
    });
    const ctx = context(app.recorder);
    await executeLifecycle(app, ctx);
    const registrationJson = JSON.stringify(app.registrations);
    activationRuns.push({
      projectCount,
      commandCount: app.registrations.length,
      registrationBytes: byteLength(registrationJson),
      registrationSha256: sha256(registrationJson),
      eventNames: [...app.events.keys()].sort(),
      lifecycleHandlersExecuted: app.recorder.eventReturns.map((item) => item.event),
      formattedStatusPayloadBytes: ctx.statuses.reduce(
        (sum, item) => sum + byteLength(item.value ?? ""),
        0,
      ),
      formattedNotificationPayloadBytes: ctx.notifications.reduce(
        (sum, item) => sum + byteLength(item.message),
        0,
      ),
      mutationEvidence: mutationSummary(app),
    });
  }

  const wire: Array<{ request: string; response: string }> = [];
  const standardEnvironment = {
    CONTEXT_HUB_API: manifest.apiOrigin,
    CONTEXT_HUB_MCP_TOKEN: token,
    CONTEXT_HUB_SESSION: "human-session",
  };
  const commands = [
    await runCommand("connect-two-project", "connect project-2", {
      candidates: [
        { id: "project-1", name: "Project 1" },
        { id: "project-2", name: "Project 2" },
      ],
      env: standardEnvironment,
    }),
    await runCommand("status", "status", { env: standardEnvironment }),
    await runCommand("sync", "sync", { env: standardEnvironment }),
    await runCommand("search-single-project", "search payment retries", {
      env: standardEnvironment,
      fetchImplementation: rpcFetch("success", wire),
    }),
    await runCommand("graph-single-project", "graph RetryPayment", {
      env: standardEnvironment,
      fetchImplementation: rpcFetch("success", wire),
    }),
    await runCommand("snapshot", "snapshot", { env: standardEnvironment }),
    await runCommand("unauthorized-search", "search private roadmap", {
      env: standardEnvironment,
      fetchImplementation: rpcFetch("unauthorized", wire),
    }),
    await runCommand("offline-graph", "graph RetryPayment", {
      env: standardEnvironment,
      fetchImplementation: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
      localGraph: {
        manifest,
        metadata: {},
        bytes: encoder.encode(
          JSON.stringify({
            nodes: [
              {
                id: "RetryPayment",
                label: "RetryPayment",
                source_file: "src/payments/retry.ts",
                source_location: "L42",
              },
            ],
            links: [{ source: "RetryPayment", target: "Gateway", relation: "calls" }],
          }),
        ),
      },
    }),
    await runCommand("usage-error", "unknown", { env: standardEnvironment }),
  ];
  const boundaryEvidence = [
    await runCommand("utf8-boundary", "status", {
      status: { payload: "界".repeat(PI_OUTPUT_LIMITS.notificationBytes) },
    }),
    await runCommand("successful-status-secret-redaction", "status", {
      status: { ok: true, credential: token },
    }),
    await runCommand("successful-search-secret-redaction", "search payment retries", {
      env: standardEnvironment,
      fetchImplementation: rpcFetch("success-with-secret", wire),
    }),
  ];
  const allMutationEvidence = [
    ...activationRuns.map((run) => run.mutationEvidence),
    ...commands.map((command) => command.mutationEvidence),
    ...boundaryEvidence.map((entry) => entry.mutationEvidence),
  ];
  const total = (key: keyof (typeof allMutationEvidence)[number]) =>
    allMutationEvidence.reduce((sum, evidence) => sum + evidence[key], 0);
  const permanentModelContext = {
    evidenceKind: "structural-no-mutation" as const,
    registeredLlmTools: total("registeredLlmTools"),
    promptMutationRegistrations: total("promptMutationRegistrations"),
    modelVisibleMessageCalls: total("modelVisibleMessageCalls"),
    hiddenContextEntryCalls: total("hiddenContextEntryCalls"),
    providerMutationCalls: total("providerMutationCalls"),
    modelMutationCalls: total("modelMutationCalls"),
    activeToolMutationCalls: total("activeToolMutationCalls"),
    thinkingMutationCalls: total("thinkingMutationCalls"),
    agentMutationCalls: total("agentMutationCalls"),
    sessionMutationCalls: total("sessionMutationCalls"),
    unexpectedMutationCalls: total("unexpectedMutationCalls"),
  };
  if (Object.values(permanentModelContext).some((value) => typeof value === "number" && value > 0))
    throw new Error("PI_PERMANENT_CONTEXT_NOT_ZERO");

  return {
    piVersionAudited: "0.85.1",
    estimator:
      "ceil(UTF-8 bytes / 4); no nonzero estimate applies because structurally model-visible bytes are zero",
    measurementBoundary:
      "formatted notify/setStatus payloads before terminal rendering; excludes wrapping, ANSI, and RPC JSON framing",
    command: PI_COMMAND,
    limits: PI_OUTPUT_LIMITS,
    permanentModelContext: {
      ...permanentModelContext,
      modelVisibleBytes: permanentModelContext.modelVisibleMessageCalls === 0 ? 0 : null,
      estimatedTokens: permanentModelContext.modelVisibleMessageCalls === 0 ? 0 : null,
    },
    activationRuns,
    commands,
    boundaryEvidence,
    transport: wire.map((exchange, index) => ({
      index: index + 1,
      requestBytes: byteLength(exchange.request),
      responseBytes: byteLength(exchange.response),
      requestSha256: sha256(exchange.request),
      responseSha256: sha256(exchange.response),
    })),
  };
}

export type PiTokenAudit = Awaited<ReturnType<typeof measurePiTokenAudit>>;

export async function measurePiTokenAudit() {
  const audit = await measurePiTokenAuditPayload();
  return { audit, auditSha256: sha256(JSON.stringify(audit)) };
}
