import assert from "node:assert/strict";
import test from "node:test";
import { createContextExtension } from "../src/index.ts";

const token = `chmcp_00000000-0000-4000-8000-000000000000.${"a".repeat(43)}`;
const repository = {
  provider: "github",
  providerRepositoryId: "repo-1",
  owner: "acme",
  name: "payments",
  canonicalUrl: "github.com/acme/payments",
};
const initializeResult = {
  protocolVersion: "2025-03-26",
  capabilities: { tools: { listChanged: false } },
  serverInfo: { name: "context-hub", version: "1.0.0" },
};
const manifest = {
  formatVersion: 1 as const,
  apiOrigin: "https://api.example.test",
  projectId: "project-one",
  repository,
  graph: null,
};

type TestContext = {
  cwd: string;
  hasUI: boolean;
  notifications: Array<{ message: string; level?: string }>;
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    select(): Promise<string | undefined>;
    setStatus(id: string, value: string | undefined): void;
  };
};
type Handler = (args: string, context: TestContext) => Promise<void>;

type EventHandler = (_event: unknown, context: TestContext) => void | Promise<void>;
type FakeApi = {
  registerCommand(name: string, value: { handler: Handler }): void;
  on(event: string, handler: EventHandler): void;
  registerTool(): void;
  registerProvider(): void;
};

function context(options: string[] = []): TestContext {
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    cwd: "/repo",
    hasUI: true,
    notifications,
    ui: {
      notify(message: string, level?: "info" | "warning" | "error") {
        notifications.push({ message, level });
      },
      async select() {
        return options.shift();
      },
      setStatus(_id: string, _value: string | undefined) {},
    },
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const events = new Map<string, EventHandler>();
  let tools = 0;
  let providers = 0;
  const extension = createContextExtension({
    env: {},
    fetchImplementation: fetch,
    root: async () => "/repo",
    remote: async () => "git@github.com:Acme/Payments.git",
    layout: async () => ({}) as never,
    localGraph: async () => null,
    manifest: async () => manifest,
    status: async () => ({
      state: "NO_LOCAL_GRAPH",
      offline: true,
      localCommitSha: "a".repeat(40),
      localGraphVersion: null,
      localGraphCommitSha: null,
      remoteCommitSha: null,
      remoteGraphVersion: null,
    }),
    sync: async () => manifest,
    connect: async () => manifest,
    makeSyncClient: () =>
      ({ resolveCandidates: async () => ({ match: "none", projects: [] }) }) as never,
    ...overrides,
  });
  const api: FakeApi = {
    registerCommand(name, value) {
      handlers.set(name, value.handler);
    },
    on(event, handler) {
      events.set(event, handler);
    },
    registerTool() {
      tools += 1;
    },
    registerProvider() {
      providers += 1;
    },
  };
  extension(api as never);
  return { handler: handlers.get("context")!, handlers, events, tools, providers };
}

test("registers one native command, lifecycle hooks, and no model-facing additions", () => {
  const app = harness();
  assert.deepEqual([...app.handlers.keys()], ["context"]);
  assert.deepEqual([...app.events.keys()].sort(), ["session_shutdown", "session_start"]);
  assert.equal(app.tools, 0);
  assert.equal(app.providers, 0);
});

test("automatic repository resolution selects exactly one authorized project", async () => {
  const connected: string[] = [];
  const app = harness({
    env: {
      CONTEXT_HUB_API: "https://api.example.test",
      CONTEXT_HUB_SESSION: "human-secret",
    },
    makeSyncClient: () => ({
      resolveCandidates: async () => ({
        match: "unique",
        projects: [{ id: "project-one", name: "Payments" }],
      }),
    }),
    connect: async (options: { projectId?: string }) => {
      connected.push(options.projectId ?? "");
      return manifest;
    },
  });
  const ctx = context();
  await app.events.get("session_start")!({}, ctx);
  assert.deepEqual(connected, ["project-one"]);
  assert.match(ctx.notifications.at(-1)!.message, /Connected/);
});

