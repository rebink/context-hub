# Phase 25 Final Architecture and Product QA

Status: **AUDIT, INDEPENDENT REVIEW, CONSOLIDATED CORRECTION, LOCAL E2E, AND 342-TEST ROOT GATE COMPLETE; LOCAL MVP ACCEPTANCE REMAINS BLOCKED**  
Baseline: `174ff9da6d1925aa84c8905ab560ad8f79956201`  
Allowed classifications: `PASS | FAIL | BLOCKED | NICE TO HAVE`

## Verdict

- **Local MVP process acceptance: BLOCKED.** [`phase-6-acceptance-evidence.md`](phase-6-acceptance-evidence.md) now preserves the original final independent `ACCEPT`, parent-owned 51-test root gate, and acceptance-ledger checkpoint. The same archive records split backend/frontend reviews plus a post-fix final review and proves that the repository had no `HEAD`, so neither the current exactly-one-review topology nor focused Git-checkpoint rule was satisfied. Current runs are not relabeled as historical evidence.
- **Production launch: BLOCKED.** Browser/accessibility, live GitHub OAuth/App, remote D1/R2/edge, real Graphify/protected Actions, live MCP/Pi plus OS secret store, privacy/account deletion, approved metrics policy, backups/restore, free-tier telemetry and deployment evidence are absent.
- **Confirmed implementation deviations:** no local P0/P1 code deviation is asserted after this correction; evidence/process and live-operation blockers remain exactly as listed.

## Evidence Rules

Each normative item has exactly one authoritative row below. `Implementation` names production symbols or an explicit deferral; `Migration` names schema evidence or `N/A`; `Verification` names a test/command or exact missing evidence. `scripts/architecture-qa.mts` enforces the unique ID manifest (52 functional, 24 nonfunctional, 43 technical-architecture, 15 MVP acceptance rows). Reports are claims; Git, production exports, fresh schema and executable checks are evidence.

## Normative Requirement Matrix

