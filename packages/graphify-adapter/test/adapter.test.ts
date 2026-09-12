import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  GraphAdapterError,
  GraphifyAdapter,
  type GraphifyAdapterOptions,
  NodeProcessBoundary,
  type ProcessBoundary,
  type ProcessRequest,
  type ProcessResult,
} from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures/graphify-0.9.58.graph.json");
const COMMIT = "9ebc249f02b2a66257816378f73683566aded0ed";
const FILES = ["main.py", "pkg/__init__.py", "pkg/core.py"];
const system = new NodeProcessBoundary();
const execute = promisify(execFile);
const TOOL_ROOT = await realpath(await mkdtemp(path.join(os.tmpdir(), "graph-adapter-tools-")));
const GIT_EXECUTABLE = path.join(TOOL_ROOT, "git");
const PYTHON_EXECUTABLE = await realpath((await execute("which", ["python3"])).stdout.trim());
const GRAPHIFY_EXECUTABLE = path.join(TOOL_ROOT, "graphify");
for (const executable of [GIT_EXECUTABLE, GRAPHIFY_EXECUTABLE]) {
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o700);
}
after(async () => rm(TOOL_ROOT, { recursive: true, force: true }));

class FixtureBoundary implements ProcessBoundary {
  readonly calls: ProcessRequest[] = [];
  output: Buffer;
  failCommand = "";
  graphifyVersion = "graphify 0.9.58\n";
  graphifyVersionStderr = "";
  pythonVersion = "Python 3.11.9\n";
  pythonVersionStderr = "";
  skipOutput = false;
  ambiguousOutput = false;
  dirtyPostflight = false;
  validatorOverride?: string;
  afterOutput?: (output: string) => Promise<void>;
  #statusCalls = 0;

