import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { generatePagesHeaders } from "../apps/web/scripts/generate-security-headers.js";
import {
  assertNetworkSandbox,
  type CommandResult,
  type CommandSpec,
  collectActionPins,
  type DeploymentManifest,
  finalizeReceipt,
  PreflightError,
  renderWranglerConfig,
  runBounded,
  runPreflight,
  validateManifest,
  verifyCandidate,
} from "./deploy-preflight.mjs";
import { canonicalJson, DEPLOYMENT_CONTRACT } from "./deployment-contract.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const COMMIT = "dd65ff65906bcfd4cd03032420ebc26c5fbae571";
const LOCK = await readFile(join(ROOT, "package-lock.json"));
const LOCK_JSON = JSON.parse(LOCK.toString("utf8"));
const NPM = process.env.npm_config_user_agent?.match(/^npm\/([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? "";
if (!NPM) throw new Error("NPM_VERSION_REQUIRED");
const SECRETS = {
  GITHUB_CLIENT_SECRET: "local-only-alpha-value",
  GITHUB_APP_CLIENT_SECRET: "local-only-beta-value",
  GITHUB_APP_PRIVATE_KEY: "local-only-gamma-value",
};

function manifest(): DeploymentManifest {
  const gates = Object.fromEntries(
    Object.keys(DEPLOYMENT_CONTRACT.gateCommands).map((key) => [
      key,
      `.deployment/receipts/${key.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.json`,
    ]),
  ) as DeploymentManifest["gates"];
  return {
    schemaVersion: 1,
    release: {
      commit: COMMIT,
      branch: "main",
      changeId: "CHG-2601",
      changeWindow: { startsAt: "2026-10-01T01:00:00.000Z", endsAt: "2026-10-01T02:00:00.000Z" },
      owners: {
        release: "Release Operations",
        cloudflare: "Platform Operations",
        github: "Provider Operations",
        security: "Security Operations",
        incident: "Incident Commander",
      },
      incidentRunbook: "docs/ai/deployment.md#incident-decision-tree",
      rollbackRunbook: "docs/ai/deployment.md#rollback-decision-tree",
    },
    cloudflare: {
      accountId: "91c7402e5d8a4b63af012e69dc832b57",
      zoneId: "4de381b9a027c56f82da7301ecb9465f",
      worker: {
        name: "context-hub-production",
        environment: "production",
        apiOrigin: "https://api.context-hub.acmecorp.com",
        route: { pattern: "api.context-hub.acmecorp.com", customDomain: true },
        workersDev: false,
        previewUrls: false,
        compatibilityDate: "2025-02-14",
        observability: {
          enabled: true,
          headSamplingRate: 0.01,
          policyReference: "docs/ai/deployment.md#headers-cache-logs-and-usage",
        },
      },
      d1: {
        binding: "DB",
        databaseName: "context-hub-production",
        databaseId: "7d9a1f42-36bc-4e80-9f15-a28c63e704bd",
      },
      r2: {
        binding: "OBJECTS",
        bucketName: "context-hub-production-objects",
        private: true,
        r2Dev: false,
        customDomains: [],
        corsRules: [],
      },
      pages: {
        projectName: "context-hub-production",
        productionBranch: "main",
        webOrigin: "https://context-hub.acmecorp.com",
        apiPublicVariable: "VITE_API_URL",
        previewDeployments: false,
      },
    },
    github: {
      oauthClientId: "Iv1.19af6c807de4b321",
      oauthCallback: "https://api.context-hub.acmecorp.com/auth/github/callback",
      appId: "682941",
      appSlug: "context-hub-production",
      appClientId: "Iv1.93bc57d10ea2468f",
      appSetupUrl: "https://api.context-hub.acmecorp.com/auth/github-app/setup",
      appCallback: "https://api.context-hub.acmecorp.com/auth/github-app/callback",
      oauthScopes: [],
      appPermissions: { metadata: "read", contents: "read" },
      environment: "production",
      environmentProtectionReference: "docs/ai/deployment.md#github-production-environment",
    },
    requiredSecrets: [...DEPLOYMENT_CONTRACT.requiredSecrets],
    tooling: {
      node: process.version.slice(1),
      npm: NPM,
      wrangler: LOCK_JSON.packages["node_modules/wrangler"].version,
      lockfileSha256: createHash("sha256").update(LOCK).digest("hex"),
      actions: {
        "actions/checkout": "11bd71901bbe5b1630ceea73d27597364c9af683",
        "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
      },
    },
    gates,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: differential tests intentionally corrupt nested fields.
function reject(change: (value: any) => void, pattern: RegExp): void {
  const value = structuredClone(manifest());
  change(value);
  assert.throws(
    () => validateManifest(value),
    (error: unknown) => error instanceof PreflightError && pattern.test(error.codes.join("\n")),
  );
}

async function receipts(root: string, value = manifest()): Promise<void> {
  for (const [index, gate] of Object.keys(DEPLOYMENT_CONTRACT.gateCommands).entries()) {
    const key = gate as keyof typeof DEPLOYMENT_CONTRACT.gateCommands;
    const outputBytes = Buffer.from(`bounded local gate output ${key} ${index}`);
    const unsigned = {
      schemaVersion: 1 as const,
      gate: key,
      command: DEPLOYMENT_CONTRACT.gateCommands[key],
      commit: value.release.commit,
      result: "PASS" as const,
      startedAt: "2026-09-16T01:00:00.000Z",
      endedAt: "2026-09-16T01:01:00.000Z",
      output: {
        bytes: outputBytes.length,
        sha256: createHash("sha256").update(outputBytes).digest("hex"),
        truncated: false as const,
      },
      tools: { node: value.tooling.node, npm: value.tooling.npm, wrangler: value.tooling.wrangler },
      generatedBy: "context-hub-gate-receipt-v1" as const,
    };
    const path = join(root, value.gates[key]);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, `${canonicalJson(finalizeReceipt(unsigned))}\n`, { mode: 0o600 });
  }
}

type GitState = { head?: string; status?: string; branch?: string; detached?: boolean };
function recordingRunner(
  records: CommandSpec[],
  git: GitState = {},
): (spec: CommandSpec) => Promise<CommandResult> {
  return async (spec) => {
    records.push(structuredClone(spec));
    const command = spec.args.join(" ");
    if (command.includes("cloudflare.com") && command.includes("1.1.1.1"))
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("network denied"),
        code: 73,
        signal: null,
      };
    if (command.includes("rev-parse HEAD"))
      return {
        stdout: Buffer.from(`${git.head ?? COMMIT}\n`),
        stderr: Buffer.alloc(0),
        code: 0,
        signal: null,
      };
    if (command.includes("status --porcelain"))
      return {
        stdout: Buffer.from(git.status ?? ""),
        stderr: Buffer.alloc(0),
        code: 0,
        signal: null,
      };
    if (command.includes("symbolic-ref")) {
      if (git.detached)
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1, signal: null };
      return {
        stdout: Buffer.from(`${git.branch ?? "main"}\n`),
        stderr: Buffer.alloc(0),
        code: 0,
        signal: null,
      };
    }
    if (command.includes("vite") && command.includes(" build ")) {
      const index = spec.args.indexOf("--outDir");
      const output = spec.args[index + 1];
      assert.ok(output);
      await mkdir(join(output, "assets"), { recursive: true });
      await writeFile(join(output, "index.html"), "<html></html>");
      await writeFile(join(output, "assets/app.js"), "console.log('built')");
      await writeFile(join(output, "assets/app.js.map"), "{}");
    }
    if (command.includes("wrangler") && command.includes("deploy --dry-run")) {
      const index = spec.args.indexOf("--outdir");
      const output = spec.args[index + 1];
      assert.ok(output);
      await mkdir(output, { recursive: true });
      await writeFile(
        join(output, "index.js"),
        "export default {fetch(){return new Response('ok')}}",
      );
      await writeFile(join(output, "index.js.map"), "{}");
    }
    return {
      stdout: Buffer.from("bounded local output"),
      stderr: Buffer.alloc(0),
      code: 0,
      signal: null,
    };
  };
}

async function integration(
  git: GitState = {},
  options: { detachedSha?: string; secretEnvironment?: NodeJS.ProcessEnv } = {},
) {
  const operational = await mkdtemp(join(tmpdir(), "context-hub-preflight-case-"));
  const records: CommandSpec[] = [];
  await receipts(operational);
  try {
    const result = await runPreflight(manifest(), {
      candidateRoot: join(operational, "candidates"),
      receiptRoot: operational,
      runner: recordingRunner(records, git),
      sandbox: {
        executable: "/usr/bin/sandbox-exec",
        prefix: ["-p", "(deny network*)"],
        kind: "darwin-sandbox-exec",
      },
      ciDetachedSha: options.detachedSha,
      secretEnvironment: options.secretEnvironment ?? SECRETS,
    });
    return {
      operational,
      records,
      result,
      cleanup: async () => rm(operational, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(operational, { recursive: true, force: true });
    throw error;
  }
}

test("production manifest accepts exact nonreserved values", () => {
  assert.deepEqual(validateManifest(manifest()), manifest());
});

test("differential manifest fixtures reject every reserved host and placeholder class", () => {
  for (const host of [
    "api.service.test",
    "api.service.example",
    "api.service.invalid",
    "localhost",
    "127.0.0.1",
    "10.0.0.1",
    "169.254.1.1",
    "[::1]",
    "api.*.com",
    "API.service.com",
    "api.service.com.",
  ]) {
    reject((value) => {
      value.cloudflare.worker.apiOrigin = `https://${host}`;
    }, /RESERVED|IP_HOST|PRIVATE_HOST|NONCANONICAL|HTTPS_ORIGIN/);
  }
  for (const name of [
    "replace-me",
    "context-hub-fixture",
    "synthetic-worker",
    "demo-pages",
    "dummy-db",
    "todo-bucket",
  ])
    reject((value) => {
      value.cloudflare.worker.name = name;
    }, /RESERVED_VALUE/);
});

test("manifest rejects unknowns, URL components, mismatches, mutable refs and missing approvals", () => {
  reject((value) => {
    value.unknown = true;
  }, /UNKNOWN_FIELD/);
  for (const origin of [
    "http://api.context-hub.acmecorp.com",
    "https://u:p@api.context-hub.acmecorp.com",
    "https://api.context-hub.acmecorp.com/path",
    "https://api.context-hub.acmecorp.com?q=1",
    "https://api.context-hub.acmecorp.com#x",
  ])
    reject((value) => {
      value.cloudflare.worker.apiOrigin = origin;
    }, /HTTPS_ORIGIN/);
  reject((value) => {
    value.cloudflare.worker.route.pattern = "other.acmecorp.com";
  }, /ORIGIN_MISMATCH/);
  reject((value) => {
    value.github.oauthCallback = "https://api.context-hub.acmecorp.com/wrong";
  }, /URL_MISMATCH/);
  reject((value) => {
    value.release.commit = "main";
  }, /INVALID_FORMAT/);
  reject((value) => {
    value.tooling.wrangler = "^4.0.0";
  }, /INVALID_FORMAT/);
  reject((value) => {
    delete value.release.owners.release;
  }, /REQUIRED/);
  reject((value) => {
    delete value.release.changeWindow;
  }, /REQUIRED/);
  reject((value) => {
    delete value.release.rollbackRunbook;
  }, /REQUIRED/);
});

test("manifest rejects fixture IDs, public surfaces, preview and secret material", () => {
  for (const id of ["0".repeat(32), "a".repeat(32), "0123456789abcdef0123456789abcdef"])
    reject((value) => {
      value.cloudflare.accountId = id;
    }, /ID_FORBIDDEN/);
  reject((value) => {
    value.cloudflare.zoneId = value.cloudflare.accountId;
  }, /DUPLICATE_ID/);
  reject((value) => {
    value.cloudflare.d1.databaseId = "00000000-0000-0000-0000-000000000000";
  }, /INVALID_FORMAT|ZERO_ID/);
  reject((value) => {
    value.cloudflare.worker.workersDev = true;
  }, /FALSE_REQUIRED/);
  reject((value) => {
    value.cloudflare.worker.previewUrls = true;
  }, /FALSE_REQUIRED/);
  reject((value) => {
    value.cloudflare.pages.previewDeployments = true;
  }, /FALSE_REQUIRED/);
  reject((value) => {
    value.cloudflare.r2.r2Dev = true;
  }, /PRIVATE_ONLY/);
  reject((value) => {
    value.cloudflare.r2.customDomains = ["objects.acmecorp.com"];
  }, /PRIVATE_ONLY/);
  reject((value) => {
    value.github.privateKey =
      "-----BEGIN PRIVATE KEY-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
  }, /SECRET_/);
  reject((value) => {
    value.requiredSecrets = ["GITHUB_CLIENT_SECRET", "ACTUAL_SECRET"];
  }, /EXACT_NAMES/);
});

test("GitHub client IDs accept documented forms and reject guesses", () => {
  for (const id of ["short", "Iv1_not_documented", "github-client-123"])
    reject((value) => {
      value.github.oauthClientId = id;
    }, /INVALID_FORMAT/);
});

test("action pins reject mutable and conflicting duplicate action references", () => {
  const first = "1".repeat(40);
  const second = "2".repeat(40);
  assert.throws(() => collectActionPins(`uses: owner/action@main`), /ACTION_REF_MUTABLE/);
  assert.throws(
    () => collectActionPins(`uses: owner/action@${first}\nuses: owner/action@${second}`),
    /CONFLICTING_ACTION_PIN/,
  );
});

test("generated config is candidate-relative, private and disables both Worker public previews", () => {
  const config = renderWranglerConfig(manifest());
  assert.match(config, /main = "\.\/worker\/index\.js"/);
  assert.match(config, /migrations_dir = "\.\/migrations"/);
  assert.match(config, /workers_dev = false\npreview_urls = false/);
  assert.match(config, /database_id = "7d9a1f42-36bc-4e80-9f15-a28c63e704bd"/);
  assert.match(config, /bucket_name = "context-hub-production-objects"/);
  assert.match(config, /WEB_ORIGIN = "https:\/\/context-hub.acmecorp.com"/);
  assert.match(config, /compatibility_date = "2025-02-14"/);
  assert.doesNotMatch(config, /SECRET|r2\.dev/);
});

test("missing secrets fail with names only and no secret content", async () => {
  await assert.rejects(
    () => runPreflight(manifest(), { secretEnvironment: {} }),
    (error: unknown) =>
      error instanceof PreflightError &&
      error.codes.join().includes("MISSING_SECRET:GITHUB_CLIENT_SECRET") &&
      !error.codes.join().includes(SECRETS.GITHUB_CLIENT_SECRET),
  );
});

test("preflight records sandboxed local-only commands and retains an immutable candidate", async () => {
  const run = await integration();
  try {
    const commands = run.records.map((entry) => entry.args.join(" "));
    assert.ok(
      commands.some((command) => command.includes("cloudflare.com") && command.includes("1.1.1.1")),
    );
    assert.ok(commands.some((command) => command.includes("d1 migrations apply DB --local")));
    assert.ok(commands.some((command) => command.includes("deploy --dry-run")));
    assert.ok(commands.some((command) => /vite[^ ]* build/.test(command)));
    assert.ok(
      commands.every(
        (command) =>
          !/(--remote|versions upload|versions deploy|pages deploy|rollback)/.test(command),
      ),
    );
    assert.ok(run.records.every((entry) => entry.executable === "/usr/bin/sandbox-exec"));
    assert.ok(
      run.records.every(
        (entry) => !Object.keys(entry.env).some((key) => /proxy|cloudflare|github/i.test(key)),
      ),
    );
    const candidate = run.result.candidatePath;
    assert.equal((await stat(candidate)).mode & 0o777, 0o700);
    assert.equal((await stat(join(candidate, "wrangler.toml"))).mode & 0o777, 0o600);
    assert.equal(
      await readFile(join(candidate, "pages/_headers"), "utf8"),
      generatePagesHeaders({
        apiUrl: manifest().cloudflare.worker.apiOrigin,
        pagesDeployment: true,
      }),
    );
    assert.equal(
      (await verifyCandidate(candidate, run.result.candidateDigest)).digest,
      run.result.candidateDigest,
    );
    const evidence = await readFile(join(candidate, "evidence.json"), "utf8");
    for (const secret of Object.values(SECRETS)) assert.doesNotMatch(evidence, new RegExp(secret));
  } finally {
    await run.cleanup();
  }
});

test("two real sandboxed synthetic integrations retain independently verifiable candidates", {
  timeout: 240_000,
}, async (context) => {
  const roots = [
    await mkdtemp(join(tmpdir(), "context-hub-real-integration-a-")),
    await mkdtemp(join(tmpdir(), "context-hub-real-integration-b-")),
  ];
  try {
    const results = [];
    for (const root of roots) {
      await receipts(root);
      results.push(
        await runPreflight(manifest(), {
          candidateRoot: join(root, "candidates"),
          receiptRoot: root,
          skipRepositoryForTests: true,
          secretEnvironment: SECRETS,
        }),
      );
    }
    assert.equal(results[0]?.files, results[1]?.files);
    for (const result of results) {
      assert.ok(result);
      const verified = await verifyCandidate(result.candidatePath, result.candidateDigest);
      assert.equal(verified.digest, result.candidateDigest);
    }
    context.diagnostic(
      `candidate digests ${results.map((item) => item.candidateDigest).join(", ")}; retained files each ${results[0]?.files}`,
    );
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("candidate verification detects every retained byte change and path escapes", async () => {
  const run = await integration();
  try {
    await writeFile(join(run.result.candidatePath, "pages/index.html"), "changed");
    await assert.rejects(
      () => verifyCandidate(run.result.candidatePath, run.result.candidateDigest),
      /CANDIDATE_(?:CONTENT|DIGEST_FILE|INVENTORY)_MISMATCH/,
    );
    await assert.rejects(() =>
      verifyCandidate(join(run.result.candidatePath, "missing"), run.result.candidateDigest),
    );
  } finally {
    await run.cleanup();
  }
});

test("receipt identity, prior commit, command, digest, duplicate path and path escape fail", async () => {
  for (const mutation of [
    (value: DeploymentManifest) => {
      value.gates.typecheck = value.gates.test;
    },
    (value: DeploymentManifest) => {
      value.gates.test = "../escape.json";
    },
  ])
    reject(mutation, /DUPLICATE_RECEIPT_PATH|PATH_ESCAPE|INVALID_FORMAT/);
  const operational = await mkdtemp(join(tmpdir(), "context-hub-receipts-"));
  const value = manifest();
  await receipts(operational, value);
  try {
    const path = join(operational, value.gates.test);
    const original = JSON.parse(await readFile(path, "utf8"));
    for (const mutation of [
      (receipt: Record<string, unknown>) => {
        receipt.commit = "1".repeat(40);
      },
      (receipt: Record<string, unknown>) => {
        receipt.command = "npm test -- --changed";
      },
      (receipt: Record<string, unknown>) => {
        receipt.generatedBy = "self-attested";
      },
      (receipt: Record<string, unknown>) => {
        receipt.exitCode = 1;
      },
    ]) {
      const receipt = structuredClone(original);
      mutation(receipt);
      const { receiptDigest: _priorDigest, ...unsigned } = receipt;
      await writeFile(path, `${canonicalJson(finalizeReceipt(unsigned as never))}\n`);
      await assert.rejects(
        () =>
          runPreflight(value, {
            candidateRoot: join(operational, "c"),
            receiptRoot: operational,
            runner: recordingRunner([]),
            sandbox: {
              executable: "/usr/bin/sandbox-exec",
              prefix: [],
              kind: "darwin-sandbox-exec",
            },
            skipRepositoryForTests: true,
            secretEnvironment: SECRETS,
          }),
        /receipt\.test(?:\.exitCode)?:?(?:IDENTITY_MISMATCH|UNKNOWN_FIELD)/,
      );
    }
    await rm(path);
    await assert.rejects(
      () =>
        runPreflight(value, {
          candidateRoot: join(operational, "c"),
          receiptRoot: operational,
          runner: recordingRunner([]),
          sandbox: { executable: "/usr/bin/sandbox-exec", prefix: [], kind: "darwin-sandbox-exec" },
          skipRepositoryForTests: true,
          secretEnvironment: SECRETS,
        }),
      /RECEIPT_NOT_READABLE/,
    );
  } finally {
    await rm(operational, { recursive: true, force: true });
  }
});

test("clean main and exact detached identity pass; dirty, staged, untracked, wrong branch and SHA fail", async () => {
  for (const state of [
    { status: " M tracked\n" },
    { status: "M  staged\n" },
    { status: "?? untracked\n" },
    { branch: "release" },
    { head: "1".repeat(40) },
  ])
    await assert.rejects(() => integration(state), /GIT_/);
  const detached = await integration({ detached: true }, { detachedSha: COMMIT });
  await detached.cleanup();
  await assert.rejects(() => integration({ detached: true }), /CI_DETACHED_SHA_REQUIRED/);
});

test("secret values in child output and candidate files are rejected without disclosure", async () => {
  const operational = await mkdtemp(join(tmpdir(), "context-hub-secret-case-"));
  await receipts(operational);
  const records: CommandSpec[] = [];
  const base = recordingRunner(records);
  const leaking = async (spec: CommandSpec) => {
    const result = await base(spec);
    if (spec.args.join(" ").includes("d1 migrations"))
      result.stdout = Buffer.from(SECRETS.GITHUB_CLIENT_SECRET);
    return result;
  };
  try {
    await assert.rejects(
      () =>
        runPreflight(manifest(), {
          candidateRoot: join(operational, "c"),
          receiptRoot: operational,
          runner: leaking,
          sandbox: { executable: "/usr/bin/sandbox-exec", prefix: [], kind: "darwin-sandbox-exec" },
          skipRepositoryForTests: true,
          secretEnvironment: SECRETS,
        }),
      (error: unknown) =>
        error instanceof PreflightError &&
        error.codes.includes("CHILD_OUTPUT_SECRET") &&
        !error.message.includes(SECRETS.GITHUB_CLIENT_SECRET),
    );
  } finally {
    await rm(operational, { recursive: true, force: true });
  }
});

test("active Darwin/Linux sandbox probe denies DNS and sockets", { timeout: 15_000 }, async () => {
  const kind = await assertNetworkSandbox();
  assert.match(kind, /sandbox|unshare|bwrap/);
});

test("bounded runner handles spawn failure, output overflow and TERM-resistant descendants", {
  timeout: 15_000,
}, async () => {
  await assert.rejects(
    () =>
      runBounded({
        executable: "/definitely/missing",
        args: [],
        cwd: ROOT,
        env: {},
        timeoutMs: 100,
      }),
    /SUBPROCESS_SPAWN_FAILED/,
  );
  await assert.rejects(
    () =>
      runBounded({
        executable: process.execPath,
        args: [
          "-e",
          `process.stdout.write('x'.repeat(${DEPLOYMENT_CONTRACT.limits.childOutputBytes + 10}))`,
        ],
        cwd: ROOT,
        env: process.env,
        timeoutMs: 5_000,
      }),
    /SUBPROCESS_OUTPUT_LIMIT/,
  );
  const started = Date.now();
  await assert.rejects(
    () =>
      runBounded({
        executable: process.execPath,
        args: [
          "-e",
          "const{spawn}=require('child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],{stdio:'ignore'});setInterval(()=>{},1000)",
        ],
        cwd: ROOT,
        env: process.env,
        timeoutMs: 100,
      }),
    /SUBPROCESS_TIMEOUT/,
  );
  assert.ok(Date.now() - started < 4_000);
});
