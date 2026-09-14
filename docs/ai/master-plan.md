# Context Hub Master Implementation Plan

Durable implementation ledger for the PRD, technical architecture, implementation playbook, security architecture, and current repository state.

## Legend and operating rule

- `[x]` implemented and locally verified in the current repository.
- `[ ]` not implemented, not verified, or still requires work.
- Phase status is `COMPLETE`, `PARTIAL`, or `PENDING`; a phase is complete only when all required items and its gate pass.
- Implement one ordered phase at a time using the bounded workflow: read the relevant requirements/code/tests -> implement with targeted checks -> run exactly one independent review of the phase diff -> fix all reported P0/P1 blockers in one batch -> run one full stop gate -> checkpoint.
- **Architecture-decision gate:** before implementing any significant architecture decision, record and approve an ADR covering context, decision, alternatives, consequences, security, operations, and rollback. This applies explicitly to provider contracts, Git credential storage/access, Graphify integration, MCP authentication/transport, local sync/cache behavior, and cross-project retrieval; phase gates must cite the accepted ADR rather than silently choosing an architecture.
- **Provider-contract gate:** each owning phase must define only the approved minimal contract, ship exactly one current adapter, add contract tests for its boundary/failure behavior, and cite the accepted ADR or narrow decision record. Do not add speculative providers, factories, registries, or fallback selection. The owners are Current provider seams (`AuthProvider`, `ObjectStorage`), Git (`GitProvider`), Graphify adapter (`GraphProvider`), Context Engine (`ContextProvider`), and universal MCP (`McpTransport`).
- **One-review rule:** each phase gets exactly one bounded independent review after implementation and targeted tests. The reviewer covers the phase diff and adjacent security/correctness boundaries and reports every P0/P1 blocker in one pass. P2 findings go to the existing backlog. If blocked, the implementation owner fixes the complete finding set, adds regression evidence, and verifies it with the phase gate; no second broad or layer-specific review is allowed.
- **Execution budget rule:** keep one writer per phase; use parallel read-only lanes only when their scopes are independent and nonduplicative; resume existing context rather than spawning fresh rereads; do not perform repository-wide review except in the dedicated final architecture/product QA phases.
- **Mandatory stop gate after every phase:** after the one review and any consolidated fixes, run `npm test` -> `npm run typecheck` -> `npm run lint` -> `npm run build` once. Stop on any failure; do not begin the next phase. Targeted checks may run during implementation.
- **Checkpoint rule:** after the full gate passes, commit one phase checkpoint so the next phase and its reviewer operate on a focused Git diff.
- Every new project route must authenticate, resolve the project, verify direct project membership, check `ADMIN | EDITOR | VIEWER`, and only then read or mutate data. Add denial, isolation, bounds, integrity, replay/conflict, and audit tests as applicable.

## Non-negotiable invariants

- **Architectural rule, not completion status:** Git is source-code truth; D1 is tenancy, authorization, version, sync, snapshot, and audit metadata truth; R2 holds immutable payloads. Each phase must preserve this split; pending sync and generalized audit schemas mean end-to-end conformance is not yet complete.
- [x] Workspace membership alone never grants project data access; inaccessible project, repository, artifact, graph, source-path, snapshot, and member metadata must not leak.
- [x] Published artifact objects are immutable, versioned, checksum-backed, and project-scoped.
- [x] Graphify remains a derived build output; implemented graph versions are immutable and checksum-backed; graph JSON is never edited, merged, or overwritten.
- [x] Context results are relevance-first, deduplicated, explicitly budgeted, bounded, and carry project/source/path/version/commit/checksum provenance where applicable.
- [x] Sync writes through a temporary path, verifies checksum and source commit, atomically replaces the cache, and preserves the last valid graph on failure.
- [x] One authenticated provider-neutral MCP endpoint exposes a stable six-tool, read-oriented surface regardless of project count; Phase 15 measures the complete schema as byte-identical for 1, 10, and 100 authorized projects.
- [x] The Phase 16 Pi client adds no LLM tools or prompt injection, never injects the repository/full graph/all artifacts, and does not duplicate Context Engine or Graphify logic; Phase 17's reviewed quantitative audit derives and regression-locks that zero-context result, and its root gate passes.
- [~] Local-first use continues from Git, manifest, and the verified graph cache when Context Hub is unavailable; artifact/offline context caches remain deferred.
- [x] The MVP uses minimal dependencies and free/open-source-compatible Pages, Workers, D1, R2, GitHub OAuth, and GitHub Actions architecture; no mandatory paid service.

## Ordered phase ledger

The order below is binding. Multi-project Task A must finish before MCP; Task B is implemented with Prompt 14; Task C is implemented with Prompt 16; Task D requires the Context Engine and MCP authorization model. A phase may not advance until its stop gate passes.

### 0A. Repository discovery — `COMPLETE`

- [x] Record structure, language/framework, package manager, frontend, backend, database, deployment, authentication, tests, lint, typecheck, CI/CD, reusable pieces, infrastructure, environment, risks, unknowns, and extension points in `docs/ai/project-discovery.md`.
- [x] Do not invent architecture or implement application code during discovery.
- [x] Run the phase stop gate.

### 0B. Technical architecture — `COMPLETE`

- [x] Record system/frontend/Worker architecture, schema, R2 layout, GitHub, Graphify, Context Engine, MCP, Pi, auth, authorization, graph sync, artifact versions, snapshots, audit, security, free-tier, and local/offline strategy in `docs/ai/architecture.md`.
- [x] Preserve Git/D1/R2 truth, immutable derived graphs/artifacts, no graph merge, bounded context, provider neutrality, local-first behavior, and free infrastructure.
- [x] Run the phase stop gate.

### 0C. Security architecture — `COMPLETE`

- [x] Threat-model authentication, authorization, isolation, Git credentials, MCP, private artifacts, R2, webhooks, SSRF, path traversal, uploads, replay, role escalation, and cross-project access in `docs/ai/security.md`.
- [x] Define nonleaking denials, least privilege, integrity, rate/bounds, redaction, and live-provider verification controls.
- [x] Run the phase stop gate.

### 1. Foundation (Prompt 1) — `COMPLETE`

- [x] Create npm/TypeScript workspaces, Vite/Pages web app, Fetch API Worker, D1, R2 bindings, ordered migrations, environment configuration, local development, CI, tests, typecheck, lint, and builds.
- [x] Keep OAuth/provider secrets server-only and deployment values outside browser bundles/source-controlled vars.
- [x] Use minimal dependencies; defer Git, Graphify, MCP, Pi, and Context Engine.
- [x] Run the phase stop gate.

### 2. Authentication and projects (Prompt 2) — `COMPLETE`

- [x] Implement GitHub identity OAuth with exact callback/origin rules, hashed expiring one-time state, opaque hashed sessions, expiry, and logout.
- [x] Implement users, sessions, workspace creation/listing, project creation/listing/detail, direct project membership, and `ADMIN | EDITOR | VIEWER` server authorization.
- [x] Test unauthenticated/authenticated access, hostile or missing mutation origins, expired/replayed state, logout, cross-project access, role enforcement, workspace-only denial, and nonleaking `404` behavior.
- [x] Close the approved provider-neutrality requirement for authentication through Phase 5A's minimal `AuthProvider` contract and its one current GitHub identity implementation.
- [x] Re-run the phase stop gate after Phase 5A.

### 3. Project dashboard (Prompt 3) — `COMPLETE`

- [x] Render real project, artifact count, member count, and honest Git/Graphify/sync placeholders from API data.
- [x] Do not fabricate Git or Graphify behavior.
- [x] Run the phase stop gate.

### 4. Artifacts (Prompt 4) — `COMPLETE`

- [x] Model artifact metadata and immutable versions with project/type/name/description/status/current version, storage key, SHA-256, content type, byte size, source commit, author, timestamp, and change note.
- [x] Support `architecture`, `adr`, `api-contract`, `coding-convention`, `domain-knowledge`, `glossary`, `database-schema`, `runbook`, `deployment-guide`, `ownership`, `security-rule`, `product-requirement`, and `custom`.
- [x] Implement bounded Markdown/text/JSON/YAML create, upload, retrieve, pagination, version creation/list/detail, R2 storage, checksum verification, permissions, and optimistic expected-version conflicts.
- [x] Preserve history, prevent silent overwrite, deny viewer mutations, keep R2 private, use server-generated project keys, and safely compensate failed publication.
- [x] Test bounds, validation, authorization/isolation, immutable recovery, checksum failures, version conflicts, pagination, and audit events.
- [x] Run the phase stop gate.

### 5. Context/artifact UI (Prompt 5) — `COMPLETE`

- [x] Provide category navigation, artifact list/create, detail, verified content, version history/publication, source-commit provenance for the current artifact version, viewer read-only behavior, and editor/admin controls using real data.
- **Deferred boundary:** freshness classification and warnings are not part of Phase 5 completion; implement the shared classifier in Phase 12 and artifact UI integration in Phase 19.
- [x] Escape/render uploads as inert content; do not offer Graphify editing.
- [x] Run the phase stop gate.

