import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MCP_TOOLS } from "../apps/api/src/mcp-transport.js";
import { run as runCli } from "../packages/context-cli/src/cli.js";
import {
  connectProject,
  ensureLayout,
  projectStatus,
  readLocalGraph,
  syncProject,
} from "../packages/context-cli/src/index.js";
import { createContextExtension, PI_COMMAND } from "../packages/context-pi/src/index.js";
import { GraphifyAdapter } from "../packages/graphify-adapter/src/index.js";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const WEB = "http://localhost:5173";
const COMMAND_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 10_000;
const STARTUP_TIMEOUT_MS = 20_000;
const COMMAND_OUTPUT_LIMIT = 1024 * 1024;
const PROCESS_OUTPUT_LIMIT = 64 * 1024;
const EXPECTED_COMMIT_A = "14e53285c954867aa267ba4127d59675418171de";
const EXPECTED_COMMIT_B = "93129d1e48dd4df5cbca458b2d205711e83e2698";
let apiOrigin = "";
const REPOSITORIES = {
  payments: "github.com/acme/payments-platform",
  identity: "github.com/acme/identity-platform",
  mobile: "github.com/acme/mobile-app",
};

// biome-ignore lint/suspicious/noExplicitAny: Cross-route response fields are asserted before use.
type Json = any;
type Evidence = { step: string; detail: string };
const evidence: Evidence[] = [];
let server: ChildProcess | undefined;
let stateRoot = "";
let repositoryRoot = "";
let isolatedHome = "";
let isolatedTemplates = "";
let pythonExecutable = "";

function childEnvironment(additional: Record<string, string> = {}): NodeJS.ProcessEnv {
  const executablePath = path.dirname(process.execPath);
  return {
    PATH: `${executablePath}:/usr/bin:/bin:/opt/homebrew/bin`,
    HOME: isolatedHome,
    TMPDIR: stateRoot,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TEMPLATE_DIR: isolatedTemplates,
    WRANGLER_SEND_METRICS: "false",
    NO_COLOR: "1",
    ...additional,
  };
}

function pass(step: string, detail: string) {
  evidence.push({ step, detail });
  console.log(`PASS ${step}: ${detail}`);
}

function assertNoForbiddenStrings(value: unknown, forbidden: string[]) {
  if (typeof value === "string") {
    for (const candidate of forbidden) assert.ok(!value.includes(candidate), `leaked ${candidate}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenStrings(item, forbidden);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) assertNoForbiddenStrings(item, forbidden);
  }
}

function assertContextEvidence(items: Json[], allowedProjects: Set<string>) {
  assert.ok(items.length > 0);
  for (const item of items) {
    assert.ok(["ARTIFACT", "GRAPH", "GIT", "REFERENCE"].includes(item.kind));
    assert.equal(item.kind, item.provenance.source);
    assert.ok(allowedProjects.has(item.provenance.projectId));
    assert.equal(typeof item.title, "string");
    assert.equal(typeof item.excerpt, "string");
    assert.equal(typeof item.relevanceReason, "string");
    assert.ok(Number.isInteger(item.tokenEstimate) && item.tokenEstimate >= 0);
    assert.ok(item.provenance.path === null || typeof item.provenance.path === "string");
    assert.ok(item.provenance.section === null || typeof item.provenance.section === "string");
    assert.ok(item.provenance.version === null || typeof item.provenance.version === "string");
    assert.ok(item.provenance.commit === null || /^[0-9a-f]{40}$/.test(item.provenance.commit));
    assert.ok(item.provenance.checksum === null || /^[0-9a-f]{64}$/.test(item.provenance.checksum));
  }
}

async function command(
  command: string,
  args: string[],
  cwd = ROOT,
  additionalEnv: Record<string, string> = {},
) {
  try {
    return await exec(command, args, {
      cwd,
      env: childEnvironment(additionalEnv),
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: COMMAND_OUTPUT_LIMIT,
    });
  } catch (error) {
    const detail = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
    };
    const output = [detail.stderr, detail.stdout, detail.message].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed (code=${detail.code ?? "unknown"}, signal=${detail.signal ?? "none"}): ${output}`,
    );
  }
}

async function request(
  pathname: string,
  options: {
    method?: string;
    cookie?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) {
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    headers.set("origin", headers.get("origin") ?? WEB);
  }
  const url = new URL(pathname, apiOrigin);
  assert.equal(url.origin, apiOrigin);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  return fetch(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers,
    body:
      options.body === undefined
        ? undefined
        : options.body instanceof Uint8Array
          ? options.body
          : JSON.stringify(options.body),
  });
}

async function expectJson(response: Response, status: number): Promise<Json> {
  const text = await response.text();
  assert.equal(response.status, status, `${response.url}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function cookieValue(response: Response, name: string) {
  const value = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${name}=([^;]+)`).exec(value);
  assert.ok(match?.[1], `missing ${name} cookie`);
  return `${name}=${match[1]}`;
}

async function oauth(identity: "admin" | "alice") {
  await expectJson(await request("/__e2e/control", { body: { identity } }), 200);
  const begin = await request("/auth/github");
  assert.equal(begin.status, 302);
  const stateCookie = cookieValue(begin, "context_hub_oauth_state");
  const state = new URL(begin.headers.get("location") ?? "").searchParams.get("state");
  assert.ok(state);
  const callback = await request(
    `/auth/github/callback?code=local-code&state=${encodeURIComponent(state)}`,
    {
      cookie: stateCookie,
    },
  );
  assert.equal(callback.status, 302);
  return cookieValue(callback, "context_hub_session");
}

async function createProject(cookie: string, workspaceId: string, name: string, slug: string) {
  const body = await expectJson(
    await request("/projects", {
      cookie,
      body: { workspaceId, name, slug, description: `${name} local E2E` },
    }),
    201,
  );
  return body.project.id as string;
}

