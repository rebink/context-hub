# Context Hub Architecture

Technical architecture for Prompt 0B, derived from the approved requirements, [`project-discovery.md`](project-discovery.md), [`security.md`](security.md), and [`master-plan.md`](master-plan.md). Labels matter: **Current** describes repository code; **Planned** is an accepted design constraint or ordered requirement, not an implementation claim.

## Invariants

1. Git is source-code truth. D1 is tenancy, authorization, version, sync, snapshot, and audit metadata truth. R2 holds immutable payloads.
2. Graphify output is derived from a Git commit, immutable, checksum-backed, and never edited, merged, or overwritten.
3. Artifact versions are immutable. Concurrent publication never silently replaces a newer version.
4. Every project-scoped server operation authenticates, resolves the project, verifies direct membership, checks `ADMIN | EDITOR | VIEWER`, and only then reads or mutates.
5. Context is relevance-first, deduplicated, explicitly budgeted, bounded, and provenance-bearing; neither clients nor prompts receive the whole repository, graph, or artifact set.
6. One provider-neutral MCP endpoint exposes a stable six-tool surface regardless of project count. Pi remains a thin client with approximately zero permanent prompt cost.
7. Local cached use remains useful when the service is unavailable. Failed synchronization preserves the last valid local graph.
8. The MVP uses minimal dependencies and free/open-source-compatible Cloudflare Pages, Workers, D1, R2, GitHub OAuth, and GitHub Actions architecture.

## System architecture

```text
Current
Browser / Vite app on Pages
          |
          | credentialed HTTPS/JSON
          v
Cloudflare Worker ----> AuthProvider ----> GitHub OAuth identity endpoints
     |       |
     |       `--------> ObjectStorage ---> private R2 immutable artifact objects
     `----------------> D1 identity/tenant/artifact metadata

Planned
Git repository / GitHub Actions ---> Graphify build ---> Worker publication API
                                                        |       |
                                                        v       v
                                                       D1      R2
                                                        ^       ^
                                                        |       |
Pi/local client <---- universal MCP / Context Engine / sync APIs
       `------------ local .ai-context cache for offline reads