  constructor(output: Buffer) {
    this.output = output;
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.calls.push(request);
    if (request.executable === GIT_EXECUTABLE) {
      const operation = request.args.join(" ");
      if (operation.includes("rev-parse --verify")) return result(`${COMMIT}\n`);
      if (operation.includes("rev-parse --abbrev-ref")) return result("HEAD\n");
      if (operation.includes("rev-parse --show-object-format")) return result("sha1\n");
      if (operation.includes("status")) {
        this.#statusCalls += 1;
        return result(this.dirtyPostflight && this.#statusCalls > 1 ? "?? injected.py\0" : "");
      }
      if (operation.includes("--others --ignored")) return result("");
      if (operation.includes("ls-files --stage")) {
        const records = await Promise.all(
          FILES.map(async (file) => {
            const bytes = await readFile(path.join(request.cwd, file));
            const objectId = createHash("sha1")
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest("hex");
            return `H 100644 ${objectId} 0\t${file}\0`;
          }),
        );
        return result(records.join(""));
      }
    }
    if (request.args.length === 1 && request.args[0] === "--version") {
      return request.executable === PYTHON_EXECUTABLE
        ? result(this.pythonVersion, this.pythonVersionStderr)
        : result(this.graphifyVersion, this.graphifyVersionStderr);
    }
    if (request.executable === PYTHON_EXECUTABLE && this.validatorOverride !== undefined) {
      return result(this.validatorOverride);
    }
    if (request.executable === GRAPHIFY_EXECUTABLE) {
      if (request.args[0] === this.failCommand) throw new GraphAdapterError("PROCESS_FAILED");
      if (request.args[0] === "cluster-only" && !this.skipOutput) {
        const output = request.env.GRAPHIFY_OUT ?? "";
        await writeFile(path.join(output, "graph.json"), this.output);
        if (this.ambiguousOutput) {
          await mkdir(path.join(output, "nested"));
          await writeFile(path.join(output, "nested/graph.json"), this.output);
        }
        await this.afterOutput?.(output);
      }
      return result("");
    }
    return await system.run(request);
  }
}

function adapter(
  boundary: ProcessBoundary,
  options: Omit<GraphifyAdapterOptions, "processBoundary"> = {},
): GraphifyAdapter {
  return new GraphifyAdapter({
    gitExecutable: GIT_EXECUTABLE,
    pythonExecutable: PYTHON_EXECUTABLE,
    graphifyExecutable: GRAPHIFY_EXECUTABLE,
    ...options,
    processBoundary: boundary,
  });
}

function result(stdout: string, stderr = ""): ProcessResult {
  return { stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

async function checkout(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "graph-adapter-fixture-"));
  await mkdir(path.join(root, "pkg"));
  await writeFile(path.join(root, "main.py"), "from pkg.core import Greeter\n");
  await writeFile(path.join(root, "pkg/__init__.py"), "");
  await writeFile(path.join(root, "pkg/core.py"), "class Greeter:\n    pass\n");
  return root;
}

function input(root: string) {
  return {
    checkoutPath: root,
    projectId: "project-1",
    repositoryProvider: "github",
    providerRepositoryId: "1234",
    repositoryIdentitySnapshot: {
      provider: "github",
      providerRepositoryId: "1234",
      owner: "owner",
      name: "repo",
      canonicalUrl: "https://github.com/owner/repo",
    },
    sourceCommitSha: COMMIT,
    executorPolicy: {
      attested: true as const,
      memoryLimitBytes: 4_000_000_000,
      diskLimitBytes: 10_000_000_000,
    },
  };
}

test("build returns captured exact bytes, derived integrity, and fixed metadata", async () => {
  const root = await checkout();
  try {
    const fixture = await readFile(FIXTURE);
    const boundary = new FixtureBoundary(fixture);
    const built = await adapter(boundary).build(input(root));
    assert.deepEqual(Buffer.from(built.bytes), fixture);
    assert.equal(built.byteSize, 5242);
    assert.equal(
      built.contentChecksumSha256,
      "25a9311a26ea28bf3d87a1cf186e4f1d10e962381bc39fdc815687dea57f085c",
    );
    assert.deepEqual([built.nodeCount, built.linkCount, built.hyperedgeCount], [7, 10, 0]);
    assert.deepEqual(
      [built.graphifyVersion, built.adapterVersion, built.profile, built.formatVersion],
      ["0.9.58", "1.0.0", "code-only-clustered-v1", 1],
    );
    assert.match(built.generator, /graphify\/0\.9\.58/);
    const graphCalls = boundary.calls.filter((call) => call.executable === GRAPHIFY_EXECUTABLE);
    assert.equal(
      boundary.calls.every((call) => path.isAbsolute(call.executable)),
      true,
    );
    assert.equal(
      boundary.calls.every((call) => call.env.PATH === "/usr/bin:/bin"),
      true,
    );
    const canonicalRoot = await realpath(root);
    assert.deepEqual(
      graphCalls.map((call) => call.args),
      [
        ["--version"],
        ["extract", canonicalRoot, "--code-only", "--no-cluster"],
        ["cluster-only", canonicalRoot, "--no-label", "--no-viz"],
      ],
    );
    assert.equal(graphCalls[1]?.env.GRAPHIFY_OUT, graphCalls[2]?.env.GRAPHIFY_OUT);
    assert.deepEqual(Object.keys(graphCalls[1]?.env ?? {}).sort(), [
      "GRAPHIFY_OUT",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TMPDIR",
    ]);
    assert.equal(
      Object.values(graphCalls[1]?.env ?? {}).some((value) => value.includes("TOKEN=bad")),
      false,
    );
    await assert.rejects(readFile(path.join(graphCalls[1]?.env.GRAPHIFY_OUT ?? "", "graph.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsupported runtime capabilities before subprocess or temporary output effects", async () => {
  const root = await checkout();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "graph-adapter-unsupported-"));
  try {
    for (const capability of ["posixProcessGroups", "O_NOFOLLOW", "O_NONBLOCK"] as const) {
      const boundary = new FixtureBoundary(await readFile(FIXTURE));
      let cleanupCalls = 0;
      await assert.rejects(
        adapter(boundary, {
          tempRoot,
          testOnlyDisabledRuntimeCapabilities: [capability],
          cleanup: async () => {
            cleanupCalls += 1;
          },
        }).build(input(root)),
        (error: unknown) =>
          error instanceof GraphAdapterError &&
          error.kind === "UNSUPPORTED_PLATFORM" &&
          error.message === "Graph build failed: UNSUPPORTED_PLATFORM",
      );
      assert.equal(boundary.calls.length, 0);
      assert.equal(cleanupCalls, 0);
      assert.deepEqual(await readdir(tempRoot), []);
    }
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(tempRoot, { recursive: true, force: true }),
    ]);
  }
});

test("rejects checkout-equal temp roots before subprocess or temporary effects", async () => {
  const root = await checkout();
  const before = (await readdir(root)).sort();
  try {
    const boundary = new FixtureBoundary(await readFile(FIXTURE));
    let cleanupCalls = 0;
    await assert.rejects(
      adapter(boundary, {
        tempRoot: root,
        cleanup: async () => {
          cleanupCalls += 1;
        },
      }).build(input(root)),
      (error: unknown) =>
        error instanceof GraphAdapterError &&
        error.kind === "INVALID_CHECKOUT" &&
        error.message === "Graph build failed: INVALID_CHECKOUT",
    );
    assert.equal(boundary.calls.length, 0);
    assert.equal(cleanupCalls, 0);
    assert.deepEqual((await readdir(root)).sort(), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects checkout-nested temp roots before subprocess or temporary effects", async () => {
  const root = await checkout();
  const nested = path.join(root, "configured-temp");
  await mkdir(nested);
  try {
    const boundary = new FixtureBoundary(await readFile(FIXTURE));
    let cleanupCalls = 0;
    await assert.rejects(
      adapter(boundary, {
        tempRoot: nested,
        cleanup: async () => {
          cleanupCalls += 1;
        },
      }).build(input(root)),
      (error: unknown) =>
        error instanceof GraphAdapterError &&
        error.kind === "INVALID_CHECKOUT" &&
        error.message === "Graph build failed: INVALID_CHECKOUT",
    );
    assert.equal(boundary.calls.length, 0);
    assert.equal(cleanupCalls, 0);
    assert.deepEqual(await readdir(nested), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects temp roots resolving through a symlink into the checkout without effects", async () => {
  const root = await checkout();
  const nested = path.join(root, "configured-temp");
  const aliases = await mkdtemp(path.join(os.tmpdir(), "graph-adapter-temp-alias-"));
  const alias = path.join(aliases, "inside-checkout");
  await mkdir(nested);
  await symlink(nested, alias);
  try {
    const boundary = new FixtureBoundary(await readFile(FIXTURE));
    let cleanupCalls = 0;
    await assert.rejects(
      adapter(boundary, {
        tempRoot: alias,
        cleanup: async () => {
          cleanupCalls += 1;
        },
      }).build(input(root)),
      (error: unknown) =>
        error instanceof GraphAdapterError &&
        error.kind === "INVALID_CHECKOUT" &&
        error.message === "Graph build failed: INVALID_CHECKOUT",
    );
    assert.equal(boundary.calls.length, 0);
    assert.equal(cleanupCalls, 0);
    assert.deepEqual(await readdir(nested), []);
    assert.deepEqual(await readdir(aliases), ["inside-checkout"]);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(aliases, { recursive: true, force: true }),
    ]);
  }
});

test("uses and cleans a canonical external configured temp root", async () => {
  const root = await checkout();
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "graph-adapter-output-")));
  try {
    const boundary = new FixtureBoundary(await readFile(FIXTURE));
    await adapter(boundary, { tempRoot }).build(input(root));
    assert.equal(boundary.calls.length > 0, true);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(tempRoot, { recursive: true, force: true }),
    ]);
  }
});

