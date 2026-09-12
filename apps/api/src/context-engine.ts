import { classifyArtifactFreshness } from "./artifact-freshness.js";
import type {
  ContextEvidence,
  ContextProvider,
  ContextQuery,
  ContextResult,
} from "./context-provider.js";
import type { GraphRow } from "./graphs.js";
import { loadVerifiedReadyGraph } from "./graphs.js";
import type { ObjectStorage } from "./object-storage.js";
import { sha256Bytes } from "./security.js";

const MAX_ARTIFACT_CANDIDATES = 24;
const MAX_ARTIFACT_SOURCE_BYTES = 64 * 1024;
const MAX_GRAPH_SOURCE_BYTES = 512 * 1024;
const MAX_GRAPH_EVIDENCE = 12;
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

type Ranked = { score: number; key: string; evidence: ContextEvidence };

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const tokens = (value: string) => Math.max(1, Math.ceil(bytes(value) / 4));
const validCommit = (value: string | null | undefined) =>
  Boolean(value && /^[0-9a-f]{40}$/.test(value));

function truncateUtf8(value: string, limit: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= limit) return value;
  return `${new TextDecoder().decode(encoded.slice(0, Math.max(0, limit - 3))).replace(/\s+$/u, "")}...`;
}

function terms(input: ContextQuery): string[] {
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

function finish(
  projectId: string,
  ranked: Ranked[],
  input: ContextQuery,
  sourceErrors: ContextResult["sourceErrors"],
  retrievalTruncated: boolean,
): ContextResult {
  ranked.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const deduped = new Map<string, Ranked>();
  for (const item of ranked) {
    const contentKey = item.evidence.excerpt.toLowerCase().replace(/\s+/g, " ").trim();
    if (!deduped.has(contentKey)) {
      deduped.set(contentKey, {
        ...item,
        evidence: completeEvidenceTokenEstimate(item.evidence),
      });
    }
  }
  const evidence: ContextEvidence[] = [];
  let tokenEstimate = 0;
  for (const item of deduped.values()) {
    const nextTokens = tokenEstimate + item.evidence.tokenEstimate;
    const next = [...evidence, item.evidence];
    const resultBytes = bytes(
      JSON.stringify({
        projectId,
        evidence: next,
        tokenEstimate: nextTokens,
        byteSize: input.budget.maxBytes,
        truncated: true,
        sourceErrors,
      }),
    );
    if (nextTokens > input.budget.maxTokens || resultBytes > input.budget.maxBytes) continue;
    evidence.push(item.evidence);
    tokenEstimate = nextTokens;
  }
  const truncated = retrievalTruncated || evidence.length < deduped.size;
  const base = { projectId, evidence, tokenEstimate, byteSize: 0, truncated, sourceErrors };
  let measured = bytes(JSON.stringify(base));
  while (base.byteSize !== measured) {
    base.byteSize = measured;
    measured = bytes(JSON.stringify(base));
  }
  return base;
}

export class ContextEngine implements ContextProvider {
  constructor(
    private readonly db: D1Database,
    private readonly storage: ObjectStorage,
  ) {}

  async search(input: ContextQuery): Promise<ContextResult> {
    const searchTerms = terms(input);
    const ranked: Ranked[] = [];
    const sourceErrors: ContextResult["sourceErrors"] = [];
    let retrievalTruncated = false;

    const git = await this.db
      .prepare(
        `SELECT gc.provider, gc.provider_repository_id, ri.owner, ri.repository_name,
                ri.canonical_url, gc.default_branch, gc.last_known_commit_sha,
                gc.status, gc.updated_at
         FROM git_connections gc
         JOIN repository_identities ri ON ri.id = gc.repository_identity_id
         JOIN project_repositories pr ON pr.project_id = gc.project_id
           AND pr.repository_identity_id = ri.id
         WHERE gc.project_id = ? AND gc.status = 'VERIFIED' LIMIT 1`,
      )
      .bind(input.projectId)
      .first<GitRow>();
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
      ranked.push({ score: 8 + matchScore(text, searchTerms), key: "git", evidence: item });
    }

    const searchableMetadata =
      "lower(a.name || ' ' || a.type || ' ' || coalesce(a.description, ''))";
    const metadataOrdering = searchTerms.length
      ? searchTerms
          .map(() => `CASE WHEN instr(${searchableMetadata}, ?) > 0 THEN 1 ELSE 0 END`)
          .join(" + ")
      : "0";
    const artifacts = await this.db
      .prepare(
        `SELECT a.id, a.type, a.name, a.description, a.current_version AS version,
                a.updated_at, av.storage_key, av.checksum, av.content_type, av.byte_size,
                av.source_commit_sha
         FROM artifacts a JOIN artifact_versions av
           ON av.artifact_id = a.id AND av.version = a.current_version
         WHERE a.project_id = ? AND a.status = 'ACTIVE'
         ORDER BY (${metadataOrdering}) DESC, a.updated_at DESC, a.id DESC LIMIT ?`,
      )
      .bind(input.projectId, ...searchTerms, MAX_ARTIFACT_CANDIDATES + 1)
      .all<ArtifactCandidate>();
    retrievalTruncated = artifacts.results.length > MAX_ARTIFACT_CANDIDATES;

    for (const artifact of artifacts.results.slice(0, MAX_ARTIFACT_CANDIDATES)) {
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
          evidence,
        });
      } catch {
        if (!sourceErrors.includes("ARTIFACT_SOURCE_UNAVAILABLE"))
          sourceErrors.push("ARTIFACT_SOURCE_UNAVAILABLE");
      }
    }

    const graphRow = git
      ? await this.db
          .prepare(
            `SELECT * FROM graph_versions
             WHERE project_id = ? AND repository_provider = ? AND provider_repository_id = ?
               AND repository_canonical_url = ? AND status = 'READY'
             ORDER BY version DESC LIMIT 1`,
          )
          .bind(input.projectId, git.provider, git.provider_repository_id, git.canonical_url)
          .first<GraphRow>()
      : null;
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
        const loaded = await loadVerifiedReadyGraph(this.storage, graphRow);
        if (!loaded) throw new Error("invalid graph source");
        const matchingNodes = loaded.graph.nodes
          .map((node) => ({ node, score: matchScore(JSON.stringify(node), searchTerms) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score);
        if (matchingNodes.length > MAX_GRAPH_EVIDENCE) retrievalTruncated = true;
        for (const { node, score } of matchingNodes.slice(0, MAX_GRAPH_EVIDENCE)) {
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
          ranked.push({ score: 12 + score, key: `graph:${node.id}`, evidence });
        }
      } catch {
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
      ranked.push({ score: 5 + referenceScore, key: "reference:agents", evidence: reference });
    }

    return finish(input.projectId, ranked, input, sourceErrors, retrievalTruncated);
  }
}
