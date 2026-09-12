export const GRAPHIFY_VERSION = "0.9.58" as const;
export const ADAPTER_VERSION = "1.0.0" as const;
export const GRAPH_PROFILE = "code-only-clustered-v1" as const;
export const GRAPH_FORMAT_VERSION = 1 as const;
export const GRAPH_GENERATOR =
  `graphify/${GRAPHIFY_VERSION} context-hub-adapter/${ADAPTER_VERSION} ${GRAPH_PROFILE}` as const;
export const MAX_GRAPH_BYTES = 8 * 1024 * 1024;
export const MAX_METADATA_BYTES = 4 * 1024;

/** The host must enforce these attested limits; Node only verifies that policy was supplied. */
export interface ExecutorResourcePolicy {
  readonly attested: true;
  readonly memoryLimitBytes: number;
  readonly diskLimitBytes: number;
}

export interface RepositoryIdentitySnapshot {
  readonly provider: string;
  readonly providerRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly canonicalUrl: string;
}

export interface GraphBuildInput {
  readonly checkoutPath: string;
  readonly projectId: string;
  readonly repositoryProvider: string;
  readonly providerRepositoryId: string;
  readonly repositoryIdentitySnapshot: RepositoryIdentitySnapshot;
  readonly sourceCommitSha: string;
  readonly executorPolicy: ExecutorResourcePolicy;
}

export interface GraphBuildResult {
  readonly bytes: Uint8Array;
  readonly byteSize: number;
  readonly contentChecksumSha256: string;
  readonly nodeCount: number;
  readonly linkCount: number;
  readonly hyperedgeCount: number;
  readonly projectId: string;
  readonly repositoryProvider: string;
  readonly providerRepositoryId: string;
  readonly repositoryIdentitySnapshot: RepositoryIdentitySnapshot;
  readonly sourceCommitSha: string;
  readonly graphifyVersion: typeof GRAPHIFY_VERSION;
  readonly adapterVersion: typeof ADAPTER_VERSION;
  readonly profile: typeof GRAPH_PROFILE;
  readonly formatVersion: typeof GRAPH_FORMAT_VERSION;
  readonly generator: typeof GRAPH_GENERATOR;
}

export interface GraphProvider {
  build(input: GraphBuildInput): Promise<GraphBuildResult>;
}

export type GraphAdapterFailureKind =
  | "INVALID_INPUT"
  | "RESOURCE_POLICY_REQUIRED"
  | "UNSUPPORTED_PLATFORM"
  | "TRUSTED_EXECUTABLE_INVALID"
  | "INVALID_CHECKOUT"
  | "COMMIT_MISMATCH"
  | "DIRTY_CHECKOUT"
  | "UNSUPPORTED_REPOSITORY_CONTENT"
  | "TOOL_VERSION_MISMATCH"
  | "PROCESS_TIMEOUT"
  | "PROCESS_FAILED"
  | "CLEANUP_FAILED"
  | "OUTPUT_INVALID"
  | "GRAPH_INVALID"
  | "HANDSHAKE_MISMATCH";

export class GraphAdapterError extends Error {
  readonly kind: GraphAdapterFailureKind;

  constructor(kind: GraphAdapterFailureKind) {
    super(`Graph build failed: ${kind}`);
    this.name = "GraphAdapterError";
    this.kind = kind;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly stdin?: Uint8Array;
}

export interface ProcessResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface ProcessBoundary {
  run(request: ProcessRequest): Promise<ProcessResult>;
}