| ID | Source | Normative item | Result | Implementation | Migration | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| PRD-F-001 | PRD §1 | Product vision: shared project-scoped AI context | PASS | ContextEngine; handleContextRoute | 0005_context.sql | apps/api/test/context-route.test.ts |
| PRD-F-002 | PRD §2 | Problem framing: remove duplicated, drifting agent context | PASS | ContextEngine.search | 0012_context_freshness.sql | apps/api/test/context-engine.test.ts |
| PRD-F-003 | PRD §3 | Product solution: Git + artifacts + Graphify through MCP | PASS | createApp; ContextEngine; WorkerMcpTransport | 0001_initial.sql, 0005_context.sql | apps/api/test/index.test.ts; apps/api/test/mcp.test.ts |
| PRD-F-004 | PRD §4 | Target users and team workflows | PASS | handleTeamRoute | 0016_team_collaboration.sql | apps/api/test/team.test.ts |
| PRD-F-005 | PRD §7 | Project aggregate contains Git, artifacts, graphs, members, sync, snapshots, audit | PASS | createApp | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | apps/api/test/index.test.ts |
| PRD-F-006 | PRD §8 | GitHub connection with provider-neutral boundary | PASS | GithubGitProvider implements GitProvider | 0002_git_connections.sql | apps/api/test/providers.test.ts |
| PRD-F-007 | PRD §9 | Artifact taxonomy, bounded text formats, immutable versions | PASS | handleArtifactRoute; artifactObjectKey | 0001_initial.sql | apps/api/test/artifacts.test.ts |
| PRD-F-008 | PRD §10 | ADMIN, EDITOR, VIEWER authorization | PASS | direct `project_members` role checks | 0001_initial.sql | apps/api/test/artifacts.test.ts; apps/api/test/team.test.ts |
| PRD-F-009 | PRD §11 | Graphify structural intelligence and immutable graph versions | PASS | GraphifyAdapter; publishGraphBuild | 0003_graph_build_lifecycle.sql | apps/api/test/graphs.test.ts |
| PRD-F-010 | PRD §12 | Graph lifecycle reserve/build/publish/fail | PASS | claimOrReclaimExpiredGraphBuild; publishGraphBuild; failGraphBuild | 0003_graph_build_lifecycle.sql, 0015_machine_graph_publication.sql | apps/api/test/graphs.test.ts; apps/api/test/machine-graphs.test.ts |
| PRD-F-011 | PRD §13 | No graph merge; later valid complete build wins | PASS | publishGraphBuild | 0004_graph_build_reservation.sql | apps/api/test/graphs.test.ts |
| PRD-F-012 | PRD §14 | Downloadable local graph file | PASS | handleSyncRoute | 0009_sync_delivery.sql | apps/api/test/sync.test.ts |
| PRD-F-013 | PRD §15 | Explicit sync conflict and freshness states | PASS | handleSyncStateRead; handleSyncStateWrite | 0007_sync_states.sql | apps/api/test/sync-states.test.ts |
| PRD-F-014 | PRD §16 | Automatic push Graphify generation | NICE TO HAVE | workflow_dispatch is the accepted MVP trigger; webhook automation deferred | N/A | docs/ai/adr/0005-ci-machine-graph-publication.md |
| PRD-F-015 | PRD §17 | Global reference context | PASS | handleCrossProjectContextRoute | 0011_multi_project_context.sql | apps/api/test/context-route.test.ts |
| PRD-F-016 | PRD §18 | Recommended knowledge structure via typed artifacts | PASS | ARTIFACT_TYPES; ContextEngine.search | 0001_initial.sql | apps/api/test/artifacts.test.ts |
| PRD-F-017 | PRD §19 | Architecture maps as managed artifact content | NICE TO HAVE | No dedicated renderer required for MVP; text artifacts supported | N/A | docs/requirements/product-requirements.md Section 43 |
| PRD-F-018 | PRD §20 | Layered context retrieval | PASS | ContextEngine.search | 0005_context.sql | apps/api/test/context-engine.test.ts |
| PRD-F-019 | PRD §21 | Bounded context retrieval response | PASS | ContextEngine.search; MCP_LIMITS | 0005_context.sql | apps/api/test/context-engine.test.ts; apps/api/test/mcp.test.ts |
| PRD-F-020 | PRD §22 | Token/context budgets | PASS | MCP_LIMITS; ContextEngine.search | 0005_context.sql | apps/api/test/mcp.test.ts |
| PRD-F-021 | PRD §23 | Source, version, commit, checksum and project provenance | PASS | ContextEngine.search | 0005_context.sql | apps/api/test/context-engine.test.ts |
| PRD-F-022 | PRD §24 | Universal six-tool Context MCP | PASS | MCP_TOOLS; WorkerMcpTransport | 0010_mcp_credentials.sql | apps/api/test/mcp.test.ts; npm run audit:mcp-tokens -w @context-hub/api |
| PRD-F-023 | PRD §25 | Provider and agent neutrality | PASS | `AuthProvider`; `IdentityLookupProvider`; `ObjectStorage`; `GitProvider`; `GraphProvider`; `ContextProvider`; `McpTransport` | N/A | `apps/api/test/providers.test.ts`; `npm run qa:architecture` |
| PRD-F-024 | PRD §26 | Pi thin adapter with no permanent model-visible context | PASS | `createContextPiExtension` | N/A | `packages/context-pi/test/extension.test.ts`; `npm run audit:pi-tokens -w @context-hub/context-pi` |
| PRD-F-025 | PRD §27 | Immutable context snapshots and manifests | PASS | handleSnapshotRoute; snapshotManifestObjectKey | 0006_snapshots.sql | apps/api/test/snapshots.test.ts |
| PRD-F-026 | PRD §28 | Artifact and graph freshness | PASS | classifyArtifactFreshness; ContextEngine | 0012_context_freshness.sql | apps/api/test/context-engine.test.ts |
| PRD-F-027 | PRD §29 | Team invitation and role management | PASS | handleTeamRoute; handleInvitationInbox | 0016_team_collaboration.sql | apps/api/test/team.test.ts |
| PRD-F-028 | PRD §30 | Web application routes and responsive UI implementation | BLOCKED | `apps/web/src/main.ts` | N/A | web tests/build pass locally; BLK-003 remains |
| PRD-F-029 | PRD §31 | Project dashboard | PASS | `mountOverview` | N/A | `apps/web/test/management-navigation.test.ts` |
| PRD-F-030 | PRD §32 | Context search UI | PASS | `mountArtifacts` plus context search wiring in `apps/web/src/main.ts` | N/A | `apps/web/test/artifact-validation.test.ts` and workspace web tests |
| PRD-F-031 | PRD §33 | Graphify version UI | PASS | `mountGraphs` | N/A | `apps/web/test/graph-helpers.test.ts` |
| PRD-F-032 | PRD §34 | Graph explorer | PASS | `mountGraphs`; `normalizeGraphQuery`; `directedResultRows` | N/A | `apps/web/test/graph-helpers.test.ts` |
| PRD-F-033 | PRD §35 | Project and global audit history | PASS | handleActivityRoute; handleGlobalActivity | 0008_project_audit_events.sql, 0020_audit_event_aggregate_invariants.sql | apps/api/test/activity.test.ts |
| PRD-F-034 | PRD §36 | Free/open-source infrastructure constraint | BLOCKED | Cloudflare/GitHub free-tier design is implemented | N/A | npm run audit:free-tier passes locally; live usage telemetry missing |
| PRD-F-035 | PRD §37 | Local graph download, compare, atomic replace and sync-state workflow | PASS | syncProject; replaceGraphCache | 0007_sync_states.sql, 0009_sync_delivery.sql | packages/context-cli/test/sync.test.ts |
| PRD-F-036 | PRD §38 | Security controls and secret references | BLOCKED | authorization, CSRF, replay, bounded input and redaction controls pass locally | 0013_mcp_security.sql, 0018_bounded_inputs.sql | `apps/api/test/index.test.ts`, `apps/api/test/mcp.test.ts`, `apps/api/test/machine-graphs.test.ts`; BLK-007 and BLK-008 remain |
| PRD-F-037 | PRD §39 | Selective retrieval and token efficiency | PASS | ContextEngine.search; MCP_LIMITS | 0005_context.sql | npm run audit:mcp-tokens -w @context-hub/api |
| PRD-F-038 | PRD §40 | Token-awareness measurements | PASS | measureMcpTokenAudit; measurePiTokenAudit | N/A | npm run audit:mcp-tokens -w @context-hub/api; npm run audit:pi-tokens -w @context-hub/context-pi |
| PRD-F-039 | PRD §41 | Free-tier bounded operation | BLOCKED | rate, size and pagination limits are coded | 0014_free_tier_quotas.sql | npm run audit:free-tier passes locally; live telemetry/alerts missing |
| PRD-F-040 | PRD §42 | MVP scope as a complete launch claim | BLOCKED | Local implementation exists | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | Phase 6 review topology/Git checkpoint and live gates |
| PRD-F-041 | PRD §43 | Explicitly out-of-MVP features remain absent | PASS | No billing, marketplace, enterprise SSO or hosted private models | N/A | npm run qa:architecture |
| PRD-F-042 | PRD §44 | Future roadmap is not an MVP obligation | NICE TO HAVE | Roadmap intentionally unimplemented | N/A | docs/requirements/product-requirements.md Section 44 |
| PRD-F-043 | PRD §45 | Recommended end-state architecture at MVP boundary | PASS | Git + immutable artifacts/graphs + selective MCP retrieval | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| PRD-F-044 | PRD Multi-project | Workspace to project to repository hierarchy | PASS | resolveProject | 0011_multi_project_context.sql | apps/api/test/index.test.ts |
| PRD-F-045 | PRD Multi-project | Universal MCP project resolution | PASS | resolveScope | 0011_multi_project_context.sql | apps/api/test/mcp.test.ts |
| PRD-F-046 | PRD Multi-project | Local repository identity precedence | PASS | normalizeGithubRepository | 0011_multi_project_context.sql | apps/api/test/mcp.test.ts |
| PRD-F-047 | PRD Multi-project | Explicit project selection | PASS | resolveScope | 0011_multi_project_context.sql | apps/api/test/mcp.test.ts |
| PRD-F-048 | PRD Multi-project | Explicit cross-project retrieval | PASS | handleCrossProjectContextRoute | 0011_multi_project_context.sql | apps/api/test/context-route.test.ts |
| PRD-F-049 | PRD Multi-project | Workspace-level context aggregation | PASS | ContextEngine.searchMany | 0011_multi_project_context.sql | apps/api/test/context-engine.test.ts |
| PRD-F-050 | PRD Multi-project | Stable compact MCP tool footprint | PASS | MCP_TOOL_NAMES | N/A | npm run audit:mcp-tokens -w @context-hub/api |
| PRD-F-051 | PRD Multi-project | Multi-project membership isolation | PASS | resolveScope; direct membership SQL | 0011_multi_project_context.sql | apps/api/test/mcp.test.ts |
| PRD-F-052 | PRD Multi-project | Single reusable MCP connection principle | PASS | WorkerMcpTransport | 0010_mcp_credentials.sql | apps/api/test/mcp.test.ts |
| PRD-NF-001 | PRD cross-cutting | Git is authoritative for source | PASS | GitProvider and commit-bound graph records | N/A | apps/api/test/index.test.ts |
| PRD-NF-002 | PRD cross-cutting | Artifacts are immutable/versioned | PASS | `artifactObjectKey` and expected-version CAS | N/A | `apps/api/test/artifacts.test.ts` |
| PRD-NF-003 | PRD cross-cutting | Graphs are immutable derived payloads | PASS | attemptGraphObjectKey and createOnly | N/A | apps/api/test/graphs.test.ts |
| PRD-NF-004 | PRD cross-cutting | No collaborative graph editing | PASS | No graph mutation route exists | N/A | npm run qa:architecture |
| PRD-NF-005 | PRD cross-cutting | Responses are bounded | PASS | `readBoundedJsonObject` and `MCP_LIMITS` | N/A | `apps/api/test/index.test.ts` and `apps/api/test/mcp.test.ts` |
| PRD-NF-006 | PRD cross-cutting | Provenance is complete | PASS | ContextEngine provenance records | N/A | apps/api/test/context-engine.test.ts |
| PRD-NF-007 | PRD cross-cutting | Permanent model context stays small | PASS | Pi reports zero model-visible bytes | N/A | npm run audit:pi-tokens -w @context-hub/context-pi |
| PRD-NF-008 | PRD cross-cutting | Provider seams avoid registries/extra implementations | PASS | AST-derived provider inventory | N/A | npm run qa:architecture |
| PRD-NF-009 | PRD cross-cutting | Local/offline graph workflows remain possible | PASS | context-cli sync and local cache | N/A | packages/context-cli/test/sync.test.ts |
| PRD-NF-010 | PRD cross-cutting | Free/open-source components only | PASS | package/dependency and free-tier audit | N/A | npm run audit:free-tier |
| PRD-NF-011 | PRD cross-cutting | Authentication and session integrity | PASS | GithubAuthProvider, HttpOnly SameSite cookie | N/A | apps/api/test/index.test.ts |
| PRD-NF-012 | PRD cross-cutting | Project authorization is server-side and direct-membership based | PASS | direct `project_members` role checks and route contract | N/A | apps/api/test/index.test.ts |
| PRD-NF-013 | PRD cross-cutting | Credential material is hashed/redacted | PASS | sha256 credential storage and audit redaction | N/A | apps/api/test/mcp.test.ts |
| PRD-NF-014 | PRD cross-cutting | Replay protection | PASS | nonce ledgers | N/A | apps/api/test/mcp.test.ts; apps/api/test/machine-graphs.test.ts |
| PRD-NF-015 | PRD cross-cutting | CSRF/origin protection | PASS | `createApp` exact-origin mutation checks | N/A | apps/api/test/index.test.ts |
| PRD-NF-016 | PRD cross-cutting | Input, payload and pagination limits | PASS | `readBoundedJsonObject` and route constants | N/A | `apps/api/test/index.test.ts`, `apps/api/test/artifacts.test.ts`, `apps/api/test/mcp.test.ts` |
| PRD-NF-017 | PRD cross-cutting | Freshness and conflict behavior are deterministic | PASS | freshness classifiers and CAS | N/A | apps/api/test/sync-states.test.ts |
| PRD-NF-018 | PRD cross-cutting | Atomic local replacement | PASS | replaceGraphCache | N/A | packages/context-cli/test/sync.test.ts |
| PRD-NF-019 | PRD cross-cutting | Workflow actions are SHA pinned and least privilege | PASS | ci.yml and graphify.yml structural policy | N/A | npm run qa:architecture |
| PRD-NF-020 | PRD cross-cutting | Performance goals have bounded local checks | PASS | pagination, payload and context budgets | N/A | npm test |
| PRD-NF-021 | PRD cross-cutting | Accessibility and real-browser behavior | BLOCKED | UI implementation only | N/A | manual browser/accessibility evidence missing |
| PRD-NF-022 | PRD cross-cutting | Remote edge/D1/R2 correctness | BLOCKED | local Miniflare/D1 evidence only | N/A | remote environment evidence missing |
| PRD-NF-023 | PRD cross-cutting | Recovery, backup and restore | BLOCKED | No production recovery drill evidence | N/A | production backup/restore runbook and drill missing |
| PRD-NF-024 | PRD cross-cutting | Privacy, deletion, metrics and telemetry policy | BLOCKED | No speculative collection added | N/A | approved policy, deletion workflow and live telemetry evidence missing |
| TA-001 | TA §1 | Architecture goals | PASS | `createApp`; `ContextEngine`; `WorkerMcpTransport` | N/A | npm run qa:architecture |
| TA-002 | TA §2 | System overview | PASS | `createApp` in `apps/api/src/index.ts` plus web/CLI/Pi packages | N/A | npm run qa:architecture |
| TA-003 | TA §3 | Source-of-truth rules | PASS | `GitProvider`; `artifactObjectKey`; `attemptGraphObjectKey`; D1 metadata tables | N/A | npm run qa:architecture |
| TA-004 | TA §4 | Graph model | PASS | `GraphRow`; `validateGraphFormatV1` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-005 | TA §5 | No-merge graph model | PASS | `publishGraphBuild`; immutable complete-version selection | N/A | npm run qa:architecture |
| TA-006 | TA §6 | Immutable object storage | PASS | `ObjectStorage`; `R2ObjectStorage`; shared storage-key builders | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-007 | TA §7 | D1 schema | PASS | Exact `scripts/architecture-schema-manifest.json` from migrations 0001-0020 | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-008 | TA §8 | Indexing | PASS | 62 exact named index SQL hashes in `scripts/architecture-schema-manifest.json` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-009 | TA §9 | Authentication | PASS | `GithubAuthProvider`; session handling in `createApp` | N/A | npm run qa:architecture |
| TA-010 | TA §10 | Authorization | PASS | `ROUTE_CONTRACTS`; direct `project_members` role checks in production handlers | N/A | `npm run qa:architecture` |
| TA-011 | TA §11 | Artifact version conflict | PASS | `handleArtifactRoute`; expected-version compare-and-swap | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-012 | TA §12 | Graph build lifecycle | PASS | `claimOrReclaimExpiredGraphBuild`; `publishGraphBuild`; `failGraphBuild` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-013 | TA §13 | Graph sync lifecycle | PASS | `handleSyncRoute`; `handleSyncStateRead`; `handleSyncStateWrite` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-014 | TA §14 | Atomic local graph replacement | PASS | `replaceGraphCache`; `syncProject` in `packages/context-cli` | N/A | npm run qa:architecture |
| TA-015 | TA §15 | Context engine layers | PASS | `ContextEngine implements ContextProvider` | N/A | npm run qa:architecture |
| TA-016 | TA §16 | Context retrieval pipeline | PASS | `ContextEngine.search`; `ContextEngine.searchMany` | N/A | npm run qa:architecture |
| TA-017 | TA §17 | Token budget strategy | PASS | `MCP_LIMITS`; bounded Context Engine byte/token accounting | N/A | npm run qa:architecture |
| TA-018 | TA §18 | Context MCP architecture | PASS | `MCP_TOOLS`; `WorkerMcpTransport` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-019 | TA §19 | MCP authentication | PASS | `handleMcpRoute`; hashed credentials, scope and nonce ledgers | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-020 | TA §20 | Pi integration | PASS | `createContextPiExtension` | N/A | npm run qa:architecture |
| TA-021 | TA §21 | Local client | PASS | `connectProject`; `syncProject`; verified local graph cache | N/A | npm run qa:architecture |
| TA-022 | TA §22 | GitHub Actions | PASS | `.github/workflows/ci.yml`; `.github/workflows/graphify.yml` | N/A | npm run qa:architecture |
| TA-023 | TA §23 | Webhook flow | NICE TO HAVE | No webhook route exists; DEF-001 records the accepted manual-dispatch MVP | N/A | docs/ai/adr/0005-ci-machine-graph-publication.md |
| TA-024 | TA §24 | Snapshot model | PASS | `handleSnapshotRoute`; `snapshotManifestObjectKey` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-025 | TA §25 | Freshness model | PASS | `classifyArtifactFreshness`; sync-state classifiers | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-026 | TA §26 | Security threat model | PASS | `readBoundedJsonObject`; origin checks; replay ledgers; immutable integrity checks | N/A | npm run qa:architecture |
| TA-027 | TA §27 | Free infrastructure architecture | PASS | `scripts/free-tier-audit.mjs`; bounded route/query constants | N/A | npm run qa:architecture |
| TA-028 | TA §28 | Cloudflare constraints | PASS | Pagination, body, retrieval and transport bounds in production modules | N/A | npm run qa:architecture |
| TA-029 | TA §29 | API structure | PASS | `ROUTE_CONTRACTS`; `createApp` | N/A | npm run qa:architecture |
| TA-030 | TA §30 | Provider interfaces | PASS | `AuthProvider`; `IdentityLookupProvider`; `ObjectStorage`; `GitProvider`; `GraphProvider`; `ContextProvider`; `McpTransport` | N/A | npm run qa:architecture |
| TA-031 | TA §31 | Repository structure | PASS | `apps/api`, `apps/web`, `packages/context-cli`, `packages/context-pi`, `packages/graphify-adapter` | N/A | npm run qa:architecture |
| TA-032 | TA §32 | Observability | BLOCKED | `handleActivityRoute`; `handleGlobalActivity`; redacted audit writers; BLK-009 remains | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | approved/live metrics and alert evidence missing |
| TA-033 | TA §33 | Performance goals | BLOCKED | Production limit constants and bounded local tests; live latency/load evidence remains blocked | N/A | live latency/load evidence missing |
| TA-034 | TA §34 | MVP development principle | PASS | Accepted ADRs 0001-0008 and one-implementation provider inventory | N/A | npm run qa:architecture |
| TA-035 | TA §35 | Technical acceptance criteria | BLOCKED | This 134-row matrix plus `npm run qa:architecture`; BLK-001 and live blockers remain | N/A | Phase 6 phase-protocol and live evidence missing |
| TA-036 | TA Multi-project | Tenant hierarchy | PASS | `workspaces`; `projects`; direct `workspace_members` and `project_members` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-037 | TA Multi-project | Workspace data model | PASS | `workspaces`; `workspace_members`; migration `0011_multi_project_context.sql` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-038 | TA Multi-project | Repository identity data model | PASS | `repository_identities`; `project_repositories`; `normalizeGithubRepository` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-039 | TA Multi-project | Universal MCP flow | PASS | `WorkerMcpTransport`; `MCP_TOOLS`; one universal `/mcp` route | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-040 | TA Multi-project | Project resolution | PASS | `resolveScope`; `normalizeGithubRepository` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-041 | TA Multi-project | Cross-project retrieval | PASS | `handleCrossProjectContextRoute`; `ContextEngine.searchMany` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-042 | TA Multi-project | Workspace context | PASS | Workspace/project scope resolution in `ContextEngine.searchMany` | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run qa:architecture |
| TA-043 | TA Multi-project | MCP tool stability | PASS | `MCP_TOOL_NAMES`; `MCP_TOOLS` exact-six runtime audit | N/A | npm run qa:architecture |
| MVP-AC-001 | PRD §42 / TA §35 | GitHub sign-in | BLOCKED | Production route/package for GitHub sign-in | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | local provider doubles pass; live GitHub OAuth/App evidence missing |
| MVP-AC-002 | PRD §42 / TA §35 | Project creation | PASS | Production route/package for Project creation | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-003 | PRD §42 / TA §35 | GitHub connection | BLOCKED | Production route/package for GitHub connection | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | local provider doubles pass; live GitHub OAuth/App evidence missing |
| MVP-AC-004 | PRD §42 / TA §35 | Artifact creation | PASS | Production route/package for Artifact creation | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-005 | PRD §42 / TA §35 | Artifact versioning | PASS | Production route/package for Artifact versioning | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-006 | PRD §42 / TA §35 | Team invitation | PASS | Production route/package for Team invitation | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-007 | PRD §42 / TA §35 | Role assignment | PASS | Production route/package for Role assignment | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-008 | PRD §42 / TA §35 | Graphify version generation/storage | PASS | Production route/package for Graphify version generation/storage | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-009 | PRD §42 / TA §35 | Local graph download | PASS | Production route/package for Local graph download | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-010 | PRD §42 / TA §35 | Local/cloud sync | PASS | Production route/package for Local/cloud sync | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-011 | PRD §42 / TA §35 | Context search | PASS | Production route/package for Context search | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-012 | PRD §42 / TA §35 | Graph query | PASS | Production route/package for Graph query | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-013 | PRD §42 / TA §35 | Pi connection | BLOCKED | Production route/package for Pi connection | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | local Pi E2E/audit pass; live Pi plus OS secret-store evidence missing |
| MVP-AC-014 | PRD §42 / TA §35 | Context snapshot | PASS | Production route/package for Context snapshot | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |
| MVP-AC-015 | PRD §42 / TA §35 | Audit history | PASS | Production route/package for Audit history | 0001_initial.sql-0020_audit_event_aggregate_invariants.sql | npm run test:e2e:local |

