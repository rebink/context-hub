import assert from "node:assert/strict";
import test from "node:test";
import { handleActivityRoute } from "../src/activity.js";

const rows = [
  {
    id: "git:event-2",
    actor_kind: "HUMAN",
    actor_id: "admin",
    action: "GIT_SYNCED",
    target_type: "REPOSITORY",
    target_id: "repository-1",
    outcome: "SUCCEEDED",
    metadata_json: "{}",
    occurred_at: "2026-09-14T11:00:00.000Z",
  },
  {
    id: "machine:event-1",
    actor_kind: "MACHINE",
    actor_id: "runner-1",
    action: "GRAPH_FAILED",
    target_type: "GRAPH_VERSION",
    target_id: "2",
    outcome: "FAILED",
    metadata_json: '{"attempt":1}',
    occurred_at: "2026-09-14T10:00:00.000Z",
  },
] as const;

class ActivityDb {
  lastListSql = "";
  lastListArgs: unknown[] = [];

  prepare(sql: string) {
    const db = this;
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        args = values;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM projects p JOIN project_members")) {
          return (
            args[0] === "project-1" && ["admin", "editor", "viewer"].includes(String(args[1]))
              ? { status: "ARCHIVED" }
              : null
          ) as T | null;
        }
        if (sql.includes("FROM project_audit_events WHERE project_id=? AND id=?")) {
          return (
            args[0] === "project-1" ? (rows.find((row) => row.id === args[1]) ?? null) : null
          ) as T | null;
        }
        return null;
      },
      async all<T>() {
        db.lastListSql = sql;
        db.lastListArgs = args;
        const limit = Number(args.at(-1));
        return { results: rows.slice(0, limit) as T[] };
      },
    };
  }
}

const env = (db: ActivityDb) => ({
  DB: db as unknown as D1Database,
  WEB_ORIGIN: "https://web.test",
});
const request = (path: string, method = "GET") =>
  new Request(`https://api.test${path}`, { method, headers: { origin: "https://web.test" } });

test("activity list is role-neutral, bounded, stable, and credentialed-CORS enabled", async () => {
  for (const id of ["admin", "editor", "viewer"]) {
    const db = new ActivityDb();
    const response = await handleActivityRoute(
      request("/projects/project-1/activity?limit=1&from=2026-09-01&to=2026-09-15"),
      env(db),
      { id },
      "project-1",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://web.test");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    const body = (await response.json()) as {
      events: unknown[];
      nextCursor: string;
      projectStatus: string;
    };
    assert.equal(body.events.length, 1);
    assert.equal(body.projectStatus, "ARCHIVED");
    assert.ok(body.nextCursor);
    assert.match(db.lastListSql, /project_id=\?/);
    assert.match(db.lastListSql, /ORDER BY occurred_at DESC,id DESC LIMIT \?/);
    assert.equal(db.lastListArgs.at(-1), 2);
  }

  const db = new ActivityDb();
  const first = await handleActivityRoute(
    request("/projects/project-1/activity?limit=1&action=GIT_SYNCED"),
    env(db),
    { id: "viewer" },
    "project-1",
  );
  const cursor = ((await first.json()) as { nextCursor: string }).nextCursor;
  const second = await handleActivityRoute(
    request(`/projects/project-1/activity?limit=1&cursor=${encodeURIComponent(cursor)}`),
    env(db),
    { id: "viewer" },
    "project-1",
  );
  assert.equal(second.status, 200);
  assert.match(db.lastListSql, /occurred_at<\?/);
  assert.ok(db.lastListArgs.includes("GIT_SYNCED"));
});

test("activity reads do not leak to outsiders or across projects", async () => {
  const db = new ActivityDb();
  const outsider = await handleActivityRoute(
    request("/projects/project-1/activity"),
    env(db),
    { id: "outsider" },
    "project-1",
  );
  assert.equal(outsider.status, 404);
  assert.deepEqual(await outsider.json(), { error: "NOT_FOUND" });

  const crossed = await handleActivityRoute(
    request("/projects/project-1/activity/machine:event-1"),
    env(db),
    { id: "viewer" },
    "project-2",
    "machine:event-1",
  );
  assert.equal(crossed.status, 404);
});

test("activity detail preserves exact provenance and rejects unsupported methods", async () => {
  const db = new ActivityDb();
  const detail = await handleActivityRoute(
    request("/projects/project-1/activity/machine:event-1"),
    env(db),
    { id: "viewer" },
    "project-1",
    "machine:event-1",
  );
  assert.equal(detail.status, 200);
  const body = (await detail.json()) as {
    event: { actor: unknown; target: unknown; outcome: string; metadata: unknown };
  };
  assert.deepEqual(body.event.actor, { kind: "MACHINE", id: "runner-1" });
  assert.deepEqual(body.event.target, { type: "GRAPH_VERSION", id: "2" });
  assert.equal(body.event.outcome, "FAILED");
  assert.deepEqual(body.event.metadata, { attempt: 1 });

  const method = await handleActivityRoute(
    request("/projects/project-1/activity", "POST"),
    env(db),
    { id: "viewer" },
    "project-1",
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET");
});