async function connectRepository(cookie: string, projectId: string, repository: string) {
  const started = await expectJson(
    await request(`/projects/${projectId}/git`, {
      cookie,
      body: { repositoryUrl: `https://${repository}.git` },
    }),
    201,
  );
  const installState = new URL(started.installationUrl).searchParams.get("state");
  assert.ok(installState);
  const setup = await request(
    `/auth/github-app/setup?state=${encodeURIComponent(installState)}&setup_action=install&installation_id=42`,
    { cookie },
  );
  assert.equal(setup.status, 302);
  const pkce = cookieValue(setup, "context_hub_git_pkce");
  const authState = new URL(setup.headers.get("location") ?? "").searchParams.get("state");
  assert.ok(authState);
  const callback = await request(
    `/auth/github-app/callback?state=${encodeURIComponent(authState)}&code=local-code`,
    { cookie: `${cookie}; ${pkce}` },
  );
  assert.equal(callback.status, 302);
  const callbackLocation = callback.headers.get("location") ?? "";
  assert.equal(
    new URL(callbackLocation).searchParams.get("git"),
    "connected",
    `Git callback failed: ${callbackLocation}`,
  );
}

async function artifact(
  cookie: string,
  projectId: string,
  name: string,
  type: string,
  content: string,
  sourceCommitSha: string,
) {
  const body = await expectJson(
    await request(`/projects/${projectId}/artifacts`, {
      cookie,
      body: {
        name,
        type,
        description: `${name} source-backed context`,
        contentType: "text/markdown; charset=utf-8",
        content,
        sourceCommitSha,
        changeNote: "Local E2E publication",
      },
    }),
    201,
  );
  return {
    ...body.artifact,
    checksum: body.checksum,
    byteSize: new TextEncoder().encode(content).byteLength,
    contentType: "text/markdown;charset=utf-8",
    sourceCommitSha,
  };
}

function graphBytes(commit: string, version: number) {
  return new TextEncoder().encode(
    JSON.stringify({
      directed: false,
      multigraph: false,
      graph: {},
      nodes: [
        {
          id: `refund-retry-v${version}`,
          label: "RefundRetryPolicy",
          file_type: "ts",
          source_file: "src/refunds/retry.ts",
          source_location: "L1",
        },
        {
          id: `payment-worker-v${version}`,
          label: "PaymentWorker",
          file_type: "ts",
          source_file: "src/payments/worker.ts",
          source_location: "L1",
        },
      ],
      links: [
        {
          source: `payment-worker-v${version}`,
          target: `refund-retry-v${version}`,
          relation: "CALLS",
          confidence: "EXTRACTED",
          confidence_score: 1,
          weight: 1,
          source_file: "src/payments/worker.ts",
          source_location: "L1",
        },
      ],
      hyperedges: [],
      built_at_commit: commit,
    }),
  );
}

async function buildGraphWithAdapter(projectId: string, commit: string, version: number) {
  const bytes = graphBytes(commit, version);
  const graphifyExecutable = path.join(stateRoot, `graphify-${version}`);
  await writeFile(
    graphifyExecutable,
    `#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv[2] === "--version") process.stdout.write("graphify 0.9.58\\n");\nelse if (process.argv[2] === "cluster-only") fs.writeFileSync(process.env.GRAPHIFY_OUT + "/graph.json", Buffer.from("${Buffer.from(bytes).toString("base64")}", "base64"));\n`,
  );
  await chmod(graphifyExecutable, 0o700);
  const checkoutParent = await mkdtemp(path.join(stateRoot, "graph-checkout-"));
  const checkout = path.join(checkoutParent, "repository");
  try {
    await command("git", ["clone", "--no-local", repositoryRoot, checkout]);
    await command("git", ["switch", "--detach", commit], checkout);
    const adapter = new GraphifyAdapter({
      gitExecutable: "/usr/bin/git",
      pythonExecutable,
      graphifyExecutable: await realpath(graphifyExecutable),
      tempRoot: stateRoot,
    });
    return await adapter.build({
      checkoutPath: checkout,
      projectId,
      repositoryProvider: "github",
      providerRepositoryId: "repo-acme-payments-platform",
      repositoryIdentitySnapshot: {
        provider: "github",
        providerRepositoryId: "repo-acme-payments-platform",
        owner: "acme",
        name: "payments-platform",
        canonicalUrl: REPOSITORIES.payments,
      },
      sourceCommitSha: commit,
      executorPolicy: {
        attested: true,
        memoryLimitBytes: 512 * 1024 * 1024,
        diskLimitBytes: 1024 * 1024 * 1024,
      },
    });
  } finally {
    await rm(checkoutParent, { recursive: true, force: true });
  }
}

async function publishGraph(
  cookie: string,
  projectId: string,
  commit: string,
  version: number,
  token: string,
) {
  const reserved = await expectJson(
    await request(`/projects/${projectId}/graphs/build`, { cookie, body: {} }),
    202,
  );
  assert.equal(reserved.graph.version, version);
  const baseHeaders = {
    "x-context-repository-provider": "github",
    "x-context-repository-id": "repo-acme-payments-platform",
    "x-context-source-commit": commit,
  };
  const claimed = await expectJson(
    await request(`/machine/projects/${projectId}/graphs/${version}/claim`, {
      method: "POST",
      token,
      headers: { ...baseHeaders, "x-context-nonce": `claim_nonce_${version}_1234567890` },
    }),
    200,
  );
  const built = await buildGraphWithAdapter(projectId, commit, version);
  const bytes = built.bytes;
  const checksum = built.contentChecksumSha256;
  const claim = claimed.claim;
  const published = await expectJson(
    await request(`/machine/projects/${projectId}/graphs/${version}/publish`, {
      method: "PUT",
      token,
      body: bytes,
      headers: {
        ...baseHeaders,
        "content-type": "application/json",
        "content-length": String(bytes.byteLength),
        "x-context-nonce": `publish_nonce_${version}_1234567890`,
        "x-context-attempt": String(claim.attempt),
        "x-context-lease-id": claim.leaseId,
        "x-context-publication-id": claim.publicationId,
        "x-context-checksum-sha256": checksum,
        "x-context-node-count": "2",
        "x-context-link-count": "1",
        "x-context-hyperedge-count": "0",
      },
    }),
    200,
  );
  assert.equal(published.graph.checksum, checksum);
  assert.equal(built.sourceCommitSha, commit);
  assert.equal(built.generator, "graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1");
  return { bytes, checksum, claim, graph: published.graph };
}