## Phase 6 Historical Evidence Reconciliation

- The original parent-session archive and reviewer artifacts are hash-identified and excerpted in [`phase-6-acceptance-evidence.md`](phase-6-acceptance-evidence.md); no current run is called historical evidence.
- The archive establishes fresh read-only final reviewer run `bdc01112-08b3-444a-a3d4-c1396e4d5db9`, returning `ACCEPT` with no P0/P1 findings at `2026-09-11T16:55:48.499Z`. It also establishes preceding split backend/frontend reviews, a consolidated correction, and this post-fix review, so the historical topology does not match the current exactly-one-review rule.
- The parent then ran migrations, migration integrity, `npm test`, typecheck, lint, build, production dependency audit, and `git diff --check`; all passed at `2026-09-11T16:57:32.848Z`, including 41 API and 10 web tests.
- The parent marked Phase 6 task 2 complete after that gate and before Phase 7 began. This is the recovered acceptance-ledger checkpoint.
- Reviewer metadata records `fatal: bad revision 'HEAD'`, and both Phase 6 and Phase 7 writers reported an entirely untracked repository. No focused contemporaneous Git phase checkpoint existed. First commit `cad3dce` is only the later integrated Phase 6-through-9 code anchor, so local MVP process acceptance remains `BLOCKED` on the historical review-topology deviation and absent Git checkpoint.

