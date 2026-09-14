import { classifyArtifactFreshness } from "./artifact-freshness.js";
import {
  ContextAuthorizationError,
  type ContextAuthorizationFence,
} from "./context-authorization.js";
import type {
  ContextEvidence,
  ContextProvider,
  ContextQuery,
  ContextResult,
  ContextSourceError,
  CrossProjectContextQuery,
  CrossProjectContextResult,
} from "./context-provider.js";
import type { GraphRow } from "./graphs.js";
import { loadVerifiedReadyGraph } from "./graphs.js";
import type { ObjectStorage } from "./object-storage.js";
import { sha256Bytes } from "./security.js";

const MAX_ARTIFACT_CANDIDATES = 24;
const MAX_ARTIFACT_SOURCE_BYTES = 64 * 1024;
const MAX_GRAPH_SOURCE_BYTES = 512 * 1024;
const MAX_GRAPH_EVIDENCE = 12;
const MAX_CROSS_PROJECT_ARTIFACT_CANDIDATES = 40;
const MAX_CROSS_PROJECT_GRAPH_EVIDENCE = 20;
const DEFAULT_MAX_SOURCES = 40;
const MAX_SOURCES = 80;
const MAX_PROJECTS = 20;
const MAX_EXCERPT_BYTES = 1_200;
const MAX_TERMS = 32;

const REFERENCE_TEXT = `Context Hub engineering invariants: Git is code truth, D1 is metadata truth, and R2 payloads are immutable. Every project-scoped request authenticates, resolves the project, verifies direct membership, and checks the current role. Context responses stay bounded and preserve source, version, commit, checksum, and project provenance.`;

type ArtifactCandidate = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  version: number;
  storage_key: string;
  checksum: string;
  content_type: string;
  byte_size: number;
  source_commit_sha: string | null;
  updated_at: string;
};

type GitRow = {
  provider: string;
  provider_repository_id: string;
  owner: string;
  repository_name: string;
  canonical_url: string;
  default_branch: string;
  last_known_commit_sha: string;
  status: string;
  updated_at: string;
};

type Ranked = {
  score: number;
  key: string;
  projectId: string;
  localRank: number;
  evidence: ContextEvidence;
};

type Retrieval = {
  ranked: Ranked[];
  sourceErrors: ContextSourceError[];
  retrievalTruncated: boolean;
};

type SearchTermsInput = Pick<ContextQuery, "query" | "domain" | "package">;

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const tokens = (value: string) => Math.max(1, Math.ceil(bytes(value) / 4));
const validCommit = (value: string | null | undefined) =>
  Boolean(value && /^[0-9a-f]{40}$/.test(value));

function truncateUtf8(value: string, limit: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= limit) return value;
  return `${new TextDecoder().decode(encoded.slice(0, Math.max(0, limit - 3))).replace(/\s+$/u, "")}...`;
}

function terms(input: SearchTermsInput): string[] {
  const values = [input.query, input.domain ?? "", input.package ?? ""]
    .join(" ")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_./-]{1,63}/g);
  return [...new Set(values ?? [])].slice(0, MAX_TERMS);
}

function matchScore(text: string, searchTerms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of searchTerms) {
    if (lower.includes(term)) score += term.includes("/") || term.includes(".") ? 7 : 4;
  }
  return score;
}

