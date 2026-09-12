import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeCheckoutPath,
  type TrustedExecutable,
  trustExecutable,
  verifyTrustedExecutable,
} from "./executable.js";
import { inspectCheckout, verifyCheckout } from "./preflight.js";
import { NodeProcessBoundary } from "./process.js";
import { type RuntimeCapability, requireAdapterRuntime } from "./runtime.js";
import {
  ADAPTER_VERSION,
  GRAPH_FORMAT_VERSION,
  GRAPH_GENERATOR,
  GRAPH_PROFILE,
  GRAPHIFY_VERSION,
  GraphAdapterError,
  type GraphBuildInput,
  type GraphBuildResult,
  type GraphProvider,
  MAX_GRAPH_BYTES,
  MAX_METADATA_BYTES,
  type ProcessBoundary,
  type ProcessResult,
} from "./types.js";

const COMMIT = /^[0-9a-f]{40}$/;
const OUTPUT_NAME = "graph.json";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_ENTRIES = 100_000;
const MAX_OUTPUT_DEPTH = 64;

export interface GraphifyAdapterOptions {
  readonly processBoundary?: ProcessBoundary;
  /** Host-configured canonical absolute paths; no executable is resolved through PATH. */
  readonly gitExecutable?: string;
  readonly graphifyExecutable?: string;
  readonly pythonExecutable?: string;
  readonly tempRoot?: string;
  readonly timeoutMs?: number;
  readonly cleanup?: (temporaryRoot: string) => Promise<void>;
  /** Test-only fail-closed seam; capabilities can be disabled but never attested present. */
  readonly testOnlyDisabledRuntimeCapabilities?: readonly RuntimeCapability[];
  /** Narrow race-injection seam used by filesystem identity tests. */
  readonly outputVerificationHook?: (
    stage: "descriptor-closed" | "traversal-complete",
    outputPath: string,
  ) => Promise<void>;
}

interface DirectoryIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface ValidationHandshake {
  readonly byteSize: number;
  readonly contentChecksumSha256: string;
  readonly nodeCount: number;
  readonly linkCount: number;
  readonly hyperedgeCount: number;
}

export class GraphifyAdapter implements GraphProvider {
  readonly #boundary: ProcessBoundary;
  readonly #git: string | undefined;
  readonly #graphify: string | undefined;
  readonly #python: string | undefined;
  readonly #tempRoot: string;
  readonly #timeoutMs: number;
  readonly #cleanup: (temporaryRoot: string) => Promise<void>;
  readonly #testOnlyDisabledRuntimeCapabilities: readonly RuntimeCapability[];
  readonly #outputVerificationHook?: GraphifyAdapterOptions["outputVerificationHook"];