## Section 37 Local-First Disposition

| Capability | Result | Evidence / disposition |
| --- | --- | --- |
| Download graph locally, inspect commit metadata, compare and atomically replace | PASS | `syncProject`, `replaceGraphCache`, `packages/context-cli/test/sync.test.ts` |
| Record local/cloud sync state explicitly | PASS | `handleSyncStateRead`, `handleSyncStateWrite`, migrations `0007` and `0009` |
| Persistent local artifact payload cache | NICE TO HAVE | ADR 0006 deliberately limits MVP cache to sync metadata; no artifact payload cache is claimed |
| Offline artifact editing and later upload/merge | NICE TO HAVE | Explicitly outside the accepted MVP local-sync slice; no implementation is claimed |
| Binary/PDF/diagram ingestion | NICE TO HAVE | Text/Markdown/YAML/JSON MVP formats are implemented; rich binary ingestion remains deferred |

## Architecture Audit Contract

`npm run qa:architecture` uses the TypeScript AST and production exports for provider and route contracts, probes every contracted route method plus a denied method, traces immutable-key builders to create-only write paths, structurally parses both workflows, applies migrations to a fresh local D1 database, compares every application table/index/trigger SQL hash and every foreign key with `scripts/architecture-schema-manifest.json`, runs the complete migration-integrity suite, invokes focused route/auth/provider/storage tests, and invokes MCP/Pi runtime audits. Child processes use finite canonical local executables, an allowlisted environment, isolated HOME/TMP, output limits, timeouts and process-group kill.

