/* biome-ignore-all lint/suspicious/noExplicitAny: The fake models Cloudflare bindings structurally. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleContextRoute, handleCrossProjectContextRoute } from "../src/context-route.js";
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
  activeProjects = new Set<string>();
  workspaceMembers = new Set<string>();
  domainReads = 0;
  raceAfterInitialAuthorization: "REMOVE" | "DEACTIVATE" | null = null;
  prepare(sql: string) {
    return new Statement(this, sql);
  }
  first(sql: string, args: any[]) {
    if (sql.includes("SELECT pm.role FROM project_members"))
      return (
        this.memberships.find((row) => row.project_id === args[0] && row.user_id === args[1]) ??
        null
      );
    if (sql.includes("COUNT(*) AS authorized_count")) {
      const userId = args[0] as string;
      const projectIds = args.slice(2) as string[];
      const authorizedCount = this.authorizedCount(userId, projectIds);
      const racedProject = projectIds.at(-1);
      if (racedProject && this.raceAfterInitialAuthorization === "REMOVE") {
        this.memberships = this.memberships.filter(
          (row) => !(row.user_id === userId && row.project_id === racedProject),
        );
      } else if (racedProject && this.raceAfterInitialAuthorization === "DEACTIVATE") {
        this.activeProjects.delete(racedProject);
      }
      this.raceAfterInitialAuthorization = null;
      return { authorized_count: authorizedCount };
    }
    if (sql.includes("SELECT 1 AS authorized")) {
      const userId = args[0] as string;
      const projectIds = args.slice(1, -1) as string[];
      return this.authorizedCount(userId, projectIds) === projectIds.length
        ? { authorized: 1 }
        : null;
    }
    if (sql.includes("FROM git_connections") || sql.includes("FROM graph_versions")) {
      this.domainReads += 1;
      return null;
    }
    throw new Error(`Unhandled SQL: ${sql}`);
  }
  all(sql: string) {
    if (sql.includes("FROM artifacts a JOIN artifact_versions")) {
      this.domainReads += 1;
      return [];
    }
    throw new Error(`Unhandled SQL: ${sql}`);
  }
  private authorizedCount(userId: string, projectIds: string[]) {
    return projectIds.filter(
      (projectId) =>
        this.activeProjects.has(projectId) &&
        this.workspaceMembers.has(`${userId}:${projectId}`) &&
        this.memberships.some((row) => row.project_id === projectId && row.user_id === userId),
    ).length;
  }
}

let storageReads = 0;
const storage: ObjectStorage = {
  async createOnly() {
    return "created";
  },
  async head() {
    storageReads += 1;
    return null;
  },
  async getBytes() {
    storageReads += 1;
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

function crossRequest(body: unknown, origin = "https://web.example") {
  return new Request("https://api.example/context/cross-project/search", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function crossCall(db: RouteD1, userId: string, body: unknown, origin?: string) {
  return handleCrossProjectContextRoute(
    crossRequest(body, origin),
    { DB: db as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
    storage,
    { id: userId },
  );
}

describe("context route authorization and validation", () => {
  it("authenticates before resolving single- or cross-project context", async () => {
    for (const unauthenticated of [
      request({ query: "refund retry", budget: { maxTokens: 100, maxBytes: 2_000 } }),
      crossRequest({
        projectIds: ["payments", "identity"],
        query: "refund retry",
        budget: { maxTokens: 100, maxBytes: 2_000 },
      }),
    ]) {
      const response = await createApp().fetch(unauthenticated, {
        WEB_ORIGIN: "https://web.example",
        DB: {} as D1Database,
        OBJECTS: {} as R2Bucket,
      } as Env);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
    }
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
      db.activeProjects.add("p");
      db.workspaceMembers.add(`${id}:p`);
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

  it("authorizes every explicit project before any domain read and does not leak a denied selector", async () => {
    const db = new RouteD1();
    for (const projectId of ["payments", "identity"]) {
      db.memberships.push({ project_id: projectId, user_id: "alice", role: "VIEWER" });
      db.activeProjects.add(projectId);
      db.workspaceMembers.add(`alice:${projectId}`);
    }
    const body = {
      projectIds: ["payments", "identity"],
      query: "refund identity",
      budget: { maxTokens: 500, maxBytes: 4_000, maxSources: 10 },
    };
    const allowed = await crossCall(db, "alice", body);
    assert.equal(allowed.status, 200);
    assert.ok(db.domainReads > 0);

    db.domainReads = 0;
    const denied = await crossCall(db, "alice", {
      ...body,
      projectIds: ["payments", "mobile"],
    });
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: "NOT_FOUND" });
    assert.equal(db.domainReads, 0);
  });

  it("fails human membership and project-active races before source metadata or R2 reads", async () => {
    for (const race of ["REMOVE", "DEACTIVATE"] as const) {
      const db = new RouteD1();
      for (const projectId of ["payments", "identity"]) {
        db.memberships.push({ project_id: projectId, user_id: "alice", role: "VIEWER" });
        db.activeProjects.add(projectId);
        db.workspaceMembers.add(`alice:${projectId}`);
      }
      db.raceAfterInitialAuthorization = race;
      storageReads = 0;
      const response = await crossCall(db, "alice", {
        projectIds: ["payments", "identity"],
        query: "refund identity",
        budget: { maxTokens: 500, maxBytes: 4_000 },
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "NOT_FOUND" });
      assert.equal(db.domainReads, 0);
      assert.equal(storageReads, 0);
    }
  });

  it("rejects a 512-byte twenty-project shell before Context Engine source reads", async () => {
    const db = new RouteD1();
    const projectIds = Array.from(
      { length: 20 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    for (const projectId of projectIds) {
      db.memberships.push({ project_id: projectId, user_id: "alice", role: "VIEWER" });
      db.activeProjects.add(projectId);
      db.workspaceMembers.add(`alice:${projectId}`);
    }
    storageReads = 0;
    const response = await crossCall(db, "alice", {
      projectIds,
      query: "refund boundary",
      budget: { maxTokens: 8_000, maxBytes: 512 },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "INVALID_INPUT" });
    assert.equal(db.domainReads, 0);
    assert.equal(storageReads, 0);
  });

  it("rejects cross-project selector bounds, duplicates, inactive/member races, and hostile CORS", async () => {
    const db = new RouteD1();
    db.memberships.push({ project_id: "payments", user_id: "alice", role: "VIEWER" });
    db.activeProjects.add("payments");
    db.workspaceMembers.add("alice:payments");
    const validBody = {
      projectIds: ["payments"],
      query: "refund identity",
      budget: { maxTokens: 500, maxBytes: 4_000 },
    };
    assert.equal((await crossCall(db, "alice", { ...validBody, projectIds: [] })).status, 400);
    assert.equal(
      (
        await crossCall(db, "alice", {
          ...validBody,
          projectIds: Array.from({ length: 21 }, (_, index) => `p-${index}`),
        })
      ).status,
      400,
    );
    assert.equal(
      (await crossCall(db, "alice", { ...validBody, projectIds: ["payments", "payments"] })).status,
      400,
    );
    db.activeProjects.delete("payments");
    assert.equal((await crossCall(db, "alice", validBody)).status, 404);
    assert.equal(db.domainReads, 0);
    assert.equal((await crossCall(db, "alice", validBody, "https://evil.example")).status, 403);
    assert.equal(db.domainReads, 0);
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