### 5A. Current provider seams — `COMPLETE`

- [x] Pass the provider-contract/ADR gate for the minimal current `AuthProvider` and `ObjectStorage` boundaries; [`adr/0001-provider-boundaries.md`](adr/0001-provider-boundaries.md) records ownership, failure semantics, and retained domain logic.
- [x] Extract `AuthProvider` only around provider authorization URL/code exchange/validated identity behavior; keep application sessions, cookies, D1 user records, and roles outside it. Ship exactly one GitHub identity implementation.
- [x] Extract `ObjectStorage` only around create-only put, head/get, and narrowly controlled compensation delete with object metadata; keep server-generated keys, checksums, D1 publication, authorization, and compensation decisions outside it. Ship exactly one Cloudflare R2 implementation.
- [x] Preserve current OAuth, artifact immutability, recovery, integrity, and nonleaking behavior without adding providers, factories, registries, dynamic selection, or unrelated refactors.
- [x] Add contract tests covering success, malformed/provider failure for `AuthProvider`, and create-only collision, metadata/head/get, failure, and compensation-delete behavior for `ObjectStorage`; retain existing route-level tests.
- [x] Acceptance includes the two named minimal contracts, exactly one current implementation each, the accepted ADR, passing contract and regression tests, and the phase stop gate.

### 6. GitHub repository connection (Prompt 6) — `PARTIAL`

- [x] Pass the architecture-decision and provider-contract gates with accepted [`adr/0002-github-app-repository-credentials.md`](adr/0002-github-app-repository-credentials.md) for the minimal `GitProvider`, GitHub App access, project/repository binding, revocation, and failure handling.
- [x] Define `GitProvider` only for GitHub App authorization/proof and live normalized repository/default-branch/current-commit inspection; ship exactly one GitHub implementation and keep project authorization, D1 references, and publication in domain code.
- [x] Add focused contract tests for URL/PKCE construction, JWT claims/signing flow, exact calls, ownership proof, valid/malformed responses, HTTP/network mapping, identity mismatch, branch/SHA validation, bounds, redirects, and token redaction.
- [x] Implement least-privilege GitHub App handling with short-lived exact-repository installation tokens; persist only installation/reference metadata and exact-session-bound hashed one-time state/verifier data.
- [x] Implement `POST /projects/:id/git`, `GET /projects/:id/git`, `POST /projects/:id/git/sync`, `DELETE /projects/:id/git`, the two GitHub App callback routes, and authorized `GET /projects/resolve`; verify provider user, installation, and exact repository identity.
- [x] Implement the `github_connection_states`, `git_connections`, and `git_audit_events` models plus normalized `repository_identities`/unique `project_repositories` links, storing provider, canonical URL, owner/name, default branch, current/last-known commit SHA, installation reference, status, and timestamps without a repository copy or persisted token.
- [x] Recheck the same actor's direct ADMIN membership inside callback publication, sync, and disconnect mutation batches; reject demotion/removal and exact-connection races without connection/link/audit mutation.
- [x] Update known commit SHA optimistically against the exact connection identity and provider tuple, atomically audit every successful sync (including unchanged verification) with bounded before/after metadata, suppress stale callback publication, preserve the prior verified row on provider or audit failure, and redact all provider credentials/bodies from responses and audit.
- [x] Constrain outbound provider hosts, redirects, time/size/content type, ports, protocols, credentials, and fixed API paths.
- [x] Replace seed-only project-repository trust with one active link per project backed by a consistent verified connection; preserve one repository mapping to many projects and none/unique/ambiguous authorized resolution.
- [x] Add focused provider and route tests for cross-session state rejection, two-state callback/PKCE replay, stale callback/disconnect interleavings, optimistic replacement races, strict callback origins, specific-installation proof beyond one-page listing, verified repository resolution, provider mechanics, and secret exposure while preserving existing tests.
- [x] Implement the repository connection UI with role-aware controls, bounded callback handling, project stale-response protection, accessible confirmation/form behavior, and responsive system-theme styling.
- [ ] Complete the required final review acceptance before marking Phase 6 complete.
- [ ] Complete live browser/GitHub App/Cloudflare verification as an external release blocker; local Phase 6 completion does not claim this deployment evidence.
- [x] Run the full local phase stop gate, including fresh/upgrade Wrangler D1 migrations, uniqueness, foreign-key and transactional rollback checks, tests, typecheck, lint, and builds.

### 7. Graphify research (Prompt 7) — `COMPLETE`

The implementation playbook labels Prompt 7 as source "Phase 5"; this master plan's operational Phase 7 numbering and order are authoritative.

- [x] Inspect canonical Graphify source/docs and isolated 0.9.58 fixtures for CLI, exact external-output behavior, output shape, watch/incremental and MCP/HTTP modes, version/checksum, authentication, source inclusion, symlink variation, and determinism limits.
- [x] Correct [`graphify-integration.md`](graphify-integration.md) and [`adr/0003-graphify-canonical-build-profile.md`](adr/0003-graphify-canonical-build-profile.md) with an official-tag-sourced 0.9.58 capability matrix, reject-all tracked-symlink/submodule/LFS preflight, exact `GRAPHIFY_OUT` recipe, immutable repository identity, implementable format-v1 rules/bounds, fixture evidence, failures, security, and rejected scope.
- [x] Record independent final-review acceptance of ADR 0003 and the corrected research contract on 2026-09-12 with no P0 or P1 findings.
- [x] Complete local documentation/link/fence/diff checks and run the full local phase stop gate. This phase is complete as documentation only and does not claim an adapter, graph schema/storage/routes, CI publication, explorer, deployment, or live Actions verification.

### 8. Graphify adapter (Prompt 8) — `COMPLETE`

- [x] Pass the provider-contract gate for a minimal public `GraphProvider` based only on the accepted Graphify research/ADR; ship exactly one `GraphifyAdapter` in an isolated Node-only workspace with no factory, registry, fallback, or application import.
- [x] Return exact graph bytes; repository provider/ID and immutable normalized identity snapshot; project/source commit; fixed Graphify/adapter/profile/format/generator metadata; derived node/link/hyperedge counts; byte size; and independently handshaken exact-byte SHA-256. Keep project/version/R2/D1/auth/publication/state transitions outside it.
- [x] Before any subprocess or temporary output, require the POSIX-only v1 process-group and safe-output capabilities or fail with redacted `UNSUPPORTED_PLATFORM`; Windows remains unsupported pending a tested Job Object/equivalent. Then reject dirty/untracked/ignored-present content, unsupported index modes/nonregular files, every tracked symlink, submodules/gitlinks/`.gitmodules`, and LFS pointers. Use the exact shared-`GRAPHIFY_OUT` two-process recipe and accept only direct regular `graph.json`; enforce the complete format-v1 contract with a stdlib-only duplicate-aware validator and always clean up.
- [x] Add retained captured Graphify 0.9.58 fixture/provenance, comprehensive adapter/validator/preflight/redaction/scope tests, and a real temporary detached Git fixture. Unit tests require neither Graphify nor network access.
- [x] Record required independent final-review acceptance with no findings after the complete implementation and 86-test gate.
- [x] Run the full local phase stop gate for the implementation (86 tests, typecheck, lint, and builds), including the Phase 8 review fixes.

### 9. Immutable graph versions and UI (Prompt 9) — `COMPLETE`

