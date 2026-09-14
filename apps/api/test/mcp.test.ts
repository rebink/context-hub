import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AuthorizedProject,
  type CredentialIdentity,
  callerWideLimit,
  executeMcpTool,
  handleMcpCredentialRoute,
  handleMcpRoute,
} from "../src/mcp.js";
import type { ObjectStorage, StoredObjectMetadata } from "../src/object-storage.js";
import { sha256Bytes } from "../src/security.js";

const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "a".repeat(43);
const TOOL_IDENTITY: CredentialIdentity = {
  credential_id: CREDENTIAL_ID,
  principal_id: "principal-one",
  owner_user_id: "user-one",
  repository_provider: null,
  provider_repository_id: null,
  repository_canonical_url: null,
};

type Project = {
  id: string;
  workspaceId: string;
  role: "ADMIN" | "EDITOR" | "VIEWER";
  canonical: string;
  principalScoped: boolean;
  active: boolean;
  directMember: boolean;
  workspaceMember: boolean;
  repositoryCurrent: boolean;
};

class Statement {
  args: unknown[] = [];
  constructor(
    private readonly db: McpD1,
    readonly sql: string,
  ) {}
  bind(...args: unknown[]) {
    if (args.length > 100) throw new Error("D1 parameter 101");
    this.args = args;
    return this;
  }
  async first<T>() {
    this.db.consumeQuery?.();
    return this.db.first(this.sql, this.args) as T | null;
  }
  async all<T>() {
    this.db.consumeQuery?.();
    return { success: true, results: this.db.all(this.sql, this.args), meta: {} } as D1Result<T>;
  }
  async run() {
    this.db.consumeQuery?.();
    return { success: true, meta: { changes: this.db.run(this.sql, this.args) } } as D1Result;
  }
}