  constructor(options: GraphifyAdapterOptions = {}) {
    this.#testOnlyDisabledRuntimeCapabilities = Object.freeze([
      ...(options.testOnlyDisabledRuntimeCapabilities ?? []),
    ]);
    this.#boundary =
      options.processBoundary ??
      new NodeProcessBoundary({
        testOnlyDisabledRuntimeCapabilities: this.#testOnlyDisabledRuntimeCapabilities,
      });
    this.#git = options.gitExecutable;
    this.#graphify = options.graphifyExecutable;
    this.#python = options.pythonExecutable;
    this.#tempRoot = options.tempRoot ?? os.tmpdir();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#cleanup =
      options.cleanup ?? ((temporaryRoot) => rm(temporaryRoot, { recursive: true, force: true }));
    this.#outputVerificationHook = options.outputVerificationHook;
  }

  async build(input: GraphBuildInput): Promise<GraphBuildResult> {
    let temporaryRoot: string | undefined;
    let built: GraphBuildResult | undefined;
    let primaryFailure: GraphAdapterError | undefined;
    try {
      const validatedInput = validateInput(input);
      requireAdapterRuntime(this.#testOnlyDisabledRuntimeCapabilities);
      const checkoutRoot = await canonicalizeCheckoutPath(validatedInput.checkoutPath);
      const tempParent = await captureExternalTempParent(checkoutRoot, this.#tempRoot);
      const [gitExecutable, pythonExecutable, graphifyExecutable] = await Promise.all([
        trustExecutable(this.#git, checkoutRoot),
        trustExecutable(this.#python, checkoutRoot),
        trustExecutable(this.#graphify, checkoutRoot),
      ]);
      const before = await inspectCheckout(
        this.#boundary,
        gitExecutable,
        checkoutRoot,
        validatedInput.sourceCommitSha,
      );
      await verifyDirectoryIdentity(tempParent);
      temporaryRoot = await mkdtemp(path.join(tempParent.canonicalPath, "context-hub-graphify-"));
      const temporaryIdentity = await captureDirectoryIdentity(temporaryRoot);
      assertExternal(before.root, temporaryIdentity.canonicalPath);
      assertContained(tempParent.canonicalPath, temporaryIdentity.canonicalPath);
      await verifyDirectoryIdentity(tempParent);
      const output = path.join(temporaryIdentity.canonicalPath, "output");
      const home = path.join(temporaryRoot, "home");
      const processTemp = path.join(temporaryRoot, "tmp");
      await Promise.all([mkdir(output), mkdir(home), mkdir(processTemp)]);
      const outputIdentity = await captureDirectoryIdentity(output);
      const manifest = path.join(temporaryRoot, "tracked-files.nul");
      await writeFile(manifest, before.manifestBytes, { flag: "wx", mode: 0o600 });
      const env = Object.freeze({
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        HOME: home,
        TMPDIR: processTemp,
        GRAPHIFY_OUT: output,
      });

      await this.#verifyRuntime(before.root, env, pythonExecutable, graphifyExecutable);
      await requireEmptyDirectory(outputIdentity);
      await this.#runTrusted(graphifyExecutable, {
        args: ["extract", before.root, "--code-only", "--no-cluster"],
        cwd: before.root,
        env,
        timeoutMs: this.#timeoutMs,
      });
      await this.#runTrusted(graphifyExecutable, {
        args: ["cluster-only", before.root, "--no-label", "--no-viz"],
        cwd: before.root,
        env,
        timeoutMs: this.#timeoutMs,
      });

      const bytes = await readExactOutput(outputIdentity, this.#outputVerificationHook);
      const validator = fileURLToPath(new URL("../python/validate_graph.py", import.meta.url));
      let validation: ProcessResult;
      try {
        validation = await this.#runTrusted(pythonExecutable, {
          args: [validator, validatedInput.sourceCommitSha, manifest, before.manifestSha256],
          cwd: before.root,
          env,
          timeoutMs: 60_000,
          maxOutputBytes: MAX_METADATA_BYTES,
          stdin: bytes,
        });
      } catch (error) {
        if (
          error instanceof GraphAdapterError &&
          (error.kind === "PROCESS_TIMEOUT" || error.kind === "TRUSTED_EXECUTABLE_INVALID")
        ) {
          throw error;
        }
        throw new GraphAdapterError("GRAPH_INVALID");
      }
      const handshake = parseHandshake(validation.stdout);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      if (handshake.byteSize !== bytes.byteLength || handshake.contentChecksumSha256 !== checksum) {
        throw new GraphAdapterError("HANDSHAKE_MISMATCH");
      }
      await verifyCheckout(this.#boundary, gitExecutable, before, validatedInput.sourceCommitSha);

      built = Object.freeze({
        bytes: Uint8Array.from(bytes),
        byteSize: bytes.byteLength,
        contentChecksumSha256: checksum,
        nodeCount: handshake.nodeCount,
        linkCount: handshake.linkCount,
        hyperedgeCount: handshake.hyperedgeCount,
        projectId: validatedInput.projectId,
        repositoryProvider: validatedInput.repositoryProvider,
        providerRepositoryId: validatedInput.providerRepositoryId,
        repositoryIdentitySnapshot: validatedInput.repositoryIdentitySnapshot,
        sourceCommitSha: validatedInput.sourceCommitSha,
        graphifyVersion: GRAPHIFY_VERSION,
        adapterVersion: ADAPTER_VERSION,
        profile: GRAPH_PROFILE,
        formatVersion: GRAPH_FORMAT_VERSION,
        generator: GRAPH_GENERATOR,
      });
      const metadataBytes = Buffer.byteLength(
        JSON.stringify({ ...built, bytes: undefined }),
        "utf8",
      );
      if (metadataBytes > MAX_METADATA_BYTES) throw new GraphAdapterError("INVALID_INPUT");
    } catch (error) {
      primaryFailure =
        error instanceof GraphAdapterError ? error : new GraphAdapterError("OUTPUT_INVALID");
    }

    if (temporaryRoot) {
      try {
        await this.#cleanup(temporaryRoot);
      } catch {
        if (!primaryFailure) primaryFailure = new GraphAdapterError("CLEANUP_FAILED");
      }
    }
    if (primaryFailure) throw primaryFailure;
    if (!built) throw new GraphAdapterError("OUTPUT_INVALID");
    return built;
  }

  async #runTrusted(
    executable: TrustedExecutable,
    request: Omit<Parameters<ProcessBoundary["run"]>[0], "executable">,
  ): Promise<ProcessResult> {
    await verifyTrustedExecutable(executable);
    return await this.#boundary.run({ ...request, executable: executable.canonicalPath });
  }

  async #verifyRuntime(
    cwd: string,
    env: Readonly<Record<string, string>>,
    pythonExecutable: TrustedExecutable,
    graphifyExecutable: TrustedExecutable,
  ): Promise<void> {
    try {
      const python = await this.#runTrusted(pythonExecutable, {
        args: ["--version"],
        cwd,
        env,
        timeoutMs: 10_000,
      });
      const pythonVersion = Buffer.from(python.stdout).toString("utf8").trim();
      if (python.stderr.byteLength !== 0 || !/^Python 3\.(?:11|12)\.[0-9]+$/.test(pythonVersion))
        throw new Error();
      const graphify = await this.#runTrusted(graphifyExecutable, {
        args: ["--version"],
        cwd,
        env,
        timeoutMs: 10_000,
      });
      const graphifyVersion = Buffer.from(graphify.stdout).toString("utf8").trim();
      if (graphify.stderr.byteLength !== 0 || graphifyVersion !== `graphify ${GRAPHIFY_VERSION}`)
        throw new Error();
    } catch (error) {
      if (
        error instanceof GraphAdapterError &&
        (error.kind === "PROCESS_TIMEOUT" || error.kind === "TRUSTED_EXECUTABLE_INVALID")
      ) {
        throw error;
      }
      throw new GraphAdapterError("TOOL_VERSION_MISMATCH");
    }
  }
}

