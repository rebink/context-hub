#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { measureMcpTokenAudit } from "../apps/api/scripts/mcp-token-audit-lib.ts";
import { createApp, type Env } from "../apps/api/src/index.ts";
import { MCP_LIMITS, MCP_TOOL_NAMES, MCP_TOOLS } from "../apps/api/src/mcp-transport.ts";
import {
  matchRouteContract,
  ROUTE_CONTRACTS,
  type RouteAuthorization,
} from "../apps/api/src/route-contract.ts";
import { measurePiTokenAudit } from "../packages/context-pi/scripts/pi-token-audit-lib.ts";

const root = resolve(import.meta.dirname, "..");
const failures: string[] = [];
const runRoot = mkdtempSync(join(realpathSync("/tmp"), "ch-qa-"));
const isolatedHome = join(runRoot, "home");
const isolatedTmp = join(runRoot, "tmp");
mkdirSync(isolatedHome);
mkdirSync(isolatedTmp);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) failures.push(message);
}

function filesBelow(directory: string, suffix: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path, suffix) : path.endsWith(suffix) ? [path] : [];
    })
    .sort();
}

function canonicalExecutable(path: string, label: string): string {
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!isAbsolute(canonical) || !stat.isFile() || (stat.mode & 0o111) === 0)
    throw new Error(`${label} is not a canonical executable file`);
  return canonical;
}

const nodeExecutable = canonicalExecutable(process.execPath, "Node");
const executables = {
  node: nodeExecutable,
  npm: canonicalExecutable(join(dirname(nodeExecutable), "npm"), "npm"),
  git: canonicalExecutable("/usr/bin/git", "Git"),
  wrangler: realpathSync(join(root, "node_modules/.bin/wrangler")),
  tsx: realpathSync(join(root, "node_modules/tsx/dist/cli.mjs")),
  bash: canonicalExecutable("/bin/bash", "bash"),
};
for (const [label, script] of Object.entries({
  wrangler: executables.wrangler,
  tsx: executables.tsx,
})) {
  check(
    lstatSync(script).isFile() && script.startsWith(join(root, "node_modules")),
    `${label} is not a validated local script`,
  );
}

function safeEnvironment(additional: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(nodeExecutable)}:/usr/bin:/bin`,
    HOME: isolatedHome,
    TMPDIR: isolatedTmp,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NO_COLOR: "1",
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    ...additional,
  };
}

type CommandResult = { stdout: string; stderr: string };

function command(
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? root,
      env: safeEnvironment(options.env),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else
        resolveCommand({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    };
    const terminate = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate();
        finish(new Error(`subprocess output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (code !== 0)
        finish(
          new Error(
            `${basename(executable)} ${args.join(" ")} failed (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8").slice(-2000)}`,
          ),
        );
      else finish();
    });
    const timer = setTimeout(() => {
      terminate();
      finish(
        new Error(`${basename(executable)} timed out after ${options.timeoutMs ?? 120_000}ms`),
      );
    }, options.timeoutMs ?? 120_000);
  });
}

async function resolvePython(): Promise<string> {
  const hostHome = process.env.HOME;
  const candidates = [
    ...(hostHome
      ? [join(hostHome, ".local/bin/python3.12"), join(hostHome, ".local/bin/python3.11")]
      : []),
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.11",
    "/usr/local/bin/python3.12",
    "/usr/local/bin/python3.11",
  ];
  for (const candidate of candidates) {
    try {
      const canonical = canonicalExecutable(candidate, "Python");
      const result = await command(canonical, ["--version"], { timeoutMs: 5_000 });
      const version = `${result.stdout}${result.stderr}`.trim();
      if (/^Python 3\.(?:11|12)\./.test(version)) return canonical;
    } catch {
      // Continue through the finite local candidate set.
    }
  }
  throw new Error("canonical local Python 3.11 or 3.12 is required");
}

