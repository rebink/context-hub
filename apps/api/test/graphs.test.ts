/* biome-ignore-all lint/suspicious/noExplicitAny: The focused fake models Cloudflare bindings structurally. */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  claimGraphBuild,
  cleanupFailedGraphAttempt,
  expireGraphBuild,
  failGraphBuild,
  GRAPH_BUILD_IDENTITY,
  type GraphBuildResult,
  type GraphClaim,
  GraphConflictError,
  handleGraphRoute,
  publishGraphBuild,
} from "../src/graphs.js";
import { createApp, type Env } from "../src/index.js";
import type {
  ObjectStorage,
  ObjectStorageMetadata,
  StoredObjectMetadata,
} from "../src/object-storage.js";
import { sha256Bytes } from "../src/security.js";

type Row = Record<string, any>;

class Statement {
  args: any[] = [];
  constructor(
    private db: GraphD1,
    readonly sql: string,
  ) {}
  bind(...args: any[]) {
    this.args = args;
    return this;
  }
  async first<T>() {
    return this.db.first(this.sql, this.args) as T | null;
  }
  async all<T>() {
    return { success: true, results: this.db.all(this.sql, this.args), meta: {} } as D1Result<T>;
  }
}

class GraphD1 {
  memberships: Row[] = [];
  connection: Row | null = null;
  graphs: Row[] = [];
  attempts: Row[] = [];
  readyUpdateFailure: "before-commit" | "after-commit" | null = null;
  orphanUpdateFailure = false;
  demoteBeforeGraphMutation = false;
  removeBeforeGraphMutation = false;
  beforeCleanupReconcile: (() => void) | null = null;

  prepare(sql: string) {
    return new Statement(this, sql);
  }
  private has(sql: string, value: string) {
    return sql.replace(/\s+/g, " ").includes(value);
  }