- [x] Reserve graph row/version at queue with repository provider, stable provider repository ID, immutable normalized repository identity snapshot, project ID, source commit, Graphify/adapter/profile/format identity, status/attempt, generator/generated-by; keep output/storage/checksum/node/link/hyperedge/byte/generated fields nullable until READY, where `generated_at` means publication.
- [x] Preserve `QUEUED -> BUILDING -> READY -> SUPERSEDED`, `BUILDING -> FAILED`, and `FAILED -> QUEUED` retry on the same logical version with an incremented attempt, with physical identity isolated per attempt.
- [x] Accept ADR 0004 and add `graph_build_attempts` keyed by project/version/attempt with unique random server-generated publication ID/key, immutable attempt identity, and attempt-owned lease/cleanup state. Reservation/retry atomically recheck current direct `ADMIN` membership; claim atomically creates the attempt/publication identity.
- [x] Publish to `projects/{projectId}/graphs/v/{version}/attempts/{attempt}/{publicationId}/graph.json`, fence finalize by full attempt/object/build identity, forbid cross-attempt adoption, supersede only lower READY versions, and support exact READY/SUPERSEDED replay.
- [x] Clean only exact failed/expired unpublished attempt keys after grace, serialized D1 cleanup ownership, fresh no-reference proof, and exact HEAD metadata checks. Legacy READY/SUPERSEDED objects remain immutable/queryable via `LEGACY_V1`; legacy orphan deletion is not automated.
- [x] Deduplicate logical versions only by the complete repository/project/build identity. A replacement provider repository cannot reuse old output even with the same normalized name and commit; an approved tool/profile/format change may build the same commit as a new immutable version.
- [x] Revalidate exact bytes at Worker publication/read boundaries with a dependency-free duplicate-aware full format-v1 validator. The Worker enforces schema-safe source paths; the Node adapter remains tracked-checkout authority.
- [x] Build the Graphify status UI with separate newest-attempt/current-READY state, complete version/commit/build/repository provenance, role-aware generation reservation, honest Phase 10/local-sync boundaries, and accessible lifecycle/error states.
- [x] The bounded Graph Explorer implements node search/inspection, neighbors, callers/callees, directed paths, and source locations through one bounded backend query at a time without returning or rendering a whole graph.
- [x] Backend/frontend and migration tests cover attempt key uniqueness, exact attempt-backed v2 lifecycle transitions, current-ADMIN mutation checks, cross-attempt isolation, exact replay, legacy coexistence, contradictory READY normalization, query cancellation, and immutable event/attempt constraints.
- [x] Independent bounded acceptance review confirmed all Phase 9 P0/P1 blockers resolved after migration 0013; the local gate passes 140 tests, typecheck, lint, and all builds. Browser/live Cloudflare verification remains an external release gate.

### 10. CI graph generation (Prompt 10) — `COMPLETE LOCALLY; LIVE RUNNER RELEASE GATE PENDING`

- [x] Phase 9 passed its single independent review and stop gate; no external machine credential, route, or workflow was included in Phase 9.
- [x] Added the complete CPython 3.12 Linux x86-64 wheel hash lock and full Action commit pins. The canonical self-hosted workflow fails closed unless it attests cgroup memory and dedicated-filesystem disk limits; representative benchmarks and live-runner evidence remain external release blockers.
- [x] Added the documented GitHub Actions flow: exact checkout -> GraphifyAdapter -> validate/checksum -> machine publish/register or bounded failure report.
- [x] Added a separate CI machine principal and one-time high-entropy bearer credential stored only as SHA-256, fixed graph lifecycle scope, exact project/provider-repository binding, and ADMIN-only bounded issue/list/rotate/revoke routes. Human sessions cannot call machine publication routes.
- [x] Enforced D1-clock credential expiry, atomic rotation/immediate revocation, commit/build/attempt/lease/publication binding, bounded hashed nonce replay protection, least workflow permissions/secrets, and complete-identity duplicate prevention.
- [x] Heavy graph generation remains outside Worker request/webhook lifecycles; Phase 10 adds no webhook.
- [x] Local migration, route, lock, runner, and workflow-assumption tests cover auth/isolation/replay, publish/fail transport, exact replay, expiry recovery, atomic lifecycle audit, immutable evidence, and credential exhaustion recovery. Live self-hosted Actions plus remote D1/R2 rotation/revocation/publication evidence remains an external release gate.
- [x] The additive CI principal/hashed-credential, bounded nonce, immutable audit data models and project/repository/commit-enforcing machine transport are implemented through migration 0014.
- [x] Completed the single independent phase review, fixed its full P0/P1 set in one consolidated pass without a second review, and passed the 154-test phase stop gate. Phase 11 may begin.

### 11. Local sync and offline cache (Prompt 11) — `COMPLETE LOCALLY`

- [x] Pass the architecture-decision gate with accepted ADR 0006 for local sync transport, atomic cache layout, offline behavior, credential storage, path defense, crash recovery, and rollback.
- [x] Implement `.ai-context/manifest.json`, `graph/graph.json`, `graph/meta.json`, `artifacts/`, and `cache/`; keep credentials outside the repository behind the environment/OS-secret integration boundary.
- [x] Implement `context connect`, `context status`, and `context sync` in the dependency-light Node CLI workspace.
- [x] Derive `CURRENT`, `GRAPH_STALE`, `LOCAL_REPOSITORY_AHEAD`, `REMOTE_GRAPH_AHEAD`, `NO_LOCAL_GRAPH`, `GRAPH_BUILDING`, `GRAPH_FAILED`, and `COMMIT_MISMATCH` with deterministic precedence from local/server Git and graph versions.
- [x] Download -> verify bounded response/checksum/metadata/source commit -> write/fsync no-follow temporary -> atomically rename graph/meta -> update manifest last.
- [x] Preserve the previous valid cache on failures through persisted rollback evidence; fixed contained paths and no-follow checks reject unsafe existing layouts, traversal inputs, symlink escapes, and mismatched sync operations. No archives are accepted.
- [x] Support offline status and verified local graph reads without network access. Artifact synchronization/reads remain deliberately unimplemented beyond the required empty directory.
- [x] Focused API/CLI tests cover every state, auth/isolation, current-repository graph selection, changed/copied remotes, full format-v1 corruption, interrupted update, rename/preparation failure, concurrent locking, dead-lock recovery, atomic replacement, prior-cache preservation, bounds, replaced-parent/symlink cases, and network/HTTP offline behavior.
- [x] Completed the one independent phase review and resolved its full P1 set in one consolidated pass without a second review.
- [x] Passed the full phase stop gate: migration integrity plus 178 tests (92 API, 26 web, 19 CLI, 41 adapter), typecheck, Biome lint, and all builds.
- **P2 backlog (non-blocking):** expand overlap-heavy state precedence cases and exhaustive crash injection across every marker/backup/rename/fsync boundary on representative target filesystems; keep live Worker/D1/R2 and OS-secret-helper checks in the external evidence ledger.

### 12. Context Engine (Prompt 12) — `COMPLETE LOCALLY`

- [x] Pass the implementation side of the provider-contract gate for minimal `ContextProvider`; ship exactly one `ContextEngine`, with no provider factory or alternative retrieval backend. The existing architecture decision is sufficient and no new undecided boundary required an ADR.
- [x] Define the contract around project-scoped query/domain/package/explicit token-and-byte budget input and bounded ranked evidence/provenance/freshness output; authentication, project authorization, and transport stay outside it.
- [x] Add focused contract/unit/route tests for bounds, ranking, deduplication, provenance, freshness states plus missing/invalid provenance, source failures, role/project isolation, no-cache behavior, and private payload integrity. Prompt 13 remains separate.
- [x] Accept project, query, optional domain/package, and explicit token/size budget.
- [x] Retrieve query-aware bounded candidates from project-indexed current artifact metadata/content, one bounded current-repository-matched Graphify graph, current verified Git metadata, architecture artifacts, and compact versioned built-in guidance derived from checked-in project invariants with truthful generated-source provenance.
- [x] Rank direct task, package/domain, architecture, currency, and source-backed relevance; deduplicate before applying one budget calculated from complete serialized evidence objects.
- [x] Return concise artifact excerpts, bounded graph relationships, source locations, relevance reason, independently testable token estimate, and exact project/source/path/section/version/commit/checksum provenance fields.
- [x] Implement the shared artifact freshness classifier as `CURRENT`, `STALE`, or `UNKNOWN` from valid artifact/current repository commits, including missing/invalid provenance behavior.
- [x] Expose that shared classifier in every applicable Context Engine result; never return the full repository, full graph, all artifacts/ADRs, or an unbounded permanent prompt.
- [x] Use bounded, indexed, non-vector retrieval for MVP. No cache/index is introduced, so there is no shared principal state; future caches remain required to namespace principal plus project.
- [x] Completed the one independent phase review and fixed its complete five-item P1 set in one consolidated pass without a second review: full-evidence token accounting, artifact HEAD integrity, current-repository graph selection, truthful built-in provenance, and query-aware artifact candidate ordering.
- [x] Passed the full phase stop gate: migration integrity plus 192 tests (106 API, 26 web, 19 CLI, 41 adapter), typecheck, Biome lint, and all builds.
- **P2 backlog (non-blocking):** make relevance reasons name only the query/domain/package dimensions that actually matched; add method, control-heavy optional-field, and exact multibyte response-boundary cases opportunistically.

### 13. Context Engine scenarios (Prompt 13) — `COMPLETE LOCALLY`

