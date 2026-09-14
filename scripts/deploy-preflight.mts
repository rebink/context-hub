import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { generatePagesHeaders } from "../apps/web/scripts/generate-security-headers.js";
import {
  canonicalJson,
  DEPLOYMENT_CONTRACT,
  generatedManifestSchema,
} from "./deployment-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_RESERVED =
  /(?:^|[-_.])(test|testing|fixture|synthetic|sample|demo|fake|dummy|example|placeholder|replace(?:-me)?|changeme|todo|tbd|localhost)(?:$|[-_.])/i;
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{32,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /(?:chmcp|chci)_[A-Za-z0-9_-]{20,}/,
  /Bearer\s+[A-Za-z0-9._~-]{24,}/i,
  /(?:CLOUDFLARE_API_TOKEN|GITHUB_TOKEN)\s*[=:]\s*[A-Za-z0-9_-]{20,}/i,
];
const RECEIPT_KEYS = Object.keys(DEPLOYMENT_CONTRACT.gateCommands) as GateKey[];

type JsonObject = Record<string, unknown>;
type GateKey = keyof typeof DEPLOYMENT_CONTRACT.gateCommands;

export type DeploymentManifest = {
  schemaVersion: 1;
  release: {
    commit: string;
    branch: "main";
    changeId: string;
    changeWindow: { startsAt: string; endsAt: string };
    owners: Record<"release" | "cloudflare" | "github" | "security" | "incident", string>;
    incidentRunbook: string;
    rollbackRunbook: string;
  };
  cloudflare: {
    accountId: string;
    zoneId: string;
    worker: {
      name: string;
      environment: "production";
      apiOrigin: string;
      route: { pattern: string; customDomain: true };
      workersDev: false;
      previewUrls: false;
      compatibilityDate: "2025-02-14";
      observability: { enabled: true; headSamplingRate: number; policyReference: string };
    };
    d1: { binding: "DB"; databaseName: string; databaseId: string };
    r2: {
      binding: "OBJECTS";
      bucketName: string;
      private: true;
      r2Dev: false;
      customDomains: [];
      corsRules: [];
    };
    pages: {
      projectName: string;
      productionBranch: "main";
      webOrigin: string;
      apiPublicVariable: "VITE_API_URL";
      previewDeployments: false;
    };
  };
  github: {
    oauthClientId: string;
    oauthCallback: string;
    appId: string;
    appSlug: string;
    appClientId: string;
    appSetupUrl: string;
    appCallback: string;
    oauthScopes: [];
    appPermissions: { metadata: "read"; contents: "read" };
    environment: "production";
    environmentProtectionReference: string;
  };
  requiredSecrets: string[];
  tooling: {
    node: string;
    npm: string;
    wrangler: string;
    lockfileSha256: string;
    actions: Record<string, string>;
  };
  gates: Record<GateKey, string>;
};

export type GateReceipt = {
  schemaVersion: 1;
  gate: GateKey;
  command: string;
  commit: string;
  result: "PASS";
  startedAt: string;
  endedAt: string;
  output: { bytes: number; sha256: string; truncated: false };
  tools: { node: string; npm: string; wrangler: string };
  generatedBy: "context-hub-gate-receipt-v1";
  receiptDigest: string;
};

export class PreflightError extends Error {
  constructor(public readonly codes: string[]) {
    super(codes.join(","));
  }
}

export type CommandSpec = {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  expectedFailure?: boolean;
};

export type CommandResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: string | null;
};
export type ProcessRunner = (spec: CommandSpec) => Promise<CommandResult>;

type Sandbox = {
  executable: string;
  prefix: string[];
  kind: "darwin-sandbox-exec" | "linux-bwrap" | "linux-unshare";
};

type PreflightOptions = {
  candidateRoot?: string;
  receiptRoot?: string;
  ciDetachedSha?: string;
  runner?: ProcessRunner;
  sandbox?: Sandbox;
  skipRepositoryForTests?: boolean;
  secretEnvironment?: NodeJS.ProcessEnv;
};

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(errors: string[]): never {
  throw new PreflightError([...new Set(errors)].sort().slice(0, 64));
}