  first(sql: string, args: any[]): Row | null {
    if (this.has(sql, "SELECT pm.role FROM project_members pm")) {
      return (
        this.memberships.find((row) => row.project_id === args[0] && row.user_id === args[1]) ??
        null
      );
    }
    if (this.has(sql, "INSERT INTO graph_versions")) {
      const projectId = args.at(-1);
      const actorId = args.at(-2);
      if (this.demoteBeforeGraphMutation) {
        const member = this.memberships.find(
          (row) => row.project_id === projectId && row.user_id === actorId,
        );
        if (member) member.role = "VIEWER";
        this.demoteBeforeGraphMutation = false;
      }
      if (this.removeBeforeGraphMutation) {
        this.memberships = this.memberships.filter(
          (row) => row.project_id !== projectId || row.user_id !== actorId,
        );
        this.removeBeforeGraphMutation = false;
      }
      if (
        !this.connection ||
        this.connection.project_id !== projectId ||
        !this.memberships.some(
          (row) => row.project_id === projectId && row.user_id === actorId && row.role === "ADMIN",
        ) ||
        this.connection.status !== "VERIFIED"
      )
        return null;
      const identity = this.graphs.find(
        (row) =>
          row.project_id === projectId &&
          row.repository_provider === this.connection?.provider &&
          row.provider_repository_id === this.connection?.provider_repository_id &&
          row.repository_owner === this.connection?.owner &&
          row.repository_name === this.connection?.repository_name &&
          row.repository_canonical_url === this.connection?.canonical_url &&
          row.source_commit_sha === this.connection?.last_known_commit_sha &&
          row.graphify_version === args[1] &&
          row.adapter_version === args[2] &&
          row.profile === args[3] &&
          row.format_version === args[4],
      );
      if (identity) throw new Error("UNIQUE constraint failed: graph_versions identity");
      const now = "2026-01-01T00:00:00.000Z";
      const projectVersions = this.graphs
        .filter((item) => item.project_id === projectId)
        .map((item) => item.version);
      const row = graphRow({
        id: args[0],
        project_id: projectId,
        version: Math.max(0, ...projectVersions) + 1,
        repository_provider: this.connection.provider,
        provider_repository_id: this.connection.provider_repository_id,
        repository_owner: this.connection.owner,
        repository_name: this.connection.repository_name,
        repository_canonical_url: this.connection.canonical_url,
        source_commit_sha: this.connection.last_known_commit_sha,
        graphify_version: args[1],
        adapter_version: args[2],
        profile: args[3],
        format_version: args[4],
        generator: args[5],
        queued_at: now,
        updated_at: now,
      });
      this.graphs.push(row);
      return row;
    }
    if (this.has(sql, "SELECT gv.* FROM graph_versions gv")) {
      if (
        !this.connection ||
        this.connection.project_id !== args[1] ||
        !this.memberships.some(
          (row) => row.project_id === args[1] && row.user_id === args[0] && row.role === "ADMIN",
        )
      )
        return null;
      return (
        this.graphs.find(
          (row) =>
            row.project_id === args[1] &&
            row.repository_provider === this.connection?.provider &&
            row.provider_repository_id === this.connection?.provider_repository_id &&
            row.repository_owner === this.connection?.owner &&
            row.repository_name === this.connection?.repository_name &&
            row.repository_canonical_url === this.connection?.canonical_url &&
            row.source_commit_sha === this.connection?.last_known_commit_sha &&
            row.graphify_version === args[2] &&
            row.adapter_version === args[3] &&
            row.profile === args[4] &&
            row.format_version === args[5],
        ) ?? null
      );
    }
    if (this.has(sql, "UPDATE graph_versions SET orphan_observed_at = ?")) {
      const row = this.graphs.find(
        (item) =>
          item.project_id === args[6] &&
          item.version === args[7] &&
          item.status === "FAILED" &&
          item.attempt === args[8] &&
          !item.orphan_observed_at,
      );
      if (!row) return null;
      Object.assign(row, {
        orphan_observed_at: args[0],
        orphan_attempt: args[1],
        orphan_lease_id: args[2],
        orphan_checksum: args[3],
        orphan_byte_size: args[4],
        orphan_cleanup_id: null,
        orphan_cleanup_expires_at: null,
        updated_at: args[5],
      });
      return null;
    }
    if (this.has(sql, "UPDATE graph_versions SET orphan_cleanup_id = ?")) {
      if (this.orphanUpdateFailure) throw new Error("D1 unavailable");
      const row = this.graphs.find(
        (item) =>
          item.project_id === args[3] &&
          item.version === args[4] &&
          item.status === "FAILED" &&
          item.attempt === args[5] &&
          item.orphan_observed_at === args[6] &&
          item.orphan_attempt === args[7] &&
          item.orphan_lease_id === args[8] &&
          item.orphan_checksum === args[9] &&
          item.orphan_byte_size === args[10] &&
          (!item.orphan_cleanup_id || item.orphan_cleanup_expires_at <= args[11]),
      );
      if (!row) return null;
      Object.assign(row, {
        orphan_cleanup_id: args[0],
        orphan_cleanup_expires_at: args[1],
        updated_at: args[2],
      });
      return { version: row.version };
    }
    if (
      this.has(sql, "SELECT storage_key FROM graph_versions") &&
      this.has(sql, "status IN ('READY', 'SUPERSEDED')")
    ) {
      return (
        this.graphs.find(
          (row) =>
            row.project_id === args[0] &&
            row.storage_key === args[1] &&
            ["READY", "SUPERSEDED"].includes(row.status),
        ) ?? null
      );
    }
    if (
      this.has(sql, "SELECT version FROM graph_versions") &&
      this.has(sql, "orphan_cleanup_id = ?")
    ) {
      return (
        this.graphs.find(
          (row) =>
            row.project_id === args[0] &&
            row.version === args[1] &&
            row.status === "FAILED" &&
            row.attempt === args[2] &&
            row.orphan_cleanup_id === args[3],
        ) ?? null
      );
    }
    if (this.has(sql, "UPDATE graph_versions SET status = 'QUEUED'")) {
      if (this.demoteBeforeGraphMutation) {
        const member = this.memberships.find(
          (candidate) => candidate.project_id === args[1] && candidate.user_id === args[4],
        );
        if (member) member.role = "VIEWER";
        this.demoteBeforeGraphMutation = false;
      }
      if (this.removeBeforeGraphMutation) {
        this.memberships = this.memberships.filter(
          (candidate) => candidate.project_id !== args[1] || candidate.user_id !== args[4],
        );
        this.removeBeforeGraphMutation = false;
      }
      const row = this.graphs.find(
        (item) =>
          item.project_id === args[1] &&
          item.version === args[2] &&
          item.status === "FAILED" &&
          item.attempt === args[3] &&
          this.memberships.some(
            (member) =>
              member.project_id === args[1] &&
              member.user_id === args[4] &&
              member.role === "ADMIN",
          ),
      );
      if (!row) return null;
      Object.assign(row, {
        status: "QUEUED",
        attempt: row.attempt + 1,
        failure_category: null,
        failed_at: null,
        build_started_at: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      return row;
    }
    if (this.has(sql, "INSERT INTO graph_build_attempts")) {
      const graph = this.graphs.find(
        (item) =>
          item.project_id === args[6] && item.version === args[7] && item.status === "QUEUED",
      );
      if (
        !graph ||
        this.attempts.some(
          (item) =>
            item.project_id === args[6] &&
            item.graph_version === args[7] &&
            item.attempt === graph.attempt,
        )
      )
        return null;
      const attempt = {
        project_id: graph.project_id,
        graph_version: graph.version,
        attempt: graph.attempt,
        publication_id: args[0],
        storage_key: `projects/${graph.project_id}/graphs/v/${graph.version}/attempts/${graph.attempt}/${args[0]}/graph.json`,
        status: "BUILDING",
        lease_id: args[2],
        lease_expires_at: args[3],
        claimed_by: args[4],
        claimed_at: args[5],
        checksum: null,
        byte_size: null,
        content_type: null,
        node_count: null,
        link_count: null,
        hyperedge_count: null,
        generated_by: null,
        published_at: null,
      };
      this.attempts.push(attempt);
      Object.assign(graph, {
        status: "BUILDING",
        lease_id: args[2],
        lease_expires_at: args[3],
        build_started_at: args[5],
        updated_at: args[5],
      });
      return attempt;
    }
    if (this.has(sql, "UPDATE graph_build_attempts SET cleanup_claim_id=?")) {
      const item = this.attempts.find(
        (candidate) =>
          candidate.project_id === args[2] &&
          candidate.graph_version === args[3] &&
          candidate.attempt === args[4] &&
          candidate.status === "FAILED" &&
          candidate.cleanup_not_before <= args[5] &&
          (!candidate.cleanup_claim_id || candidate.cleanup_claim_expires_at <= args[6]) &&
          candidate.checksum &&
          candidate.byte_size &&
          candidate.content_type === "application/json",
      );
      if (!item) return null;
      Object.assign(item, { cleanup_claim_id: args[0], cleanup_claim_expires_at: args[1] });
      if (this.orphanUpdateFailure) throw new Error("D1 unavailable");
      return item;
    }
    if (
      this.has(sql, "SELECT version FROM graph_versions WHERE project_id=?") &&
      this.has(sql, "selected_publication_id=?")
    ) {
      return (
        this.graphs.find(
          (candidate) =>
            candidate.project_id === args[0] &&
            (candidate.storage_key === args[1] || candidate.selected_publication_id === args[2]),
        ) ?? null
      );
    }
    if (
      this.has(sql, "SELECT * FROM graph_build_attempts WHERE project_id=?") &&
      this.has(sql, "AND lease_id=? AND publication_id=? AND storage_key=?")
    ) {
      return (
        this.attempts.find(
          (candidate) =>
            candidate.project_id === args[0] &&
            candidate.graph_version === args[1] &&
            candidate.attempt === args[2] &&
            candidate.lease_id === args[3] &&
            candidate.publication_id === args[4] &&
            candidate.storage_key === args[5],
        ) ?? null
      );
    }
    if (
      this.has(sql, "SELECT * FROM graph_build_attempts WHERE project_id=?") &&
      this.has(sql, "status='PUBLISHED'")
    ) {
      return (
        this.attempts.find(
          (candidate) =>
            candidate.project_id === args[0] &&
            candidate.graph_version === args[1] &&
            candidate.attempt === args[2] &&
            candidate.status === "PUBLISHED" &&
            candidate.lease_id === args[3] &&
            candidate.publication_id === args[4] &&
            candidate.storage_key === args[5] &&
            candidate.checksum === args[6] &&
            candidate.byte_size === args[7] &&
            candidate.node_count === args[8] &&
            candidate.link_count === args[9] &&
            candidate.hyperedge_count === args[10] &&
            candidate.generated_by === args[11],
        ) ?? null
      );
    }
    if (this.has(sql, "SELECT gba.* FROM graph_build_attempts gba")) {
      const candidate = this.attempts.find(
        (item) =>
          item.project_id === args[0] &&
          item.graph_version === args[1] &&
          item.attempt === args[2] &&
          item.status === "FAILED" &&
          item.cleanup_claim_id === args[3] &&
          item.cleanup_claim_expires_at > args[4],
      );
      if (!candidate) return null;
      return this.graphs.some(
        (graph) =>
          graph.project_id === candidate.project_id &&
          (graph.storage_key === candidate.storage_key ||
            graph.selected_publication_id === candidate.publication_id),
      )
        ? null
        : candidate;
    }
    if (
      this.has(sql, "UPDATE graph_build_attempts SET cleanup_claim_id=NULL") &&
      !this.has(sql, "cleanup_result='DELETED'")
    ) {
      const item = this.attempts.find(
        (candidate) =>
          candidate.project_id === args[0] &&
          candidate.graph_version === args[1] &&
          candidate.attempt === args[2] &&
          candidate.status === "FAILED" &&
          candidate.cleanup_claim_id === args[3],
      );
      if (!item) return null;
      item.cleanup_claim_id = null;
      item.cleanup_claim_expires_at = null;
      return { graph_version: item.graph_version };
    }
    if (this.has(sql, "UPDATE graph_build_attempts SET cleanup_claim_id=NULL")) {
      this.beforeCleanupReconcile?.();
      this.beforeCleanupReconcile = null;
      const item = this.attempts.find(
        (candidate) =>
          candidate.project_id === args[1] &&
          candidate.graph_version === args[2] &&
          candidate.attempt === args[3] &&
          candidate.status === "FAILED" &&
          candidate.cleanup_claim_id === args[4],
      );
      if (!item) return null;
      Object.assign(item, {
        cleanup_claim_id: null,
        cleanup_claim_expires_at: null,
        cleanup_result: "DELETED",
        cleanup_not_before: args[0],
      });
      return { graph_version: item.graph_version };
    }
    if (this.has(sql, "UPDATE graph_build_attempts SET status='FAILED'")) {
      const expired = this.has(sql, "failure_category='LEASE_EXPIRED'");
      const projectIndex = expired ? 3 : 4;
      const versionIndex = expired ? 4 : 5;
      const item = this.attempts.find(
        (candidate) =>
          candidate.project_id === args[projectIndex] &&
          candidate.graph_version === args[versionIndex] &&
          candidate.status === "BUILDING" &&
          (expired
            ? candidate.lease_expires_at <= args[5]
            : candidate.attempt === args[6] &&
              candidate.lease_id === args[7] &&
              candidate.publication_id === args[8] &&
              candidate.storage_key === args[9] &&
              candidate.lease_expires_at > args[10]),
      );
      if (!item) return null;
      const failure = expired ? "LEASE_EXPIRED" : args[0];
      Object.assign(item, {
        status: "FAILED",
        failure_category: failure,
        failed_at: expired ? args[0] : args[1],
        orphan_observed_at: expired ? args[1] : args[2],
        cleanup_not_before: expired ? args[2] : args[3],
      });
      const graph = this.graphs.find(
        (candidate) =>
          candidate.project_id === item.project_id && candidate.version === item.graph_version,
      );
      if (graph)
        Object.assign(graph, {
          status: "FAILED",
          lease_id: null,
          lease_expires_at: null,
          failure_category: failure,
          failed_at: item.failed_at,
          updated_at: item.failed_at,
        });
      return { graph_version: item.graph_version };
    }
    if (this.has(sql, "UPDATE graph_build_attempts SET checksum=?")) {
      const item = this.attempts.find(
        (candidate) =>
          candidate.project_id === args[5] &&
          candidate.graph_version === args[6] &&
          candidate.attempt === args[7] &&
          candidate.status === "BUILDING" &&
          candidate.lease_id === args[8] &&
          candidate.publication_id === args[9] &&
          candidate.storage_key === args[10] &&
          candidate.lease_expires_at > args[11],
      );
      if (!item) return null;
      Object.assign(item, {
        checksum: args[0],
        byte_size: args[1],
        content_type: "application/json",
        node_count: args[2],
        link_count: args[3],
        hyperedge_count: args[4],
        generated_by: item.claimed_by,
      });
      return { graph_version: item.graph_version };
    }
    if (this.has(sql, "UPDATE graph_build_attempts SET status='PUBLISHED'")) {
      if (this.readyUpdateFailure === "before-commit") throw new Error("D1 unavailable");
      const item = this.attempts.find(
        (candidate) =>
          candidate.project_id === args[6] &&
          candidate.graph_version === args[7] &&
          candidate.attempt === args[8] &&
          candidate.status === "BUILDING" &&
          candidate.lease_id === args[9] &&
          candidate.publication_id === args[10] &&
          candidate.storage_key === args[11] &&
          candidate.lease_expires_at > args[12],
      );
      const graph =
        item &&
        this.graphs.find(
          (candidate) =>
            candidate.project_id === item.project_id && candidate.version === item.graph_version,
        );
      if (
        !item ||
        !graph ||
        this.graphs.some(
          (candidate) =>
            candidate.project_id === graph.project_id &&
            candidate.status === "READY" &&
            candidate.version > graph.version,
        )
      )
        return null;
      for (const old of this.graphs)
        if (
          old.project_id === graph.project_id &&
          old.status === "READY" &&
          old.version < graph.version
        )
          Object.assign(old, { status: "SUPERSEDED", superseded_at: args[5], updated_at: args[5] });
      Object.assign(item, {
        status: "PUBLISHED",
        checksum: args[0],
        byte_size: args[1],
        content_type: "application/json",
        node_count: args[2],
        link_count: args[3],
        hyperedge_count: args[4],
        generated_by: item.claimed_by,
        published_at: args[5],
      });
      Object.assign(graph, {
        status: "READY",
        lease_id: null,
        lease_expires_at: null,
        storage_layout: "ATTEMPT_V2",
        storage_key: item.storage_key,
        selected_publication_id: item.publication_id,
        checksum: args[0],
        byte_size: args[1],
        node_count: args[2],
        link_count: args[3],
        hyperedge_count: args[4],
        generated_by: item.claimed_by,
        published_attempt: item.attempt,
        published_lease_id: item.lease_id,
        generated_at: args[5],
        updated_at: args[5],
      });
      if (this.readyUpdateFailure === "after-commit") throw new Error("lost D1 acknowledgement");
      return item;
    }
    if (this.has(sql, "UPDATE graph_versions SET status = 'BUILDING'")) {
      const row = this.graphs.find(
        (item) =>
          item.project_id === args[4] && item.version === args[5] && item.status === "QUEUED",
      );
      if (!row) return null;
      Object.assign(row, {
        status: "BUILDING",
        lease_id: args[0],
        lease_expires_at: args[1],
        build_started_at: args[2],
        updated_at: args[3],
      });
      return { attempt: row.attempt };
    }
    if (this.has(sql, "failure_category = 'LEASE_EXPIRED'")) {
      const row = this.graphs.find(
        (item) =>
          item.project_id === args[2] &&
          item.version === args[3] &&
          item.status === "BUILDING" &&
          item.lease_expires_at <= args[4],
      );
      if (!row) return null;
      Object.assign(row, {
        status: "FAILED",
        lease_id: null,
        lease_expires_at: null,
        failure_category: "LEASE_EXPIRED",
        failed_at: args[0],
        updated_at: args[1],
      });
      return { version: row.version };
    }
    if (this.has(sql, "UPDATE graph_versions SET status = 'FAILED'")) {
      const row = this.graphs.find(
        (item) =>
          item.project_id === args[3] &&
          item.version === args[4] &&
          item.status === "BUILDING" &&
          item.attempt === args[5] &&
          item.lease_id === args[6] &&
          item.lease_expires_at > args[7],
      );
      if (!row) return null;
      Object.assign(row, {
        status: "FAILED",
        lease_id: null,
        lease_expires_at: null,
        failure_category: args[0],
        failed_at: args[1],
        updated_at: args[2],
      });
      return { version: row.version };
    }
    if (this.has(sql, "UPDATE graph_versions SET status = 'READY'")) {
      if (this.readyUpdateFailure === "before-commit") throw new Error("D1 unavailable");
      const row = this.graphs.find(
        (item) =>
          item.project_id === args[11] &&
          item.version === args[12] &&
          item.status === "BUILDING" &&
          item.attempt === args[13] &&
          item.lease_id === args[14] &&
          item.lease_expires_at > args[15],
      );
      if (
        !row ||
        this.graphs.some(
          (item) =>
            item.project_id === row.project_id &&
            item.status === "READY" &&
            item.version > row.version,
        )
      )
        return null;
      for (const old of this.graphs)
        if (
          old.project_id === row.project_id &&
          old.status === "READY" &&
          old.version < row.version
        )
          Object.assign(old, {
            status: "SUPERSEDED",
            superseded_at: args[9],
            updated_at: args[10],
          });
      Object.assign(row, {
        status: "READY",
        lease_id: null,
        lease_expires_at: null,
        storage_key: args[0],
        checksum: args[1],
        byte_size: args[2],
        node_count: args[3],
        link_count: args[4],
        hyperedge_count: args[5],
        generated_by: args[6],
        published_attempt: args[7],
        published_lease_id: args[8],
        generated_at: args[9],
        updated_at: args[10],
      });
      if (this.readyUpdateFailure === "after-commit") throw new Error("lost D1 acknowledgement");
      return row;
    }
    if (this.has(sql, "SELECT storage_key FROM graph_versions")) {
      return (
        this.graphs.find(
          (row) =>
            row.project_id === args[0] &&
            row.version === args[1] &&
            ["READY", "SUPERSEDED"].includes(row.status) &&
            row.storage_key === args[2] &&
            row.checksum === args[3],
        ) ?? null
      );
    }
    if (this.has(sql, "SELECT * FROM graph_versions WHERE project_id = ? AND version = ?")) {
      return (
        this.graphs.find((row) => row.project_id === args[0] && row.version === args[1]) ?? null
      );
    }
    if (this.has(sql, "status = 'READY' ORDER BY version DESC LIMIT 1")) {
      return (
        this.graphs
          .filter((row) => row.project_id === args[0] && row.status === "READY")
          .sort((a, b) => b.version - a.version)[0] ?? null
      );
    }
    throw new Error(`Unhandled first SQL: ${sql}`);
  }

  all(sql: string, args: any[]) {
    if (this.has(sql, "FROM graph_versions") && this.has(sql, "ORDER BY version DESC LIMIT 51"))
      return this.graphs
        .filter((row) => row.project_id === args[0])
        .sort((a, b) => b.version - a.version)
        .slice(0, 51);
    throw new Error(`Unhandled all SQL: ${sql}`);
  }
}

class RouterD1 extends GraphD1 {
  override first(sql: string, args: any[]): Row | null {
    if (sql.replace(/\s+/g, " ").includes("FROM sessions s JOIN users u")) {
      return {
        id: "viewer",
        session_id: "session",
        username: "viewer",
        display_name: null,
        avatar_url: null,
      };
    }
    return super.first(sql, args);
  }
}

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; metadata: ObjectStorageMetadata }>();
  deleted: string[] = [];
  collide = false;
  writeThenThrow: "valid" | "malformed" | null = null;
  headFailure = false;
  deleteThenThrow = false;
  afterHead: (() => void) | null = null;
  async createOnly(key: string, bytes: Uint8Array<ArrayBuffer>, metadata: ObjectStorageMetadata) {
    if (this.collide || this.objects.has(key)) return "collision" as const;
    const storedMetadata =
      this.writeThenThrow === "malformed" ? { ...metadata, contentType: "text/plain" } : metadata;
    this.objects.set(key, { bytes, metadata: storedMetadata });
    if (this.writeThenThrow) throw new Error("lost write acknowledgement");
    return "created" as const;
  }
  async head(key: string): Promise<StoredObjectMetadata | null> {
    if (this.headFailure) throw new Error("R2 head unavailable");
    const object = this.objects.get(key);
    const result = object
      ? {
          byteSize: object.bytes.byteLength,
          httpContentType: object.metadata.contentType,
          metadata: object.metadata,
        }
      : null;
    const afterHead = this.afterHead;
    this.afterHead = null;
    afterHead?.();
    return result;
  }
  async getBytes(key: string) {
    return this.objects.get(key)?.bytes ?? null;
  }
  async compensationDelete(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
    if (this.deleteThenThrow) throw new Error("lost delete acknowledgement");
  }
}

