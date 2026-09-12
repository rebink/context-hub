import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MCP_PROTOCOL_VERSION,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  type McpDispatch,
  WorkerMcpTransport,
} from "../src/mcp-transport.js";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://api.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const allow: McpDispatch = async () => ({ ok: true });

describe("Worker McpTransport contract", () => {
  it("negotiates POST initialize and rejects unsupported server-notification GET", async () => {
    const transport = new WorkerMcpTransport();
    const initialized = await transport.handle(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
      allow,
    );
    assert.equal(initialized.status, 200);
    assert.deepEqual((await initialized.json()) as object, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "context-hub", version: "1.0.0" },
      },
    });

    let negotiated = false;
    const get = await transport.handle(
      new Request("https://api.example/mcp", { headers: { accept: "text/event-stream" } }),
      async (input) => {
        negotiated = input.kind === "negotiate";
        return { ok: true };
      },
    );
    assert.equal(negotiated, true);
    assert.equal(get.status, 405);
    assert.equal(
      ((await get.json()) as { error: { message: string } }).error.message,
      "SERVER_NOTIFICATIONS_UNSUPPORTED",
    );
  });

  it("requires exactly one project selector in every stable tool schema", () => {
    for (const tool of MCP_TOOLS) {
      const schema = tool.inputSchema as {
        oneOf: Array<{ required: string[] }>;
      };
      assert.deepEqual(
        schema.oneOf.map((entry) => entry.required),
        [["repository"], ["projectId"], ["projectIds"]],
      );
      for (const selected of [
        [],
        ["repository"],
        ["projectId"],
        ["projectIds"],
        ["repository", "projectId"],
        ["repository", "projectId", "projectIds"],
      ]) {
        const matches = schema.oneOf.filter((entry) =>
          entry.required.every((key) => selected.includes(key)),
        ).length;
        assert.equal(matches === 1, selected.length === 1);
      }
    }
  });

  it("validates initialization, request IDs, method params, and notification semantics", async () => {
    const transport = new WorkerMcpTransport();
    for (const params of [
      {},
      { protocolVersion: "unsupported", capabilities: {}, clientInfo: { name: "c", version: "1" } },
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: null,
        clientInfo: { name: "c", version: "1" },
      },
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "", version: "1" },
      },
    ]) {
      const invalid = await transport.handle(
        request({ jsonrpc: "2.0", id: 7, method: "initialize", params }),
        allow,
      );
      assert.equal(invalid.status, 400);
      assert.equal(((await invalid.json()) as { error: { code: number } }).error.code, -32602);
    }

    const nullId = await transport.handle(
      request({ jsonrpc: "2.0", id: null, method: "ping" }),
      allow,
    );
    assert.equal(nullId.status, 400);
    assert.equal(((await nullId.json()) as { error: { code: number } }).error.code, -32700);

    let dispatches = 0;
    for (const [method, params] of [
      [
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "notification-client", version: "1.0.0" },
        },
      ],
      ["ping", {}],
      ["tools/list", {}],
      ["tools/call", { name: "project_info", arguments: { projectId: "project-one" } }],
    ] as const) {
      const notification = await transport.handle(
        request({ jsonrpc: "2.0", method, params }),
        async () => {
          dispatches += 1;
          return { ok: true };
        },
      );
      assert.equal(notification.status, 202);
      assert.equal(await notification.text(), "");
      assert.equal(notification.headers.has("content-type"), false);
    }
    assert.equal(dispatches, 4);

    const invalidNotification = await transport.handle(
      request({ jsonrpc: "2.0", method: "tools/call", params: {} }),
      async () => {
        dispatches += 1;
        return { ok: true };
      },
    );
    assert.equal(invalidNotification.status, 202);
    assert.equal(await invalidNotification.text(), "");
    assert.equal(dispatches, 4);

    const initialized = await transport.handle(
      request({ jsonrpc: "2.0", method: "notifications/initialized" }),
      async (input) => {
        assert.equal(input.kind, "initialized");
        dispatches += 1;
        return { ok: true };
      },
    );
    assert.equal(initialized.status, 202);
    assert.equal(await initialized.text(), "");
    assert.equal(initialized.headers.has("content-type"), false);
    assert.equal(dispatches, 5);

    for (const [method, params] of [
      ["ping", { unexpected: true }],
      ["tools/list", { cursor: "unsupported" }],
      ["tools/call", { arguments: {} }],
    ] as const) {
      const invalid = await transport.handle(
        request({ jsonrpc: "2.0", id: 8, method, params }),
        allow,
      );
      assert.equal(invalid.status, 400);
      assert.equal(((await invalid.json()) as { error: { code: number } }).error.code, -32602);
    }
  });

  it("lists and dispatches exactly six stable tools independent of project data", async () => {
    const transport = new WorkerMcpTransport();
    let stableToolJson: string | null = null;
    for (const projectCount of [1, 10, 100]) {
      const listed = await transport.handle(
        request({ jsonrpc: "2.0", id: `list-${projectCount}`, method: "tools/list" }),
        async () => ({ ok: true, value: { projectCount } }),
      );
      const body = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
      assert.deepEqual(
        body.result.tools.map((tool) => tool.name),
        MCP_TOOL_NAMES,
      );
      assert.equal(body.result.tools.length, 6);
      assert.equal(JSON.stringify(body).includes("project-one"), false);
      const toolJson = JSON.stringify(body.result.tools);
      stableToolJson ??= toolJson;
      assert.equal(toolJson, stableToolJson);
    }

    const dispatched: string[] = [];
    for (const name of MCP_TOOL_NAMES) {
      const response = await transport.handle(
        request({
          jsonrpc: "2.0",
          id: name,
          method: "tools/call",
          params: { name, arguments: { projectId: "project-one" } },
        }),
        async (input) => {
          if (input.kind === "call-tool") dispatched.push(input.name);
          return { ok: true, value: { projectId: "project-one" } };
        },
      );
      assert.equal(response.status, 200);
    }
    assert.deepEqual(dispatched, MCP_TOOL_NAMES);
  });

  it("maps malformed, oversized, unknown, unacceptable, and domain failures stably", async () => {
    const transport = new WorkerMcpTransport();
    const malformed = await transport.handle(
      new Request("https://api.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      allow,
    );
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: { code: number } }).error.code, -32700);

    const oversized = await transport.handle(
      request(
        { jsonrpc: "2.0", id: 1, method: "ping", padding: "x" },
        { "content-length": "20000" },
      ),
      allow,
    );
    assert.equal(oversized.status, 400);

    const unknown = await transport.handle(
      request({ jsonrpc: "2.0", id: 2, method: "resources/list" }),
      allow,
    );
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: { code: number } }).error.code, -32601);

    const unacceptable = await transport.handle(
      request({ jsonrpc: "2.0", id: 3, method: "ping" }, { accept: "text/plain" }),
      allow,
    );
    assert.equal(unacceptable.status, 406);

    const denied = await transport.handle(
      request({ jsonrpc: "2.0", id: 4, method: "ping" }),
      async () => ({ ok: false, code: "INVALID_CREDENTIAL", status: 401 }),
    );
    assert.equal(denied.status, 401);
    assert.deepEqual((await denied.json()) as object, {
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32001, message: "INVALID_CREDENTIAL" },
    });
  });

  it("fails closed when an encoded tool result exceeds the transport bound", async () => {
    const response = await new WorkerMcpTransport().handle(
      request({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "project_info", arguments: { projectId: "project-one" } },
      }),
      async () => ({ ok: true, value: { content: "x".repeat(140 * 1024) } }),
    );
    assert.equal(response.status, 500);
    assert.equal(
      ((await response.json()) as { error: { message: string } }).error.message,
      "RESPONSE_TOO_LARGE",
    );
  });
});
