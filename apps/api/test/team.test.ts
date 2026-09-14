import assert from "node:assert/strict";
import test from "node:test";
import type { IdentityLookupProvider } from "../src/identity-lookup-provider.js";
import { createApp, type Env } from "../src/index.js";
import { SESSION_COOKIE } from "../src/security.js";
import { handleInvitationInbox, handleTeamRoute } from "../src/team.js";

type Row = Record<string, unknown>;

class Statement {
  args: unknown[] = [];
  constructor(
    private readonly db: TeamD1,
    readonly sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM sessions s JOIN users u")) {
      return (
        this.db.sessionUser
          ? {
              id: this.db.sessionUser,
              session_id: "session",
              username: this.db.sessionUser,
              display_name: null,
              avatar_url: null,
            }
          : null
      ) as T | null;
    }
    if (this.sql.includes("SELECT pm.role FROM projects")) {
      const userId = String(this.args[1]);
      return (
        this.db.memberships.get(userId) ? { role: this.db.memberships.get(userId) } : null
      ) as T | null;
    }
    if (this.sql.includes("SELECT id FROM users WHERE provider=? AND provider_user_id=?")) {
      const providerId = String(this.args[1]);
      return (
        this.db.localUsers.get(providerId) ? { id: this.db.localUsers.get(providerId) } : null
      ) as T | null;
    }
    if (this.sql.includes("INSERT INTO project_invitations")) {
      return (
        this.db.inviteCreated
          ? { id: "new-invite", invitee_user_id: this.args[2], role: this.args[3] }
          : null
      ) as T | null;
    }
    if (this.sql.includes("UPDATE project_invitations") && this.sql.includes("status='ACCEPTED'")) {
      const [actor, invitationId, invitee] = this.args.map(String);
      if (
        actor !== invitee ||
        actor !== this.db.invitee ||
        invitationId !== this.db.invitationId ||
        this.db.accepted
      )
        return null;
      this.db.accepted = true;
      return {
        id: invitationId,
        project_id: "project-a",
        role: "EDITOR",
        accepted_at: "db-time",
      } as T;
    }
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
  async run(): Promise<D1Result> {
    return { success: true, meta: { changes: 0 } } as D1Result;
  }
}

class TeamD1 {
  memberships = new Map<string, string>();
  localUsers = new Map<string, string>();
  providerUsers = new Map<string, { providerUserId: string; username: string }>();
  batchChanges = [0, 0, 0];
  inviteCreated = false;
  prepared: Statement[] = [];
  invitee = "invitee";
  invitationId = "invite-1";
  accepted = false;
  sessionUser: string | null = null;
  prepare(sql: string) {
    const statement = new Statement(this, sql);
    this.prepared.push(statement);
    return statement;
  }
  async batch<T>(statements: D1PreparedStatement[]) {
    return statements.map((_, index) => ({
      success: true,
      meta: { changes: this.batchChanges[index] ?? 0 },
    })) as D1Result<T>[];
  }
}

function env(db: TeamD1): Env {
  return {
    DB: db as unknown as D1Database,
    OBJECTS: {} as R2Bucket,
    WEB_ORIGIN: "https://web.example",
  };
}

function identityProvider(db: TeamD1): IdentityLookupProvider {
  return {
    provider: "github",
    async resolveLogin(login) {
      const resolved = db.providerUsers.get(login.toLowerCase());
      return resolved ? { provider: "github", ...resolved } : null;
    },
  };
}

function teamRoute(
  request: Request,
  bindings: Env,
  user: { id: string },
  projectId: string,
  memberUserId?: string,
  invitationId?: string,
): Promise<Response> {
  return handleTeamRoute(
    request,
    bindings,
    user,
    projectId,
    identityProvider(bindings.DB as unknown as TeamD1),
    memberUserId,
    invitationId,
  );
}