- [x] **Prerequisite:** Phase 12's shared `CURRENT | STALE | UNKNOWN` classifier and Context Engine exposure are implemented and have passed the stop gate; Prompt 13 does not define a separate classifier.
- [x] Relevant architecture is found in an overlap scenario that also includes graph, provenance, deduplication, and freshness evidence.
- [x] Unrelated artifacts, inactive rows, and non-current versions are excluded by scenario fakes that enforce the production SQL predicates.
- [x] Relevant graph evidence is included only for the current verified repository and READY graph; scenarios prove the 12-node evidence cap, four-relationship cap, excerpt bound, and truncation signal.
- [x] One explicit token/byte output budget is verified from independently encoded result/evidence measurements rather than trusting response accounting fields.
- [x] Every important result has exact project/source/path/section/version/commit/checksum provenance with source-appropriate truthful nullability.
- [x] Duplicate excerpts are removed before the one global budget is applied; a calibrated scenario proves a later unique result fits only because duplicate cost is removed first.
- [x] `CURRENT`, `STALE`, and `UNKNOWN` artifacts, including missing and invalid commits, are classified by the shared Phase 12 classifier.
- [x] Private project data does not cross projects through metadata rows, repository/status/current-version selection, storage calls/keys, source errors, response fields, or repeated uncached searches. Context retrieval validates bounded base64url IDs, positive bounded versions/attempts, exact `LEGACY_V1`/`ATTEMPT_V2` semantics, and exact derived artifact/graph keys before R2 HEAD/get.
- [x] Completed the one independent review and fixed its complete P1 set in one consolidated pass without a second review: fail-closed storage-key component validation plus valid legacy/current matrices, pre-budget dedup proof, graph bounds, uncached re-read proof, exact provenance matrices, and stricter HEAD/SQL fakes.
- [x] Passed the root phase stop gate: migration integrity plus 200 tests (114 API, 26 web, 19 CLI, 41 adapter), typecheck, Biome lint, and all builds.

### A. Workspace and multi-project foundation (Task A) — `PARTIAL`

- [x] Add users, workspaces, workspace members, projects, project members, normalized repository identities, and project-repository join models/migrations/helpers.
- [x] Support users in multiple workspaces/projects and different direct project roles; keep workspace membership separate from project authorization.
- [x] Normalize GitHub SSH/HTTPS remotes and return none/unique/ambiguous authorized project resolution without guessing.
- [x] Test user in two workspaces, user in multiple projects, workspace-only denial, unauthorized query denial, correct remote resolution, and ambiguous explicit-selection requirement.
- [x] Create repository identities/links through the real Git connection flow rather than seeds.
- [x] Re-run migration, authorization, isolation, and phase stop gates after completing the backend real-link flow.
- [x] Complete the Task A real-link flow locally through the Phase 6 UI; final Phase 6 review acceptance remains pending and live provider/browser verification remains an external release blocker.

### 14/B. Universal multi-project MCP (Prompt 14 + Task B) — `COMPLETE LOCALLY`

- [x] Accept ADR 0007 for MCP authentication, principal lifecycle, Authorization-only credential transport, hash-only D1 storage, replay/rate controls, project/repository scope, GET/POST behavior, cross-project all-or-nothing authorization, and the minimal `McpTransport` boundary.
- [x] Define `McpTransport` only for bounded protocol decode/encode and stable tool dispatch; ship exactly one Worker `GET/POST /mcp` implementation while authentication, authorization, project resolution, and Context Engine behavior remain domain services.
- [x] Add transport contract tests for GET/POST negotiation, malformed/oversized requests, stable error mapping, response bounds, and exact six-tool dispatch; no alternate transport, per-project server, factory, or provider is present.
- [x] Expose one authenticated `GET/POST /mcp` endpoint, not one server/configuration per project.
- [x] Expose exactly the stable initial tools: `project_info`, `search_context`, `get_artifact`, `query_graph`, `get_sources`, and `sync_status`.
- [x] Keep schemas small, read-only, provider-neutral, role-aware, bounded, and provenance-bearing; do not expose all Graphify or administrative operations.
- [x] Resolve one mutually exclusive scope by normalized local repository identity, explicit project selection, or explicit cross-project scope; never infer access from selection/workspace.
- [x] Authenticate, verify current workspace access plus direct project membership/current role, and only then retrieve; independently authorize the complete cross-project set before any domain read.
- [x] Model MCP/local-client principals separately from Phase 10 CI identities, with 256-bit credentials stored only as SHA-256, exact operation and project sets, optional repository binding, and issue/expiry/last-used/revocation/rotation metadata.
- [x] Implement ADMIN human-cookie lifecycle routes with exact mutation Origin, secure one-time display, D1-clock expiry/rotation/revocation, atomic nonce consumption, D1 request-rate/live-nonce limits, request/result/context budgets, immutable redacted audit outcomes, and nonleaking errors.
- [x] Test multi-workspace/project selection, normalized auto-selection and ambiguity, explicit switch, authorized and partially unauthorized cross-project scope with zero domain reads, constant six-tool dispatch, valid/inactive/rotated/revoked/replayed/wrong-project/wrong-repository credentials, no human-cookie MCP access, lifecycle Origin/role races, protocol failures, and migration integrity.
- [x] Add additive migration 0015 and verify fresh plus staged-through-0015 upgrades, separate CI/MCP tables, hash-only credentials, replacement integrity, immutable nonce/audit records, and scope guards.
- [x] Completed the one independent phase review and fixed its complete seven-item P1 set in one consolidated writer pass without another review: exact-one selector schemas, MCP initialize/notification negotiation, pre-decode auth/replay/rate/audit, database-sealed scopes/expiry bounds, exact-transition revoke audit, caller-wide cross-project limits, and SQL-sensitive six-tool/lifecycle/isolation coverage.
- [x] Passed the root phase stop gate: fresh/staged-through-0015 migration integrity plus 219 tests (133 API, 26 web, 19 CLI, 41 adapter), typecheck, Biome lint, and all builds.
- **P2 backlog (non-blocking):** add explicit UTF-8-boundary-safe artifact excerpt truncation rather than relying on replacement decoding at a byte cutoff.

### 15. MCP token audit (Prompt 15) — `COMPLETE LOCALLY`

- [x] Record the reproducible method, exact six-tool schema bytes/estimated tokens, representative average, largest response, transport/context limits, and worst-case bounded model-visible footprint in [`mcp-token-budget.md`](mcp-token-budget.md).
- [x] Measure 1, 10, and 100 authorized projects against the exported transport: the complete 4,082-byte schema and SHA-256 remain exactly identical, with no duplicated tool/schema or embedded project enumeration.
- [x] Measure actual JSON-RPC encoding for representative single-project, explicit two-project, and partially unauthorized responses; the rejection has no model-visible tool text or project/provenance leakage. Measurements fit accepted bounds, so no transport verbosity was trimmed.
- [x] Add a deterministic dependency-free audit script and regression tests for schema constancy, six unique tools, response accounting, nonleaking rejection, production-sourced immutable limits, and the calculated bound.
- [x] Complete the one independent Phase 15 review and fix its complete two-item P1 set in one consolidated pass without a second review: one production limits source across runtime/schema/audit plus exact envelope/limits/ceiling regression locks.
- [x] Passed the root phase stop gate: fresh/staged-through-0015 migration integrity plus 222 tests (136 API, 26 web, 19 CLI, 41 adapter), typecheck, Biome lint, and all builds.

### 16/C. Pi integration and project resolution (Prompt 16 + Task C) — `COMPLETE LOCALLY`

- [x] Implement lightweight native commands: `/context connect`, `/context status`, `/context sync`, `/context search <query>`, `/context graph <node>`, and `/context snapshot`.
- [x] Call the existing local CLI and Context Hub/MCP rather than reimplementing retrieval or Graphify; snapshot remains an explicit non-mutating Phase 18 placeholder.
- [x] Read/normalize the local Git remote, resolve the project, cache explicit selection locally, expose status, report zero matches, and require selection for multiple matches.
- [x] Support explicit project switching, consume the scoped MCP/local-client principal credential provisioned through Phase 14's ADMIN lifecycle, and keep credentials out of repository files/prompts/output.
- [x] Add no provider-specific model behavior, new agent architecture, LLM tools, bulk injection, or required cloud dependency for cached status/graph use.
- [x] Add Pi API-fake and client tests for registration/lifecycle, automatic resolution, zero/one/many, selection/switching, authorization, offline graph fallback, origin/credential handling, secret redaction, output bounds, no tools/providers, and shutdown cleanup.
- [x] Record exact researched Pi 0.85.1 extension/package assumptions in [`pi-integration.md`](pi-integration.md).
- [x] Complete the one independent phase review and this single consolidated four-item P1 correction pass: live remote/manifest fencing before every MCP or cached graph read, strict initialize-result negotiation, streaming 128 KiB response enforcement, and abortable generation-fenced startup auto-selection.
- [x] Passed the root phase stop gate: fresh/staged-through-0015 migration integrity plus 245 tests (136 API, 26 web, 22 CLI, 20 Pi, 41 adapter), typecheck, Biome lint, and all builds.
- [ ] Collect external live Pi/TUI command, reload, and shutdown evidence plus live OS-secret-helper handoff before release.
- **P2 backlog (non-blocking):** typecheck against Pi's exported types when an install fixture is available; add explicit redirect, no-UI ambiguity, invalid-credential, and distinct nonce/ID tests; collect package distribution evidence for Node >=22.19.

### 17. Pi token audit (Prompt 17) — `COMPLETE LOCALLY`