Fresh schema truth is **40 application tables**, **62 non-auto indexes**, **124 triggers**, and **100 foreign-key rows**. Wrangler's `_cf_METADATA` and the migration ledger `d1_migrations` are explicitly excluded; the prior “42 application tables” wording counted these two non-domain tables and is corrected here.

Latest correction evidence (local only):

| Evidence | Exact result |
| --- | --- |
| Architecture audit | `PASS`; two consecutive bounded runs produced digest `3cddb373ad45292a542bcb6a7f94ca618ed543db9af586961c1435a8e4198aec` |
| Normative matrix | 134 unique rows: 52 functional, 24 nonfunctional, 43 technical architecture, 15 MVP acceptance |
| Route contract | 49 production route shapes; every contracted method reached its handler boundary and every sampled uncontracted method returned `405` |
| Provider contract | Exactly one implementation each for `AuthProvider`, `IdentityLookupProvider`, `ObjectStorage`, `GitProvider`, `GraphProvider`, `ContextProvider`, and `McpTransport`; no registry |
| Immutable storage | Shared artifact, legacy graph, attempt graph, and snapshot builders are used by create-only publication and all audited retrieval/integrity paths; no request-body storage-key selector found |
| Workflows | CI: `pull_request,push`, read-only contents, cancellation enabled, 20-minute timeout; Graphify: manual dispatch, read-only contents, non-cancelling project concurrency, protected environment, trusted tooling revision, 30-minute timeout; all actions full-SHA pinned |
| Runtime audits | MCP: six tools, 4,082 schema bytes, digest `3cd33a36192e35bdd8b6c195b27a5a2720db3cc992faa7b0c0699465e2044599`; Pi: zero permanent model-visible bytes, digest `9ae7b270a3a64257fc58825710cffe6418f64e7f95d40ec3fae75ed64ff04382` |
| Local product scenario | `npm run test:e2e:local` PASS through real local Git/Graphify-adapter/HTTP/MCP/CLI/Pi paths; external seams remain explicitly blocked |
| Unit and focused semantics | 342 workspace unit tests PASS; architecture audit also executes nine named route/auth/provider/storage test files |
| Free-tier audit | PASS with 40 application tables, 2 excluded platform/ledger tables, 62 indexes and 34 project-first indexes |