function graphRow(overrides: Row = {}): Row {
  return {
    id: "g",
    project_id: "p",
    version: 1,
    repository_provider: "github",
    provider_repository_id: "repo-1",
    repository_owner: "owner",
    repository_name: "repo",
    repository_canonical_url: "github.com/owner/repo",
    source_commit_sha: "a".repeat(40),
    graphify_version: GRAPH_BUILD_IDENTITY.graphifyVersion,
    adapter_version: GRAPH_BUILD_IDENTITY.adapterVersion,
    profile: GRAPH_BUILD_IDENTITY.profile,
    format_version: GRAPH_BUILD_IDENTITY.formatVersion,
    generator: GRAPH_BUILD_IDENTITY.generator,
    status: "QUEUED",
    attempt: 1,
    storage_layout: "ATTEMPT_V2",
    selected_publication_id: null,
    lease_id: null,
    lease_expires_at: null,
    failure_category: null,
    storage_key: null,
    checksum: null,
    byte_size: null,
    node_count: null,
    link_count: null,
    hyperedge_count: null,
    generated_by: null,
    published_attempt: null,
    published_lease_id: null,
    queued_at: "2026-01-01T00:00:00.000Z",
    build_started_at: null,
    failed_at: null,
    generated_at: null,
    superseded_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    orphan_observed_at: null,
    orphan_attempt: null,
    orphan_lease_id: null,
    orphan_checksum: null,
    orphan_byte_size: null,
    orphan_cleanup_id: null,
    orphan_cleanup_expires_at: null,
    ...overrides,
  };
}