- [x] Verify no unnecessary system-prompt growth, tools, all-artifact/full-graph injection, Graphify duplication, hidden context payload, or provider/model/agent behavior modification.
- [x] Record reproducible output and activation measurements in [`pi-token-budget.md`](pi-token-budget.md): permanent model-visible overhead is structurally exactly 0 bytes / 0 estimated tokens, registration is byte-identical for 1, 10, and 100 authorized projects, and all native command formatted notification payloads are bounded.
- [x] Add dependency-free executable audit and regression tests over actual exported Pi registration, formatting, lifecycle, and limits, with a canonical exact-locked final audit digest.
- [x] Complete the one independent Phase 17 review and its complete four-item P1 correction in one consolidated pass: fail-closed derived mutation evidence, canonical final digest, UTF-8-safe/redacted successful output, and accurate formatted-payload labeling.
- [x] Passed the root phase stop gate: fresh/staged-through-0015 migration integrity plus 249 tests (136 API, 26 web, 22 CLI, 24 Pi, 41 adapter), typecheck, Biome lint, and all builds.
- **P2 backlog (non-blocking):** typecheck against Pi's exported API when an install fixture is available; collect Node >=22.19/package installation evidence; collect live TUI/RPC/provider/reload/shutdown telemetry.

### 18. Immutable snapshots (Prompt 18) — `COMPLETE LOCALLY`

- [x] Add snapshot and snapshot-artifact references for project, name, exact Git SHA, graph version plus selected publication/attempt/storage provenance, exact artifact versions/storage provenance, creator, timestamp, immutable manifest metadata, and narrow immutable creation outcomes in additive migration 0016.
- [x] Implement authenticated ADMIN/EDITOR create plus direct-member bounded list, inspect, and exact-manifest retrieve without duplicating graph or artifact payloads; publish one canonical create-only R2 manifest and compensate only proven-unpublished owned objects.
- [x] Preserve and revalidate checksums/provenance, require a READY/SUPERSEDED graph whose Git and current verified repository identity match, require exact same-project artifact versions, and fail closed when any D1/R2 reference or payload is missing, mismatched, or corrupt. A graph is required because Prompt 18 defines graph version as part of every snapshot.
- [x] Add SQL-aware API and fresh/staged migration tests for role/isolation, bounds/pagination, reproducibility, invalid references, immutable retrieval, R2 collision/ambiguous writes, D1 compensation, audit truthfulness, and route behavior.
- [x] Complete the one independent review and its full seven-item P1 correction in one consolidated pass: sealed exact artifact membership/count, complete artifact type/version provenance and referenced-row guards, created-versus-adopted publication ownership, integrity-verified idempotent replay, shared list/inspect/retrieve verification, D1-authoritative timestamps, and truthful non-mutating Pi availability text with refreshed token evidence. No second review is planned.
- [x] Passed the root phase stop gate: fresh/staged-through-0016 migration integrity plus 261 tests (148 API, 26 web, 22 CLI, 24 Pi, 41 adapter), typecheck, Biome lint, and all builds. Remote R2 create-only contention and compensation behavior remain external release evidence.
- **P2 backlog (non-blocking):** bound cursor decoding before allocation; define infrastructure-failure audit policy; add real-D1/predicate-sensitive fake coverage and race cases beyond the seven fixed P1 findings.

### 19. Freshness UI and sync-state persistence (Prompt 19) — `COMPLETE LOCALLY`

- [x] Reuse Phase 12's exact shared `classifyArtifactFreshness` implementation and `CURRENT | STALE | UNKNOWN` semantics without a second classifier.
- [x] Add bounded freshness/provenance fields to artifact list/detail/version APIs and non-color-only responsive UI badges/warnings for current, stale, unknown, disconnected, unverified, missing-commit, and invalid-provenance states. Immutable artifact rows/history are never rewritten, and Context Engine presentation remains on the same classifier.
- [x] Add migration 0017's bounded project/principal/client sync state with stable nonsecret client ID, exact repository identity, verified local and observed remote Git/graph identity, deterministic Phase 11 status, monotonic observation sequence, D1-authoritative last-seen/last-sync time, project-first indexes, and a 20-client-per-principal/project retention cap.
- [x] Add direct-member human-session list/current reads and Authorization-only scoped MCP/local-principal current-state upsert. Every query rechecks active project, workspace/direct membership, `sync_status` scope, and exact current verified repository binding; cookie/Origin-bearing local writes fail nonleaking.
- [x] Wire CLI and Pi status plus successful/failed sync through the CLI reporting seam. Reporting is best-effort, bounded, path/credential-free, and separately identified from graph sync outcome; offline and last-valid-cache behavior remains independent.
- [x] Add SQL-sensitive API/migration, CLI, Pi, and web coverage for freshness transitions/history immutability, provenance/repository edges, auth/isolation/repository binding, create/update/list/current, D1 time, monotonic/idempotent observations, bounds/pagination, and reporting/offline failure preservation.
- [x] Complete the one independent Phase 19 review and its full four-item P1 correction in one consolidated pass: server-verified local/remote graph truth including attempts and deterministic-state contradictions; authorization-conditioned atomic upsert rechecks; sync-success separation from reporting/status failures in CLI/Pi; and exact bounded JSON acknowledgment validation. No second review is planned.
- [x] Passed the root phase stop gate: fresh/staged-through-0017 migration integrity plus 274 tests (153 API, 28 web, 26 CLI, 26 Pi, 41 adapter), typecheck, Biome lint, and all builds. External browser/accessibility and remote D1/local-client reporting evidence remain pending.
- **P2 backlog (non-blocking):** add full real-D1 20-client/FK/identity/concurrent-race coverage; bound cursor text before `atob`.

### 20. Team management (Prompt 20) — `COMPLETE LOCALLY`

- [x] Add migration 0018's bounded invitation lifecycle. Invitations bind one exact existing GitHub-authenticated user ID to one project and role, retain no email or bearer secret, use D1-authoritative issued/7-day expiry/accepted/revoked timestamps, allow at most 100 live pending invitations and 100 members per project, and retain terminal rows as immutable replay evidence. One pending row per project/invitee is unique; a revoked or D1-expired invitation may be reissued as a new identity.
- [x] Implement authenticated inbox/list, ADMIN invite/revoke, exact-invitee acceptance, member list, expected-role/revision role change, and removal. Project team routes resolve active project plus direct current membership before role checks; workspace-only and cross-project access remain nonleaking.
- [x] Prevent mass assignment, self-invite/self-role mutation, replay/expired/revoked acceptance, and final-ADMIN demotion/removal. D1 triggers and conditional writes serialize final-admin safety and couple successful invitation/membership transitions to narrow immutable `team_events` evidence.
- [x] Reauthorize all artifact/graph/context/sync/MCP operations from D1 on every request. Role/removal transitions delete the affected user's project sync-state rows transactionally; no human role cache exists, and multi-project MCP credentials remain intact while their current direct-membership checks immediately fence the removed project only.
- [x] Add the responsive role-aware Team surface and invitation inbox with loading/empty/error/conflict states, exact expected revision controls, final-admin-safe controls, no browser-stored invitation credential, dark-mode inheritance, and reduced-motion inheritance.
- [x] Add targeted API and fresh/staged-through-0018 SQL migration evidence for permission boundaries, exact invitee acceptance/replay, D1 timestamps, immutable audits, self-role rejection, role transitions, and final-admin removal. Broader root regression evidence is intentionally pending the owned phase gate.
- [x] Complete the one independent review and its full five-item P1 correction in one consolidated writer pass without a second review: exact-origin credentialed Team CORS; same-write ACTIVE/current-ADMIN fencing; deterministic revision-bound sealed team outcomes; current stable provider-identity invitation lookup; and one shared bounded streaming JSON-object reader across every mutation.
- [x] Passed the root phase stop gate: fresh/staged-through-0018 migration integrity plus 290 tests (167 API, 30 web, 26 CLI, 26 Pi, 41 adapter), typecheck, Biome lint, and all builds. Live browser/accessibility, external invitation delivery (not implemented), remote D1 contention, and remote MCP/sync revocation evidence remain external.
- **P2 backlog (non-blocking):** add browser/focus CORS refresh coverage; collect remote real-D1 contention evidence for two-admin/final-admin, accept/revoke, archive, capacity, and actor-demotion races; add an exact seven-day expiry assertion.

### 20A. Project administration and artifact lifecycle — `COMPLETE LOCALLY`