test("automatic resolution reports zero and ambiguity without silently selecting", async () => {
  for (const candidate of [
    { match: "none", projects: [] },
    {
      match: "ambiguous",
      projects: [
        { id: "one", name: "One" },
        { id: "two", name: "Two" },
      ],
    },
  ]) {
    let connects = 0;
    const app = harness({
      env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_SESSION: "session" },
      makeSyncClient: () => ({ resolveCandidates: async () => candidate }),
      connect: async () => {
        connects += 1;
        return manifest;
      },
    });
    const ctx = context();
    await app.events.get("session_start")!({}, ctx);
    assert.equal(connects, 0);
    assert.match(
      ctx.notifications.at(-1)!.message,
      candidate.match === "none" ? /not connected/ : /Multiple/,
    );
  }
});

test("connect requires explicit ambiguity choice and supports cached selection switching", async () => {
  const selected: string[] = [];
  const app = harness({
    env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_SESSION: "session" },
    makeSyncClient: () => ({
      resolveCandidates: async () => ({
        match: "ambiguous",
        projects: [
          { id: "one", name: "One" },
          { id: "two", name: "Two" },
        ],
      }),
    }),
    connect: async (options: { projectId?: string }) => {
      selected.push(options.projectId ?? "");
      return { ...manifest, projectId: options.projectId ?? "" };
    },
  });
  const interactive = context(["Two (two)"]);
  await app.handler("connect", interactive);
  await app.handler("connect one", context());
  assert.deepEqual(selected, ["two", "one"]);
});

test("status remains local and sync delegates to context-cli", async () => {
  let syncCalls = 0;
  const app = harness({
    env: {
      CONTEXT_HUB_API: "https://api.example.test",
      CONTEXT_HUB_SESSION: "session",
    },
    sync: async () => {
      syncCalls += 1;
      return manifest;
    },
  });
  const status = context();
  await app.handler("status", status);
  assert.match(status.notifications[0]!.message, /NO_LOCAL_GRAPH/);
  const synced = context();
  await app.handler("sync", synced);
  assert.equal(syncCalls, 1);
  assert.match(synced.notifications[0]!.message, /reporting NOT_CONFIGURED/);
});

for (const reporting of ["REPORTED", "FAILED"] as const) {
  test(`sync success remains successful when reporting is ${reporting}`, async () => {
    const app = harness({
      env: {
        CONTEXT_HUB_API: "https://api.example.test",
        CONTEXT_HUB_SESSION: "session",
        CONTEXT_HUB_MCP_TOKEN: token,
      },
      sync: async () => manifest,
      status: async () => {
        if (reporting === "FAILED") throw new Error("REPORT_FAILED");
        return {
          state: "CURRENT" as const,
          offline: false,
          localCommitSha: "a".repeat(40),
          localGraphVersion: 1,
          localGraphCommitSha: "a".repeat(40),
          remoteCommitSha: "a".repeat(40),
          remoteGraphVersion: 1,
          reporting: "REPORTED" as const,
        };
      },
    });
    const output = context();
    await app.handler("sync", output);
    assert.equal(output.notifications[0]!.level, "info");
    assert.match(output.notifications[0]!.message, new RegExp(`reporting ${reporting}`));
  });
}

test("MCP search uses initialize lifecycle, exact origin, authorization header, and bounded args", async () => {
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), init: init!, body });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const id = body.id;
    const result =
      body.method === "tools/call"
        ? { content: [{ type: "text", text: JSON.stringify({ projects: [], truncated: false }) }] }
        : initializeResult;
    return Response.json({ jsonrpc: "2.0", id, result });
  };
  const app = harness({
    env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_MCP_TOKEN: token },
    fetchImplementation: fakeFetch,
    localGraph: async () => ({ manifest, metadata: {}, bytes: new Uint8Array() }),
  });
  await app.handler("search refunds", context());
  assert.deepEqual(
    requests.map((request) => request.body.method),
    ["initialize", "notifications/initialized", "tools/call"],
  );
  for (const request of requests) {
    assert.equal(request.url, "https://api.example.test/mcp");
    assert.equal(new Headers(request.init.headers).get("authorization"), `Bearer ${token}`);
    assert.match(new Headers(request.init.headers).get("x-context-nonce")!, /^[0-9a-f-]{36}$/);
  }
  const params = requests[2]!.body.params as { arguments: Record<string, unknown> };
  assert.equal(params.arguments.maxBytes, 12 * 1024);
  assert.equal(params.arguments.projectId, "project-one");
});