async function mcp(token: string, method: string, params: Json, id = 1) {
  return request("/mcp", {
    method: "POST",
    token,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-context-nonce": randomUUID(),
    },
    body: { jsonrpc: "2.0", id, method, params },
  });
}

async function resolvePython() {
  const hostPaths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = [
    ...hostPaths.flatMap((directory) => [
      path.join(directory, "python3.12"),
      path.join(directory, "python3.11"),
    ]),
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.11",
    "/usr/local/bin/python3.12",
    "/usr/local/bin/python3.11",
  ];
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, fsConstants.X_OK);
      const canonical = await realpath(candidate);
      const version = (await command(canonical, ["--version"])).stdout.trim();
      if (/^Python 3\.(?:11|12)\./.test(version)) return canonical;
    } catch {
      // Continue through the bounded local candidate set.
    }
  }
  throw new Error("Python 3.11 or 3.12 is required for the local Graphify adapter E2E");
}

async function reservePort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    release: () =>
      new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function terminateProcessGroup(child: ChildProcess, graceMs = 2_000) {
  if (!child.pid) return;
  const groupExists = () => {
    try {
      process.kill(-(child.pid as number), 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + graceMs;
  while (groupExists() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  if (groupExists()) process.kill(-child.pid, "SIGKILL");
  const reapDeadline = Date.now() + 2_000;
  while (groupExists() && Date.now() < reapDeadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  if (groupExists()) throw new Error("process group did not exit");
}

function spawnWrangler(port: number, runId: string) {
  return spawn(
    path.join(ROOT, "node_modules/.bin/wrangler"),
    [
      "dev",
      "scripts/e2e-worker.ts",
      "--local",
      "--config",
      "apps/api/wrangler.toml",
      "--persist-to",
      stateRoot,
      "--port",
      String(port),
      "--var",
      `E2E_RUN_ID:${runId}`,
      "--log-level",
      "error",
    ],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnvironment(),
    },
  );
}

async function startWrangler(port: number) {
  const runId = randomUUID();
  const child = spawnWrangler(port, runId);
  let stdout = "";
  let stderr = "";
  let overflow = false;
  const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
    if (target === "stdout") stdout += chunk.toString();
    else stderr += chunk.toString();
    if (stdout.length + stderr.length > PROCESS_OUTPUT_LIMIT) {
      overflow = true;
      void terminateProcessGroup(child);
    }
  };
  child.stdout?.on("data", (chunk) => capture("stdout", chunk));
  child.stderr?.on("data", (chunk) => capture("stderr", chunk));
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (overflow) throw new Error("wrangler exceeded the bounded startup output limit");
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`wrangler exited early: ${stderr || stdout}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/__e2e/identity`, {
          signal: AbortSignal.timeout(500),
        });
        const identity = (await response.json()) as { runId?: string };
        if (response.status === 200 && identity.runId === runId) {
          if (stderr.trim()) throw new Error(`wrangler wrote unexpected stderr: ${stderr}`);
          return child;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("wrangler wrote")) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`wrangler startup timed out: ${stderr || stdout}`);
  } catch (error) {
    await terminateProcessGroup(child);
    throw error;
  }
}

