import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { validateGraphFormatV1 } from "./graph-format-v1.js";
import {
  CHECKSUM,
  type GraphMetadata,
  isGraphMetadata,
  isManifest,
  isRepositoryIdentity,
  type LocalGraph,
  MAX_GRAPH_BYTES,
  MAX_METADATA_BYTES,
  type Manifest,
  SHA,
} from "./types.js";

const CONTEXT = ".ai-context";
const MANIFEST = "manifest.json";
const GRAPH = "graph/graph.json";
const META = "graph/meta.json";
const MARKER = "cache/sync-transaction.json";
const LOCK = "cache/sync.lock";
const BACKUPS = {
  manifest: "cache/manifest.previous",
  graph: "cache/graph.previous",
  meta: "cache/meta.previous",
} as const;
const NOFOLLOW = constants.O_NOFOLLOW;

function requireNoFollow(): number {
  if (typeof NOFOLLOW !== "number" || process.platform === "win32")
    throw new Error("UNSUPPORTED_PLATFORM");
  return NOFOLLOW;
}

type DirectoryIdentity = { path: string; dev: number; ino: number };

type Layout = {
  root: string;
  context: string;
  manifest: string;
  graph: string;
  meta: string;
  marker: string;
  lock: string;
  backups: { manifest: string; graph: string; meta: string };
  directories: DirectoryIdentity[];
};

type Marker = {
  formatVersion: 1;
  previous: { manifest: boolean; graph: boolean; meta: boolean };
};

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

async function assertDirectory(candidate: string) {
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("UNSAFE_LOCAL_LAYOUT");
}

async function ensureDirectory(candidate: string) {
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertDirectory(candidate);
}

export async function ensureLayout(projectRoot: string): Promise<Layout> {
  requireNoFollow();
  const root = await realpath(projectRoot);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("INVALID_PROJECT_ROOT");
  const context = path.join(root, CONTEXT);
  const graphDirectory = path.join(context, "graph");
  const artifactsDirectory = path.join(context, "artifacts");
  const cacheDirectory = path.join(context, "cache");
  for (const directory of [context, graphDirectory, artifactsDirectory, cacheDirectory]) {
    if (!inside(root, directory)) throw new Error("UNSAFE_LOCAL_LAYOUT");
    await ensureDirectory(directory);
    const canonical = await realpath(directory);
    if (canonical !== directory || !inside(root, canonical)) throw new Error("UNSAFE_LOCAL_LAYOUT");
  }
  const directoryPaths = [context, graphDirectory, artifactsDirectory, cacheDirectory];
  const directories: DirectoryIdentity[] = [];
  for (const directory of directoryPaths) {
    const info = await lstat(directory);
    directories.push({ path: directory, dev: info.dev, ino: info.ino });
  }
  const layout = {
    root,
    context,
    manifest: path.join(context, MANIFEST),
    graph: path.join(context, GRAPH),
    meta: path.join(context, META),
    marker: path.join(context, MARKER),
    lock: path.join(context, LOCK),
    backups: {
      manifest: path.join(context, BACKUPS.manifest),
      graph: path.join(context, BACKUPS.graph),
      meta: path.join(context, BACKUPS.meta),
    },
  };
  for (const candidate of [
    layout.manifest,
    layout.graph,
    layout.meta,
    layout.marker,
    layout.lock,
    ...Object.values(layout.backups),
  ]) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("UNSAFE_LOCAL_LAYOUT");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { ...layout, directories };
}

async function assertStableDirectory(layout: Layout, directory: string) {
  const expected = layout.directories.find((item) => item.path === directory);
  if (!expected) throw new Error("UNSAFE_LOCAL_LAYOUT");
  const [canonical, current] = await Promise.all([realpath(directory), lstat(directory)]);
  if (
    canonical !== directory ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  )
    throw new Error("UNSAFE_LOCAL_LAYOUT");
}

async function assertStableParent(layout: Layout, candidate: string) {
  const directory = path.dirname(candidate);
  if (!inside(layout.root, candidate)) throw new Error("UNSAFE_LOCAL_LAYOUT");
  await assertStableDirectory(layout, directory);
}

