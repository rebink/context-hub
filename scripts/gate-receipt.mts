import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  finalizeReceipt,
  type GateReceipt,
  PreflightError,
  runBounded,
} from "./deploy-preflight.mjs";
import { canonicalJson, DEPLOYMENT_CONTRACT } from "./deployment-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type GateKey = keyof typeof DEPLOYMENT_CONTRACT.gateCommands;

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertRedactedOutput(value: Buffer): void {
  const text = value.toString("utf8");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{32,}/.test(text) ||
    /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:chmcp|chci)_[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~-]{24,}/i.test(
      text,
    )
  )
    throw new PreflightError(["GATE_OUTPUT_SECRET_DETECTED"]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--gate" || args[2] !== "--output")
    throw new PreflightError(["USAGE:--gate_GATE_--output_PATH"]);
  const gate = args[1] as GateKey;
  if (!(gate in DEPLOYMENT_CONTRACT.gateCommands)) throw new PreflightError(["UNKNOWN_GATE"]);
  const outputPath = resolve(args[3] ?? "");
  if (!outputPath.startsWith(`${resolve(ROOT, ".deployment/receipts")}/`))
    throw new PreflightError(["RECEIPT_OUTPUT_PATH_FORBIDDEN"]);
  const status = await runBounded({
    executable: "/usr/bin/git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: ROOT,
    env: { HOME: "/tmp", PATH: "/usr/bin:/bin", LC_ALL: "C" },
    timeoutMs: 15_000,
  });
  if (status.stdout.length) throw new PreflightError(["GIT_WORKTREE_NOT_CLEAN"]);
  const head = (
    await runBounded({
      executable: "/usr/bin/git",
      args: ["rev-parse", "HEAD"],
      cwd: ROOT,
      env: { HOME: "/tmp", PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeoutMs: 15_000,
    })
  ).stdout
    .toString("utf8")
    .trim();
  const npmExec = process.env.npm_execpath;
  const npmVersion = process.env.npm_config_user_agent?.match(
    /^npm\/([0-9]+\.[0-9]+\.[0-9]+)/,
  )?.[1];
  if (!npmExec || !npmVersion) throw new PreflightError(["NPM_EXECUTABLE_REQUIRED"]);
  const lock = JSON.parse(await readFile(resolve(ROOT, "package-lock.json"), "utf8"));
  const wrangler = lock.packages?.["node_modules/wrangler"]?.version;
  if (typeof wrangler !== "string") throw new PreflightError(["WRANGLER_VERSION_REQUIRED"]);
  const temp = await mkdtemp("/tmp/context-hub-gate-receipt-");
  try {
    const command = DEPLOYMENT_CONTRACT.gateCommands[gate];
    const npmArgs =
      command === "npm test"
        ? ["test"]
        : command.startsWith("npm run ")
          ? ["run", ...command.slice(8).split(" ")]
          : command.slice(4).split(" ");
    const startedAt = new Date().toISOString();
    const result = await runBounded({
      executable: process.execPath,
      args: [await realpath(npmExec), ...npmArgs],
      cwd: ROOT,
      env: {
        HOME: temp,
        TMPDIR: temp,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        LC_ALL: "C",
        LANG: "C",
        CI: "1",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        npm_config_offline: "true",
      },
      timeoutMs: gate === "localE2e" || gate === "test" ? 360_000 : 240_000,
    });
    const combined = Buffer.concat([result.stdout, result.stderr]);
    assertRedactedOutput(combined);
    const unsigned: Omit<GateReceipt, "receiptDigest"> = {
      schemaVersion: 1,
      gate,
      command,
      commit: head,
      result: "PASS",
      startedAt,
      endedAt: new Date().toISOString(),
      output: { bytes: combined.length, sha256: digest(combined), truncated: false },
      tools: { node: process.version.slice(1), npm: npmVersion, wrangler },
      generatedBy: "context-hub-gate-receipt-v1",
    };
    const receipt = finalizeReceipt(unsigned);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(outputPath), 0o700);
    await writeFile(outputPath, `${canonicalJson(receipt)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(
      `${canonicalJson({ status: "PASS", gate, receiptDigest: receipt.receiptDigest })}\n`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  const codes = error instanceof PreflightError ? error.codes : ["GATE_RECEIPT_INTERNAL_ERROR"];
  process.stderr.write(`${canonicalJson({ status: "BLOCKED", missingPrerequisites: codes })}\n`);
  process.exitCode = 1;
});
