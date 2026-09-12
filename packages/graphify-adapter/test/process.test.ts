import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GraphAdapterError, NodeProcessBoundary } from "../src/index.js";

const boundary = new NodeProcessBoundary();

test("process boundary rejects unsupported execution before spawn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-process-unsupported-"));
  const marker = path.join(root, "spawned.txt");
  try {
    const unsupported = new NodeProcessBoundary({
      testOnlyDisabledRuntimeCapabilities: ["posixProcessGroups"],
    });
    await assert.rejects(
      unsupported.run({
        executable: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'spawned')", marker],
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeoutMs: 1000,
      }),
      (error: unknown) =>
        error instanceof GraphAdapterError &&
        error.kind === "UNSUPPORTED_PLATFORM" &&
        error.message === "Graph build failed: UNSUPPORTED_PLATFORM",
    );
    await assert.rejects(readFile(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process boundary times out and reports only the stable adapter failure", async () => {
  await assert.rejects(
    boundary.run({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 20,
    }),
    (error: unknown) =>
      error instanceof GraphAdapterError &&
      error.kind === "PROCESS_TIMEOUT" &&
      error.message === "Graph build failed: PROCESS_TIMEOUT",
  );
});

test("process boundary rejects oversized diagnostics without exposing them", async () => {
  await assert.rejects(
    boundary.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('secret'.repeat(4000))"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 1000,
    }),
    (error: unknown) =>
      error instanceof GraphAdapterError && error.message === "Graph build failed: PROCESS_FAILED",
  );
});

test("process boundary handles an immediate exit while writing large stdin", async () => {
  await assert.rejects(
    boundary.run({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 2000,
      stdin: Buffer.alloc(4 * 1024 * 1024),
    }),
    (error: unknown) => error instanceof GraphAdapterError && error.kind === "PROCESS_FAILED",
  );
});

test("process boundary kills detached descendants after a successful leader exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-process-group-"));
  const marker = path.join(root, "descendant.txt");
  try {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const code = `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'survived'), 300)`;",
      "spawn(process.execPath, ['-e', code, process.argv[1]], { stdio: 'ignore' }).unref();",
    ].join("\n");
    await boundary.run({
      executable: process.execPath,
      args: ["-e", script, marker],
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(readFile(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process boundary maps spawn and nonzero races once", async () => {
  const request = {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    timeoutMs: 2000,
    stdin: Buffer.alloc(2 * 1024 * 1024),
  };
  await assert.rejects(
    boundary.run({ ...request, executable: pathThatCannotExist(), args: [] }),
    (error: unknown) => error instanceof GraphAdapterError && error.kind === "PROCESS_FAILED",
  );
  await assert.rejects(
    boundary.run({
      ...request,
      executable: process.execPath,
      args: ["-e", "process.exit(7)"],
    }),
    (error: unknown) => error instanceof GraphAdapterError && error.kind === "PROCESS_FAILED",
  );
});

function pathThatCannotExist(): string {
  return `${process.cwd()}/.missing-process-${process.pid}`;
}
