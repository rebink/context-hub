export type ArtifactFreshness = "CURRENT" | "STALE" | "UNKNOWN";

export type ContextBudget = {
  maxTokens: number;
  maxBytes: number;
  /** One response-wide evidence count. Existing callers retain the bounded default. */
  maxSources?: number;
};

export type ContextQuery = {
  projectId: string;
  query: string;
  domain?: string;
  package?: string;
  budget: ContextBudget;
};

export type CrossProjectContextQuery = {
  projectIds: string[];
  query: string;
  domain?: string;
  package?: string;
  budget: ContextBudget;
};

export type ContextProvenance = {
  projectId: string;
  source: "ARTIFACT" | "GRAPH" | "GIT" | "REFERENCE";
  path: string | null;
  section: string | null;
  version: string | null;
  commit: string | null;
  checksum: string | null;
};

export type ContextEvidence = {
  kind: ContextProvenance["source"];
  title: string;
  excerpt: string;
  relevanceReason: string;
  tokenEstimate: number;
  freshness: ArtifactFreshness | null;
  provenance: ContextProvenance;
};

export type ContextSourceError = "ARTIFACT_SOURCE_UNAVAILABLE" | "GRAPH_SOURCE_UNAVAILABLE";

export type ContextResult = {
  projectId: string;
  evidence: ContextEvidence[];
  tokenEstimate: number;
  byteSize: number;
  truncated: boolean;
  sourceErrors: ContextSourceError[];
};

export type CrossProjectContextResult = {
  projectIds: string[];
  evidence: ContextEvidence[];
  tokenEstimate: number;
  byteSize: number;
  truncated: boolean;
  sourceErrors: Array<{ projectId: string; error: ContextSourceError }>;
};

/** Retrieval only; authentication, authorization, and HTTP transport are caller-owned. */
export interface ContextProvider {
  search(input: ContextQuery): Promise<ContextResult>;
  searchMany(input: CrossProjectContextQuery): Promise<CrossProjectContextResult>;
}