- [x] Add ADMIN-only `PATCH /projects/:id` and a real-data Settings view for the approved mutable `name`, `slug`, and `description` fields; exact-key validation rejects mass assignment and keeps workspace, ownership, status, membership, repository, and provider identity outside the mutation contract.
- [x] Add ADMIN-only logical `DELETE /projects/:id/artifacts/:artifactId` with archive status, actor, D1 time, reason, and revision metadata; default active lists/counts, Context Engine, MCP sources, and current artifact detail hide archived rows while exact authorized version history and sealed snapshot replay remain intact. R2 is never deleted by archive.
- [x] Require exact project `expectedRevision` plus artifact `expectedVersion` and `expectedRevision`; SQL predicates recheck active project, current direct role, status, and revision, and stale/repeated requests return deterministic `409 CONFLICT` without retry.
- [x] Couple successful settings and archive transitions to narrow immutable `project_administration_events` evidence with actor/project/target/revision, D1-authoritative time, and bounded JSON before/after metadata. Generalized Phase 21 audit aggregation/history and its denial/failure policy remain pending.
- [x] Add targeted endpoint, SQL migration, role/isolation, bounds/mass-assignment, conflict/race/no-op, immutable-history/no-R2-delete, default exclusion, snapshot, Context Engine/MCP predicate, and role-safe UI helper coverage. Local browser/accessibility and remote D1/R2 contention evidence remain external.
- [x] Complete the one independent Phase 20A diff review and its complete three-item P1 correction in one consolidated pass: initial artifact lifecycle insertion guards, exact `UPDATE ... RETURNING` settings transitions without post-commit authorization/read, and allowlisted conflict classification with generic nonleaking internal failures. No second review is planned.
- [x] Passed the root phase stop gate: fresh/staged-through-0019 migration integrity plus 302 tests (178 API, 31 web, 26 CLI, 26 Pi, 41 adapter), typecheck, Biome lint, and all builds.
- **P2 backlog (non-blocking):** add a project-path method branch so unsupported methods on `/projects/:id` return `405 Method Not Allowed` with `Allow: GET, PATCH`, plus router coverage; add browser/DOM E2E coverage for artifact archive confirmation, stale-conflict draft preservation, and focus behavior when a browser harness exists while retaining the external browser/accessibility gate.

### 21. Audit coverage (Prompt 21) — `COMPLETE LOCALLY`

- [x] Record project creation/settings, artifact creation/version/archive, Git connect/sync/disconnect, invitation create/accept/revoke, role change/removal, future actor-bound graph reserve/retry plus machine claim/publish/failure, snapshot creation/outcomes, sync-state reports, and machine/MCP credential/request lifecycle without payloads or secrets.
- [x] Add migration 0020's immutable `project_audit_events` materialization with deterministic unique source transition identity, exact project and `HUMAN | MACHINE | MCP | SYSTEM` actor, action, target, outcome, canonical allowlisted metadata capped at 2 KiB, D1-authoritative time, project/time plus actor/action indexes, 100,000-event project capacity, and indefinite no-pruning retention.
- [x] Backfill only exact truthful narrow evidence and preserve legacy domain tables as transition truth. Historical graph reservations without actors and project-less multi-project MCP lifecycle rows are omitted rather than inferred; future covered success events are trigger-derived in the authoritative transaction.
- [x] Record safely identified existing machine/MCP denials/failures, snapshot rejected/failed outcomes, and failed sync reports with bounded codes. Intentionally omit ordinary human authorization/validation denials and uncontrolled infrastructure exceptions when a safe project/target is unavailable.
- [x] Add authenticated direct-member-only `GET /projects/:id/activity` and detail reads with 30-day default/90-day maximum windows, 50-row pages, filter-bound stable cursors, action/actor filters, archived-project reads, exact CORS/method behavior, and no global aggregate.
- [x] Add a role-neutral responsive Activity UI with exact actor/action/target/outcome/time/metadata presentation, filters, bounded pagination, empty/error/archive states, inert text rendering, keyboard focus, dark-mode inheritance, mobile layout, and reduced-motion inheritance.
- [x] Add targeted migration/API/web evidence for bounds, cursors, filters, backfill/bridge truth, indexes, immutability/forgery/duplicate/redaction guards, and sync/admin/team transition materialization. Broader touched-domain regressions and external remote/browser evidence remain pending.
- [x] Complete the one independent Phase 21 review and its consolidated four-item P1 correction without a second review: exact authoritative generalized/source seals, immutable graph reservation and sync-report evidence, migration-time 100,000-event enforcement, and one finite shared TypeScript/SQL action contract.
- [x] Passed the root phase stop gate: fresh/staged-through-0020 migration integrity plus 309 tests (184 API, 32 web, 26 CLI, 26 Pi, 41 adapter), typecheck, Biome lint, and all builds. Remote D1 and live browser/accessibility evidence remain external.
- **P2 backlog (non-blocking):** retain Phase 20A's method-branch and browser/focus items; make route-specific Activity `OPTIONS` advertise only its GET-only surface; generation-fence Activity loads or disable the complete filter form while loading; add broader router/auth/exact-preflight and per-required-event-class migration coverage.

### D. Explicit cross-project context (Task D) — `COMPLETE LOCALLY`

- [x] Accepted ADR 0008 for explicit canonical scope, all-or-nothing caller authorization, global ranking/provenance-safe deduplication, one response budget, zero current cache state, stable MCP transport, bounded corruption, and nonleaking failure behavior.
- [x] Extended the one Context Engine seam for an explicit one-to-twenty-project set, query/domain/package, and one overall token/byte/source budget while preserving the existing single-project API.
- [x] Added the human-session `POST /context/cross-project/search`; it validates before one complete-set active-project/current direct-member/current workspace-member authorization check and starts no Context Engine/domain/R2 read on mismatch. MCP retains its scoped-principal/repository checks and invokes the multi-project engine once.
- [x] Query each authorized project's active current artifacts, verified current Git/repository-matched graph, and built-in guidance under caller-wide retrieval caps; rank globally with deterministic fair ties, retain distinct project provenance, deduplicate exact same-project excerpts, and apply one serialized response budget.
- [x] Added executable Payments/Identity/Mobile isolation, relevance/fairness/dedup/budget/order, archived/freshness/provenance/corruption, 1/10/20, route race/bounds/CORS/nonleakage, all-before-read, six-tool schema/digest, and zero-cache-surface evidence.
- [x] Completed the one independent Task D review and fixed its complete two-item P1 set in one consolidated writer pass without a second review: opaque caller-built authorization fences now guard every source metadata SELECT and every R2 read against current human/MCP complete-set authority, and exact complete-shell byte accounting now rejects impossible budgets and bounds admitted source errors.
- [x] Passed the root phase stop gate: fresh/staged-through-0020 migration integrity plus 318 tests (193 API, 32 web, 26 CLI, 26 Pi, 41 adapter), typecheck, Biome lint, and all builds. Remote D1/R2 and twenty-project performance evidence remain external.
- **P2 backlog (non-blocking):** reconcile ADR deduplication wording with boundary duplicate rejection; add route-specific `405 Allow: POST` and narrow global preflight behavior; broaden race/R2/minimum-budget coverage beyond the consolidated P1 fixes.

### Management UI completion — `COMPLETE LOCALLY`

- [x] Global navigation: Projects, Activity, Settings, with URL-backed deep links and history restoration.
- [x] Global Activity is only a bounded, paginated/time-limited aggregate of audit events from projects where the caller has direct current membership; every aggregate query joins current project and workspace membership, returns authorized project metadata only, exposes no inaccessible counts/order gaps, and explicitly supports active/archived filtering.
- [x] Global Settings minimally shows real account/session data and a bounded read-only connection/configuration overview for directly authorized projects; it returns no provider payload, credential, secret, or invented preference. Project settings mutation remains the separate ADMIN-only Phase 20A seam.
- [x] Project navigation: Overview, Context, Graphify, Git, Team, Snapshots, Activity, Settings.
- [x] Git management: repository, branch, current commit, connection/verification/error state, connect/disconnect/sync controls by role.
- [x] Graphify management and focused Graph Explorer surfaces from Phase 9; graph editing remains absent.
- [x] Team management: pending invites, acceptance, member list, role changes/removal, and final-admin-safe controls.
- [x] Snapshot list/create/inspect with exact provenance, real Overview freshness/sync status, project Activity history, and the Phase 20A project Settings/lifecycle UI are wired.
- [x] Viewer controls remain read-only while server authorization stays authoritative; loading, empty, error, conflict, stale, offline, integrity, and nonleaking denial copy is explicit, and async view transitions are abortable/generation-fenced.
- [x] The single independent review is complete and its six P1 findings are fixed in one consolidated pass: authenticated teardown/history fail closed without retained private state; every project route refreshes current list/detail authorization behind an abortable generation fence; snapshot inspection renders the complete API provenance contract; invalid routes canonicalize while project selection exposes `aria-current` only in project context; create/dialog flows restore focus; and SQL-sensitive plus coordinator/history acceptance contracts cover mixed authorization, cursors, demotion/removal, stale completion, teardown, and listener cleanup.
- [x] Passed the root phase stop gate: fresh/staged-through-0020 migration integrity plus 330 tests (197 API, 40 web, 26 CLI, 26 Pi, 41 adapter), typecheck, Biome lint, and all builds. No browser runtime is installed, so live browser, keyboard, responsive, accessibility, and back/forward execution remain an explicit external Phase 24 gate.
- [ ] Management UI P2 backlog only: replace global Activity append failures with append-specific retry/error handling; replace stale Graphify copy that says local sync is not implemented; explicitly classify whether the account provider user ID belongs in the Settings response; add snapshot pagination or an explicit truncation/load-more state beyond the current bounded first page.