```

The browser and future local/MCP clients are untrusted input boundaries. Only the Worker may access D1, R2, OAuth secrets, retained provider credentials, and private payloads. Heavy Graphify execution does not run in a normal Worker request or webhook lifecycle.

## Frontend architecture

### Current

- `apps/web` is a vanilla TypeScript SPA built by Vite and deployed as static Pages assets.
- `main.ts` owns session bootstrap, workspace/project navigation, create forms, overview metrics, callback project selection, and view lifecycle. `artifacts.ts` owns artifact UI; `git.ts` owns project repository status and ADMIN connection controls; `graphs.ts` owns Graphify lifecycle/provenance/version history and focused bounded explorer queries; `api.ts` is the credentialed transport wrapper; focused helper modules provide non-authoritative client validation.
- The browser fetches only real API data. Git and Graphify states are active; local sync remains explicitly unavailable rather than fabricated.
- Uploaded text and provider metadata are rendered through DOM `textContent`; request generations and `AbortController` prevent stale project view responses from winning.
- The browser stores only the selected project ID in `localStorage`; it does not store provider/session credentials or trusted roles.

### Planned

- Add Graphify/focused explorer, Team, Snapshots, Activity, and Settings views as their server capabilities land. Viewer presentation is read-only, but server authorization remains authoritative.
- Add loading, empty, error, conflict, stale, and offline states without broad data preloading. Never render an entire graph; graph UI requests bounded node/search/neighborhood/path slices.
- Reuse the one Context Engine freshness classifier rather than implementing UI-specific semantics. Framework/router adoption requires evidence and an ADR if significant; it is not part of the current plan.

## Worker/API architecture

### Current

- `apps/api/src/index.ts` is a native Fetch router for health, OAuth/session, workspace/project, repository resolution, and dispatch to `artifacts.ts` and `graphs.ts`; it composes the single GitHub and R2 adapters.
- Browser mutations require the exact configured `WEB_ORIGIN`; credentialed CORS reflects only that origin. API responses use bounded, stable error codes.
- Current project reads join direct `project_members`; artifact handlers query children by both project and resource ID. Workspace membership alone grants no project read.
- D1 statements are parameterized. Upload bodies, fields, media types, IDs, pages, and cursors are bounded and validated.

### Planned

- Organize later route families into narrow modules without introducing a framework prematurely. Every route keeps authenticate -> resolve -> direct membership -> role -> execute and project predicates.
- Add team, snapshot, activity, and generalized audit APIs in their owning phases only. Bounded context/sync, universal MCP, human graph metadata/build reservation, and Phase 10 machine publication routes are current.
- Graph publication continues to accept uploads/finalization only from the exact CI machine principal; human browser sessions, MCP/local-client principals, including their ADMIN owner, cannot publish bytes.
- Webhooks are optional; if enabled they verify the signature over raw bytes, deduplicate delivery IDs, bind the exact repository, and only schedule work.

## Provider contracts and ownership

Provider neutrality is enforced with the smallest useful contract at the real integration boundary. Each contract initially has exactly one implementation; no factories, service locators, plugin registries, fallback providers, or speculative extra backends are approved. Contract tests plus a short ADR/decision record are required in the owning phase before that phase is complete.

| Contract | Owning phase and initial implementation | Minimal responsibility | Status |
| --- | --- | --- | --- |
| `AuthProvider` | Current-provider seams; GitHub identity OAuth adapter | Build authorization request, exchange callback code, return a validated provider identity; never own app sessions/roles | Current; accepted in [`adr/0001-provider-boundaries.md`](adr/0001-provider-boundaries.md) |
| `ObjectStorage` | Current-provider seams; Cloudflare R2 adapter | Create-only put, head/get, and narrowly controlled compensation delete with object metadata; D1 publication remains domain logic | Current; accepted in [`adr/0001-provider-boundaries.md`](adr/0001-provider-boundaries.md) |
| `GitProvider` | Git connection phase; GitHub App repository adapter | Build installation/user-PKCE URLs, prove user/installation, mint transient exact-repository tokens, and read validated repository/default-branch/current-commit metadata | Current backend; accepted in [`adr/0002-github-app-repository-credentials.md`](adr/0002-github-app-repository-credentials.md) |
| `GraphProvider` | Graphify adapter phase; one `GraphifyAdapter` | Run/validate the accepted `code-only-clustered-v1` profile and expose exact bytes, complete repository/project/build provenance, derived counts, size, generator, and SHA-256; never own project/version/R2/D1/auth | Current in isolated Node-only `packages/graphify-adapter`; ADR 0003 accepted and Phase 8 independently reviewed with final ACCEPT and no findings |
| `ContextProvider` | Context Engine phase; one `ContextEngine` | Execute bounded project-scoped retrieval and return deduplicated evidence with budget/provenance/freshness; never own auth or transport | Current; narrow decision recorded in this document |
| `McpTransport` | Universal MCP phase; one `WorkerMcpTransport` | Decode/encode bounded MCP requests for the stable six tools and dispatch into caller-owned auth/domain logic | Current through accepted [`adr/0007-universal-mcp-authentication-transport.md`](adr/0007-universal-mcp-authentication-transport.md); single review and 219-test root gate complete |

Provider adapters do not bypass domain authorization, choose project scope, or redefine immutable publication. `AuthProvider` does not persist Git credentials; Git identity login and repository access are separate concerns. `ObjectStorage` does not decide keys or metadata truth.

## D1 schema and index ownership

Ordered SQL migrations in `apps/api/migrations` are authoritative. Applied migrations are additive and are not rewritten.

### Current tables

- **Identity:** `users` (unique provider identity), `sessions` (unique token hash, user and expiry indexes), `oauth_states` (hashed state primary key and expiry index).
- **Tenancy:** `workspaces`, `workspace_members`, `projects`, `project_members`; indexes support projects by workspace and memberships by user. Direct project membership is the data boundary.
- **Repository identity and Git:** `repository_identities` has unique canonical/provider-owner-name identity; `project_repositories` allows one active link per project while one identity may serve many projects. Resolution requires a consistent verified connection. `github_connection_states` stores session-bound hashed, expiring installation/authorization state, consumption metadata, and PKCE verifier hashes; `git_connections` stores the current verified GitHub App installation reference, connection identity, and repository metadata.
- **Artifacts:** `artifacts` stores current pointer/status and project metadata; `artifact_versions` stores immutable object metadata and provenance. Indexes support project/type cursor listing and version history.
- **Graphs:** `graph_versions` stores logical build identity/lifecycle and the selected immutable payload, `graph_build_attempts` stores exact lease/publication/object/cleanup ownership keyed by project/version/attempt, and immutable `graph_events` records logical transitions. Migration 0010 preserves selected legacy version-only rows under `LEGACY_V1`; migration 0011 forward-restores bounded constraints and missing migration transition evidence; migration 0012 requires every `ATTEMPT_V2` logical transition to have exact matching attempt state and identity; migration 0013 adds database-time publication fencing and makes retry independent of old-attempt cleanup ownership. All new claims use `ATTEMPT_V2`. Project-first lifecycle and cleanup indexes plus one current READY row are enforced.
- **MCP/local clients:** migration 0015 adds MCP-specific principals, immutable exact project/operation scopes, optional exact repository binding, SHA-256-only expiring/rotatable/revocable credentials, bounded one-hour nonce/rate records, and immutable redacted outcomes. These identities are separate from Phase 10 CI principals.
- **Audit:** `audit_events` is artifact-specific, `git_audit_events` records bounded Git connect/sync/disconnect metadata, and MCP has narrow immutable lifecycle/request outcomes. These are indexed by project/principal/time as applicable; none is the generalized planned audit schema.

### Planned owner tables/indexes

- **Project/artifact administration:** project settings revision and artifact archive actor/time/revision plus active/archive indexes; immutable versions remain untouched.
- **Snapshots phase:** `context_snapshots` and `snapshot_artifacts` own exact Git SHA, graph version, and artifact-version references; index project/time and enforce same-project references.
- **Sync/freshness phase:** `sync_states` owns project+client local/remote Git/graph state and last sync; unique/index project+client.
- **Team phase:** invitations own token hash, project, invitee, role, inviter, status, expiry, and indexed lookup/expiry.
- **Audit phase:** generalized immutable `audit_events` owns project, actor/principal, action, target type/ID, bounded redacted metadata, outcome, and time with project/time index.
- Webhook delivery records exist only if webhooks are enabled; usage records exist only after privacy/free-tier evaluation.

D1 stores no repository clone, graph JSON, artifact body, plaintext session/OAuth/MCP/CI secret, or retained Git token.

## R2 layout and immutable publication

### Current

```text
projects/{projectId}/artifacts/{artifactId}/v/{version}/content
```

The Worker composes `R2ObjectStorage` from `Env.OBJECTS`; all R2 operations, including health, pass through it. Artifact domain logic generates keys. Create-only writes include checksum/content-type/upload ownership metadata. D1 publication follows object success. On D1 failure, compensation deletes only after checking that no matching publication exists; uncertainty leaves an orphan rather than risking data loss. Reads resolve the key through authorized D1 metadata and verify byte size and SHA-256 before returning UTF-8 content. Buckets remain private.

### Graphs and planned snapshots

```text
# Legacy selected objects remain readable and immutable
projects/{projectId}/graphs/v/{graphVersion}/graph.json

