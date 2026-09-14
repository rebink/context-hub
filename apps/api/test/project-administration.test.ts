/* biome-ignore-all lint/suspicious/noExplicitAny: The fake models the D1 binding structurally. */
/* biome-ignore-all lint/style/noNonNullAssertion: Assertions establish fixture presence. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Env } from "../src/index.js";
import { handleProjectAdministration } from "../src/project-administration.js";

type ProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  settings_revision: number;
};
type MemberRow = { project_id: string; user_id: string; role: string };

class Statement {
  args: any[] = [];
  constructor(
    private readonly db: AdminD1,
    private readonly sql: string,
  ) {}
  bind(...args: any[]) {
    this.args = args;
    return this;
  }
  async first<T>() {
    return this.db.first(this.sql, this.args) as T | null;
  }
}

class AdminD1 {
  projects: ProjectRow[] = [
    {
      id: "p",
      workspace_id: "w",
      name: "Payments",
      slug: "payments",
      description: "Money flows",
      status: "ACTIVE",
      settings_revision: 1,
    },
    {
      id: "q",
      workspace_id: "w",
      name: "Identity",
      slug: "identity",
      description: null,
      status: "ACTIVE",
      settings_revision: 1,
    },
  ];
  members: MemberRow[] = [
    { project_id: "p", user_id: "admin", role: "ADMIN" },
    { project_id: "p", user_id: "editor", role: "EDITOR" },
    { project_id: "p", user_id: "viewer", role: "VIEWER" },
    { project_id: "q", user_id: "other-admin", role: "ADMIN" },
  ];
  events: Record<string, unknown>[] = [];
  beforeUpdate?: () => void;
  afterUpdate?: () => void;
  updateError?: Error;

  prepare(sql: string) {
    return new Statement(this, sql);
  }

  first(sql: string, args: any[]): Record<string, unknown> | null {
    if (sql.includes("SELECT p.id,p.workspace_id")) {
      const project = this.projects.find((row) => row.id === args[0] && row.status === "ACTIVE");
      const membership = this.members.find(
        (row) => row.project_id === args[0] && row.user_id === args[1],
      );
      return project && membership
        ? {
            ...project,
            role: membership.role,
            member_count: this.members.filter((row) => row.project_id === project.id).length,
            artifact_count: 0,
          }
        : null;
    }
    if (sql.includes("UPDATE projects SET name=?")) {
      if (this.updateError) throw this.updateError;
      this.beforeUpdate?.();
      this.beforeUpdate = undefined;
      const project = this.projects.find(
        (row) =>
          row.id === args[4] &&
          row.status === "ACTIVE" &&
          row.settings_revision === args[5] &&
          this.members.some(
            (member) =>
              member.project_id === row.id && member.user_id === args[6] && member.role === "ADMIN",
          ),
      );
      if (!project) return null;
      if (
        this.projects.some(
          (row) =>
            row.workspace_id === project.workspace_id &&
            row.id !== project.id &&
            row.slug === args[1],
        )
      ) {
        throw new Error("UNIQUE constraint failed: projects.workspace_id, projects.slug");
      }
      const before = {
        name: project.name,
        slug: project.slug,
        description: project.description,
        revision: project.settings_revision,
      };
      project.name = args[0];
      project.slug = args[1];
      project.description = args[2];
      project.settings_revision += 1;
      this.events.push({
        actor_user_id: args[3],
        project_id: project.id,
        target_type: "PROJECT",
        target_id: project.id,
        action: "PROJECT_SETTINGS_UPDATED",
        before_metadata: JSON.stringify(before),
        after_metadata: JSON.stringify({
          name: project.name,
          slug: project.slug,
          description: project.description,
          revision: project.settings_revision,
        }),
        created_at: "D1_TIME",
      });
      const returned = {
        name: project.name,
        slug: project.slug,
        description: project.description,
        settings_revision: project.settings_revision,
      };
      this.afterUpdate?.();
      this.afterUpdate = undefined;
      return returned;
    }
    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

function request(
  body: unknown,
  init: { origin?: string; contentType?: string; method?: string } = {},
) {
  const encoded = JSON.stringify(body);
  return new Request("https://api.example/projects/p", {
    method: init.method ?? "PATCH",
    headers: {
      origin: init.origin ?? "https://app.example",
      "content-type": init.contentType ?? "application/json",
    },
    body: encoded,
  });
}

async function body(response: Response) {
  return response.json() as Promise<any>;
}

function fixture() {
  const db = new AdminD1();
  const env = {
    DB: db as unknown as D1Database,
    WEB_ORIGIN: "https://app.example",
  } as Env;
  return { db, env };
}

const update = {
  name: "Payments Platform",
  slug: "payments-platform",
  description: "Bounded payment context",
  expectedRevision: 1,
};

test("project settings are current-ADMIN-only and project isolated", async () => {
  const { env } = fixture();
  assert.equal(
    (await handleProjectAdministration(request(update), env, { id: "admin" }, "p")).status,
    200,
  );
  for (const userId of ["editor", "viewer"]) {
    const denied = await handleProjectAdministration(request(update), env, { id: userId }, "p");
    assert.equal(denied.status, 403);
  }
  for (const [userId, projectId] of [
    ["outsider", "p"],
    ["other-admin", "p"],
    ["admin", "q"],
  ] satisfies Array<[string, string]>) {
    const denied = await handleProjectAdministration(
      request(update),
      env,
      { id: userId },
      projectId,
    );
    assert.equal(denied.status, 404);
    assert.deepEqual(await body(denied), { error: "NOT_FOUND" });
  }
});

test("project settings reject mass assignment and enforce exact bounded input", async () => {
  const { env } = fixture();
  for (const value of [
    { ...update, workspace_id: "other" },
    { ...update, status: "ARCHIVED" },
    { ...update, repositoryId: "forged" },
    { ...update, slug: "Bad Slug" },
    { ...update, name: " ".repeat(101) },
    { ...update, description: "x".repeat(501) },
  ]) {
    const response = await handleProjectAdministration(request(value), env, { id: "admin" }, "p");
    assert.equal(response.status, 400);
  }
  assert.equal(
    (
      await handleProjectAdministration(
        request(update, { contentType: "text/plain" }),
        env,
        { id: "admin" },
        "p",
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await handleProjectAdministration(
        request(update, { origin: "https://evil.example" }),
        env,
        { id: "admin" },
        "p",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleProjectAdministration(
        request(update, { method: "POST" }),
        env,
        { id: "admin" },
        "p",
      )
    ).status,
    405,
  );
  const oversized = request(update);
  oversized.headers.set("content-length", "2049");
  assert.equal(
    (await handleProjectAdministration(oversized, env, { id: "admin" }, "p")).status,
    413,
  );
});

test("project settings preserve exact revision conflicts, no-ops, D1 evidence, and race fences", async () => {
  const { db, env } = fixture();
  const stale = await handleProjectAdministration(
    request({ ...update, expectedRevision: 2 }),
    env,
    { id: "admin" },
    "p",
  );
  assert.equal(stale.status, 409);
  assert.equal((await body(stale)).currentRevision, 1);
  assert.equal(db.events.length, 0);

  const noOp = await handleProjectAdministration(
    request({
      name: " Payments ",
      slug: "payments",
      description: " Money flows ",
      expectedRevision: 1,
    }),
    env,
    { id: "admin" },
    "p",
  );
  assert.equal(noOp.status, 200);
  assert.equal((await body(noOp)).unchanged, true);
  assert.equal(db.projects[0]!.settings_revision, 1);
  assert.equal(db.events.length, 0);

  const changed = await handleProjectAdministration(request(update), env, { id: "admin" }, "p");
  assert.equal(changed.status, 200);
  assert.equal((await body(changed)).project.settings_revision, 2);
  assert.equal(db.events[0]!.actor_user_id, "admin");
  assert.equal(db.events[0]!.project_id, "p");
  assert.equal(db.events[0]!.created_at, "D1_TIME");
  assert.ok((db.events[0]!.before_metadata as string).length < 4096);
  assert.ok(!(db.events[0]!.after_metadata as string).includes("repositoryId"));

  const repeated = await handleProjectAdministration(request(update), env, { id: "admin" }, "p");
  assert.equal(repeated.status, 409);
  assert.equal(db.events.length, 1);

  const raced = fixture();
  raced.db.beforeUpdate = () => {
    raced.db.members.find((member) => member.user_id === "admin")!.role = "EDITOR";
  };
  const raceResponse = await handleProjectAdministration(
    request(update),
    raced.env,
    { id: "admin" },
    "p",
  );
  assert.equal(raceResponse.status, 409);
  assert.equal(raced.db.projects[0]!.settings_revision, 1);
  assert.equal(raced.db.events.length, 0);
});

test("project settings return the committed transition without a post-commit read", async () => {
  const { db, env } = fixture();
  db.afterUpdate = () => {
    db.members = db.members.filter(
      (member) => !(member.project_id === "p" && member.user_id === "admin"),
    );
    const project = db.projects[0]!;
    project.name = "Subsequent writer";
    project.slug = "subsequent-writer";
    project.description = null;
    project.settings_revision = 3;
  };

  const response = await handleProjectAdministration(request(update), env, { id: "admin" }, "p");
  assert.equal(response.status, 200);
  assert.deepEqual((await body(response)).project, {
    id: "p",
    workspace_id: "w",
    name: "Payments Platform",
    slug: "payments-platform",
    description: "Bounded payment context",
    status: "ACTIVE",
    role: "ADMIN",
    settings_revision: 2,
    member_count: 3,
    artifact_count: 0,
  });
});

test("project settings map only known D1 conflicts", async () => {
  for (const message of [
    "D1_ERROR: UNIQUE constraint failed: projects.workspace_id, projects.slug",
    "D1_ERROR: invalid project settings transition: SQLITE_CONSTRAINT",
  ]) {
    const { db, env } = fixture();
    db.updateError = new Error(message);
    const response = await handleProjectAdministration(request(update), env, { id: "admin" }, "p");
    assert.equal(response.status, 409);
    assert.equal((await body(response)).currentRevision, 1);
  }

  const { db, env } = fixture();
  db.updateError = new Error("NOT NULL constraint failed: private.secret");
  await assert.rejects(
    handleProjectAdministration(request(update), env, { id: "admin" }, "p"),
    /private\.secret/,
  );
});