function request(path: string, method = "GET", body?: object, origin = "https://web.example") {
  return new Request(`https://api.example${path}`, {
    method,
    headers: { origin, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function standardGraph(row: Row): Row {
  return {
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [
      { id: "a", label: "Alpha", file_type: "ts", source_file: "src/a.ts", source_location: "L1" },
      { id: "b", label: "Beta", file_type: "ts", source_file: "src/b.ts", source_location: "L2" },
    ],
    links: [
      {
        source: "a",
        target: "b",
        relation: "CALLS",
        confidence: "EXTRACTED",
        confidence_score: 1,
        weight: 1,
        source_file: "src/a.ts",
        source_location: "L1",
      },
    ],
    hyperedges: [],
    built_at_commit: row.source_commit_sha,
  };
}

async function buildResult(row: Row, graph: Row = standardGraph(row)): Promise<GraphBuildResult> {
  const bytes = new TextEncoder().encode(JSON.stringify(graph));
  return {
    bytes,
    checksum: await sha256Bytes(bytes),
    byteSize: bytes.byteLength,
    nodeCount: graph.nodes.length,
    linkCount: graph.links.length,
    hyperedgeCount: graph.hyperedges.length,
    generator: row.generator,
    projectId: row.project_id,
    repositoryProvider: row.repository_provider,
    providerRepositoryId: row.provider_repository_id,
    repositoryOwner: row.repository_owner,
    repositoryName: row.repository_name,
    repositoryCanonicalUrl: row.repository_canonical_url,
    sourceCommitSha: row.source_commit_sha,
    graphifyVersion: row.graphify_version,
    adapterVersion: row.adapter_version,
    profile: row.profile,
    formatVersion: row.format_version,
  };
}

let db: GraphD1;
let storage: MemoryStorage;
const env = () => ({ DB: db as unknown as D1Database, WEB_ORIGIN: "https://web.example" });

beforeEach(() => {
  db = new GraphD1();
  storage = new MemoryStorage();
  db.memberships.push(
    { project_id: "p", user_id: "admin", role: "ADMIN" },
    { project_id: "p", user_id: "viewer", role: "VIEWER" },
  );
  db.connection = {
    project_id: "p",
    provider: "github",
    provider_repository_id: "repo-1",
    owner: "owner",
    repository_name: "repo",
    canonical_url: "github.com/owner/repo",
    last_known_commit_sha: "a".repeat(40),
    status: "VERIFIED",
  };
});

describe("graph reservation and lifecycle", () => {
  it("requires direct ADMIN membership and exact Origin, then deduplicates complete identity", async () => {
    assert.equal(
      (
        await handleGraphRoute(
          request("/projects/p/graphs/build", "POST"),
          env(),
          storage,
          { id: "viewer" },
          "p",
          "build",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handleGraphRoute(
          request("/projects/p/graphs/build", "POST", undefined, "https://evil.example"),
          env(),
          storage,
          { id: "admin" },
          "p",
          "build",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handleGraphRoute(
          request("/projects/p/graphs"),
          env(),
          storage,
          { id: "outsider" },
          "p",
        )
      ).status,
      404,
    );
    const first = await handleGraphRoute(
      request("/projects/p/graphs/build", "POST"),
      env(),
      storage,
      { id: "admin" },
      "p",
      "build",
    );
    assert.equal(first.status, 202);
    assert.equal(((await first.json()) as any).dispatch, "MANUAL_ACTIONS_DISPATCH_REQUIRED");
    const duplicate = await handleGraphRoute(
      request("/projects/p/graphs/build", "POST"),
      env(),
      storage,
      { id: "admin" },
      "p",
      "build",
    );
    assert.equal(duplicate.status, 202);
    assert.equal(db.graphs.length, 1);
  });

  it("treats every complete build-identity dimension as distinct and only deduplicates the exact tuple", async () => {
    const changedDimensions: Array<[string, Row]> = [
      ["project", { project_id: "other" }],
      ["repository provider", { repository_provider: "gitlab" }],
      ["provider repository ID", { provider_repository_id: "repo-2" }],
      ["repository owner", { repository_owner: "other-owner" }],
      ["repository name", { repository_name: "other-repo" }],
      ["canonical URL", { repository_canonical_url: "github.com/owner/other-repo" }],
      ["source commit", { source_commit_sha: "b".repeat(40) }],
      ["Graphify version", { graphify_version: "0.9.59" }],
      ["adapter version", { adapter_version: "2.0.0" }],
      ["profile", { profile: "other-profile" }],
      ["format version", { format_version: 2 }],
    ];

    for (const [dimension, override] of changedDimensions) {
      db.graphs = [graphRow(override)];
      const response = await handleGraphRoute(
        request("/projects/p/graphs/build", "POST"),
        env(),
        storage,
        { id: "admin" },
        "p",
        "build",
      );
      assert.equal(response.status, 202, dimension);
      assert.equal(db.graphs.length, 2, dimension);
      const reserved = db.graphs.find((row) => row.id !== "g");
      assert.equal(reserved?.version, dimension === "project" ? 1 : 2, dimension);
    }

    db.graphs = [graphRow()];
    const duplicate = await handleGraphRoute(
      request("/projects/p/graphs/build", "POST"),
      env(),
      storage,
      { id: "admin" },
      "p",
      "build",
    );
    assert.equal(duplicate.status, 202);
    assert.equal(db.graphs.length, 1);
  });

  it("claims with a fenced lease, rejects stale failure, and retries FAILED on the same version", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    assert.equal(db.graphs[0]?.status, "BUILDING");
    await assert.rejects(
      failGraphBuild(env(), { ...claim, leaseId: "x".repeat(43) }, "TOOL_FAILED"),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STALE_LEASE",
    );
    await failGraphBuild(env(), claim, "TOOL_FAILED");
    const retried = await handleGraphRoute(
      request("/projects/p/graphs/build", "POST"),
      env(),
      storage,
      { id: "admin" },
      "p",
      "build",
    );
    assert.equal(retried.status, 202);
    assert.equal(db.graphs[0]?.version, 1);
    assert.equal(db.graphs[0]?.attempt, 2);
  });

  it("expires a lease to FAILED and rejects its late completion", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    const building = db.graphs[0];
    assert.ok(building);
    building.lease_expires_at = "2000-01-01T00:00:00.000Z";
    const attempt = db.attempts[0];
    assert.ok(attempt);
    attempt.lease_expires_at = building.lease_expires_at;
    assert.equal(await expireGraphBuild(env(), "p", 1), true);
    assert.equal(db.graphs[0]?.failure_category, "LEASE_EXPIRED");
    await assert.rejects(
      publishGraphBuild(env(), storage, claim, result),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STALE_LEASE",
    );
  });

  it("rejects an immutable-key collision without publishing metadata", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    storage.collide = true;
    await assert.rejects(
      publishGraphBuild(env(), storage, claim, result),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STORAGE_COLLISION",
    );
    assert.equal(db.graphs[0]?.status, "BUILDING");
  });

  it("publishes immutable object-first metadata, supports exact replay, and preserves old READY until success", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    const published = await publishGraphBuild(env(), storage, claim, result);
    assert.equal(published.status, "READY");
    assert.equal(storage.objects.size, 1);
    assert.equal((await publishGraphBuild(env(), storage, claim, result)).status, "READY");
    const stale: GraphClaim = { ...claim, leaseId: "z".repeat(43) };
    await assert.rejects(
      publishGraphBuild(env(), storage, stale, result),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STALE_LEASE",
    );
  });

  it("derives publisher provenance from the immutable claim instead of caller data", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1, "machine-principal-1");
    const result = Object.assign(await buildResult(db.graphs[0] as Row), {
      generatedBy: "forged-principal",
    });

    const published = await publishGraphBuild(env(), storage, claim, result);

    assert.equal(published.generated_by, "machine-principal-1");
    assert.equal(db.attempts[0]?.claimed_by, "machine-principal-1");
    assert.equal(db.attempts[0]?.generated_by, "machine-principal-1");
  });

  it("validates exact READY replay bytes and immutable claim provenance", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    await publishGraphBuild(env(), storage, claim, result);

    const tampered = { ...result, bytes: result.bytes.slice() };
    tampered.bytes[0] = (tampered.bytes[0] ?? 0) ^ 1;
    await assert.rejects(
      publishGraphBuild(env(), storage, claim, tampered),
      (error: unknown) => error instanceof GraphConflictError && error.code === "INTEGRITY_ERROR",
    );

    const attempt = db.attempts[0];
    assert.ok(attempt);
    db.attempts = [];
    await assert.rejects(
      publishGraphBuild(env(), storage, claim, result),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STALE_LEASE",
    );
    db.attempts = [{ ...attempt, generated_by: "different-runner" }];
    await assert.rejects(
      publishGraphBuild(env(), storage, claim, result),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STALE_LEASE",
    );
    db.attempts = [attempt];
    const graph = db.graphs[0];
    assert.ok(graph);
    graph.generated_by = "different-runner";
    await assert.rejects(
      publishGraphBuild(env(), storage, claim, result),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STALE_LEASE",
    );
  });

  it("recovers a lost write acknowledgement only with exact object metadata", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    storage.writeThenThrow = "valid";
    assert.equal((await publishGraphBuild(env(), storage, claim, result)).status, "READY");

    db.graphs.push(graphRow({ id: "g2", version: 2, source_commit_sha: "b".repeat(40) }));
    const secondClaim = await claimGraphBuild(env(), "p", 2);
    const second = await buildResult(db.graphs[1] as Row);
    storage.writeThenThrow = "malformed";
    await assert.rejects(
      publishGraphBuild(env(), storage, secondClaim, second),
      /lost write acknowledgement/,
    );
    assert.equal(db.graphs[1]?.status, "BUILDING");
    assert.equal(storage.deleted.length, 0);
  });

  it("uses a fresh terminal timestamp when the lease expires during object verification", async () => {
    db.graphs.push(graphRow({ id: "g1", version: 1 }));
    const firstClaim = await claimGraphBuild(env(), "p", 1);
    const first = await buildResult(db.graphs[0] as Row);
    await publishGraphBuild(env(), storage, firstClaim, first);

    db.graphs.push(graphRow({ id: "g2", version: 2, source_commit_sha: "b".repeat(40) }));
    const secondClaim = await claimGraphBuild(env(), "p", 2);
    const second = await buildResult(db.graphs[1] as Row);
    storage.afterHead = () => {
      const expired = "2000-01-01T00:00:00.000Z";
      const graph = db.graphs[1];
      const attempt = db.attempts[1];
      assert.ok(graph && attempt);
      graph.lease_expires_at = expired;
      attempt.lease_expires_at = expired;
    };
    await assert.rejects(
      publishGraphBuild(env(), storage, secondClaim, second),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STALE_LEASE",
    );
    assert.equal(db.graphs[0]?.status, "READY");
    assert.equal(db.graphs[1]?.status, "BUILDING");
    assert.notEqual(db.attempts[1]?.status, "PUBLISHED");
  });

  it("retains an orphan and the prior READY graph when D1 fails before promotion commits", async () => {
    db.graphs.push(graphRow({ id: "g1", version: 1 }));
    const firstClaim = await claimGraphBuild(env(), "p", 1);
    const first = await buildResult(db.graphs[0] as Row);
    await publishGraphBuild(env(), storage, firstClaim, first);

    db.graphs.push(graphRow({ id: "g2", version: 2, source_commit_sha: "b".repeat(40) }));
    const secondClaim = await claimGraphBuild(env(), "p", 2);
    const second = await buildResult(db.graphs[1] as Row);
    db.readyUpdateFailure = "before-commit";
    await assert.rejects(publishGraphBuild(env(), storage, secondClaim, second), /D1 unavailable/);

    assert.equal(db.graphs[0]?.status, "READY");
    assert.equal(db.graphs[1]?.status, "BUILDING");
    assert.ok(storage.objects.has(secondClaim.storageKey));
    assert.equal(storage.deleted.length, 0);
  });

  it("allocates a distinct publication identity and key for every retry", async () => {
    db.graphs.push(graphRow());
    const first = await claimGraphBuild(env(), "p", 1, "runner-1");
    await failGraphBuild(env(), first, "TOOL_FAILED");
    const retry = await handleGraphRoute(
      request("/projects/p/graphs/build", "POST"),
      env(),
      storage,
      { id: "admin" },
      "p",
      "build",
    );
    assert.equal(retry.status, 202);
    const second = await claimGraphBuild(env(), "p", 1, "runner-2");
    assert.notEqual(second.publicationId, first.publicationId);
    assert.notEqual(second.storageKey, first.storageKey);
    assert.match(second.storageKey, /\/attempts\/2\//);
  });

  it("does not let a corrupt old-attempt object block retry", async () => {
    db.graphs.push(graphRow());
    const first = await claimGraphBuild(env(), "p", 1);
    storage.objects.set(first.storageKey, {
      bytes: new TextEncoder().encode("corrupt"),
      metadata: { contentType: "text/plain", checksum: "bad", uploadId: first.publicationId },
    });
    await failGraphBuild(env(), first, "INVALID_OUTPUT");
    assert.equal(
      (
        await handleGraphRoute(
          request("/projects/p/graphs/build", "POST"),
          env(),
          storage,
          { id: "admin" },
          "p",
          "build",
        )
      ).status,
      202,
    );
    const second = await claimGraphBuild(env(), "p", 1);
    assert.notEqual(second.storageKey, first.storageKey);
    assert.ok(storage.objects.has(first.storageKey));
  });

  it("retries immediately while the old attempt has an active cleanup claim", async () => {
    db.graphs.push(graphRow());
    const first = await claimGraphBuild(env(), "p", 1, "old-cleaner-runner");
    await failGraphBuild(env(), first, "TOOL_FAILED");
    const oldAttempt = db.attempts[0];
    assert.ok(oldAttempt);
    oldAttempt.cleanup_claim_id = "c".repeat(43);
    oldAttempt.cleanup_claim_expires_at = "2099-01-01T00:00:00.000Z";

    const retry = await handleGraphRoute(
      request("/projects/p/graphs/build", "POST"),
      env(),
      storage,
      { id: "admin" },
      "p",
      "build",
    );
    assert.equal(retry.status, 202);
    const second = await claimGraphBuild(env(), "p", 1, "new-attempt-runner");
    assert.notEqual(second.storageKey, first.storageKey);
    assert.equal(oldAttempt.cleanup_claim_id, "c".repeat(43));
    assert.equal(db.graphs[0]?.status, "BUILDING");
  });

  it("lets an old cleaner coexist without deleting the current attempt key", async () => {
    db.graphs.push(graphRow());
    const first = await claimGraphBuild(env(), "p", 1, "old-runner");
    const result = await buildResult(db.graphs[0] as Row);
    storage.objects.set(first.storageKey, {
      bytes: result.bytes,
      metadata: {
        contentType: "application/json",
        checksum: result.checksum,
        uploadId: first.publicationId,
      },
    });
    await failGraphBuild(env(), first, "TOOL_FAILED");
    const oldAttempt = db.attempts[0];
    assert.ok(oldAttempt);
    Object.assign(oldAttempt, {
      checksum: result.checksum,
      byte_size: result.byteSize,
      content_type: "application/json",
      cleanup_not_before: "2000-01-01",
    });
    await handleGraphRoute(
      request("/projects/p/graphs/build", "POST"),
      env(),
      storage,
      { id: "admin" },
      "p",
      "build",
    );
    const second = await claimGraphBuild(env(), "p", 1, "new-runner");
    storage.objects.set(second.storageKey, {
      bytes: result.bytes,
      metadata: {
        contentType: "application/json",
        checksum: result.checksum,
        uploadId: second.publicationId,
      },
    });

    assert.equal(await cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), true);
    assert.deepEqual(storage.deleted, [first.storageKey]);
    assert.ok(storage.objects.has(second.storageKey));
    assert.equal(db.graphs[0]?.status, "BUILDING");
  });

  it("cleans only an exact unreferenced failed attempt after grace", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    storage.objects.set(claim.storageKey, {
      bytes: result.bytes,
      metadata: {
        contentType: "application/json",
        checksum: result.checksum,
        uploadId: claim.publicationId,
      },
    });
    await failGraphBuild(env(), claim, "TOOL_FAILED");
    const attempt = db.attempts[0];
    assert.ok(attempt);
    Object.assign(attempt, {
      checksum: result.checksum,
      byte_size: result.byteSize,
      content_type: "application/json",
      cleanup_not_before: "2000-01-01T00:00:00.000Z",
      cleanup_claim_id: "active-cleaner",
      cleanup_claim_expires_at: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(await cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), false);
    assert.ok(storage.objects.has(claim.storageKey));
    attempt.cleanup_claim_expires_at = "2000-01-01T00:00:00.000Z";
    assert.equal(await cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), true);
    assert.deepEqual(storage.deleted, [claim.storageKey]);
    assert.equal(attempt.status, "FAILED");
    assert.equal(attempt.cleanup_result, "DELETED");
  });

  it("re-reconciles an exact key recreated after delete but before the D1 update", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    const object = {
      bytes: result.bytes,
      metadata: {
        contentType: "application/json" as const,
        checksum: result.checksum,
        uploadId: claim.publicationId,
      },
    };
    storage.objects.set(claim.storageKey, object);
    await failGraphBuild(env(), claim, "TOOL_FAILED");
    const attempt = db.attempts[0];
    assert.ok(attempt);
    Object.assign(attempt, {
      checksum: result.checksum,
      byte_size: result.byteSize,
      content_type: "application/json",
      node_count: result.nodeCount,
      link_count: result.linkCount,
      hyperedge_count: 0,
      generated_by: "internal-runner",
      cleanup_not_before: "2000-01-01",
    });
    db.beforeCleanupReconcile = () => storage.objects.set(claim.storageKey, object);
    assert.equal(await cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), true);
    assert.equal(attempt.status, "FAILED");
    assert.ok(storage.objects.has(claim.storageKey));

    attempt.cleanup_not_before = "2000-01-01";
    assert.equal(await cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), true);
    assert.equal(storage.objects.has(claim.storageKey), false);
    assert.equal(attempt.status, "FAILED");
  });

  it("releases exact cleanup ownership for absent or mismatched HEAD evidence", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    await failGraphBuild(env(), claim, "TOOL_FAILED");
    const attempt = db.attempts[0];
    assert.ok(attempt);
    Object.assign(attempt, {
      checksum: result.checksum,
      byte_size: result.byteSize,
      content_type: "application/json",
      cleanup_not_before: "2000-01-01",
    });

    assert.equal(await cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), false);
    assert.equal(attempt.cleanup_claim_id, null);

    storage.objects.set(claim.storageKey, {
      bytes: result.bytes,
      metadata: {
        contentType: "text/plain",
        checksum: result.checksum,
        uploadId: claim.publicationId,
      },
    });
    assert.equal(await cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), false);
    assert.equal(attempt.cleanup_claim_id, null);
    assert.ok(storage.objects.has(claim.storageKey));
  });

  it("rechecks references after HEAD and never deletes a newly selected key", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    storage.objects.set(claim.storageKey, {
      bytes: result.bytes,
      metadata: {
        contentType: "application/json",
        checksum: result.checksum,
        uploadId: claim.publicationId,
      },
    });
    await failGraphBuild(env(), claim, "TOOL_FAILED");
    const attempt = db.attempts[0];
    const graph = db.graphs[0];
    assert.ok(attempt && graph);
    Object.assign(attempt, {
      checksum: result.checksum,
      byte_size: result.byteSize,
      content_type: "application/json",
      cleanup_not_before: "2000-01-01",
    });
    storage.afterHead = () => {
      graph.storage_key = claim.storageKey;
      graph.selected_publication_id = claim.publicationId;
    };

    assert.equal(await cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), false);
    assert.deepEqual(storage.deleted, []);
    assert.ok(storage.objects.has(claim.storageKey));
    assert.equal(attempt.cleanup_claim_id, null);
  });

  it("retains failed-attempt bytes on reference, R2, or D1 uncertainty", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    storage.objects.set(claim.storageKey, {
      bytes: result.bytes,
      metadata: {
        contentType: "application/json",
        checksum: result.checksum,
        uploadId: claim.publicationId,
      },
    });
    await failGraphBuild(env(), claim, "TOOL_FAILED");
    const attempt = db.attempts[0];
    const graph = db.graphs[0];
    assert.ok(attempt && graph);
    Object.assign(attempt, {
      checksum: result.checksum,
      byte_size: result.byteSize,
      content_type: "application/json",
      cleanup_not_before: "2000-01-01",
    });
    graph.storage_key = claim.storageKey;
    assert.equal(await cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), false);
    assert.ok(storage.objects.has(claim.storageKey));
    assert.equal(attempt.cleanup_claim_id, null);
    graph.storage_key = null;
    attempt.cleanup_claim_expires_at = "2000-01-01";
    storage.headFailure = true;
    assert.equal(await cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), false);
    assert.ok(storage.objects.has(claim.storageKey));
    assert.equal(attempt.cleanup_claim_id, null);
    storage.headFailure = false;
    attempt.cleanup_claim_expires_at = "2000-01-01";
    db.orphanUpdateFailure = true;
    await assert.rejects(cleanupFailedGraphAttempt(env(), storage, "p", 1, 1), /D1 unavailable/);
    assert.ok(storage.objects.has(claim.storageKey));
    assert.equal(attempt.cleanup_claim_id, null);
  });

  it("atomically denies reserve after demotion and retry after removal", async () => {
    db.demoteBeforeGraphMutation = true;
    const denied = await handleGraphRoute(
      request("/projects/p/graphs/build", "POST"),
      env(),
      storage,
      { id: "admin" },
      "p",
      "build",
    );
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "FORBIDDEN" });
    assert.equal(db.graphs.length, 0);

    const admin = db.memberships.find((member) => member.user_id === "admin");
    assert.ok(admin);
    admin.role = "ADMIN";
    db.graphs.push(
      graphRow({ status: "FAILED", failure_category: "TOOL_FAILED", failed_at: "2026-01-01" }),
    );
    db.removeBeforeGraphMutation = true;
    const retry = await handleGraphRoute(
      request("/projects/p/graphs/build", "POST"),
      env(),
      storage,
      { id: "admin" },
      "p",
      "build",
    );
    assert.equal(retry.status, 404);
    assert.deepEqual(await retry.json(), { error: "NOT_FOUND" });
    assert.equal(db.graphs[0]?.status, "FAILED");
  });

  it("recovers an acknowledged-lost READY commit by exact replay without deleting bytes", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    db.readyUpdateFailure = "after-commit";
    const acknowledged = await publishGraphBuild(env(), storage, claim, result);
    assert.equal(acknowledged.status, "READY");
    assert.equal(db.graphs[0]?.status, "READY");

    db.readyUpdateFailure = null;
    const replay = await publishGraphBuild(env(), storage, claim, result);
    assert.equal(replay.status, "READY");
    assert.equal(storage.objects.size, 1);
    assert.equal(storage.deleted.length, 0);
  });

  it("keeps a higher READY graph when concurrent lower publication arrives late", async () => {
    db.graphs.push(
      graphRow({ id: "g1", version: 1 }),
      graphRow({ id: "g2", version: 2, source_commit_sha: "b".repeat(40) }),
    );
    const firstClaim = await claimGraphBuild(env(), "p", 1);
    const secondClaim = await claimGraphBuild(env(), "p", 2);
    const first = await buildResult(db.graphs[0] as Row);
    const second = await buildResult(db.graphs[1] as Row);
    assert.equal((await publishGraphBuild(env(), storage, secondClaim, second)).status, "READY");
    await assert.rejects(
      publishGraphBuild(env(), storage, firstClaim, first),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STALE_LEASE",
    );
    assert.equal(db.graphs[1]?.status, "READY");
    assert.equal(db.graphs[0]?.status, "BUILDING");
    assert.equal(storage.deleted.length, 0);
    assert.ok(storage.objects.has(secondClaim.storageKey));
  });

  it("accepts exact SUPERSEDED replay after a newer version becomes READY", async () => {
    db.graphs.push(graphRow({ id: "g1", version: 1 }));
    const firstClaim = await claimGraphBuild(env(), "p", 1);
    const first = await buildResult(db.graphs[0] as Row);
    await publishGraphBuild(env(), storage, firstClaim, first);
    db.graphs.push(graphRow({ id: "g2", version: 2, source_commit_sha: "b".repeat(40) }));
    const secondClaim = await claimGraphBuild(env(), "p", 2);
    const second = await buildResult(db.graphs[1] as Row);
    await publishGraphBuild(env(), storage, secondClaim, second);
    assert.equal(db.graphs[0]?.status, "SUPERSEDED");
    assert.equal((await publishGraphBuild(env(), storage, firstClaim, first)).status, "SUPERSEDED");
    const firstAttempt = db.attempts[0];
    assert.ok(firstAttempt);
    firstAttempt.claimed_by = "forged-principal";
    await assert.rejects(
      publishGraphBuild(env(), storage, firstClaim, first),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STALE_LEASE",
    );
  });

  it("never deletes a reused version key owned by a different attempt", async () => {
    const row = graphRow({
      status: "BUILDING",
      lease_id: "n".repeat(43),
      lease_expires_at: "2099-01-01T00:00:00.000Z",
      build_started_at: "2026-01-01T00:00:00.000Z",
      attempt: 2,
    });
    db.graphs.push(row);
    const publicationId = "q".repeat(43);
    const currentClaim: GraphClaim = {
      projectId: "p",
      version: 1,
      attempt: 2,
      leaseId: "n".repeat(43),
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      publicationId,
      storageKey: `projects/p/graphs/v/1/attempts/2/${publicationId}/graph.json`,
    };
    const result = await buildResult(row);
    const key = "projects/p/graphs/v/1/graph.json";
    storage.objects.set(key, {
      bytes: result.bytes,
      metadata: {
        contentType: "application/json",
        checksum: result.checksum,
        uploadId: `2.${"n".repeat(43)}`,
      },
    });
    const staleClaim = { ...currentClaim, attempt: 1, leaseId: "o".repeat(43) };
    await assert.rejects(
      publishGraphBuild(env(), storage, staleClaim, result),
      (error: unknown) => error instanceof GraphConflictError && error.code === "STALE_LEASE",
    );
    assert.ok(storage.objects.has(key));
    assert.equal(storage.deleted.length, 0);
  });
});