function excerpt(text: string, searchTerms: string[]): { text: string; section: string | null } {
  const lower = text.toLowerCase();
  const positions = searchTerms.map((term) => lower.indexOf(term)).filter((at) => at >= 0);
  const at = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, at - 240);
  const selected = truncateUtf8(text.slice(start, start + 2_000).trim(), MAX_EXCERPT_BYTES);
  const preceding = text.slice(0, at).split("\n").reverse();
  const heading = preceding.find((line) => /^#{1,6}\s+\S/.test(line.trim()));
  return { text: selected, section: heading?.replace(/^#{1,6}\s+/, "").trim() ?? null };
}

function reason(score: number, type?: string, domain?: string, packageName?: string): string {
  const reasons = [score > 0 ? "matches task terms" : "current project context"];
  if (type === "architecture" || type === "adr") reasons.push("architecture evidence");
  if (domain) reasons.push(`domain ${domain}`);
  if (packageName) reasons.push(`package ${packageName}`);
  return reasons.join("; ");
}

function completeEvidenceTokenEstimate(evidence: ContextEvidence): ContextEvidence {
  const complete = { ...evidence, tokenEstimate: 0 };
  let estimate = tokens(JSON.stringify(complete));
  while (complete.tokenEstimate !== estimate) {
    complete.tokenEstimate = estimate;
    estimate = tokens(JSON.stringify(complete));
  }
  return complete;
}

const STORAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PUBLICATION_ID = /^[A-Za-z0-9_-]{32,128}$/;
const validStorageInteger = (value: number | null): value is number =>
  Number.isSafeInteger(value) && value !== null && value >= 1 && value <= 2_147_483_647;

function artifactStorageKey(projectId: string, artifact: ArtifactCandidate): string | null {
  if (
    !STORAGE_ID.test(projectId) ||
    !STORAGE_ID.test(artifact.id) ||
    !validStorageInteger(artifact.version)
  )
    return null;
  return `projects/${projectId}/artifacts/${artifact.id}/v/${artifact.version}/content`;
}

function graphStorageKey(projectId: string, graph: GraphRow): string | null {
  if (!STORAGE_ID.test(projectId) || !validStorageInteger(graph.version)) return null;
  if (graph.storage_layout === "LEGACY_V1") {
    if (graph.selected_publication_id !== null) return null;
    return `projects/${projectId}/graphs/v/${graph.version}/graph.json`;
  }
  if (
    graph.storage_layout !== "ATTEMPT_V2" ||
    !validStorageInteger(graph.published_attempt) ||
    !graph.selected_publication_id ||
    !PUBLICATION_ID.test(graph.selected_publication_id)
  )
    return null;
  return `projects/${projectId}/graphs/v/${graph.version}/attempts/${graph.published_attempt}/${graph.selected_publication_id}/graph.json`;
}

function sortedDeduplicated(ranked: Ranked[]): ContextEvidence[] {
  const perProject = new Map<string, Ranked[]>();
  for (const item of ranked) {
    const values = perProject.get(item.projectId) ?? [];
    values.push(item);
    perProject.set(item.projectId, values);
  }
  for (const values of perProject.values()) {
    values.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    values.forEach((item, index) => {
      item.localRank = index;
    });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.localRank - b.localRank ||
      a.projectId.localeCompare(b.projectId) ||
      a.key.localeCompare(b.key),
  );
  const deduped = new Map<string, ContextEvidence>();
  for (const item of ranked) {
    // Equal text in another project is distinct evidence because its provenance is distinct.
    const contentKey = `${item.projectId}\0${item.evidence.excerpt}`;
    if (!deduped.has(contentKey)) {
      deduped.set(contentKey, completeEvidenceTokenEstimate(item.evidence));
    }
  }
  return [...deduped.values()];
}

export class ContextBudgetError extends Error {
  constructor() {
    super("context response budget is too small");
  }
}

function measureResult<T extends { byteSize: number }>(value: T): T {
  let measured = bytes(JSON.stringify(value));
  while (value.byteSize !== measured) {
    value.byteSize = measured;
    measured = bytes(JSON.stringify(value));
  }
  return value;
}

function ensureMinimumFits(shell: Record<string, unknown>, budget: ContextQuery["budget"]): void {
  const minimum = measureResult({
    ...shell,
    evidence: [] as ContextEvidence[],
    tokenEstimate: 0,
    byteSize: 0,
    truncated: false,
    sourceErrors: [] as unknown[],
  });
  if (minimum.byteSize > budget.maxBytes) throw new ContextBudgetError();
}

function applyBudget<
  E,
  T extends {
    evidence: ContextEvidence[];
    tokenEstimate: number;
    byteSize: number;
    truncated: boolean;
    sourceErrors: E[];
  },
>(
  shell: Omit<T, "evidence" | "tokenEstimate" | "byteSize" | "truncated" | "sourceErrors">,
  sourceErrors: E[],
  ranked: Ranked[],
  budget: ContextQuery["budget"],
  retrievalTruncated: boolean,
): T {
  const candidates = sortedDeduplicated(ranked);
  const sourceLimit = Math.min(budget.maxSources ?? DEFAULT_MAX_SOURCES, MAX_SOURCES);
  const admittedErrors: E[] = [];
  let omittedErrors = false;
  for (const error of sourceErrors) {
    const candidate = measureResult({
      ...shell,
      evidence: [] as ContextEvidence[],
      tokenEstimate: 0,
      byteSize: 0,
      truncated: false,
      sourceErrors: [...admittedErrors, error],
    });
    if (candidate.byteSize <= budget.maxBytes) admittedErrors.push(error);
    else omittedErrors = true;
  }

  const evidence: ContextEvidence[] = [];
  let tokenEstimate = 0;
  for (const item of candidates) {
    if (evidence.length >= sourceLimit) break;
    const nextTokens = tokenEstimate + item.tokenEstimate;
    const candidate = measureResult({
      ...shell,
      evidence: [...evidence, item],
      tokenEstimate: nextTokens,
      byteSize: 0,
      truncated: false,
      sourceErrors: admittedErrors,
    });
    if (nextTokens > budget.maxTokens || candidate.byteSize > budget.maxBytes) continue;
    evidence.push(item);
    tokenEstimate = nextTokens;
  }
  const result = measureResult({
    ...shell,
    evidence,
    tokenEstimate,
    byteSize: 0,
    truncated: retrievalTruncated || omittedErrors || evidence.length < candidates.length,
    sourceErrors: admittedErrors,
  }) as T;
  if (result.byteSize > budget.maxBytes) throw new ContextBudgetError();
  return result;
}

function allocatedLimit(total: number, projectCount: number, index: number): number {
  return Math.floor(total / projectCount) + (index < total % projectCount ? 1 : 0);
}

function canonicalProjectIds(projectIds: string[]): string[] {
  const ids = [...new Set(projectIds)].sort();
  if (ids.length < 1 || ids.length > MAX_PROJECTS || ids.some((id) => !STORAGE_ID.test(id))) {
    throw new Error("invalid project scope");
  }
  return ids;
}

export class ContextEngine implements ContextProvider {
  constructor(
    private readonly db: D1Database,
    private readonly storage: ObjectStorage,
    private readonly authorization: ContextAuthorizationFence,
  ) {}

  async search(input: ContextQuery): Promise<ContextResult> {
    this.authorization.assertProjectSet([input.projectId]);
    ensureMinimumFits({ projectId: input.projectId }, input.budget);
    const retrieval = await this.retrieve(input, MAX_ARTIFACT_CANDIDATES, MAX_GRAPH_EVIDENCE);
    return applyBudget<ContextSourceError, ContextResult>(
      { projectId: input.projectId },
      retrieval.sourceErrors,
      retrieval.ranked,
      input.budget,
      retrieval.retrievalTruncated,
    );
  }

  async searchMany(input: CrossProjectContextQuery): Promise<CrossProjectContextResult> {
    const projectIds = canonicalProjectIds(input.projectIds);
    this.authorization.assertProjectSet(projectIds);
    ensureMinimumFits({ projectIds }, input.budget);
    const retrievals: Array<{ projectId: string; value: Retrieval }> = [];
    for (const [index, projectId] of projectIds.entries()) {
      const value = await this.retrieve(
        { ...input, projectId },
        allocatedLimit(MAX_CROSS_PROJECT_ARTIFACT_CANDIDATES, projectIds.length, index),
        allocatedLimit(MAX_CROSS_PROJECT_GRAPH_EVIDENCE, projectIds.length, index),
      );
      retrievals.push({ projectId, value });
    }
    return applyBudget<
      CrossProjectContextResult["sourceErrors"][number],
      CrossProjectContextResult
    >(
      { projectIds },
      retrievals.flatMap(({ projectId, value }) =>
        value.sourceErrors.map((error) => ({ projectId, error })),
      ),
      retrievals.flatMap(({ value }) => value.ranked),
      input.budget,
      retrievals.some(({ value }) => value.retrievalTruncated),
    );
  }

  private async retrieve(
    input: ContextQuery,
    artifactLimit: number,
    graphLimit: number,
  ): Promise<Retrieval> {
    const searchTerms = terms(input);
    const ranked: Ranked[] = [];
    const sourceErrors: ContextResult["sourceErrors"] = [];
    let retrievalTruncated = false;

    await this.authorization.assertCurrent(this.db);
    const git = await this.authorization
      .prepare(
        this.db,
        `SELECT gc.provider, gc.provider_repository_id, ri.owner, ri.repository_name,
                ri.canonical_url, gc.default_branch, gc.last_known_commit_sha,
                gc.status, gc.updated_at
         FROM git_connections gc
         JOIN repository_identities ri ON ri.id = gc.repository_identity_id
         JOIN project_repositories pr ON pr.project_id = gc.project_id
           AND pr.repository_identity_id = ri.id
         WHERE gc.project_id = ? AND gc.status = 'VERIFIED'`,
        " LIMIT 1",
        [input.projectId],
      )
      .first<GitRow>();
    await this.authorization.assertCurrent(this.db);
    const currentCommit = validCommit(git?.last_known_commit_sha)
      ? git?.last_known_commit_sha
      : null;

    if (git) {
      const text = `${git.provider} repository ${git.provider_repository_id}; default branch ${git.default_branch}; current commit ${git.last_known_commit_sha}`;
      const item: ContextEvidence = {
        kind: "GIT",
        title: "Current repository metadata",
        excerpt: text,
        relevanceReason: "current repository provenance",
        tokenEstimate: tokens(text),
        freshness: null,
        provenance: {
          projectId: input.projectId,
          source: "GIT",
          path: null,
          section: "repository",
          version: git.updated_at,
          commit: currentCommit ?? null,
          checksum: null,
        },
      };
      ranked.push({
        score: 8 + matchScore(text, searchTerms),
        key: "git",
        projectId: input.projectId,
        localRank: 0,
        evidence: item,
      });
    }

    const searchableMetadata =
      "lower(a.name || ' ' || a.type || ' ' || coalesce(a.description, ''))";
    const metadataOrdering = searchTerms.length
      ? searchTerms
          .map(() => `CASE WHEN instr(${searchableMetadata}, ?) > 0 THEN 1 ELSE 0 END`)
          .join(" + ")
      : "0";
    await this.authorization.assertCurrent(this.db);
    const artifacts = await this.authorization
      .prepare(
        this.db,
        `SELECT a.id, a.type, a.name, a.description, a.current_version AS version,
                a.updated_at, av.storage_key, av.checksum, av.content_type, av.byte_size,
                av.source_commit_sha
         FROM artifacts a JOIN artifact_versions av
           ON av.artifact_id = a.id AND av.version = a.current_version
         WHERE a.project_id = ? AND a.status = 'ACTIVE'`,
        ` ORDER BY (${metadataOrdering}) DESC, a.updated_at DESC, a.id DESC LIMIT ?`,
        [input.projectId],
        [...searchTerms, artifactLimit + 1],
      )
      .all<ArtifactCandidate>();
    await this.authorization.assertCurrent(this.db);
    retrievalTruncated = artifacts.results.length > artifactLimit;

    for (const artifact of artifacts.results.slice(0, artifactLimit)) {
      const metadata = `${artifact.name} ${artifact.type} ${artifact.description ?? ""}`;
      const metadataScore = matchScore(metadata, searchTerms);
      if (artifact.byte_size > MAX_ARTIFACT_SOURCE_BYTES) {
        retrievalTruncated = true;
        continue;
      }
      if (artifact.storage_key !== artifactStorageKey(input.projectId, artifact)) {
        if (!sourceErrors.includes("ARTIFACT_SOURCE_UNAVAILABLE"))
          sourceErrors.push("ARTIFACT_SOURCE_UNAVAILABLE");
        continue;
      }
      try {
        await this.authorization.assertCurrent(this.db);
        const stored = await this.storage.head(artifact.storage_key);
        if (
          !stored ||
          stored.byteSize !== artifact.byte_size ||
          stored.byteSize > MAX_ARTIFACT_SOURCE_BYTES ||
          stored.httpContentType !== artifact.content_type ||
          stored.metadata.contentType !== artifact.content_type ||
          stored.metadata.checksum !== artifact.checksum
        ) {
          if (!sourceErrors.includes("ARTIFACT_SOURCE_UNAVAILABLE"))
            sourceErrors.push("ARTIFACT_SOURCE_UNAVAILABLE");
          continue;
        }
        await this.authorization.assertCurrent(this.db);
        const content = await this.storage.getBytes(artifact.storage_key);
        if (
          !content ||
          content.byteLength !== stored.byteSize ||
          (await sha256Bytes(content)) !== artifact.checksum
        ) {
          if (!sourceErrors.includes("ARTIFACT_SOURCE_UNAVAILABLE"))
            sourceErrors.push("ARTIFACT_SOURCE_UNAVAILABLE");
          continue;
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        const contentScore = matchScore(text, searchTerms);
        if (metadataScore + contentScore === 0) continue;
        const selected = excerpt(text, searchTerms);
        const evidence: ContextEvidence = {
          kind: "ARTIFACT",
          title: artifact.name,
          excerpt: selected.text,
          relevanceReason: reason(
            metadataScore + contentScore,
            artifact.type,
            input.domain,
            input.package,
          ),
          tokenEstimate: tokens(selected.text),
          freshness: classifyArtifactFreshness(artifact.source_commit_sha, currentCommit),
          provenance: {
            projectId: input.projectId,
            source: "ARTIFACT",
            path: `artifacts/${artifact.id}`,
            section: selected.section,
            version: String(artifact.version),
            commit: validCommit(artifact.source_commit_sha) ? artifact.source_commit_sha : null,
            checksum: artifact.checksum,
          },
        };
        const architectureBoost =
          artifact.type === "architecture" || artifact.type === "adr" ? 6 : 0;
        const currencyBoost =
          evidence.freshness === "CURRENT" ? 3 : evidence.freshness === "STALE" ? -1 : 0;
        ranked.push({
          score: 10 + metadataScore + contentScore + architectureBoost + currencyBoost,
          key: `artifact:${artifact.id}`,
          projectId: input.projectId,
          localRank: 0,
          evidence,
        });
      } catch (cause) {
        if (cause instanceof ContextAuthorizationError) throw cause;
        if (!sourceErrors.includes("ARTIFACT_SOURCE_UNAVAILABLE"))
          sourceErrors.push("ARTIFACT_SOURCE_UNAVAILABLE");
      }
    }

    if (git) await this.authorization.assertCurrent(this.db);
    const graphRow = git
      ? await this.authorization
          .prepare(
            this.db,
            `SELECT * FROM graph_versions
             WHERE project_id = ? AND repository_provider = ? AND provider_repository_id = ?
               AND repository_canonical_url = ? AND status = 'READY'`,
            " ORDER BY version DESC LIMIT 1",
            [input.projectId, git.provider, git.provider_repository_id, git.canonical_url],
          )
          .first<GraphRow>()
      : null;
    if (git) await this.authorization.assertCurrent(this.db);
    if (
      graphRow &&
      (!graphRow.storage_key || graphRow.storage_key !== graphStorageKey(input.projectId, graphRow))
    ) {
      sourceErrors.push("GRAPH_SOURCE_UNAVAILABLE");
    } else if (
      graphRow &&
      graphRow.byte_size !== null &&
      graphRow.byte_size > MAX_GRAPH_SOURCE_BYTES
    ) {
      sourceErrors.push("GRAPH_SOURCE_UNAVAILABLE");
    } else if (graphRow && graphRow.byte_size !== null) {
      try {
        const loaded = await loadVerifiedReadyGraph(this.storage, graphRow, async () => {
          await this.authorization.assertCurrent(this.db);
        });
        if (!loaded) throw new Error("invalid graph source");
        const matchingNodes = loaded.graph.nodes
          .map((node) => ({ node, score: matchScore(JSON.stringify(node), searchTerms) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score);
        if (matchingNodes.length > graphLimit) retrievalTruncated = true;
        for (const { node, score } of matchingNodes.slice(0, graphLimit)) {
          const adjacent = loaded.graph.links
            .filter((link) => link.source === node.id || link.target === node.id)
            .slice(0, 4)
            .map((link) => ({
              source: link.source,
              target: link.target,
              relation: typeof link.relation === "string" ? link.relation : null,
            }));
          const text = truncateUtf8(
            JSON.stringify({ node, relationships: adjacent }),
            MAX_EXCERPT_BYTES,
          );
          const sourceFile = typeof node.source_file === "string" ? node.source_file : null;
          const sourceLocation =
            typeof node.source_location === "string" ? node.source_location : null;
          const evidence: ContextEvidence = {
            kind: "GRAPH",
            title: typeof node.label === "string" ? node.label : node.id,
            excerpt: text,
            relevanceReason: "task-matched Graphify node with bounded relationships",
            tokenEstimate: tokens(text),
            freshness: null,
            provenance: {
              projectId: input.projectId,
              source: "GRAPH",
              path: sourceFile,
              section: sourceLocation,
              version: String(graphRow.version),
              commit: graphRow.source_commit_sha,
              checksum: graphRow.checksum,
            },
          };
          ranked.push({
            score: 12 + score,
            key: `graph:${node.id}`,
            projectId: input.projectId,
            localRank: 0,
            evidence,
          });
        }
      } catch (cause) {
        if (cause instanceof ContextAuthorizationError) throw cause;
        sourceErrors.push("GRAPH_SOURCE_UNAVAILABLE");
      }
    }

    const referenceScore = matchScore(REFERENCE_TEXT, searchTerms);
    if (referenceScore > 0) {
      const checksum = await sha256Bytes(new TextEncoder().encode(REFERENCE_TEXT));
      const reference: ContextEvidence = {
        kind: "REFERENCE",
        title: "Context Hub agent guidance",
        excerpt: REFERENCE_TEXT,
        relevanceReason: "small linked architecture guidance matching task terms",
        tokenEstimate: tokens(REFERENCE_TEXT),
        freshness: null,
        provenance: {
          projectId: input.projectId,
          source: "REFERENCE",
          path: null,
          section: "built-in engineering invariants",
          version: "context-hub-reference-v1",
          commit: null,
          checksum,
        },
      };
      ranked.push({
        score: 5 + referenceScore,
        key: "reference:agents",
        projectId: input.projectId,
        localRank: 0,
        evidence: reference,
      });
    }

    return { ranked, sourceErrors, retrievalTruncated };
  }
}