test("rejects untrusted executable configuration before subprocess or temporary effects", async () => {
  const root = await checkout();
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "graph-adapter-trust-")));
  const external = path.join(tempRoot, "external-tool");
  const linked = path.join(tempRoot, "linked-tool");
  const checkoutTool = path.join(root, "marker-tool");
  await writeFile(external, "#!/bin/sh\nexit 0\n");
  await chmod(external, 0o700);
  await symlink(external, linked);
  await writeFile(checkoutTool, "#!/bin/sh\ntouch marker-effect\n");
  await chmod(checkoutTool, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `.:${root}:/usr/bin`;
  try {
    const scenarios: Array<[string, string | undefined]> = [
      ["missing configuration", undefined],
      ["relative path", "marker-tool"],
      ["missing path", path.join(tempRoot, "missing-tool")],
      ["symlinked path", linked],
      ["checkout-local path", checkoutTool],
    ];
    for (const [name, gitExecutable] of scenarios) {
      const boundary = new FixtureBoundary(await readFile(FIXTURE));
      await assert.rejects(
        adapter(boundary, { gitExecutable, tempRoot }).build(input(root)),
        (error: unknown) =>
          error instanceof GraphAdapterError &&
          error.kind === "TRUSTED_EXECUTABLE_INVALID" &&
          error.message === "Graph build failed: TRUSTED_EXECUTABLE_INVALID",
        name,
      );
      assert.equal(boundary.calls.length, 0, name);
      assert.deepEqual((await readdir(tempRoot)).sort(), ["external-tool", "linked-tool"], name);
      await assert.rejects(readFile(path.join(root, "marker-effect")), name);
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(tempRoot, { recursive: true, force: true }),
    ]);
  }
});