describe("graph router", () => {
  it("covers authentication, membership isolation, and public list/latest/detail/search success", async () => {
    const routerDb = new RouterD1();
    routerDb.memberships.push({ project_id: "p", user_id: "viewer", role: "VIEWER" });
    const routerStorage = new MemoryStorage();
    routerDb.graphs.push(graphRow());
    const routerEnv = { DB: routerDb as unknown as D1Database, WEB_ORIGIN: "https://web.example" };
    const claim = await claimGraphBuild(routerEnv, "p", 1, "runner-1");
    const result = await buildResult(routerDb.graphs[0] as Row);
    await publishGraphBuild(routerEnv, routerStorage, claim, result);
    const bucket = {
      head: async (key: string) => {
        const object = routerStorage.objects.get(key);
        return object
          ? {
              size: object.bytes.byteLength,
              httpMetadata: { contentType: object.metadata.contentType },
              customMetadata: object.metadata,
            }
          : null;
      },
      get: async (key: string) => {
        const object = routerStorage.objects.get(key);
        return object
          ? {
              arrayBuffer: async () =>
                object.bytes.buffer.slice(
                  object.bytes.byteOffset,
                  object.bytes.byteOffset + object.bytes.byteLength,
                ),
            }
          : null;
      },
    } as unknown as R2Bucket;
    const bindings = {
      DB: routerDb as unknown as D1Database,
      OBJECTS: bucket,
      WEB_ORIGIN: "https://web.example",
      API_ORIGIN: "https://api.example",
    } as Env;
    const router = createApp();
    assert.equal((await router.fetch(request("/projects/p/graphs"), bindings)).status, 401);
    const authenticated = (path: string, method = "GET", body?: object) => {
      const routed = request(path, method, body);
      routed.headers.set("cookie", "context_hub_session=token");
      return routed;
    };
    assert.equal(
      (await router.fetch(authenticated("/projects/other/graphs"), bindings)).status,
      404,
    );
    const list = await router.fetch(authenticated("/projects/p/graphs"), bindings);
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as any;
    assert.equal(listBody.graphs.length, 1);
    assert.equal(listBody.graphs[0].generatedBy, "runner-1");
    assert.equal("storageKey" in listBody.graphs[0], false);
    assert.equal("leaseId" in listBody.graphs[0], false);
    assert.equal(
      (await router.fetch(authenticated("/projects/p/graphs/latest"), bindings)).status,
      200,
    );
    assert.equal((await router.fetch(authenticated("/projects/p/graphs/1"), bindings)).status, 200);
    const search = await router.fetch(
      authenticated("/projects/p/graphs/1/query", "POST", { operation: "search", query: "Alpha" }),
      bindings,
    );
    assert.equal(search.status, 200);
    assert.deepEqual(
      ((await search.json()) as any).result.nodes.map((node: Row) => node.id),
      ["a"],
    );
  });
});