function validateInput(input: unknown): GraphBuildInput {
  try {
    if (!isPlainRecord(input)) throw new GraphAdapterError("INVALID_INPUT");

    const executorPolicy = input.executorPolicy;
    if (!isPlainRecord(executorPolicy)) {
      throw new GraphAdapterError("RESOURCE_POLICY_REQUIRED");
    }
    const attested = executorPolicy.attested;
    const memoryLimitBytes = executorPolicy.memoryLimitBytes;
    const diskLimitBytes = executorPolicy.diskLimitBytes;
    if (
      attested !== true ||
      !Number.isSafeInteger(memoryLimitBytes) ||
      (memoryLimitBytes as number) <= 0 ||
      !Number.isSafeInteger(diskLimitBytes) ||
      (diskLimitBytes as number) <= 0
    ) {
      throw new GraphAdapterError("RESOURCE_POLICY_REQUIRED");
    }

    const snapshot = input.repositoryIdentitySnapshot;
    if (!isPlainRecord(snapshot)) throw new GraphAdapterError("INVALID_INPUT");
    const checkoutPath = input.checkoutPath;
    const projectId = input.projectId;
    const repositoryProvider = input.repositoryProvider;
    const providerRepositoryId = input.providerRepositoryId;
    const sourceCommitSha = input.sourceCommitSha;
    const snapshotProvider = snapshot.provider;
    const snapshotRepositoryId = snapshot.providerRepositoryId;
    const owner = snapshot.owner;
    const name = snapshot.name;
    const canonicalUrl = snapshot.canonicalUrl;
    if (
      typeof checkoutPath !== "string" ||
      checkoutPath.length === 0 ||
      Buffer.byteLength(checkoutPath, "utf8") > 4096 ||
      typeof sourceCommitSha !== "string" ||
      !COMMIT.test(sourceCommitSha)
    ) {
      throw new GraphAdapterError("INVALID_INPUT");
    }
    const values = [
      projectId,
      repositoryProvider,
      providerRepositoryId,
      snapshotProvider,
      snapshotRepositoryId,
      owner,
      name,
      canonicalUrl,
    ];
    if (
      values.some(
        (value) =>
          typeof value !== "string" ||
          value.length === 0 ||
          Buffer.byteLength(value, "utf8") > 1024,
      )
    ) {
      throw new GraphAdapterError("INVALID_INPUT");
    }
    if (repositoryProvider !== snapshotProvider || providerRepositoryId !== snapshotRepositoryId) {
      throw new GraphAdapterError("INVALID_INPUT");
    }

    const repositoryIdentitySnapshot = Object.freeze({
      provider: snapshotProvider as string,
      providerRepositoryId: snapshotRepositoryId as string,
      owner: owner as string,
      name: name as string,
      canonicalUrl: canonicalUrl as string,
    });
    const validated = Object.freeze({
      checkoutPath,
      projectId: projectId as string,
      repositoryProvider: repositoryProvider as string,
      providerRepositoryId: providerRepositoryId as string,
      repositoryIdentitySnapshot,
      sourceCommitSha,
      executorPolicy: Object.freeze({
        attested: true as const,
        memoryLimitBytes: memoryLimitBytes as number,
        diskLimitBytes: diskLimitBytes as number,
      }),
    });
    const envelope = {
      projectId: validated.projectId,
      repositoryProvider: validated.repositoryProvider,
      providerRepositoryId: validated.providerRepositoryId,
      repositoryIdentitySnapshot,
      sourceCommitSha: validated.sourceCommitSha,
      graphifyVersion: GRAPHIFY_VERSION,
      adapterVersion: ADAPTER_VERSION,
      profile: GRAPH_PROFILE,
      formatVersion: GRAPH_FORMAT_VERSION,
      generator: GRAPH_GENERATOR,
    };
    if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_METADATA_BYTES) {
      throw new GraphAdapterError("INVALID_INPUT");
    }
    return validated;
  } catch (error) {
    if (error instanceof GraphAdapterError) throw error;
    throw new GraphAdapterError("INVALID_INPUT");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExternal(checkout: string, candidate: string): void {
  const relative = path.relative(checkout, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."))
    throw new GraphAdapterError("INVALID_CHECKOUT");
}

function assertContained(parent: string, candidate: string): void {
  const relative = path.relative(parent, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new GraphAdapterError("OUTPUT_INVALID");
  }
}

async function captureExternalTempParent(
  checkout: string,
  configuredParent: string,
): Promise<DirectoryIdentity> {
  try {
    if (!path.isAbsolute(configuredParent)) throw new Error();
    const canonicalPath = await realpath(configuredParent);
    const stat = await lstat(canonicalPath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    assertExternal(checkout, canonicalPath);
    return { canonicalPath, device: stat.dev, inode: stat.ino };
  } catch {
    throw new GraphAdapterError("INVALID_CHECKOUT");
  }
}

async function captureDirectoryIdentity(directory: string): Promise<DirectoryIdentity> {
  try {
    const canonicalPath = await realpath(directory);
    const stat = await lstat(directory, { bigint: true });
    if (canonicalPath !== directory || !stat.isDirectory() || stat.isSymbolicLink())
      throw new Error();
    return { canonicalPath, device: stat.dev, inode: stat.ino };
  } catch {
    throw new GraphAdapterError("OUTPUT_INVALID");
  }
}

async function verifyDirectoryIdentity(identity: DirectoryIdentity): Promise<void> {
  const current = await captureDirectoryIdentity(identity.canonicalPath);
  if (current.device !== identity.device || current.inode !== identity.inode) throw new Error();
}

async function requireEmptyDirectory(identity: DirectoryIdentity): Promise<void> {
  try {
    await verifyDirectoryIdentity(identity);
    const directory = await opendir(identity.canonicalPath);
    try {
      if ((await directory.read()) !== null) throw new Error();
    } finally {
      await directory.close().catch(() => undefined);
    }
    await verifyDirectoryIdentity(identity);
  } catch {
    throw new GraphAdapterError("OUTPUT_INVALID");
  }
}

async function captureContainedDirectory(
  root: DirectoryIdentity,
  directory: string,
): Promise<DirectoryIdentity> {
  const identity = await captureDirectoryIdentity(directory);
  const relative = path.relative(root.canonicalPath, identity.canonicalPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error();
  }
  return identity;
}

async function readExactOutput(
  identity: DirectoryIdentity,
  verificationHook?: GraphifyAdapterOptions["outputVerificationHook"],
): Promise<Buffer> {
  try {
    if (!("O_NOFOLLOW" in fsConstants) || !("O_NONBLOCK" in fsConstants)) throw new Error();
    await verifyDirectoryIdentity(identity);
    const expected = path.join(identity.canonicalPath, OUTPUT_NAME);
    const direct = await lstat(expected, { bigint: true });
    if (!direct.isFile() || direct.isSymbolicLink() || direct.size > BigInt(MAX_GRAPH_BYTES)) {
      throw new Error();
    }

    const handle = await open(
      expected,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const stat = await handle.stat({ bigint: true });
      if (
        !stat.isFile() ||
        stat.dev !== direct.dev ||
        stat.ino !== direct.ino ||
        stat.size !== direct.size ||
        stat.mtimeNs !== direct.mtimeNs ||
        stat.ctimeNs !== direct.ctimeNs ||
        stat.size > BigInt(MAX_GRAPH_BYTES)
      ) {
        throw new Error();
      }
      bytes = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) throw new Error();
        offset += read.bytesRead;
      }
      const finalStat = await handle.stat({ bigint: true });
      if (
        finalStat.dev !== stat.dev ||
        finalStat.ino !== stat.ino ||
        finalStat.size !== stat.size ||
        finalStat.mtimeNs !== stat.mtimeNs ||
        finalStat.ctimeNs !== stat.ctimeNs
      ) {
        throw new Error();
      }
    } finally {
      await handle.close();
    }
    await verificationHook?.("descriptor-closed", expected);
    const closedPath = await lstat(expected, { bigint: true });
    if (!sameOutputFile(direct, closedPath)) throw new Error();
    await verifyDirectoryIdentity(identity);

    let entries = 0;
    async function rejectAlternateGraphs(
      directoryIdentity: DirectoryIdentity,
      depth: number,
    ): Promise<void> {
      if (depth > MAX_OUTPUT_DEPTH) throw new Error();
      await verifyDirectoryIdentity(directoryIdentity);
      const directory = await opendir(directoryIdentity.canonicalPath);
      try {
        for await (const entry of directory) {
          entries += 1;
          if (entries > MAX_OUTPUT_ENTRIES) throw new Error();
          const full = path.join(directoryIdentity.canonicalPath, entry.name);
          const entryStat = await lstat(full, { bigint: true });
          if (entryStat.isSymbolicLink()) throw new Error();
          if (depth > 1 && entry.name === OUTPUT_NAME) throw new Error();
          if (entryStat.isDirectory()) {
            const childIdentity = await captureContainedDirectory(identity, full);
            if (entryStat.dev !== childIdentity.device || entryStat.ino !== childIdentity.inode) {
              throw new Error();
            }
            await rejectAlternateGraphs(childIdentity, depth + 1);
            await verifyDirectoryIdentity(childIdentity);
          } else if (!entryStat.isFile()) {
            throw new Error();
          }
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      await verifyDirectoryIdentity(directoryIdentity);
    }
    await rejectAlternateGraphs(identity, 1);
    await verificationHook?.("traversal-complete", expected);
    await verifyDirectoryIdentity(identity);
    const finalPath = await lstat(expected, { bigint: true });
    if (!sameOutputFile(direct, finalPath)) throw new Error();
    return bytes;
  } catch {
    throw new GraphAdapterError("OUTPUT_INVALID");
  }
}

function sameOutputFile(
  left: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  },
  right: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  },
): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isHandshakeRecord(value: unknown): value is {
  byteSize: unknown;
  contentChecksumSha256: unknown;
  nodeCount: unknown;
  linkCount: unknown;
  hyperedgeCount: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "byteSize" in value &&
    "contentChecksumSha256" in value &&
    "nodeCount" in value &&
    "linkCount" in value &&
    "hyperedgeCount" in value
  );
}

function parseHandshake(bytes: Uint8Array): ValidationHandshake {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_METADATA_BYTES)
    throw new GraphAdapterError("GRAPH_INVALID");
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!isHandshakeRecord(value)) throw new Error();
    const keys = ["byteSize", "contentChecksumSha256", "nodeCount", "linkCount", "hyperedgeCount"];
    if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error();
    const { byteSize, contentChecksumSha256, nodeCount, linkCount, hyperedgeCount } = value;
    if (
      typeof byteSize !== "number" ||
      !Number.isSafeInteger(byteSize) ||
      typeof nodeCount !== "number" ||
      !Number.isSafeInteger(nodeCount) ||
      typeof linkCount !== "number" ||
      !Number.isSafeInteger(linkCount) ||
      hyperedgeCount !== 0 ||
      typeof contentChecksumSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(contentChecksumSha256)
    )
      throw new Error();
    return { byteSize, contentChecksumSha256, nodeCount, linkCount, hyperedgeCount };
  } catch {
    throw new GraphAdapterError("GRAPH_INVALID");
  }
}