function source(path: string) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function visit(node: ts.Node, callback: (node: ts.Node) => void) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function providerEvidence() {
  const paths = [
    ...filesBelow(join(root, "apps/api/src"), ".ts"),
    ...filesBelow(join(root, "packages/graphify-adapter/src"), ".ts"),
  ];
  const interfaces = new Map<string, string>();
  const implementations = new Map<string, string[]>();
  const expected: Record<string, string> = {
    AuthProvider: "GithubAuthProvider",
    IdentityLookupProvider: "GithubIdentityLookupProvider",
    ObjectStorage: "R2ObjectStorage",
    GitProvider: "GithubGitProvider",
    GraphProvider: "GraphifyAdapter",
    ContextProvider: "ContextEngine",
    McpTransport: "WorkerMcpTransport",
  };
  const registries: string[] = [];
  for (const path of paths) {
    const tree = source(path);
    visit(tree, (node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text in expected)
        interfaces.set(node.name.text, relative(root, path));
      if (ts.isClassDeclaration(node) && node.name) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
          for (const item of clause.types) {
            const contract = item.expression.getText(tree);
            if (contract in expected)
              implementations.set(contract, [
                ...(implementations.get(contract) ?? []),
                node.name.text,
              ]);
          }
        }
      }
      if (
        (ts.isClassDeclaration(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isVariableDeclaration(node)) &&
        node.name &&
        /registry|serviceLocator/i.test(node.name.getText(tree))
      )
        registries.push(`${relative(root, path)}:${node.name.getText(tree)}`);
    });
  }
  check(
    JSON.stringify([...interfaces.keys()].sort()) === JSON.stringify(Object.keys(expected).sort()),
    `provider interface set changed: ${[...interfaces.keys()].sort().join(",")}`,
  );
  for (const [contract, implementation] of Object.entries(expected))
    check(
      JSON.stringify(implementations.get(contract) ?? []) === JSON.stringify([implementation]),
      `${contract} implementation set changed`,
    );
  check(registries.length === 0, `provider registries found: ${registries.join(",")}`);
  return {
    interfaces: Object.fromEntries(
      [...interfaces]
        .sort()
        .map(([name, path]) => [name, { path, implementations: implementations.get(name) ?? [] }]),
    ),
    registries,
  };
}

const routeSamples: Record<string, string> = {
  "project-detail": "/projects/project-one",
  git: "/projects/project-one/git",
  "git-sync": "/projects/project-one/git/sync",
  artifacts: "/projects/project-one/artifacts",
  artifact: "/projects/project-one/artifacts/artifact-one",
  "artifact-versions": "/projects/project-one/artifacts/artifact-one/versions",
  "artifact-version": "/projects/project-one/artifacts/artifact-one/versions/1",
  graphs: "/projects/project-one/graphs",
  "graph-latest": "/projects/project-one/graphs/latest",
  "graph-build": "/projects/project-one/graphs/build",
  graph: "/projects/project-one/graphs/1",
  "graph-query": "/projects/project-one/graphs/1/query",
  "context-search": "/projects/project-one/context/search",
  sync: "/projects/project-one/sync",
  "sync-graph": "/projects/project-one/sync/graph/1",
  "sync-states": "/projects/project-one/sync-states",
  "sync-state-current": "/projects/project-one/sync-states/current",
  team: "/projects/project-one/team",
  "team-invitation": "/projects/project-one/team/invitations/invitation-one",
  "team-member": "/projects/project-one/team/members/user-one",
  "invitation-accept": "/invitations/invitation-one/accept",
  snapshots: "/projects/project-one/snapshots",
  snapshot: "/projects/project-one/snapshots/snapshot-one",
  "snapshot-manifest": "/projects/project-one/snapshots/snapshot-one/manifest",
  "project-activity": "/projects/project-one/activity",
  "project-activity-detail": "/projects/project-one/activity/event-one",
  "machine-credentials": "/projects/project-one/machine-credentials",
  "machine-credential-rotate": "/projects/project-one/machine-credentials/credential-one/rotate",
  "machine-credential": "/projects/project-one/machine-credentials/credential-one",
  "machine-graph-command": "/machine/projects/project-one/graphs/1/claim",
  "machine-graph-publish": "/machine/projects/project-one/graphs/1/publish",
  "mcp-credential-rotate": "/mcp-credentials/credential-one/rotate",
  "mcp-credential": "/mcp-credentials/credential-one",
};

function samplePath(id: string, pathShape: string): string {
  return routeSamples[id] ?? pathShape;
}

