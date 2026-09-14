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
- `main.ts` owns session bootstrap, URL/history-backed global and project navigation, create forms, callback project selection, invitation inbox, and abortable view lifecycle. `overview.ts` loads real current Git/graph/sync status; `artifacts.ts` owns Context artifact UI; `git.ts`, `graphs.ts`, `team.ts`, `snapshots.ts`, and `activity.ts` own their project surfaces; `management.ts` owns global authorized Activity and read-only account/configuration Settings; `api.ts` remains the credentialed transport wrapper.
- The browser fetches only real API data. The Overview reports current Git, READY graph, and persisted client sync truth, including honest absent/offline/error states; no count, connection, preference, or status is fabricated.
- Uploaded text and provider metadata are rendered through DOM `textContent`; request generations and `AbortController` prevent stale project view responses from winning.
- The browser stores only the selected project ID in `localStorage`; it does not store provider/session credentials or trusted roles.

### Planned

- Live browser execution must verify deep links, back/forward/reload, keyboard focus, labels, responsive/mobile layout, system dark mode, reduced motion, and accessibility in the external Phase 24 gate. Deterministic dependency-minimal route and role contracts do not replace this evidence.
- Continue to keep loading, empty, error, conflict, stale, and offline states bounded without broad data preloading. Never render an entire graph; graph UI requests bounded node/search/neighborhood/path slices.
- Reuse the one Context Engine freshness classifier rather than implementing UI-specific semantics. Framework/router adoption requires evidence and an ADR if significant; it is not part of the current plan.

## Worker/API architecture

### Current

- `apps/api/src/index.ts` is a native Fetch router for health, OAuth/session, workspace/project, repository resolution, and dispatch to `artifacts.ts` and `graphs.ts`; it composes the single GitHub and R2 adapters.
- Browser mutations require the exact configured `WEB_ORIGIN`; credentialed CORS reflects only that origin. API responses use bounded, stable error codes. One outer Worker response boundary applies CSP/frame denial, nosniff, strict referrer/permissions policy, and production-only HSTS to redirects, errors, preflights, JSON, MCP, and downloads.
- Current project reads join direct `project_members`; artifact handlers query children by both project and resource ID. Workspace membership alone grants no project read.
- D1 statements are parameterized. Upload bodies, fields, media types, IDs, pages, and cursors are bounded and validated.

### Planned

- Organize later route families into narrow modules without introducing a framework prematurely. Every route keeps authenticate -> resolve -> direct membership -> role -> execute and project predicates.
- Team APIs are current through `team.ts`; `activity.ts` provides current direct-member-only project activity list/detail reads. `management.ts` provides a 30-day-default/90-day-maximum, 50-event-page global aggregate whose event query joins direct project and current workspace membership, plus a 100-project read-only account/session/configuration overview under the same authorization boundary. Snapshot APIs, bounded context/sync, universal MCP, human graph metadata/build reservation, and machine publication routes are current.
- Graph publication continues to accept uploads/finalization only from the exact CI machine principal; human browser sessions, MCP/local-client principals, including their ADMIN owner, cannot publish bytes.
- Webhooks are optional; if enabled they verify the signature over raw bytes, deduplicate delivery IDs, bind the exact repository, and only schedule work.

## Provider contracts and ownership

Provider neutrality is enforced with the smallest useful contract at the real integration boundary. Each contract initially has exactly one implementation; no factories, service locators, plugin registries, fallback providers, or speculative extra backends are approved. Contract tests plus a short ADR/decision record are required in the owning phase before that phase is complete.

| Contract | Owning phase and initial implementation | Minimal responsibility | Status |
| --- | --- | --- | --- |
| `AuthProvider` | Current-provider seams; GitHub identity OAuth adapter | Build authorization request, exchange callback code, return a validated provider identity; never own app sessions/roles | Current; accepted in [`adr/0001-provider-boundaries.md`](adr/0001-provider-boundaries.md) |
| `IdentityLookupProvider` | Team phase; one bounded GitHub public-identity lookup adapter | Resolve a normalized current login to the provider's current stable user ID/login; never create or update a local identity or decide invitation authority | Current; narrow Phase 20 identity-authority boundary |
| `ObjectStorage` | Current-provider seams; Cloudflare R2 adapter | Create-only put, head/get, and narrowly controlled compensation delete with object metadata; D1 publication remains domain logic | Current; accepted in [`adr/0001-provider-boundaries.md`](adr/0001-provider-boundaries.md) |
| `GitProvider` | Git connection phase; GitHub App repository adapter | Build installation/user-PKCE URLs, prove user/installation, mint transient exact-repository tokens, and read validated repository/default-branch/current-commit metadata | Current backend; accepted in [`adr/0002-github-app-repository-credentials.md`](adr/0002-github-app-repository-credentials.md) |
| `GraphProvider` | Graphify adapter phase; one `GraphifyAdapter` | Run/validate the accepted `code-only-clustered-v1` profile and expose exact bytes, complete repository/project/build provenance, derived counts, size, generator, and SHA-256; never own project/version/R2/D1/auth | Current in isolated Node-only `packages/graphify-adapter`; ADR 0003 accepted and Phase 8 independently reviewed with final ACCEPT and no findings |
| `ContextProvider` | Context Engine phase plus Task D; one `ContextEngine` | Execute bounded single- or explicit cross-project retrieval and return globally ranked evidence with budget/provenance/freshness; never own auth or transport | Current; Task D semantics accepted in [`adr/0008-explicit-cross-project-context.md`](adr/0008-explicit-cross-project-context.md) |
| `McpTransport` | Universal MCP phase; one `WorkerMcpTransport` | Decode/encode bounded MCP requests for the stable six tools and dispatch into caller-owned auth/domain logic | Current through accepted [`adr/0007-universal-mcp-authentication-transport.md`](adr/0007-universal-mcp-authentication-transport.md); single review and 219-test root gate complete |