function request(
  path: string,
  method: string,
  body?: Row,
  origin = "https://web.example",
): Request {
  return new Request(`https://api.example${path}`, {
    method,
    headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("team mutations require direct current ADMIN membership", async () => {
  const db = new TeamD1();
  db.memberships.set("viewer", "VIEWER");
  const viewer = await teamRoute(
    request("/projects/project-a/team", "POST", { username: "known", role: "EDITOR" }),
    env(db),
    { id: "viewer" },
    "project-a",
  );
  assert.equal(viewer.status, 403);
  assert.deepEqual(await viewer.json(), { error: "FORBIDDEN" });

  const outsider = await teamRoute(
    request("/projects/project-a/team", "GET"),
    env(db),
    { id: "outsider" },
    "project-a",
  );
  assert.equal(outsider.status, 404);
});

test("invite rejects mass assignment, hostile origin, self invite, and unknown identity", async () => {
  const db = new TeamD1();
  db.memberships.set("admin", "ADMIN");
  db.providerUsers.set("admin", { providerUserId: "1", username: "Admin" });
  db.localUsers.set("1", "admin");
  const extra = await teamRoute(
    request("/projects/project-a/team", "POST", {
      username: "admin",
      role: "ADMIN",
      projectId: "other",
    }),
    env(db),
    { id: "admin" },
    "project-a",
  );
  assert.equal(extra.status, 400);

  const hostile = await teamRoute(
    request(
      "/projects/project-a/team",
      "POST",
      { username: "known", role: "EDITOR" },
      "https://evil.example",
    ),
    env(db),
    { id: "admin" },
    "project-a",
  );
  assert.equal(hostile.status, 403);

  const self = await teamRoute(
    request("/projects/project-a/team", "POST", { username: "admin", role: "ADMIN" }),
    env(db),
    { id: "admin" },
    "project-a",
  );
  assert.equal(self.status, 409);

  db.providerUsers.clear();
  const unknown = await teamRoute(
    request("/projects/project-a/team", "POST", { username: "missing", role: "VIEWER" }),
    env(db),
    { id: "admin" },
    "project-a",
  );
  assert.equal(unknown.status, 409);
});

test("invite authority follows current provider stable identity, not cached or duplicate usernames", async () => {
  const db = new TeamD1();
  db.memberships.set("admin", "ADMIN");
  db.providerUsers.set("renamed-user", { providerUserId: "42", username: "Renamed-User" });
  db.localUsers.set("42", "target");
  db.inviteCreated = true;
  const renamed = await teamRoute(
    request("/projects/project-a/team", "POST", { username: "RENAMED-USER", role: "EDITOR" }),
    env(db),
    { id: "admin" },
    "project-a",
  );
  assert.equal(renamed.status, 201);
  const localLookup = db.prepared.find((statement) => statement.sql.includes("provider_user_id=?"));
  assert.deepEqual(localLookup?.args, ["github", "42"]);
  const inviteWrite = db.prepared.find((statement) =>
    statement.sql.includes("INSERT INTO project_invitations"),
  );
  assert.ok(inviteWrite?.sql.includes("p.status='ACTIVE'"));
  assert.ok(inviteWrite?.sql.includes("admin.role='ADMIN'"));

  db.inviteCreated = false;
  db.providerUsers.set("old-login", { providerUserId: "99", username: "old-login" });
  const reclaimed = await teamRoute(
    request("/projects/project-a/team", "POST", { username: "old-login", role: "VIEWER" }),
    env(db),
    { id: "admin" },
    "project-a",
  );
  assert.equal(reclaimed.status, 409);
  assert.deepEqual(await reclaimed.json(), { error: "INVITEE_UNAVAILABLE" });

  for (const username of ["self", "existing-member", "pending", "duplicate-name", "unknown"]) {
    db.providerUsers.set(username, { providerUserId: username, username });
    db.localUsers.set(username, username === "self" ? "admin" : `local-${username}`);
    const unavailable = await teamRoute(
      request("/projects/project-a/team", "POST", { username, role: "VIEWER" }),
      env(db),
      { id: "admin" },
      "project-a",
    );
    assert.equal(unavailable.status, 409);
    assert.deepEqual(await unavailable.json(), { error: "INVITEE_UNAVAILABLE" });
  }
});

test("acceptance binds exact authenticated invitee and is replay safe", async () => {
  const db = new TeamD1();
  const wrong = await handleInvitationInbox(
    request("/invitations/invite-1/accept", "POST", {}),
    env(db),
    { id: "other" },
    "invite-1",
  );
  assert.equal(wrong.status, 409);
  assert.equal(db.accepted, false);

  const accepted = await handleInvitationInbox(
    request("/invitations/invite-1/accept", "POST", {}),
    env(db),
    { id: "invitee" },
    "invite-1",
  );
  assert.equal(accepted.status, 200);
  assert.equal(db.accepted, true);
  const acceptanceWrite = db.prepared.find(
    (statement) =>
      statement.sql.includes("status='ACCEPTED'") && statement.sql.includes("RETURNING"),
  );
  assert.ok(acceptanceWrite?.sql.includes("p.status='ACTIVE'"));

  const replay = await handleInvitationInbox(
    request("/invitations/invite-1/accept", "POST", {}),
    env(db),
    { id: "invitee" },
    "invite-1",
  );
  assert.equal(replay.status, 409);
});

test("invitation revocation write atomically rechecks active project ADMIN", async () => {
  const db = new TeamD1();
  db.memberships.set("admin", "ADMIN");
  const result = await teamRoute(
    request("/projects/project-a/team/invitations/invite-1", "DELETE", {}),
    env(db),
    { id: "admin" },
    "project-a",
    undefined,
    "invite-1",
  );
  assert.equal(result.status, 409);
  const write = db.prepared.find(
    (statement) =>
      statement.sql.includes("status='REVOKED'") && statement.sql.includes("RETURNING"),
  );
  assert.ok(write?.sql.includes("p.status='ACTIVE'"));
  assert.ok(write?.sql.includes("admin.role='ADMIN'"));
});

test("role changes require expected role/revision and invalidate only affected project sync state", async () => {
  const db = new TeamD1();
  db.memberships.set("admin", "ADMIN");
  db.batchChanges = [1, 1];
  const changed = await teamRoute(
    request("/projects/project-a/team/members/editor", "PATCH", {
      role: "VIEWER",
      expectedRole: "EDITOR",
      expectedRevision: 4,
    }),
    env(db),
    { id: "admin" },
    "project-a",
    "editor",
  );
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), {
    member: { user_id: "editor", role: "VIEWER", revision: 5 },
  });
  const invalidation = db.prepared.find((statement) =>
    statement.sql.includes("DELETE FROM sync_states"),
  );
  assert.ok(invalidation);
  assert.deepEqual(invalidation.args, ["project-a", "editor", "project-a", "editor", "VIEWER", 5]);
  const roleWrite = db.prepared.find((statement) =>
    statement.sql.includes("UPDATE project_members SET previous_role"),
  );
  assert.ok(roleWrite?.sql.includes("p.status='ACTIVE'"));
  assert.ok(roleWrite?.sql.includes("a.role='ADMIN'"));

  db.batchChanges = [0, 0];
  const stale = await teamRoute(
    request("/projects/project-a/team/members/editor", "PATCH", {
      role: "ADMIN",
      expectedRole: "EDITOR",
      expectedRevision: 4,
    }),
    env(db),
    { id: "admin" },
    "project-a",
    "editor",
  );
  assert.equal(stale.status, 409);
});

test("member removal is expected-role/revision conditional and scopes sync invalidation", async () => {
  const db = new TeamD1();
  db.memberships.set("admin", "ADMIN");
  db.batchChanges = [1, 1, 2];
  const removed = await teamRoute(
    request("/projects/project-a/team/members/viewer", "DELETE", {
      expectedRole: "VIEWER",
      expectedRevision: 2,
    }),
    env(db),
    { id: "admin" },
    "project-a",
    "viewer",
  );
  assert.equal(removed.status, 200);
  const invalidation = db.prepared.find((statement) =>
    statement.sql.includes("DELETE FROM sync_states"),
  );
  assert.ok(invalidation?.sql.includes("NOT EXISTS"));
  assert.deepEqual(invalidation?.args, ["project-a", "viewer", "project-a", "viewer"]);
  const removalWrite = db.prepared.find((statement) =>
    statement.sql.includes("DELETE FROM project_members"),
  );
  assert.ok(removalWrite?.sql.includes("p.status='ACTIVE'"));
  assert.ok(removalWrite?.sql.includes("a.role='ADMIN'"));
});

test("invitation inbox validates bounded cursor pagination", async () => {
  const db = new TeamD1();
  const oversized = await handleInvitationInbox(request("/invitations?limit=51", "GET"), env(db), {
    id: "invitee",
  });
  assert.equal(oversized.status, 400);
  const unknown = await handleInvitationInbox(
    request("/invitations?projectId=project-a", "GET"),
    env(db),
    { id: "invitee" },
  );
  assert.equal(unknown.status, 400);
  const valid = await handleInvitationInbox(
    request("/invitations?limit=10&cursor=invite-1", "GET"),
    env(db),
    { id: "invitee" },
  );
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { invitations: [], nextCursor: null });
});