async function exists(layout: Layout, candidate: string) {
  await assertStableParent(layout, candidate);
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("UNSAFE_LOCAL_LAYOUT");
    await assertStableParent(layout, candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function safeRead(layout: Layout, candidate: string, maximum: number): Promise<Uint8Array> {
  await assertStableParent(layout, candidate);
  const before = await lstat(candidate);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maximum)
    throw new Error("UNSAFE_LOCAL_LAYOUT");
  const handle = await open(candidate, constants.O_RDONLY | requireNoFollow());
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size !== before.size || current.size > maximum)
      throw new Error("UNSAFE_LOCAL_LAYOUT");
    const bytes = await handle.readFile();
    if (bytes.byteLength !== current.size) throw new Error("LOCAL_CACHE_CORRUPT");
    await assertStableParent(layout, candidate);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(layout: Layout, directory: string) {
  await assertStableDirectory(layout, directory);
  const handle = await open(
    directory,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | requireNoFollow(),
  );
  try {
    await handle.sync();
    await assertStableDirectory(layout, directory);
  } finally {
    await handle.close();
  }
}

async function writeTemporary(layout: Layout, directory: string, bytes: Uint8Array) {
  await assertStableDirectory(layout, directory);
  const candidate = path.join(directory, `.context-${randomUUID()}.tmp`);
  const handle = await open(
    candidate,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requireNoFollow(),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(candidate, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await syncDirectory(layout, directory);
  await assertStableDirectory(layout, directory);
  return candidate;
}

async function atomicWrite(layout: Layout, target: string, bytes: Uint8Array) {
  const directory = path.dirname(target);
  const temporary = await writeTemporary(layout, directory, bytes);
  try {
    await assertStableDirectory(layout, directory);
    await rename(temporary, target);
    await syncDirectory(layout, directory);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function jsonBytes(value: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(layout: Layout, candidate: string, maximum: number): Promise<unknown> {
  const bytes = await safeRead(layout, candidate, maximum);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("LOCAL_CACHE_CORRUPT");
  }
}

function validMarker(value: unknown): value is Marker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  if (marker.formatVersion !== 1 || !marker.previous || typeof marker.previous !== "object")
    return false;
  const previous = marker.previous as Record<string, unknown>;
  return ["manifest", "graph", "meta"].every((key) => typeof previous[key] === "boolean");
}

async function removeRegular(layout: Layout, candidate: string) {
  if (!(await exists(layout, candidate))) return;
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("UNSAFE_LOCAL_LAYOUT");
  await assertStableParent(layout, candidate);
  await unlink(candidate);
  await assertStableParent(layout, candidate);
}

type MutationLock = { handle: Awaited<ReturnType<typeof open>>; dev: number; ino: number };

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireMutationLock(layout: Layout): Promise<MutationLock> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assertStableParent(layout, layout.lock);
    try {
      const handle = await open(
        layout.lock,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requireNoFollow(),
        0o600,
      );
      try {
        await handle.writeFile(jsonBytes({ formatVersion: 1, pid: process.pid }));
        await handle.sync();
        const info = await handle.stat();
        await syncDirectory(layout, path.dirname(layout.lock));
        return { handle, dev: info.dev, ino: info.ino };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await removeRegular(layout, layout.lock).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const before = await lstat(layout.lock);
      const value = await readJson(layout, layout.lock, MAX_METADATA_BYTES);
      const pid =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).pid
          : undefined;
      if (!Number.isSafeInteger(pid) || (pid as number) < 1) throw new Error("UNSAFE_SYNC_LOCK");
      if (processIsAlive(pid as number)) throw new Error("SYNC_IN_PROGRESS");
      const current = await lstat(layout.lock);
      if (before.dev !== current.dev || before.ino !== current.ino)
        throw new Error("SYNC_IN_PROGRESS");
      await unlink(layout.lock);
      await syncDirectory(layout, path.dirname(layout.lock));
    }
  }
  throw new Error("SYNC_IN_PROGRESS");
}

async function releaseMutationLock(layout: Layout, lock: MutationLock) {
  try {
    const current = await lstat(layout.lock);
    if (current.dev !== lock.dev || current.ino !== lock.ino) throw new Error("SYNC_LOCK_LOST");
    await unlink(layout.lock);
    await syncDirectory(layout, path.dirname(layout.lock));
  } finally {
    await lock.handle.close();
  }
}

async function withMutationLock<T>(layout: Layout, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireMutationLock(layout);
  try {
    return await operation();
  } finally {
    await releaseMutationLock(layout, lock);
  }
}

async function restore(layout: Layout, marker: Marker) {
  for (const name of ["graph", "meta", "manifest"] as const) {
    const target = layout[name];
    if (marker.previous[name]) {
      const maximum = name === "graph" ? MAX_GRAPH_BYTES : MAX_METADATA_BYTES;
      const bytes = await safeRead(layout, layout.backups[name], maximum);
      await atomicWrite(layout, target, bytes);
    } else {
      await removeRegular(layout, target);
      await syncDirectory(layout, path.dirname(target));
    }
  }
  await removeRegular(layout, layout.marker);
  for (const backup of Object.values(layout.backups)) await removeRegular(layout, backup);
  await syncDirectory(layout, path.join(layout.context, "cache"));
}

async function recoverInterruptedSyncUnlocked(layout: Layout) {
  if (!(await exists(layout, layout.marker))) return false;
  const value = await readJson(layout, layout.marker, MAX_METADATA_BYTES);
  if (!validMarker(value)) throw new Error("LOCAL_CACHE_CORRUPT");
  await restore(layout, value);
  return true;
}

async function readManifestUnlocked(layout: Layout): Promise<Manifest | null> {
  if (!(await exists(layout, layout.manifest))) return null;
  const value = await readJson(layout, layout.manifest, MAX_METADATA_BYTES);
  if (!isManifest(value)) throw new Error("LOCAL_CACHE_CORRUPT");
  return value;
}

export async function recoverInterruptedSync(layout: Layout) {
  return withMutationLock(layout, async () => recoverInterruptedSyncUnlocked(layout));
}

export async function writeManifest(layout: Layout, manifest: Manifest) {
  if (!isManifest(manifest)) throw new Error("INVALID_MANIFEST");
  return withMutationLock(layout, async () => {
    await recoverInterruptedSyncUnlocked(layout);
    await atomicWrite(layout, layout.manifest, jsonBytes(manifest));
  });
}

export async function readManifest(layout: Layout): Promise<Manifest | null> {
  return withMutationLock(layout, async () => {
    await recoverInterruptedSyncUnlocked(layout);
    return readManifestUnlocked(layout);
  });
}

function sameRepository(left: Manifest["repository"], right: Manifest["repository"]) {
  return (
    isRepositoryIdentity(left) &&
    isRepositoryIdentity(right) &&
    left.provider === right.provider &&
    left.providerRepositoryId === right.providerRepositoryId &&
    left.canonicalUrl === right.canonicalUrl
  );
}

function verifyGraphShape(bytes: Uint8Array, metadata: GraphMetadata) {
  const graph = validateGraphFormatV1(bytes, metadata.sourceCommitSha);
  if (
    !graph ||
    graph.nodes.length !== metadata.nodeCount ||
    graph.links.length !== metadata.linkCount ||
    metadata.hyperedgeCount !== 0
  )
    throw new Error("GRAPH_CORRUPT");
}

async function readLocalGraphUnlocked(layout: Layout): Promise<LocalGraph | null> {
  const manifest = await readManifestUnlocked(layout);
  if (!manifest?.graph) return null;
  if (!(await exists(layout, layout.graph)) || !(await exists(layout, layout.meta)))
    throw new Error("LOCAL_CACHE_CORRUPT");
  const metadataValue = await readJson(layout, layout.meta, MAX_METADATA_BYTES);
  if (!isGraphMetadata(metadataValue)) throw new Error("LOCAL_CACHE_CORRUPT");
  const metadata = metadataValue;
  const bytes = await safeRead(layout, layout.graph, MAX_GRAPH_BYTES);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (
    !CHECKSUM.test(checksum) ||
    bytes.byteLength !== manifest.graph.byteSize ||
    checksum !== manifest.graph.checksum ||
    metadata.version !== manifest.graph.version ||
    metadata.status !== "READY" ||
    !sameRepository(manifest.repository, metadata.repository) ||
    metadata.sourceCommitSha !== manifest.graph.sourceCommitSha ||
    metadata.checksum !== manifest.graph.checksum ||
    metadata.byteSize !== manifest.graph.byteSize
  )
    throw new Error("LOCAL_CACHE_CORRUPT");
  verifyGraphShape(bytes, metadata);
  return { manifest, metadata, bytes };
}

export async function readLocalGraph(layout: Layout): Promise<LocalGraph | null> {
  return withMutationLock(layout, async () => {
    await recoverInterruptedSyncUnlocked(layout);
    return readLocalGraphUnlocked(layout);
  });
}

async function replaceGraphCacheUnlocked(
  layout: Layout,
  previousManifest: Manifest,
  metadata: GraphMetadata,
  graphBytes: Uint8Array,
  options: {
    syncedAt?: string;
    afterPrepare?: (name: "graph" | "meta" | "manifest") => void | Promise<void>;
    beforeInstall?: (name: "graph" | "meta" | "manifest") => void | Promise<void>;
  } = {},
) {
  const syncedAt = options.syncedAt ?? new Date().toISOString();
  await recoverInterruptedSyncUnlocked(layout);
  const currentManifest = await readManifestUnlocked(layout);
  if (!currentManifest || JSON.stringify(currentManifest) !== JSON.stringify(previousManifest))
    throw new Error("SYNC_CONFLICT");
  if (
    metadata.status !== "READY" ||
    !metadata.checksum ||
    metadata.byteSize === null ||
    metadata.byteSize !== graphBytes.byteLength ||
    graphBytes.byteLength > MAX_GRAPH_BYTES ||
    !SHA.test(metadata.sourceCommitSha) ||
    createHash("sha256").update(graphBytes).digest("hex") !== metadata.checksum
  )
    throw new Error("GRAPH_INTEGRITY_ERROR");
  verifyGraphShape(graphBytes, metadata);

  const nextManifest: Manifest = {
    ...previousManifest,
    graph: {
      version: metadata.version,
      sourceCommitSha: metadata.sourceCommitSha,
      checksum: metadata.checksum,
      byteSize: metadata.byteSize,
      syncedAt,
    },
  };
  if (!sameRepository(previousManifest.repository, metadata.repository))
    throw new Error("GRAPH_INTEGRITY_ERROR");
  const temporary: Partial<Record<"graph" | "meta" | "manifest", string>> = {};
  const previous = {
    manifest: await exists(layout, layout.manifest),
    graph: await exists(layout, layout.graph),
    meta: await exists(layout, layout.meta),
  };
  let markerPersisted = false;
  try {
    temporary.graph = await writeTemporary(layout, path.dirname(layout.graph), graphBytes);
    await options.afterPrepare?.("graph");
    temporary.meta = await writeTemporary(layout, path.dirname(layout.meta), jsonBytes(metadata));
    await options.afterPrepare?.("meta");
    temporary.manifest = await writeTemporary(
      layout,
      path.dirname(layout.manifest),
      jsonBytes(nextManifest),
    );
    await options.afterPrepare?.("manifest");
    for (const name of ["manifest", "graph", "meta"] as const) {
      if (previous[name]) {
        const maximum = name === "graph" ? MAX_GRAPH_BYTES : MAX_METADATA_BYTES;
        await atomicWrite(
          layout,
          layout.backups[name],
          await safeRead(layout, layout[name], maximum),
        );
      } else {
        await removeRegular(layout, layout.backups[name]);
      }
    }
    const marker: Marker = { formatVersion: 1, previous };
    await atomicWrite(layout, layout.marker, jsonBytes(marker));
    markerPersisted = true;
    await options.beforeInstall?.("graph");
    await assertStableParent(layout, layout.graph);
    await rename(temporary.graph, layout.graph);
    await options.beforeInstall?.("meta");
    await assertStableParent(layout, layout.meta);
    await rename(temporary.meta, layout.meta);
    await syncDirectory(layout, path.dirname(layout.graph));
    await options.beforeInstall?.("manifest");
    await assertStableParent(layout, layout.manifest);
    await rename(temporary.manifest, layout.manifest);
    await syncDirectory(layout, path.dirname(layout.manifest));
    await removeRegular(layout, layout.marker);
    await syncDirectory(layout, path.join(layout.context, "cache"));
    for (const backup of Object.values(layout.backups))
      await removeRegular(layout, backup).catch(() => undefined);
    await syncDirectory(layout, path.join(layout.context, "cache")).catch(() => undefined);
  } catch (error) {
    if (markerPersisted) {
      try {
        await restore(layout, { formatVersion: 1, previous });
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "LOCAL_CACHE_RECOVERY_FAILED");
      }
    }
    throw error;
  } finally {
    for (const candidate of Object.values(temporary)) {
      if (!candidate) continue;
      await assertStableParent(layout, candidate).catch(() => undefined);
      await rm(candidate, { force: true }).catch(() => undefined);
    }
  }
  return nextManifest;
}

export async function replaceGraphCache(
  layout: Layout,
  previousManifest: Manifest,
  metadata: GraphMetadata,
  graphBytes: Uint8Array,
  options: {
    syncedAt?: string;
    afterPrepare?: (name: "graph" | "meta" | "manifest") => void | Promise<void>;
    beforeInstall?: (name: "graph" | "meta" | "manifest") => void | Promise<void>;
  } = {},
) {
  return withMutationLock(layout, () =>
    replaceGraphCacheUnlocked(layout, previousManifest, metadata, graphBytes, options),
  );
}