for (const command of [
  "search refunds",
  "graph RefundService",
  "graph RefundService offline",
] as const) {
  test(`changed remote blocks ${command} before MCP or cached graph access`, async () => {
    let fetchCalls = 0;
    let graphReads = 0;
    const offline = command.endsWith(" offline");
    const app = harness({
      env: offline
        ? {}
        : { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_MCP_TOKEN: token },
      remote: async () => "git@github.com:acme/identity.git",
      fetchImplementation: async () => {
        fetchCalls += 1;
        return new Response();
      },
      localGraph: async () => {
        graphReads += 1;
        return null;
      },
    });
    const ctx = context();
    await app.handler(command.replace(" offline", ""), ctx);
    assert.equal(ctx.notifications[0]?.message, "COMMIT_MISMATCH");
    assert.equal(fetchCalls, 0);
    assert.equal(graphReads, 0);
  });
}

test("rejects malformed initialize results before notification or tool calls", async () => {
  for (const result of [
    { ...initializeResult, protocolVersion: "2024-11-05" },
    { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: initializeResult.serverInfo },
  ]) {
    const methods: unknown[] = [];
    const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      methods.push(body.method);
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };
    const app = harness({
      env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_MCP_TOKEN: token },
      fetchImplementation: fakeFetch,
    });
    const ctx = context();
    await app.handler("search refunds", ctx);
    assert.deepEqual(methods, ["initialize"]);
    assert.equal(ctx.notifications[0]?.message, "MCP_PROTOCOL_ERROR");
  }
});

test("cancels a chunked MCP response immediately above 128 KiB", async () => {
  let cancelled = false;
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: body.id, result: initializeResult });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(70 * 1024));
        controller.enqueue(new Uint8Array(70 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, { headers: { "content-type": "application/json" } });
  };
  const app = harness({
    env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_MCP_TOKEN: token },
    fetchImplementation: fakeFetch,
  });
  const ctx = context();
  await app.handler("search refunds", ctx);
  assert.equal(ctx.notifications[0]?.message, "RESPONSE_TOO_LARGE");
  assert.equal(cancelled, true);
});

test("authorization errors and secrets are not exposed", async () => {
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: body.id, result: initializeResult });
    return Response.json(
      { jsonrpc: "2.0", id: body.id, error: { code: -32001, message: `UNAUTHENTICATED ${token}` } },
      { status: 401 },
    );
  };
  const app = harness({
    env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_MCP_TOKEN: token },
    fetchImplementation: fakeFetch,
    localGraph: async () => ({ manifest, metadata: {}, bytes: new Uint8Array() }),
  });
  const ctx = context();
  await app.handler("search refunds", ctx);
  assert.equal(ctx.notifications[0]!.message, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(ctx.notifications), /chmcp_|a{43}/);
});

test("reports MCP authorization failure without project detail", async () => {
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: body.id, result: initializeResult });
    return Response.json(
      { jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "UNAUTHENTICATED" } },
      { status: 401 },
    );
  };
  const app = harness({
    env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_MCP_TOKEN: token },
    fetchImplementation: fakeFetch,
  });
  const ctx = context();
  await app.handler("search refunds", ctx);
  assert.equal(ctx.notifications[0]?.message, "Context Hub authorization failed.");
});

test("graph falls back to the verified local cache when MCP is offline", async () => {
  const graph = {
    nodes: [
      { id: "refund", label: "RefundService", source_file: "src/refund.ts", source_location: "L1" },
    ],
    links: [{ source: "refund", target: "payment", relation: "calls" }],
  };
  const app = harness({
    env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_MCP_TOKEN: token },
    fetchImplementation: async () => {
      throw new Error("network");
    },
    localGraph: async () => ({
      manifest,
      metadata: {},
      bytes: new TextEncoder().encode(JSON.stringify(graph)),
    }),
  });
  const ctx = context();
  await app.handler("graph RefundService", ctx);
  assert.match(ctx.notifications[0]!.message, /"offline":true/);
  assert.match(ctx.notifications[0]!.message, /RefundService/);
});

test("cached graph works without network configuration or credentials", async () => {
  const graph = { nodes: [{ id: "refund", label: "RefundService" }], links: [] };
  const app = harness({
    env: {},
    localGraph: async () => ({
      manifest,
      metadata: {},
      bytes: new TextEncoder().encode(JSON.stringify(graph)),
    }),
  });
  const ctx = context();
  await app.handler("graph RefundService", ctx);
  assert.match(ctx.notifications[0]?.message ?? "", /"offline":true/);
});

