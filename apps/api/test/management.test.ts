import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/index.js";
import {
  handleGlobalActivity,
  handleGlobalSettings,
  type ManagementUser,
} from "../src/management.js";

const user: ManagementUser = {
  id: "user-1",
  session_id: "session-1",
  username: "alice",
  display_name: "Alice",
  avatar_url: null,
};

const eventRows = [
  {
    id: "git:event-2",
    project_id: "accessible-1",
    project_name: "Payments",
    project_slug: "payments",
    project_status: "ACTIVE",
    actor_kind: "HUMAN",
    actor_id: "user-1",
    action: "GIT_SYNCED",
    target_type: "REPOSITORY",
    target_id: "repo-1",
    outcome: "SUCCEEDED",
    metadata_json: "{}",
    occurred_at: "2026-09-14T11:00:00.000Z",
  },
  {
    id: "graph:event-1",
    project_id: "accessible-2",
    project_name: "Identity",
    project_slug: "identity",
    project_status: "ARCHIVED",
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

const inaccessibleEvent = {
  ...eventRows[0],
  id: "git:inaccessible-event",
  project_id: "inaccessible-3",
  project_name: "Mobile Secret",
  project_slug: "mobile-secret",
  occurred_at: "2026-09-14T10:30:00.000Z",
} as const;

const accessibleSettingsRow = {
  id: "accessible-1",
  name: "Payments",
  slug: "payments",
  status: "ACTIVE",
  settings_revision: 4,
  role: "VIEWER",
  git_provider: "github",
  repository_url: "https://github.com/acme/payments",
  repository_owner: "acme",
  repository_name: "payments",
  default_branch: "main",
  current_commit: "a".repeat(40),
  git_status: "VERIFIED",
  git_verified_at: "2026-09-14T00:00:00.000Z",
  graph_version: 3,
  graph_status: "READY",
  graph_source_commit: "a".repeat(40),
  sync_status: "CURRENT",
  sync_last_seen_at: "2026-09-14T01:00:00.000Z",
};

class ManagementDb {
  activitySql = "";
  activityArgs: unknown[] = [];
  settingsSql = "";
  settingsArgs: unknown[] = [];

  prepare(sql: string) {
    const db = this;
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        args = values;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM sessions s JOIN users")) {
          return {
            provider: "github",
            provider_user_id: "42",
            username: "alice",
            display_name: "Alice",
            avatar_url: null,
            created_at: "2026-01-01T00:00:00.000Z",
            last_login_at: "2026-09-14T00:00:00.000Z",
            session_id: "session-1",
            session_created_at: "2026-09-14T00:00:00.000Z",
            session_expires_at: "2026-10-14T00:00:00.000Z",
          } as T;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM project_audit_events")) {
          db.activitySql = sql;
          db.activityArgs = args;
          const authorizationInsideAggregate =
            sql.includes("JOIN project_members pm") && sql.includes("JOIN workspace_members wm");
          let selected = authorizationInsideAggregate
            ? [...eventRows]
            : [...eventRows, inaccessibleEvent];
          if (sql.includes("p.status=?")) {
            const status = args.find((value) => value === "ACTIVE" || value === "ARCHIVED");
            selected = selected.filter((row) => row.project_status === status);
          }
          if (sql.includes("pae.action=?")) {
            const action = args.find((value) => value === "GIT_SYNCED" || value === "GRAPH_FAILED");
            selected = selected.filter((row) => row.action === action);
          }
          return { results: selected as unknown as T[] };
        }
        db.settingsSql = sql;
        db.settingsArgs = args;
        const authorizationInsideOverview =
          sql.includes("JOIN project_members pm") && sql.includes("JOIN workspace_members wm");
        return {
          results: (authorizationInsideOverview
            ? [accessibleSettingsRow]
            : [accessibleSettingsRow, { ...accessibleSettingsRow, id: "inaccessible-3" }]) as T[],
        };
      },
    };
  }
}

const env = (db: ManagementDb) => ({
  DB: db as unknown as D1Database,
  WEB_ORIGIN: "https://web.test",
});
const request = (path: string, method = "GET") =>
  new Request(`https://api.test${path}`, { method, headers: { origin: "https://web.test" } });