function fakeEnv(): Env {
  const statement = {
    bind() {
      return this;
    },
    async first() {
      return null;
    },
    async all() {
      return { results: [] };
    },
    async run() {
      return { success: true, meta: { changes: 0 } };
    },
  };
  return {
    DB: { prepare: () => statement, batch: async () => [] } as never,
    OBJECTS: { head: async () => null } as never,
    APP_ENV: "development",
    WEB_ORIGIN: "http://localhost:5173",
    API_ORIGIN: "http://localhost:8787",
  };
}

async function routeEvidence() {
  const indexTree = source(join(root, "apps/api/src/index.ts"));
  const called = new Set<string>();
  visit(indexTree, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      called.add(node.expression.text);
  });
  check(
    called.has("matchRouteContract"),
    "dispatcher does not consume the production route contract",
  );
  const expectedAuth: Partial<Record<string, RouteAuthorization>> = {
    "project-detail": "DIRECT_PROJECT_MEMBER",
    git: "DIRECT_PROJECT_MEMBER",
    artifacts: "DIRECT_PROJECT_MEMBER",
    graphs: "DIRECT_PROJECT_MEMBER",
    "context-search": "DIRECT_PROJECT_MEMBER",
    snapshots: "DIRECT_PROJECT_MEMBER",
    team: "DIRECT_PROJECT_MEMBER",
    "project-activity": "DIRECT_PROJECT_MEMBER",
    "machine-graph-command": "MACHINE_PRINCIPAL",
    "machine-graph-publish": "MACHINE_PRINCIPAL",
    mcp: "MCP_PRINCIPAL",
    "invitation-accept": "EXACT_INVITEE",
  };
  const app = createApp(async () => new Response(null, { status: 503 }));
  const rows = [];
  for (const contract of ROUTE_CONTRACTS) {
    const path = samplePath(contract.id, contract.pathShape);
    check(
      matchRouteContract(path)?.id === contract.id,
      `route ${contract.id} does not match its sample`,
    );
    for (const handler of contract.handler.split("|"))
      check(called.has(handler), `route ${contract.id} names uncalled handler ${handler}`);
    if (expectedAuth[contract.id])
      check(
        contract.authorization === expectedAuth[contract.id],
        `route ${contract.id} auth changed`,
      );
    if (contract.pathShape.startsWith("/projects/:projectId"))
      check(
        contract.authorization === "DIRECT_PROJECT_MEMBER",
        `project route ${contract.id} does not require direct membership`,
      );
    if (contract.pathShape.startsWith("/machine/projects/:projectId"))
      check(
        contract.authorization === "MACHINE_PRINCIPAL",
        `machine route ${contract.id} does not require a bound machine principal`,
      );
    const methodStatuses: Record<string, number> = {};
    for (const method of contract.methods) {
      const response = await app.fetch(
        new Request(`http://localhost:8787${path}`, {
          method,
          headers: method === "GET" ? undefined : { origin: "http://localhost:5173" },
        }),
        fakeEnv(),
      );
      methodStatuses[method] = response.status;
      check(response.status !== 405, `${contract.id} rejects contracted ${method}`);
    }
    const uncontractedMethod = ["GET", "POST", "PUT", "PATCH", "DELETE"].find(
      (method) => !contract.methods.includes(method),
    );
    check(uncontractedMethod, `${contract.id} contracts every probeable method`);
    const denied = await app.fetch(
      new Request(`http://localhost:8787${path}`, {
        method: uncontractedMethod,
        headers: { origin: "http://localhost:5173" },
      }),
      fakeEnv(),
    );
    check(denied.status === 405, `${contract.id} does not reject an uncontracted method`);
    rows.push({
      id: contract.id,
      pathShape: contract.pathShape,
      methods: [...contract.methods],
      handler: contract.handler,
      authorization: contract.authorization,
      methodStatuses,
    });
  }
  check(new Set(rows.map((row) => row.id)).size === rows.length, "duplicate route contract IDs");
  return rows;
}