Provider adapters do not bypass domain authorization, choose project scope, or redefine immutable publication. `AuthProvider` does not persist Git credentials; Git identity login and repository access are separate concerns. `ObjectStorage` does not decide keys or metadata truth.

## D1 schema and index ownership

Ordered SQL migrations in `apps/api/migrations` are authoritative. Applied migrations are additive and are not rewritten.

### Current tables

- **Identity:** `users` (unique provider identity), `sessions` (unique token hash, user and expiry indexes), `oauth_states` (hashed state primary key and expiry index).
- **Tenancy:** `workspaces`, `workspace_members`, `projects`, `project_members`; indexes support projects by workspace and memberships by user. Direct project membership is the data boundary.
- **Repository identity and Git:** `repository_identities` has unique canonical/provider-owner-name identity; `project_repositories` allows one active link per project while one identity may serve many projects. Resolution requires a consistent verified connection. `github_connection_states` stores session-bound hashed, expiring installation/authorization state, consumption metadata, and PKCE verifier hashes; `git_connections` stores the current verified GitHub App installation reference, connection identity, and repository metadata.
- **Artifacts:** `artifacts` stores current pointer/status and project metadata; `artifact_versions` stores immutable object metadata and provenance. Indexes support project/type cursor listing and version history.
- **Graphs:** `graph_versions` stores logical build identity/lifecycle and the selected immutable payload, `graph_build_attempts` stores exact lease/publication/object/cleanup ownership keyed by project/version/attempt, and immutable `graph_events` records logical transitions. Migration 0020 adds immutable actor-bound `graph_reservation_events` for future initial reservations and retries; historical reservations without exact actors remain omitted. Migration 0010 preserves selected legacy version-only rows under `LEGACY_V1`; migration 0011 forward-restores bounded constraints and missing migration transition evidence; migration 0012 requires every `ATTEMPT_V2` logical transition to have exact matching attempt state and identity; migration 0013 adds database-time publication fencing and makes retry independent of old-attempt cleanup ownership. All new claims use `ATTEMPT_V2`. Project-first lifecycle and cleanup indexes plus one current READY row are enforced.
- **MCP/local clients:** migration 0015 adds MCP-specific principals, immutable exact project/operation scopes, optional exact repository binding, SHA-256-only expiring/rotatable/revocable credentials, bounded one-hour nonce/rate records, and immutable redacted outcomes. These identities are separate from Phase 10 CI principals.
- **Snapshots:** migration 0016 adds immutable `context_snapshots`, `snapshot_artifacts`, and narrow `snapshot_events`. Rows capture exact Git, selected graph publication/attempt/storage/checksum identity, sealed expected artifact count, exact artifact ID/version/logical type/storage/checksum/source/change provenance, creator and D1-authoritative time, idempotency, and canonical manifest metadata. Composite foreign keys, insertion/count seals, referenced artifact/version immutability triggers, and project-first indexes preserve exact project scope and replay.
- **Sync state:** migration 0017 adds one bounded row per project, MCP/local principal, and stable nonsecret client UUID. It stores only client kind/version, monotonic observation sequence, exact normalized repository identity, local Git and server-verified published graph version/attempt/checksum/source commit, authoritative remote Git/READY-graph identity/status, deterministic Phase 11 status, bounded failure code, and D1-clock last-seen/last-successful-sync times. Writes use one authorization-conditioned upsert after truth validation, so membership, scope, credential, and repository replacement races cannot publish state. Project/time and principal/time indexes support bounded reads; each principal may retain at most 20 clients per project. Migration 0020 adds immutable `sync_state_events` in the same projection statement and conservatively seeds only each latest provable pre-migration projection.
- **Team:** migration 0018 adds 7-day exact-user project invitations, membership revisions, immutable removal evidence, and deterministic revision-bound `team_events`. Partial unique and project/invitee/status/time indexes enforce one live invite per identity, bounded lookup, and retained terminal replay evidence. Trigger insert guards prove exact invitation/member/removal state before accepting a unique success event; ACTIVE/current-ADMIN guards and mutation predicates fence archive and actor-demotion races. Invite lookup resolves the normalized current GitHub login through the one bounded `IdentityLookupProvider`, then matches only `(provider, provider_user_id)` already in D1 without updating identity. No invitation bearer or email address is stored. Phase 20's single review, consolidated five-item P1 correction, and 290-test root gate are complete; live browser/accessibility, delivery, and remote contention evidence remain external.
- **Project/artifact administration:** migration 0019 adds a settings revision and last-update actor/time for approved mutable project name/slug/description only; artifact lifecycle revision plus archived actor/time/reason; a project/status/time index; immutable-version update/delete guards; and narrow immutable `project_administration_events` with bounded redacted before/after JSON. An insert guard requires every new artifact to begin ACTIVE at lifecycle revision 1 with null archive metadata without rewriting historical rows. Trigger and conditional-write predicates fence active project, current direct ADMIN, revision/current-version, and status races. Settings responses use the guarded write's exact `RETURNING` transition rather than a post-commit authorization/read. Only known revision, uniqueness, and lifecycle trigger conflicts map to deterministic 409 responses; unexpected D1 failures reach the generic nonleaking 500 boundary. Archived artifacts leave R2, versions, snapshot references, checksums, and provenance untouched.
- **Audit:** migration 0020 adds generalized immutable `project_audit_events` as an indexed, trigger-derived materialization over the retained domain event tables. Each event has deterministic source identity, project, exact `HUMAN | MACHINE | MCP | SYSTEM` actor kind/stable ID, action, target type/ID, `SUCCEEDED | DENIED | FAILED` outcome, canonical allowlisted metadata, and D1-authoritative occurrence time. Project/time, actor/time, and action/time indexes back bounded reads. Exact historical rows are backfilled only where every field is known; historical graph reservation actors and project-less multi-project MCP lifecycle rows are not inferred. Source and generalized rows are immutable, exact per-source guards rederive every generalized field and canonical metadata, unique bridges prevent duplicates, and the shared finite `PROJECT_AUDIT_ACTIONS` contract is checked against SQL. Metadata is capped at 2 KiB, and an O(1) counter installed before backfill aborts event 100,001 while accepting exactly 100,000 retained events. Events are retained indefinitely because immutable history has no approved deletion policy; reaching capacity fails the owning transition rather than silently dropping evidence. Phase 21's single review, consolidated four-item P1 correction, and 309-test root gate are complete; remote D1 and live browser/accessibility evidence remain external.

