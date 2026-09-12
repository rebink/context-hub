# Context Hub Implementation Status

Last updated: 2026-09-15

The durable, exhaustive phase and acceptance ledger is [`docs/ai/master-plan.md`](master-plan.md). This file remains the concise current-state summary.

## Current State

- [x] Phase 9 immutable graph versions, attempt-scoped publication, bounded explorer, and role-aware UI are implemented through additive migration 0013. The full local gate passes 140 tests (78 API, 26 web, 36 adapter), migration integrity, typecheck, Biome lint, and Worker/Vite/adapter builds; final bounded review returned ACCEPT. Browser/live Cloudflare verification remains an external release gate.
- [x] Phase 11 local sync is complete locally from Phase 10 checkpoint `3d15a0f`; its one independent review is complete, the complete P1 set is fixed, and the 178-test full stop gate passes. Remote CI has not run.
- [x] Phase 12 Context Engine is complete locally from checkpoint `9c0702a`: one minimal `ContextProvider`/`ContextEngine`, query-aware bounded single-project retrieval, complete-evidence token accounting, current-repository graph selection, exact provenance, private artifact HEAD/byte verification, and the shared freshness classifier pass the single review and 192-test full gate.
- [x] Phase 13 Context Engine executable acceptance scenarios are complete locally from checkpoint `de8a832`: overlap-heavy relevance/exclusion/capped-graph/exact-provenance/calibrated-deduplication/freshness coverage, independently measured token/byte budgets, valid legacy/current and malformed storage-key matrices, strict SQL and HEAD-before-get fakes, and repeated uncached isolation pass the single review and 200-test full gate.
- [x] Phase 14/B universal MCP is complete locally from checkpoint `8f128d1`: accepted ADR 0007, additive migration 0015, separate sealed-scope/hash-only MCP credentials, one bounded Worker transport, standards-compatible initialize/notification handling, exact six-tool universal endpoint, all-or-nothing caller-bounded cross-project authorization, pre-decode replay/rate/audit controls, exact lifecycle auditing, and SQL-sensitive tests pass the single review and 219-test root gate.
- [x] Phase 15 MCP token audit is complete locally from Phase 14 checkpoint `cef956a`: the executable audit measures the actual exported six-tool schemas, production limits, and transport encoding; proves the 4,082-byte schema is identical for 1, 10, and 100 authorized projects; measures required success/denial fixtures; and locks the 135,154-byte conservative schema-plus-response bound in [`mcp-token-budget.md`](mcp-token-budget.md). The single review, consolidated two-item P1 fix pass, and 222-test root gate are complete.
- [x] Phase 16/C Pi integration is complete locally from checkpoint `b7cd40e`: one native `/context` command family reuses the local CLI and MCP, resolves the normalized repository with explicit ambiguity handling/switching, consumes environment/OS-helper-injected human and scoped MCP credentials, preserves offline status and verified cached graph use, and keeps snapshots unavailable. Its single review, consolidated four-item P1 correction pass, and 245-test root gate are complete; external live Pi/TUI and OS-helper evidence remains pending.
- [!] Production D1 ID, R2 bucket, Pages origin, and Worker origin remain placeholders. GitHub OAuth credentials and live Cloudflare resources are not configured.
- [!] No browser, live OAuth, remote D1/R2, or deployment end-to-end test has run.

## Completed