function obj(value: unknown, path: string, keys: readonly string[], errors: string[]): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path}:OBJECT_REQUIRED`);
    return {};
  }
  const result = value as JsonObject;
  const allowed = new Set(keys);
  for (const key of Object.keys(result))
    if (!allowed.has(key)) errors.push(`${path}.${key}:UNKNOWN_FIELD`);
  for (const key of keys) if (!(key in result)) errors.push(`${path}.${key}:REQUIRED`);
  return result;
}

function text(value: unknown, path: string, errors: string[], pattern?: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    errors.push(`${path}:INVALID_STRING`);
    return "";
  }
  if (PRODUCTION_RESERVED.test(value) || /\.invalid(?:$|[/:])/i.test(value))
    errors.push(`${path}:RESERVED_VALUE`);
  if (pattern && !new RegExp(pattern).test(value)) errors.push(`${path}:INVALID_FORMAT`);
  return value;
}

function list(value: unknown, path: string, errors: string[]): unknown[] {
  if (!Array.isArray(value)) {
    errors.push(`${path}:ARRAY_REQUIRED`);
    return [];
  }
  return value;
}

function repositoryReference(value: unknown, path: string, errors: string[]): string {
  const result = text(value, path, errors, DEPLOYMENT_CONTRACT.patterns.repositoryReference);
  if (result.includes("..") || result.includes("//")) errors.push(`${path}:PATH_ESCAPE`);
  return result;
}

function receiptPath(value: unknown, path: string, errors: string[]): string {
  const result = text(value, path, errors, DEPLOYMENT_CONTRACT.patterns.receiptPath);
  if (result.includes("..") || isAbsolute(result)) errors.push(`${path}:PATH_ESCAPE`);
  return result;
}

function productionHostname(hostname: string, path: string, errors: string[]): void {
  const lower = hostname.toLowerCase();
  if (
    hostname !== lower ||
    hostname.endsWith(".") ||
    hostname.includes("*") ||
    !hostname.includes(".")
  )
    errors.push(`${path}:NONCANONICAL_HOST`);
  if (PRODUCTION_RESERVED.test(hostname) || /\.(?:test|example|invalid|localhost)$/.test(lower))
    errors.push(`${path}:RESERVED_HOST`);
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(lower) || lower.includes(":"))
    errors.push(`${path}:IP_HOST_FORBIDDEN`);
  const labels = lower.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    errors.push(`${path}:NONCANONICAL_HOST`);
  if (/^(?:10|127|169\.254|192\.168)\./.test(lower) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(lower))
    errors.push(`${path}:PRIVATE_HOST_FORBIDDEN`);
}

function origin(value: unknown, path: string, errors: string[]): string {
  const raw = text(value, path, errors);
  try {
    const parsed = new URL(raw);
    productionHostname(parsed.hostname, path, errors);
    if (
      parsed.protocol !== "https:" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== raw
    )
      errors.push(`${path}:HTTPS_ORIGIN_REQUIRED`);
    return parsed.origin;
  } catch {
    errors.push(`${path}:HTTPS_ORIGIN_REQUIRED`);
    return "";
  }
}

function exactUrl(value: unknown, path: string, expected: string, errors: string[]): void {
  const raw = text(value, path, errors);
  try {
    const parsed = new URL(raw);
    productionHostname(parsed.hostname, path, errors);
    if (
      parsed.protocol !== "https:" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      raw !== expected
    )
      errors.push(`${path}:URL_MISMATCH`);
  } catch {
    errors.push(`${path}:URL_MISMATCH`);
  }
}

function rejectSecretMaterial(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "string") {
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value)))
      errors.push(`${path}:SECRET_VALUE_FORBIDDEN`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      rejectSecretMaterial(entry, `${path}[${index}]`, errors);
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    if (
      /(?:secret|token|password|privateKey|private_key|credentialValue)$/i.test(key) &&
      key !== "requiredSecrets"
    )
      errors.push(`${path}.${key}:SECRET_FIELD_FORBIDDEN`);
    rejectSecretMaterial(entry, `${path}.${key}`, errors);
  }
}

function suspiciousIdentifier(value: string, path: string, errors: string[]): void {
  if (/^0+$/.test(value.replaceAll("-", ""))) errors.push(`${path}:ZERO_ID_FORBIDDEN`);
  if (/^([0-9a-f])\1{15,}$/.test(value.replaceAll("-", "")))
    errors.push(`${path}:REPEATED_ID_FORBIDDEN`);
  if (/^(?:0123456789abcdef){2}$|^(?:abcdef0123456789){2}$/.test(value))
    errors.push(`${path}:FIXTURE_ID_FORBIDDEN`);
}

export function validateManifest(input: unknown): DeploymentManifest {
  const errors: string[] = [];
  rejectSecretMaterial(input, "$", errors);
  const root = obj(
    input,
    "$",
    ["schemaVersion", "release", "cloudflare", "github", "requiredSecrets", "tooling", "gates"],
    errors,
  );
  if (root.schemaVersion !== 1) errors.push("$.schemaVersion:UNSUPPORTED");
  const release = obj(
    root.release,
    "$.release",
    [
      "commit",
      "branch",
      "changeId",
      "changeWindow",
      "owners",
      "incidentRunbook",
      "rollbackRunbook",
    ],
    errors,
  );
  text(release.commit, "$.release.commit", errors, DEPLOYMENT_CONTRACT.patterns.sha);
  if (release.branch !== "main") errors.push("$.release.branch:MAIN_REQUIRED");
  text(release.changeId, "$.release.changeId", errors, "^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$");
  const window = obj(
    release.changeWindow,
    "$.release.changeWindow",
    ["startsAt", "endsAt"],
    errors,
  );
  const start = Date.parse(text(window.startsAt, "$.release.changeWindow.startsAt", errors));
  const end = Date.parse(text(window.endsAt, "$.release.changeWindow.endsAt", errors));
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end ||
    end - start > 4 * 60 * 60 * 1000
  )
    errors.push("$.release.changeWindow:INVALID_WINDOW");
  const owners = obj(
    release.owners,
    "$.release.owners",
    ["release", "cloudflare", "github", "security", "incident"],
    errors,
  );
  for (const key of ["release", "cloudflare", "github", "security", "incident"])
    text(owners[key], `$.release.owners.${key}`, errors, DEPLOYMENT_CONTRACT.patterns.owner);
  repositoryReference(release.incidentRunbook, "$.release.incidentRunbook", errors);
  repositoryReference(release.rollbackRunbook, "$.release.rollbackRunbook", errors);

  const cloudflare = obj(
    root.cloudflare,
    "$.cloudflare",
    ["accountId", "zoneId", "worker", "d1", "r2", "pages"],
    errors,
  );
  const accountId = text(
    cloudflare.accountId,
    "$.cloudflare.accountId",
    errors,
    DEPLOYMENT_CONTRACT.patterns.accountId,
  );
  const zoneId = text(
    cloudflare.zoneId,
    "$.cloudflare.zoneId",
    errors,
    DEPLOYMENT_CONTRACT.patterns.accountId,
  );
  suspiciousIdentifier(accountId, "$.cloudflare.accountId", errors);
  suspiciousIdentifier(zoneId, "$.cloudflare.zoneId", errors);
  if (accountId === zoneId) errors.push("$.cloudflare.zoneId:DUPLICATE_ID_FORBIDDEN");
  const worker = obj(
    cloudflare.worker,
    "$.cloudflare.worker",
    [
      "name",
      "environment",
      "apiOrigin",
      "route",
      "workersDev",
      "previewUrls",
      "compatibilityDate",
      "observability",
    ],
    errors,
  );
  text(worker.name, "$.cloudflare.worker.name", errors, DEPLOYMENT_CONTRACT.patterns.resourceName);
  if (worker.environment !== "production")
    errors.push("$.cloudflare.worker.environment:PRODUCTION_REQUIRED");
  const apiOrigin = origin(worker.apiOrigin, "$.cloudflare.worker.apiOrigin", errors);
  const route = obj(worker.route, "$.cloudflare.worker.route", ["pattern", "customDomain"], errors);
  const routePattern = text(route.pattern, "$.cloudflare.worker.route.pattern", errors);
  productionHostname(routePattern, "$.cloudflare.worker.route.pattern", errors);
  if (routePattern !== new URL(apiOrigin || "https://invalid.invalid").hostname)
    errors.push("$.cloudflare.worker.route.pattern:ORIGIN_MISMATCH");
  if (route.customDomain !== true)
    errors.push("$.cloudflare.worker.route.customDomain:TRUE_REQUIRED");
  if (worker.workersDev !== false) errors.push("$.cloudflare.worker.workersDev:FALSE_REQUIRED");
  if (worker.previewUrls !== false) errors.push("$.cloudflare.worker.previewUrls:FALSE_REQUIRED");
  if (worker.compatibilityDate !== DEPLOYMENT_CONTRACT.compatibilityDate)
    errors.push("$.cloudflare.worker.compatibilityDate:TESTED_DATE_REQUIRED");
  const observability = obj(
    worker.observability,
    "$.cloudflare.worker.observability",
    ["enabled", "headSamplingRate", "policyReference"],
    errors,
  );
  if (observability.enabled !== true)
    errors.push("$.cloudflare.worker.observability.enabled:TRUE_REQUIRED");
  if (
    typeof observability.headSamplingRate !== "number" ||
    observability.headSamplingRate <= 0 ||
    observability.headSamplingRate > 0.1
  )
    errors.push("$.cloudflare.worker.observability.headSamplingRate:INVALID_RATE");
  repositoryReference(
    observability.policyReference,
    "$.cloudflare.worker.observability.policyReference",
    errors,
  );
  const d1 = obj(
    cloudflare.d1,
    "$.cloudflare.d1",
    ["binding", "databaseName", "databaseId"],
    errors,
  );
  if (d1.binding !== "DB") errors.push("$.cloudflare.d1.binding:DB_REQUIRED");
  text(
    d1.databaseName,
    "$.cloudflare.d1.databaseName",
    errors,
    DEPLOYMENT_CONTRACT.patterns.resourceName,
  );
  const databaseId = text(
    d1.databaseId,
    "$.cloudflare.d1.databaseId",
    errors,
    DEPLOYMENT_CONTRACT.patterns.uuid,
  );
  suspiciousIdentifier(databaseId, "$.cloudflare.d1.databaseId", errors);
  const r2 = obj(
    cloudflare.r2,
    "$.cloudflare.r2",
    ["binding", "bucketName", "private", "r2Dev", "customDomains", "corsRules"],
    errors,
  );
  if (r2.binding !== "OBJECTS") errors.push("$.cloudflare.r2.binding:OBJECTS_REQUIRED");
  text(
    r2.bucketName,
    "$.cloudflare.r2.bucketName",
    errors,
    DEPLOYMENT_CONTRACT.patterns.resourceName,
  );
  if (
    r2.private !== true ||
    r2.r2Dev !== false ||
    list(r2.customDomains, "$.cloudflare.r2.customDomains", errors).length ||
    list(r2.corsRules, "$.cloudflare.r2.corsRules", errors).length
  )
    errors.push("$.cloudflare.r2:PRIVATE_ONLY");
  const pages = obj(
    cloudflare.pages,
    "$.cloudflare.pages",
    ["projectName", "productionBranch", "webOrigin", "apiPublicVariable", "previewDeployments"],
    errors,
  );
  text(
    pages.projectName,
    "$.cloudflare.pages.projectName",
    errors,
    DEPLOYMENT_CONTRACT.patterns.resourceName,
  );
  if (pages.productionBranch !== "main")
    errors.push("$.cloudflare.pages.productionBranch:MAIN_REQUIRED");
  const webOrigin = origin(pages.webOrigin, "$.cloudflare.pages.webOrigin", errors);
  if (webOrigin === apiOrigin) errors.push("$.cloudflare.pages.webOrigin:DISTINCT_ORIGIN_REQUIRED");
  if (pages.apiPublicVariable !== "VITE_API_URL")
    errors.push("$.cloudflare.pages.apiPublicVariable:INVALID");
  if (pages.previewDeployments !== false)
    errors.push("$.cloudflare.pages.previewDeployments:FALSE_REQUIRED");

  const github = obj(
    root.github,
    "$.github",
    [
      "oauthClientId",
      "oauthCallback",
      "appId",
      "appSlug",
      "appClientId",
      "appSetupUrl",
      "appCallback",
      "oauthScopes",
      "appPermissions",
      "environment",
      "environmentProtectionReference",
    ],
    errors,
  );
  text(
    github.oauthClientId,
    "$.github.oauthClientId",
    errors,
    DEPLOYMENT_CONTRACT.patterns.githubClientId,
  );
  const appId = text(
    github.appId,
    "$.github.appId",
    errors,
    DEPLOYMENT_CONTRACT.patterns.githubAppId,
  );
  suspiciousIdentifier(appId, "$.github.appId", errors);
  text(github.appSlug, "$.github.appSlug", errors, DEPLOYMENT_CONTRACT.patterns.resourceName);
  text(
    github.appClientId,
    "$.github.appClientId",
    errors,
    DEPLOYMENT_CONTRACT.patterns.githubClientId,
  );
  exactUrl(
    github.oauthCallback,
    "$.github.oauthCallback",
    `${apiOrigin}/auth/github/callback`,
    errors,
  );
  exactUrl(
    github.appSetupUrl,
    "$.github.appSetupUrl",
    `${apiOrigin}/auth/github-app/setup`,
    errors,
  );
  exactUrl(
    github.appCallback,
    "$.github.appCallback",
    `${apiOrigin}/auth/github-app/callback`,
    errors,
  );
  if (list(github.oauthScopes, "$.github.oauthScopes", errors).length)
    errors.push("$.github.oauthScopes:IDENTITY_ONLY_REQUIRED");
  const permissions = obj(
    github.appPermissions,
    "$.github.appPermissions",
    ["metadata", "contents"],
    errors,
  );
  if (permissions.metadata !== "read" || permissions.contents !== "read")
    errors.push("$.github.appPermissions:READ_ONLY_REQUIRED");
  if (github.environment !== "production") errors.push("$.github.environment:PRODUCTION_REQUIRED");
  repositoryReference(
    github.environmentProtectionReference,
    "$.github.environmentProtectionReference",
    errors,
  );

  const secrets = list(root.requiredSecrets, "$.requiredSecrets", errors);
  if (canonicalJson(secrets) !== canonicalJson(DEPLOYMENT_CONTRACT.requiredSecrets))
    errors.push("$.requiredSecrets:EXACT_NAMES_REQUIRED");
  const tooling = obj(
    root.tooling,
    "$.tooling",
    ["node", "npm", "wrangler", "lockfileSha256", "actions"],
    errors,
  );
  for (const key of ["node", "npm", "wrangler"])
    text(tooling[key], `$.tooling.${key}`, errors, DEPLOYMENT_CONTRACT.patterns.semver);
  text(
    tooling.lockfileSha256,
    "$.tooling.lockfileSha256",
    errors,
    DEPLOYMENT_CONTRACT.patterns.digest,
  );
  const actions = obj(
    tooling.actions,
    "$.tooling.actions",
    Object.keys(tooling.actions as JsonObject),
    errors,
  );
  if (Object.keys(actions).length < 2 || Object.keys(actions).length > 8)
    errors.push("$.tooling.actions:BOUNDED_SET_REQUIRED");
  for (const [name, sha] of Object.entries(actions)) {
    text(name, `$.tooling.actions.${name}`, errors, "^[A-Za-z0-9_./-]+$");
    text(sha, `$.tooling.actions.${name}`, errors, DEPLOYMENT_CONTRACT.patterns.sha);
  }
  const gates = obj(root.gates, "$.gates", RECEIPT_KEYS, errors);
  for (const key of RECEIPT_KEYS) receiptPath(gates[key], `$.gates.${key}`, errors);
  if (new Set(Object.values(gates)).size !== RECEIPT_KEYS.length)
    errors.push("$.gates:DUPLICATE_RECEIPT_PATH");
  if (errors.length) fail(errors);
  return input as DeploymentManifest;
}

export function renderWranglerConfig(
  manifest: DeploymentManifest,
  main = "./worker/index.js",
  migrations = "./migrations",
): string {
  const c = manifest.cloudflare;
  const g = manifest.github;
  return `name = ${JSON.stringify(c.worker.name)}\nmain = ${JSON.stringify(main)}\naccount_id = ${JSON.stringify(c.accountId)}\ncompatibility_date = ${JSON.stringify(c.worker.compatibilityDate)}\nworkers_dev = false\npreview_urls = false\nroutes = [{ pattern = ${JSON.stringify(c.worker.route.pattern)}, custom_domain = true }]\n\n[vars]\nAPP_ENV = "production"\nWEB_ORIGIN = ${JSON.stringify(c.pages.webOrigin)}\nAPI_ORIGIN = ${JSON.stringify(c.worker.apiOrigin)}\nGITHUB_CLIENT_ID = ${JSON.stringify(g.oauthClientId)}\nGITHUB_APP_ID = ${JSON.stringify(g.appId)}\nGITHUB_APP_SLUG = ${JSON.stringify(g.appSlug)}\nGITHUB_APP_CLIENT_ID = ${JSON.stringify(g.appClientId)}\n\n[observability]\nenabled = true\nhead_sampling_rate = ${c.worker.observability.headSamplingRate}\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = ${JSON.stringify(c.d1.databaseName)}\ndatabase_id = ${JSON.stringify(c.d1.databaseId)}\nmigrations_dir = ${JSON.stringify(migrations)}\n\n[[r2_buckets]]\nbinding = "OBJECTS"\nbucket_name = ${JSON.stringify(c.r2.bucketName)}\n`;
}

function terminateGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {}
}

export async function runBounded(spec: CommandSpec): Promise<CommandResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let terminating = false;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    const settle = (error: PreflightError | null, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
      if (error) rejectPromise(error);
      else if (result) resolvePromise(result);
    };
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forceFinal = (code: string) => {
      if (!terminating) {
        terminating = true;
        terminateGroup(child, "SIGTERM");
        killTimer = setTimeout(
          () => terminateGroup(child, "SIGKILL"),
          DEPLOYMENT_CONTRACT.limits.terminationGraceMs,
        );
        finalTimer = setTimeout(
          () => settle(new PreflightError([code])),
          DEPLOYMENT_CONTRACT.limits.terminationGraceMs +
            DEPLOYMENT_CONTRACT.limits.finalCloseDeadlineMs,
        );
      }
    };
    const collect = (current: Buffer, chunk: Buffer): Buffer => {
      const next = Buffer.concat([current, chunk]);
      if (
        stdout.length + stderr.length + chunk.length >
        DEPLOYMENT_CONTRACT.limits.childOutputBytes
      )
        forceFinal("SUBPROCESS_OUTPUT_LIMIT");
      return next.subarray(0, DEPLOYMENT_CONTRACT.limits.childOutputBytes);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });
    let killTimer: NodeJS.Timeout | undefined;
    let finalTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => forceFinal("SUBPROCESS_TIMEOUT"), spec.timeoutMs);
    child.once("error", () => settle(new PreflightError(["SUBPROCESS_SPAWN_FAILED"])));
    child.once("close", (code, signal) => {
      if (terminating)
        settle(
          new PreflightError([
            stdout.length + stderr.length >= DEPLOYMENT_CONTRACT.limits.childOutputBytes
              ? "SUBPROCESS_OUTPUT_LIMIT"
              : "SUBPROCESS_TIMEOUT",
          ]),
        );
      else if (code !== 0 && !spec.expectedFailure)
        settle(new PreflightError(["SUBPROCESS_FAILED"]));
      else if (code === 0 && spec.expectedFailure)
        settle(new PreflightError(["NETWORK_SANDBOX_PROBE_ESCAPED"]));
      else settle(null, { stdout, stderr, code, signal });
    });
  });
}

async function canonicalExecutable(path: string): Promise<string> {
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isFile()) fail(["LOCAL_TOOL_INVALID"]);
  return resolved;
}

async function detectSandbox(staging: string): Promise<Sandbox> {
  if (process.platform === "darwin") {
    const executable = await canonicalExecutable("/usr/bin/sandbox-exec");
    const profile = join(staging, "deny-network.sb");
    await writeFile(
      profile,
      '(version 1)\n(allow default)\n(deny network*)\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n',
      { mode: 0o600 },
    );
    return { executable, prefix: ["-f", profile], kind: "darwin-sandbox-exec" };
  }
  if (process.platform === "linux") {
    for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap"]) {
      try {
        const executable = await canonicalExecutable(candidate);
        return {
          executable,
          prefix: ["--unshare-net", "--dev-bind", "/", "/", "--"],
          kind: "linux-bwrap",
        };
      } catch {}
    }
    for (const candidate of ["/usr/bin/unshare", "/bin/unshare"]) {
      try {
        const executable = await canonicalExecutable(candidate);
        return { executable, prefix: ["--net", "--"], kind: "linux-unshare" };
      } catch {}
    }
  }
  fail(["NETWORK_SANDBOX_UNAVAILABLE"]);
}

function isolatedEnvironment(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    TMPDIR: join(home, "tmp"),
    PATH: "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    CI: "1",
    NO_COLOR: "1",
    WRANGLER_SEND_METRICS: "false",
    ...extra,
  };
}

async function sandboxedRun(
  runner: ProcessRunner,
  sandbox: Sandbox,
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = DEPLOYMENT_CONTRACT.limits.childTimeoutMs,
  expectedFailure = false,
): Promise<CommandResult> {
  const result = await runner({
    executable: sandbox.executable,
    args: [...sandbox.prefix, executable, ...args],
    cwd,
    env,
    timeoutMs,
    expectedFailure,
  });
  if (expectedFailure ? result.code === 0 : result.code !== 0) {
    fail([expectedFailure ? "NETWORK_SANDBOX_PROBE_ESCAPED" : "SUBPROCESS_FAILED"]);
  }
  return result;
}

async function networkProbe(runner: ProcessRunner, sandbox: Sandbox, home: string): Promise<void> {
  const source =
    "const d=require('node:dns'),n=require('node:net');let x=0;const done=()=>{if(++x===2)process.exit(73)};const r=new d.Resolver();r.setServers(['1.1.1.1']);r.resolve4('cloudflare.com',e=>e?done():process.exit(0));const s=n.connect(53,'1.1.1.1',()=>process.exit(0));s.on('error',done);setTimeout(()=>process.exit(0),1500)";
  await sandboxedRun(
    runner,
    sandbox,
    process.execPath,
    ["-e", source],
    ROOT,
    isolatedEnvironment(home),
    4_000,
    true,
  );
}

export async function assertNetworkSandbox(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "context-hub-sandbox-probe-"));
  try {
    await mkdir(join(home, "tmp"), { mode: 0o700 });
    const sandbox = await detectSandbox(home);
    await networkProbe(runBounded, sandbox, home);
    return sandbox.kind;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function commandText(result: CommandResult, secretValues: string[]): Promise<void> {
  scanBytes([result.stdout, result.stderr], secretValues, "CHILD_OUTPUT_SECRET");
}

function scanBytes(contents: Buffer[], secretValues: string[], code: string): void {
  for (const content of contents) {
    const textValue = content.toString("utf8");
    if (
      secretValues.some((secret) => secret && textValue.includes(secret)) ||
      CREDENTIAL_PATTERNS.some((pattern) => pattern.test(textValue))
    )
      fail([code]);
  }
}

async function fileList(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) fail(["CANDIDATE_SYMLINK_FORBIDDEN"]);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) output.push(child);
      else fail(["CANDIDATE_SPECIAL_FILE_FORBIDDEN"]);
    }
  }
  await walk(root);
  return output.sort();
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

async function readBounded(path: string, max: number): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile() || info.size > max) fail(["BOUNDED_FILE_INVALID"]);
  return await readFile(path);
}

function receiptUnsigned(receipt: GateReceipt): Omit<GateReceipt, "receiptDigest"> {
  const { receiptDigest: _ignored, ...unsigned } = receipt;
  return unsigned;
}

export function finalizeReceipt(receipt: Omit<GateReceipt, "receiptDigest">): GateReceipt {
  return { ...receipt, receiptDigest: digest(canonicalJson(receipt)) };
}

function validateReceipt(value: unknown, gate: GateKey, manifest: DeploymentManifest): GateReceipt {
  const errors: string[] = [];
  const receipt = obj(
    value,
    `receipt.${gate}`,
    [
      "schemaVersion",
      "gate",
      "command",
      "commit",
      "result",
      "startedAt",
      "endedAt",
      "output",
      "tools",
      "generatedBy",
      "receiptDigest",
    ],
    errors,
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.gate !== gate ||
    receipt.command !== DEPLOYMENT_CONTRACT.gateCommands[gate] ||
    receipt.commit !== manifest.release.commit ||
    receipt.result !== "PASS" ||
    receipt.generatedBy !== "context-hub-gate-receipt-v1"
  )
    errors.push(`receipt.${gate}:IDENTITY_MISMATCH`);
  const started = Date.parse(String(receipt.startedAt));
  const ended = Date.parse(String(receipt.endedAt));
  if (!Number.isFinite(started) || !Number.isFinite(ended) || started > ended)
    errors.push(`receipt.${gate}:TIME_INVALID`);
  const output = obj(
    receipt.output,
    `receipt.${gate}.output`,
    ["bytes", "sha256", "truncated"],
    errors,
  );
  if (
    !Number.isInteger(output.bytes) ||
    Number(output.bytes) < 0 ||
    Number(output.bytes) > DEPLOYMENT_CONTRACT.limits.childOutputBytes ||
    !new RegExp(DEPLOYMENT_CONTRACT.patterns.digest).test(String(output.sha256)) ||
    output.truncated !== false
  )
    errors.push(`receipt.${gate}:OUTPUT_INVALID`);
  const tools = obj(receipt.tools, `receipt.${gate}.tools`, ["node", "npm", "wrangler"], errors);
  if (
    tools.node !== manifest.tooling.node ||
    tools.npm !== manifest.tooling.npm ||
    tools.wrangler !== manifest.tooling.wrangler
  )
    errors.push(`receipt.${gate}:TOOLS_MISMATCH`);
  const candidate = value as GateReceipt;
  if (candidate.receiptDigest !== digest(canonicalJson(receiptUnsigned(candidate))))
    errors.push(`receipt.${gate}:DIGEST_INVALID`);
  if (errors.length) fail(errors);
  return candidate;
}

async function loadReceipts(
  manifest: DeploymentManifest,
  receiptRoot: string,
  secretValues: string[],
): Promise<Map<GateKey, { receipt: GateReceipt; bytes: Buffer }>> {
  const result = new Map<GateKey, { receipt: GateReceipt; bytes: Buffer }>();
  const paths = new Set<string>();
  const digests = new Set<string>();
  const outputDigests = new Set<string>();
  for (const gate of RECEIPT_KEYS) {
    const relativePath = manifest.gates[gate];
    const absolute = resolve(receiptRoot, relativePath);
    if (!inside(receiptRoot, absolute)) fail([`RECEIPT_PATH_ESCAPE:${gate}`]);
    let bytes: Buffer;
    try {
      bytes = await readBounded(absolute, DEPLOYMENT_CONTRACT.limits.receiptBytes);
    } catch {
      fail([`RECEIPT_NOT_READABLE:${gate}`]);
    }
    scanBytes([bytes], secretValues, "RECEIPT_SECRET_DETECTED");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail([`RECEIPT_JSON_INVALID:${gate}`]);
    }
    const receipt = validateReceipt(parsed, gate, manifest);
    if (
      paths.has(absolute) ||
      digests.has(receipt.receiptDigest) ||
      outputDigests.has(receipt.output.sha256)
    )
      fail(["DUPLICATE_RECEIPT"]);
    paths.add(absolute);
    digests.add(receipt.receiptDigest);
    outputDigests.add(receipt.output.sha256);
    result.set(gate, { receipt, bytes: Buffer.from(`${canonicalJson(receipt)}\n`) });
  }
  return result;
}

async function checkRepository(
  manifest: DeploymentManifest,
  runner: ProcessRunner,
  sandbox: Sandbox,
  home: string,
  ciDetachedSha?: string,
): Promise<void> {
  const env = isolatedEnvironment(home);
  const execute = async (args: string[], expectedFailure = false) =>
    await sandboxedRun(runner, sandbox, "/usr/bin/git", args, ROOT, env, 15_000, expectedFailure);
  const head = (await execute(["rev-parse", "HEAD"])).stdout.toString("utf8").trim();
  if (head !== manifest.release.commit) fail(["GIT_COMMIT_MISMATCH"]);
  if ((await execute(["status", "--porcelain=v1", "--untracked-files=all"])).stdout.length)
    fail(["GIT_WORKTREE_NOT_CLEAN"]);
  let branch = "";
  try {
    branch = (await execute(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout
      .toString("utf8")
      .trim();
  } catch {}
  if (branch) {
    if (branch !== "main" || ciDetachedSha) fail(["GIT_BRANCH_MISMATCH"]);
  } else if (
    ciDetachedSha !== head ||
    !new RegExp(DEPLOYMENT_CONTRACT.patterns.sha).test(ciDetachedSha ?? "")
  )
    fail(["CI_DETACHED_SHA_REQUIRED"]);
}

export function collectActionPins(workflows: string): Record<string, string> {
  if (/uses:\s*[^\s@]+@(?![0-9a-f]{40}\b)/.test(workflows)) fail(["ACTION_REF_MUTABLE"]);
  const actual = new Map<string, string>();
  for (const match of workflows.matchAll(/uses:\s*([^\s@]+)@([0-9a-f]{40})\b/g)) {
    const name = match[1];
    const sha = match[2];
    if (!name || !sha) fail(["ACTION_REF_INVALID"]);
    if (actual.has(name) && actual.get(name) !== sha) fail(["CONFLICTING_ACTION_PIN"]);
    actual.set(name, sha);
  }
  return Object.fromEntries([...actual].sort());
}

async function staticChecks(manifest: DeploymentManifest): Promise<void> {
  const checkedSchema = await readFile(
    join(ROOT, "scripts/deployment-manifest.schema.json"),
    "utf8",
  );
  let parsedSchema: unknown;
  try {
    parsedSchema = JSON.parse(checkedSchema);
  } catch {
    fail(["GENERATED_SCHEMA_DRIFT"]);
  }
  if (canonicalJson(parsedSchema) !== canonicalJson(JSON.parse(generatedManifestSchema())))
    fail(["GENERATED_SCHEMA_DRIFT"]);
  const lock = await readFile(join(ROOT, "package-lock.json"));
  if (digest(lock) !== manifest.tooling.lockfileSha256) fail(["LOCKFILE_DIGEST_MISMATCH"]);
  const lockJson = JSON.parse(lock.toString("utf8"));
  const npmVersion = process.env.npm_config_user_agent?.match(
    /^npm\/([0-9]+\.[0-9]+\.[0-9]+)/,
  )?.[1];
  if (
    lockJson.packages?.["node_modules/wrangler"]?.version !== manifest.tooling.wrangler ||
    process.version.slice(1) !== manifest.tooling.node ||
    npmVersion !== manifest.tooling.npm
  )
    fail(["TOOL_VERSION_MISMATCH"]);
  const workflows = (
    await Promise.all(
      (
        await readdir(join(ROOT, ".github/workflows"))
      )
        .filter((name) => name.endsWith(".yml"))
        .map((name) => readFile(join(ROOT, ".github/workflows", name), "utf8")),
    )
  ).join("\n");
  const actual = collectActionPins(workflows);
  if (canonicalJson(actual) !== canonicalJson(manifest.tooling.actions))
    fail(["ACTION_LOCK_MISMATCH"]);
  const migrations = (await readdir(join(ROOT, "apps/api/migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (
    migrations.length !== 20 ||
    migrations.some((name, index) => !name.startsWith(`${String(index + 1).padStart(4, "0")}_`))
  )
    fail(["MIGRATION_ORDER_INVALID"]);
  for (const reference of [
    manifest.release.incidentRunbook,
    manifest.release.rollbackRunbook,
    manifest.cloudflare.worker.observability.policyReference,
    manifest.github.environmentProtectionReference,
  ]) {
    const path = reference.split("#")[0];
    if (!path || !inside(ROOT, resolve(ROOT, path))) fail(["REFERENCE_PATH_ESCAPE"]);
    await access(resolve(ROOT, path), constants.R_OK).catch(() => fail(["REFERENCE_MISSING"]));
  }
}

async function copyMigrations(destination: string): Promise<void> {
  await mkdir(destination, { mode: 0o700 });
  for (const name of (await readdir(join(ROOT, "apps/api/migrations")))
    .filter((item) => item.endsWith(".sql"))
    .sort())
    await copyFile(join(ROOT, "apps/api/migrations", name), join(destination, name));
}

async function candidateInventory(
  candidate: string,
): Promise<{ files: Array<{ path: string; bytes: number; sha256: string }>; digest: string }> {
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const path of await fileList(candidate)) {
    const rel = relative(candidate, path).split(sep).join("/");
    if (rel === "candidate.digest" || rel === "inventory.json") continue;
    const bytes = await readFile(path);
    entries.push({ path: rel, bytes: bytes.length, sha256: digest(bytes) });
  }
  const inventory = { schemaVersion: 1, files: entries };
  return { files: entries, digest: digest(canonicalJson(inventory)) };
}

export async function verifyCandidate(
  candidatePath: string,
  expectedDigest: string,
): Promise<{ digest: string; files: number }> {
  const candidate = await realpath(candidatePath);
  const mode = (await stat(candidate)).mode & 0o777;
  if (mode !== 0o700) fail(["CANDIDATE_MODE_INVALID"]);
  const config = join(candidate, "wrangler.toml");
  if (((await stat(config)).mode & 0o777) !== 0o600) fail(["CANDIDATE_CONFIG_MODE_INVALID"]);
  const digestFile = (await readFile(join(candidate, "candidate.digest"), "utf8")).trim();
  const retainedInventory = await readFile(join(candidate, "inventory.json"), "utf8");
  const current = await candidateInventory(candidate);
  if (digestFile !== expectedDigest) fail(["CANDIDATE_DIGEST_FILE_MISMATCH"]);
  if (current.digest !== expectedDigest) fail(["CANDIDATE_CONTENT_MISMATCH"]);
  if (digest(canonicalJson(JSON.parse(retainedInventory))) !== expectedDigest)
    fail(["CANDIDATE_INVENTORY_MISMATCH"]);
  return { digest: current.digest, files: current.files.length };
}

export async function runPreflight(
  manifestInput: unknown,
  options: PreflightOptions = {},
): Promise<{ candidatePath: string; candidateDigest: string; files: number }> {
  const manifest = validateManifest(manifestInput);
  const runner = options.runner ?? runBounded;
  const secretEnv = options.secretEnvironment ?? process.env;
  const secretValues: string[] = [];
  const presence: Record<string, boolean> = {};
  for (const name of DEPLOYMENT_CONTRACT.requiredSecrets) {
    const value = secretEnv[name];
    presence[name] = typeof value === "string" && value.trim().length > 0;
    if (presence[name]) secretValues.push(value as string);
  }
  const missing = Object.entries(presence)
    .filter(([, present]) => !present)
    .map(([name]) => `MISSING_SECRET:${name}`);
  if (missing.length) fail(missing);
  const candidateRoot = resolve(options.candidateRoot ?? join(ROOT, ".deployment/candidates"));
  await mkdir(candidateRoot, { recursive: true, mode: 0o700 });
  await chmod(candidateRoot, 0o700);
  const staging = await mkdtemp(join(candidateRoot, ".building-"));
  await chmod(staging, 0o700);
  try {
    const toolHome = join(staging, "tool-home");
    await mkdir(join(toolHome, "tmp"), { recursive: true, mode: 0o700 });
    const sandbox = options.sandbox ?? (await detectSandbox(staging));
    await networkProbe(runner, sandbox, toolHome);
    if (!options.skipRepositoryForTests)
      await checkRepository(manifest, runner, sandbox, toolHome, options.ciDetachedSha);
    await staticChecks(manifest);
    const receipts = await loadReceipts(
      manifest,
      resolve(options.receiptRoot ?? ROOT),
      secretValues,
    );
    const canonicalManifest = Buffer.from(`${canonicalJson(manifest)}\n`);
    scanBytes([canonicalManifest], secretValues, "MANIFEST_SECRET_DETECTED");
    await writeFile(join(staging, "manifest.json"), canonicalManifest, { mode: 0o600 });
    await copyMigrations(join(staging, "migrations"));
    await mkdir(join(staging, "receipts"), { mode: 0o700 });
    for (const [gate, value] of receipts)
      await writeFile(join(staging, "receipts", `${gate}.json`), value.bytes, { mode: 0o600 });
    const buildConfig = join(staging, "build.wrangler.toml");
    await writeFile(
      buildConfig,
      renderWranglerConfig(
        manifest,
        resolve(ROOT, "apps/api/src/index.ts"),
        join(staging, "migrations"),
      ),
      { mode: 0o600 },
    );
    const node = await canonicalExecutable(process.execPath);
    const wrangler = await canonicalExecutable(join(ROOT, "node_modules/.bin/wrangler"));
    const tsc = await canonicalExecutable(join(ROOT, "node_modules/.bin/tsc"));
    const vite = await canonicalExecutable(join(ROOT, "node_modules/.bin/vite"));
    const env = isolatedEnvironment(toolHome);
    for (const invocation of [
      [
        node,
        [
          wrangler,
          "d1",
          "migrations",
          "apply",
          "DB",
          "--local",
          "--config",
          buildConfig,
          "--persist-to",
          join(staging, "local-d1"),
        ],
        ROOT,
        env,
      ],
      [node, [tsc, "-p", join(ROOT, "apps/web/tsconfig.json")], ROOT, env],
      [
        node,
        [vite, "build", "--outDir", join(staging, "pages"), "--emptyOutDir"],
        join(ROOT, "apps/web"),
        isolatedEnvironment(toolHome, {
          VITE_API_URL: manifest.cloudflare.worker.apiOrigin,
          CF_PAGES: "1",
        }),
      ],
      [
        node,
        [
          wrangler,
          "deploy",
          "--dry-run",
          "--config",
          buildConfig,
          "--outdir",
          join(staging, "worker"),
        ],
        ROOT,
        env,
      ],
    ] as const) {
      const result = await sandboxedRun(
        runner,
        sandbox,
        invocation[0],
        [...invocation[1]],
        invocation[2],
        invocation[3],
      );
      await commandText(result, secretValues);
    }
    const headers = generatePagesHeaders({
      apiUrl: manifest.cloudflare.worker.apiOrigin,
      pagesDeployment: true,
    });
    await writeFile(join(staging, "pages/_headers"), headers, { mode: 0o600 });
    const pages = await fileList(join(staging, "pages"));
    const workers = await fileList(join(staging, "worker"));
    if (
      !pages.some((path) => basename(path) === "index.html") ||
      !pages.some((path) => basename(path) === "_headers") ||
      !pages.some((path) => path.includes(`${sep}assets${sep}`)) ||
      !workers.some((path) => path.endsWith(".js"))
    )
      fail(["CANDIDATE_ASSETS_INCOMPLETE"]);
    const workerBytes = (await Promise.all(workers.map((path) => readFile(path)))).reduce(
      (sum, bytes) => sum + bytes.length,
      0,
    );
    const workerGzip = (
      await Promise.all(workers.map(async (path) => gzipSync(await readFile(path)).length))
    ).reduce((a, b) => a + b, 0);
    if (
      workerBytes > DEPLOYMENT_CONTRACT.limits.workerBytes ||
      workerGzip > DEPLOYMENT_CONTRACT.limits.workerGzipBytes
    )
      fail(["WORKER_BUNDLE_TOO_LARGE"]);
    await rm(buildConfig);
    await rm(join(staging, "local-d1"), { recursive: true, force: true });
    await rm(toolHome, { recursive: true, force: true });
    await rm(join(staging, "deny-network.sb"), { force: true });
    await writeFile(join(staging, "wrangler.toml"), renderWranglerConfig(manifest), {
      mode: 0o600,
    });
    const evidence = {
      schemaVersion: 1,
      status: "PASS",
      commit: manifest.release.commit,
      manifestSha256: digest(canonicalManifest),
      secretPresence: presence,
      sandbox: sandbox.kind,
      migrations: 20,
      worker: { files: workers.length, bytes: workerBytes, gzipBytes: workerGzip },
      pages: { files: pages.length, headersSha256: digest(headers) },
    };
    await writeFile(join(staging, "evidence.json"), `${canonicalJson(evidence)}\n`, {
      mode: 0o600,
    });
    const allBeforeInventory = await fileList(staging);
    scanBytes(
      await Promise.all(allBeforeInventory.map((path) => readFile(path))),
      secretValues,
      "CANDIDATE_SECRET_DETECTED",
    );
    const inventory = await candidateInventory(staging);
    await writeFile(
      join(staging, "inventory.json"),
      `${canonicalJson({ schemaVersion: 1, files: inventory.files })}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(staging, "candidate.digest"), `${inventory.digest}\n`, { mode: 0o600 });
    const destination = join(
      candidateRoot,
      `${manifest.release.commit}-${inventory.digest.slice(0, 16)}`,
    );
    await rename(staging, destination);
    const verified = await verifyCandidate(destination, inventory.digest);
    return { candidatePath: destination, candidateDigest: verified.digest, files: verified.files };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function readManifest(path: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readBounded(path, DEPLOYMENT_CONTRACT.limits.manifestBytes);
  } catch {
    fail(["MANIFEST_NOT_READABLE"]);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(["MANIFEST_JSON_INVALID"]);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--verify-candidate") {
    if (args.length !== 4 || args[2] !== "--expect") fail(["VERIFY_USAGE"]);
    const result = await verifyCandidate(resolve(args[1] ?? ""), args[3] ?? "");
    process.stdout.write(`${canonicalJson({ status: "PASS", ...result })}\n`);
    return;
  }
  const manifestIndex = args.indexOf("--manifest");
  const detachedIndex = args.indexOf("--ci-detached-sha");
  const allowed = new Set([manifestIndex, manifestIndex + 1, detachedIndex, detachedIndex + 1]);
  if (
    manifestIndex < 0 ||
    !args[manifestIndex + 1] ||
    args.some((_arg, index) => !allowed.has(index))
  )
    fail(["USAGE:--manifest_PATH_[--ci-detached-sha_SHA]"]);
  const manifest = await readManifest(resolve(args[manifestIndex + 1] as string));
  const result = await runPreflight(manifest, {
    ciDetachedSha: detachedIndex >= 0 ? args[detachedIndex + 1] : undefined,
  });
  process.stdout.write(`${canonicalJson({ status: "PASS", ...result })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const codes = error instanceof PreflightError ? error.codes : ["PREFLIGHT_INTERNAL_ERROR"];
    process.stderr.write(`${canonicalJson({ status: "BLOCKED", missingPrerequisites: codes })}\n`);
    process.exitCode = 1;
  });
}