## Deviations and Launch Blockers

| ID | Item | Result | Owner / exact unblock condition | Launch effect |
| --- | --- | --- | --- | --- |
| BLK-001 | Phase 6 historical phase-protocol compliance | BLOCKED | Process owner: retain the recovered final review/root-gate/ledger evidence; the split/post-fix reviews and missing historical `HEAD` cannot be repaired by another review or a backdated commit | Blocks local MVP process acceptance |
| GATE-006 | Phase 6 final review and parent root gate | PASS | Final reviewer run returned `ACCEPT`; migrations, 51 tests, typecheck, lint, builds, audit, and diff check then passed; see recovered evidence | Does not cure the historical review topology, supply the absent Git checkpoint, or provide live evidence |
| GATE-025 | Phase 25 canonical root gate | PASS | Deterministic architecture QA, local E2E, migration integrity, 342 tests, typecheck, Biome lint, and all builds passed | Does not resolve BLK-001 or production live gates |
| BLK-003 | Browser and accessibility validation | BLOCKED | Product QA: complete real desktop/mobile keyboard, screen-reader and accessibility checks | Blocks production launch |
| BLK-004 | Live GitHub OAuth/App | BLOCKED | Platform/security: configure sandbox credentials and verify identity, installation and exact-repository flows | Blocks production launch |
| BLK-005 | Remote D1/R2/private edge behavior | BLOCKED | Platform: provision non-production remote bindings and verify isolation, integrity, contention, rate and redacted-log behavior | Blocks production launch |
| BLK-006 | Real Graphify/protected Actions | BLOCKED | Platform: execute the pinned protected workflow with the real Graphify binary and bounded runner evidence | Blocks production launch |
| BLK-007 | Live MCP/Pi and OS secret store | BLOCKED | Client/security: exercise real hosts with helper-injected credentials and verify output/log secrecy | Blocks production launch |
| BLK-008 | Privacy/account deletion | BLOCKED | Product/security: approve policy and implement/verify the complete deletion lifecycle | Blocks production launch |
| BLK-009 | Live metrics, studies and alerts | BLOCKED | Phase 27 defines and locally validates the minimized registry/derived surface without raw telemetry; Product/platform must approve study/live aggregate retention, collect same-period receipts, and verify alerts | Blocks production launch |
| BLK-010 | Backup and restore | BLOCKED | Platform: define backups and complete an isolated restore drill | Blocks production launch |
| BLK-011 | Free-tier live usage evidence | BLOCKED | Platform: capture account-plan/usage evidence and validate alert thresholds | Blocks production launch |
| BLK-012 | Deployment evidence | BLOCKED | Release owner: deploy only after BLK-003 through BLK-011 close and record smoke/rollback evidence | Blocks production launch |
| DEF-001 | Webhooks and automatic push Graphify | NICE TO HAVE | Product: post-MVP decision; manual protected dispatch is the accepted MVP | Does not block local implementation |
| DEF-002 | Binary/PDF/diagram ingestion | NICE TO HAVE | Product: post-MVP format and threat-model decision | Does not block local implementation |
| DEF-003 | Artifact payload cache and offline artifact edits | NICE TO HAVE | Product: post-MVP local conflict/cache design | Does not block local implementation |
| DEF-004 | Pi snapshot mutation | NICE TO HAVE | Product: post-MVP mutation contract; current command is truthfully read-only | Does not block local implementation |
| DEF-005 | Additional providers/registry | NICE TO HAVE | Architecture: add only for an approved provider requirement | Does not block local implementation |
| DEF-006 | External invitation delivery | NICE TO HAVE | Product: post-MVP delivery-channel decision; in-product invitation flow exists | Does not block local implementation |

