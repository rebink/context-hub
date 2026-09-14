/* biome-ignore-all lint/style/noNonNullAssertion: Fixture constructors establish non-null READY metadata. */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  ensureLayout,
  readLocalGraph,
  recoverInterruptedSync,
  replaceGraphCache,
  writeManifest,
} from "../src/cache.js";
import { run as runCli } from "../src/cli.js";
import { ClientError, SyncClient, SyncStateReporter } from "../src/client.js";
import { connectProject, deriveStatus, projectStatus, syncProject } from "../src/index.js";
import type { GraphMetadata, LocalGraph, Manifest, SyncMetadata, SyncState } from "../src/types.js";

const execFile = promisify(execFileCallback);
const firstCommit = "a".repeat(40);
const secondCommit = "b".repeat(40);

function graphBytes(commit = firstCommit) {
  return new TextEncoder().encode(
    JSON.stringify({
      directed: false,
      multigraph: false,
      graph: {},
      nodes: [],
      links: [],
      hyperedges: [],
      built_at_commit: commit,
    }),
  );
}

function metadata(version = 1, commit = firstCommit): GraphMetadata {
  const bytes = graphBytes(commit);
  return {
    repository: {
      provider: "github",
      providerRepositoryId: "repo-1",
      owner: "owner",
      name: "repo",
      canonicalUrl: "github.com/owner/repo",
    },
    version,
    attempt: 1,
    status: "READY",
    sourceCommitSha: commit,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
    nodeCount: 0,
    linkCount: 0,
    hyperedgeCount: 0,
    graphifyVersion: "0.9.58",
    adapterVersion: "1.0.0",
    profile: "code-only-clustered-v1",
    formatVersion: 1,
    generator: "graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1",
    failureCategory: null,
    generatedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function manifest(graph = metadata()): Manifest {
  return {
    formatVersion: 1,
    apiOrigin: "https://api.example",
    projectId: "project-a",
    repository: {
      provider: "github",
      providerRepositoryId: "repo-1",
      owner: "owner",
      name: "repo",
      canonicalUrl: "github.com/owner/repo",
    },
    graph: {
      version: graph.version,
      sourceCommitSha: graph.sourceCommitSha,
      checksum: graph.checksum!,
      byteSize: graph.byteSize!,
      syncedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function localGraph(graph = metadata()): LocalGraph {
  return { manifest: manifest(graph), metadata: graph, bytes: graphBytes(graph.sourceCommitSha) };
}

function remote(overrides: Partial<SyncMetadata> = {}): SyncMetadata {
  const ready = metadata();
  return {
    projectId: "project-a",
    repository: {
      provider: "github",
      providerRepositoryId: "repo-1",
      owner: "owner",
      name: "repo",
      canonicalUrl: "github.com/owner/repo",
      defaultBranch: "main",
      remoteCommitSha: firstCommit,
    },
    newestGraph: ready,
    readyGraph: ready,
    ...overrides,
  };
}

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "context-cli-test-"));
}

async function gitRepository() {
  const root = await temporaryDirectory();
  await execFile("git", ["init", "-q", root]);
  await execFile("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await execFile("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(path.join(root, "file.txt"), "one");
  await execFile("git", ["-C", root, "add", "file.txt"]);
  await execFile("git", ["-C", root, "commit", "-qm", "one"]);
  const first = (await execFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(root, "file.txt"), "two");
  await execFile("git", ["-C", root, "commit", "-qam", "two"]);
  const second = (await execFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  await execFile("git", ["-C", root, "remote", "add", "origin", "git@github.com:owner/repo.git"]);
  return { root, first, second };
}

describe("sync state precedence", () => {
  it("derives every online state deterministically", async () => {
    const root = await temporaryDirectory();
    const cases: Array<[SyncState, LocalGraph | null, SyncMetadata, string]> = [
      ["CURRENT", localGraph(), remote(), firstCommit],
      ["GRAPH_STALE", localGraph(metadata(1, secondCommit)), remote(), firstCommit],
      ["NO_LOCAL_GRAPH", null, remote(), firstCommit],
      [
        "GRAPH_BUILDING",
        null,
        remote({ newestGraph: { ...metadata(2), status: "BUILDING" } }),
        firstCommit,
      ],
      [
        "GRAPH_FAILED",
        null,
        remote({ newestGraph: { ...metadata(2), status: "FAILED" } }),
        firstCommit,
      ],
      [
        "REMOTE_GRAPH_AHEAD",
        localGraph(),
        remote({ newestGraph: metadata(2), readyGraph: metadata(2) }),
        firstCommit,
      ],
      ["COMMIT_MISMATCH", localGraph(), remote({ projectId: "other-project" }), firstCommit],
    ];
    for (const [expected, local, server, head] of cases) {
      const result = await deriveStatus(root, manifest(), local, head, server);
      assert.equal(result.state, expected);
    }
  });

  it("distinguishes a local repository ahead using Git ancestry", async () => {
    const fixture = await gitRepository();
    const server = remote();
    server.repository.remoteCommitSha = fixture.first;
    const graph = metadata(1, fixture.first);
    const result = await deriveStatus(
      fixture.root,
      manifest(graph),
      localGraph(graph),
      fixture.second,
      server,
    );
    assert.equal(result.state, "LOCAL_REPOSITORY_AHEAD");
  });

  it("uses verified local state offline", async () => {
    const root = await temporaryDirectory();
    assert.equal(
      (await deriveStatus(root, manifest(), null, firstCommit, null)).state,
      "NO_LOCAL_GRAPH",
    );
    assert.equal(
      (await deriveStatus(root, manifest(), localGraph(), secondCommit, null)).state,
      "GRAPH_STALE",
    );
    const current = await deriveStatus(root, manifest(), localGraph(), firstCommit, null);
    assert.equal(current.state, "CURRENT");
    assert.equal(current.offline, true);
  });
});

describe("safe atomic local cache", () => {
  it("creates the exact layout and atomically selects graph, meta, then manifest", async () => {
    const root = await temporaryDirectory();
    const layout = await ensureLayout(root);
    const initial: Manifest = { ...manifest(), graph: null };
    await writeManifest(layout, initial);
    await replaceGraphCache(layout, initial, metadata(), graphBytes());
    const loaded = await readLocalGraph(layout);
    assert.equal(loaded?.manifest.graph?.version, 1);
    assert.equal(
      Buffer.from(loaded?.bytes ?? []).toString("hex"),
      Buffer.from(graphBytes()).toString("hex"),
    );
    for (const relative of [
      "manifest.json",
      "graph/graph.json",
      "graph/meta.json",
      "artifacts",
      "cache",
    ])
      assert.equal(
        await readFile(path.join(root, ".ai-context", relative)).then(
          () => true,
          () => false,
        ),
        !["artifacts", "cache"].includes(relative),
      );
  });

  it("preserves the prior cache when a corrupt or mismatched update is rejected", async () => {
    const root = await temporaryDirectory();
    const layout = await ensureLayout(root);
    const initial: Manifest = { ...manifest(), graph: null };
    await writeManifest(layout, initial);
    const selected = await replaceGraphCache(layout, initial, metadata(), graphBytes());
    const before = await readFile(layout.graph);
    const bad = { ...metadata(2), checksum: "0".repeat(64) };
    await assert.rejects(
      replaceGraphCache(layout, selected, bad, graphBytes()),
      /GRAPH_INTEGRITY_ERROR/,
    );
    assert.deepEqual(await readFile(layout.graph), before);
    assert.equal((await readLocalGraph(layout))?.metadata.version, 1);
  });

  it("rolls back an interrupted pair replacement before reading", async () => {
    const root = await temporaryDirectory();
    const layout = await ensureLayout(root);
    const initial: Manifest = { ...manifest(), graph: null };
    await writeManifest(layout, initial);
    const selected = await replaceGraphCache(layout, initial, metadata(), graphBytes());
    await writeFile(layout.backups.graph, await readFile(layout.graph));
    await writeFile(layout.backups.meta, await readFile(layout.meta));
    await writeFile(layout.backups.manifest, await readFile(layout.manifest));
    await writeFile(
      layout.marker,
      JSON.stringify({ formatVersion: 1, previous: { graph: true, meta: true, manifest: true } }),
    );
    await writeFile(layout.graph, graphBytes(secondCommit));
    await writeFile(layout.meta, JSON.stringify(metadata(2, secondCommit)));
    assert.equal(await recoverInterruptedSync(layout), true);
    const loaded = await readLocalGraph(layout);
    assert.equal(loaded?.metadata.version, selected.graph?.version);
    assert.equal(
      Buffer.from(loaded?.bytes ?? []).toString("hex"),
      Buffer.from(graphBytes()).toString("hex"),
    );
  });

  it("restores the prior selected tuple when an install rename fails", async () => {
    const root = await temporaryDirectory();
    const layout = await ensureLayout(root);
    const initial: Manifest = { ...manifest(), graph: null };
    await writeManifest(layout, initial);
    const selected = await replaceGraphCache(layout, initial, metadata(), graphBytes());
    const next = metadata(2, secondCommit);
    await assert.rejects(
      replaceGraphCache(layout, selected, next, graphBytes(secondCommit), {
        beforeInstall: (name) => {
          if (name === "meta") throw new Error("injected rename failure");
        },
      }),
      /injected rename failure/,
    );
    const loaded = await readLocalGraph(layout);
    assert.equal(loaded?.metadata.version, 1);
    assert.equal(
      Buffer.from(loaded?.bytes ?? []).toString("hex"),
      Buffer.from(graphBytes()).toString("hex"),
    );
  });

  it("rejects malformed format-v1 graphs even when local checksums match", async () => {
    const root = await temporaryDirectory();
    const layout = await ensureLayout(root);
    const initial: Manifest = { ...manifest(), graph: null };
    await writeManifest(layout, initial);
    for (const text of [
      `{"directed":false,"directed":false,"multigraph":false,"graph":{},"nodes":[],"links":[],"hyperedges":[],"built_at_commit":"${firstCommit}"}`,
      `{"directed":false,"multigraph":false,"graph":{},"nodes":[{"id":"a","label":"a","file_type":"typescript","source_file":"../escape.ts","source_location":"L1"}],"links":[],"hyperedges":[],"built_at_commit":"${firstCommit}"}`,
      `{"directed":false,"multigraph":false,"graph":{},"nodes":[],"links":[{"source":"missing","target":"missing","relation":"calls","confidence":"EXTRACTED","confidence_score":1,"weight":1,"source_file":"src/a.ts","source_location":"L1"}],"hyperedges":[],"built_at_commit":"${firstCommit}"}`,
    ]) {
      const bytes = new TextEncoder().encode(text);
      const invalid = {
        ...metadata(2),
        checksum: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.byteLength,
      };
      await assert.rejects(replaceGraphCache(layout, initial, invalid, bytes), /GRAPH_CORRUPT/);
    }
  });

  it("cleans every prepared temporary file when preparation fails", async () => {
    const root = await temporaryDirectory();
    const layout = await ensureLayout(root);
    const initial: Manifest = { ...manifest(), graph: null };
    await writeManifest(layout, initial);
    for (const stage of ["graph", "meta", "manifest"] as const) {
      await assert.rejects(
        replaceGraphCache(layout, initial, metadata(), graphBytes(), {
          afterPrepare: (name) => {
            if (name === stage) throw new Error(`prepare-${stage}`);
          },
        }),
        new RegExp(`prepare-${stage}`),
      );
      const leftovers = [
        ...(await readdir(path.join(layout.context, "graph"))),
        ...(await readdir(layout.context)),
      ].filter((name) => name.startsWith(".context-") && name.endsWith(".tmp"));
      assert.deepEqual(leftovers, []);
    }
  });

  it("serializes concurrent cache replacements and recovers a dead lock", async () => {
    const root = await temporaryDirectory();
    const layout = await ensureLayout(root);
    const initial: Manifest = { ...manifest(), graph: null };
    await writeManifest(layout, initial);
    const selected = await replaceGraphCache(layout, initial, metadata(), graphBytes());
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const next = metadata(2, secondCommit);
    const first = replaceGraphCache(layout, selected, next, graphBytes(secondCommit), {
      beforeInstall: async (name) => {
        if (name === "graph") {
          entered?.();
          await blocked;
        }
      },
    });
    await started;
    await assert.rejects(
      replaceGraphCache(layout, selected, metadata(3), graphBytes()),
      /SYNC_IN_PROGRESS/,
    );
    release?.();
    await first;
    assert.equal((await readLocalGraph(layout))?.metadata.version, 2);

    await writeFile(layout.lock, JSON.stringify({ formatVersion: 1, pid: 2_147_483_647 }));
    assert.equal((await readLocalGraph(layout))?.metadata.version, 2);
  });

  it("fails if a validated parent directory is replaced before mutation", async () => {
    const root = await temporaryDirectory();
    const layout = await ensureLayout(root);
    const initial: Manifest = { ...manifest(), graph: null };
    await writeManifest(layout, initial);
    const graphDirectory = path.join(layout.context, "graph");
    const originalDirectory = path.join(layout.context, "graph-original");
    const outside = await temporaryDirectory();
    await assert.rejects(
      replaceGraphCache(layout, initial, metadata(), graphBytes(), {
        afterPrepare: async (name) => {
          if (name !== "graph") return;
          await rename(graphDirectory, originalDirectory);
          await symlink(outside, graphDirectory);
        },
      }),
      /UNSAFE_LOCAL_LAYOUT/,
    );
    await rm(graphDirectory);
    await rename(originalDirectory, graphDirectory);
  });

  it("rejects directory and selected-file symlinks", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, ".ai-context"));
    await symlink(os.tmpdir(), path.join(root, ".ai-context", "graph"));
    await assert.rejects(ensureLayout(root), /UNSAFE_LOCAL_LAYOUT/);

    const safeRoot = await temporaryDirectory();
    const layout = await ensureLayout(safeRoot);
    await writeFile(path.join(safeRoot, "outside"), "{}\n");
    await symlink(path.join(safeRoot, "outside"), layout.manifest);
    await assert.rejects(readLocalGraph(layout), /UNSAFE_LOCAL_LAYOUT/);
  });
});

describe("transport and offline behavior", () => {
  it("connects the repository without persisting its supplied credential", async () => {
    const fixture = await gitRepository();
    let authenticated = false;
    const connected = await connectProject({
      directory: fixture.root,
      apiOrigin: "https://api.example",
      projectId: "project-a",
      session: "top-secret-session",
      fetchImplementation: async (_input, init) => {
        authenticated =
          new Headers(init?.headers).get("cookie")?.includes("top-secret-session") ?? false;
        const value = remote();
        value.repository.remoteCommitSha = fixture.second;
        return Response.json(value);
      },
    });
    assert.equal(authenticated, true);
    assert.equal(connected.projectId, "project-a");
    const stored = await readFile(path.join(fixture.root, ".ai-context", "manifest.json"), "utf8");
    assert.equal(stored.includes("top-secret-session"), false);
  });

  it("does not persist a connection when lifecycle cancellation wins after metadata", async () => {
    const fixture = await gitRepository();
    const controller = new AbortController();
    await assert.rejects(
      connectProject({
        directory: fixture.root,
        apiOrigin: "https://api.example",
        projectId: "project-a",
        session: "secret",
        signal: controller.signal,
        fetchImplementation: async () => {
          const value = remote();
          value.repository.remoteCommitSha = fixture.second;
          controller.abort();
          return Response.json(value);
        },
      }),
      /AbortError/,
    );
    const stored = await readFile(
      path.join(fixture.root, ".ai-context", "manifest.json"),
      "utf8",
    ).then(
      () => true,
      () => false,
    );
    assert.equal(stored, false);
  });

  it("validates bounded zero, unique, and ambiguous repository candidates", async () => {
    for (const [payload, expected] of [
      [
        { match: "none", projects: [] },
        { match: "none", projects: [] },
      ],
      [
        { match: "unique", project: { id: "project-a", name: "Payments" } },
        { match: "unique", projects: [{ id: "project-a", name: "Payments" }] },
      ],
      [
        {
          match: "ambiguous",
          projects: [
            { id: "project-a", name: "Payments" },
            { id: "project-b", name: "Shared payments" },
          ],
        },
        {
          match: "ambiguous",
          projects: [
            { id: "project-a", name: "Payments" },
            { id: "project-b", name: "Shared payments" },
          ],
        },
      ],
    ] as const) {
      const client = new SyncClient("https://api.example", "secret", async () =>
        Response.json(payload),
      );
      assert.deepEqual(
        await client.resolveCandidates("git@github.com:acme/payments.git"),
        expected,
      );
    }
  });

  it("rejects malformed repository candidate disclosure", async () => {
    const client = new SyncClient("https://api.example", "secret", async () =>
      Response.json({
        match: "ambiguous",
        projects: [
          { id: "project-a", name: "Payments" },
          { id: "invalid/id", name: "Other" },
        ],
      }),
    );
    await assert.rejects(
      client.resolveCandidates("git@github.com:acme/payments.git"),
      /INVALID_RESPONSE/,
    );
  });

  it("rejects metadata/header mismatch and oversized downloads", async () => {
    const graph = metadata();
    const mismatch = new SyncClient(
      "https://api.example",
      "secret",
      async () =>
        new Response(graphBytes(), {
          headers: {
            "content-type": "application/json",
            "x-context-graph-version": "99",
            "x-context-source-commit": graph.sourceCommitSha,
            "x-context-checksum-sha256": graph.checksum!,
          },
        }),
    );
    await assert.rejects(mismatch.download("project-a", graph), /GRAPH_METADATA_MISMATCH/);

    const oversized = new SyncClient(
      "https://api.example",
      "secret",
      async () =>
        new Response("", {
          headers: {
            "content-type": "application/json",
            "content-length": String(9 * 1024 * 1024),
            "x-context-graph-version": "1",
            "x-context-source-commit": graph.sourceCommitSha,
            "x-context-checksum-sha256": graph.checksum!,
          },
        }),
    );
    await assert.rejects(oversized.download("project-a", graph), /RESPONSE_TOO_LARGE/);
  });

  it("never sends a credential to an origin selected only by repository files", async () => {
    const fixture = await gitRepository();
    const layout = await ensureLayout(fixture.root);
    await writeManifest(layout, {
      ...manifest(),
      apiOrigin: "https://attacker.example",
      graph: null,
    });
    let called = false;
    await assert.rejects(
      syncProject({
        directory: fixture.root,
        session: "secret",
        credentialApiOrigin: "https://api.example",
        fetchImplementation: async () => {
          called = true;
          return new Response();
        },
      }),
      /CREDENTIAL_ORIGIN_MISMATCH/,
    );
    assert.equal(called, false);
  });

  it("preserves a prior cache on HTTP/auth/offline failures", async () => {
    const fixture = await gitRepository();
    const graph = metadata(1, fixture.second);
    const layout = await ensureLayout(fixture.root);
    const connected = { ...manifest(graph), apiOrigin: "https://api.example" };
    await writeManifest(layout, { ...connected, graph: null });
    await replaceGraphCache(
      layout,
      { ...connected, graph: null },
      graph,
      graphBytes(fixture.second),
    );
    const before = await readFile(layout.graph);
    for (const response of [
      async () => new Response('{"error":"UNAUTHENTICATED"}', { status: 401 }),
      async () => {
        throw new Error("network down");
      },
    ]) {
      await assert.rejects(
        syncProject({
          directory: fixture.root,
          session: "secret",
          credentialApiOrigin: "https://api.example",
          fetchImplementation: response,
        }),
        (error: unknown) => error instanceof ClientError,
      );
      assert.deepEqual(await readFile(layout.graph), before);
    }
  });

  it("rejects copied caches and changed Git remotes before any request", async () => {
    const fixture = await gitRepository();
    const layout = await ensureLayout(fixture.root);
    await writeManifest(layout, { ...manifest(), graph: null });
    await execFile("git", [
      "-C",
      fixture.root,
      "remote",
      "set-url",
      "origin",
      "git@github.com:other/repository.git",
    ]);
    let called = false;
    const status = await projectStatus({
      directory: fixture.root,
      session: "secret",
      credentialApiOrigin: "https://api.example",
      fetchImplementation: async () => {
        called = true;
        return Response.json(remote());
      },
    });
    assert.equal(status.state, "COMMIT_MISMATCH");
    await assert.rejects(
      syncProject({
        directory: fixture.root,
        session: "secret",
        credentialApiOrigin: "https://api.example",
        fetchImplementation: async () => {
          called = true;
          return Response.json(remote());
        },
      }),
      /COMMIT_MISMATCH/,
    );
    assert.equal(called, false);
  });

  it("uses a verified cache for status during retryable service outages", async () => {
    const fixture = await gitRepository();
    const graph = metadata(1, fixture.second);
    const layout = await ensureLayout(fixture.root);
    const connected = { ...manifest(graph), graph: null };
    await writeManifest(layout, connected);
    await replaceGraphCache(layout, connected, graph, graphBytes(fixture.second));
    for (const statusCode of [408, 425, 429, 500, 503]) {
      const status = await projectStatus({
        directory: fixture.root,
        session: "secret",
        credentialApiOrigin: "https://api.example",
        fetchImplementation: async () => new Response("unavailable", { status: statusCode }),
      });
      assert.equal(status.state, "CURRENT");
      assert.equal(status.offline, true);
    }
  });

  it("requires a bounded exact JSON acknowledgment for sync-state reporting", async () => {
    const value = {
      clientId: "12345678-1234-4123-8123-123456789abc",
      clientKind: "CONTEXT_CLI" as const,
      clientVersion: "0.1.0",
      observationSequence: 7,
      repository: {
        provider: "github",
        providerRepositoryId: "repo-1",
        canonicalUrl: "github.com/owner/repo",
      },
      localGitSha: firstCommit,
      localGraphVersion: null,
      localGraphAttempt: null,
      localGraphChecksum: null,
      localGraphSourceCommitSha: null,
      remoteGitSha: firstCommit,
      remoteGraphVersion: null,
      remoteGraphAttempt: null,
      remoteGraphChecksum: null,
      remoteGraphSourceCommitSha: null,
      remoteGraphStatus: null,
      status: "NO_LOCAL_GRAPH",
      reportOutcome: "STATUS" as const,
      failureCode: null,
    };
    const token = `chmcp_11111111-1111-4111-8111-111111111111.${"x".repeat(43)}`;
    const responses = [
      new Response("ok", { headers: { "content-type": "text/plain" } }),
      new Response("{", { headers: { "content-type": "application/json" } }),
      Response.json({
        syncState: {
          projectId: "project-a",
          clientId: value.clientId,
          observationSequence: 8,
          status: value.status,
          reportOutcome: value.reportOutcome,
        },
      }),
    ];
    for (const response of responses) {
      const reporter = new SyncStateReporter("https://api.example", token, async () => response);
      await assert.rejects(reporter.report("project-a", value), /SYNC_STATE_REPORT_FAILED/);
    }
    const reporter = new SyncStateReporter("https://api.example", token, async () =>
      Response.json({
        syncState: {
          projectId: "project-a",
          clientId: value.clientId,
          observationSequence: 7,
          status: value.status,
          reportOutcome: value.reportOutcome,
        },
      }),
    );
    await reporter.report("project-a", value);
  });

  it("reports bounded verified online state with a stable client identity and Authorization only", async () => {
    const fixture = await gitRepository();
    const graph = metadata(1, fixture.second);
    const layout = await ensureLayout(fixture.root);
    const connected = {
      ...manifest(graph),
      client: { id: "12345678-1234-4123-8123-123456789abc", observationSequence: 4 },
      graph: null,
    };
    await writeManifest(layout, connected);
    await replaceGraphCache(layout, connected, graph, graphBytes(fixture.second));
    const server = remote({
      repository: { ...remote().repository, remoteCommitSha: fixture.second },
      newestGraph: graph,
      readyGraph: graph,
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const reports: Array<Record<string, unknown>> = [];
    const fetchImplementation = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/sync")) return Response.json(server);
      assert.equal(init?.method, "PUT");
      const headers = new Headers(init?.headers);
      assert.match(headers.get("authorization") ?? "", /^Bearer chmcp_/);
      assert.equal(headers.has("cookie"), false);
      assert.equal(headers.has("origin"), false);
      const body = JSON.parse(String(init?.body));
      reports.push(body);
      assert.equal(body.localGraphAttempt, 1);
      assert.equal(body.status, "CURRENT");
      assert.equal(JSON.stringify(body).includes(fixture.root), false);
      assert.equal(JSON.stringify(body).includes("human-session"), false);
      return Response.json({
        syncState: {
          projectId: "project-a",
          clientId: body.clientId,
          observationSequence: body.observationSequence,
          status: body.status,
          reportOutcome: body.reportOutcome,
        },
      });
    };
    const status = await projectStatus({
      directory: fixture.root,
      session: "human-session",
      credentialApiOrigin: "https://api.example",
      reportToken: `chmcp_11111111-1111-4111-8111-111111111111.${"x".repeat(43)}`,
      fetchImplementation,
    });
    assert.equal(status.reporting, "REPORTED");
    assert.equal(reports[0]?.observationSequence, 5);
    assert.equal(reports[0]?.reportOutcome, "STATUS");

    const failedSyncReport = await projectStatus({
      directory: fixture.root,
      session: "human-session",
      credentialApiOrigin: "https://api.example",
      reportToken: `chmcp_11111111-1111-4111-8111-111111111111.${"x".repeat(43)}`,
      reportOutcome: "SYNC_FAILED",
      failureCode: "GRAPH_INTEGRITY_ERROR",
      fetchImplementation,
    });
    assert.equal(failedSyncReport.reporting, "REPORTED");
    assert.equal(reports[1]?.observationSequence, 6);
    assert.equal(reports[1]?.reportOutcome, "SYNC_FAILED");
    assert.equal(reports[1]?.failureCode, "GRAPH_INTEGRITY_ERROR");
    assert.equal(requests.length, 4);
    const saved = JSON.parse(await readFile(layout.manifest, "utf8"));
    assert.equal(saved.client.id, "12345678-1234-4123-8123-123456789abc");
    assert.equal(saved.client.observationSequence, 6);
  });

  it("keeps verified local status usable when telemetry persistence fails", async () => {
    const fixture = await gitRepository();
    const graph = metadata(1, fixture.second);
    const layout = await ensureLayout(fixture.root);
    const connected = { ...manifest(graph), graph: null };
    await writeManifest(layout, connected);
    await replaceGraphCache(layout, connected, graph, graphBytes(fixture.second));
    const server = remote({
      repository: { ...remote().repository, remoteCommitSha: fixture.second },
      newestGraph: graph,
      readyGraph: graph,
    });
    const status = await projectStatus({
      directory: fixture.root,
      session: "human-session",
      credentialApiOrigin: "https://api.example",
      reportToken: `chmcp_11111111-1111-4111-8111-111111111111.${"x".repeat(43)}`,
      fetchImplementation: async (input) =>
        String(input).endsWith("/sync")
          ? Response.json(server)
          : new Response("unavailable", { status: 503 }),
    });
    assert.equal(status.state, "CURRENT");
    assert.equal(status.offline, false);
    assert.equal(status.reporting, "FAILED");
    assert.ok(await readLocalGraph(layout));
  });

  it("prints sync success even when post-sync reporting fails", async () => {
    const priorSession = process.env.CONTEXT_HUB_SESSION;
    const priorOrigin = process.env.CONTEXT_HUB_API;
    const priorToken = process.env.CONTEXT_HUB_MCP_TOKEN;
    process.env.CONTEXT_HUB_SESSION = "session";
    process.env.CONTEXT_HUB_API = "https://api.example";
    process.env.CONTEXT_HUB_MCP_TOKEN = `chmcp_11111111-1111-4111-8111-111111111111.${"x".repeat(43)}`;
    const output: string[] = [];
    try {
      await runCli(["sync"], "/unused", (value) => output.push(value), {
        connectProject,
        syncProject: async () => manifest(),
        projectStatus: async () => {
          throw new Error("REPORT_FAILED");
        },
      });
    } finally {
      if (priorSession === undefined) delete process.env.CONTEXT_HUB_SESSION;
      else process.env.CONTEXT_HUB_SESSION = priorSession;
      if (priorOrigin === undefined) delete process.env.CONTEXT_HUB_API;
      else process.env.CONTEXT_HUB_API = priorOrigin;
      if (priorToken === undefined) delete process.env.CONTEXT_HUB_MCP_TOKEN;
      else process.env.CONTEXT_HUB_MCP_TOKEN = priorToken;
    }
    assert.deepEqual(JSON.parse(output[0] ?? ""), {
      synced: true,
      projectId: "project-a",
      graphVersion: 1,
      reporting: "FAILED",
    });
  });

  it("reports verified status offline and surfaces local corruption", async () => {
    const fixture = await gitRepository();
    const graph = metadata(1, fixture.second);
    const layout = await ensureLayout(fixture.root);
    const connected = { ...manifest(graph), graph: null };
    await writeManifest(layout, connected);
    await replaceGraphCache(layout, connected, graph, graphBytes(fixture.second));
    const status = await projectStatus({ directory: fixture.root });
    assert.equal(status.state, "CURRENT");
    assert.equal(status.offline, true);

    await writeFile(layout.graph, "{}\n");
    const corrupt = await projectStatus({ directory: fixture.root });
    assert.equal(corrupt.state, "COMMIT_MISMATCH");
    assert.equal(corrupt.offline, true);
  });
});
