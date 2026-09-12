export const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
export const MAX_METADATA_BYTES = 64 * 1024;
export const SHA = /^[0-9a-f]{40}$/;
export const CHECKSUM = /^[0-9a-f]{64}$/;

export type GraphLifecycle = "QUEUED" | "BUILDING" | "FAILED" | "READY" | "SUPERSEDED";

export type RepositoryIdentity = {
  provider: string;
  providerRepositoryId: string;
  owner: string;
  name: string;
  canonicalUrl: string;
};

export type GraphMetadata = {
  repository: RepositoryIdentity;
  version: number;
  status: GraphLifecycle;
  sourceCommitSha: string;
  checksum: string | null;
  byteSize: number | null;
  nodeCount: number | null;
  linkCount: number | null;
  hyperedgeCount: number | null;
  graphifyVersion: string;
  adapterVersion: string;
  profile: string;
  formatVersion: number;
  generator: string;
  failureCategory: string | null;
  generatedAt: string | null;
  updatedAt: string;
};

export type SyncMetadata = {
  projectId: string;
  repository: RepositoryIdentity & {
    defaultBranch: string;
    remoteCommitSha: string;
  };
  newestGraph: GraphMetadata | null;
  readyGraph: GraphMetadata | null;
};

export type Manifest = {
  formatVersion: 1;
  apiOrigin: string;
  projectId: string;
  repository: RepositoryIdentity;
  graph: {
    version: number;
    sourceCommitSha: string;
    checksum: string;
    byteSize: number;
    syncedAt: string;
  } | null;
};

export type LocalGraph = {
  manifest: Manifest;
  metadata: GraphMetadata;
  bytes: Uint8Array;
};

export type SyncState =
  | "CURRENT"
  | "GRAPH_STALE"
  | "LOCAL_REPOSITORY_AHEAD"
  | "REMOTE_GRAPH_AHEAD"
  | "NO_LOCAL_GRAPH"
  | "GRAPH_BUILDING"
  | "GRAPH_FAILED"
  | "COMMIT_MISMATCH";

export function isSafeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

export function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.provider === "github" &&
    typeof item.providerRepositoryId === "string" &&
    item.providerRepositoryId.length > 0 &&
    item.providerRepositoryId.length <= 255 &&
    typeof item.owner === "string" &&
    item.owner.length > 0 &&
    item.owner.length <= 255 &&
    typeof item.name === "string" &&
    item.name.length > 0 &&
    item.name.length <= 255 &&
    typeof item.canonicalUrl === "string" &&
    /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.canonicalUrl)
  );
}

export function isGraphMetadata(value: unknown): value is GraphMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const nullableCount = (candidate: unknown) =>
    candidate === null || isSafeInteger(candidate, 0, 100_000);
  return (
    isRepositoryIdentity(item.repository) &&
    isSafeInteger(item.version, 1) &&
    ["QUEUED", "BUILDING", "FAILED", "READY", "SUPERSEDED"].includes(item.status as string) &&
    typeof item.sourceCommitSha === "string" &&
    SHA.test(item.sourceCommitSha) &&
    (item.checksum === null ||
      (typeof item.checksum === "string" && CHECKSUM.test(item.checksum))) &&
    (item.byteSize === null || isSafeInteger(item.byteSize, 0, MAX_GRAPH_BYTES)) &&
    nullableCount(item.nodeCount) &&
    nullableCount(item.linkCount) &&
    nullableCount(item.hyperedgeCount) &&
    typeof item.graphifyVersion === "string" &&
    item.graphifyVersion.length <= 64 &&
    typeof item.adapterVersion === "string" &&
    item.adapterVersion.length <= 64 &&
    typeof item.profile === "string" &&
    item.profile.length <= 128 &&
    isSafeInteger(item.formatVersion, 1, 100) &&
    typeof item.generator === "string" &&
    item.generator.length <= 255 &&
    (item.failureCategory === null ||
      (typeof item.failureCategory === "string" && item.failureCategory.length <= 64)) &&
    (item.generatedAt === null ||
      (typeof item.generatedAt === "string" && item.generatedAt.length <= 64)) &&
    typeof item.updatedAt === "string" &&
    item.updatedAt.length <= 64
  );
}

export function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    item.formatVersion !== 1 ||
    typeof item.apiOrigin !== "string" ||
    typeof item.projectId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(item.projectId) ||
    !isRepositoryIdentity(item.repository)
  )
    return false;
  if (item.graph === null) return true;
  if (!item.graph || typeof item.graph !== "object" || Array.isArray(item.graph)) return false;
  const graph = item.graph as Record<string, unknown>;
  return (
    isSafeInteger(graph.version, 1) &&
    typeof graph.sourceCommitSha === "string" &&
    SHA.test(graph.sourceCommitSha) &&
    typeof graph.checksum === "string" &&
    CHECKSUM.test(graph.checksum) &&
    isSafeInteger(graph.byteSize, 0, MAX_GRAPH_BYTES) &&
    typeof graph.syncedAt === "string" &&
    graph.syncedAt.length <= 64
  );
}