### 22. Security audit (Prompt 22) — `COMPLETE LOCALLY`

- [x] Audited authentication, authorization, project isolation, D1 predicates, R2 privacy/integrity, OAuth/Git credentials, webhook absence, MCP, downloads, sync, traversal, SSRF, uploads, replay, rate limits, headers, logging, CI, backups, privacy, and secret handling.
- [x] Created `docs/ai/security-audit.md` with reproducible evidence and fixed the confirmed High local-code findings: centralized Worker headers, exact-origin generated Pages headers, bounded redirect-safe identity OAuth provider responses with complete stream cleanup, bounded workspace/project JSON bodies, and pinned/read-only general CI actions.
- [x] Verified local role/membership revocation across human/MCP/sync, revoked/expired/wrong/replayed credentials, artifact/graph/snapshot corruption, and all-before-read partial cross-project denial. Webhook replay is N/A because no endpoint exists; complete account deletion remains open.
- [x] Marked backup/restore `BLOCKED` because no safe isolated deployed procedure exists; production headers/origins, rate limits, logs, provider/client/runner behavior, privacy/retention, and recovery remain explicit external/live blockers.
- [x] Completed the one independent review and fixed its complete two-item P1 set in one consolidated writer pass without a second review: fail-closed exact parsed-origin Pages CSP generation and stable redacted OAuth stream/body cleanup failures.
- [ ] P2 backlog only: broaden representative Worker-header assertions; cancel shared bounded JSON on early media/declared-length rejection.
- [x] Passed the root phase stop gate: fresh/staged-through-0020 migration integrity plus 336 tests (201 API, 42 web, 26 CLI, 26 Pi, 41 adapter), typecheck, Biome lint, and all builds. The dependency audit remains at zero known vulnerabilities across 229 dependencies.

### 23. Free-tier audit (Prompt 23) — `COMPLETE LOCALLY`

- [x] Recorded current first-party Workers, Pages, D1, R2, and GitHub Actions limits/access date/caveats plus repository measurements and account/deployment unknowns in [`free-tier-audit.md`](free-tier-audit.md).
- [x] Added a dependency-free executable audit and regression tests for Worker/web build output, fresh migration schema/size/local plans, workflow triggers/concurrency/timeouts/retention, application limits, no interval polling, bounded retries, graph-build deduplication, and create-only storage evidence.
- [x] Audited bounded high-cost route models. Reduced snapshots to 20 artifact references/four fully verified list entries, consolidated create metadata into one bounded project-scoped query, and replaced integrity's per-artifact D1 metadata reads with one project/snapshot-predicated join while preserving every R2 HEAD/GET/checksum/schema/provenance check. Consolidated 1-20-project Context metadata into three complete-set-fenced queries, globally ranked artifacts before eight reads, and allocated eight complementary graphs fairly and deterministically under the 16-object cap (15+1 for single-project), preserving every immediate pre-HEAD/pre-GET authorization check.
- [x] Added 20-minute superseded-run cancellation to quality CI and serialized non-cancelled Graphify publication per project; no unsafe cancellation after object-first upload and no Actions artifact retention were introduced.
- [x] Verified representative local SQLite plans use project-first indexes; no index was added because no unbounded scan was demonstrated. Remote D1 plans/rows scanned remain external evidence and local SQLite is not claimed equivalent.
- [x] Recorded 70/85/95 monitoring thresholds, exact deployed billing/analytics requirements, no-cost assumptions, and fixed/open/external findings without claiming repository-enforced zero cost.
- [x] Completed the one independent review and its consolidated four-P1 correction pass.
- [x] Passed the root phase stop gate: fresh/staged-through-0020 migration integrity plus 340 tests (205 API, 42 web, 26 CLI, 26 Pi, 41 adapter), typecheck, Biome lint, and all builds. External Cloudflare/GitHub usage and plan/visibility, remote D1 plans, and Graphify benchmarks remain blockers.

### 24. End-to-end verification (Prompt 24) — `COMPLETE LOCALLY; EXTERNAL/LIVE CHECKS BLOCKED`

- [x] Admin signs in through the injected OAuth provider seam and creates Payments Platform through production HTTP routes on fresh local D1.
- [x] Admin connects normalized GitHub through the injected `GitProvider`, then uploads immutable architecture and refund ADR versions to local private R2.
- [x] Graph v1 is deterministically generated at real commit A by the actual `GraphifyAdapter`/detached-Git/Python-validator path with an injected executable seam, production-format validated, machine-published, and shown current. Protected Actions and the real Graphify binary remain BLOCKED.
- [x] Admin invites the current provider identity; developer accepts the intended EDITOR role.
- [x] Actual `context-cli` sync/cache, exact `REPORTED` telemetry persistence/audit, and native `context-pi` registration/connect execute against production HTTP/MCP entry points.
- [x] Refund retry returns bounded, Payments-only, source-backed Context Engine evidence through Pi and MCP.
- [x] Developer changes the isolated real repository and creates commit B.
- [x] Graph v2 is validated/published; actual CLI detects `REMOTE_GRAPH_AHEAD` and atomically syncs v2.
- [x] Exact graph v1 bytes/checksum remain immutable and are revalidated by same-attempt replay plus authorized explorer retrieval after supersession.
- [x] Snapshot raw bytes/checksum seal and revalidate exact commit-B Git/repository, graph-v2 generator/publication, and complete active artifact-v1 provenance; audit/freshness/team evidence is asserted.
- [x] Added fail-fast `npm run test:e2e:local` and [`e2e-report.md`](e2e-report.md), with every local and external step classified.
- [x] Multi-project local E2E creates Acme Payments/Identity/Mobile; limits Alice to Payments/Identity; exercises actual CLI remote resolution/switching, isolated and globally bounded combined retrieval, nonleaking Payments+Mobile denial, and the unchanged six-tool digest.
- [ ] Browser/accessibility, live OAuth/provider, remote D1/R2/private bucket, protected Actions Graphify, live MCP/Pi host, OS secret store, and deployment checks remain explicitly BLOCKED with prerequisites in the report.
- [x] Completed the one independent Phase 24 review and its consolidated six-P1 correction pass without a second review: exact D1 `RETURNING` cardinality/identity checks, bounded isolated harness lifecycle, deterministic Git/Python execution, actual identity/CLI auto-resolution and reporting, structural isolation/snapshot assertions, and exact audit/revocation evidence.
- [x] Passed the parent-owned root phase stop gate: `npm run test:e2e:local`, fresh/staged-through-0020 migration integrity, 342 tests (207 API, 42 web, 26 CLI, 26 Pi, 41 adapter), typecheck, Biome lint, and all builds.

### 25. Final architecture and product QA (Prompt 25) — `PENDING`

- [ ] Verify Git truth, derived Graphify, immutable/no-merge graphs, immutable artifact versions, server permissions, provider-neutral MCP, lightweight Pi, bounded context, provenance, safe sync, and free-tier architecture against PRD/architecture/security.
- [ ] Identify deviations without speculative redesign.
- [ ] Product QA: create project, connect Git, upload architecture/ADR, invite teammate, assign roles, generate/inspect graph, sync, search/query, connect Pi, create snapshot, and inspect audit.
- [ ] Report product QA as `PASS`, `FAIL`, `BLOCKED`, or `NICE TO HAVE`, focusing on clarity, reliability, token efficiency, security, and developer experience.
- [ ] Run the phase stop gate.

### 26. Production deployment and live verification — `PENDING`

- [ ] Create real production D1 and private R2 resources; apply fresh ordered migrations and verify indexes/backups/restore procedure.
- [ ] Configure Pages/Worker origins, routes, bindings, production IDs/bucket, exact credentialed CORS, secure cookies, CSP/security headers, caching, rate limits, and redacted observability.
- [ ] Configure GitHub OAuth callback/credentials, GitHub Actions/machine publication secrets, deployment environment protection, least CI permissions, and credential rotation/revocation.
- [ ] Deploy Pages and Worker; verify health, browser flows, live OAuth, remote D1/R2 integrity, private object denial, Graphify CI, sync, MCP, Pi, and E2E.
- [ ] Verify no secrets in source, Pages config, browser bundles, logs, or public buckets; rotate test credentials before launch.
- [ ] Record live URLs/resource identifiers in secure operational configuration, deployment evidence, rollback, incident, and recovery procedures.
- [ ] Run the phase stop gate against the production candidate and stop launch on any failed security/E2E check.

### 27. Success metrics and launch acceptance — `PENDING`