test("global activity is bounded and every aggregate query authorizes direct current membership", async () => {
  const db = new ManagementDb();
  const response = await handleGlobalActivity(
    request("/activity?limit=1&from=2026-09-01&to=2026-09-15"),
    env(db),
    user,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    events: Array<{ project: { id: string } }>;
    nextCursor: string;
    projectStatusPolicy: string;
  };
  assert.deepEqual(
    body.events.map((event) => event.project.id),
    ["accessible-1"],
  );
  assert.equal(body.projectStatusPolicy, "ACTIVE_AND_ARCHIVED");
  assert.ok(body.nextCursor);
  assert.match(
    db.activitySql,
    /JOIN project_members pm ON pm\.project_id=p\.id AND pm\.user_id=\?/,
  );
  assert.match(db.activitySql, /JOIN workspace_members wm/);
  assert.match(db.activitySql, /ORDER BY pae\.occurred_at DESC,pae\.id DESC LIMIT \?/);
  assert.equal(db.activityArgs[0], "user-1");
  assert.equal(db.activityArgs.at(-1), 2);
  assert.doesNotMatch(JSON.stringify(body), /inaccessible|count/i);

  const next = await handleGlobalActivity(
    request(`/activity?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`),
    env(db),
    user,
  );
  assert.equal(next.status, 200);
  assert.match(db.activitySql, /pae\.occurred_at<\?/);

  const archived = await handleGlobalActivity(
    request("/activity?projectStatus=ARCHIVED&from=2026-09-01&to=2026-09-15"),
    env(db),
    user,
  );
  const archivedBody = (await archived.json()) as {
    events: Array<{ project: { id: string; status: string } }>;
  };
  assert.equal(archivedBody.events.length, 1);
  assert.equal(archivedBody.events[0]?.project.id, "accessible-2");
  assert.equal(archivedBody.events[0]?.project.status, "ARCHIVED");
  assert.doesNotMatch(JSON.stringify(archivedBody), /inaccessible-3|Mobile Secret|count/i);
});

test("global activity validates cursor, window, status, and method bounds", async () => {
  const db = new ManagementDb();
  assert.equal(
    (await handleGlobalActivity(request("/activity?limit=51"), env(db), user)).status,
    400,
  );
  assert.equal(
    (await handleGlobalActivity(request("/activity?from=2025-01-01&to=2026-01-01"), env(db), user))
      .status,
    400,
  );
  assert.equal(
    (await handleGlobalActivity(request("/activity?projectStatus=DELETED"), env(db), user)).status,
    400,
  );
  const filtered = await handleGlobalActivity(request("/activity?limit=1"), env(db), user);
  const filteredCursor = ((await filtered.json()) as { nextCursor: string }).nextCursor;
  assert.ok(filteredCursor);
  const tampered = await handleGlobalActivity(
    request(`/activity?limit=1&action=GRAPH_FAILED&cursor=${filteredCursor}`),
    env(db),
    user,
  );
  assert.equal(tampered.status, 400);
  const method = await handleGlobalActivity(request("/activity", "POST"), env(db), user);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET");
});

test("global settings returns only authorized bounded read-only configuration without secrets", async () => {
  const db = new ManagementDb();
  const response = await handleGlobalSettings(request("/settings"), env(db), user);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    account: { provider: string };
    projects: Array<{ id: string; role: string }>;
    readOnly: boolean;
  };
  assert.equal(body.account.provider, "github");
  assert.deepEqual(
    body.projects.map((project) => project.id),
    ["accessible-1"],
  );
  assert.equal(body.projects[0]?.role, "VIEWER");
  assert.equal(body.readOnly, true);
  assert.match(
    db.settingsSql,
    /JOIN project_members pm ON pm\.project_id=p\.id AND pm\.user_id=\?/,
  );
  assert.match(db.settingsSql, /JOIN workspace_members wm/);
  assert.match(db.settingsSql, /LIMIT 101/);
  assert.deepEqual(db.settingsArgs, ["user-1"]);
  assert.doesNotMatch(
    JSON.stringify(body),
    /token|secret|installation|private.key|inaccessible-3/i,
  );
  const method = await handleGlobalSettings(request("/settings", "POST"), env(db), user);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET");
});

test("global routes authenticate before management queries", async () => {
  let queried = false;
  const database = {
    prepare() {
      queried = true;
      throw new Error("must not query");
    },
  } as unknown as D1Database;
  const objects = { head: async () => null } as unknown as R2Bucket;
  for (const path of ["/activity", "/settings"]) {
    queried = false;
    const response = await createApp().fetch(request(path), {
      DB: database,
      OBJECTS: objects,
      WEB_ORIGIN: "https://web.test",
    });
    assert.equal(response.status, 401);
    assert.equal(queried, false);
    assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
    const preflight = await createApp().fetch(request(path, "OPTIONS"), {
      DB: database,
      OBJECTS: objects,
      WEB_ORIGIN: "https://web.test",
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
    assert.equal(queried, false);
  }
});