function storageEvidence() {
  const builderPath = join(root, "apps/api/src/storage-keys.ts");
  const builderTree = source(builderPath);
  const builders = new Map<string, string>();
  visit(builderTree, (node) => {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) return;
    const returned = node.body.statements.find(ts.isReturnStatement)?.expression;
    if (
      returned &&
      (ts.isTemplateExpression(returned) || ts.isNoSubstitutionTemplateLiteral(returned))
    )
      builders.set(node.name.text, returned.getText(builderTree));
  });
  const expectedBuilders = [
    "artifactObjectKey",
    "legacyGraphObjectKey",
    "attemptGraphObjectKey",
    "snapshotManifestObjectKey",
  ];
  check(
    JSON.stringify([...builders.keys()].sort()) === JSON.stringify(expectedBuilders.sort()),
    `immutable key builder set changed: ${[...builders.keys()].join(",")}`,
  );
  const files = [
    "artifacts.ts",
    "context-engine.ts",
    "graphs.ts",
    "machine-graphs.ts",
    "mcp.ts",
    "snapshots.ts",
  ];
  const calls: Record<string, string[]> = {};
  const keyCallNames = new Set([
    ...expectedBuilders,
    "createOnly",
    "putImmutable",
    "publishManifest",
  ]);
  for (const file of files) {
    const tree = source(join(root, "apps/api/src", file));
    const names: string[] = [];
    visit(tree, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        keyCallNames.has(node.expression.text)
      )
        names.push(node.expression.text);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        keyCallNames.has(node.expression.name.text)
      )
        names.push(node.expression.name.text);
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "storageKey" &&
        ts.isPropertyAssignment(node.parent) &&
        node.parent.initializer === node
      )
        failures.push(`${file} accepts a client-selected storageKey`);
    });
    calls[file] = names;
  }
  check(
    calls["artifacts.ts"]?.filter((name) => name === "artifactObjectKey").length === 2,
    "artifact writes do not use artifactObjectKey twice",
  );
  check(
    calls["graphs.ts"]?.includes("attemptGraphObjectKey"),
    "graph create-only publication is not fenced by attemptGraphObjectKey",
  );
  check(
    calls["snapshots.ts"]?.includes("snapshotManifestObjectKey"),
    "snapshot create-only publication does not use snapshotManifestObjectKey",
  );
  check(
    calls["machine-graphs.ts"]?.includes("attemptGraphObjectKey"),
    "machine claim does not derive attemptGraphObjectKey",
  );
  check(
    ["artifactObjectKey", "attemptGraphObjectKey", "legacyGraphObjectKey"].every((name) =>
      calls["context-engine.ts"]?.includes(name),
    ),
    "Context Engine does not validate every immutable payload layout through shared builders",
  );
  check(
    calls["mcp.ts"]?.includes("artifactObjectKey"),
    "MCP artifact retrieval does not validate the shared immutable artifact layout",
  );
  check(
    calls["snapshots.ts"]?.includes("artifactObjectKey"),
    "snapshot sealing does not validate shared immutable artifact layouts",
  );
  const bodySelectors = filesBelow(join(root, "apps/api/src"), ".ts").flatMap((path) => {
    const tree = source(path);
    const found: string[] = [];
    visit(tree, (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ["storageKey", "storage_key"].includes(node.name.text) &&
        /body|parsed|input/.test(node.expression.getText(tree))
      )
        found.push(`${relative(root, path)}:${node.getText(tree)}`);
    });
    return found;
  });
  check(
    bodySelectors.length === 0,
    `request bodies can select storage keys: ${bodySelectors.join(",")}`,
  );
  return { builders: Object.fromEntries(builders), productionCalls: calls, bodySelectors };
}

type WorkflowStep = { name?: string; uses?: string; with: Record<string, string> };
type WorkflowJob = {
  runsOn?: string;
  environment?: string;
  timeoutMinutes?: number;
  steps: WorkflowStep[];
};