# Current physical key; logical graph version/API is unchanged
projects/{projectId}/graphs/v/{graphVersion}/attempts/{attempt}/{publicationId}/graph.json

projects/{projectId}/snapshots/{snapshotId}/manifest.json  # planned
```

Accepted [`adr/0004-attempt-scoped-graph-payloads.md`](adr/0004-attempt-scoped-graph-payloads.md) replaces only ADR 0003's physical-key assumption with attempt-scoped object identity. Claim atomically creates attempt metadata and a random, server-generated, never-reused publication ID/key. Upload and finalize bind the exact project/version/attempt/lease/publication/key, complete build identity, content, checksum, and `uploadId=publicationId`; no attempt may adopt another attempt's object. Finalize selects the physical key, marks the logical version READY, and supersedes only lower READY versions. Exact replay of that selected attempt remains valid when READY or SUPERSEDED only after the full submitted bytes validate and the matching immutable PUBLISHED attempt evidence and R2 metadata are present.

Cleanup may delete only an exact failed/expired unpublished attempt key after grace, a serialized D1 cleanup claim, a fresh no-reference proof immediately before delete, and exact R2 HEAD metadata checks; uncertainty retains the object, releases exact cleanup ownership where possible, and forbids prefix deletion. Retry proceeds independently of an old attempt's cleanup claim because the new attempt has a distinct key. A successful delete leaves the failed attempt recheckable rather than terminal, so a late recreation of the same exact key can be reconciled again. Existing version-only READY/SUPERSEDED objects remain immutable and queryable through a storage-layout marker without move/rewrite. Existing unready rows may retry under v2. Authorized explorer reads continue to resolve selected keys through D1, verify exact metadata/checksum/full format-v1 bytes, and expose neither raw graph bytes nor keys. Snapshot manifests remain planned; quotas and retention still require operational evidence.

## GitHub identity and Git connection

### Current identity flow

1. Generate random OAuth state, store only SHA-256 with expiry/cap, and set an `HttpOnly` state cookie.
2. Redirect to GitHub with no repository scope.
3. Require callback state/query/cookie equality and atomically delete the unexpired state.
4. The single `GithubAuthProvider` exchanges the code server-side, requests GitHub `/user`, validates and normalizes identity, then discards the access token.
5. Upsert the user and issue a random opaque session stored only as SHA-256.

Production cross-site cookies are `Secure; SameSite=None`; local HTTP uses `SameSite=Lax`. The OAuth secret is Worker-only.

### Current repository connection

An ADMIN connects one MVP repository per project through a separate GitHub App flow accepted in [`adr/0002-github-app-repository-credentials.md`](adr/0002-github-app-repository-credentials.md). Two independently hashed, expiring, one-time states separate installation setup from PKCE user authorization and bind both transitions to the exact application session. The adapter verifies that the transient GitHub user matches the logged-in identity, proves the specific selected installation through `/user/installations/{installation_id}/repositories`, signs an in-memory RS256 App JWT, mints a short-lived token restricted to the exact repository, and validates repository/default-branch/head-SHA responses. Publication atomically rechecks consumed flow state after provider calls, invalidates sibling flows, and cannot revive a disconnected or replacement connection. Sync and disconnect use exact optimistic connection predicates and return `409` when stale. D1 stores only installation/reference and connection metadata plus state/verifier/session references; user tokens, App JWTs, installation tokens, client secrets, private keys, and plaintext session tokens are never persisted or returned. The project UI presents role-aware status and ADMIN controls, uses bounded fixed callback messages, and guards project changes with abort/generation checks. Live browser/GitHub/Cloudflare verification remains pending.

## Graphify and graph lifecycle

**Current:** Phase 7 research and ADR 0003 are accepted. Phase 8 is implemented and independently reviewed with final ACCEPT and no findings: the isolated Node-only `GraphProvider` and single `GraphifyAdapter` preflight a detached exact Git commit, run the pinned two-command profile through an injected process boundary, validate exact output bytes with a stdlib-only duplicate-aware Python validator, and return bounded immutable provenance. The package is never imported by the Worker or web application. Phase 9 has attempt-scoped internal publication/storage, authenticated human metadata/reservation routes, a bounded explorer query API, and a role-aware Graphify status/provenance/version-history/focused-explorer frontend. ADR 0004 is accepted and Phase 9 is locally complete through migration 0013 with final bounded review ACCEPT. Phase 10 machine credentials, exact publication transport, migration 0014, complete hash lock, separately pinned trusted tooling checkout, and fail-closed canonical workflow are locally complete under ADR 0005 after the single phase review and 154-test gate; live bounded-runner/remote deployment evidence remains pending.

**Current adapter contract / canonical execution:** the adapter runs pinned `graphifyy==0.9.58` on Python 3.11/3.12 against a detached exact commit; GitHub Actions integration belongs to Phase 10. The host must configure Git, Python, and Graphify as canonical absolute paths to trusted regular executable files outside the canonical checkout; the adapter rejects missing, relative, symlinked, non-executable, checkout-local, or changed paths and never resolves bare names or inherits ambient `PATH`. V1 subprocesses receive the fixed absolute-only `PATH=/usr/bin:/bin`. V1 is POSIX-only and fails with stable redacted `UNSUPPORTED_PLATFORM` before any subprocess or temporary output creation unless detached process-group signaling, `O_NOFOLLOW`, and `O_NONBLOCK` are available. Windows remains unsupported until Job Object or equivalent process-tree containment and safe output behavior is implemented and tested. Before execution it rejects dirty/untracked files, every tracked symlink, submodules/gitlinks, and LFS pointers; clean status alone is insufficient. It creates a new empty absolute external directory, supplies the same `GRAPHIFY_OUT` in a scrubbed environment to `extract --code-only --no-cluster` and then `cluster-only --no-label --no-viz`, and accepts exactly `${GRAPHIFY_OUT}/graph.json` after both zero exits without assuming `--out` on `cluster-only`. It preserves and hashes exact bytes without reserialization.

Format v1 applies the detailed fail-closed contract in [`graphify-integration.md`](graphify-integration.md): exact top-level fields/types, `directed=false`, `multigraph=false`, lowercase matching `built_at_commit`, required typed node/link fields, unique IDs and valid endpoints, fixed confidence/location/path rules, empty hyperedges, duplicate-key rejection, bounded scalar unknown node/link fields, and explicit depth/key/string/byte/count limits. Every raw numeric token uses JSON's ASCII grammar, is at most 128 characters, and must convert to a finite JavaScript binary64 value; binary64 underflow is accepted as JavaScript accepts it, while overflow is rejected. A dependency-free Worker validator applies the full byte/schema boundary at publication and read time and requires schema-safe normalized relative POSIX paths; the Node adapter separately remains authoritative for tracked regular-file provenance because the Worker has no checkout manifest. These are Context Hub rules derived from one 0.9.58 fixture, not an upstream formal schema.

```text
reserve version -> QUEUED -> BUILDING -> validate/checksum -> immutable R2 object
                      ^          |                                  |
                      |          v                                  v
                      +------- FAILED                         D1 READY metadata
                                                              |
                                                       prior READY -> SUPERSEDED