### Planned owner tables/indexes

- Global project-authorized activity aggregation remains deferred; it does not change the generalized per-project event contract.
- Webhook delivery records exist only if webhooks are enabled; usage records exist only after privacy/free-tier evaluation.

D1 stores no repository clone, graph JSON, artifact body, plaintext session/OAuth/MCP/CI secret, or retained Git token.

## R2 layout and immutable publication

### Current

```text
projects/{projectId}/artifacts/{artifactId}/v/{version}/content
```

The Worker composes `R2ObjectStorage` from `Env.OBJECTS`; all R2 operations, including health, pass through it. Artifact domain logic generates keys. Create-only writes include checksum/content-type/upload ownership metadata. D1 publication follows object success. On D1 failure, compensation deletes only after checking that no matching publication exists; uncertainty leaves an orphan rather than risking data loss. Reads resolve the key through authorized D1 metadata and verify byte size and SHA-256 before returning UTF-8 content. Buckets remain private.

### Graphs and snapshots

```text
# Legacy selected objects remain readable and immutable
projects/{projectId}/graphs/v/{graphVersion}/graph.json

# Current physical key; logical graph version/API is unchanged
projects/{projectId}/graphs/v/{graphVersion}/attempts/{attempt}/{publicationId}/graph.json

projects/{projectId}/snapshots/{snapshotId}/manifest.json
```

Accepted [`adr/0004-attempt-scoped-graph-payloads.md`](adr/0004-attempt-scoped-graph-payloads.md) replaces only ADR 0003's physical-key assumption with attempt-scoped object identity. Claim atomically creates attempt metadata and a random, server-generated, never-reused publication ID/key. Upload and finalize bind the exact project/version/attempt/lease/publication/key, complete build identity, content, checksum, and `uploadId=publicationId`; no attempt may adopt another attempt's object. Finalize selects the physical key, marks the logical version READY, and supersedes only lower READY versions. Exact replay of that selected attempt remains valid when READY or SUPERSEDED only after the full submitted bytes validate and the matching immutable PUBLISHED attempt evidence and R2 metadata are present.