function workflow(path: string) {
  const lines = readFileSync(path, "utf8").split("\n");
  const result: {
    name?: string;
    on: string[];
    permissions: Record<string, string>;
    concurrency: Record<string, string>;
    jobs: Record<string, WorkflowJob>;
  } = { on: [], permissions: {}, concurrency: {}, jobs: {} };
  let section = "";
  let job: WorkflowJob | undefined;
  let step: WorkflowStep | undefined;
  let inWith = false;
  let blockIndent: number | null = null;
  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length;
    if (blockIndent !== null) {
      if (!raw.trim() || indent > blockIndent) continue;
      blockIndent = null;
    }
    const text = raw.trim();
    if (!text || text.startsWith("#")) continue;
    if (text.endsWith(": |") || text.endsWith(": >")) {
      blockIndent = indent;
      continue;
    }
    const pair = /^([^:]+):(?:\s+(.*))?$/.exec(text.replace(/\s+#.*$/, ""));
    if (indent === 0 && pair) {
      section = pair[1] ?? "";
      job = undefined;
      step = undefined;
      inWith = false;
      if (section === "name") result.name = pair[2];
      continue;
    }
    if (section === "on" && indent === 2 && pair) result.on.push(pair[1] ?? "");
    if (section === "permissions" && indent === 2 && pair)
      result.permissions[pair[1] ?? ""] = pair[2] ?? "";
    if (section === "concurrency" && indent === 2 && pair)
      result.concurrency[pair[1] ?? ""] = pair[2] ?? "";
    if (section !== "jobs") continue;
    if (indent === 2 && pair) {
      job = { steps: [] };
      result.jobs[pair[1] ?? ""] = job;
      continue;
    }
    if (!job) continue;
    if (indent === 4 && pair) {
      const key = pair[1] ?? "";
      const value = pair[2] ?? "";
      if (key === "runs-on") job.runsOn = value;
      if (key === "environment") job.environment = value;
      if (key === "timeout-minutes") job.timeoutMinutes = Number(value);
      if (key !== "steps") step = undefined;
      continue;
    }
    if (indent === 6 && text.startsWith("- ")) {
      step = { with: {} };
      job.steps.push(step);
      inWith = false;
      const item = /^-\s+([^:]+):\s*(.*)$/.exec(text);
      if (item?.[1] === "name") step.name = item[2];
      if (item?.[1] === "uses") step.uses = item[2];
      continue;
    }
    if (!step || !pair) continue;
    if (indent === 8) {
      inWith = pair[1] === "with";
      if (pair[1] === "name") step.name = pair[2];
      if (pair[1] === "uses") step.uses = pair[2];
      continue;
    }
    if (indent === 10 && inWith) step.with[pair[1] ?? ""] = pair[2] ?? "";
  }
  return result;
}

function workflowEvidence() {
  const expressionStart = "$" + "{{";
  const ci = workflow(join(root, ".github/workflows/ci.yml"));
  const graphify = workflow(join(root, ".github/workflows/graphify.yml"));
  const ciJob = ci.jobs.quality;
  const graphJob = graphify.jobs.graphify;
  check(ci.on.join(",") === "pull_request,push", "quality workflow triggers changed");
  check(ci.permissions.contents === "read", "quality permissions changed");
  check(ci.concurrency["cancel-in-progress"] === "true", "quality cancellation changed");
  check(ciJob?.timeoutMinutes === 20, "quality timeout changed");
  check(graphify.on.join(",") === "workflow_dispatch", "Graphify trigger changed");
  check(graphify.permissions.contents === "read", "Graphify permissions changed");
  check(
    graphify.concurrency.group === `graphify-${expressionStart} inputs.project_id }}`,
    "Graphify concurrency changed",
  );
  check(graphify.concurrency["cancel-in-progress"] === "false", "Graphify cancellation changed");
  check(graphJob?.timeoutMinutes === 30, "Graphify timeout changed");
  check(graphJob?.environment === "context-hub-graphify", "Graphify environment changed");
  const actions = [...(ciJob?.steps ?? []), ...(graphJob?.steps ?? [])]
    .filter((step) => step.uses)
    .map((step) => ({ uses: step.uses, with: step.with }));
  check(
    actions.every((item) => /@[0-9a-f]{40}$/.test(item.uses ?? "")),
    "workflow action is not full-SHA pinned",
  );
  const sourceCheckout = actions.find((item) => item.with.path === "source");
  const toolingCheckout = actions.find((item) => item.with.path === "tooling");
  check(
    sourceCheckout?.with.ref === `${expressionStart} inputs.commit }}`,
    "source checkout is not commit-bound",
  );
  check(
    toolingCheckout?.with.ref === `${expressionStart} vars.CONTEXT_HUB_TOOLING_SHA }}`,
    "tooling checkout is not trusted-revision-bound",
  );
  return { ci, graphify, actions };
}

function hash(value: string | null): string {
  return createHash("sha256")
    .update(value ?? "")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

interface SchemaManifest {
  tables: Array<{ name: string; sqlSha256: string }>;
  indexes: Array<{ name: string; sqlSha256: string }>;
  triggers: Array<{ name: string; sqlSha256: string }>;
  foreignKeys: Record<string, unknown[]>;
}

function parseSchemaManifest(value: string, label: string): SchemaManifest {
  try {
    return JSON.parse(value) as SchemaManifest;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function migrationEvidence(python: string) {
  const persist = join(runRoot, "d1");
  await command(
    executables.node,
    [
      executables.wrangler,
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      persist,
      "--config",
      join(root, "apps/api/wrangler.toml"),
    ],
    { timeoutMs: 180_000 },
  );
  const sqlite = filesBelow(persist, ".sqlite").find(
    (path) => basename(path) !== "metadata.sqlite",
  );
  if (!sqlite) throw new Error("Wrangler did not create a local SQLite database");
  const program = `
import hashlib,json,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
out={"version":1}
for typ,key in (("table","tables"),("index","indexes"),("trigger","triggers")):
 rows=[]
 for name,sql in c.execute("select name,sql from sqlite_master where type=? and name not like 'sqlite_%' order by name",(typ,)):
  if name in ("_cf_METADATA","d1_migrations"): continue
  rows.append({"name":name,"sqlSha256":hashlib.sha256((sql or "").encode()).hexdigest()})
 out[key]=rows
out["foreignKeys"]={}
for (name,) in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not in ('_cf_METADATA','d1_migrations') order by name"):
 rows=[list(row) for row in c.execute("pragma foreign_key_list('"+name.replace("'","''")+"')")]
 if rows: out["foreignKeys"][name]=rows
print(json.dumps(out,sort_keys=True,separators=(",",":")))`;
  const actualText = (
    await command(python, ["-c", program, sqlite], { timeoutMs: 30_000 })
  ).stdout.trim();
  const actual = parseSchemaManifest(actualText, "fresh schema manifest");
  const expected = parseSchemaManifest(
    readFileSync(join(root, "scripts/architecture-schema-manifest.json"), "utf8"),
    "reviewed schema manifest",
  );
  check(
    canonicalJson(actual) === canonicalJson(expected),
    "fresh sqlite_master/FK manifest differs from the reviewed exact manifest",
  );
  const migrationSuite = await command(
    executables.bash,
    [join(root, "apps/api/test/migration-integrity.sh")],
    {
      timeoutMs: 600_000,
    },
  );
  check(
    migrationSuite.stdout.includes("transactional rollback passed"),
    "migration-integrity suite did not report its complete semantic gate",
  );
  return {
    applicationTables: actual.tables.length,
    platformTablesExcluded: ["_cf_METADATA", "d1_migrations"],
    indexes: actual.indexes.length,
    triggers: actual.triggers.length,
    foreignKeys: Object.values(actual.foreignKeys).reduce((sum, rows) => sum + rows.length, 0),
    exactManifestSha256: hash(JSON.stringify(expected)),
    integritySuite: "apps/api/test/migration-integrity.sh",
  };
}

async function semanticTests() {
  const testFiles = [
    "apps/api/test/index.test.ts",
    "apps/api/test/providers.test.ts",
    "apps/api/test/artifacts.test.ts",
    "apps/api/test/graphs.test.ts",
    "apps/api/test/context-route.test.ts",
    "apps/api/test/mcp.test.ts",
    "apps/api/test/snapshots.test.ts",
    "apps/api/test/team.test.ts",
    "packages/context-cli/test/sync.test.ts",
  ];
  await command(executables.node, [executables.tsx, "--test", ...testFiles], {
    timeoutMs: 300_000,
  });
  return { files: testFiles, status: "PASS" };
}

const coverage = {
  functional: Array.from(
    { length: 52 },
    (_, index) => `PRD-F-${String(index + 1).padStart(3, "0")}`,
  ),
  nonfunctional: Array.from(
    { length: 24 },
    (_, index) => `PRD-NF-${String(index + 1).padStart(3, "0")}`,
  ),
  architecture: Array.from(
    { length: 43 },
    (_, index) => `TA-${String(index + 1).padStart(3, "0")}`,
  ),
  acceptance: Array.from(
    { length: 15 },
    (_, index) => `MVP-AC-${String(index + 1).padStart(3, "0")}`,
  ),
};

function documentationEvidence() {
  const qa = readFileSync(join(root, "docs/ai/final-qa.md"), "utf8");
  const found = [...qa.matchAll(/^\| ((?:PRD-F|PRD-NF|TA|MVP-AC)-\d{3}) \|/gm)].map(
    (match) => match[1],
  );
  const expected = Object.values(coverage).flat();
  check(found.length === new Set(found).size, "final QA contains duplicate normative matrix IDs");
  check(
    JSON.stringify(found.sort()) === JSON.stringify(expected.sort()),
    "final QA normative matrix coverage changed",
  );
  const master = readFileSync(join(root, "docs/ai/master-plan.md"), "utf8");
  const status = readFileSync(join(root, "docs/ai/implementation-status.md"), "utf8");
  check(
    /^### 6\.[^\n]*PARTIAL: HISTORICAL PROTOCOL GAPS/m.test(master) &&
      /phase-6-acceptance-evidence\.md/.test(`${master}\n${status}\n${qa}`) &&
      /split backend\/frontend reviews plus a post-fix final review/.test(qa),
    "Phase 6 recovered evidence or historical protocol-gap disposition changed",
  );
  check(
    /Local MVP process acceptance: BLOCKED/.test(qa) &&
      /neither the current exactly-one-review topology nor focused Git-checkpoint rule was satisfied/.test(
        qa,
      ),
    "local MVP process acceptance must remain blocked on the Phase 6 protocol gaps",
  );
  return {
    coverage: Object.fromEntries(Object.entries(coverage).map(([key, ids]) => [key, ids.length])),
    total: expected.length,
  };
}

async function main() {
  try {
    await command(executables.git, ["init", "--bare", join(runRoot, "empty.git")], {
      timeoutMs: 10_000,
    });
    const python = await resolvePython();
    const mcp = await measureMcpTokenAudit();
    const pi = await measurePiTokenAudit();
    check(MCP_TOOL_NAMES.length === 6 && MCP_TOOLS.length === 6, "MCP tool count changed");
    check(
      mcp.schema.runs.every((run) => run.sha256 === mcp.schema.sha256),
      "MCP schema varies by project count",
    );
    check(
      pi.audit.permanentModelContext.modelVisibleBytes === 0,
      "Pi model-visible context is nonzero",
    );
    const evidence = {
      baseline: (
        await command(executables.git, ["rev-parse", "HEAD"], { timeoutMs: 5_000 })
      ).stdout.trim(),
      executables: { ...executables, python },
      subprocessPolicy: {
        timeout: true,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        detachedProcessGroupKill: true,
        allowlistedEnvironment: true,
        wranglerLocalOnly: true,
      },
      providers: providerEvidence(),
      routes: await routeEvidence(),
      storage: storageEvidence(),
      workflows: workflowEvidence(),
      migrations: await migrationEvidence(python),
      semanticTests: await semanticTests(),
      mcp: {
        tools: [...MCP_TOOL_NAMES],
        limits: MCP_LIMITS,
        schemaBytes: mcp.schema.bytes,
        schemaSha256: mcp.schema.sha256,
      },
      pi: {
        command: pi.audit.command,
        modelVisibleBytes: 0,
        estimatedTokens: 0,
        auditSha256: pi.auditSha256,
      },
      documentation: documentationEvidence(),
      stagedFiles: (
        await command(executables.git, ["diff", "--cached", "--name-only"], { timeoutMs: 5_000 })
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean),
    };
    check(
      evidence.stagedFiles.length === 0,
      `audit found staged files: ${evidence.stagedFiles.join(",")}`,
    );
    if (failures.length) {
      console.error(JSON.stringify({ status: "FAIL", failures, evidence }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify({ status: "PASS", digest: hash(JSON.stringify(evidence)), evidence }, null, 2),
    );
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

await main();
