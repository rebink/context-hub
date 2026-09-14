import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleCredentialRoute } from "../src/machine-graphs.js";

class AdminStatement {
  args: unknown[] = [];
  constructor(
    private readonly db: AdminD1,
    readonly sql: string,
  ) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>() {
    return this.db.first(this.sql, this.args) as T | null;
  }
  async run() {
    return { success: true, meta: { changes: this.db.run(this.sql, this.args) } } as D1Result;
  }
  async all<T>() {
    return { success: true, results: this.db.rows() as T[], meta: {} } as D1Result<T>;
  }
}

type Credential = {
  id: string;
  principalId: string;
  hash: string;
  revokedAt: string | null;
  replacedBy: string | null;
};

class AdminD1 {
  role: "ADMIN" | "EDITOR" | null = "ADMIN";
  principals = new Map<string, { name: string; status: "ACTIVE" | "REVOKED" }>();
  credentials: Credential[] = [];
  prepare(sql: string) {
    return new AdminStatement(this, sql);
  }
  async batch(statements: AdminStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
  first(sql: string, args: unknown[]) {
    if (sql.startsWith("SELECT role FROM project_members"))
      return this.role ? { role: this.role } : null;
    if (sql.includes("FROM machine_credentials mc JOIN machine_principals mp")) {
      const credential = this.credentials.find((row) => row.id === args[1]);
      return credential ? this.row(credential) : null;
    }
    return null;
  }
  run(sql: string, args: unknown[]) {
    if (sql.includes("INSERT INTO machine_principals")) {
      if (
        this.role !== "ADMIN" ||
        [...this.principals.values()].filter((principal) => principal.status === "ACTIVE").length >=
          20
      )
        return 0;
      this.principals.set(args[0] as string, { name: args[1] as string, status: "ACTIVE" });
      return 1;
    }
    if (
      sql.includes("INSERT INTO machine_credentials") &&
      sql.includes("FROM machine_principals")
    ) {
      const principalId = args[4] as string;
      if (this.principals.get(principalId)?.status !== "ACTIVE") return 0;
      this.credentials.push({
        id: args[0] as string,
        principalId,
        hash: args[1] as string,
        revokedAt: null,
        replacedBy: null,
      });
      return 1;
    }
    if (
      sql.includes("UPDATE machine_credentials SET revoked_at=") &&
      sql.includes("replaced_by_credential_id=?")
    ) {
      const old = this.credentials.find((row) => row.id === args[2] && !row.revokedAt);
      if (!old || this.role !== "ADMIN") return 0;
      old.revokedAt = "now";
      old.replacedBy = args[0] as string;
      return 1;
    }
    if (
      sql.includes("INSERT INTO machine_credentials") &&
      sql.includes("FROM machine_credentials")
    ) {
      const old = this.credentials.find((row) => row.id === args[4] && row.replacedBy === args[5]);
      if (!old || this.role !== "ADMIN") return 0;
      this.credentials.push({
        id: args[0] as string,
        principalId: old.principalId,
        hash: args[1] as string,
        revokedAt: null,
        replacedBy: null,
      });
      return 1;
    }
    if (sql.includes("UPDATE machine_credentials SET revoked_at=")) {
      const credential = this.credentials.find((row) => row.id === args[1] && !row.revokedAt);
      if (!credential || this.role !== "ADMIN") return 0;
      credential.revokedAt = "now";
      return 1;
    }
    if (sql.includes("UPDATE machine_principals SET status='REVOKED'")) {
      const credential = this.credentials.find((row) => row.id === args[1] && row.revokedAt);
      const principal = credential ? this.principals.get(credential.principalId) : null;
      if (!principal) return 0;
      principal.status = "REVOKED";
      return 1;
    }
    if (sql.includes("INSERT INTO machine_audit_events")) return 1;
    return 0;
  }
  rows() {
    return this.credentials.map((credential) => this.row(credential));
  }
  private row(credential: Credential) {
    return {
      id: credential.id,
      principal_id: credential.principalId,
      name: this.principals.get(credential.principalId)?.name,
      repository_provider: "github",
      provider_repository_id: "repo-1",
      scope: "GRAPH_CLAIM_PUBLISH_FAIL",
      credential_status: credential.revokedAt ? "REVOKED" : "ACTIVE",
      expires_at: "2099-01-01",
      created_at: "2026-01-01",
      revoked_at: credential.revokedAt,
    };
  }
}

function request(method: string, path: string, body?: object) {
  return new Request(`https://api.example${path}`, {
    method,
    headers: {
      origin: "https://web.example",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const env = (db: AdminD1) => ({
  DB: db as unknown as D1Database,
  WEB_ORIGIN: "https://web.example",
});
const user = { id: "admin" };

async function issue(db: AdminD1) {
  return handleCredentialRoute(
    request("POST", "/projects/project-one/machine-credentials", {
      name: "Canonical CI",
      expiresInDays: 30,
    }),
    env(db),
    user,
    "project-one",
  );
}

describe("machine credential administration", () => {
  it("issues a one-time bearer secret and lists only bounded public metadata", async () => {
    const db = new AdminD1();
    const issued = await issue(db);
    assert.equal(issued.status, 201);
    const issuedBody = (await issued.json()) as { token: string; credential: { id: string } };
    assert.match(issuedBody.token, /^chm_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(db.credentials[0]?.hash.length, 64);
    assert.ok(!JSON.stringify(issuedBody).includes(db.credentials[0]?.hash ?? "missing"));

    const listed = await handleCredentialRoute(
      request("GET", "/projects/project-one/machine-credentials"),
      env(db),
      user,
      "project-one",
    );
    const listBody = await listed.json();
    assert.equal(listed.status, 200);
    assert.ok(!JSON.stringify(listBody).includes("token"));
    assert.ok(!JSON.stringify(listBody).includes("secret_hash"));
  });

  it("rotates atomically and revokes immediately", async () => {
    const db = new AdminD1();
    const issued = (await (await issue(db)).json()) as { credential: { id: string } };
    const rotated = await handleCredentialRoute(
      request("POST", `/projects/project-one/machine-credentials/${issued.credential.id}/rotate`, {
        expiresInDays: 10,
      }),
      env(db),
      user,
      "project-one",
      issued.credential.id,
      true,
    );
    assert.equal(rotated.status, 200);
    const replacement = (await rotated.json()) as { credential: { id: string } };
    assert.ok(db.credentials.find((row) => row.id === issued.credential.id)?.revokedAt);
    assert.equal(
      db.credentials.find((row) => row.id === replacement.credential.id)?.revokedAt,
      null,
    );

    const revoked = await handleCredentialRoute(
      request("DELETE", `/projects/project-one/machine-credentials/${replacement.credential.id}`),
      env(db),
      user,
      "project-one",
      replacement.credential.id,
    );
    assert.equal(revoked.status, 204);
    assert.ok(db.credentials.find((row) => row.id === replacement.credential.id)?.revokedAt);
  });

  it("allows repeated revoke and reissue without exhausting active principals", async () => {
    const db = new AdminD1();
    for (let index = 0; index < 25; index += 1) {
      const issued = await issue(db);
      assert.equal(issued.status, 201);
      const body = (await issued.json()) as { credential: { id: string } };
      const revoked = await handleCredentialRoute(
        request("DELETE", `/projects/project-one/machine-credentials/${body.credential.id}`),
        env(db),
        user,
        "project-one",
        body.credential.id,
      );
      assert.equal(revoked.status, 204);
    }
    assert.equal(
      [...db.principals.values()].filter((principal) => principal.status === "ACTIVE").length,
      0,
    );
  });

  it("requires current direct ADMIN membership and exact mutation Origin", async () => {
    const editor = new AdminD1();
    editor.role = "EDITOR";
    assert.equal((await issue(editor)).status, 403);
    const outsider = new AdminD1();
    outsider.role = null;
    assert.equal((await issue(outsider)).status, 404);
    const hostile = await handleCredentialRoute(
      new Request("https://api.example/projects/project-one/machine-credentials", {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ name: "CI", expiresInDays: 1 }),
      }),
      env(new AdminD1()),
      user,
      "project-one",
    );
    assert.equal(hostile.status, 403);
  });
});