## Validation Boundary

Local commands demonstrate deterministic implementation behavior only. They do not prove external-provider configuration, browser behavior, production performance/cost, recovery, privacy operations or deployment. No deployment, production resource creation, product metrics collection, second review or commit is performed by this correction.

Phase 26 subsequently implements preparation-only runbook, canonical nonsecret manifest, offline preflight, and synthetic tests from checkpoint `dd65ff6`; see [`deployment-evidence.md`](deployment-evidence.md). Its only review, consolidated correction, offline preflight, and 342-test root gate are complete; no live action ran, and neither Phase 6's historical protocol gaps nor BLK-003 through BLK-012 is promoted by preparation evidence.

Phase 27 subsequently defines the minimized metric registry, local/synthetic audit, response-local Context counters, and bounded D1-derived project aggregate in [`metrics.md`](metrics.md) and [`metrics-evidence.md`](metrics-evidence.md). This narrows BLK-009 to missing approved/live aggregate receipts, studies, and alert verification; it does not promote any live matrix row or cure Phase 6's historical protocol gaps.

## Private-pilot launch update

`FREE_PILOT` is locally contract-tested only: it requires exact canonical assigned `pages.dev`/`workers.dev` origins, private R2, no previews/custom domains/CORS, and hash-only stable GitHub pilot admission before persistence and on every session. `CUSTOM_DOMAIN` remains a separate strict profile. The public repository's Graphify workflow now targets exact GitHub-hosted `ubuntu-24.04`; Oracle Free Tier is a future fallback only. This adds no live deployment, OAuth, privacy, quota, or billing evidence. The free architecture cannot mathematically prove $0 under abusive/unbounded or account-shared traffic; allowlisting/monitoring are controls rather than billing proofs.