test("rejects an executable replaced after trust validation before its next command", async () => {
  const root = await checkout();
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "graph-adapter-change-")));
  const graphifyExecutable = path.join(tempRoot, "graphify");
  await writeFile(graphifyExecutable, "#!/bin/sh\nexit 0\n");
  await chmod(graphifyExecutable, 0o700);
  const fixtureBoundary = new FixtureBoundary(await readFile(FIXTURE));
  const changingBoundary: ProcessBoundary = {
    async run(request) {
      const response = await fixtureBoundary.run(request);
      if (request.executable === graphifyExecutable && request.args[0] === "--version") {
        await rename(graphifyExecutable, `${graphifyExecutable}.old`);
        await writeFile(graphifyExecutable, "#!/bin/sh\ntouch marker-effect\n");
        await chmod(graphifyExecutable, 0o700);
      }
      return response;
    },
  };
  try {
    await assert.rejects(
      adapter(changingBoundary, { graphifyExecutable, tempRoot }).build(input(root)),
      (error: unknown) =>
        error instanceof GraphAdapterError && error.kind === "TRUSTED_EXECUTABLE_INVALID",
    );
    assert.equal(
      fixtureBoundary.calls.some((call) => call.args[0] === "extract"),
      false,
    );
    assert.deepEqual((await readdir(tempRoot)).sort(), ["graphify", "graphify.old"]);
    await assert.rejects(readFile(path.join(root, "marker-effect")));
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(tempRoot, { recursive: true, force: true }),
    ]);
  }
});

