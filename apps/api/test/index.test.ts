/* biome-ignore-all lint/style/noNonNullAssertion: Assertions establish fixture presence. */
/* biome-ignore-all lint/suspicious/noExplicitAny: Tests inspect several JSON response shapes. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { app, createApp, type Env, normalizeGithubRepository } from "../src/index.js";
import { SESSION_COOKIE, sha256 } from "../src/security.js";

type Row = Record<string, unknown>;

class FakeStatement {
  args: unknown[] = [];
  constructor(
    private db: FakeD1,
    private sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.args) as T | null;
  }
  async run(): Promise<D1Result> {
    const changes = this.db.run(this.sql, this.args);
    return { success: true, meta: { changes } } as D1Result;
  }
  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.db.all(this.sql, this.args) as T[],
      meta: {},
    } as D1Result<T>;
  }
}

class FakeD1 {
  healthy = true;
  oauthStates = new Map<string, string>();
  users: Row[] = [];
  sessions: Row[] = [];
  workspaces: Row[] = [];
  workspaceMembers: Row[] = [];
  projects: Row[] = [];
  projectMembers: Row[] = [];
  artifacts: Row[] = [];
  repositories: Row[] = [];
  projectRepositories: Row[] = [];
  gitConnections: Row[] = [];
  gitAuditEvents: Row[] = [];
  githubConnectionStates: Row[] = [];
  beforeMutation?: (sql: string) => void;
  projectUpdateError?: Error;
  failAuditInsert = false;

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
  async batch(statements: FakeStatement[]) {
    const snapshot = structuredClone({
      repositories: this.repositories,
      projectRepositories: this.projectRepositories,
      gitConnections: this.gitConnections,
      gitAuditEvents: this.gitAuditEvents,
      githubConnectionStates: this.githubConnectionStates,
    });
    try {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }
  private has(sql: string, text: string) {
    return sql.replace(/\s+/g, " ").includes(text);
  }
  first(sql: string, args: unknown[]): Row | null {
    if (this.has(sql, "SELECT 1 AS ok")) return this.healthy ? { ok: 1 } : null;
    if (this.has(sql, "INSERT INTO oauth_states")) {
      if (this.oauthStates.size >= (args[3] as number)) return null;
      this.oauthStates.set(args[0] as string, args[1] as string);
      return { state_hash: args[0] };
    }
    if (this.has(sql, "INSERT INTO github_connection_states")) {
      if (this.githubConnectionStates.length >= (args[10] as number)) return null;
      this.githubConnectionStates.push({
        state_hash: args[0],
        kind: "INSTALL",
        user_id: args[1],
        session_id: args[2],
        project_id: args[3],
        canonical_url: args[4],
        owner: args[5],
        repository_name: args[6],
        expires_at: args[7],
        consumed_at: null,
      });
      return { state_hash: args[0] };
    }
    if (this.has(sql, "DELETE FROM oauth_states")) {
      const hash = args[0] as string;
      const now = args[1] as string;
      const expiry = this.oauthStates.get(hash);
      if (!expiry || expiry <= now) return null;
      this.oauthStates.delete(hash);
      return { state_hash: hash };
    }
    if (this.has(sql, "FROM sessions s JOIN users u")) {
      const hash = args[0] as string;
      const now = args[1] as string;
      const session = this.sessions.find(
        (row) => row.token_hash === hash && (row.expires_at as string) > now,
      );
      const user = session && this.users.find((row) => row.id === session.user_id);
      return user
        ? {
            ...pick(user, ["id", "username", "display_name", "avatar_url"]),
            session_id: session.id,
          }
        : null;
    }
    if (this.has(sql, "SELECT id FROM users")) {
      const user = this.users.find(
        (row) => row.provider === args[0] && row.provider_user_id === args[1],
      );
      return user ? { id: user.id } : null;
    }
    if (this.has(sql, "SELECT role FROM workspace_members")) {
      const member = this.workspaceMembers.find(
        (row) => row.workspace_id === args[0] && row.user_id === args[1],
      );
      return member ? { role: member.role } : null;
    }
    if (this.has(sql, "SELECT role FROM project_members")) {
      const member = this.projectMembers.find(
        (row) => row.project_id === args[0] && row.user_id === args[1],
      );
      return member ? { role: member.role } : null;
    }
    if (this.has(sql, "SELECT project_id FROM git_connections")) {
      return (
        this.gitConnections.find(
          (row) =>
            row.project_id === args[0] &&
            (!this.has(sql, "connection_id = ?") || row.connection_id === args[1]),
        ) ?? null
      );
    }
    if (
      this.has(sql, "UPDATE github_connection_states SET") &&
      this.has(sql, "SET state_hash = ?")
    ) {
      const row = this.githubConnectionStates.find(
        (item) =>
          item.state_hash === args[4] &&
          item.kind === "INSTALL" &&
          item.user_id === args[5] &&
          item.session_id === args[6] &&
          item.consumed_at === null &&
          (item.expires_at as string) > (args[7] as string),
      );
      if (!row) return null;
      Object.assign(row, {
        state_hash: args[0],
        kind: "AUTHORIZE",
        installation_id: args[1],
        verifier_hash: args[2],
        expires_at: args[3],
      });
      return { project_id: row.project_id };
    }
    if (this.has(sql, "UPDATE github_connection_states SET consumed_at")) {
      const row = this.githubConnectionStates.find(
        (item) =>
          item.state_hash === args[1] &&
          item.kind === "AUTHORIZE" &&
          item.user_id === args[2] &&
          item.session_id === args[3] &&
          item.verifier_hash === args[4] &&
          item.consumed_at === null &&
          (item.expires_at as string) > (args[5] as string),
      );
      if (!row) return null;
      row.consumed_at = args[0];
      return row;
    }
    if (this.has(sql, "SELECT provider_user_id FROM users")) {
      const user = this.users.find((row) => row.id === args[0] && row.provider === "github");
      return user ? { provider_user_id: user.provider_user_id } : null;
    }
    if (this.has(sql, "SELECT id FROM repository_identities")) {
      const repository = this.repositories.find(
        (row) => row.provider === "github" && row.canonical_url === args[0],
      );
      return repository ? { id: repository.id } : null;
    }
    if (this.has(sql, "FROM git_connections gc JOIN repository_identities ri")) {
      const connection = this.gitConnections.find((row) => row.project_id === args[0]);
      const repository =
        connection && this.repositories.find((row) => row.id === connection.repository_identity_id);
      if (!connection || !repository) return null;
      if (this.has(sql, "SELECT gc.provider, ri.canonical_url")) {
        return {
          provider: connection.provider,
          canonical_url: repository.canonical_url,
          owner: repository.owner,
          repository_name: repository.repository_name,
          default_branch: connection.default_branch,
          last_known_commit_sha: connection.last_known_commit_sha,
          provider_repository_id: connection.provider_repository_id,
          status: connection.status,
          verified_at: connection.verified_at,
          created_at: connection.created_at,
          updated_at: connection.updated_at,
        };
      }
      return {
        connection_id: connection.connection_id ?? null,
        repository_identity_id: connection.repository_identity_id,
        installation_id: connection.installation_id,
        provider_repository_id: connection.provider_repository_id,
        canonical_url: repository.canonical_url,
        owner: repository.owner,
        repository_name: repository.repository_name,
        default_branch: connection.default_branch,
        last_known_commit_sha: connection.last_known_commit_sha,
        status: connection.status,
        verified_at: connection.verified_at,
        updated_at: connection.updated_at,
      };
    }
    if (this.has(sql, "UPDATE projects SET name=?")) {
      if (this.projectUpdateError) throw this.projectUpdateError;
      const project = this.projects.find(
        (row) =>
          row.id === args[4] &&
          row.status === "ACTIVE" &&
          (row.settings_revision ?? 1) === args[5] &&
          this.projectMembers.some(
            (member) =>
              member.project_id === row.id && member.user_id === args[6] && member.role === "ADMIN",
          ),
      );
      if (!project) return null;
      project.name = args[0];
      project.slug = args[1];
      project.description = args[2];
      project.settings_revision = Number(project.settings_revision ?? 1) + 1;
      return {
        name: project.name,
        slug: project.slug,
        description: project.description,
        settings_revision: project.settings_revision,
      };
    }
    if (this.has(sql, "SELECT p.id,p.workspace_id,p.name,p.slug,p.description")) {
      const project = this.projects.find((row) => row.id === args[0] && row.status === "ACTIVE");
      const member = this.projectMembers.find(
        (row) => row.project_id === args[0] && row.user_id === args[1],
      );
      return project && member
        ? {
            ...project,
            settings_revision: project.settings_revision ?? 1,
            role: member.role,
            member_count: this.projectMembers.filter((item) => item.project_id === project.id)
              .length,
            artifact_count: this.artifacts.filter(
              (item) => item.project_id === project.id && item.status === "ACTIVE",
            ).length,
          }
        : null;
    }
    if (
      this.has(sql, "FROM projects p JOIN project_members pm") &&
      this.has(sql, "WHERE p.id = ?")
    ) {
      const project = this.projects.find((row) => row.id === args[0]);
      const member = this.projectMembers.find(
        (row) => row.project_id === args[0] && row.user_id === args[1],
      );
      return project && member
        ? {
            ...project,
            role: member.role,
            member_count: this.projectMembers.filter((item) => item.project_id === project.id)
              .length,
            artifact_count: this.artifacts.filter((item) => item.project_id === project.id).length,
          }
        : null;
    }
    throw new Error(`Unhandled first: ${sql}`);
  }
  run(sql: string, args: unknown[]): number {
    const hook = this.beforeMutation;
    if (hook) {
      this.beforeMutation = undefined;
      hook(sql);
    }
    const before = JSON.stringify({
      states: this.githubConnectionStates,
      links: this.projectRepositories,
      connections: this.gitConnections,
      audits: this.gitAuditEvents,
    });
    if (this.has(sql, "DELETE FROM oauth_states WHERE expires_at <=")) {
      for (const [hash, expiry] of this.oauthStates) {
        if (expiry <= (args[0] as string)) this.oauthStates.delete(hash);
      }
    } else if (this.has(sql, "INSERT INTO users")) {
      const existing = this.users.find(
        (row) => row.provider === args[1] && row.provider_user_id === args[2],
      );
      const values = {
        id: args[0],
        provider: args[1],
        provider_user_id: args[2],
        username: args[3],
        display_name: args[4],
        avatar_url: args[5],
        last_login_at: args[6],
      };
      if (existing) Object.assign(existing, { ...values, id: existing.id });
      else this.users.push(values);
    } else if (this.has(sql, "INSERT INTO sessions")) {
      this.sessions.push({
        id: args[0],
        user_id: args[1],
        token_hash: args[2],
        expires_at: args[3],
      });
    } else if (this.has(sql, "DELETE FROM sessions")) {
      this.sessions = this.sessions.filter((row) => row.token_hash !== args[0]);
    } else if (this.has(sql, "INSERT INTO workspaces")) {
      if (this.workspaces.some((workspace) => workspace.slug === args[2])) {
        throw new Error("UNIQUE constraint failed: workspaces.slug");
      }
      this.workspaces.push({
        id: args[0],
        name: args[1],
        slug: args[2],
        created_by: args[3],
        created_at: new Date().toISOString(),
      });
    } else if (this.has(sql, "INSERT INTO workspace_members")) {
      this.workspaceMembers.push({ workspace_id: args[0], user_id: args[1], role: "ADMIN" });
    } else if (this.has(sql, "INSERT INTO projects")) {
      if (
        this.projects.some(
          (project) => project.workspace_id === args[1] && project.slug === args[3],
        )
      ) {
        throw new Error("UNIQUE constraint failed: projects.workspace_id, projects.slug");
      }
      this.projects.push({
        id: args[0],
        workspace_id: args[1],
        name: args[2],
        slug: args[3],
        description: args[4],
        created_by: args[5],
        status: "ACTIVE",
        settings_revision: 1,
        created_at: new Date().toISOString(),
      });
    } else if (this.has(sql, "INSERT INTO project_members")) {
      this.projectMembers.push({ project_id: args[0], user_id: args[1], role: "ADMIN" });
    } else if (this.has(sql, "DELETE FROM github_connection_states WHERE expires_at")) {
      this.githubConnectionStates = this.githubConnectionStates.filter(
        (row) => (row.expires_at as string) > (args[0] as string),
      );
    } else if (this.has(sql, "INSERT INTO github_connection_states")) {
      this.githubConnectionStates.push({
        state_hash: args[0],
        kind: "INSTALL",
        user_id: args[1],
        session_id: args[2],
        project_id: args[3],
        canonical_url: args[4],
        owner: args[5],
        repository_name: args[6],
        expires_at: args[7],
        consumed_at: null,
      });
    } else if (this.has(sql, "INSERT INTO repository_identities")) {
      const conditional = this.has(sql, "project_members");
      const state = conditional
        ? this.githubConnectionStates.find(
            (row) =>
              row.state_hash === args[4] &&
              row.user_id === args[5] &&
              row.session_id === args[6] &&
              row.project_id === args[7] &&
              row.consumed_at !== null &&
              (row.expires_at as string) > (args[8] as string),
          )
        : true;
      const admin = conditional
        ? this.projectMembers.some(
            (row) => row.project_id === args[9] && row.user_id === args[10] && row.role === "ADMIN",
          )
        : true;
      const unconnected = !this.gitConnections.some((row) => row.project_id === args[11]);
      if (
        state &&
        admin &&
        unconnected &&
        !this.repositories.some((row) => row.canonical_url === args[1])
      ) {
        this.repositories.push({
          id: args[0],
          provider: "github",
          canonical_url: args[1],
          owner: args[2],
          repository_name: args[3],
        });
      }
    } else if (this.has(sql, "INSERT INTO git_connections")) {
      const repository = this.repositories.find((row) => row.canonical_url === args[9]);
      const validState = this.githubConnectionStates.some(
        (row) =>
          row.state_hash === args[10] &&
          row.user_id === args[11] &&
          row.session_id === args[12] &&
          row.project_id === args[13] &&
          row.consumed_at !== null &&
          (row.expires_at as string) > (args[14] as string),
      );
      const admin = this.projectMembers.some(
        (row) => row.project_id === args[15] && row.user_id === args[16] && row.role === "ADMIN",
      );
      if (
        repository &&
        validState &&
        admin &&
        !this.gitConnections.some((row) => row.project_id === args[17])
      ) {
        this.gitConnections.push({
          connection_id: args[0],
          project_id: args[1],
          repository_identity_id: repository.id,
          provider: "github",
          installation_id: args[2],
          provider_repository_id: args[3],
          default_branch: args[4],
          last_known_commit_sha: args[5],
          status: "VERIFIED",
          verified_at: args[6],
          created_at: args[7],
          updated_at: args[8],
        });
      }
    } else if (this.has(sql, "INSERT INTO project_repositories")) {
      const connection = this.gitConnections.find(
        (row) => row.project_id === args[0] && row.connection_id === args[1],
      );
      if (connection) {
        this.projectRepositories.push({
          project_id: connection.project_id,
          repository_identity_id: connection.repository_identity_id,
        });
      }
    } else if (this.has(sql, "UPDATE git_connections SET")) {
      const connection = this.gitConnections.find(
        (row) =>
          row.project_id === args[4] &&
          (row.connection_id ?? null) === args[5] &&
          row.repository_identity_id === args[6] &&
          row.installation_id === args[7] &&
          row.provider_repository_id === args[8] &&
          row.default_branch === args[9] &&
          row.last_known_commit_sha === args[10] &&
          row.status === args[11] &&
          row.verified_at === args[12] &&
          row.updated_at === args[13] &&
          this.projectMembers.some(
            (member) =>
              member.project_id === args[14] &&
              member.user_id === args[15] &&
              member.role === "ADMIN",
          ),
      );
      if (connection) {
        Object.assign(connection, {
          default_branch: args[0],
          last_known_commit_sha: args[1],
          status: "VERIFIED",
          verified_at: args[2],
          updated_at: args[3],
        });
      }
    } else if (this.has(sql, "DELETE FROM project_repositories")) {
      const admin = this.projectMembers.some(
        (row) => row.project_id === args[2] && row.user_id === args[3] && row.role === "ADMIN",
      );
      const exact = this.gitConnections.some(
        (row) =>
          row.project_id === args[4] &&
          (row.connection_id ?? null) === args[5] &&
          row.repository_identity_id === args[6] &&
          row.installation_id === args[7] &&
          row.provider_repository_id === args[8],
      );
      if (admin && exact) {
        this.projectRepositories = this.projectRepositories.filter(
          (row) => row.project_id !== args[0] || row.repository_identity_id !== args[1],
        );
      }
    } else if (this.has(sql, "DELETE FROM git_connections")) {
      const admin = this.projectMembers.some(
        (row) => row.project_id === args[5] && row.user_id === args[6] && row.role === "ADMIN",
      );
      const audited =
        !this.has(sql, "git_audit_events") ||
        this.gitAuditEvents.some((row) => row.id === args[7] && row.project_id === args[8]);
      if (admin && audited) {
        this.gitConnections = this.gitConnections.filter(
          (row) =>
            !(
              row.project_id === args[0] &&
              (row.connection_id ?? null) === args[1] &&
              row.repository_identity_id === args[2] &&
              row.installation_id === args[3] &&
              row.provider_repository_id === args[4]
            ),
        );
      }
    } else if (this.has(sql, "INSERT INTO git_audit_events")) {
      if (this.failAuditInsert) throw new Error("injected audit failure");
      let allowed = true;
      let projectId = args[1];
      let repositoryId = args[2];
      let actorId = args[3];
      let metadata: unknown = this.has(sql, "'git-disconnected'") ? "{}" : (args[4] ?? "{}");
      if (this.has(sql, "'git-connected'")) {
        projectId = this.gitConnections.find(
          (row) => row.project_id === args[3] && row.connection_id === args[4],
        )?.project_id;
        repositoryId = this.gitConnections.find(
          (row) => row.project_id === args[3] && row.connection_id === args[4],
        )?.repository_identity_id;
        actorId = args[1];
        metadata = args[2];
        allowed = Boolean(projectId);
      } else {
        const adminOffset = this.has(sql, "'git-synced'") ? 5 : 4;
        const exactOffset = adminOffset + 2;
        allowed =
          this.projectMembers.some(
            (row) =>
              row.project_id === args[adminOffset] &&
              row.user_id === args[adminOffset + 1] &&
              row.role === "ADMIN",
          ) &&
          this.gitConnections.some(
            (row) =>
              row.project_id === args[exactOffset] &&
              (row.connection_id ?? null) === args[exactOffset + 1] &&
              row.repository_identity_id === args[exactOffset + 2] &&
              row.installation_id === args[exactOffset + 3] &&
              row.provider_repository_id === args[exactOffset + 4] &&
              (!this.has(sql, "'git-synced'") ||
                (row.default_branch === args[exactOffset + 5] &&
                  row.last_known_commit_sha === args[exactOffset + 6] &&
                  row.status === "VERIFIED" &&
                  row.verified_at === args[exactOffset + 7] &&
                  row.updated_at === args[exactOffset + 8])),
          );
      }
      if (allowed) {
        this.gitAuditEvents.push({
          id: args[0],
          project_id: projectId,
          repository_identity_id: repositoryId,
          event_type: this.has(sql, "'git-connected'")
            ? "git-connected"
            : this.has(sql, "'git-synced'")
              ? "git-synced"
              : "git-disconnected",
          actor_id: actorId,
          metadata,
        });
      }
    } else if (this.has(sql, "DELETE FROM github_connection_states WHERE project_id")) {
      const allowed = this.has(sql, "git_audit_events")
        ? this.gitAuditEvents.some((row) => row.id === args[1] && row.project_id === args[2])
        : this.gitConnections.some(
            (row) => row.project_id === args[1] && row.connection_id === args[2],
          );
      if (allowed) {
        this.githubConnectionStates = this.githubConnectionStates.filter(
          (row) => row.project_id !== args[0],
        );
      }
    } else throw new Error(`Unhandled run: ${sql}`);
    const after = JSON.stringify({
      states: this.githubConnectionStates,
      links: this.projectRepositories,
      connections: this.gitConnections,
      audits: this.gitAuditEvents,
    });
    return before === after ? 0 : 1;
  }
  all(sql: string, args: unknown[]): Row[] {
    if (this.has(sql, "FROM workspaces w JOIN workspace_members")) {
      return this.workspaceMembers
        .filter((member) => member.user_id === args[0])
        .map((member) => ({
          ...this.workspaces.find((workspace) => workspace.id === member.workspace_id),
          role: member.role,
        }));
    }
    if (this.has(sql, "FROM repository_identities ri")) {
      const [userId, canonical] = args;
      const repositoryIds = this.repositories
        .filter((repo) => repo.provider === "github" && repo.canonical_url === canonical)
        .map((repo) => repo.id);
      return this.projectRepositories
        .filter(
          (link) =>
            repositoryIds.includes(link.repository_identity_id) &&
            this.gitConnections.some(
              (connection) =>
                connection.project_id === link.project_id &&
                connection.repository_identity_id === link.repository_identity_id &&
                connection.provider === "github" &&
                connection.status === "VERIFIED",
            ),
        )
        .flatMap((link) => {
          const member = this.projectMembers.find(
            (item) => item.project_id === link.project_id && item.user_id === userId,
          );
          const project = this.projects.find((item) => item.id === link.project_id);
          return member && project
            ? [
                {
                  ...project,
                  role: member.role,
                  member_count: this.projectMembers.filter((item) => item.project_id === project.id)
                    .length,
                  artifact_count: this.artifacts.filter((item) => item.project_id === project.id)
                    .length,
                },
              ]
            : [];
        });
    }
    if (this.has(sql, "FROM projects p JOIN project_members pm")) {
      return this.projectMembers
        .filter((member) => member.user_id === args[0])
        .flatMap((member) => {
          const project = this.projects.find((item) => item.id === member.project_id);
          return project
            ? [
                {
                  ...project,
                  role: member.role,
                  member_count: this.projectMembers.filter((item) => item.project_id === project.id)
                    .length,
                  artifact_count: this.artifacts.filter((item) => item.project_id === project.id)
                    .length,
                },
              ]
            : [];
        });
    }
    throw new Error(`Unhandled all: ${sql}`);
  }
}

function pick(row: Row, keys: string[]): Row {
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

function bindings(db = new FakeD1(), production = false): Env {
  return {
    DB: db as unknown as D1Database,
    OBJECTS: { head: async () => null } as unknown as R2Bucket,
    APP_ENV: production ? "production" : "test",
    WEB_ORIGIN: "https://app.example",
    API_ORIGIN: "https://api.example",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_SLUG: "context-hub-test",
    GITHUB_APP_CLIENT_ID: "app-client-id",
    GITHUB_APP_CLIENT_SECRET: "app-client-secret",
    GITHUB_APP_PRIVATE_KEY: "unused-in-installation-url",
  };
}

async function addUserSession(
  db: FakeD1,
  userId: string,
  token: string,
  expires = Date.now() + 60_000,
) {
  db.users.push({
    id: userId,
    provider: "github",
    provider_user_id: userId,
    username: userId,
    display_name: null,
    avatar_url: null,
  });
  db.sessions.push({
    id: `s-${userId}-${token}`,
    user_id: userId,
    token_hash: await sha256(token),
    expires_at: new Date(expires).toISOString(),
  });
}

function request(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (token) headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("origin")) {
    headers.set("origin", "https://app.example");
  }
  return new Request(`https://api.example${path}`, { ...init, headers });
}

async function body(response: Response): Promise<any> {
  return response.json();
}

async function githubAppPrivateKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

async function login(db: FakeD1, production = true) {
  const outbound: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("access_token")) return Response.json({ access_token: "github-secret-token" });
    return Response.json({
      id: 42,
      login: "octocat",
      name: "Octo Cat",
      avatar_url: "https://avatars.example/42",
    });
  };
  const oauthApp = createApp(outbound);
  const env = bindings(db, production);
  const start = await oauthApp.fetch(request("/auth/github"), env);
  const location = new URL(start.headers.get("location")!);
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "https://api.example/auth/github/callback",
  );
  const state = location.searchParams.get("state")!;
  const stateCookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
  const callback = await oauthApp.fetch(
    request(`/auth/github/callback?code=code&state=${state}`, undefined, {
      headers: { cookie: stateCookie },
    }),
    env,
  );
  return { oauthApp, env, callback, state, stateCookie };
}

describe("API foundation and CORS", () => {
  it("reports healthy bindings and hides failures", async () => {
    const db = new FakeD1();
    assert.equal((await app.fetch(request("/api/health"), bindings(db))).status, 200);
    db.healthy = false;
    const unavailable = await app.fetch(request("/api/health"), bindings(db));
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await body(unavailable), {
      service: "context-hub-api",
      status: "unavailable",
    });
  });

  it("requires an exact configured callback origin and HTTPS in production", async () => {
    const invalidOrigins = [
      undefined,
      "not-a-url",
      "https://user:pass@api.example",
      "https://api.example/path",
      "https://api.example?query=1",
      "https://api.example#hash",
      "https://api.example/",
    ];
    for (const configured of invalidOrigins) {
      const env = bindings();
      env.API_ORIGIN = configured;
      const response = await app.fetch(new Request("https://attacker.example/auth/github"), env);
      assert.equal(response.status, 503, String(configured));
    }
    const production = bindings(new FakeD1(), true);
    production.API_ORIGIN = "http://api.example";
    assert.equal((await app.fetch(request("/auth/github"), production)).status, 503);
    const local = bindings();
    local.API_ORIGIN = "http://localhost:8787";
    const started = await app.fetch(request("/auth/github"), local);
    assert.equal(started.status, 302);
    assert.equal(
      new URL(started.headers.get("location") ?? "").searchParams.get("redirect_uri"),
      "http://localhost:8787/auth/github/callback",
    );
  });

  it("applies security headers to every Worker response and HSTS only in production", async () => {
    for (const production of [false, true]) {
      const response = await app.fetch(request("/missing"), bindings(new FakeD1(), production));
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.match(response.headers.get("permissions-policy") ?? "", /camera=\(\)/);
      assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
      assert.equal(
        response.headers.has("strict-transport-security"),
        production,
        "HSTS must not affect local HTTP development",
      );
    }
  });

  it("rejects workspace and project bodies before buffering beyond two KiB", async () => {
    const db = new FakeD1();
    await addUserSession(db, "u", "token");
    const oversized = JSON.stringify({ name: "x".repeat(2049), slug: "safe" });
    const response = await app.fetch(
      request("/workspaces", "token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversized,
      }),
      bindings(db),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await body(response), { error: "INVALID_INPUT" });
    assert.equal(db.workspaces.length, 0);
  });

  it("supports exact-origin credentialed preflights and rejects hostile mutations", async () => {
    const env = bindings();
    const preflight = await app.fetch(
      request("/workspaces", undefined, {
        method: "OPTIONS",
        headers: { origin: env.WEB_ORIGIN! },
      }),
      env,
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
    const hostile = await app.fetch(
      request("/auth/logout", undefined, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
      env,
    );
    assert.equal(hostile.status, 403);
    assert.equal(hostile.headers.get("access-control-allow-origin"), null);
    const originless = await app.fetch(
      new Request("https://api.example/auth/logout", { method: "POST" }),
      env,
    );
    assert.equal(originless.status, 403);
  });
});

describe("GitHub OAuth and sessions", () => {
  it("rejects mismatched state, consumes valid state once, upserts, and stores only a session hash", async () => {
    const db = new FakeD1();
    db.oauthStates.set("abandoned", new Date(0).toISOString());
    const { oauthApp, env, callback, state, stateCookie } = await login(db);
    assert.equal(callback.status, 302);
    assert.equal(db.oauthStates.size, 0);
    assert.equal(db.users.length, 1);
    assert.equal(db.sessions.length, 1);
    const setCookie = callback.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=None/);
    assert.match(setCookie, /Secure/);
    const rawSession = /context_hub_session=([^;,]+)/.exec(setCookie)?.[1];
    assert.ok(rawSession);
    assert.notEqual(db.sessions[0]!.token_hash, rawSession);
    assert.equal(db.sessions[0]!.token_hash, await sha256(decodeURIComponent(rawSession)));
    assert.equal(JSON.stringify(db).includes("github-secret-token"), false);
    assert.equal((await callback.text()).includes("github-secret-token"), false);

    await login(db);
    assert.equal(db.users.length, 1, "the provider identity is upserted rather than duplicated");

    const replay = await oauthApp.fetch(
      request(`/auth/github/callback?code=again&state=${state}`, undefined, {
        headers: { cookie: stateCookie },
      }),
      env,
    );
    assert.equal(replay.status, 400);
    assert.deepEqual(await body(replay), { error: "INVALID_OAUTH_STATE" });

    const mismatch = await oauthApp.fetch(
      request("/auth/github/callback?code=x&state=wrong", undefined, {
        headers: { cookie: stateCookie },
      }),
      env,
    );
    assert.equal(mismatch.status, 400);

    const expiredStart = await oauthApp.fetch(request("/auth/github"), env);
    const expiredLocation = new URL(expiredStart.headers.get("location")!);
    const expiredState = expiredLocation.searchParams.get("state")!;
    const expiredCookie = expiredStart.headers.get("set-cookie")!.split(";", 1)[0]!;
    for (const hash of db.oauthStates.keys()) db.oauthStates.set(hash, new Date(0).toISOString());
    const expired = await oauthApp.fetch(
      request(`/auth/github/callback?code=x&state=${expiredState}`, undefined, {
        headers: { cookie: expiredCookie },
      }),
      env,
    );
    assert.equal(expired.status, 400);
    assert.deepEqual(await body(expired), { error: "INVALID_OAUTH_STATE" });
  });

  it("preserves auth configuration, provider, and unexpected failure boundaries", async () => {
    const unavailable = bindings();
    delete unavailable.GITHUB_CLIENT_ID;
    assert.equal((await app.fetch(request("/auth/github"), unavailable)).status, 503);

    const callbackWith = async (outbound: typeof fetch) => {
      const db = new FakeD1();
      const env = bindings(db);
      const oauthApp = createApp(outbound);
      const start = await oauthApp.fetch(request("/auth/github"), env);
      const location = new URL(start.headers.get("location")!);
      const state = location.searchParams.get("state")!;
      const stateCookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
      return oauthApp.fetch(
        request(`/auth/github/callback?code=code&state=${state}`, undefined, {
          headers: { cookie: stateCookie },
        }),
        env,
      );
    };

    const providerFailure = await callbackWith(async () => new Response(null, { status: 503 }));
    assert.equal(providerFailure.status, 502);
    assert.deepEqual(await body(providerFailure), { error: "AUTH_FAILED" });

    const malformed = await callbackWith(
      async () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    );
    assert.equal(malformed.status, 502);
    assert.deepEqual(await body(malformed), { error: "AUTH_FAILED" });

    const network = await callbackWith(async () => {
      throw new Error("network failed with provider detail");
    });
    assert.equal(network.status, 502);
    assert.deepEqual(await body(network), { error: "AUTH_FAILED" });

    const streamFailure = await callbackWith(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("uncontrolled provider stream detail"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    assert.equal(streamFailure.status, 502);
    assert.deepEqual(await body(streamFailure), { error: "AUTH_FAILED" });
  });

  it("rejects missing, invalid, and expired sessions, then logout invalidates a valid session", async () => {
    const db = new FakeD1();
    await addUserSession(db, "active", "valid");
    await addUserSession(db, "expired", "old", Date.now() - 1_000);
    const env = bindings(db);
    for (const token of [undefined, "invalid", "old"]) {
      assert.equal((await app.fetch(request("/auth/session", token), env)).status, 401);
    }
    assert.equal((await app.fetch(request("/auth/session", "valid"), env)).status, 200);
    const logout = await app.fetch(request("/auth/logout", "valid", { method: "POST" }), env);
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await app.fetch(request("/auth/session", "valid"), env)).status, 401);
  });
});

describe("workspaces and project authorization", () => {
  it("creates and lists multiple workspaces/projects with creator ADMIN", async () => {
    const db = new FakeD1();
    await addUserSession(db, "u1", "token");
    const env = bindings(db);
    for (const [name, slug] of [
      ["One", "one"],
      ["Two", "two"],
    ]) {
      const created = await app.fetch(
        request("/workspaces", "token", { method: "POST", body: JSON.stringify({ name, slug }) }),
        env,
      );
      assert.equal(created.status, 201);
    }
    assert.equal(db.workspaceMembers.length, 2);
    assert.ok(db.workspaceMembers.every((member) => member.role === "ADMIN"));
    const workspaceList = await body(await app.fetch(request("/workspaces", "token"), env));
    assert.equal(workspaceList.workspaces.length, 2);

    for (const [index, workspace] of db.workspaces.entries()) {
      const created = await app.fetch(
        request("/projects", "token", {
          method: "POST",
          body: JSON.stringify({
            workspaceId: workspace.id,
            name: `Project ${index}`,
            slug: `project-${index}`,
            description: "Description",
          }),
        }),
        env,
      );
      assert.equal(created.status, 201);
      const createdProject = (await body(created)).project;
      assert.equal(createdProject.role, "ADMIN");
      assert.equal(createdProject.member_count, 1);
      assert.equal(createdProject.artifact_count, 0);
    }
    db.artifacts.push({ id: "artifact-1", project_id: db.projects[0]!.id });
    const listedProjects = (await body(await app.fetch(request("/projects", "token"), env)))
      .projects;
    assert.equal(listedProjects.length, 2);
    assert.equal(listedProjects[0].artifact_count, 1);
    const detail = await body(
      await app.fetch(request(`/projects/${db.projects[0]!.id}`, "token"), env),
    );
    assert.equal(detail.project.artifact_count, 1);
  });

  it("enforces workspace ADMIN creation and direct project membership without metadata leakage", async () => {
    const db = new FakeD1();
    await addUserSession(db, "admin", "admin-token");
    await addUserSession(db, "outsider", "outsider-token");
    db.workspaces.push({ id: "w", name: "Secret Workspace", slug: "secret", created_by: "admin" });
    db.workspaceMembers.push(
      { workspace_id: "w", user_id: "admin", role: "ADMIN" },
      { workspace_id: "w", user_id: "outsider", role: "VIEWER" },
    );
    db.projects.push({
      id: "p",
      workspace_id: "w",
      name: "Secret Project",
      slug: "secret-project",
      description: "hidden",
      status: "ACTIVE",
    });
    db.projectMembers.push({ project_id: "p", user_id: "admin", role: "VIEWER" });
    const env = bindings(db);
    const deniedCreate = await app.fetch(
      request("/projects", "outsider-token", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "w", name: "No", slug: "no" }),
      }),
      env,
    );
    assert.equal(deniedCreate.status, 404);
    assert.deepEqual(await body(deniedCreate), { error: "NOT_FOUND" });
    const list = await body(await app.fetch(request("/projects", "outsider-token"), env));
    assert.deepEqual(list.projects, []);
    const detail = await app.fetch(request("/projects/p", "outsider-token"), env);
    assert.equal(detail.status, 404);
    assert.equal((await detail.text()).includes("Secret Project"), false);
    assert.equal((await app.fetch(request("/projects/p", "admin-token"), env)).status, 200);
    assert.equal((await app.fetch(request("/projects/%", "admin-token"), env)).status, 400);
  });

  it("routes authenticated project settings PATCH with exact Origin and current ADMIN", async () => {
    const db = new FakeD1();
    await addUserSession(db, "admin", "admin-token");
    await addUserSession(db, "editor", "editor-token");
    db.projects.push({
      id: "p",
      workspace_id: "w",
      name: "Payments",
      slug: "payments",
      description: null,
      status: "ACTIVE",
      settings_revision: 1,
    });
    db.projectMembers.push(
      { project_id: "p", user_id: "admin", role: "ADMIN" },
      { project_id: "p", user_id: "editor", role: "EDITOR" },
    );
    const env = bindings(db);
    const payload = JSON.stringify({
      name: "Payments Platform",
      slug: "payments-platform",
      description: "Payment context",
      expectedRevision: 1,
    });
    assert.equal(
      (await app.fetch(request("/projects/p", undefined, { method: "PATCH", body: payload }), env))
        .status,
      401,
    );
    assert.equal(
      (
        await app.fetch(
          new Request("https://api.example/projects/p", { method: "PATCH", body: payload }),
          env,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await app.fetch(
          request("/projects/p", "admin-token", {
            method: "PATCH",
            headers: { origin: "https://evil.example", "content-type": "application/json" },
            body: payload,
          }),
          env,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await app.fetch(
          request("/projects/p", "editor-token", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: payload,
          }),
          env,
        )
      ).status,
      403,
    );
    const updated = await app.fetch(
      request("/projects/p", "admin-token", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
      env,
    );
    assert.equal(updated.status, 200);
    assert.equal((await body(updated)).project.settings_revision, 2);

    db.projects[0]!.settings_revision = 1;
    db.projects[0]!.name = "Payments";
    db.projects[0]!.slug = "payments";
    db.projects[0]!.description = null;
    db.projectUpdateError = new Error("D1 internal SQL detail: hidden_table");
    const failed = await app.fetch(
      request("/projects/p", "admin-token", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
      env,
    );
    assert.equal(failed.status, 500);
    const failedText = await failed.text();
    assert.deepEqual(JSON.parse(failedText), { error: "INTERNAL_ERROR" });
    assert.equal(failedText.includes("hidden_table"), false);
  });

  it("validates inputs and reports slug conflicts", async () => {
    const db = new FakeD1();
    await addUserSession(db, "u", "t");
    const env = bindings(db);
    const invalid = await app.fetch(
      request("/workspaces", "t", {
        method: "POST",
        body: JSON.stringify({ name: "", slug: "Bad Slug" }),
      }),
      env,
    );
    assert.equal(invalid.status, 400);
    assert.deepEqual(await body(invalid), { error: "INVALID_INPUT" });

    const workspaceBody = JSON.stringify({ name: "One", slug: "one" });
    assert.equal(
      (await app.fetch(request("/workspaces", "t", { method: "POST", body: workspaceBody }), env))
        .status,
      201,
    );
    const duplicateWorkspace = await app.fetch(
      request("/workspaces", "t", { method: "POST", body: workspaceBody }),
      env,
    );
    assert.equal(duplicateWorkspace.status, 409);
    assert.deepEqual(await body(duplicateWorkspace), { error: "CONFLICT" });

    const projectBody = JSON.stringify({
      workspaceId: db.workspaces[0]!.id,
      name: "Project",
      slug: "project",
    });
    assert.equal(
      (await app.fetch(request("/projects", "t", { method: "POST", body: projectBody }), env))
        .status,
      201,
    );
    const duplicateProject = await app.fetch(
      request("/projects", "t", { method: "POST", body: projectBody }),
      env,
    );
    assert.equal(duplicateProject.status, 409);
    assert.deepEqual(await body(duplicateProject), { error: "CONFLICT" });
  });
});

describe("Git repository connection routes", () => {
  it("requires exact Origin, authentication, direct membership, and ADMIN to begin", async () => {
    const db = new FakeD1();
    await addUserSession(db, "admin", "admin-token");
    await addUserSession(db, "editor", "editor-token");
    await addUserSession(db, "outsider", "outsider-token");
    db.projectMembers.push(
      { project_id: "p", user_id: "admin", role: "ADMIN" },
      { project_id: "p", user_id: "editor", role: "EDITOR" },
    );
    const env = bindings(db);
    const payload = JSON.stringify({ repositoryUrl: "https://github.com/Owner/Repo.git" });
    assert.equal(
      (
        await app.fetch(
          new Request("https://api.example/projects/p/git", { method: "POST", body: payload }),
          env,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await app.fetch(
          request("/projects/p/git", undefined, { method: "POST", body: payload }),
          env,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await app.fetch(
          request("/projects/p/git", "outsider-token", { method: "POST", body: payload }),
          env,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await app.fetch(
          request("/projects/p/git", "editor-token", { method: "POST", body: payload }),
          env,
        )
      ).status,
      403,
    );

    const connected = await app.fetch(
      request("/projects/p/git", "admin-token", { method: "POST", body: payload }),
      env,
    );
    assert.equal(connected.status, 201);
    const reply = await body(connected);
    const installation = new URL(reply.installationUrl);
    assert.equal(
      installation.origin + installation.pathname,
      "https://github.com/apps/context-hub-test/installations/new",
    );
    const rawState = installation.searchParams.get("state");
    assert.ok(rawState);
    assert.equal(db.githubConnectionStates.length, 1);
    assert.equal(db.githubConnectionStates[0]!.canonical_url, "github.com/owner/repo");
    assert.equal(JSON.stringify(db).includes(rawState), false);
  });

  it("rejects invalid remotes, duplicate connections, and missing GitHub App configuration", async () => {
    const db = new FakeD1();
    await addUserSession(db, "admin", "token");
    db.projectMembers.push({ project_id: "p", user_id: "admin", role: "ADMIN" });
    const env = bindings(db);
    const invalid = await app.fetch(
      request("/projects/p/git", "token", {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "https://evil.example/o/r" }),
      }),
      env,
    );
    assert.equal(invalid.status, 400);
    db.gitConnections.push({ project_id: "p" });
    const duplicate = await app.fetch(
      request("/projects/p/git", "token", {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "https://github.com/o/r" }),
      }),
      env,
    );
    assert.equal(duplicate.status, 409);
    db.gitConnections = [];
    delete env.GITHUB_APP_PRIVATE_KEY;
    const unavailable = await app.fetch(
      request("/projects/p/git", "token", {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "https://github.com/o/r" }),
      }),
      env,
    );
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await body(unavailable), { error: "GIT_UNAVAILABLE" });
  });

  it("publishes, reads, synchronizes, resolves, and disconnects a proven installation", async () => {
    const db = new FakeD1();
    await addUserSession(db, "admin", "admin-token");
    db.sessions.push({
      id: "s-admin-other",
      user_id: "admin",
      token_hash: await sha256("admin-other-token"),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await addUserSession(db, "viewer", "viewer-token");
    await addUserSession(db, "outsider", "outsider-token");
    db.projects.push({
      id: "p",
      workspace_id: "w",
      name: "Project",
      slug: "project",
      status: "ACTIVE",
    });
    db.projectMembers.push(
      { project_id: "p", user_id: "admin", role: "ADMIN" },
      { project_id: "p", user_id: "viewer", role: "VIEWER" },
    );
    const admin = db.users.find((row) => row.id === "admin");
    if (admin) admin.provider_user_id = "42";
    const env = bindings(db);
    env.GITHUB_APP_PRIVATE_KEY = await githubAppPrivateKey();
    let headSha = "a".repeat(40);
    let repositoryId = 77;
    let providerUserId = 42;
    let failProvider = false;
    const providerCalls: string[] = [];
    const gitApp = createApp(async (input) => {
      const url = String(input);
      providerCalls.push(url);
      if (failProvider) throw new Error("secret provider body");
      if (url.includes("/login/oauth/access_token"))
        return Response.json({ access_token: "user-secret" });
      if (url.endsWith("/user")) return Response.json({ id: providerUserId, login: "admin" });
      if (url.includes("/user/installations/99/repositories"))
        return Response.json({ total_count: 1, repositories: [{ id: 77 }] });
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-secret" });
      if (url.includes("/git/ref/heads/")) return Response.json({ object: { sha: headSha } });
      return Response.json({
        id: repositoryId,
        name: "repo",
        full_name: "owner/repo",
        default_branch: "main",
      });
    });

    const started = await gitApp.fetch(
      request("/projects/p/git", "admin-token", {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "https://github.com/Owner/Repo.git" }),
      }),
      env,
    );
    const installState = new URL((await body(started)).installationUrl).searchParams.get("state");
    assert.ok(installState);
    const wrongSession = await gitApp.fetch(
      request(
        `/auth/github-app/setup?setup_action=install&installation_id=99&state=${installState}`,
        "admin-other-token",
      ),
      env,
    );
    assert.match(wrongSession.headers.get("location") ?? "", /git_error=invalid_state/);

    const setup = await gitApp.fetch(
      request(
        `/auth/github-app/setup?setup_action=install&installation_id=99&state=${installState}`,
        "admin-token",
      ),
      env,
    );
    const authorization = new URL(setup.headers.get("location") ?? "");
    const authorizeState = authorization.searchParams.get("state");
    const pkceCookie = setup.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(authorizeState && pkceCookie);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(JSON.stringify(db).includes(installState), false);
    assert.equal(JSON.stringify(db).includes(pkceCookie.split("=")[1] ?? ""), false);

    const wrongVerifier = await gitApp.fetch(
      request(`/auth/github-app/callback?code=code&state=${authorizeState}`, undefined, {
        headers: { cookie: `${SESSION_COOKIE}=admin-token; context_hub_git_pkce=wrong` },
      }),
      env,
    );
    assert.match(wrongVerifier.headers.get("location") ?? "", /git_error=invalid_state/);

    providerUserId = 43;
    const identityMismatch = await gitApp.fetch(
      request(`/auth/github-app/callback?code=code&state=${authorizeState}`, undefined, {
        headers: { cookie: `${SESSION_COOKIE}=admin-token; ${pkceCookie}` },
      }),
      env,
    );
    assert.match(identityMismatch.headers.get("location") ?? "", /git_error=identity_mismatch/);
    assert.equal(db.gitConnections.length, 0);
    assert.equal(db.projectRepositories.length, 0);
    assert.equal(db.gitAuditEvents.length, 0);

    providerUserId = 42;
    const restarted = await gitApp.fetch(
      request("/projects/p/git", "admin-token", {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: "https://github.com/owner/repo" }),
      }),
      env,
    );
    const restartedInstallState = new URL((await body(restarted)).installationUrl).searchParams.get(
      "state",
    );
    const restartedSetup = await gitApp.fetch(
      request(
        `/auth/github-app/setup?setup_action=install&installation_id=99&state=${restartedInstallState}`,
        "admin-token",
      ),
      env,
    );
    const restartedAuthorization = new URL(restartedSetup.headers.get("location") ?? "");
    const restartedAuthorizeState = restartedAuthorization.searchParams.get("state");
    const restartedPkceCookie = restartedSetup.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(restartedAuthorizeState && restartedPkceCookie);
    const crossSessionCallback = await gitApp.fetch(
      request(`/auth/github-app/callback?code=code&state=${restartedAuthorizeState}`, undefined, {
        headers: { cookie: `${SESSION_COOKIE}=admin-other-token; ${restartedPkceCookie}` },
      }),
      env,
    );
    assert.match(crossSessionCallback.headers.get("location") ?? "", /git_error=invalid_state/);
    assert.equal(db.gitConnections.length, 0);
    const callback = await gitApp.fetch(
      request(`/auth/github-app/callback?code=code&state=${restartedAuthorizeState}`, undefined, {
        headers: { cookie: `${SESSION_COOKIE}=admin-token; ${restartedPkceCookie}` },
      }),
      env,
    );
    assert.match(callback.headers.get("location") ?? "", /git=connected/);
    assert.match(callback.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(db.githubConnectionStates.length, 0);
    assert.equal(db.gitConnections.length, 1);
    assert.equal(db.projectRepositories.length, 1);
    assert.equal(db.gitAuditEvents[0]?.event_type, "git-connected");
    assert.deepEqual(JSON.parse(String(db.gitAuditEvents[0]?.metadata)), {
      defaultBranch: "main",
      commitSha: "a".repeat(40),
    });
    assert.equal(JSON.stringify(db).includes("user-secret"), false);
    assert.equal(JSON.stringify(db).includes("installation-secret"), false);

    const replay = await gitApp.fetch(
      request(`/auth/github-app/callback?code=again&state=${restartedAuthorizeState}`, undefined, {
        headers: { cookie: `${SESSION_COOKIE}=admin-token; ${restartedPkceCookie}` },
      }),
      env,
    );
    assert.match(replay.headers.get("location") ?? "", /git_error=invalid_state/);
    assert.equal(providerCalls.filter((url) => url.includes("access_token")).length, 4);

    const visible = await gitApp.fetch(request("/projects/p/git", "viewer-token"), env);
    assert.equal(visible.status, 200);
    const connection = (await body(visible)).connection;
    assert.equal(connection.canonical_url, "github.com/owner/repo");
    assert.equal(connection.last_known_commit_sha, "a".repeat(40));
    assert.equal(connection.installation_id, undefined);
    assert.equal(
      (await gitApp.fetch(request("/projects/p/git", "outsider-token"), env)).status,
      404,
    );
    assert.equal(
      (await gitApp.fetch(request("/projects/p/git/sync", "viewer-token", { method: "POST" }), env))
        .status,
      403,
    );

    const resolved = await body(
      await gitApp.fetch(
        request("/projects/resolve?repository=git@github.com:owner/repo.git", "viewer-token"),
        env,
      ),
    );
    assert.equal(resolved.match, "unique");
    assert.equal(resolved.project.id, "p");

    headSha = "b".repeat(40);
    const synced = await gitApp.fetch(
      request("/projects/p/git/sync", "admin-token", { method: "POST" }),
      env,
    );
    assert.equal(synced.status, 200);
    assert.equal((await body(synced)).lastKnownCommitSha, headSha);
    assert.equal(db.gitConnections[0]?.last_known_commit_sha, headSha);
    assert.equal(db.gitAuditEvents[1]?.event_type, "git-synced");
    assert.deepEqual(JSON.parse(String(db.gitAuditEvents[1]?.metadata)), {
      changed: true,
      old: { defaultBranch: "main", commitSha: "a".repeat(40) },
      new: { defaultBranch: "main", commitSha: headSha },
    });

    const unchanged = await gitApp.fetch(
      request("/projects/p/git/sync", "admin-token", { method: "POST" }),
      env,
    );
    assert.equal(unchanged.status, 200);
    assert.equal((await body(unchanged)).changed, false);
    assert.equal(db.gitAuditEvents[2]?.event_type, "git-synced");
    assert.equal(JSON.parse(String(db.gitAuditEvents[2]?.metadata)).changed, false);

    const preserved = JSON.stringify(db.gitConnections[0]);
    failProvider = true;
    const failed = await gitApp.fetch(
      request("/projects/p/git/sync", "admin-token", { method: "POST" }),
      env,
    );
    assert.equal(failed.status, 502);
    assert.deepEqual(await body(failed), { error: "GIT_PROVIDER_FAILED" });
    assert.equal(JSON.stringify(db.gitConnections[0]), preserved);
    assert.equal(db.gitAuditEvents.length, 3);
    failProvider = false;

    repositoryId = 88;
    const mismatched = await gitApp.fetch(
      request("/projects/p/git/sync", "admin-token", { method: "POST" }),
      env,
    );
    assert.equal(mismatched.status, 502);
    assert.equal(JSON.stringify(db.gitConnections[0]), preserved);
    assert.equal(db.gitAuditEvents.length, 3);
    repositoryId = 77;

    const disconnected = await gitApp.fetch(
      request("/projects/p/git", "admin-token", { method: "DELETE" }),
      env,
    );
    assert.equal(disconnected.status, 200);
    assert.equal(db.gitConnections.length, 0);
    assert.equal(db.projectRepositories.length, 0);
    assert.equal(db.gitAuditEvents[3]?.event_type, "git-disconnected");
    assert.equal(db.repositories.length, 1, "canonical identity remains as audit provenance");
    const afterDisconnect = await body(
      await gitApp.fetch(
        request("/projects/resolve?repository=https://github.com/owner/repo", "viewer-token"),
        env,
      ),
    );
    assert.equal(afterDisconnect.match, "none");
  });

  it("prevents an in-flight stale callback from resurrecting a disconnected replacement", async () => {
    const db = new FakeD1();
    await addUserSession(db, "admin", "token");
    db.projects.push({ id: "p", workspace_id: "w", name: "P", slug: "p", status: "ACTIVE" });
    db.projectMembers.push({ project_id: "p", user_id: "admin", role: "ADMIN" });
    const admin = db.users.find((row) => row.id === "admin");
    if (admin) admin.provider_user_id = "42";
    const env = bindings(db);
    env.GITHUB_APP_PRIVATE_KEY = await githubAppPrivateKey();
    let releaseA: (() => void) | undefined;
    const waitForReleaseA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let sawA: (() => void) | undefined;
    const aStarted = new Promise<void>((resolve) => {
      sawA = resolve;
    });
    const gitApp = createApp(async (input, init) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) {
        const code = JSON.parse(String(init?.body)).code;
        if (code === "A") {
          sawA?.();
          await waitForReleaseA;
        }
        if (code === "DEMOTE") {
          const member = db.projectMembers.find(
            (row) => row.project_id === "p" && row.user_id === "admin",
          );
          if (member) member.role = "EDITOR";
        }
        if (code === "REMOVE") {
          db.projectMembers = db.projectMembers.filter(
            (row) => row.project_id !== "p" || row.user_id !== "admin",
          );
        }
        return Response.json({ access_token: `user-${code}` });
      }
      if (url.endsWith("/user")) return Response.json({ id: 42, login: "admin" });
      if (url.includes("/user/installations/99/repositories")) {
        return Response.json({ total_count: 1, repositories: [{ id: 77 }] });
      }
      if (url.includes("/access_tokens")) return Response.json({ token: "installation" });
      if (url.includes("/git/ref/heads/")) {
        return Response.json({ object: { sha: "a".repeat(40) } });
      }
      return Response.json({
        id: 77,
        name: "repo",
        full_name: "owner/repo",
        default_branch: "main",
      });
    });
    const startFlow = async () => {
      const started = await gitApp.fetch(
        request("/projects/p/git", "token", {
          method: "POST",
          body: JSON.stringify({ repositoryUrl: "https://github.com/owner/repo" }),
        }),
        env,
      );
      const installState = new URL((await body(started)).installationUrl).searchParams.get("state");
      const setup = await gitApp.fetch(
        request(
          `/auth/github-app/setup?setup_action=install&installation_id=99&state=${installState}`,
          "token",
        ),
        env,
      );
      const authorization = new URL(setup.headers.get("location") ?? "");
      return {
        state: authorization.searchParams.get("state"),
        cookie: setup.headers.get("set-cookie")?.split(";", 1)[0],
      };
    };

    const flowA = await startFlow();
    const callbackA = gitApp.fetch(
      request(`/auth/github-app/callback?code=A&state=${flowA.state}`, undefined, {
        headers: { cookie: `${SESSION_COOKIE}=token; ${flowA.cookie}` },
      }),
      env,
    );
    await aStarted;
    const flowB = await startFlow();
    const callbackB = await gitApp.fetch(
      request(`/auth/github-app/callback?code=B&state=${flowB.state}`, undefined, {
        headers: { cookie: `${SESSION_COOKIE}=token; ${flowB.cookie}` },
      }),
      env,
    );
    assert.match(callbackB.headers.get("location") ?? "", /git=connected/);
    assert.equal(db.githubConnectionStates.length, 0, "publication invalidates sibling flows");
    assert.equal(
      (await gitApp.fetch(request("/projects/p/git", "token", { method: "DELETE" }), env)).status,
      200,
    );
    releaseA?.();
    const stale = await callbackA;
    assert.match(stale.headers.get("location") ?? "", /git_error=stale_connection/);
    assert.equal(db.gitConnections.length, 0);
    assert.equal(db.projectRepositories.length, 0);

    for (const code of ["DEMOTE", "REMOVE"]) {
      const existing = db.projectMembers.find(
        (row) => row.project_id === "p" && row.user_id === "admin",
      );
      if (existing) existing.role = "ADMIN";
      else db.projectMembers.push({ project_id: "p", user_id: "admin", role: "ADMIN" });
      const flow = await startFlow();
      const auditCount = db.gitAuditEvents.length;
      const repositoryCount = db.repositories.length;
      const denied = await gitApp.fetch(
        request(`/auth/github-app/callback?code=${code}&state=${flow.state}`, undefined, {
          headers: { cookie: `${SESSION_COOKIE}=token; ${flow.cookie}` },
        }),
        env,
      );
      assert.match(denied.headers.get("location") ?? "", /git_error=forbidden/);
      assert.equal(db.gitConnections.length, 0, code);
      assert.equal(db.projectRepositories.length, 0, code);
      assert.equal(db.gitAuditEvents.length, auditCount, code);
      assert.equal(db.repositories.length, repositoryCount, code);
    }
  });

  it("returns stale-operation conflicts when old sync or disconnect races a replacement", async () => {
    const makeDb = async () => {
      const db = new FakeD1();
      await addUserSession(db, "admin", "token");
      db.projectMembers.push({ project_id: "p", user_id: "admin", role: "ADMIN" });
      db.repositories.push(
        {
          id: "r1",
          provider: "github",
          canonical_url: "github.com/o/old",
          owner: "o",
          repository_name: "old",
        },
        {
          id: "r2",
          provider: "github",
          canonical_url: "github.com/o/new",
          owner: "o",
          repository_name: "new",
        },
      );
      db.projectRepositories.push({ project_id: "p", repository_identity_id: "r1" });
      db.gitConnections.push({
        connection_id: "old-connection",
        project_id: "p",
        repository_identity_id: "r1",
        provider: "github",
        installation_id: "1",
        provider_repository_id: "11",
        default_branch: "main",
        last_known_commit_sha: "a".repeat(40),
        status: "VERIFIED",
      });
      return db;
    };
    const replacement = {
      connection_id: "replacement",
      project_id: "p",
      repository_identity_id: "r2",
      provider: "github",
      installation_id: "2",
      provider_repository_id: "22",
      default_branch: "trunk",
      last_known_commit_sha: "c".repeat(40),
      status: "VERIFIED",
    };

    const syncDb = await makeDb();
    const syncEnv = bindings(syncDb);
    syncEnv.GITHUB_APP_PRIVATE_KEY = await githubAppPrivateKey();
    let replaced = false;
    const syncApp = createApp(async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        syncDb.gitConnections = [{ ...replacement }];
        syncDb.projectRepositories = [{ project_id: "p", repository_identity_id: "r2" }];
        replaced = true;
        return Response.json({ token: "installation" });
      }
      if (url.includes("/git/ref/heads/")) {
        return Response.json({ object: { sha: "b".repeat(40) } });
      }
      return Response.json({ id: 11, name: "old", full_name: "o/old", default_branch: "main" });
    });
    const sync = await syncApp.fetch(
      request("/projects/p/git/sync", "token", { method: "POST" }),
      syncEnv,
    );
    assert.equal(replaced, true);
    assert.equal(sync.status, 409);
    assert.deepEqual(await body(sync), { error: "GIT_STALE_OPERATION" });
    assert.deepEqual(syncDb.gitConnections, [replacement]);
    assert.equal(syncDb.gitAuditEvents.length, 0);

    const disconnectDb = await makeDb();
    disconnectDb.beforeMutation = () => {
      disconnectDb.gitConnections = [{ ...replacement }];
      disconnectDb.projectRepositories = [{ project_id: "p", repository_identity_id: "r2" }];
    };
    const disconnected = await app.fetch(
      request("/projects/p/git", "token", { method: "DELETE" }),
      bindings(disconnectDb),
    );
    assert.equal(disconnected.status, 409);
    assert.deepEqual(await body(disconnected), { error: "GIT_STALE_OPERATION" });
    assert.deepEqual(disconnectDb.gitConnections, [replacement]);
    assert.deepEqual(disconnectDb.projectRepositories, [
      { project_id: "p", repository_identity_id: "r2" },
    ]);
    assert.equal(disconnectDb.gitAuditEvents.length, 0);
  });

  it("does not let an older sync overwrite newer metadata from the same connection", async () => {
    const db = new FakeD1();
    await addUserSession(db, "admin", "token");
    db.projectMembers.push({ project_id: "p", user_id: "admin", role: "ADMIN" });
    db.repositories.push({
      id: "r",
      provider: "github",
      canonical_url: "github.com/o/repo",
      owner: "o",
      repository_name: "repo",
    });
    db.projectRepositories.push({ project_id: "p", repository_identity_id: "r" });
    const connection = {
      connection_id: "connection",
      project_id: "p",
      repository_identity_id: "r",
      provider: "github",
      installation_id: "1",
      provider_repository_id: "11",
      default_branch: "main",
      last_known_commit_sha: "a".repeat(40),
      status: "VERIFIED",
      verified_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    db.gitConnections.push(connection);
    const newer = {
      ...connection,
      default_branch: "trunk",
      last_known_commit_sha: "c".repeat(40),
      verified_at: "2026-01-01T00:00:02.000Z",
      updated_at: "2026-01-01T00:00:02.000Z",
    };
    const env = bindings(db);
    env.GITHUB_APP_PRIVATE_KEY = await githubAppPrivateKey();
    const gitApp = createApp(async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation" });
      if (url.includes("/git/ref/heads/")) {
        db.gitConnections = [{ ...newer }];
        return Response.json({ object: { sha: "b".repeat(40) } });
      }
      return Response.json({ id: 11, name: "repo", full_name: "o/repo", default_branch: "main" });
    });

    const stale = await gitApp.fetch(
      request("/projects/p/git/sync", "token", { method: "POST" }),
      env,
    );

    assert.equal(stale.status, 409);
    assert.deepEqual(await body(stale), { error: "GIT_STALE_OPERATION" });
    assert.deepEqual(db.gitConnections, [newer]);
    assert.equal(db.gitAuditEvents.length, 0);
  });

  it("rechecks ADMIN membership when sync and disconnect mutate", async () => {
    const makeDb = async () => {
      const db = new FakeD1();
      await addUserSession(db, "admin", "token");
      db.projectMembers.push({ project_id: "p", user_id: "admin", role: "ADMIN" });
      db.repositories.push({
        id: "r",
        provider: "github",
        canonical_url: "github.com/o/repo",
        owner: "o",
        repository_name: "repo",
      });
      db.projectRepositories.push({ project_id: "p", repository_identity_id: "r" });
      db.gitConnections.push({
        connection_id: "connection",
        project_id: "p",
        repository_identity_id: "r",
        provider: "github",
        installation_id: "1",
        provider_repository_id: "11",
        default_branch: "main",
        last_known_commit_sha: "a".repeat(40),
        status: "VERIFIED",
        verified_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      return db;
    };

    for (const removal of [false, true]) {
      const db = await makeDb();
      const originalConnection = structuredClone(db.gitConnections);
      const env = bindings(db);
      env.GITHUB_APP_PRIVATE_KEY = await githubAppPrivateKey();
      const gitApp = createApp(async (input) => {
        const url = String(input);
        if (url.includes("/access_tokens")) return Response.json({ token: "installation" });
        if (url.includes("/git/ref/heads/")) {
          if (removal) db.projectMembers = [];
          else db.projectMembers[0]!.role = "EDITOR";
          return Response.json({ object: { sha: "b".repeat(40) } });
        }
        return Response.json({ id: 11, name: "repo", full_name: "o/repo", default_branch: "main" });
      });
      const denied = await gitApp.fetch(
        request("/projects/p/git/sync", "token", { method: "POST" }),
        env,
      );
      assert.equal(denied.status, removal ? 404 : 403);
      assert.deepEqual(db.gitConnections, originalConnection);
      assert.equal(db.gitAuditEvents.length, 0);
    }

    for (const removal of [false, true]) {
      const db = await makeDb();
      const originalConnection = structuredClone(db.gitConnections);
      db.beforeMutation = () => {
        if (removal) db.projectMembers = [];
        else db.projectMembers[0]!.role = "EDITOR";
      };
      const denied = await app.fetch(
        request("/projects/p/git", "token", { method: "DELETE" }),
        bindings(db),
      );
      assert.equal(denied.status, removal ? 404 : 403);
      assert.deepEqual(db.gitConnections, originalConnection);
      assert.deepEqual(db.projectRepositories, [{ project_id: "p", repository_identity_id: "r" }]);
      assert.equal(db.gitAuditEvents.length, 0);
    }
  });

  it("rolls back sync metadata when its audit insert fails", async () => {
    const db = new FakeD1();
    await addUserSession(db, "admin", "token");
    db.projectMembers.push({ project_id: "p", user_id: "admin", role: "ADMIN" });
    db.repositories.push({
      id: "r",
      provider: "github",
      canonical_url: "github.com/o/repo",
      owner: "o",
      repository_name: "repo",
    });
    const connection = {
      connection_id: "connection",
      project_id: "p",
      repository_identity_id: "r",
      provider: "github",
      installation_id: "1",
      provider_repository_id: "11",
      default_branch: "main",
      last_known_commit_sha: "a".repeat(40),
      status: "VERIFIED",
      verified_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    db.gitConnections.push(connection);
    const originalConnection = structuredClone(connection);
    db.failAuditInsert = true;
    const env = bindings(db);
    env.GITHUB_APP_PRIVATE_KEY = await githubAppPrivateKey();
    const gitApp = createApp(async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation" });
      if (url.includes("/git/ref/heads/")) {
        return Response.json({ object: { sha: "b".repeat(40) } });
      }
      return Response.json({ id: 11, name: "repo", full_name: "o/repo", default_branch: "main" });
    });

    const failed = await gitApp.fetch(
      request("/projects/p/git/sync", "token", { method: "POST" }),
      env,
    );
    assert.equal(failed.status, 500);
    assert.deepEqual(await body(failed), { error: "GIT_PERSISTENCE_FAILED" });
    assert.deepEqual(db.gitConnections, [originalConnection]);
    assert.equal(db.gitAuditEvents.length, 0);
  });
});

describe("repository resolution", () => {
  it("normalizes GitHub SSH and HTTPS repository identities", () => {
    assert.equal(
      normalizeGithubRepository("git@github.com:Owner/Repo.git"),
      "github.com/owner/repo",
    );
    assert.equal(
      normalizeGithubRepository("https://github.com/OWNER/Repo.git"),
      "github.com/owner/repo",
    );
    assert.equal(
      normalizeGithubRepository("ssh://git@github.com/Owner/Repo.git"),
      "github.com/owner/repo",
    );
    assert.equal(normalizeGithubRepository("https://gitlab.com/Owner/Repo"), null);
    assert.equal(normalizeGithubRepository("https://github.com:8443/Owner/Repo"), null);
  });

  it("returns zero, unique, and ambiguous authorized matches without inaccessible projects", async () => {
    const db = new FakeD1();
    await addUserSession(db, "u", "t");
    db.repositories.push({ id: "r", provider: "github", canonical_url: "github.com/owner/repo" });
    db.projects.push(
      {
        id: "p1",
        workspace_id: "w1",
        name: "One",
        slug: "one",
        description: null,
        status: "ACTIVE",
      },
      {
        id: "p2",
        workspace_id: "w2",
        name: "Two",
        slug: "two",
        description: "secret",
        status: "ACTIVE",
      },
    );
    db.projectRepositories.push(
      { project_id: "p1", repository_identity_id: "r" },
      { project_id: "p2", repository_identity_id: "r" },
    );
    db.gitConnections.push(
      {
        connection_id: "c1",
        project_id: "p1",
        repository_identity_id: "r",
        provider: "github",
        status: "VERIFIED",
      },
      {
        connection_id: "c2",
        project_id: "p2",
        repository_identity_id: "r",
        provider: "github",
        status: "VERIFIED",
      },
    );
    const env = bindings(db);
    let resolved = await body(
      await app.fetch(
        request("/projects/resolve?repository=git%40github.com%3Aowner%2Frepo.git", "t"),
        env,
      ),
    );
    assert.equal(resolved.match, "none");
    assert.equal(JSON.stringify(resolved).includes("secret"), false);
    db.projectMembers.push({ project_id: "p1", user_id: "u", role: "VIEWER" });
    db.gitConnections[0]!.status = "ERROR";
    resolved = await body(
      await app.fetch(
        request("/projects/resolve?repository=https%3A%2F%2Fgithub.com%2Fowner%2Frepo", "t"),
        env,
      ),
    );
    assert.equal(resolved.match, "none", "an unverified connection is ignored");
    db.gitConnections[0]!.status = "VERIFIED";
    db.gitConnections[0]!.repository_identity_id = "inconsistent";
    resolved = await body(
      await app.fetch(
        request("/projects/resolve?repository=https%3A%2F%2Fgithub.com%2Fowner%2Frepo", "t"),
        env,
      ),
    );
    assert.equal(resolved.match, "none", "an inconsistent seed link is ignored");
    db.gitConnections[0]!.repository_identity_id = "r";
    resolved = await body(
      await app.fetch(
        request("/projects/resolve?repository=https%3A%2F%2Fgithub.com%2Fowner%2Frepo", "t"),
        env,
      ),
    );
    assert.equal(resolved.match, "unique");
    assert.equal(resolved.project.id, "p1");
    assert.equal(resolved.project.artifact_count, 0);
    db.projectMembers.push({ project_id: "p2", user_id: "u", role: "EDITOR" });
    const ambiguousResponse = await app.fetch(
      request("/projects/resolve?repository=https%3A%2F%2Fgithub.com%2Fowner%2Frepo", "t"),
      env,
    );
    assert.equal(ambiguousResponse.status, 409);
    assert.equal((await body(ambiguousResponse)).match, "ambiguous");
  });
});
