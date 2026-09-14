const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PROJECTS = 20;

type FenceParts = {
  predicate: string;
  bindings: readonly unknown[];
};

export type McpContextFenceIdentity = {
  credentialId: string;
  principalId: string;
  repositoryProvider: string | null;
  providerRepositoryId: string | null;
  repositoryCanonicalUrl: string | null;
};

export class ContextAuthorizationError extends Error {
  constructor() {
    super("context authorization changed");
  }
}

/** Opaque trusted SQL fence. Only the policy-specific factories can construct one. */
export class ContextAuthorizationFence {
  private constructor(
    private readonly projectIds: readonly string[],
    private readonly parts: FenceParts,
  ) {}

  assertProjectSet(projectIds: readonly string[]): void {
    const ids = canonicalIds(projectIds);
    if (
      ids.length !== this.projectIds.length ||
      ids.some((id, index) => id !== this.projectIds[index])
    )
      throw new ContextAuthorizationError();
  }

  prepare(
    db: D1Database,
    beforeFence: string,
    afterFence: string,
    bindingsBeforeFence: readonly unknown[],
    bindingsAfterFence: readonly unknown[] = [],
  ): D1PreparedStatement {
    return db
      .prepare(`${beforeFence} AND ${this.parts.predicate}${afterFence}`)
      .bind(...bindingsBeforeFence, ...this.parts.bindings, ...bindingsAfterFence);
  }

  async assertCurrent(db: D1Database): Promise<void> {
    const row = await db
      .prepare(`SELECT 1 AS authorized WHERE ${this.parts.predicate}`)
      .bind(...this.parts.bindings)
      .first<{ authorized: number }>();
    if (!row) throw new ContextAuthorizationError();
  }

  static human(projectIds: readonly string[], userId: string): ContextAuthorizationFence {
    const ids = canonicalIds(projectIds);
    const placeholders = ids.map(() => "?").join(",");
    return new ContextAuthorizationFence(ids, {
      predicate: `(
        SELECT COUNT(*) FROM projects context_auth_p
        JOIN project_members context_auth_pm
          ON context_auth_pm.project_id=context_auth_p.id AND context_auth_pm.user_id=?
        JOIN workspace_members context_auth_wm
          ON context_auth_wm.workspace_id=context_auth_p.workspace_id
         AND context_auth_wm.user_id=context_auth_pm.user_id
        WHERE context_auth_p.status='ACTIVE'
          AND context_auth_pm.role IN ('ADMIN','EDITOR','VIEWER')
          AND context_auth_p.id IN (${placeholders})
      )=?`,
      bindings: [userId, ...ids, ids.length],
    });
  }

  static mcp(
    projectIds: readonly string[],
    identity: McpContextFenceIdentity,
  ): ContextAuthorizationFence {
    const ids = canonicalIds(projectIds);
    const placeholders = ids.map(() => "?").join(",");
    const repositoryCheck = identity.repositoryProvider
      ? `AND (
          SELECT COUNT(DISTINCT context_auth_gc.project_id)
          FROM git_connections context_auth_gc
          JOIN repository_identities context_auth_ri
            ON context_auth_ri.id=context_auth_gc.repository_identity_id
          JOIN project_repositories context_auth_pr
            ON context_auth_pr.project_id=context_auth_gc.project_id
           AND context_auth_pr.repository_identity_id=context_auth_ri.id
          WHERE context_auth_gc.project_id IN (${placeholders})
            AND context_auth_gc.status='VERIFIED'
            AND context_auth_gc.provider=?
            AND context_auth_gc.provider_repository_id=?
            AND context_auth_ri.canonical_url=?
        )=?`
      : "";
    return new ContextAuthorizationFence(ids, {
      predicate: `EXISTS (
        SELECT 1 FROM mcp_credentials context_auth_mc
        JOIN mcp_principals context_auth_mp
          ON context_auth_mp.id=context_auth_mc.principal_id
        WHERE context_auth_mc.id=? AND context_auth_mp.id=?
          AND context_auth_mc.revoked_at IS NULL
          AND context_auth_mc.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND context_auth_mp.status='ACTIVE'
          AND EXISTS (
            SELECT 1 FROM mcp_principal_operations context_auth_mpo
            WHERE context_auth_mpo.principal_id=context_auth_mp.id
              AND context_auth_mpo.operation='search_context'
          )
          AND (
            SELECT COUNT(*) FROM mcp_principal_projects context_auth_mpp
            JOIN projects context_auth_p
              ON context_auth_p.id=context_auth_mpp.project_id AND context_auth_p.status='ACTIVE'
            JOIN project_members context_auth_pm
              ON context_auth_pm.project_id=context_auth_p.id
             AND context_auth_pm.user_id=context_auth_mp.owner_user_id
            JOIN workspace_members context_auth_wm
              ON context_auth_wm.workspace_id=context_auth_p.workspace_id
             AND context_auth_wm.user_id=context_auth_mp.owner_user_id
            WHERE context_auth_mpp.principal_id=context_auth_mp.id
              AND context_auth_pm.role IN ('ADMIN','EDITOR','VIEWER')
              AND context_auth_p.id IN (${placeholders})
          )=?
          ${repositoryCheck}
      )`,
      bindings: [
        identity.credentialId,
        identity.principalId,
        ...ids,
        ids.length,
        ...(identity.repositoryProvider
          ? [
              ...ids,
              identity.repositoryProvider,
              identity.providerRepositoryId,
              identity.repositoryCanonicalUrl,
              ids.length,
            ]
          : []),
      ],
    });
  }
}

function canonicalIds(projectIds: readonly string[]): string[] {
  const ids = [...new Set(projectIds)].sort();
  if (
    ids.length !== projectIds.length ||
    ids.length < 1 ||
    ids.length > MAX_PROJECTS ||
    ids.some((id) => !ID.test(id))
  ) {
    throw new ContextAuthorizationError();
  }
  return ids;
}