test("router applies exact-origin credentialed CORS to team successes and errors", async () => {
  const db = new TeamD1();
  db.sessionUser = "admin";
  db.memberships.set("admin", "ADMIN");
  db.providerUsers.set("known", { providerUserId: "42", username: "Known" });
  db.localUsers.set("42", "target");
  db.inviteCreated = true;
  db.batchChanges = [1, 1, 1];
  const app = createApp(
    async () =>
      new Response(JSON.stringify({ id: 42, login: "Known" }), {
        headers: { "content-type": "application/json" },
      }),
  );
  const call = (path: string, method: string, body?: Row, origin?: string) =>
    app.fetch(
      new Request(`https://api.example${path}`, {
        method,
        headers: {
          cookie: `${SESSION_COOKIE}=token`,
          ...(origin === undefined ? {} : { origin }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env(db),
    );
  const successes = [
    await call("/projects/project-a/team", "GET", undefined, "https://web.example"),
    await call(
      "/projects/project-a/team",
      "POST",
      { username: "known", role: "VIEWER" },
      "https://web.example",
    ),
    await call(
      "/projects/project-a/team/members/target",
      "PATCH",
      { role: "VIEWER", expectedRole: "EDITOR", expectedRevision: 1 },
      "https://web.example",
    ),
    await call(
      "/projects/project-a/team/members/target",
      "DELETE",
      { expectedRole: "VIEWER", expectedRevision: 2 },
      "https://web.example",
    ),
  ];
  for (const result of successes) {
    assert.ok(result.status < 400);
    assert.equal(result.headers.get("access-control-allow-origin"), "https://web.example");
    assert.equal(result.headers.get("access-control-allow-credentials"), "true");
    assert.equal(result.headers.get("vary"), "origin");
  }

  const getError = await call(
    "/invitations?unexpected=true",
    "GET",
    undefined,
    "https://web.example",
  );
  assert.equal(getError.status, 400);
  assert.equal(getError.headers.get("access-control-allow-origin"), "https://web.example");

  db.batchChanges = [0, 0, 0];
  const exactOriginError = await call(
    "/projects/project-a/team/members/target",
    "PATCH",
    { role: "ADMIN", expectedRole: "VIEWER", expectedRevision: 2 },
    "https://web.example",
  );
  assert.equal(exactOriginError.status, 409);
  assert.equal(exactOriginError.headers.get("access-control-allow-origin"), "https://web.example");
  const hostile = await call(
    "/projects/project-a/team",
    "POST",
    { username: "known", role: "VIEWER" },
    "https://evil.example",
  );
  assert.equal(hostile.status, 403);
  assert.equal(hostile.headers.get("access-control-allow-origin"), null);
  const missing = await call("/projects/project-a/team/members/target", "DELETE", {
    expectedRole: "VIEWER",
    expectedRevision: 2,
  });
  assert.equal(missing.status, 403);
  assert.equal(missing.headers.get("access-control-allow-origin"), null);
});

test("every team mutation uses the shared bounded JSON object reader", async () => {
  const db = new TeamD1();
  db.memberships.set("admin", "ADMIN");
  const invoke = (kind: "invite" | "accept" | "revoke" | "role" | "remove", req: Request) => {
    if (kind === "accept")
      return handleInvitationInbox(req, env(db), { id: "invitee" }, "invite-1");
    if (kind === "revoke")
      return teamRoute(req, env(db), { id: "admin" }, "project-a", undefined, "invite-1");
    if (kind === "role") return teamRoute(req, env(db), { id: "admin" }, "project-a", "target");
    if (kind === "remove") return teamRoute(req, env(db), { id: "admin" }, "project-a", "target");
    return teamRoute(req, env(db), { id: "admin" }, "project-a");
  };
  const paths = {
    invite: ["POST", "/projects/project-a/team"],
    accept: ["POST", "/invitations/invite-1/accept"],
    revoke: ["DELETE", "/projects/project-a/team/invitations/invite-1"],
    role: ["PATCH", "/projects/project-a/team/members/target"],
    remove: ["DELETE", "/projects/project-a/team/members/target"],
  } as const;
  for (const kind of Object.keys(paths) as (keyof typeof paths)[]) {
    const [method, path] = paths[kind];
    const declared = new Request(`https://api.example${path}`, {
      method,
      headers: {
        origin: "https://web.example",
        "content-type": "application/json",
        "content-length": "2049",
      },
      body: "{}",
    });
    assert.equal((await invoke(kind, declared)).status, 413, `${kind} declared size`);
    const chunked = new Request(`https://api.example${path}`, {
      method,
      headers: { origin: "https://web.example", "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(2100) }),
    });
    assert.equal((await invoke(kind, chunked)).status, 413, `${kind} streamed size`);
    const malformed = new Request(`https://api.example${path}`, {
      method,
      headers: { origin: "https://web.example", "content-type": "application/json" },
      body: "{",
    });
    assert.equal((await invoke(kind, malformed)).status, 400, `${kind} malformed`);
    const nonObject = new Request(`https://api.example${path}`, {
      method,
      headers: { origin: "https://web.example", "content-type": "application/json" },
      body: "[]",
    });
    assert.equal((await invoke(kind, nonObject)).status, 400, `${kind} non-object`);
  }
});

test("acceptance enforces JSON content type and exact empty body", async () => {
  const db = new TeamD1();
  const wrongType = await handleInvitationInbox(
    request("/invitations/invite-1/accept", "POST"),
    env(db),
    { id: "invitee" },
    "invite-1",
  );
  assert.equal(wrongType.status, 415);
  const assigned = await handleInvitationInbox(
    request("/invitations/invite-1/accept", "POST", { role: "ADMIN" }),
    env(db),
    { id: "invitee" },
    "invite-1",
  );
  assert.equal(assigned.status, 400);
});