Cleanup may delete only an exact failed/expired unpublished attempt key after grace, a serialized D1 cleanup claim, a fresh no-reference proof immediately before delete, and exact R2 HEAD metadata checks; uncertainty retains the object, releases exact cleanup ownership where possible, and forbids prefix deletion. Retry proceeds independently of an old attempt's cleanup claim because the new attempt has a distinct key. A successful delete leaves the failed attempt recheckable rather than terminal, so a late recreation of the same exact key can be reconciled again. Existing version-only READY/SUPERSEDED objects remain immutable and queryable through a storage-layout marker without move/rewrite. Existing unready rows may retry under v2. Authorized explorer reads continue to resolve selected keys through D1, verify exact metadata/checksum/full format-v1 bytes, and expose neither raw graph bytes nor keys.

Snapshot creation requires one exact READY/SUPERSEDED graph and rejects an absent graph because Prompt 18 defines graph version as mandatory. The graph commit must equal the requested 40-hex Git SHA and its immutable repository identity must match the current verified project connection; artifacts may retain older or unknown source provenance but must be exact same-project immutable versions. The Worker verifies every referenced graph/artifact through D1, R2 HEAD metadata, exact bytes, checksums, and the production graph validator before publishing one deterministic JSON manifest. The manifest repeats exact artifact logical type and immutable version provenance but no private storage key or payload bytes. A random project/snapshot-derived key is create-only; created, collision-adopted, and ambiguous-adopted outcomes remain distinct, and adopted bytes are never compensation-deleted. Compensation applies only to request-created bytes after object verification and the freshest exact D1 no-reference proof immediately before delete; uncertainty retains an orphan. D1 snapshot/reference/success-event publication is one batch, stores an expected artifact count, and seals further references after exact-count success. Quotas, retention, and remote contention evidence remain pending.

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

The implementation uses query-aware metadata ordering before reading at most 15 project-predicated current artifact versions (and at most 64 KiB per payload), one current READY graph only when its immutable repository identity matches the current verified Git connection and its verified payload is at most 512 KiB, current verified Git metadata, and compact versioned built-in architecture guidance derived from the checked-in project invariants. Artifact and graph R2 bytes are resolved only from authorized D1 rows and exact server-defined keys beneath the requested project's namespace; mismatched artifact or graph keys fail before R2 HEAD/get. Artifact HEAD size, HTTP/custom content type, and checksum metadata must exactly match D1 before download, followed by exact byte-size/checksum verification. Graph reads retain the existing HEAD/upload identity and format-v1 checks. It ranks task/package/domain matches, architecture evidence, current provenance, and bounded source-backed graph relationships; deduplicates excerpts; computes token cost from each complete serialized evidence object; and then applies one global token/byte budget. Every result has one fixed provenance shape with exact project/source/path/section/version/commit/checksum fields, nullable only when a source has no applicable value. Built-in generated guidance truthfully uses null path/commit with its own stable version and checksum rather than claiming repository provenance.

`classifyArtifactFreshness` is the shared `CURRENT | STALE | UNKNOWN` classifier. It returns `CURRENT` only for equal valid lowercase 40-hex artifact/current commits, `STALE` for unequal valid commits, and `UNKNOWN` for missing or invalid provenance. It annotates applicable context evidence and never rewrites artifacts. Phase 13 executable overlap scenarios cover relevance, capped graph relationships, exclusion, budgets, provenance, deduplication, freshness, SQL predicates, HEAD-before-get behavior, and uncached isolation. Context Engine validates bounded storage components and exact supported graph layouts before storage access.

Task D is implemented locally under accepted ADR 0008. The same seam accepts one canonical explicit set of one to twenty project IDs and one query/domain/package plus overall token/byte/source budget. Callers construct a minimal opaque authorization fence from fixed human or MCP policy inputs; the fence appends a trusted parameterized complete-set current-authorization predicate to every Git/artifact/graph metadata SELECT and is rechecked around metadata reads plus immediately before each R2 HEAD/GET. Human fences require the complete active/current direct-role/workspace-member set; MCP fences additionally require the current active principal, unrevoked/unexpired credential, project and `search_context` operation scopes, and any exact repository binding. The engine accepts no caller SQL.

Artifact and graph retrieval caps are caller-wide and deterministically allocated over canonical project IDs. Phase 23 consolidates cross-project Git/artifact/graph metadata into three complete-set-fenced queries and admits at most eight artifact plus eight graph source objects across the whole call; every admitted object's HEAD and GET still has an immediate D1 authorization recheck. This keeps conservative human/MCP 20-project paths below D1's current 50-query invocation boundary without reducing the explicit 1-20 project scope. Evidence is globally score-ranked; equal-score ties use per-project candidate rank then canonical project ID, exact byte-for-byte excerpts deduplicate only within one project, and distinct project provenance is never collapsed. Before retrieval, exact fixed-point UTF-8 accounting rejects a budget smaller than the canonical empty response shell. Evidence and bounded source errors are admitted only when the complete final serialization fits; omitted errors set truncation and a final assertion fails closed. Authorized corruption omits the source and reports only its authorized project plus bounded source class. There is still no cache/index or cache-state surface; any future cache requires a separately accepted design and complete project-set, principal, query/config, and provenance namespacing with no subset/superset reuse. The one Task D review, consolidated two-P1 fix pass, and 318-test root gate are complete; remote D1/R2 and twenty-project performance evidence remain pending.