- [x] Discovery, architecture, and threat model: `docs/ai/project-discovery.md`, `docs/ai/architecture.md`, `docs/ai/security.md`.
- [x] Phase 1 foundation: npm workspaces, TypeScript, Vite/Pages frontend, Worker API, D1, R2, migrations, CI, local development, tests, lint, typecheck, and build.
- [x] Prompt 2 authentication/projects: GitHub identity OAuth behind the single `GithubAuthProvider`, hashed one-time state, opaque hashed sessions, logout, workspaces, projects, direct project membership, ADMIN/EDITOR/VIEWER checks, and nonleaking project authorization.
- [x] Project dashboard: real project/member/artifact counts, active Git status, Graphify status/explorer navigation, and an honest sync placeholder.
- [x] Phase 4 artifacts and current artifact UI: 13 canonical types, immutable R2 objects behind the single `R2ObjectStorage`, D1 metadata, SHA-256 verification, bounded text uploads, pagination, version history, optimistic conflicts, audit events, role enforcement, verified content, and source-commit provenance.
- [x] Phase 5A current provider seams: minimal `AuthProvider` and `ObjectStorage` contracts, exactly one GitHub/R2 implementation each, focused contract tests, and accepted [`adr/0001-provider-boundaries.md`](adr/0001-provider-boundaries.md).
- [x] Multi-project foundation core: tenant hierarchy, multiple workspaces/projects, normalized GitHub remotes, authorized none/unique/ambiguous resolution, and isolation tests.
- [x] Phase 6 backend: accepted GitHub App credential ADR, minimal `GitProvider` and one GitHub adapter, exact-session-bound two-state PKCE flow, specific-installation proof, exact-repository short-lived tokens, mutation-time ADMIN checks, stale-flow suppression, atomic sync metadata/audit, verified unique project links/resolution, strict callback origin configuration, D1 metadata/audit, and local migration integrity evidence.
- [x] Master-plan Phase 7 / Prompt 7 Graphify research: corrected 0.9.58 evidence, reject-all symlink/submodule/LFS preflight, exact shared-`GRAPHIFY_OUT` recipe, repository-bound identity, fail-closed format-v1 schema/bounds, lifecycle, security, and rejected alternatives are documented in [`graphify-integration.md`](graphify-integration.md) and accepted ADR 0003. Independent final review reported no P0 or P1 findings and ACCEPT on 2026-09-12.
- [x] Master-plan Phase 8 / Prompt 8 Graphify adapter: the isolated Node-only workspace implements the single `GraphProvider`/`GraphifyAdapter`, POSIX-only fail-closed runtime gate, exact-commit Git preflight/postflight, two-command environment, exact-byte output/integrity, strict Python validation, retained fixture, and contract/security tests. Independent final review returned ACCEPT with no findings after the complete implementation and 86-test gate.
- [x] Master-plan Phase 9 / Prompt 9 graph versions: ATTEMPT_V2 immutable physical keys, D1-clock lease fencing, exact attempt evidence, private R2 publication/replay, retry-safe orphan cleanup, bounded human explorer routes, and the role-aware frontend pass 140 local tests and final bounded P0/P1 review.
- [x] Master-plan Phase 10 / Prompt 10 CI graph generation: ADR 0005, migration 0014 machine principals/hashed credentials/nonces/atomic lifecycle audits, exact machine claim/publish/fail transport, independently pinned tooling checkout, complete Python hash lock, host resource attestation, bounded ambiguous-publish replay, and expiry recovery pass the single phase review plus 154-test local gate. Live runner and remote Cloudflare evidence remain release gates.
- [x] Master-plan Phase 11 / Prompt 11 local sync: accepted ADR 0006, the Node CLI workspace, existing-session environment/OS-secret boundary, current-repository-scoped member-only Worker metadata/download routes, live-remote validation, deterministic status classifier, duplicate-aware full format-v1 verification, mutation locking, retained parent-directory identity checks, rollback-backed atomic graph/meta replacement, manifest-last selection, retryable-service offline fallback, and verified offline reads pass the single review plus the 178-test full gate. Live remote and OS secret-helper evidence remain external.

## Partial

