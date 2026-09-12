import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { trustExecutable } from "../src/executable.js";
import { GraphAdapterError, NodeProcessBoundary, type ProcessBoundary } from "../src/index.js";
import {
  type CheckoutSnapshot,
  inspectCheckout as inspectCheckoutWithGit,
  verifyCheckout as verifyCheckoutWithGit,
} from "../src/preflight.js";

const execute = promisify(execFile);
const boundary = new NodeProcessBoundary();
const GIT_EXECUTABLE = await realpath((await execute("which", ["git"])).stdout.trim());

async function inspectCheckout(
  processBoundary: ProcessBoundary,
  root: string,
  commit: string,
): Promise<CheckoutSnapshot> {
  return await inspectCheckoutWithGit(
    processBoundary,
    await trustExecutable(GIT_EXECUTABLE, await realpath(root)),
    root,
    commit,
  );
}

async function verifyCheckout(
  processBoundary: ProcessBoundary,
  snapshot: CheckoutSnapshot,
  commit: string,
): Promise<void> {
  return await verifyCheckoutWithGit(
    processBoundary,
    await trustExecutable(GIT_EXECUTABLE, snapshot.root),
    snapshot,
    commit,
  );
}

async function repository(): Promise<{ root: string; commit: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-preflight-git-"));
  await execute("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "main.py"), "print('ok')\n");
  await execute("git", ["add", "main.py"], { cwd: root });
  await execute(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"],
    { cwd: root },
  );
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: root });
  await execute("git", ["checkout", "-q", "--detach", stdout.trim()], { cwd: root });
  return { root, commit: stdout.trim() };
}

test("real Git preflight returns a tracked regular POSIX manifest", async () => {
  const fixture = await repository();
  try {
    const snapshot = await inspectCheckout(boundary, fixture.root, fixture.commit);
    assert.deepEqual(snapshot.paths, ["main.py"]);
    assert.deepEqual(Buffer.from(snapshot.manifestBytes), Buffer.from("main.py\0"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("preflight rejects staged, unstaged, untracked, and ignored-present files", async () => {
  for (const prepare of [
    async (root: string) => {
      await writeFile(path.join(root, "main.py"), "changed\n");
    },
    async (root: string) => {
      await writeFile(path.join(root, "new.py"), "new\n");
    },
    async (root: string) => {
      await writeFile(path.join(root, ".gitignore"), "ignored.py\n");
      await execute("git", ["add", ".gitignore"], { cwd: root });
      await execute(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-qm",
          "ignore",
        ],
        { cwd: root },
      );
      await execute("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: root });
      await writeFile(path.join(root, "ignored.py"), "ignored\n");
    },
    async (root: string) => {
      await writeFile(path.join(root, "staged.py"), "staged\n");
      await execute("git", ["add", "staged.py"], { cwd: root });
    },
  ]) {
    const fixture = await repository();
    try {
      await prepare(fixture.root);
      const current = (
        await execute("git", ["rev-parse", "HEAD"], { cwd: fixture.root })
      ).stdout.trim();
      await assert.rejects(inspectCheckout(boundary, fixture.root, current));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("preflight rejects assume-unchanged and skip-worktree index flags", async () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const fixture = await repository();
    try {
      await execute("git", ["update-index", flag, "main.py"], { cwd: fixture.root });
      await assert.rejects(
        inspectCheckout(boundary, fixture.root, fixture.commit),
        (error: unknown) =>
          error instanceof GraphAdapterError && error.kind === "UNSUPPORTED_REPOSITORY_CONTENT",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("preflight compares tracked worktree bytes with the stage-0 blob despite clean status", async () => {
  const fixture = await repository();
  try {
    await writeFile(path.join(fixture.root, "main.py"), "print('tampered')\n");
    const hidePorcelain: ProcessBoundary = {
      async run(request) {
        if (request.executable === GIT_EXECUTABLE && request.args.includes("status")) {
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        return await boundary.run(request);
      },
    };
    await assert.rejects(
      inspectCheckout(hidePorcelain, fixture.root, fixture.commit),
      (error: unknown) =>
        error instanceof GraphAdapterError && error.kind === "UNSUPPORTED_REPOSITORY_CONTENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("preflight rejects gitlinks and tracked .gitmodules", async () => {
  for (const gitmodules of [false, true]) {
    const fixture = await repository();
    try {
      if (gitmodules) {
        await writeFile(
          path.join(fixture.root, ".gitmodules"),
          '[submodule "vendor"]\n\tpath = vendor\n\turl = https://example.invalid/vendor\n',
        );
        await execute("git", ["add", ".gitmodules"], { cwd: fixture.root });
      } else {
        await execute(
          "git",
          ["update-index", "--add", "--cacheinfo", `160000,${fixture.commit},vendor`],
          { cwd: fixture.root },
        );
      }
      await execute(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-qm",
          "unsupported",
        ],
        { cwd: fixture.root },
      );
      const commit = (
        await execute("git", ["rev-parse", "HEAD"], { cwd: fixture.root })
      ).stdout.trim();
      await execute("git", ["checkout", "-q", "--detach", commit], { cwd: fixture.root });
      await assert.rejects(inspectCheckout(boundary, fixture.root, commit));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("preflight rejects Windows drive-form paths on every platform", async () => {
  if (process.platform === "win32") return;
  const fixture = await repository();
  try {
    await writeFile(path.join(fixture.root, "C:escape.py"), "print('bad')\n");
    await execute("git", ["add", "C:escape.py"], { cwd: fixture.root });
    await execute(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "drive"],
      { cwd: fixture.root },
    );
    const commit = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: fixture.root })
    ).stdout.trim();
    await execute("git", ["checkout", "-q", "--detach", commit], { cwd: fixture.root });
    await assert.rejects(
      inspectCheckout(boundary, fixture.root, commit),
      (error: unknown) =>
        error instanceof GraphAdapterError && error.kind === "UNSUPPORTED_REPOSITORY_CONTENT",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Git preflight and postflight preserve process timeout taxonomy", async () => {
  const timedOut: ProcessBoundary = {
    async run() {
      throw new GraphAdapterError("PROCESS_TIMEOUT");
    },
  };
  await assert.rejects(
    inspectCheckout(timedOut, process.cwd(), "0".repeat(40)),
    (error: unknown) => error instanceof GraphAdapterError && error.kind === "PROCESS_TIMEOUT",
  );
  await assert.rejects(
    verifyCheckout(
      timedOut,
      {
        root: process.cwd(),
        paths: [],
        fingerprint: "0".repeat(64),
        manifestBytes: Buffer.alloc(0),
        manifestSha256: "0".repeat(64),
      },
      "0".repeat(40),
    ),
    (error: unknown) => error instanceof GraphAdapterError && error.kind === "PROCESS_TIMEOUT",
  );
});

test("preflight rejects index symlinks and LFS pointers", async () => {
  for (const lfs of [false, true]) {
    const fixture = await repository();
    try {
      if (lfs) {
        await writeFile(
          path.join(fixture.root, "large.bin"),
          "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n",
        );
      } else {
        await symlink("main.py", path.join(fixture.root, "linked.py"));
      }
      await execute("git", ["add", lfs ? "large.bin" : "linked.py"], { cwd: fixture.root });
      await execute(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-qm",
          "unsupported",
        ],
        { cwd: fixture.root },
      );
      const commit = (
        await execute("git", ["rev-parse", "HEAD"], { cwd: fixture.root })
      ).stdout.trim();
      await execute("git", ["checkout", "-q", "--detach", commit], { cwd: fixture.root });
      await assert.rejects(inspectCheckout(boundary, fixture.root, commit));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});