## Universal MCP and Pi

### MCP (current; complete locally)

Accepted [`adr/0007-universal-mcp-authentication-transport.md`](adr/0007-universal-mcp-authentication-transport.md) defines one authenticated `GET/POST /mcp` endpoint for all authorized projects. Its stable read-only tools are exactly `project_info`, `search_context`, `get_artifact`, `query_graph`, `get_sources`, and `sync_status`; schemas contain bounded selectors rather than project enumerations and remain constant with project count. One mutually exclusive selector supplies a normalized local repository identity, explicit project, or explicit cross-project set. Selection never grants access. The Worker authenticates a separate MCP/local-client principal, verifies credential scope, current workspace membership, current direct project membership/role, and optional exact current repository binding for the complete set before any domain read. Partial authorization fails all-or-nothing without project detail.

The minimal `McpTransport` handles only 16 KiB JSON-RPC decode, stable dispatch, error encoding, and a 128 KiB response ceiling. Exactly one `WorkerMcpTransport` implements POST `initialize`, initialized notification, `ping`, `tools/list`, and `tools/call`; authenticated GET explicitly reports that server notifications are unsupported. Authentication/resolution/audit and tool behavior remain domain logic. Search reuses `ContextEngine`; graph tools reuse current-repository selection, private-R2 verification, the full graph validator, and bounded explorer query; artifact bytes use exact derived keys, HEAD/byte/checksum/UTF-8 verification and bounded excerpts.

MCP credentials contain 256 random bits, are displayed once, accepted only in Authorization, and stored only as SHA-256. Immutable principal scopes carry exact tool/project sets and optional provider/stable-ID/canonical repository binding. D1-clock issue/expiry/last-use/revocation/rotation metadata, one-hour unique nonces, 120-request/minute and 1,000-live-nonce limits, exact-Origin ADMIN lifecycle mutations, and non-sensitive immutable outcomes are implemented in migration 0015. OS credential-store integration belongs to the later client phase. Live client/remote D1/log-redaction/rate tuning remains release evidence. Phase 15 now deterministically measures the exported transport in [`mcp-token-budget.md`](mcp-token-budget.md): the six-tool schema is exactly 4,082 bytes for 1, 10, and 100 authorized projects, and representative success/denial envelopes remain bounded and nonleaking. Its single independent review, consolidated two-item P1 fix pass, and 222-test root gate are complete.

### Pi (current; complete locally)

The `packages/context-pi` extension offers one native `/context` command family with `connect`, `status`, `sync`, `search`, `graph`, and `snapshot` subcommands. It reuses `packages/context-cli` for canonical Git remote discovery, the fixed safe cache, connection, offline status, verified local graph reads, and atomic sync. It resolves zero/one/many authorized projects, automatically selects exactly one, requires explicit TUI or ID choice for ambiguity, and caches only the non-secret selection. Search and online graph requests use the existing bounded MCP tools; local verified graph fallback remains available on network failure. Snapshot is a fixed non-mutating Phase 18 availability response.

The scoped MCP token is provisioned through Phase 14's ADMIN human lifecycle and accepted by Pi only from `CONTEXT_HUB_MCP_TOKEN`; the existing CLI human session remains environment-only for connect/sync. Before MCP or cached graph reads, the client revalidates the live normalized remote against the manifest; online calls additionally require the independently supplied API origin to equal the manifest origin. Redirects are rejected, response streaming is capped at 128 KiB, and MCP initialization is validated before notification/tool dispatch. Startup auto-selection is abortable and lifecycle-generation fenced across shutdown/reload. Credentials are never accepted from command arguments or persisted/output. The package registers no LLM tools and uses no prompt, provider, model, or agent hooks. Exact Pi 0.85.1 API/package assumptions are recorded in [`pi-integration.md`](pi-integration.md).

Phase 17's deterministic [`pi-token-budget.md`](pi-token-budget.md) audit activates actual production registration, lifecycle, commands, and formatting. Fail-closed Proxy evidence structurally derives exactly 0 permanent model-visible bytes / 0 estimated tokens; one 107-byte native registration remains byte-identical for 1, 10, and 100 authorized projects. Measured UI values are formatted notification/status payloads before terminal rendering, wrapping, ANSI, or RPC JSON framing. UTF-8-safe truncation and successful-output secret redaction are regression-locked, while MCP envelopes remain Phase 15-supporting transport evidence. The one Phase 17 review, consolidated four-item P1 correction, and 249-test root gate are complete; external live Pi telemetry remains pending.