test("rejects unsafe API origins before sending a credential", async () => {
  let calls = 0;
  const app = harness({
    env: { CONTEXT_HUB_API: "https://api.example.test/path", CONTEXT_HUB_MCP_TOKEN: token },
    fetchImplementation: async () => {
      calls += 1;
      return new Response();
    },
    localGraph: async () => ({ manifest, metadata: {}, bytes: new Uint8Array() }),
  });
  const ctx = context();
  await app.handler("search refunds", ctx);
  assert.equal(calls, 0);
  assert.equal(ctx.notifications[0]!.message, "INVALID_API_ORIGIN");
});

test("bounds command output on a valid UTF-8 boundary and redacts successful status", async () => {
  const app = harness({
    status: async () => ({ payload: "界".repeat(20_000) }),
  });
  const status = context();
  await app.handler("status", status);
  const message = status.notifications[0]?.message ?? "";
  const bytes = new TextEncoder().encode(message);
  assert.ok(bytes.byteLength <= 16 * 1024);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert.match(message, /\n\[output truncated\]$/);

  const secretStatus = harness({ status: async () => ({ ok: true, credential: token }) });
  const redacted = context();
  await secretStatus.handler("status", redacted);
  assert.match(redacted.notifications[0]?.message ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(redacted.notifications[0]?.message ?? "", /chmcp_|a{43}/);

  const snapshot = context();
  await app.handler("snapshot", snapshot);
  assert.match(snapshot.notifications[0]?.message ?? "", /available through the web\/API/);
  assert.match(snapshot.notifications[0]?.message ?? "", /defined mutation-auth contract/);
  assert.match(snapshot.notifications[0]?.message ?? "", /no snapshot was created/);
});

test("redacts a valid credential from otherwise successful MCP output", async () => {
  const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: body.id, result: initializeResult });
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ projects: [{ projectId: "project-one", content: token }] }),
          },
        ],
      },
    });
  };
  const app = harness({
    env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_MCP_TOKEN: token },
    fetchImplementation: fakeFetch,
  });
  const ctx = context();
  await app.handler("search refunds", ctx);
  assert.match(ctx.notifications[0]?.message ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(ctx.notifications[0]?.message ?? "", /chmcp_|a{43}/);
});

test("shutdown fences deferred automatic selection before cache mutation or notification", async () => {
  let releaseResolution: ((value: unknown) => void) | undefined;
  const resolution = new Promise((resolve) => {
    releaseResolution = resolve;
  });
  let cacheMutations = 0;
  const app = harness({
    env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_SESSION: "session" },
    makeSyncClient: () => ({ resolveCandidates: () => resolution }),
    connect: async () => {
      cacheMutations += 1;
      return manifest;
    },
  });
  const ctx = context();
  const startup = app.events.get("session_start")!({}, ctx);
  app.events.get("session_shutdown")!({}, ctx);
  releaseResolution?.({
    match: "unique",
    projects: [{ id: "project-one", name: "Payments" }],
  });
  await startup;
  assert.equal(cacheMutations, 0);
  assert.deepEqual(ctx.notifications, []);
});

test("shutdown aborts a deferred automatic connect before it can mutate cache", async () => {
  let connectStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    connectStarted = resolve;
  });
  let cacheMutations = 0;
  const app = harness({
    env: { CONTEXT_HUB_API: "https://api.example.test", CONTEXT_HUB_SESSION: "session" },
    makeSyncClient: () => ({
      resolveCandidates: async () => ({
        match: "unique",
        projects: [{ id: "project-one", name: "Payments" }],
      }),
    }),
    connect: async (options: { signal?: AbortSignal }) => {
      connectStarted?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      options.signal?.throwIfAborted();
      cacheMutations += 1;
      return manifest;
    },
  });
  const ctx = context();
  const startup = app.events.get("session_start")!({}, ctx);
  await started;
  app.events.get("session_shutdown")!({}, ctx);
  await startup;
  assert.equal(cacheMutations, 0);
  assert.deepEqual(ctx.notifications, []);
});

test("shutdown clears extension status", () => {
  const values: Array<string | undefined> = [];
  const app = harness();
  const ctx = context();
  ctx.ui.setStatus = (_id, value) => values.push(value);
  app.events.get("session_start")!({}, ctx);
  app.events.get("session_shutdown")!({}, ctx);
  assert.deepEqual(values, ["context: local", undefined]);
});