```

Build identity and graph metadata include repository provider, stable provider repository ID, immutable normalized identity snapshot, project ID, source commit, Graphify version, adapter version, profile, and format version. An unchanged complete identity reuses its reservation/result; a replacement repository at the same name/commit can never reuse the old graph. `FAILED` may retry to `QUEUED` on the same unready reserved version with an incremented attempt. `generated_at` means READY publication. READY is immutable forever, and a failed/uncertain build never replaces latest READY. Reservation and retry must atomically recheck current direct `ADMIN` membership.

Under accepted ADR 0004, publication remains private immutable R2 object-first and transactional D1 READY transition/supersede, but each claim owns a unique attempt-scoped publication ID/key and D1's current UTC time independently fences lease expiry. Exact same-attempt replay is deterministic even after SUPERSEDED; cross-attempt adoption is forbidden, and late attempts can orphan only their own key. Graphify watch/update, local authoritative generation, upstream MCP/HTTP, direct R2 publication, semantic extraction, and graph merge/global/PR output are rejected. ADMIN alone triggers/retries builds and manages CI credentials; interactive cancellation is deferred beyond MVP. Runner termination or lease expiry makes the active attempt `FAILED`; a later authenticated claim reconciles expiry using D1 time and creates a distinct incremented attempt, while late completion is rejected by current lease plus attempt/publication identity. Successful machine lifecycle audits are D1-triggered in the same statement as their attempt transitions. All direct members may later read/query bounded READY graphs; only an exact project/repository/operation/lease/attempt/publication-bound machine principal uploads/finalizes.

## Context Engine

**Current:** Phase 12 implements the minimal provider-neutral `ContextProvider` and exactly one `ContextEngine`; there is no factory, registry, cache, vector index, or alternate backend. The contract accepts project ID, query, optional domain/package, and explicit token and byte ceilings. Authentication, current direct-membership authorization, Origin enforcement, and HTTP transport remain in the Worker route.

The implementation uses query-aware metadata ordering before reading at most 24 project-predicated current artifact versions (and at most 64 KiB per payload), one current READY graph only when its immutable repository identity matches the current verified Git connection and its verified payload is at most 512 KiB, current verified Git metadata, and compact versioned built-in architecture guidance derived from the checked-in project invariants. Artifact and graph R2 bytes are resolved only from authorized D1 rows and exact server-defined keys beneath the requested project's namespace; mismatched artifact or graph keys fail before R2 HEAD/get. Artifact HEAD size, HTTP/custom content type, and checksum metadata must exactly match D1 before download, followed by exact byte-size/checksum verification. Graph reads retain the existing HEAD/upload identity and format-v1 checks. It ranks task/package/domain matches, architecture evidence, current provenance, and bounded source-backed graph relationships; deduplicates excerpts; computes token cost from each complete serialized evidence object; and then applies one global token/byte budget. Every result has one fixed provenance shape with exact project/source/path/section/version/commit/checksum fields, nullable only when a source has no applicable value. Built-in generated guidance truthfully uses null path/commit with its own stable version and checksum rather than claiming repository provenance.

`classifyArtifactFreshness` is the shared `CURRENT | STALE | UNKNOWN` classifier. It returns `CURRENT` only for equal valid lowercase 40-hex artifact/current commits, `STALE` for unequal valid commits, and `UNKNOWN` for missing or invalid provenance. It annotates applicable context evidence and never rewrites artifacts. Phase 13 executable overlap scenarios now cover relevant architecture plus capped graph relationships, unrelated exclusion, independently measured budgets, exact provenance for each artifact state, calibrated pre-budget deduplication, all freshness states, honest current-row/repository/status/order predicates, HEAD-before-get R2 behavior, and repeated uncached cross-project isolation. Context Engine validates base64url project/artifact/publication IDs, positive bounded versions/attempts, exact supported graph layout semantics, and derived keys before storage access; tests admit valid current artifact versions plus both legacy and attempt-scoped graphs while rejecting malformed components with zero R2 calls. The implementation has no cache, so there is no cross-principal cache state; any future cache/index must be principal- and project-namespaced. Cross-project retrieval remains deferred and must independently authorize every project before any read. Phase 13's single review and 200-test full stop gate are complete.

## Universal MCP and Pi

### MCP (current; complete locally)

Accepted [`adr/0007-universal-mcp-authentication-transport.md`](adr/0007-universal-mcp-authentication-transport.md) defines one authenticated `GET/POST /mcp` endpoint for all authorized projects. Its stable read-only tools are exactly `project_info`, `search_context`, `get_artifact`, `query_graph`, `get_sources`, and `sync_status`; schemas contain bounded selectors rather than project enumerations and remain constant with project count. One mutually exclusive selector supplies a normalized local repository identity, explicit project, or explicit cross-project set. Selection never grants access. The Worker authenticates a separate MCP/local-client principal, verifies credential scope, current workspace membership, current direct project membership/role, and optional exact current repository binding for the complete set before any domain read. Partial authorization fails all-or-nothing without project detail.

The minimal `McpTransport` handles only 16 KiB JSON-RPC decode, stable dispatch, error encoding, and a 128 KiB response ceiling. Exactly one `WorkerMcpTransport` implements POST `initialize`, initialized notification, `ping`, `tools/list`, and `tools/call`; authenticated GET explicitly reports that server notifications are unsupported. Authentication/resolution/audit and tool behavior remain domain logic. Search reuses `ContextEngine`; graph tools reuse current-repository selection, private-R2 verification, the full graph validator, and bounded explorer query; artifact bytes use exact derived keys, HEAD/byte/checksum/UTF-8 verification and bounded excerpts.

MCP credentials contain 256 random bits, are displayed once, accepted only in Authorization, and stored only as SHA-256. Immutable principal scopes carry exact tool/project sets and optional provider/stable-ID/canonical repository binding. D1-clock issue/expiry/last-use/revocation/rotation metadata, one-hour unique nonces, 120-request/minute and 1,000-live-nonce limits, exact-Origin ADMIN lifecycle mutations, and non-sensitive immutable outcomes are implemented in migration 0015. OS credential-store integration belongs to the later client phase. Live client/remote D1/log-redaction/rate tuning remains release evidence; Phase 15 token measurement remains deferred.

### Pi (planned)

The Pi extension offers thin native commands: `/context connect`, `/context status`, `/context sync`, `/context search`, `/context graph`, and `/context snapshot`. It normalizes the local Git remote, resolves zero/one/many authorized projects, caches explicit selection locally, and calls Context Hub/MCP rather than duplicating Graphify or retrieval. It adds no provider-specific model behavior, agent architecture, bulk injection, or unnecessary tools; cached use does not block when cloud service is unavailable.

## Artifact conflicts and versioning

### Current

Artifacts have a mutable metadata row/current pointer and immutable `artifact_versions`. Publishing requires `expectedVersion`; a stale writer receives deterministic `409 CONFLICT` with the authorized current version. The UI preserves the draft, requires explicit latest-version review, and never auto-retries. Historical bytes, checksum, type, size, source commit, change note, author, and timestamp remain retrievable and verified.

### Planned

Logical archive/delete changes metadata only and preserves all versions. Project settings and artifact lifecycle mutations use explicit revision preconditions. Freshness classification annotates results/UI but never modifies an artifact. Binary formats remain deferred until format-specific validation, scanning, and quotas exist.

## Graph sync and atomic local replacement

**Current:** accepted [`adr/0006-local-sync-cache.md`](adr/0006-local-sync-cache.md) defines the Phase 11 transport and cache. The dependency-light Node CLI exposes `context connect`, `context status`, and `context sync`; bounded Worker routes return direct-member project/repository/graph metadata and exact current-READY bytes only after private-R2 validation. Phase 11 temporarily consumes the existing opaque human session from `CONTEXT_HUB_SESSION` or an OS-secret helper that injects it and requires a separately supplied matching `CONTEXT_HUB_API` origin before sending it; no token enters repository files, a repository edit cannot redirect it, and no later local-client principal API is implemented.

The fixed `.ai-context/` layout contains `manifest.json`, `graph/graph.json`, `graph/meta.json`, `artifacts/`, and `cache/`; artifact/cache directories are empty except bounded crash-recovery files in this phase. Sync compares local Git, verified local graph source/version, known remote Git, and remote graph with ADR-defined deterministic precedence for `CURRENT`, `GRAPH_STALE`, `LOCAL_REPOSITORY_AHEAD`, `REMOTE_GRAPH_AHEAD`, `NO_LOCAL_GRAPH`, `GRAPH_BUILDING`, `GRAPH_FAILED`, and `COMMIT_MISMATCH`.

Update order is bounded authenticated download -> exact repository provenance/metadata/size/checksum/source verification -> duplicate-aware full format-v1 validation -> exclusive no-follow project-contained temporary writes and file/directory fsync -> atomic graph/meta rename -> manifest replacement last. A process-owned mutation lock serializes recovery, reads, and updates; dead owners are recovered. Persisted prior copies and a transaction marker provide startup rollback after interruption. Fixed contained paths, retained directory device/inode checks, and existing-layout checks reject replaced parents, symlinks, and traversal/escape shapes; no archive is accepted. Every command revalidates the live Git remote before network access. Failure preserves the previous valid selection, while network/timeout/retryable-service failures use offline status and verified local graph reads do not contact the service.

## Snapshots and freshness

**Current:** artifact versions may carry a source commit, but no classifier, snapshot, or persisted client sync state exists.

**Planned:** a snapshot references project, name, exact Git SHA, graph version, exact artifact versions, creator, and time rather than copying payloads. An optional immutable R2 manifest repeats these references/checksums for reproducibility; D1 remains metadata truth. Creation validates that every referenced version belongs to the authorized project. Freshness uses the shared classifier and known repository commit, reports unknown provenance honestly, and never rewrites historical records.

## Authentication and authorization

Human browser sessions are opaque cookie credentials; current CI machine and MCP/local-client principals are separate from human sessions and from each other. Authentication establishes an identity, never a role or project grant. Authorization always derives current membership from D1. Inaccessible resource responses expose no project/repository/artifact/graph/path/member existence; known members lacking mutation capability receive `403` where appropriate. Cross-project operations authorize all scope before any retrieval. Role changes/removal later invalidate affected credentials/caches as required and protect the final admin.

## Audit and observability

### Current

Artifact publication and Git connect/sync/disconnect insert domain-specific audit rows without credentials or payload bodies. Errors are returned as generic codes. There is no generalized activity API, metrics store, or production observability configuration.

### Planned

General audit covers project settings, artifact lifecycle, Git connect/disconnect, invitations/roles/removal, graph build/publication/failure, snapshots, sync, MCP, and machine credential lifecycle according to the approved denial/failure policy. Events include actor/principal, project, action, target, bounded redacted metadata/outcome, and time; they never contain tokens, credentials, private bodies, or unnecessary source content.

Operational signals include API errors, graph duration/failure, sync failure, artifact conflicts, MCP calls and bounded sizes, context result size, auth abuse, and storage/integrity failures. Logs redact authorization headers, callback codes, cookies, storage credential references, provider payload secrets, and artifact/graph content. Before launch, define rate limits, alerts, backups, restore exercises, and privacy-safe success metrics.

## Security architecture

[`security.md`](security.md) is the detailed threat model. Mandatory controls include exact Origin/CORS/callback configuration; hashed expiring state/sessions/machine secrets; least privilege and secret-store bindings; project-predicated D1 queries; private R2 with checksum verification; bounded input/output; safe inert rendering; SSRF allow-lists; raw-body webhook verification; replay/idempotency controls; path containment; nonleaking denials; CSP and security headers; lockfile/CI permissions; and tested backup/restore. Live-provider and remote Cloudflare validation remain release gates because local fakes cannot prove platform behavior.

## Free-tier and performance constraints

- Pages serves static frontend assets; Worker handles bounded API orchestration; D1 stores indexed metadata; R2 stores immutable payloads; GitHub Actions performs heavy graph builds.
- Avoid polling, full-table scans, unbounded lists/search, repository copies in D1, graph generation in Worker requests, duplicate commit builds, duplicate uploads, and per-project MCP servers/schemas.
- Prefer cursor pagination, project-first indexes, caching with authorization-safe namespaces, content hashes, commit deduplication, event-driven triggers, immutable object reuse, and local graph queries.
- Targets are normal cached dashboard under two seconds, near-instant artifact metadata, bounded predictable context, fast local graph queries, asynchronous graph update, and nonblocking Pi/sync use. Current limits and measured consumption must be verified in the free-tier audit; they are not assumed here.

## Local/offline behavior

The current web application requires the Worker. Planned local/Pi operation is local-first: Git remains usable independently; status and graph queries use verified local manifest/graph/artifact/offline caches; a cloud outage reports stale/offline state rather than destroying data or blocking normal development. Cloud-only mutations queue/retry only where an approved replay-safe protocol exists. Credentials never enter `.ai-context`, Git, prompts, logs, or cache payloads.

## Deployment and configuration

### Current

- `apps/web`: Vite build for Cloudflare Pages; local Vite proxies API/auth/project/workspace paths. `VITE_API_URL` is the only documented public web endpoint setting.
- `apps/api`: Worker with `DB`, `OBJECTS`, `APP_ENV`, `WEB_ORIGIN`, `API_ORIGIN`, and server-only GitHub OAuth bindings. `API_ORIGIN` is required, origin-only, and HTTPS in production; configured HTTP is accepted only outside production for local use. Wrangler contains local values and placeholder production resources.
- GitHub Actions defines install, local migration, test, typecheck, lint, and build on PRs and `main`, but the repository has no commit/remote run evidence.

### Planned release requirements

Provision private production D1/R2, apply migrations, configure exact origins/routes/bindings and OAuth callback, keep secrets in Wrangler/CI secret stores, add security headers/rate limits/redacted observability/backups, deploy Pages/Worker, and verify browser OAuth, remote integrity/private-object denial, Graphify CI, sync, MCP, Pi, and end-to-end flows. No phase or deployment advances unless tests, typecheck, lint, and build pass; significant architecture choices additionally require their accepted ADR and contract tests.