## Artifact conflicts and versioning

### Current

Artifacts have a mutable metadata row/current pointer and immutable `artifact_versions`. Publishing requires `expectedVersion`; a stale writer receives deterministic `409 CONFLICT` with the authorized current version. The UI preserves the draft, requires explicit latest-version review, and never auto-retries. Historical bytes, checksum, type, size, source commit, change note, author, and timestamp remain retrievable and verified.

### Current freshness and lifecycle

Artifact list/detail/version responses annotate exact artifact source commit, current verified repository commit, repository verification edge, and the shared `CURRENT | STALE | UNKNOWN` classification. The responsive UI renders text/symbol badges and explicit warnings without relying on color, retains both commits, and never modifies immutable history. Context Engine and artifact routes import the same `classifyArtifactFreshness` implementation.

Logical archive/delete is current: ADMIN submits exact current version and lifecycle revision plus a bounded reason; D1 atomically tombstones metadata and emits narrow immutable evidence. Default active lists/counts/current detail, Context Engine, MCP `get_artifact`, and `get_sources` exclude archived artifacts. Explicit authorized HTTP version list/read and already sealed snapshot integrity replay continue to resolve exact immutable versions; new snapshots reject archived active selection. Publishing after archive is fenced, restore is not implemented, and no R2 delete occurs. Project name/slug/description settings use exact settings revisions; repository identity, provider IDs, workspace, ownership, status, and security fields are not mutable. Binary formats remain deferred until format-specific validation, scanning, and quotas exist. Phase 20A's single review, consolidated three-item P1 correction, and 302-test root gate are complete; browser/accessibility and remote D1/R2 contention evidence remain external.

## Graph sync and atomic local replacement

**Current:** accepted [`adr/0006-local-sync-cache.md`](adr/0006-local-sync-cache.md) defines the Phase 11 transport and cache. The dependency-light Node CLI exposes `context connect`, `context status`, and `context sync`; bounded Worker routes return direct-member project/repository/graph metadata and exact current-READY bytes only after private-R2 validation. Phase 11 temporarily consumes the existing opaque human session from `CONTEXT_HUB_SESSION` or an OS-secret helper that injects it and requires a separately supplied matching `CONTEXT_HUB_API` origin before sending it; no token enters repository files, a repository edit cannot redirect it, and no later local-client principal API is implemented.

The fixed `.ai-context/` layout contains `manifest.json`, `graph/graph.json`, `graph/meta.json`, `artifacts/`, and `cache/`; artifact/cache directories are empty except bounded crash-recovery files in this phase. Sync compares local Git, verified local graph source/version, known remote Git, and remote graph with ADR-defined deterministic precedence for `CURRENT`, `GRAPH_STALE`, `LOCAL_REPOSITORY_AHEAD`, `REMOTE_GRAPH_AHEAD`, `NO_LOCAL_GRAPH`, `GRAPH_BUILDING`, `GRAPH_FAILED`, and `COMMIT_MISMATCH`.

Update order is bounded authenticated download -> exact repository provenance/metadata/size/checksum/source verification -> duplicate-aware full format-v1 validation -> exclusive no-follow project-contained temporary writes and file/directory fsync -> atomic graph/meta rename -> manifest replacement last. A process-owned mutation lock serializes recovery, reads, and updates; dead owners are recovered. Persisted prior copies and a transaction marker provide startup rollback after interruption. Fixed contained paths, retained directory device/inode checks, and existing-layout checks reject replaced parents, symlinks, and traversal/escape shapes; no archive is accepted. Every command revalidates the live Git remote before network access. Failure preserves the previous valid selection, while network/timeout/retryable-service failures use offline status and verified local graph reads do not contact the service.

Online CLI/Pi status and successful/failed sync now optionally report through the existing repository-scoped MCP/local principal credential and `sync_status` operation. The mutation accepts Authorization only, rejects cookie/Origin-bearing requests, rechecks current workspace/direct membership and exact verified repository binding, and performs a monotonic idempotent upsert. Human cookie sessions provide bounded list/current reads only. Reporting increments a stable nonsecret cache client UUID/sequence and sends no credential, path, graph bytes, artifact content, or unverified graph as current; reporting failure is separate from graph sync and never invalidates the last verified cache. Phase 19's single review, consolidated four-item P1 correction, and 274-test root gate are complete; browser/accessibility and remote D1/client reporting evidence remain external.

## Snapshots and freshness

**Current snapshots:** authenticated browser-session routes provide ADMIN/EDITOR create and direct-member bounded list, inspect, and exact-manifest retrieval. Snapshots reference rather than copy graph/artifact payloads. D1 stores immutable exact provenance, sealed artifact membership, D1-authoritative creation/outcome timestamps, and narrow creation outcomes; private R2 stores one bounded canonical immutable manifest. One shared integrity verifier backs matching idempotent replay, list, inspect, and retrieve: it requires the exact artifact count, captured D1 graph/artifact rows, graph schema, all R2 HEAD/GET metadata and bytes, checksums, manifest schema, and canonical byte equality. Metadata list/inspect and exact-manifest retrieval retain distinct response shapes but all fail closed rather than claiming reproducibility after corruption.

