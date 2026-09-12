/* biome-ignore-all lint/suspicious/noExplicitAny: The fake models Cloudflare bindings structurally. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleContextRoute } from "../src/context-route.js";
import { createApp, type Env } from "../src/index.js";
import type { ObjectStorage } from "../src/object-storage.js";

type Row = Record<string, any>;

class Statement {
  args: any[] = [];
  constructor(
    private readonly db: RouteD1,
    private readonly sql: string,
  ) {}
  bind(...args: any[]) {
    this.args = args;
    return this;
  }
  async first<T>() {
    return this.db.first(this.sql, this.args) as T | null;
  }
  async all<T>() {
    return { success: true, results: this.db.all(this.sql), meta: {} } as unknown as D1Result<T>;
  }
}

class RouteD1 {
  memberships: Row[] = [];
  prepare(sql: string) {
    return new Statement(this, sql);
  }
  first(sql: string, args: any[]) {
    if (sql.includes("SELECT pm.role FROM project_members"))
      return (
        this.memberships.find((row) => row.project_id === args[0] && row.user_id === args[1]) ??
        null
      );
    if (sql.includes("FROM git_connections") || sql.includes("FROM graph_versions")) return null;
    throw new Error(`Unhandled SQL: ${sql}`);
  }
  all(sql: string) {
    if (sql.includes("FROM artifacts a JOIN artifact_versions")) return [];
    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

const storage: ObjectStorage = {
  async createOnly() {
    return "created";
  },
  async head() {
    return null;
  },
  async getBytes() {
    return null;
  },
  async compensationDelete() {},
};

function request(body: unknown, origin = "https://web.example") {
  return new Request("https://api.example/projects/p/context/search", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function call(db: RouteD1, userId: string, body: unknown, origin?: string) {
  return handleContextRoute(
    request(body, origin),
    { DB: db as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
    storage,
    { id: userId },
    "p",
  );
}

describe("context route authorization and validation", () => {
  it("authenticates before resolving a context project", async () => {
    const response = await createApp().fetch(
      request({ query: "refund retry", budget: { maxTokens: 100, maxBytes: 2_000 } }),
      { WEB_ORIGIN: "https://web.example", DB: {} as D1Database, OBJECTS: {} as R2Bucket } as Env,
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
  });

  it("returns the same nonleaking denial for outsiders and workspace-only users", async () => {
    const db = new RouteD1();
    for (const user of ["outsider", "workspace-only"]) {
      const response = await call(db, user, {
        query: "refund retry",
        budget: { maxTokens: 100, maxBytes: 2_000 },
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "NOT_FOUND" });
    }
  });

  it("allows every direct project role and validates explicit strict budgets", async () => {
    const db = new RouteD1();
    for (const role of ["ADMIN", "EDITOR", "VIEWER"]) {
      const id = role.toLowerCase();
      db.memberships.push({ project_id: "p", user_id: id, role });
      const response = await call(db, id, {
        query: "refund retry",
        budget: { maxTokens: 100, maxBytes: 2_000 },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const result = (await response.json()) as Row;
      assert.equal(result.projectId, "p");
      assert.ok(result.byteSize <= 2_000);
    }
    const invalid = await call(db, "admin", { query: "refund retry", budget: { maxTokens: 100 } });
    assert.equal(invalid.status, 400);
  });

  it("rejects hostile origins and oversized request declarations", async () => {
    const db = new RouteD1();
    db.memberships.push({ project_id: "p", user_id: "u", role: "VIEWER" });
    assert.equal(
      (
        await call(
          db,
          "u",
          { query: "refund retry", budget: { maxTokens: 100, maxBytes: 2_000 } },
          "https://evil.example",
        )
      ).status,
      403,
    );
    const oversized = new Request("https://api.example/projects/p/context/search", {
      method: "POST",
      headers: {
        origin: "https://web.example",
        "content-type": "application/json",
        "content-length": "5000",
      },
      body: "{}",
    });
    const response = await handleContextRoute(
      oversized,
      { DB: db as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
      storage,
      { id: "u" },
      "p",
    );
    assert.equal(response.status, 400);
  });
});