- [~] Authentication/projects scope beyond Prompt 2: member invitation, removal, and role-management APIs/UI are deferred.
- [~] Phase 6 / remaining task #2: the backend and project repository UI fixes pass locally, including demotion/removal race rejection, every-request sync audit rollback, callback-to-authorized-project binding, verified-GET success announcements, recovery states, focus restoration, and narrow mobile styling. The overall phase remains partial pending independent final-review acceptance. Live browser/GitHub App/Cloudflare verification remains a separate external release blocker.
- [~] Audit history: artifact and redacted Git lifecycle events exist, but generalized project/member/graph/snapshot auditing and audit UI do not.
- [~] Artifact UI freshness is pending: Phase 12 now provides the shared `CURRENT | STALE | UNKNOWN` classifier and Context Engine exposure, while artifact UI and sync-state persistence integration remain deferred to Phase 19.
- [~] Artifact formats: Markdown, text, JSON, and YAML work; PDF, diagrams, binary, and multipart uploads are intentionally deferred.
- [~] Git/D1/R2 source-of-truth separation is implemented for artifacts and attempt-scoped graphs. Migrations 0010-0013 preserve legacy graphs; migration 0014 adds CI machine principals/credentials; migration 0015 separately adds scoped MCP/local-client principals, hash-only credentials, replay/rate records, and immutable narrow audits. Snapshot, sync-state, and generalized audit schemas remain pending.

## Remaining Work — Required Order

Every significant architecture choice first needs an approved ADR. The mandatory gates include Git credentials, Graphify integration, MCP authentication/transport, local sync/cache behavior, and cross-project retrieval.

1. [~] Obtain independent Phase 6 final-review acceptance for the locally passing backend/UI fixes and operational ADR. Then complete live browser/GitHub App/Cloudflare verification as an external release gate; neither review nor live evidence is claimed complete here.
2. [x] Phase 9 is locally complete through migration 0013 and final bounded review ACCEPT. Browser/live Cloudflare verification remains part of the external release gate.
3. [x] Phase 10 CI graph generation is locally complete through migration 0014 after its single review and 154-test gate. Live bounded-runner benchmarks and remote D1/R2 publication remain external release gates.
4. [x] Phase 11 local sync is locally complete after one review, one consolidated P1 fix pass, and the 178-test full stop gate. Live Worker/D1/R2 sync, OS secret-helper handoff, and target-filesystem crash evidence remain external release gates.
5. [x] Phase 12 `ContextProvider` and Context Engine are complete locally after one review, one consolidated five-item P1 fix pass, and the 192-test full gate.
6. [x] Phase 13 Context Engine scenarios are complete locally after one review, one consolidated P1 fix pass, and the 200-test full gate.
7. [x] Phase 14/B universal MCP is complete locally after one review, one consolidated seven-item P1 fix pass, fresh/staged migration integrity, and the 219-test root gate.
8. [x] Phase 15 MCP schema/response token audits are complete locally after one review, one consolidated two-item P1 fix pass, and the 222-test root gate.
9. [x] Phase 16/C Pi integration is complete locally after one review, one consolidated four-item P1 pass, and the 245-test root gate; external live Pi/TUI evidence remains a release gate.
10. [ ] Perform the separate Phase 17 Pi token audit.
10. [ ] Add immutable snapshots, then integrate the shared freshness classifier into artifact UI and persist/index sync state.
11. [ ] Add team invitations, acceptance, removal, and role changes.
12. [ ] Add ADMIN-only project update/settings and logical artifact archive/delete, including immutable-history preservation, expected-version conflicts, audit, UI, endpoint/data-model acceptance, and role/isolation tests.
13. [ ] Complete generalized audit-event coverage and project audit history UI.
14. [ ] Approve the cross-project retrieval ADR; implement explicit all-project-authorized, bounded cross-project context retrieval.
15. [ ] Complete remaining management UI: global Activity aggregated only across directly authorized projects via a bounded API; minimal real-data account/session and connection/configuration Settings; and remaining project Git, Graphify, Team, Snapshot, Activity, and Settings surfaces. No fake data.
16. [ ] Run security, free-tier, single-project E2E, multi-project E2E, final architecture, and product QA reviews.
17. [ ] Configure production resources, deploy, and complete live OAuth, D1/R2, browser, Graphify, sync, MCP, and Pi verification.
18. [ ] Establish, collect, and review the required context-efficiency, reliability, developer-experience, infrastructure, and performance success metrics.

Every step must stop unless tests, typecheck, lint, and build pass. Detailed dependencies and acceptance checks are maintained in [`docs/ai/master-plan.md`](master-plan.md).