`/context snapshot` remains fixed and non-mutating while truthfully reporting that snapshots are available through web/API and Pi creation awaits a defined mutation-authentication contract. Prompt 18 does not define that local-client mutation contract, and adding MCP snapshot tools would violate the explicit deferred-tools and exact six-tool invariants. Phase 19 adds freshness UI and persisted sync metadata without changing snapshot or MCP tool surfaces. The shared classifier reports byte-identical `CURRENT | STALE | UNKNOWN` semantics in Context Engine and artifact APIs and never rewrites historical records.

## Authentication and authorization

Human browser sessions are opaque cookie credentials; current CI machine and MCP/local-client principals are separate from human sessions and from each other. Authentication establishes an identity, never a role or project grant. Authorization always derives current membership from D1. Inaccessible resource responses expose no project/repository/artifact/graph/path/member existence; known members lacking mutation capability receive `403` where appropriate. Cross-project operations authorize all scope before any retrieval. Team writes condition on exact current role/revision, D1 serializes final-admin protection, and changed/removed members lose authority on the next request. Role/removal deletes their project sync rows transactionally. There are no hidden human role caches; MCP credentials retain unrelated project scopes and independently recheck current direct membership for every selected project.

## Audit and observability

### Current

Migration 0020 materializes project creation/settings, artifact creation/version/archive, Git connect/sync/disconnect, invitation/accept/revoke/role/removal, future actor-bound graph reservation/retry plus machine claim/publish/failure, snapshots, sync-state reports, machine credential lifecycle, and project-scoped MCP credential/request lifecycle. Success evidence is trigger-derived in the authoritative transition. Existing safely identified machine/MCP denials and failures, snapshot rejected/failed attempts, and failed sync reports are included with generic bounded codes; ordinary human authorization/validation denials and uncontrolled infrastructure exceptions are intentionally not persisted because they may lack a safely disclosable project/target and could amplify hostile writes. No event stores credentials, headers, cookies, OAuth codes, provider payloads, storage keys, payload/content, paths, queries/source excerpts, invitation PII, or exception text.

Authenticated `GET /projects/:id/activity` and `GET /projects/:id/activity/:eventId` recheck direct current membership for every request, including archived projects. Lists default to 30 days, permit at most a 90-day explicit window, return at most 50 events, use stable `(occurred_at,id)` cursors bound to filters, and support exact action and actor kind/ID filters. Outsiders and workspace-only callers receive nonleaking `404`; all direct roles receive the same provenance-oriented project history. There is no global aggregate.

### Planned

Metrics storage and production observability configuration remain deferred. Global Activity is current locally; remote D1 and live browser behavior remain unverified.

Operational signals include API errors, graph duration/failure, sync failure, artifact conflicts, MCP calls and bounded sizes, context result size, auth abuse, and storage/integrity failures. Logs redact authorization headers, callback codes, cookies, storage credential references, provider payload secrets, and artifact/graph content. Before launch, define rate limits, alerts, backups, restore exercises, and privacy-safe success metrics.

## Security architecture

[`security.md`](security.md) is the detailed threat model. Mandatory controls include exact Origin/CORS/callback configuration; hashed expiring state/sessions/machine secrets; least privilege and secret-store bindings; project-predicated D1 queries; private R2 with checksum verification; bounded input/output; safe inert rendering; SSRF allow-lists; raw-body webhook verification; replay/idempotency controls; path containment; nonleaking denials; CSP and security headers; lockfile/CI permissions; and tested backup/restore. Live-provider and remote Cloudflare validation remain release gates because local fakes cannot prove platform behavior.

## Free-tier and performance constraints

- Pages serves static frontend assets; Worker handles bounded API orchestration; D1 stores indexed metadata; R2 stores immutable payloads; GitHub Actions performs heavy graph builds.
- Avoid polling, full-table scans, unbounded lists/search, repository copies in D1, graph generation in Worker requests, duplicate commit builds, duplicate uploads, and per-project MCP servers/schemas.
- Prefer cursor pagination, project-first indexes, caching with authorization-safe namespaces, content hashes, commit deduplication, event-driven triggers, immutable object reuse, and local graph queries.
- Targets are normal cached dashboard under two seconds, near-instant artifact metadata, bounded predictable context, fast local graph queries, asynchronous graph update, and nonblocking Pi/sync use. The locally implemented [`free-tier-audit.md`](free-tier-audit.md) measures repository-controlled consumption, caps snapshots at 20 references/four fully verified list entries, and records current official limits; its one review, consolidated four-P1 correction, and 340-test root gate are complete; all deployed/account-shared telemetry remains pending.