- [ ] Context efficiency: average context tokens/task, irrelevant-context ratio, Graphify response size, and artifact retrieval size.
- [ ] Reliability: graph build success, sync success, failed-update preservation, artifact conflict rate, API errors, graph/sync failures, and graph duration.
- [ ] Developer experience: time to connect a project, time to onboard a developer, and manual context-paste actions avoided.
- [ ] Infrastructure: Worker requests/project, D1 reads/writes/project, R2 storage/project, and GitHub Actions minutes/project.
- [ ] Performance: normal cached dashboard under 2 seconds, near-instant artifact metadata, bounded/predictable retrieval, fast local graph queries, asynchronous graph updates, and nonblocking sync/Pi use.
- [ ] Define collection method, privacy-safe dimensions, baseline/target, review cadence, owner, and alert/action threshold without logging secrets or unnecessary private content.
- [ ] Confirm MVP acceptance: sign-in/project/Git/artifacts/team/graphs/sync/search/query/Pi/snapshots/audit work; isolation holds; snapshots reproduce; context stays bounded; free services can operate the system.
- [ ] Run the final stop gate and retain launch evidence.

## Required endpoint ledger

All project endpoints inherit authenticate -> resolve -> direct membership -> role -> execute, project predicates, bounded validation, nonleaking errors, and audit where applicable.

- [x] `GET /api/health`.
- [x] `GET /auth/github`, `GET /auth/github/callback`, `GET /auth/session`, `POST /auth/logout`.
- [x] `GET/POST /workspaces`.
- [x] `GET/POST /projects`, `GET /projects/:id`, `GET /projects/resolve?repository=...`.
- [x] `GET/POST /projects/:id/artifacts`, `GET /projects/:id/artifacts/:artifactId`.
- [x] `GET/POST /projects/:id/artifacts/:artifactId/versions`, `GET /projects/:id/artifacts/:artifactId/versions/:version`.
- [x] `GET/POST/DELETE /projects/:id/git` and `POST /projects/:id/git/sync`.
- [x] `GET /projects/:id/graphs`, `GET /projects/:id/graphs/latest`, `GET /projects/:id/graphs/:version`, `POST /projects/:id/graphs/build` (authenticated human metadata/reservation only; dispatch remains unavailable until Phase 10).
- [x] `POST /projects/:id/graphs/:version/query` for bounded node search/detail, neighbors, callers/callees, directed path, and sources.
- [x] `POST /projects/:id/context/search` and bounded relevant-context retrieval (substantive search input uses a bounded JSON body, not query strings).
- [x] `GET /projects/:id/team`, invite/accept/revoke, role `PATCH`, and member `DELETE` routes.
- [x] ADMIN-only `PATCH /projects/:id` with exact expected settings revision and deterministic conflict behavior.
- [x] ADMIN-only logical `DELETE /projects/:id/artifacts/:artifactId` with exact expected current version plus lifecycle revision and immutable version-history preservation.
- [x] `GET/POST /projects/:id/snapshots` and snapshot detail retrieval.
- [x] `GET /projects/:id/activity`.
- [x] Bounded `GET /activity` aggregate over directly authorized projects only, with pagination/time bounds and nonleaking isolation.
- [x] `GET /settings` for real account/session and authorized connection/configuration overview; no fabricated values or project mutation.
- [x] `GET/POST /mcp` universal authenticated transport.
- [x] `POST /context/cross-project/search` with independent active/current direct-member/current workspace-member authorization for the complete explicit set before source reads.
- [x] Local sync/graph publication machine endpoints required by the Graphify/CI protocol, with scoped credentials and replay protection.

## Required data model and index ledger

- [x] `users`, `sessions`, `oauth_states` with provider identity uniqueness, hashed tokens/state, expiry indexes.
- [x] `workspaces`, `workspace_members`, `projects`, `project_members` with tenant foreign keys, direct roles, and membership indexes.
- [x] `repository_identities`, `project_repositories` with canonical provider identity uniqueness and resolution index.
- [x] `github_connection_states`, `git_connections`, and `git_audit_events` with hashed expiring connection state, project/provider/repository/default branch/installation reference/known commit/metadata/timestamps, normalized repository identity joins, and project/time audit indexes.
- [x] `artifacts`, `artifact_versions` with immutable checksummed payload metadata and project/type/version indexes.
- [x] Migration 0019 extends `projects` with approved mutable settings revision/evidence and `artifacts` with logical archive status/actor/time/reason/revision while preserving immutable `artifact_versions` and active/archive indexes.
- [x] Generalized immutable `project_audit_events` materialization for required targets/actions with deterministic source identities and project/time plus actor/action indexes; its 309-test root gate passes.
- [~] `graph_versions` and `graph_events` exist with complete build-identity uniqueness, project/version and status/version indexes, one current READY row, lease expiry lookup, constrained lifecycle payloads, and immutable transition events; Phase 9 acceptance additionally requires ADR 0004's additive `graph_build_attempts`, storage-layout marker, selected-publication metadata, and project-first cleanup indexes.
- [x] `context_snapshots`, `snapshot_artifacts` with project and exact-version constraints/indexes.
- [x] `sync_states` with project/client uniqueness/index and local/remote Git/graph state.
- [x] Exact-existing-user team invitation records with project/role/inviter/status/expiry and lookup/expiry indexes; no bearer token or email is stored.
- [x] Separate `machine_principals` and `mcp_principals` with owner, status, allowed operations, direct project scope, optional exact repository binding, and creation/revocation metadata.
- [x] Machine and MCP credentials store only SHA-256 secret hashes with issued/expiry/last-used/revoked/rotation metadata and indexes; plaintext credentials are shown once and never persisted or logged.
- [x] Bounded nonce/idempotency records bind principal, project/repository scope, operation, request identity, and expiry for MCP/local requests and CI graph publication replay prevention.
- [ ] Webhook delivery/idempotency records if webhook flows are enabled.
- [ ] Usage/metrics records only if needed after evaluating privacy and free-tier cost; do not store sensitive payloads.

## External blockers and live prerequisites

These do not justify marking implementation complete and must remain separate from code status.

- [~] Git history/checkpoints and remote CI: repository is on `main` with Phase 9 checkpoint `cad3dce` and Phase 10 checkpoint `3d15a0f`; the locally gated Phase 11 change is awaiting its checkpoint and remote CI has never run.
- [ ] Cloudflare production resources: real D1 ID, private R2 bucket, Pages origin, Worker origin/routes, bindings, migrations, backups, and deployment access.
- [ ] GitHub integration: OAuth app/callback credentials, repository access model/permissions, Actions secrets/permissions, and any webhook secret.
- [x] Graphify research acceptance: corrected source/docs/fixture evidence, output/preflight/schema contract, hosting rejection, and the accepted profile are recorded in [`graphify-integration.md`](graphify-integration.md) and ADR 0003; independent final review reported no P0 or P1 findings and ACCEPT on 2026-09-12. This documentation evidence does not satisfy later implementation or live gates.
- [~] Graphify implementation/live evidence: the isolated adapter and accepted ADR 0004 attempt-scoped Phase 9 implementation passed their independent phase reviews and local gates. Resource sizing, cross-environment determinism, upstream schema compatibility, any future symlink/submodule/LFS support, hash-locked adapter/Actions, machine publication, and a safe live Actions/D1/R2 environment remain unverified.
- [ ] Live test identities/repositories and an approved private-data-safe staging environment for OAuth, D1/R2, CI, MCP, Pi, sync, and E2E verification.
- [ ] Current Cloudflare/GitHub free-tier limits and production observability/rate-limit configuration must be verified at audit time.

## Explicit MVP deferrals

Do not implement these until the MVP ledger, audits, E2E, deployment, and launch metrics pass and a later scope is explicitly approved.

- [ ] Advanced vector/embedding/semantic search and context quality scoring.
- [ ] Billing or mandatory paid infrastructure.
- [ ] SAML/enterprise SSO or additional authentication providers.
- [ ] Giant/full-graph visualization, graph diff, or collaborative Graphify editing/merge.
- [ ] Multiple repositories per project.
- [ ] Extra Git providers (GitLab/Bitbucket), AI providers, agent adapters beyond Pi, or speculative provider/infrastructure adapters.
- [ ] Workspace/global organization context; keep only the small repository `AGENTS.md` global reference and project architecture maps in MVP retrieval.
- [ ] PDF, diagrams, archives, multipart, compressed, executable, and other binary artifact formats until format-specific validation/scanning/quotas exist.
- [ ] Snapshot MCP tools (`create_snapshot`, `get_snapshot`); snapshots remain web/API/Pi command functionality in MVP and the MCP surface stays at six tools.
- [ ] AI-generated documentation, full IDE replacement, complex workflow engine, and multi-cloud infrastructure.
- [ ] Architecture drift detection, artifact approval workflows, PR-aware context, organization-wide context, and other roadmap automation.