test("requires an attested host memory and disk policy", async () => {
  const root = await checkout();
  try {
    const boundary = new FixtureBoundary(await readFile(FIXTURE));
    const value = input(root);
    await assert.rejects(
      adapter(boundary).build({
        ...value,
        executorPolicy: undefined as never,
      }),
      (error: unknown) =>
        error instanceof Error && error.message === "Graph build failed: RESOURCE_POLICY_REQUIRED",
    );
    assert.equal(boundary.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed runtime inputs return stable errors without serialization hooks", async () => {
  const root = await checkout();
  try {
    const fixture = await readFile(FIXTURE);
    const invalidInputs: Array<[string, unknown, string]> = [
      ["missing top-level", undefined, "INVALID_INPUT"],
      ["null top-level", null, "INVALID_INPUT"],
      ["string top-level", "input", "INVALID_INPUT"],
      ["array top-level", [], "INVALID_INPUT"],
      [
        "missing snapshot",
        { ...input(root), repositoryIdentitySnapshot: undefined },
        "INVALID_INPUT",
      ],
      ["null snapshot", { ...input(root), repositoryIdentitySnapshot: null }, "INVALID_INPUT"],
      ["array snapshot", { ...input(root), repositoryIdentitySnapshot: [] }, "INVALID_INPUT"],
      ["null policy", { ...input(root), executorPolicy: null }, "RESOURCE_POLICY_REQUIRED"],
      ["string policy", { ...input(root), executorPolicy: "attested" }, "RESOURCE_POLICY_REQUIRED"],
      [
        "throwing getter",
        Object.defineProperty({ ...input(root) }, "projectId", {
          enumerable: true,
          get() {
            throw new Error("sensitive getter detail");
          },
        }),
        "INVALID_INPUT",
      ],
    ];
    for (const [name, malformed, expected] of invalidInputs) {
      const boundary = new FixtureBoundary(fixture);
      await assert.rejects(
        adapter(boundary).build(malformed as never),
        (error: unknown) =>
          error instanceof GraphAdapterError &&
          error.kind === expected &&
          !error.message.includes("sensitive"),
        name,
      );
      assert.equal(boundary.calls.length, 0, name);
    }

    let serialized = false;
    const value = input(root);
    const snapshot = Object.assign(Object.create(null), value.repositoryIdentitySnapshot, {
      toJSON() {
        serialized = true;
        throw new Error("uncontrolled serialization hook");
      },
    });
    await adapter(new FixtureBoundary(fixture)).build({
      ...value,
      repositoryIdentitySnapshot: snapshot,
    });
    assert.equal(serialized, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public process failures are stable and redact uncontrolled details", async () => {
  const root = await checkout();
  try {
    const boundary = new FixtureBoundary(await readFile(FIXTURE));
    boundary.failCommand = "extract";
    await assert.rejects(adapter(boundary).build(input(root)), (error: unknown) => {
      assert.equal(
        error instanceof Error ? error.message : "",
        "Graph build failed: PROCESS_FAILED",
      );
      assert.doesNotMatch(error instanceof Error ? error.message : "", /secret|TOKEN|\/path/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version, output, validation, and postflight failures fail closed", async () => {
  const scenarios: Array<[string, (boundary: FixtureBoundary) => void, string]> = [
    [
      "version",
      (boundary) => {
        boundary.graphifyVersion = "graphify 0.9.59\n";
      },
      "TOOL_VERSION_MISMATCH",
    ],
    [
      "version suffix",
      (boundary) => {
        boundary.graphifyVersion = "graphify 0.9.58.dev1\n";
      },
      "TOOL_VERSION_MISMATCH",
    ],
    [
      "version prefix",
      (boundary) => {
        boundary.graphifyVersion = "tool graphify 0.9.58\n";
      },
      "TOOL_VERSION_MISMATCH",
    ],
    [
      "version multiple lines",
      (boundary) => {
        boundary.graphifyVersion = "graphify 0.9.58\nextra\n";
      },
      "TOOL_VERSION_MISMATCH",
    ],
    [
      "version on stderr",
      (boundary) => {
        boundary.graphifyVersion = "";
        boundary.graphifyVersionStderr = "graphify 0.9.58\n";
      },
      "TOOL_VERSION_MISMATCH",
    ],
    [
      "python version",
      (boundary) => {
        boundary.pythonVersion = "Python 3.10.14\n";
      },
      "TOOL_VERSION_MISMATCH",
    ],
    [
      "python version suffix",
      (boundary) => {
        boundary.pythonVersion = "Python 3.11.9+vendor\n";
      },
      "TOOL_VERSION_MISMATCH",
    ],
    [
      "python version prefix",
      (boundary) => {
        boundary.pythonVersion = "CPython 3.11.9\n";
      },
      "TOOL_VERSION_MISMATCH",
    ],
    [
      "python version multiple lines",
      (boundary) => {
        boundary.pythonVersion = "Python 3.12.1\nextra\n";
      },
      "TOOL_VERSION_MISMATCH",
    ],
    [
      "missing output",
      (boundary) => {
        boundary.skipOutput = true;
      },
      "OUTPUT_INVALID",
    ],
    [
      "ambiguous output",
      (boundary) => {
        boundary.ambiguousOutput = true;
      },
      "OUTPUT_INVALID",
    ],
    [
      "invalid graph",
      (boundary) => {
        boundary.output = Buffer.from('{"directed":false}');
      },
      "GRAPH_INVALID",
    ],
    [
      "checksum handshake",
      (boundary) => {
        boundary.validatorOverride = JSON.stringify({
          byteSize: 5242,
          contentChecksumSha256: "0".repeat(64),
          nodeCount: 7,
          linkCount: 10,
          hyperedgeCount: 0,
        });
      },
      "HANDSHAKE_MISMATCH",
    ],
    [
      "dirty postflight",
      (boundary) => {
        boundary.dirtyPostflight = true;
      },
      "DIRTY_CHECKOUT",
    ],
  ];
  for (const [name, configure, kind] of scenarios) {
    const root = await checkout();
    try {
      const boundary = new FixtureBoundary(await readFile(FIXTURE));
      configure(boundary);
      await assert.rejects(adapter(boundary).build(input(root)), (error: unknown) => {
        assert.equal(
          error instanceof Error ? error.message : "",
          `Graph build failed: ${kind}`,
          name,
        );
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("output handling rejects replaced parents and blocking or nonregular entries", async (t) => {
  const fixture = await readFile(FIXTURE);
  const scenarios: Array<[string, (output: string) => Promise<Server | undefined>]> = [
    [
      "replaced output directory symlink",
      async (output) => {
        const original = `${output}-original`;
        const replacement = `${output}-replacement`;
        await rename(output, original);
        await mkdir(replacement);
        await writeFile(path.join(replacement, "graph.json"), fixture);
        await symlink(replacement, output);
        return undefined;
      },
    ],
    [
      "final symlink",
      async (output) => {
        await unlink(path.join(output, "graph.json"));
        await writeFile(path.join(output, "target.json"), fixture);
        await symlink("target.json", path.join(output, "graph.json"));
        return undefined;
      },
    ],
    [
      "ordinary directory",
      async (output) => {
        await unlink(path.join(output, "graph.json"));
        await mkdir(path.join(output, "graph.json"));
        return undefined;
      },
    ],
    [
      "replaced nested directory symlink",
      async (output) => {
        const nested = path.join(output, "nested");
        const original = path.join(output, "nested-original");
        await mkdir(nested);
        await rename(nested, original);
        await symlink(original, nested);
        return undefined;
      },
    ],
  ];
  if (process.platform !== "win32") {
    scenarios.push([
      "FIFO",
      async (output) => {
        await unlink(path.join(output, "graph.json"));
        await execute("mkfifo", [path.join(output, "graph.json")]);
        return undefined;
      },
    ]);
    scenarios.push([
      "Unix socket",
      async (output) => {
        await unlink(path.join(output, "graph.json"));
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(path.join(output, "graph.json"), resolve);
        });
        return server;
      },
    ]);
  } else {
    t.diagnostic("FIFO and Unix-domain socket cases are not portable to Windows");
  }

  for (const [name, mutate] of scenarios) {
    const root = await checkout();
    let server: Server | undefined;
    try {
      const boundary = new FixtureBoundary(fixture);
      boundary.afterOutput = async (output) => {
        server = await mutate(output);
      };
      await assert.rejects(
        adapter(boundary).build(input(root)),
        (error: unknown) => error instanceof GraphAdapterError && error.kind === "OUTPUT_INVALID",
        name,
      );
    } finally {
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("output handling rejects unlink and replacement races after descriptor reads", async () => {
  const fixture = await readFile(FIXTURE);
  const scenarios: Array<
    [string, "descriptor-closed" | "traversal-complete", (outputPath: string) => Promise<void>]
  > = [
    ["unlink after close", "descriptor-closed", async (outputPath) => unlink(outputPath)],
    [
      "replacement after close",
      "descriptor-closed",
      async (outputPath) => {
        await rename(outputPath, `${outputPath}.old`);
        await writeFile(outputPath, fixture);
      },
    ],
    [
      "replacement after traversal",
      "traversal-complete",
      async (outputPath) => {
        await rename(outputPath, `${outputPath}.old`);
        await writeFile(outputPath, fixture);
      },
    ],
  ];

  for (const [name, mutationStage, mutate] of scenarios) {
    const root = await checkout();
    try {
      const boundary = new FixtureBoundary(fixture);
      await assert.rejects(
        adapter(boundary, {
          outputVerificationHook: async (stage, outputPath) => {
            if (stage === mutationStage) await mutate(outputPath);
          },
        }).build(input(root)),
        (error: unknown) => error instanceof GraphAdapterError && error.kind === "OUTPUT_INVALID",
        name,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("cleanup failures are secondary to process and validation failures", async () => {
  const scenarios: Array<[string, (boundary: FixtureBoundary) => void, boolean, string]> = [
    ["successful build and cleanup", () => undefined, false, "SUCCESS"],
    ["successful build with failed cleanup", () => undefined, true, "CLEANUP_FAILED"],
    [
      "process and cleanup failures",
      (boundary) => {
        boundary.failCommand = "extract";
      },
      true,
      "PROCESS_FAILED",
    ],
    [
      "validation and cleanup failures",
      (boundary) => {
        boundary.output = Buffer.from('{"directed":false}');
      },
      true,
      "GRAPH_INVALID",
    ],
  ];
  for (const [name, configure, cleanupFails, expected] of scenarios) {
    const root = await checkout();
    let cleanupCalls = 0;
    try {
      const boundary = new FixtureBoundary(await readFile(FIXTURE));
      configure(boundary);
      const build = adapter(boundary, {
        cleanup: async (temporaryRoot) => {
          cleanupCalls += 1;
          await rm(temporaryRoot, { recursive: true, force: true });
          if (cleanupFails) throw new Error("sensitive cleanup detail");
        },
      }).build(input(root));
      if (expected === "SUCCESS") await build;
      else {
        await assert.rejects(
          build,
          (error: unknown) =>
            error instanceof GraphAdapterError &&
            error.kind === expected &&
            !error.message.includes("sensitive"),
          name,
        );
      }
      assert.equal(cleanupCalls, 1, name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("captured fixture provenance remains exact", async () => {
  const bytes = await readFile(FIXTURE);
  const provenance = JSON.parse(
    await readFile(path.join(HERE, "fixtures/graphify-0.9.58.provenance.json"), "utf8"),
  );
  assert.equal(provenance.source.commit, COMMIT);
  assert.equal(provenance.source.tree, "1a19b33ffe05726edd03adfff4920e0cfd7ce6f0");
  assert.equal(provenance.output.byteSize, 5242);
  assert.equal(
    provenance.output.sha256,
    "25a9311a26ea28bf3d87a1cf186e4f1d10e962381bc39fdc815687dea57f085c",
  );
  assert.deepEqual(
    [provenance.output.nodeCount, provenance.output.linkCount, provenance.output.hyperedgeCount],
    [7, 10, 0],
  );
  assert.equal(bytes.byteLength, provenance.output.byteSize);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.output.sha256);
  const graph = JSON.parse(bytes.toString("utf8"));
  assert.equal(graph.built_at_commit, provenance.source.commit);
  assert.deepEqual(
    [graph.nodes.length, graph.links.length, graph.hyperedges.length],
    [provenance.output.nodeCount, provenance.output.linkCount, provenance.output.hyperedgeCount],
  );
  const graphPaths = [
    ...new Set(
      [...graph.nodes, ...graph.links].map(
        (record: { source_file?: string }) => record.source_file,
      ),
    ),
  ].sort();
  assert.deepEqual(graphPaths, provenance.output.sourcePaths);
  assert.deepEqual(
    provenance.output.sourcePaths,
    provenance.source.files.map((file: { path: string }) => file.path),
  );
  for (const source of provenance.source.files) {
    const sourcePath = path.join(HERE, "fixtures/source", source.path);
    const sourceBytes = await readFile(sourcePath);
    assert.equal(createHash("sha256").update(sourceBytes).digest("hex"), source.sha256);
    assert.equal(source.mode, "100644");
    assert.equal((await stat(sourcePath)).mode & 0o777, 0o644);
  }
  assert.equal(provenance.classification, "captured clean canonical-profile fixture");
});