class McpD1 {
  credentialStatus: "ACTIVE" | "EXPIRED" | "REVOKED" = "ACTIVE";
  boundCanonical: string | null = null;
  allowed = new Set(["project_info"]);
  nonces = new Set<string>();
  recentCount = 0;
  activeNonceCount = 0;
  domainReads = 0;
  auditOperations: string[] = [];
  queryCount = 0;
  maxQueries = Number.POSITIVE_INFINITY;
  raceAfterDispatch: "REVOKE" | "REMOVE" | "DEACTIVATE" | "REPLACE" | null = null;
  consumeQuery() {
    this.queryCount += 1;
    if (this.queryCount > this.maxQueries) throw new Error("D1 query 51");
  }
  projects: Project[] = [
    {
      id: "project-one",
      workspaceId: "workspace-one",
      role: "ADMIN",
      canonical: "github.com/acme/shared",
      principalScoped: true,
      active: true,
      directMember: true,
      workspaceMember: true,
      repositoryCurrent: true,
    },
    {
      id: "project-two",
      workspaceId: "workspace-two",
      role: "VIEWER",
      canonical: "github.com/acme/two",
      principalScoped: true,
      active: true,
      directMember: true,
      workspaceMember: true,
      repositoryCurrent: true,
    },
    {
      id: "project-three",
      workspaceId: "workspace-one",
      role: "EDITOR",
      canonical: "github.com/acme/shared",
      principalScoped: true,
      active: true,
      directMember: true,
      workspaceMember: true,
      repositoryCurrent: true,
    },
    {
      id: "project-private",
      workspaceId: "workspace-one",
      role: "VIEWER",
      canonical: "github.com/acme/private",
      principalScoped: false,
      active: true,
      directMember: true,
      workspaceMember: true,
      repositoryCurrent: true,
    },
  ];
  prepare(sql: string) {
    return new Statement(this, sql);
  }
  async batch(statements: Statement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
  first(sql: string, args: unknown[]) {
    if (
      sql.includes("FROM mcp_credentials mc JOIN mcp_principals mp") &&
      sql.includes("mc.secret_hash")
    ) {
      if (this.credentialStatus !== "ACTIVE" || args[0] !== CREDENTIAL_ID) return null;
      return {
        credential_id: CREDENTIAL_ID,
        principal_id: "principal-one",
        owner_user_id: "user-one",
        repository_provider: this.boundCanonical ? "github" : null,
        provider_repository_id: this.boundCanonical ? "repository-one" : null,
        repository_canonical_url: this.boundCanonical,
      };
    }
    if (sql.includes("INSERT INTO mcp_request_nonces")) {
      const nonceHash = args[0] as string;
      if (this.nonces.has(nonceHash) || this.recentCount >= 120 || this.activeNonceCount >= 1_000)
        return null;
      this.nonces.add(nonceHash);
      this.recentCount += 1;
      this.activeNonceCount += 1;
      return { credential_id: CREDENTIAL_ID };
    }
    if (sql.includes("AS recent_count"))
      return { recent_count: this.recentCount, active_count: this.activeNonceCount };
    if (sql.includes("SELECT mc.id FROM mcp_credentials")) {
      for (const predicate of [
        "mp.status='ACTIVE'",
        "mpp.principal_id=mp.id",
        "p.status='ACTIVE'",
        "pm.user_id=mp.owner_user_id",
        "wm.user_id=mp.owner_user_id",
        "(SELECT COUNT(*)",
      ])
        assert.ok(sql.includes(predicate), `authorization SQL omitted ${predicate}`);
      if (this.boundCanonical) {
        assert.ok(sql.includes("gc.status='VERIFIED'"));
        assert.ok(sql.includes("JOIN project_repositories pr"));
        assert.ok(sql.includes("ri.canonical_url=?"));
      }
      const operation = args[2] as string;
      const requested = args.filter(
        (arg) => typeof arg === "string" && arg.startsWith("project-"),
      ) as string[];
      const authorized = requested.every((id) => {
        const project = this.projects.find((candidate) => candidate.id === id);
        return (
          project?.principalScoped &&
          project.active &&
          project.directMember &&
          project.workspaceMember &&
          (!this.boundCanonical || project.repositoryCurrent)
        );
      });
      const accepted =
        this.credentialStatus === "ACTIVE" &&
        (operation.match(/^[A-Z_]+$/) || this.allowed.has(operation)) &&
        authorized;
      if (accepted && operation === "search_context" && this.raceAfterDispatch) {
        const raced = this.projects.find((project) => project.id === "project-two");
        if (this.raceAfterDispatch === "REVOKE") this.credentialStatus = "REVOKED";
        else if (raced && this.raceAfterDispatch === "REMOVE") raced.directMember = false;
        else if (raced && this.raceAfterDispatch === "DEACTIVATE") raced.active = false;
        else if (raced && this.raceAfterDispatch === "REPLACE") raced.repositoryCurrent = false;
        this.raceAfterDispatch = null;
      }
      return accepted ? { id: CREDENTIAL_ID } : null;
    }
    if (sql.includes("SELECT 1 AS authorized")) {
      assert.match(sql, /context_auth_mpo\.operation='search_context'/);
      assert.match(sql, /context_auth_mc\.revoked_at IS NULL/);
      const requested = args.filter(
        (arg) => typeof arg === "string" && arg.startsWith("project-"),
      ) as string[];
      const authorized = requested.every((id) => {
        const project = this.projects.find((candidate) => candidate.id === id);
        return (
          project?.principalScoped &&
          project.active &&
          project.directMember &&
          project.workspaceMember &&
          (!this.boundCanonical || project.repositoryCurrent)
        );
      });
      return this.credentialStatus === "ACTIVE" && authorized ? { authorized: 1 } : null;
    }
    if (sql.includes("SELECT p.id,p.workspace_id,p.name")) {
      this.domainReads += 1;
      const project = this.projects.find((candidate) => candidate.id === args[0]);
      if (!project) return null;
      return {
        id: project.id,
        workspace_id: project.workspaceId,
        name: project.id,
        slug: project.id,
        description: null,
        status: "ACTIVE",
        provider: "github",
        provider_repository_id: `repo-${project.id}`,
        canonical_url: project.canonical,
        owner: "acme",
        repository_name: project.id,
        default_branch: "main",
        last_known_commit_sha: "a".repeat(40),
      };
    }
    throw new Error(`Unhandled first query: ${sql}`);
  }
  all(sql: string, args: unknown[]) {
    if (!sql.includes("JOIN mcp_principal_projects"))
      throw new Error(`Unhandled all query: ${sql}`);
    const canonical = sql.includes("AND ri.canonical_url=?")
      ? (args.find((arg) => typeof arg === "string" && arg.startsWith("github.com/")) as
          | string
          | undefined)
      : undefined;
    const requested = new Set(
      args.filter((arg) => typeof arg === "string" && arg.startsWith("project-")) as string[],
    );
    return this.projects
      .filter(
        (project) =>
          project.principalScoped &&
          project.active &&
          project.directMember &&
          project.workspaceMember &&
          project.repositoryCurrent &&
          (!this.boundCanonical || project.canonical === this.boundCanonical) &&
          (canonical ? project.canonical === canonical : requested.has(project.id)),
      )
      .map((project) => ({
        id: project.id,
        workspace_id: project.workspaceId,
        role: project.role,
      }));
  }
  run(sql: string, args: unknown[]) {
    if (sql.includes("INSERT INTO mcp_audit_events")) {
      this.auditOperations.push(String(args[4]));
      return 1;
    }
    if (sql.includes("UPDATE mcp_credentials") || sql.includes("DELETE FROM mcp_request_nonces"))
      return 1;
    throw new Error(`Unhandled run query: ${sql}`);
  }
}

let mcpStorageReads = 0;
const storage: ObjectStorage = {
  async createOnly() {
    return "collision";
  },
  async head() {
    mcpStorageReads += 1;
    return null;
  },
  async getBytes() {
    mcpStorageReads += 1;
    return null;
  },
  async compensationDelete() {},
};

function call(
  db: McpD1,
  nonce: string,
  name: string,
  args: Record<string, unknown>,
  authorization = `Bearer chmcp_${CREDENTIAL_ID}.${SECRET}`,
) {
  return handleMcpRoute(
    new Request("https://api.example/mcp", {
      method: "POST",
      headers: {
        authorization,
        "x-context-nonce": nonce,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nonce,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    { DB: db as unknown as D1Database },
    storage,
  );
}

function rawMcpRequest(
  db: McpD1,
  nonce: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return handleMcpRoute(
    new Request("https://api.example/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer chmcp_${CREDENTIAL_ID}.${SECRET}`,
        "x-context-nonce": nonce,
        accept: "application/json",
        "content-type": "application/json",
        ...headers,
      },
      body,
    }),
    { DB: db as unknown as D1Database },
    storage,
  );
}

async function errorMessage(response: Response) {
  return ((await response.json()) as { error: { message: string } }).error.message;
}

type LifecycleCredential = {
  id: string;
  principalId: string;
  hash: string;
  revoked: boolean;
  replacement: string | null;
};

class LifecycleD1 {
  admin = true;
  principal: { id: string; name: string; revoked: boolean } | null = null;
  credentials: LifecycleCredential[] = [];
  revokeAuditCount = 0;
  prepare(sql: string) {
    return new Statement(this as unknown as McpD1, sql);
  }
  async batch(statements: Statement[]) {
    const snapshot = structuredClone({ principal: this.principal, credentials: this.credentials });
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (cause) {
      Object.assign(this, snapshot);
      throw cause;
    }
  }
  first(sql: string, args: unknown[]) {
    if (sql.includes("SELECT COUNT(*) AS count FROM project_members"))
      return { count: this.admin ? 1 : 0 };
    if (sql.includes("FROM mcp_credentials mc JOIN mcp_principals mp")) {
      const credential = this.credentials.find((item) => item.id === args[0]);
      if (!credential || !this.principal || args[1] !== "admin") return null;
      return this.row(credential);
    }
    return null;
  }
  all() {
    return this.credentials.map((credential) => this.row(credential));
  }
  run(sql: string, args: unknown[]) {
    if (sql.includes("INSERT INTO mcp_principals")) {
      if (!this.admin) return 0;
      this.principal = { id: args[0] as string, name: args[2] as string, revoked: false };
      return 1;
    }
    if (sql.includes("INSERT INTO mcp_principal_projects")) return this.principal ? 1 : 0;
    if (sql.includes("INSERT INTO mcp_principal_operations")) return this.principal ? 1 : 0;
    if (sql.includes("INSERT INTO mcp_credentials") && sql.includes("FROM mcp_principals")) {
      if (!this.principal) return 0;
      this.credentials.push({
        id: args[0] as string,
        principalId: this.principal.id,
        hash: args[1] as string,
        revoked: false,
        replacement: null,
      });
      return 1;
    }
    if (
      sql.includes("UPDATE mcp_credentials SET revoked_at=") &&
      sql.includes("replaced_by_credential_id")
    ) {
      const credential = this.credentials.find((item) => item.id === args[2] && !item.revoked);
      if (!credential || !this.admin) return 0;
      credential.revoked = true;
      credential.replacement = args[1] as string;
      return 1;
    }
    if (sql.includes("INSERT INTO mcp_credentials") && sql.includes("FROM mcp_credentials")) {
      const old = this.credentials.find(
        (item) => item.id === args[4] && item.replacement === args[5] && item.revoked,
      );
      if (!old) return 0;
      this.credentials.push({
        id: args[0] as string,
        principalId: old.principalId,
        hash: args[1] as string,
        revoked: false,
        replacement: null,
      });
      return 1;
    }
    if (sql.includes("UPDATE mcp_credentials SET revoked_at=")) {
      const credential = this.credentials.find((item) => item.id === args[1] && !item.revoked);
      if (!credential || !this.admin) return 0;
      credential.revoked = true;
      this.revokeAuditCount += 1;
      return 1;
    }
    if (sql.includes("UPDATE mcp_principals SET status='REVOKED'")) {
      if (this.principal) this.principal.revoked = true;
      return this.principal ? 1 : 0;
    }
    if (sql.includes("INSERT INTO mcp_audit_events")) return 1;
    return 0;
  }
  private row(credential: LifecycleCredential) {
    return {
      id: this.principal?.id,
      name: this.principal?.name,
      credential_id: credential.id,
      credential_status: credential.revoked ? "REVOKED" : "ACTIVE",
      project_ids: "project-one",
      operations: "project_info,search_context",
      repository_provider: null,
      provider_repository_id: null,
      repository_canonical_url: null,
      issued_at: "2026-01-01",
      expires_at: "2099-01-01",
      last_used_at: null,
      revoked_at: credential.revoked ? "now" : null,
      replaced_by_credential_id: credential.replacement,
    };
  }
}

function lifecycleRequest(
  method: string,
  path: string,
  body?: object,
  origin = "https://web.example",
) {
  return new Request(`https://api.example${path}`, {
    method,
    headers: {
      origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("MCP credential lifecycle", () => {
  it("issues one-time 256-bit credentials, rotates, and revokes without returning hashes", async () => {
    const db = new LifecycleD1();
    const issue = await handleMcpCredentialRoute(
      lifecycleRequest("POST", "/mcp-credentials", {
        name: "Local client",
        projectIds: ["project-one"],
        operations: ["project_info", "search_context"],
        expiresInDays: 30,
      }),
      { DB: db as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
      { id: "admin" },
    );
    assert.equal(issue.status, 201);
    const issued = (await issue.json()) as { token: string; credential: { credentialId: string } };
    assert.match(issued.token, /^chmcp_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(db.credentials[0]?.hash.length, 64);
    assert.equal(JSON.stringify(issued).includes(db.credentials[0]?.hash ?? "missing"), false);

    const rotate = await handleMcpCredentialRoute(
      lifecycleRequest("POST", `/mcp-credentials/${issued.credential.credentialId}/rotate`, {
        expiresInDays: 10,
      }),
      { DB: db as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
      { id: "admin" },
      issued.credential.credentialId,
      true,
    );
    assert.equal(rotate.status, 200);
    const rotated = (await rotate.json()) as { credential: { credentialId: string } };
    assert.equal(db.credentials[0]?.revoked, true);

    const revokeRequest = () =>
      handleMcpCredentialRoute(
        lifecycleRequest("DELETE", `/mcp-credentials/${rotated.credential.credentialId}`),
        { DB: db as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
        { id: "admin" },
        rotated.credential.credentialId,
      );
    const concurrentRevokes = await Promise.all([revokeRequest(), revokeRequest()]);
    assert.deepEqual(concurrentRevokes.map((response) => response.status).sort(), [204, 404]);
    assert.equal(db.credentials[1]?.revoked, true);
    assert.equal(db.revokeAuditCount, 1);
  });

  it("requires exact Origin and current ADMIN authority at the issuance statement", async () => {
    const hostileDb = new LifecycleD1();
    const hostile = await handleMcpCredentialRoute(
      lifecycleRequest(
        "POST",
        "/mcp-credentials",
        {
          name: "Local client",
          projectIds: ["project-one"],
          operations: ["project_info"],
          expiresInDays: 1,
        },
        "https://evil.example",
      ),
      { DB: hostileDb as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
      { id: "admin" },
    );
    assert.equal(hostile.status, 403);
    assert.equal(hostileDb.principal, null);

    const raced = new LifecycleD1();
    raced.admin = false;
    const denied = await handleMcpCredentialRoute(
      lifecycleRequest("POST", "/mcp-credentials", {
        name: "Local client",
        projectIds: ["project-one"],
        operations: ["project_info"],
        expiresInDays: 1,
      }),
      { DB: raced as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
      { id: "admin" },
    );
    assert.equal(denied.status, 404);
    assert.equal(raced.credentials.length, 0);

    const lifecycleRace = new LifecycleD1();
    const issuedResponse = await handleMcpCredentialRoute(
      lifecycleRequest("POST", "/mcp-credentials", {
        name: "Race client",
        projectIds: ["project-one"],
        operations: ["project_info"],
        expiresInDays: 1,
      }),
      { DB: lifecycleRace as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
      { id: "admin" },
    );
    const issued = (await issuedResponse.json()) as { credential: { credentialId: string } };
    lifecycleRace.admin = false;
    const rotateDenied = await handleMcpCredentialRoute(
      lifecycleRequest("POST", `/mcp-credentials/${issued.credential.credentialId}/rotate`, {
        expiresInDays: 1,
      }),
      { DB: lifecycleRace as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
      { id: "admin" },
      issued.credential.credentialId,
      true,
    );
    assert.equal(rotateDenied.status, 404);
    const revokeDenied = await handleMcpCredentialRoute(
      lifecycleRequest("DELETE", `/mcp-credentials/${issued.credential.credentialId}`),
      { DB: lifecycleRace as unknown as D1Database, WEB_ORIGIN: "https://web.example" },
      { id: "admin" },
      issued.credential.credentialId,
    );
    assert.equal(revokeDenied.status, 404);
    assert.equal(lifecycleRace.credentials[0]?.revoked, false);
  });
});

class ToolStatement {
  args: unknown[] = [];
  constructor(
    private readonly db: ToolD1,
    private readonly sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>() {
    return this.db.first(this.sql, this.args) as T | null;
  }
  async all<T>() {
    return { success: true, results: this.db.all(this.sql, this.args), meta: {} } as D1Result<T>;
  }
}

class ToolD1 {
  constructor(
    readonly artifact: Record<string, unknown>,
    readonly graph: Record<string, unknown>,
  ) {}
  prepare(sql: string) {
    return new ToolStatement(this, sql);
  }
  first(sql: string, args: unknown[]) {
    if (sql.includes("SELECT 1 AS authorized")) {
      assert.match(sql, /context_auth_mpo\.operation='search_context'/);
      assert.match(sql, /context_auth_mc\.revoked_at IS NULL/);
      assert.match(sql, /context_auth_pm\.role IN/);
      return { authorized: 1 };
    }
    if (sql.includes("SELECT p.id,p.workspace_id,p.name")) {
      assert.ok(sql.includes("gc.status='VERIFIED'"));
      assert.ok(sql.includes("EXISTS (SELECT 1 FROM project_repositories current_pr"));
      return {
        id: "project-one",
        workspace_id: "workspace-one",
        name: "Project One",
        slug: "project-one",
        description: "Bounded project",
        status: "ACTIVE",
        provider: "github",
        provider_repository_id: "repo-one",
        canonical_url: "github.com/acme/one",
        owner: "acme",
        repository_name: "one",
        default_branch: "main",
        last_known_commit_sha: "a".repeat(40),
      };
    }
    if (sql.includes("FROM artifacts a JOIN artifact_versions av") && sql.includes("CASE WHEN")) {
      assert.ok(sql.includes("a.project_id=?"));
      assert.ok(sql.includes("a.status='ACTIVE'"));
      return args[1] === "artifact-one" ? this.artifact : null;
    }
    if (sql.includes("SELECT gv.* FROM graph_versions")) {
      assert.ok(sql.includes("gv.status='READY'"));
      assert.ok(sql.includes("JOIN project_repositories pr"));
      assert.ok(sql.includes("gc.status='VERIFIED'"));
      return this.graph;
    }
    if (sql.includes("SELECT gv.status,gv.version")) {
      assert.ok(sql.includes("gv.project_id=?"));
      return this.graph;
    }
    if (sql.includes("SELECT gc.provider, gc.provider_repository_id")) {
      assert.match(sql, /context_auth_mpo\.operation='search_context'/);
      return {
        provider: "github",
        provider_repository_id: "repo-one",
        owner: "acme",
        repository_name: "one",
        canonical_url: "github.com/acme/one",
        default_branch: "main",
        last_known_commit_sha: "a".repeat(40),
        status: "VERIFIED",
        updated_at: "2026-01-01T00:00:00.000Z",
      };
    }
    if (sql.includes("SELECT * FROM graph_versions")) {
      assert.match(sql, /context_auth_mpo\.operation='search_context'/);
      return this.graph;
    }
    throw new Error(`Unhandled tool first query: ${sql}`);
  }
  all(sql: string, _args: unknown[]) {
    if (sql.includes("SELECT gc.project_id, gc.provider")) {
      assert.match(sql, /context_auth_mpo\.operation='search_context'/);
      return [
        {
          project_id: "project-one",
          provider: "github",
          provider_repository_id: "repo-one",
          owner: "acme",
          repository_name: "one",
          canonical_url: "github.com/acme/one",
          default_branch: "main",
          last_known_commit_sha: "a".repeat(40),
          status: "VERIFIED",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ];
    }
    if (sql.includes("context_candidates")) {
      assert.match(sql, /context_auth_mpo\.operation='search_context'/);
      return [{ ...this.artifact, project_id: "project-one", candidate_rank: 1 }];
    }
    if (sql.includes("context_graphs")) {
      assert.match(sql, /context_auth_mpo\.operation='search_context'/);
      return [{ ...this.graph, project_id: "project-one", candidate_rank: 1 }];
    }
    if (sql.includes("a.current_version AS version")) {
      assert.ok(sql.includes("a.status = 'ACTIVE'"));
      assert.match(sql, /context_auth_mpo\.operation='search_context'/);
      assert.ok(sql.includes("av.version = a.current_version"));
      return [this.artifact];
    }
    if (sql.includes("SELECT a.id,a.type,a.name,a.current_version")) {
      assert.ok(sql.includes("a.project_id=?"));
      assert.ok(sql.includes("a.status='ACTIVE'"));
      return [this.artifact];
    }
    throw new Error(`Unhandled tool all query: ${sql}`);
  }
}

class ToolStorage implements ObjectStorage {
  corruptArtifact = false;
  constructor(
    private readonly entries: Map<
      string,
      { bytes: Uint8Array<ArrayBuffer>; metadata: StoredObjectMetadata }
    >,
  ) {}
  async createOnly() {
    return "collision" as const;
  }
  async head(key: string) {
    return this.entries.get(key)?.metadata ?? null;
  }
  async getBytes(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.corruptArtifact && key.includes("/artifacts/"))
      return new TextEncoder().encode("corrupt") as Uint8Array<ArrayBuffer>;
    return entry.bytes;
  }
  async compensationDelete() {}
}

describe("MCP six-tool domain contract", () => {
  it("returns bounded provenance-bearing results and verifies private payload integrity", async () => {
    const project: AuthorizedProject = {
      id: "project-one",
      workspace_id: "workspace-one",
      role: "VIEWER",
    };
    const commit = "a".repeat(40);
    const artifactBytes = new TextEncoder().encode(
      "Architecture service boundary",
    ) as Uint8Array<ArrayBuffer>;
    const artifactChecksum = await sha256Bytes(artifactBytes);
    const publication = "p".repeat(32);
    const graphBytes = new TextEncoder().encode(
      JSON.stringify({
        directed: false,
        multigraph: false,
        graph: {},
        nodes: [
          {
            id: "service",
            label: "ServiceBoundary",
            file_type: "ts",
            source_file: "src/service.ts",
            source_location: "L1",
          },
        ],
        links: [],
        hyperedges: [],
        built_at_commit: commit,
      }),
    ) as Uint8Array<ArrayBuffer>;
    const graphChecksum = await sha256Bytes(graphBytes);
    const artifactKey = "projects/project-one/artifacts/artifact-one/v/1/content";
    const graphKey = `projects/project-one/graphs/v/1/attempts/1/${publication}/graph.json`;
    const artifact = {
      id: "artifact-one",
      project_id: "project-one",
      type: "architecture",
      name: "Architecture",
      description: "Service design",
      current_version: 1,
      version: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
      storage_key: artifactKey,
      checksum: artifactChecksum,
      content_type: "text/markdown",
      byte_size: artifactBytes.byteLength,
      source_commit_sha: commit,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const graph = {
      id: "graph-one",
      project_id: "project-one",
      version: 1,
      repository_provider: "github",
      provider_repository_id: "repo-one",
      repository_owner: "acme",
      repository_name: "one",
      repository_canonical_url: "github.com/acme/one",
      source_commit_sha: commit,
      graphify_version: "0.9.58",
      adapter_version: "1.0.0",
      profile: "code-only-clustered-v1",
      format_version: 1,
      generator: "graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1",
      status: "READY",
      attempt: 1,
      storage_layout: "ATTEMPT_V2",
      selected_publication_id: publication,
      lease_id: null,
      lease_expires_at: null,
      failure_category: null,
      storage_key: graphKey,
      checksum: graphChecksum,
      byte_size: graphBytes.byteLength,
      node_count: 1,
      link_count: 0,
      hyperedge_count: 0,
      generated_by: "runner",
      published_attempt: 1,
      published_lease_id: "lease-identifier",
      queued_at: "2026-01-01T00:00:00.000Z",
      build_started_at: "2026-01-01T00:00:00.000Z",
      failed_at: null,
      generated_at: "2026-01-01T00:00:01.000Z",
      superseded_at: null,
      updated_at: "2026-01-01T00:00:01.000Z",
      orphan_observed_at: null,
      orphan_attempt: null,
      orphan_lease_id: null,
      orphan_checksum: null,
      orphan_byte_size: null,
      orphan_cleanup_id: null,
      orphan_cleanup_expires_at: null,
    };
    const storage = new ToolStorage(
      new Map([
        [
          artifactKey,
          {
            bytes: artifactBytes,
            metadata: {
              byteSize: artifactBytes.byteLength,
              httpContentType: "text/markdown",
              metadata: {
                contentType: "text/markdown",
                checksum: artifactChecksum,
                uploadId: "artifact-upload",
              },
            },
          },
        ],
        [
          graphKey,
          {
            bytes: graphBytes,
            metadata: {
              byteSize: graphBytes.byteLength,
              httpContentType: "application/json",
              metadata: {
                contentType: "application/json",
                checksum: graphChecksum,
                uploadId: publication,
              },
            },
          },
        ],
      ]),
    );
    const env = {
      DB: new ToolD1(artifact, graph) as unknown as D1Database,
    };
    const calls = [
      ["project_info", { projectId: "project-one" }],
      [
        "search_context",
        {
          projectId: "project-one",
          query: "architecture boundary",
          maxTokens: 500,
          maxBytes: 8_000,
        },
      ],
      ["get_artifact", { projectId: "project-one", artifactId: "artifact-one" }],
      [
        "query_graph",
        { projectId: "project-one", operation: "search", query: "Service", limit: 5 },
      ],
      ["get_sources", { projectId: "project-one", limit: 5 }],
      ["sync_status", { projectId: "project-one" }],
    ] as const;
    for (const [name, args] of calls) {
      const result = await executeMcpTool(
        env,
        storage,
        name,
        args,
        [project],
        name === "search_context" ? TOOL_IDENTITY : undefined,
      );
      const encoded = JSON.stringify(result);
      assert.ok(encoded.length < 128 * 1024);
      assert.match(encoded, /project-one/);
      if (name !== "project_info") assert.match(encoded, /(checksum|commit|sourceCommitSha)/);
    }

    storage.corruptArtifact = true;
    await assert.rejects(
      executeMcpTool(
        env,
        storage,
        "get_artifact",
        { projectId: "project-one", artifactId: "artifact-one" },
        [project],
      ),
      /SOURCE_UNAVAILABLE/,
    );
  });
});

describe("universal MCP authorization", () => {
  it("keeps graph/source allocations within one caller-wide limit", () => {
    for (const projectCount of [1, 10, 20]) {
      const perProject = callerWideLimit(20, projectCount);
      assert.ok(perProject !== null);
      assert.ok(perProject * projectCount <= 20);
      assert.equal(callerWideLimit(projectCount - 1, projectCount), null);
    }
  });

  it("rejects missing and contradictory selectors before domain reads", async () => {
    const db = new McpD1();
    const selectors = [
      {},
      { repository: "https://github.com/acme/two", projectId: "project-two" },
      {
        repository: "https://github.com/acme/two",
        projectId: "project-two",
        projectIds: ["project-two"],
      },
    ];
    for (const [index, scope] of selectors.entries()) {
      const response = await call(db, `nonce-invalid-scope-${index}`, "project_info", scope);
      assert.equal(response.status, 400);
      assert.equal(await errorMessage(response), "INVALID_SCOPE");
    }
    assert.equal(db.domainReads, 0);
  });

  it("authenticates and consumes malformed protocol requests before decoding", async () => {
    const db = new McpD1();
    const malformed = await rawMcpRequest(db, "nonce-malformed-protocol", "{");
    assert.equal(malformed.status, 400);
    assert.deepEqual(db.auditOperations, ["PROTOCOL"]);
    const replay = await call(db, "nonce-malformed-protocol", "project_info", {
      projectId: "project-one",
    });
    assert.equal(replay.status, 401);

    const unknown = await rawMcpRequest(
      db,
      "nonce-unknown-method",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown/method" }),
    );
    assert.equal(unknown.status, 404);
    const unacceptable = await rawMcpRequest(
      db,
      "nonce-unacceptable",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      { accept: "text/plain" },
    );
    assert.equal(unacceptable.status, 406);
    assert.deepEqual(db.auditOperations, ["PROTOCOL", "PROTOCOL", "PROTOCOL", "PROTOCOL"]);

    const noAuth = await handleMcpRoute(
      new Request("https://api.example/mcp", {
        method: "POST",
        headers: { cookie: "context_hub_session=human", "content-type": "application/json" },
        body: "{",
      }),
      { DB: db as unknown as D1Database },
      storage,
    );
    assert.equal(noAuth.status, 401);
    assert.equal(await errorMessage(noAuth), "INVALID_CREDENTIAL");
  });

  it("enforces both request-rate and live-nonce caps", async () => {
    const rate = new McpD1();
    rate.recentCount = 120;
    const rateLimited = await call(rate, "nonce-rate-limited", "project_info", {
      projectId: "project-one",
    });
    assert.equal(rateLimited.status, 429);
    assert.equal(await errorMessage(rateLimited), "RATE_LIMITED");

    const live = new McpD1();
    live.activeNonceCount = 1_000;
    const liveLimited = await call(live, "nonce-live-limited", "project_info", {
      projectId: "project-one",
    });
    assert.equal(liveLimited.status, 429);
  });
  it("supports explicit switching and authorized projects across workspaces", async () => {
    const db = new McpD1();
    const one = await call(db, "nonce-explicit-one", "project_info", { projectId: "project-one" });
    assert.equal(one.status, 200);
    const oneBody = (await one.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const projectInfo = JSON.parse(oneBody.result.content[0]?.text ?? "null") as {
      projects: unknown[];
    };
    assert.equal(projectInfo.projects.length, 1);

    const two = await call(db, "nonce-explicit-two", "project_info", { projectId: "project-two" });
    assert.equal(two.status, 200);
    assert.equal(db.domainReads, 2);
  });

  it("auto-selects a unique normalized repository and requires selection when ambiguous", async () => {
    const db = new McpD1();
    const unique = await call(db, "nonce-repository-one", "project_info", {
      repository: "git@github.com:acme/two.git",
    });
    assert.equal(unique.status, 200);

    const ambiguous = await call(db, "nonce-repository-two", "project_info", {
      repository: "https://github.com/Acme/Shared.git",
    });
    assert.equal(ambiguous.status, 409);
    assert.equal(await errorMessage(ambiguous), "AMBIGUOUS_PROJECT");

    const missing = await call(db, "nonce-repository-missing", "project_info", {
      repository: "https://github.com/acme/missing",
    });
    assert.equal(missing.status, 404);
    assert.equal(await errorMessage(missing), "PROJECT_NOT_FOUND");
  });

  it("checks principal, project, direct-member, workspace-member, and repository predicates", async () => {
    for (const predicate of [
      "principalScoped",
      "active",
      "directMember",
      "workspaceMember",
    ] as const) {
      const db = new McpD1();
      const project = db.projects[0];
      assert.ok(project);
      project[predicate] = false;
      const denied = await call(db, `nonce-predicate-${predicate}`, "project_info", {
        projectId: "project-one",
      });
      assert.equal(denied.status, 404);
      assert.equal(await errorMessage(denied), "PROJECT_NOT_FOUND");
      assert.equal(db.domainReads, 0);
    }
  });

  it("authorizes a complete cross-project set before any domain read", async () => {
    const db = new McpD1();
    const allowed = await call(db, "nonce-cross-allowed", "project_info", {
      projectIds: ["project-one", "project-two"],
    });
    assert.equal(allowed.status, 200);
    assert.equal(db.domainReads, 2);

    db.domainReads = 0;
    const denied = await call(db, "nonce-cross-denied", "project_info", {
      projectIds: ["project-one", "project-private"],
    });
    assert.equal(denied.status, 404);
    assert.equal(await errorMessage(denied), "PROJECT_NOT_FOUND");
    assert.equal(db.domainReads, 0);
  });

  it("fails MCP credential, membership, active-project, and repository races before source reads", async () => {
    for (const race of ["REVOKE", "REMOVE", "DEACTIVATE", "REPLACE"] as const) {
      const db = new McpD1();
      db.allowed.add("search_context");
      db.raceAfterDispatch = race;
      const selector =
        race === "REPLACE"
          ? { projectId: "project-two" }
          : { projectIds: ["project-one", "project-two"] };
      if (race === "REPLACE") db.boundCanonical = "github.com/acme/two";
      mcpStorageReads = 0;
      const denied = await call(db, `nonce-search-race-${race.toLowerCase()}`, "search_context", {
        ...selector,
        query: "refund identity",
        maxTokens: 500,
        maxBytes: 4_000,
      });
      assert.equal(denied.status, 404);
      assert.equal(await errorMessage(denied), "PROJECT_NOT_FOUND");
      assert.equal(db.domainReads, 0);
      assert.equal(mcpStorageReads, 0);
    }
  });

  it("rejects replay, expired/revoked credentials, wrong projects, and human cookies", async () => {
    const db = new McpD1();
    assert.equal(
      (await call(db, "nonce-replay-value", "project_info", { projectId: "project-one" })).status,
      200,
    );
    const replay = await call(db, "nonce-replay-value", "project_info", {
      projectId: "project-one",
    });
    assert.equal(replay.status, 401);
    assert.equal(await errorMessage(replay), "REQUEST_DENIED");

    const wrong = await call(db, "nonce-wrong-project", "project_info", {
      projectId: "project-private",
    });
    assert.equal(wrong.status, 404);
    assert.equal(db.domainReads, 1);

    for (const status of ["EXPIRED", "REVOKED"] as const) {
      db.credentialStatus = status;
      assert.equal(
        (
          await call(db, `nonce-${status.toLowerCase()}-credential`, "project_info", {
            projectId: "project-one",
          })
        ).status,
        401,
      );
    }
    assert.equal(
      (await call(db, "nonce-human-cookie", "project_info", { projectId: "project-one" }, ""))
        .status,
      401,
    );
  });

  it("enforces an optional current repository binding", async () => {
    const db = new McpD1();
    db.boundCanonical = "github.com/acme/two";
    db.maxQueries = 50;
    assert.equal(
      (await call(db, "nonce-bound-correct", "project_info", { projectId: "project-two" })).status,
      200,
    );
    db.queryCount = 0;
    assert.equal(
      (
        await call(db, "nonce-bound-transport-budget", "project_info", {
          projectId: "project-two",
        })
      ).status,
      200,
    );
    assert.equal(db.queryCount, 8);
    const wrong = await call(db, "nonce-bound-wrong", "project_info", {
      projectId: "project-one",
    });
    assert.equal(wrong.status, 404);
    const boundProject = db.projects.find((project) => project.id === "project-two");
    assert.ok(boundProject);
    boundProject.repositoryCurrent = false;
    const stale = await call(db, "nonce-bound-stale", "project_info", {
      projectId: "project-two",
    });
    assert.equal(stale.status, 404);
  });
});
