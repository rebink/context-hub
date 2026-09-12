import { createHash } from "node:crypto";
import {
  ensureLayout,
  readLocalGraph,
  readManifest,
  replaceGraphCache,
  writeManifest,
} from "./cache.js";
import {
  ClientError,
  isAncestor,
  localHead,
  localRemote,
  repositoryRoot,
  SyncClient,
  validateApiOrigin,
} from "./client.js";
import type { LocalGraph, Manifest, RepositoryIdentity, SyncMetadata, SyncState } from "./types.js";

export { ensureLayout, readLocalGraph, readManifest, recoverInterruptedSync } from "./cache.js";
export {
  ClientError,
  localRemote,
  repositoryRoot,
  SyncClient,
  validateApiOrigin,
} from "./client.js";
export type { GraphMetadata, LocalGraph, Manifest, SyncMetadata, SyncState } from "./types.js";

export type StatusResult = {
  state: SyncState;
  offline: boolean;
  localCommitSha: string;
  localGraphVersion: number | null;
  localGraphCommitSha: string | null;
  remoteCommitSha: string | null;
  remoteGraphVersion: number | null;
};

export function normalizeGithubRemote(value: string): string | null {
  const input = value.trim();
  let owner: string | undefined;
  let repository: string | undefined;
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/i.exec(input);
  if (scp) {
    owner = scp[1];
    repository = scp[2];
  } else {
    try {
      const url = new URL(input);
      if (
        !["https:", "ssh:"].includes(url.protocol) ||
        url.hostname.toLowerCase() !== "github.com" ||
        url.port ||
        url.search ||
        url.hash ||
        (url.username && url.username !== "git") ||
        url.password
      )
        return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 2) return null;
      owner = parts[0];
      repository = parts[1];
    } catch {
      return null;
    }
  }
  repository = repository?.replace(/\.git$/i, "");
  if (
    !owner ||
    !repository ||
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repository)
  )
    return null;
  return `github.com/${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity) {
  return (
    left.provider === right.provider &&
    left.providerRepositoryId === right.providerRepositoryId &&
    left.canonicalUrl === right.canonicalUrl
  );
}

export async function deriveStatus(
  root: string,
  manifest: Manifest,
  local: LocalGraph | null,
  localCommitSha: string,
  remote: SyncMetadata | null,
): Promise<StatusResult> {
  const base = {
    localCommitSha,
    localGraphVersion: local?.metadata.version ?? null,
    localGraphCommitSha: local?.metadata.sourceCommitSha ?? null,
    remoteCommitSha: remote?.repository.remoteCommitSha ?? null,
    remoteGraphVersion: remote?.readyGraph?.version ?? null,
  };
  if (!remote) {
    const state: SyncState = !local
      ? "NO_LOCAL_GRAPH"
      : local.metadata.sourceCommitSha !== localCommitSha
        ? "GRAPH_STALE"
        : "CURRENT";
    return { state, offline: true, ...base };
  }
  if (
    remote.projectId !== manifest.projectId ||
    !sameRepository(manifest.repository, remote.repository) ||
    (remote.newestGraph !== null &&
      !sameRepository(manifest.repository, remote.newestGraph.repository)) ||
    (remote.readyGraph !== null &&
      !sameRepository(manifest.repository, remote.readyGraph.repository))
  )
    return { state: "COMMIT_MISMATCH", offline: false, ...base };
  if (localCommitSha !== remote.repository.remoteCommitSha) {
    const ahead = await isAncestor(root, remote.repository.remoteCommitSha, localCommitSha);
    if (!ahead) return { state: "COMMIT_MISMATCH", offline: false, ...base };
  }
  if (["QUEUED", "BUILDING"].includes(remote.newestGraph?.status ?? ""))
    return { state: "GRAPH_BUILDING", offline: false, ...base };
  if (remote.newestGraph?.status === "FAILED")
    return { state: "GRAPH_FAILED", offline: false, ...base };
  if (!local) return { state: "NO_LOCAL_GRAPH", offline: false, ...base };
  if (remote.readyGraph && remote.readyGraph.version > local.metadata.version)
    return { state: "REMOTE_GRAPH_AHEAD", offline: false, ...base };
  if (localCommitSha !== remote.repository.remoteCommitSha)
    return { state: "LOCAL_REPOSITORY_AHEAD", offline: false, ...base };
  if (
    local.metadata.sourceCommitSha !== localCommitSha ||
    (remote.readyGraph && remote.readyGraph.sourceCommitSha !== remote.repository.remoteCommitSha)
  )
    return { state: "GRAPH_STALE", offline: false, ...base };
  return { state: "CURRENT", offline: false, ...base };
}

export async function connectProject(options: {
  directory: string;
  apiOrigin: string;
  session: string;
  projectId?: string;
  fetchImplementation?: typeof fetch;
  signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  const root = await repositoryRoot(options.directory);
  const remoteValue = await localRemote(root);
  const canonical = normalizeGithubRemote(remoteValue);
  if (!canonical) throw new ClientError("INVALID_REPOSITORY");
  const client = new SyncClient(
    validateApiOrigin(options.apiOrigin),
    options.session,
    options.fetchImplementation,
  );
  const projectId = options.projectId ?? (await client.resolve(remoteValue, options.signal));
  const metadata = await client.metadata(projectId, options.signal);
  if (metadata.repository.canonicalUrl !== canonical) throw new ClientError("COMMIT_MISMATCH");
  options.signal?.throwIfAborted();
  const layout = await ensureLayout(root);
  const existing = await readManifest(layout);
  const keepGraph =
    existing &&
    existing.apiOrigin === client.apiOrigin &&
    existing.projectId === projectId &&
    sameRepository(existing.repository, metadata.repository)
      ? existing.graph
      : null;
  const manifest: Manifest = {
    formatVersion: 1,
    apiOrigin: client.apiOrigin,
    projectId,
    repository: {
      provider: metadata.repository.provider,
      providerRepositoryId: metadata.repository.providerRepositoryId,
      owner: metadata.repository.owner,
      name: metadata.repository.name,
      canonicalUrl: metadata.repository.canonicalUrl,
    },
    graph: keepGraph,
  };
  options.signal?.throwIfAborted();
  await writeManifest(layout, manifest);
  return manifest;
}

export async function projectStatus(options: {
  directory: string;
  session?: string;
  credentialApiOrigin?: string;
  fetchImplementation?: typeof fetch;
}) {
  const root = await repositoryRoot(options.directory);
  const layout = await ensureLayout(root);
  const manifest = await readManifest(layout);
  if (!manifest) throw new ClientError("NOT_CONNECTED");
  const head = await localHead(root);
  const canonicalRemote = normalizeGithubRemote(await localRemote(root));
  if (!canonicalRemote || canonicalRemote !== manifest.repository.canonicalUrl) {
    return {
      state: "COMMIT_MISMATCH",
      offline: !options.session,
      localCommitSha: head,
      localGraphVersion: manifest.graph?.version ?? null,
      localGraphCommitSha: manifest.graph?.sourceCommitSha ?? null,
      remoteCommitSha: null,
      remoteGraphVersion: null,
    } satisfies StatusResult;
  }
  let local: LocalGraph | null;
  try {
    local = await readLocalGraph(layout);
  } catch {
    return {
      state: "COMMIT_MISMATCH",
      offline: !options.session,
      localCommitSha: head,
      localGraphVersion: manifest.graph?.version ?? null,
      localGraphCommitSha: manifest.graph?.sourceCommitSha ?? null,
      remoteCommitSha: null,
      remoteGraphVersion: null,
    } satisfies StatusResult;
  }
  if (!options.session) return deriveStatus(root, manifest, local, head, null);
  if (
    !options.credentialApiOrigin ||
    validateApiOrigin(options.credentialApiOrigin) !== manifest.apiOrigin
  )
    throw new ClientError("CREDENTIAL_ORIGIN_MISMATCH");
  const client = new SyncClient(manifest.apiOrigin, options.session, options.fetchImplementation);
  try {
    return await deriveStatus(
      root,
      manifest,
      local,
      head,
      await client.metadata(manifest.projectId),
    );
  } catch (error) {
    if (
      error instanceof ClientError &&
      (error.code === "OFFLINE" ||
        (error.code === "HTTP_ERROR" &&
          error.status !== undefined &&
          (error.status === 408 ||
            error.status === 425 ||
            error.status === 429 ||
            error.status >= 500)))
    )
      return deriveStatus(root, manifest, local, head, null);
    throw error;
  }
}

export async function syncProject(options: {
  directory: string;
  session: string;
  credentialApiOrigin: string;
  fetchImplementation?: typeof fetch;
}) {
  const root = await repositoryRoot(options.directory);
  const layout = await ensureLayout(root);
  const manifest = await readManifest(layout);
  if (!manifest) throw new ClientError("NOT_CONNECTED");
  const canonicalRemote = normalizeGithubRemote(await localRemote(root));
  if (!canonicalRemote || canonicalRemote !== manifest.repository.canonicalUrl)
    throw new ClientError("COMMIT_MISMATCH");
  if (validateApiOrigin(options.credentialApiOrigin) !== manifest.apiOrigin)
    throw new ClientError("CREDENTIAL_ORIGIN_MISMATCH");
  const client = new SyncClient(manifest.apiOrigin, options.session, options.fetchImplementation);
  const metadata = await client.metadata(manifest.projectId);
  if (
    metadata.projectId !== manifest.projectId ||
    !sameRepository(manifest.repository, metadata.repository)
  )
    throw new ClientError("COMMIT_MISMATCH");
  const ready = metadata.readyGraph;
  if (!ready) throw new ClientError("NO_REMOTE_GRAPH");
  if (!sameRepository(manifest.repository, ready.repository))
    throw new ClientError("COMMIT_MISMATCH");
  if (manifest.graph?.version === ready.version) {
    const local = await readLocalGraph(layout);
    if (local) return manifest;
  }
  const bytes = await client.download(manifest.projectId, ready);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== ready.checksum || ready.sourceCommitSha !== metadata.readyGraph?.sourceCommitSha)
    throw new ClientError("GRAPH_INTEGRITY_ERROR");
  return replaceGraphCache(layout, manifest, ready, bytes);
}