async function verifyHarnessLifecycle() {
  const occupied = await reservePort();
  const conflict = spawnWrangler(occupied.port, randomUUID());
  let conflictOutput = "";
  conflict.stdout?.on("data", (chunk) => (conflictOutput += chunk.toString()));
  conflict.stderr?.on("data", (chunk) => (conflictOutput += chunk.toString()));
  const conflictExited = await Promise.race([
    new Promise<boolean>((resolve) => conflict.once("exit", () => resolve(true))),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  await terminateProcessGroup(conflict, 100);
  await occupied.release();
  assert.equal(
    conflictExited,
    true,
    `wrangler did not fail fast on an occupied port: ${conflictOutput}`,
  );
  assert.notEqual(conflict.exitCode, 0, "occupied-port wrangler unexpectedly succeeded");

  const sleeper = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30 & wait"], {
    detached: true,
    stdio: "ignore",
    env: childEnvironment(),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await terminateProcessGroup(sleeper, 100);
  assert.ok(sleeper.exitCode !== null || sleeper.signalCode !== null);
  pass(
    "harness-lifecycle",
    "migration failures reject, occupied-port startup fails, and timed-out process groups are reaped",
  );
}

async function withCliEnvironment<T>(session: string, token: string, operation: () => Promise<T>) {
  const previous = {
    session: process.env.CONTEXT_HUB_SESSION,
    api: process.env.CONTEXT_HUB_API,
    token: process.env.CONTEXT_HUB_MCP_TOKEN,
  };
  process.env.CONTEXT_HUB_SESSION = session;
  process.env.CONTEXT_HUB_API = apiOrigin;
  process.env.CONTEXT_HUB_MCP_TOKEN = token;
  try {
    return await operation();
  } finally {
    if (previous.session === undefined) delete process.env.CONTEXT_HUB_SESSION;
    else process.env.CONTEXT_HUB_SESSION = previous.session;
    if (previous.api === undefined) delete process.env.CONTEXT_HUB_API;
    else process.env.CONTEXT_HUB_API = previous.api;
    if (previous.token === undefined) delete process.env.CONTEXT_HUB_MCP_TOKEN;
    else process.env.CONTEXT_HUB_MCP_TOKEN = previous.token;
  }
}

async function setupRuntime() {
  stateRoot = await mkdtemp(path.join(tmpdir(), "context-hub-e2e-state-"));
  repositoryRoot = await mkdtemp(path.join(tmpdir(), "context-hub-e2e-repo-"));
  isolatedHome = path.join(stateRoot, "home");
  isolatedTemplates = path.join(stateRoot, "git-templates");
  await mkdir(isolatedHome, { recursive: true });
  await mkdir(isolatedTemplates, { recursive: true });
  await command(
    "git",
    ["init", "--object-format=sha1", "--initial-branch=main", `--template=${isolatedTemplates}`],
    repositoryRoot,
  );
  await command("git", ["config", "user.name", "Context Hub E2E"], repositoryRoot);
  await command("git", ["config", "user.email", "e2e@context-hub.invalid"], repositoryRoot);
  await command("git", ["config", "commit.gpgsign", "false"], repositoryRoot);
  await command("git", ["config", "core.hooksPath", isolatedTemplates], repositoryRoot);
  await command("git", ["config", "core.autocrlf", "false"], repositoryRoot);
  await command("git", ["config", "core.filemode", "false"], repositoryRoot);
  pythonExecutable = await resolvePython();
  await command(
    "git",
    ["remote", "add", "origin", "https://github.com/acme/payments-platform.git"],
    repositoryRoot,
  );
  await mkdir(path.join(repositoryRoot, "src/refunds"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "src/payments"), { recursive: true });
  await writeFile(
    path.join(repositoryRoot, "src/refunds/retry.ts"),
    "export const refundRetryLimit = 0;\n",
  );
  await writeFile(
    path.join(repositoryRoot, "src/payments/worker.ts"),
    "export function runPaymentWorker() { return true; }\n",
  );
  await writeFile(path.join(repositoryRoot, ".gitignore"), ".ai-context/\n");
  await command("git", ["add", "src", ".gitignore"], repositoryRoot);
  await command("git", ["commit", "-m", "commit A"], repositoryRoot, {
    GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
  });
  const commitA = (await command("git", ["rev-parse", "HEAD"], repositoryRoot)).stdout.trim();
  assert.equal(commitA, EXPECTED_COMMIT_A, "deterministic commit A changed");

  await assert.rejects(
    command(path.join(ROOT, "node_modules/.bin/wrangler"), [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      path.join(stateRoot, "missing-wrangler.toml"),
    ]),
    /failed/,
  );
  await command(path.join(ROOT, "node_modules/.bin/wrangler"), [
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    "apps/api/wrangler.toml",
    "--persist-to",
    stateRoot,
  ]);
  await verifyHarnessLifecycle();
  const reservation = await reservePort();
  apiOrigin = `http://127.0.0.1:${reservation.port}`;
  await reservation.release();
  server = await startWrangler(reservation.port);
  return commitA;
}

async function main() {
  const commitA = await setupRuntime();
  await expectJson(await request("/__e2e/control", { body: { commit: commitA } }), 200);

  const admin = await oauth("admin");
  pass(
    "1",
    "admin authenticated through the production HTTP OAuth callback with injected provider responses",
  );
  const workspace = await expectJson(
    await request("/workspaces", { cookie: admin, body: { name: "Acme", slug: "acme" } }),
    201,
  );
  const workspaceId = workspace.workspace.id as string;
  const payments = await createProject(
    admin,
    workspaceId,
    "Payments Platform",
    "payments-platform",
  );
  const identity = await createProject(
    admin,
    workspaceId,
    "Identity Platform",
    "identity-platform",
  );
  const mobile = await createProject(admin, workspaceId, "Mobile App", "mobile-app");
  pass("2", `created Payments Platform (${payments}) in Acme with Identity and Mobile peers`);

  await connectRepository(admin, payments, REPOSITORIES.payments);
  pass(
    "3",
    "connected normalized GitHub repository through the injected GitProvider contract and production routes",
  );
  const architecture = await artifact(
    admin,
    payments,
    "Payments Architecture",
    "architecture",
    "# Payments Architecture\nRefund work belongs in src/refunds and calls the payment worker.\n",
    commitA,
  );
  pass("4", `published immutable architecture artifact ${architecture.id} v1`);
  const refundAdr = await artifact(
    admin,
    payments,
    "Refund Retry ADR",
    "adr",
    "# Refund Retry\nRetry transient refund failures twice with idempotency keys; never retry permanent declines.\n",
    commitA,
  );
  pass("5", `published immutable refund ADR ${refundAdr.id} v1`);

  const machineIssued = await expectJson(
    await request(`/projects/${payments}/machine-credentials`, {
      cookie: admin,
      body: { name: "Local canonical Graphify seam", expiresInDays: 1 },
    }),
    201,
  );
  const machineToken = machineIssued.token as string;
  const graphV1 = await publishGraph(admin, payments, commitA, 1, machineToken);
  pass(
    "6",
    `reserved, format-validated, checksummed, and machine-published graph v1 at commit ${commitA}`,
  );

  const alice = await oauth("alice");
  const invited = await expectJson(
    await request(`/projects/${payments}/team`, {
      cookie: admin,
      body: { username: "alice", role: "EDITOR" },
    }),
    201,
  );
  pass("7", `invited current provider identity alice as EDITOR (${invited.invitation.id})`);
  const accepted = await expectJson(
    await request(`/invitations/${invited.invitation.id}/accept`, { cookie: alice, body: {} }),
    200,
  );
  assert.equal(accepted.invitation.role, "EDITOR");
  pass("8", "alice accepted the exact invitation and intended EDITOR role");

  const mcpIssued = await expectJson(
    await request("/mcp-credentials", {
      cookie: admin,
      body: {
        name: "Payments local client",
        projectIds: [payments],
        operations: ["project_info", "search_context", "query_graph", "sync_status"],
        repository: `https://${REPOSITORIES.payments}.git`,
        expiresInDays: 1,
      },
    }),
    201,
  );
  const mcpToken = mcpIssued.token as string;
  const fetchImplementation: typeof fetch = fetch;
  const manifest = await connectProject({
    directory: repositoryRoot,
    apiOrigin: apiOrigin,
    session: decodeURIComponent(alice.split("=")[1] ?? ""),
    fetchImplementation,
  });
  assert.equal(manifest.projectId, payments);
  const aliceSession = decodeURIComponent(alice.split("=")[1] ?? "");
  const initialSyncOutput: string[] = [];
  await withCliEnvironment(aliceSession, mcpToken, () =>
    runCli(["sync"], repositoryRoot, (value) => initialSyncOutput.push(value)),
  );
  const initialSync = JSON.parse(initialSyncOutput.at(-1) ?? "null");
  assert.deepEqual(initialSync, {
    synced: true,
    projectId: payments,
    graphVersion: 1,
    reporting: "REPORTED",
  });
  assert.equal((await readLocalGraph(await ensureLayout(repositoryRoot)))?.metadata.version, 1);
  pass(
    "9",
    "actual context-cli sync atomically cached graph v1 and reported sync telemetry through the real HTTP client",
  );

  type LocalPiContext = {
    cwd: string;
    hasUI: boolean;
    ui: {
      notify(message: string): void;
      select(): Promise<undefined>;
      setStatus(): void;
    };
  };
  let registered:
    | { description: string; handler(args: string, context: LocalPiContext): Promise<void> }
    | undefined;
  const notifications: string[] = [];
  const extension = createContextExtension({
    env: {
      CONTEXT_HUB_API: apiOrigin,
      CONTEXT_HUB_SESSION: decodeURIComponent(alice.split("=")[1] ?? ""),
      CONTEXT_HUB_MCP_TOKEN: mcpToken,
    },
    fetchImplementation,
  });
  extension({
    registerCommand(name, command) {
      assert.equal(name, PI_COMMAND.name);
      registered = command;
    },
    on() {},
  });
  assert.ok(registered);
  const piContext = {
    cwd: repositoryRoot,
    hasUI: false,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async () => undefined,
      setStatus() {},
    },
  };
  await registered.handler("connect", piContext);
  pass(
    "10",
    "actual context-pi extension registered one native command and dispatched connect without tool/model/prompt hooks",
  );
  await registered.handler("search refund retry", piContext);
  pass("11", "developer dispatched the refund retry question through the native Pi command");
  const piSearch = JSON.parse(notifications.at(-1) ?? "null");
  const piSerialized = JSON.stringify(piSearch);
  assert.match(piSerialized, /Refund Retry|refund/i);
  assert.ok(Array.isArray(piSearch.evidence));
  assertContextEvidence(piSearch.evidence, new Set([payments]));
  assertNoForbiddenStrings(piSearch, [
    identity,
    mobile,
    "Identity Platform",
    "Mobile App",
    REPOSITORIES.identity,
    REPOSITORIES.mobile,
  ]);
  assert.ok(new TextEncoder().encode(piSerialized).byteLength <= 32 * 1024);
  pass(
    "12",
    "Pi used actual MCP/ContextEngine retrieval with bounded Payments-only source provenance",
  );

  await writeFile(
    path.join(repositoryRoot, "src/refunds/retry.ts"),
    "export const refundRetryLimit = 2;\n",
  );
  await command("git", ["add", "src/refunds/retry.ts"], repositoryRoot);
  await command("git", ["commit", "-m", "implement refund retry"], repositoryRoot, {
    GIT_AUTHOR_DATE: "2025-01-02T00:00:00Z",
    GIT_COMMITTER_DATE: "2025-01-02T00:00:00Z",
  });
  const commitB = (await command("git", ["rev-parse", "HEAD"], repositoryRoot)).stdout.trim();
  assert.equal(commitB, EXPECTED_COMMIT_B, "deterministic commit B changed");
  pass("13", "implemented refund retry in the isolated real repository");
  pass("14", `created deterministic feature commit B ${commitB}`);
  await expectJson(await request("/__e2e/control", { body: { commit: commitB } }), 200);
  await expectJson(
    await request(`/projects/${payments}/git/sync`, { cookie: admin, body: {} }),
    200,
  );
  const graphV2 = await publishGraph(admin, payments, commitB, 2, machineToken);
  pass("15", "reserved and built validated graph v2 against verified commit B");
  pass("16", `machine-published immutable graph v2 checksum ${graphV2.checksum}`);

  const stale = await projectStatus({
    directory: repositoryRoot,
    session: decodeURIComponent(alice.split("=")[1] ?? ""),
    credentialApiOrigin: apiOrigin,
    fetchImplementation,
  });
  assert.equal(stale.state, "REMOTE_GRAPH_AHEAD");
  pass("17", "CLI classified cached v1 as REMOTE_GRAPH_AHEAD from verified server truth");
  await syncProject({
    directory: repositoryRoot,
    session: decodeURIComponent(alice.split("=")[1] ?? ""),
    credentialApiOrigin: apiOrigin,
    fetchImplementation,
  });
  const localV2 = await readLocalGraph(await ensureLayout(repositoryRoot));
  assert.equal(localV2?.metadata.version, 2);
  assert.equal(localV2?.metadata.checksum, graphV2.checksum);
  pass("18", "CLI atomically replaced the verified cache with graph v2");

  const replayV1 = await expectJson(
    await request(`/machine/projects/${payments}/graphs/1/publish`, {
      method: "PUT",
      token: machineToken,
      body: graphV1.bytes,
      headers: {
        "x-context-repository-provider": "github",
        "x-context-repository-id": "repo-acme-payments-platform",
        "x-context-source-commit": commitA,
        "content-type": "application/json",
        "content-length": String(graphV1.bytes.byteLength),
        "x-context-nonce": "replay_v1_nonce_1234567890",
        "x-context-attempt": String(graphV1.claim.attempt),
        "x-context-lease-id": graphV1.claim.leaseId,
        "x-context-publication-id": graphV1.claim.publicationId,
        "x-context-checksum-sha256": graphV1.checksum,
        "x-context-node-count": "2",
        "x-context-link-count": "1",
        "x-context-hyperedge-count": "0",
      },
    }),
    200,
  );
  assert.equal(replayV1.graph.checksum, graphV1.checksum);
  const queriedV1 = await expectJson(
    await request(`/projects/${payments}/graphs/1/query`, {
      cookie: alice,
      body: { operation: "search", query: "RefundRetryPolicy", limit: 5 },
    }),
    200,
  );
  assert.equal(queriedV1.graph.status, "SUPERSEDED");
  assert.equal(queriedV1.graph.checksum, graphV1.checksum);
  pass(
    "19",
    "exact graph v1 publication replay and explorer retrieval revalidated immutable stored bytes/checksum after supersession",
  );

  const snapshot = await expectJson(
    await request(`/projects/${payments}/snapshots`, {
      cookie: admin,
      body: {
        name: "Refund retry release",
        gitSha: commitB,
        graphVersion: 2,
        artifacts: [
          { artifactId: architecture.id, version: 1 },
          { artifactId: refundAdr.id, version: 1 },
        ],
        idempotencyKey: "refund-retry-release",
      },
    }),
    201,
  );
  const snapshotResponse = await request(
    `/projects/${payments}/snapshots/${snapshot.snapshot.id}/manifest`,
    { cookie: alice },
  );
  assert.equal(snapshotResponse.status, 200);
  assert.equal(snapshotResponse.headers.get("content-type"), "application/json");
  const snapshotBytes = new Uint8Array(await snapshotResponse.arrayBuffer());
  const snapshotChecksum = createHash("sha256").update(snapshotBytes).digest("hex");
  assert.equal(snapshotResponse.headers.get("x-content-sha256"), snapshotChecksum);
  assert.equal(snapshot.snapshot.manifest.checksum, snapshotChecksum);
  assert.equal(snapshot.snapshot.manifest.byteSize, snapshotBytes.byteLength);
  const snapshotManifest = JSON.parse(new TextDecoder().decode(snapshotBytes));
  assert.equal(snapshotManifest.formatVersion, 1);
  assert.equal(snapshotManifest.snapshotId, snapshot.snapshot.id);
  assert.equal(snapshotManifest.projectId, payments);
  assert.equal(snapshotManifest.name, "Refund retry release");
  assert.equal(snapshotManifest.gitSha, commitB);
  assert.equal(snapshotManifest.graph.version, 2);
  assert.equal(snapshotManifest.graph.sourceCommitSha, commitB);
  assert.equal(snapshotManifest.graph.checksum, graphV2.checksum);
  assert.equal(snapshotManifest.graph.publicationId, graphV2.claim.publicationId);
  assert.equal(snapshotManifest.graph.publishedAttempt, graphV2.claim.attempt);
  assert.equal(snapshotManifest.graph.publishedLeaseId, graphV2.claim.leaseId);
  assert.deepEqual(snapshotManifest.graph.repository, {
    provider: "github",
    providerRepositoryId: "repo-acme-payments-platform",
    owner: "acme",
    name: "payments-platform",
    canonicalUrl: REPOSITORIES.payments,
  });
  assert.equal(snapshotManifest.graph.graphifyVersion, "0.9.58");
  assert.equal(snapshotManifest.graph.adapterVersion, "1.0.0");
  assert.equal(snapshotManifest.graph.profile, "code-only-clustered-v1");
  assert.equal(snapshotManifest.graph.formatVersion, 1);
  assert.equal(
    snapshotManifest.graph.generator,
    "graphify/0.9.58 context-hub-adapter/1.0.0 code-only-clustered-v1",
  );
  const expectedArtifacts = new Map([
    [architecture.id, architecture],
    [refundAdr.id, refundAdr],
  ]);
  assert.equal(snapshotManifest.artifacts.length, 2);
  for (const reference of snapshotManifest.artifacts) {
    const expected = expectedArtifacts.get(reference.artifactId);
    assert.ok(expected);
    assert.equal(reference.version, 1);
    assert.equal(reference.type, expected.type);
    assert.equal(reference.checksum, expected.checksum);
    assert.equal(reference.byteSize, expected.byteSize);
    assert.equal(reference.contentType, expected.contentType);
    assert.equal(reference.sourceCommitSha, commitA);
    expectedArtifacts.delete(reference.artifactId);
  }
  assert.equal(expectedArtifacts.size, 0);
  pass(
    "20",
    "snapshot retrieval reverified commit B, graph v2, and both exact active artifact versions",
  );

  const activity = await expectJson(
    await request(`/projects/${payments}/activity`, { cookie: alice }),
    200,
  );
  assert.ok(activity.events.some((event: Json) => event.action === "GIT_CONNECTED"));
  assert.ok(activity.events.some((event: Json) => event.action === "GIT_SYNCED"));
  assert.ok(activity.events.some((event: Json) => event.action === "GRAPH_PUBLISHED"));
  assert.ok(activity.events.some((event: Json) => event.action === "SNAPSHOT_CREATED"));
  const team = await expectJson(
    await request(`/projects/${payments}/team`, { cookie: alice }),
    200,
  );
  assert.ok(
    team.members.some((member: Json) => member.username === "alice" && member.role === "EDITOR"),
  );
  const cliOutput: string[] = [];
  await withCliEnvironment(aliceSession, mcpToken, () =>
    runCli(["status"], repositoryRoot, (value) => cliOutput.push(value)),
  );
  const cliStatus = JSON.parse(cliOutput.at(-1) ?? "null");
  assert.equal(cliStatus.state, "CURRENT");
  assert.equal(cliStatus.reporting, "REPORTED");
  const currentSync = await expectJson(
    await request(`/projects/${payments}/sync-states/current`, { cookie: alice }),
    200,
  );
  assert.equal(currentSync.syncState.projectId, payments);
  assert.equal(currentSync.syncState.status, "CURRENT");
  assert.equal(currentSync.syncState.reportOutcome, "STATUS");
  assert.equal(currentSync.syncState.clientKind, "CONTEXT_CLI");
  const syncAudit = await expectJson(
    await request(`/projects/${payments}/activity?action=SYNC_STATE_REPORTED`, { cookie: alice }),
    200,
  );
  assert.ok(syncAudit.events.length >= 2);
  assert.ok(
    syncAudit.events.every(
      (event: Json) =>
        event.id.startsWith("sync_state:sync:") &&
        event.actor.kind === "MCP" &&
        event.target.type === "SYNC_CLIENT" &&
        event.action === "SYNC_STATE_REPORTED" &&
        event.outcome === "SUCCEEDED",
    ),
  );
  pass(
    "audit/freshness/team",
    "general audit, CURRENT cache freshness, and accepted team membership evidence are present",
  );

  await writeFile(
    path.join(repositoryRoot, "cache-safety-probe.ts"),
    "export const probe = true;\n",
  );
  await command("git", ["add", "cache-safety-probe.ts"], repositoryRoot);
  await command("git", ["commit", "-m", "cache safety probe"], repositoryRoot, {
    GIT_AUTHOR_DATE: "2025-01-03T00:00:00Z",
    GIT_COMMITTER_DATE: "2025-01-03T00:00:00Z",
  });
  const probeCommit = (await command("git", ["rev-parse", "HEAD"], repositoryRoot)).stdout.trim();
  await expectJson(await request("/__e2e/control", { body: { commit: probeCommit } }), 200);
  await expectJson(
    await request(`/projects/${payments}/git/sync`, { cookie: admin, body: {} }),
    200,
  );
  await publishGraph(admin, payments, probeCommit, 3, machineToken);
  const corruptDownloadFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith(`/projects/${payments}/sync/graph/3`)) {
      return new Response("corrupt", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "7" },
      });
    }
    return fetchImplementation(input, init);
  };
  await assert.rejects(
    syncProject({
      directory: repositoryRoot,
      session: decodeURIComponent(alice.split("=")[1] ?? ""),
      credentialApiOrigin: apiOrigin,
      fetchImplementation: corruptDownloadFetch,
    }),
    /GRAPH_METADATA_MISMATCH|GRAPH_INTEGRITY_ERROR|INVALID_RESPONSE/,
  );
  const preservedV2 = await readLocalGraph(await ensureLayout(repositoryRoot));
  assert.equal(preservedV2?.metadata.version, 2);
  assert.equal(preservedV2?.metadata.checksum, graphV2.checksum);
  pass(
    "rollback/cache-safety",
    "actual CLI rejected a corrupt newer download and preserved the previously verified v2 selection",
  );

  await connectRepository(admin, identity, REPOSITORIES.identity);
  await connectRepository(admin, mobile, REPOSITORIES.mobile);
  const identityArtifact = await artifact(
    admin,
    identity,
    "Identity Retry Contract",
    "api-contract",
    "# Identity retry\nIdentity token renewal retries once after a transient provider timeout.\n",
    commitB,
  );
  const identityInvite = await expectJson(
    await request(`/projects/${identity}/team`, {
      cookie: admin,
      body: { username: "alice", role: "VIEWER" },
    }),
    201,
  );
  await expectJson(
    await request(`/invitations/${identityInvite.invitation.id}/accept`, {
      cookie: alice,
      body: {},
    }),
    200,
  );
  const aliceProjects = await expectJson(await request("/projects", { cookie: alice }), 200);
  assert.deepEqual(
    aliceProjects.projects.map((project: Json) => project.id).sort(),
    [identity, payments].sort(),
  );
  pass(
    "multi-membership",
    "Alice is a workspace member but a direct member only of Payments and Identity",
  );

  const resolvePayments = await expectJson(
    await request(
      `/projects/resolve?repository=${encodeURIComponent(`https://${REPOSITORIES.payments}.git`)}`,
      { cookie: alice },
    ),
    200,
  );
  const resolveIdentity = await expectJson(
    await request(
      `/projects/resolve?repository=${encodeURIComponent(`git@github.com:acme/identity-platform.git`)}`,
      { cookie: alice },
    ),
    200,
  );
  assert.equal(resolvePayments.project.id, payments);
  assert.equal(resolveIdentity.project.id, identity);
  await command(
    "git",
    ["remote", "set-url", "origin", "https://github.com/acme/identity-platform.git"],
    repositoryRoot,
  );
  const autoIdentity = await connectProject({
    directory: repositoryRoot,
    apiOrigin: apiOrigin,
    session: aliceSession,
    fetchImplementation,
  });
  assert.equal(autoIdentity.projectId, identity);
  await command(
    "git",
    ["remote", "set-url", "origin", "https://github.com/acme/payments-platform.git"],
    repositoryRoot,
  );
  await connectProject({
    directory: repositoryRoot,
    apiOrigin: apiOrigin,
    session: decodeURIComponent(alice.split("=")[1] ?? ""),
    projectId: payments,
    fetchImplementation,
  });
  pass(
    "multi-resolution",
    "actual CLI remote discovery auto-resolved both repository identities before explicit switching back to Payments",
  );

  const paymentsSearch = await expectJson(
    await request(`/projects/${payments}/context/search`, {
      cookie: alice,
      body: { query: "refund retry", budget: { maxTokens: 1000, maxBytes: 12000 } },
    }),
    200,
  );
  assert.equal(paymentsSearch.projectId, payments);
  assert.deepEqual(paymentsSearch.sourceErrors, []);
  assertContextEvidence(paymentsSearch.evidence, new Set([payments]));
  assertNoForbiddenStrings(paymentsSearch, [
    identity,
    mobile,
    identityArtifact.id,
    "Identity Retry Contract",
    "Identity token renewal retries once",
    REPOSITORIES.identity,
    REPOSITORIES.mobile,
  ]);
  const identitySearch = await expectJson(
    await request(`/projects/${identity}/context/search`, {
      cookie: alice,
      body: { query: "identity retry", budget: { maxTokens: 1000, maxBytes: 12000 } },
    }),
    200,
  );
  assert.equal(identitySearch.projectId, identity);
  assert.deepEqual(identitySearch.sourceErrors, []);
  assertContextEvidence(identitySearch.evidence, new Set([identity]));
  assertNoForbiddenStrings(identitySearch, [
    payments,
    mobile,
    refundAdr.id,
    "Refund Retry ADR",
    "Retry transient refund failures twice",
    REPOSITORIES.payments,
    REPOSITORIES.mobile,
  ]);
  pass(
    "multi-isolation",
    "production single-project ContextEngine searches isolate Payments and Identity sources",
  );

  const combined = await expectJson(
    await request("/context/cross-project/search", {
      cookie: alice,
      body: {
        projectIds: [payments, identity],
        query: "retry",
        budget: { maxTokens: 1800, maxBytes: 18000, maxSources: 8 },
      },
    }),
    200,
  );
  const combinedText = JSON.stringify(combined);
  assert.deepEqual(new Set(combined.projectIds), new Set([payments, identity]));
  assert.deepEqual(combined.sourceErrors, []);
  assertContextEvidence(combined.evidence, new Set([payments, identity]));
  const combinedProvenance = new Set(
    combined.evidence.map((item: Json) => item.provenance.projectId),
  );
  assert.deepEqual(combinedProvenance, new Set([payments, identity]));
  assert.ok(combined.tokenEstimate <= 1800 && combined.byteSize <= 18000);
  assert.ok(new TextEncoder().encode(combinedText).byteLength <= 18000);
  pass(
    "multi-combined",
    "one cross-project ContextEngine call used a single global budget and retained both project provenances",
  );

  const denied = await request("/context/cross-project/search", {
    cookie: alice,
    body: {
      projectIds: [payments, mobile],
      query: "retry",
      budget: { maxTokens: 1800, maxBytes: 18000, maxSources: 8 },
    },
  });
  const deniedText = await denied.text();
  assert.equal(denied.status, 404);
  assert.deepEqual(JSON.parse(deniedText), { error: "NOT_FOUND" });
  pass(
    "multi-denial",
    "Payments+Mobile failed all-or-nothing without inaccessible ID/name/repository/source leakage",
  );

  const tools = await expectJson(await mcp(mcpToken, "tools/list", {}), 200);
  assert.equal(tools.result.tools.length, 6);
  assert.deepEqual(tools.result.tools, MCP_TOOLS);
  const schemaDigest = createHash("sha256").update(JSON.stringify(MCP_TOOLS)).digest("hex");
  const secondTools = await expectJson(await mcp(mcpToken, "tools/list", {}, 2), 200);
  assert.equal(
    createHash("sha256").update(JSON.stringify(secondTools.result.tools)).digest("hex"),
    schemaDigest,
  );
  pass(
    "six-tool-invariant",
    `actual MCP tools/list remains six tools with stable schema digest ${schemaDigest}`,
  );

  const revokedId = mcpIssued.credential.credentialId as string;
  assert.match(revokedId, /^[0-9a-f-]{36}$/);
  const revokeResponse = await request(`/mcp-credentials/${revokedId}`, {
    method: "DELETE",
    cookie: admin,
    headers: { origin: WEB },
  });
  assert.equal(revokeResponse.status, 204, await revokeResponse.text());
  const repeatedRevoke = await request(`/mcp-credentials/${revokedId}`, {
    method: "DELETE",
    cookie: admin,
    headers: { origin: WEB },
  });
  assert.equal(repeatedRevoke.status, 404);
  const revoked = await mcp(mcpToken, "tools/list", {});
  assert.equal(revoked.status, 401);
  assert.deepEqual(await revoked.json(), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32001, message: "INVALID_CREDENTIAL" },
  });
  const revokeAudit = await expectJson(
    await request(`/projects/${payments}/activity?action=MCP_CREDENTIAL_REVOKED`, {
      cookie: alice,
    }),
    200,
  );
  assert.equal(revokeAudit.events.length, 1);
  assert.equal(revokeAudit.events[0].action, "MCP_CREDENTIAL_REVOKED");
  assert.equal(revokeAudit.events[0].actor.kind, "HUMAN");
  assert.equal(revokeAudit.events[0].target.type, "MCP_CREDENTIAL");
  assert.equal(revokeAudit.events[0].target.id, revokedId);
  assert.equal(revokeAudit.events[0].outcome, "SUCCEEDED");
  pass(
    "authorization/revocation",
    "revocation emitted exact audit evidence and the same credential failed immediately without replacement",
  );

  const allOutput = JSON.stringify({ evidence, notifications, combined, deniedText, schemaDigest });
  assert.ok(!allOutput.includes(machineToken) && !allOutput.includes(mcpToken));
  assert.ok(!/chm(?:cp)?_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/.test(allOutput));
  pass(
    "no-secret-leakage",
    "scenario output, Pi notifications, MCP results, and denials contain no issued credential",
  );

  console.log(
    `E2E_LOCAL_OK commitA=${commitA} commitB=${commitB} payments=${payments} snapshot=${snapshot.snapshot.id}`,
  );
}

async function run() {
  try {
    await main();
  } finally {
    if (server) await terminateProcessGroup(server);
    await Promise.all([
      stateRoot ? rm(stateRoot, { recursive: true, force: true }) : Promise.resolve(),
      repositoryRoot ? rm(repositoryRoot, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