## Local/offline behavior

The current web application requires the Worker. Current CLI/Pi operation is local-first for Git, status, and the verified manifest/graph cache; Pi graph queries fall back to a compact verified local projection when MCP is offline. Artifact/offline context caches remain planned. A cloud outage reports stale/offline state rather than destroying data or blocking normal development. Cloud-only mutations queue/retry only where an approved replay-safe protocol exists. Credentials never enter `.ai-context`, Git, prompts, logs, command arguments, or cache payloads.

## Local end-to-end verification

Phase 24 adds one fail-fast local system scenario, documented in [`e2e-report.md`](e2e-report.md). It applies migrations 0001-0020 to fresh Wrangler-local D1, uses local R2 through the production `ObjectStorage` adapter, executes production `createApp` HTTP/MCP routes on a dynamically reserved and run-identity-probed loopback port, creates asserted deterministic SHA-1 Git commits A/B under isolated Git/HOME/TMP configuration, and drives the actual CLI/cache and Pi extension seams. `createApp` retains production `GithubGitProvider` by default and permits an explicit E2E-only `GitProvider` factory override; OAuth/identity responses are a declared local provider seam. Graph generation runs the actual `GraphifyAdapter`, detached Git preflight/postflight, process boundary, and Python validator while injecting only a deterministic executable in place of the unavailable Graphify binary. This does not add a provider registry or alter production selection.

The scenario verifies single- and multi-project authorization, bounded Context Engine retrieval, provenance, immutable graph replay, snapshot sealing, stale/current transitions, atomic cache replacement, credential revocation, the exact six-tool schema, and output secret absence. It also exposed and corrected trigger-sensitive D1 success accounting in Git connect/sync/disconnect, MCP revocation, and sync-state reporting: authoritative guarded statements use `RETURNING` and require exactly one expected base-row identity, independent of generalized-audit trigger changes. Remote D1/R2, protected Actions Graphify, browser/accessibility, live OAuth/provider, MCP/Pi host, OS secret store, and deployment remain external. The one review, consolidated six-P1 correction, repeated local E2E, and 342-test root gate are complete.

## Final architecture and product QA

Phase 25 is implemented in [`final-qa.md`](final-qa.md). Its deterministic 134-row matrix reconciles PRD functional/nonfunctional requirements, all 35 technical-architecture sections plus eight multi-project invariants, and all 15 MVP acceptance items against production symbols, migrations, tests, or exact missing evidence. `npm run qa:architecture` AST-derives the exhaustive provider inventory and immutable-key data flow; consumes and probes the production route/auth contract; compares every application table, index, trigger SQL hash and foreign key from a fresh migrated database; structurally parses workflow policy; invokes focused semantic tests and the complete migration suite; and runs MCP/Pi audits under bounded isolated subprocesses. The single Phase 25 review, consolidated correction, deterministic architecture QA, local E2E, and 342-test root gate are complete. Local MVP acceptance remains `BLOCKED` on missing historical Phase 6 acceptance evidence, and production launch remains `BLOCKED` on the report's live/browser/remote/operational gates.

## Deployment and configuration

### Current

- `apps/web`: Vite build for Cloudflare Pages; local Vite proxies API/auth/project/workspace paths. `VITE_API_URL` is the only documented public web endpoint setting and is parsed by one shared exact-origin normalizer. The build generates `dist/_headers` without modifying tracked source: local same-origin builds may use self only, while Cloudflare Pages (`CF_PAGES=1`) requires an explicit non-placeholder HTTPS API origin and fails before Vite on credentials, paths, query, fragment, malformed input, or non-HTTPS. CSP `connect-src` is self plus exactly that normalized origin.
- `apps/api`: Worker with `DB`, `OBJECTS`, `APP_ENV`, `WEB_ORIGIN`, `API_ORIGIN`, and server-only GitHub OAuth bindings. `API_ORIGIN` is required, origin-only, and HTTPS in production; configured HTTP is accepted only outside production for local use. Wrangler contains local values and placeholder production resources.
- GitHub Actions defines install, local migration, test, typecheck, lint, and build on PRs and `main`; actions are full-commit pinned and the token is read-only, but the repository has no commit/remote run evidence.

### Planned release requirements

Provision private production D1/R2, apply migrations, set exact HTTPS `VITE_API_URL` in the Cloudflare Pages build environment and verify its generated CSP plus all routes/bindings and OAuth callback, keep secrets in Wrangler/CI secret stores, configure rate limits/redacted observability/retention and an isolated backup/restore exercise, deploy Pages/Worker, and verify browser OAuth, remote integrity/private-object denial, Graphify CI, sync, MCP, Pi, and end-to-end flows. No phase or deployment advances unless tests, typecheck, lint, and build pass; significant architecture choices additionally require their accepted ADR and contract tests.
