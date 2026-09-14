/* biome-ignore-all lint/suspicious/noExplicitAny: This fake models Cloudflare D1 structurally. */
import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/index.js";
import { handleMetricsRoute, sampledRate } from "../src/metrics.js";

class Statement {
  private args: unknown[] = [];
  constructor(
    private readonly db: MetricsD1,
    private readonly sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>() {
    return this.db.first(this.sql, this.args) as T | null;
  }
}

class MetricsD1 {
  project: Record<string, unknown> | null = { status: "ACTIVE", role: "VIEWER" };
  audit: Record<string, unknown> = {};
  inventory: Record<string, unknown> = {};
  queries: Array<{ sql: string; args: unknown[] }> = [];
  prepare(sql: string) {
    return new Statement(this, sql);
  }
  first(sql: string, args: unknown[]) {
    this.queries.push({ sql, args });
    if (sql.includes("JOIN project_members")) return this.project;
    if (sql.includes("FROM project_audit_events")) return this.audit;
    if (sql.includes("(SELECT COUNT(*) FROM artifact_versions av JOIN artifacts a"))
      return this.inventory;
    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

const env = (db: MetricsD1) => ({ DB: db as any, WEB_ORIGIN: "https://web.test" });
const request = (query = "") =>
  new Request(`https://api.test/projects/project-1/metrics${query}`, {
    headers: { origin: "https://web.test" },
  });

async function body(response: Response) {
  return (await response.json()) as any;
}

test("metrics router authenticates before project resolution", async () => {
  const db = new MetricsD1();
  const response = await createApp().fetch(request(), {
    DB: db as any,
    OBJECTS: {} as any,
    WEB_ORIGIN: "https://web.test",
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await body(response), { error: "UNAUTHENTICATED" });
  assert.equal(db.queries.length, 0);
});

test("sampled rates use terminal outcomes and return null without samples", () => {
  assert.deepEqual(sampledRate(7, 3), { successes: 7, failures: 3, sampleCount: 10, rate: 0.7 });
  assert.deepEqual(sampledRate(0, 0), { successes: 0, failures: 0, sampleCount: 0, rate: null });
});

test("project metrics aggregate bounded metadata without inventing unavailable values", async () => {
  const db = new MetricsD1();
  db.project = { status: "ARCHIVED", role: "EDITOR" };
  db.audit = {
    audit_events: 12,
    first_event_at: "2026-08-01T00:00:00.000Z",
    last_event_at: "2026-09-01T00:00:00.000Z",
    graph_published: 3,
    graph_failed: 1,
    sync_succeeded: 4,
    sync_failed: 2,
    snapshot_succeeded: 1,
    snapshot_failed: 1,
    team_events: 2,
    artifact_events: 4,
    projects_created: 1,
    git_connected: 1,
    members_invited: 2,
    invitations_accepted: 1,
  };
  db.inventory = {
    artifact_versions: 4,
    artifact_bytes: 100,
    graph_versions: 2,
    graph_bytes: 200,
    snapshots: 1,
    snapshot_bytes: 30,
    graph_published: 3,
    graph_failed: 1,
    graph_duration_samples: 4,
    graph_duration_avg_ms: 1500.5,
    graph_duration_min_ms: 500,
    graph_duration_max_ms: 3000,
  };

  const response = await handleMetricsRoute(
    request("?windowDays=30"),
    env(db),
    { id: "user-1" },
    "project-1",
    new Date("2026-09-16T00:00:00.000Z"),
  );
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.deepEqual(result.window, {
    days: 30,
    from: "2026-08-17T00:00:00.000Z",
    to: "2026-09-16T00:00:00.000Z",
  });
  assert.equal(result.project.status, "ARCHIVED");
  assert.equal(result.reliability.graphBuild.rate, 0.75);
  assert.equal(result.reliability.sync.sampleCount, 6);
  assert.equal(result.reliability.failedUpdatePreservation, null);
  assert.equal(result.reliability.artifactConflictRate, null);
  assert.equal(result.immutableObjectMetadata.knownReferencedBytes, 330);
  assert.equal(result.immutableObjectMetadata.orphanBytes, null);
  assert.equal(result.timing.graphDurationMs.average, 1500.5);
  assert.deepEqual(result.onboarding, {
    projectsCreated: 1,
    gitConnected: 1,
    membersInvited: 2,
    invitationsAccepted: 1,
  });
  assert.equal(db.queries.length, 3);
  assert.match(db.queries[2]?.sql ?? "", /artifact_versions av JOIN artifacts a/);
  assert.match(db.queries[2]?.sql ?? "", /status IN \('FAILED','CLEANED'\)/);
  assert.match(
    db.queries[2]?.sql ?? "",
    /CASE WHEN status='PUBLISHED' THEN published_at ELSE failed_at END/,
  );
  assert.doesNotMatch(db.queries[1]?.sql ?? "", /occurred_at<=/);
  assert.doesNotMatch(db.queries[2]?.sql ?? "", /(?:published_at|failed_at)<=/);
  assert.deepEqual(db.queries[1]?.args, [
    "project-1",
    "2026-08-17T00:00:00.000Z",
    "2026-09-16T00:00:00.000Z",
  ]);
  assert.deepEqual(db.queries[2]?.args.slice(6, 9), [
    "project-1",
    "2026-08-17T00:00:00.000Z",
    "2026-09-16T00:00:00.000Z",
  ]);
  for (const query of db.queries.slice(1)) {
    assert.match(query.sql, /project_id=\?/);
    assert.ok(query.args.filter((value) => value === "project-1").length >= 1);
  }
});

test("metrics authorize direct roles, hide outsiders, and enforce exact windows", async () => {
  for (const role of ["ADMIN", "EDITOR", "VIEWER"] as const) {
    const db = new MetricsD1();
    db.project = { status: "ACTIVE", role };
    const response = await handleMetricsRoute(request("?windowDays=7"), env(db), { id: "u" }, "p");
    assert.equal(response.status, 200);
    assert.equal((await body(response)).project.role, role);
  }

  const outsider = new MetricsD1();
  outsider.project = null;
  const denied = await handleMetricsRoute(
    request(),
    env(outsider),
    { id: "outsider" },
    "project-1",
  );
  assert.equal(denied.status, 404);
  assert.deepEqual(await body(denied), { error: "NOT_FOUND" });
  assert.equal(outsider.queries.length, 1);

  for (const query of [
    "?windowDays=6",
    "?windowDays=91",
    "?windowDays=7&windowDays=30",
    "?from=x",
  ]) {
    const db = new MetricsD1();
    const response = await handleMetricsRoute(request(query), env(db), { id: "u" }, "project-1");
    assert.equal(response.status, 400);
    assert.equal(db.queries.length, 0);
  }
});