describe("bounded graph explorer", () => {
  it("reads an immutable legacy version-only selected object", async () => {
    const legacy = graphRow({
      status: "READY",
      storage_layout: "LEGACY_V1",
      storage_key: "projects/p/graphs/v/1/graph.json",
      selected_publication_id: null,
      published_attempt: 1,
      published_lease_id: "l".repeat(43),
      generated_by: "legacy-runner",
      generated_at: "2026-01-01T00:01:00.000Z",
    });
    const result = await buildResult(legacy);
    Object.assign(legacy, {
      checksum: result.checksum,
      byte_size: result.byteSize,
      node_count: result.nodeCount,
      link_count: result.linkCount,
      hyperedge_count: 0,
    });
    db.graphs.push(legacy);
    storage.objects.set(legacy.storage_key, {
      bytes: result.bytes,
      metadata: {
        contentType: "application/json",
        checksum: result.checksum,
        uploadId: `1.${legacy.published_lease_id}`,
      },
    });
    const response = await handleGraphRoute(
      request("/projects/p/graphs/1/query", "POST", { operation: "search", query: "Alpha" }),
      env(),
      storage,
      { id: "viewer" },
      "p",
      "1",
      true,
    );
    assert.equal(response.status, 200);
  });

  it("verifies private bytes and honors source-to-target callers, callees, path, and source provenance", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    await publishGraphBuild(env(), storage, claim, result);
    const callees = await handleGraphRoute(
      request("/projects/p/graphs/1/query", "POST", { operation: "callees", nodeId: "a" }),
      env(),
      storage,
      { id: "viewer" },
      "p",
      "1",
      true,
    );
    assert.equal(callees.status, 200);
    assert.deepEqual(
      ((await callees.json()) as any).result.nodes.map((node: Row) => node.id),
      ["b"],
    );
    const callers = await handleGraphRoute(
      request("/projects/p/graphs/1/query", "POST", { operation: "callers", nodeId: "b" }),
      env(),
      storage,
      { id: "viewer" },
      "p",
      "1",
      true,
    );
    assert.deepEqual(
      ((await callers.json()) as any).result.nodes.map((node: Row) => node.id),
      ["a"],
    );
    const path = await handleGraphRoute(
      request("/projects/p/graphs/1/query", "POST", {
        operation: "path",
        source: "a",
        target: "b",
        maxDepth: 2,
      }),
      env(),
      storage,
      { id: "viewer" },
      "p",
      "1",
      true,
    );
    assert.deepEqual(
      ((await path.json()) as any).result.path.nodes.map((node: Row) => node.id),
      ["a", "b"],
    );
    const sources = await handleGraphRoute(
      request("/projects/p/graphs/1/query", "POST", { operation: "sources", limit: 1 }),
      env(),
      storage,
      { id: "viewer" },
      "p",
      "1",
      true,
    );
    assert.equal(((await sources.json()) as any).result.truncated, true);
  });

  it("enforces the visited-node limit inside a single high-fanout expansion", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const graph = standardGraph(db.graphs[0] as Row);
    graph.nodes = Array.from({ length: 5_002 }, (_, index) => ({
      id: `n${index}`,
      label: `Node ${index}`,
      file_type: "ts",
      source_file: `src/n${index}.ts`,
      source_location: "L1",
    }));
    graph.links = Array.from({ length: 5_001 }, (_, index) => ({
      source: "n0",
      target: `n${index + 1}`,
      relation: "CALLS",
      confidence: "EXTRACTED",
      confidence_score: 1,
      weight: 1,
      source_file: "src/n0.ts",
      source_location: "L1",
    }));
    const result = await buildResult(db.graphs[0] as Row, graph);
    await publishGraphBuild(env(), storage, claim, result);
    const response = await handleGraphRoute(
      request("/projects/p/graphs/1/query", "POST", {
        operation: "path",
        source: "n0",
        target: "n5001",
        maxDepth: 2,
      }),
      env(),
      storage,
      { id: "viewer" },
      "p",
      "1",
      true,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.result.path, null);
    assert.equal(body.result.truncated, true);
  });

  it("rejects oversized/invalid queries and checksum corruption without exposing storage keys", async () => {
    db.graphs.push(graphRow());
    const claim = await claimGraphBuild(env(), "p", 1);
    const result = await buildResult(db.graphs[0] as Row);
    await publishGraphBuild(env(), storage, claim, result);
    const invalid = await handleGraphRoute(
      request("/projects/p/graphs/1/query", "POST", {
        operation: "path",
        source: "a",
        target: "b",
        maxDepth: 99,
      }),
      env(),
      storage,
      { id: "viewer" },
      "p",
      "1",
      true,
    );
    assert.equal(invalid.status, 400);
    const object = storage.objects.values().next().value;
    assert.ok(object);
    object.bytes[0] = (object.bytes[0] ?? 0) ^ 1;
    const corrupt = await handleGraphRoute(
      request("/projects/p/graphs/1/query", "POST", { operation: "search", query: "a" }),
      env(),
      storage,
      { id: "viewer" },
      "p",
      "1",
      true,
    );
    assert.equal(corrupt.status, 500);
    assert.deepEqual(await corrupt.json(), { error: "STORAGE_INTEGRITY_ERROR" });
  });
});
