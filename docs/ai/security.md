# Security Architecture

## Scope

This threat model covers the browser, Worker API, D1 metadata, immutable R2 payloads, GitHub OAuth/API/Actions/webhooks, the future Context MCP, and future local Pi/sync clients. It defines controls; it does not authorize implementation of a later playbook phase.

## Security invariants

1. The Worker is the only public component allowed privileged or direct access to D1, R2, provider credentials, or private project payloads. Authorized browsers and clients receive bounded content only through the Worker.
2. Every project-scoped operation authenticates the caller, resolves the project, verifies direct project membership, checks the role, and only then accesses metadata or payloads.
3. Workspace membership never implies project access.
4. Client-supplied user IDs, project authority, roles, checksums, versions, storage keys, repository ownership, or commit provenance are untrusted.
5. Git remains code truth, D1 metadata truth, and R2 payloads immutable. Published versions are never silently overwritten.
6. Unauthorized responses reveal no inaccessible project, repository, artifact, graph, source-path, or membership metadata.
7. Context responses are bounded and preserve project, source, version, commit, and checksum provenance.

## Trust boundaries and data classes

- Browser to Worker: hostile network input; cookies, origins, JSON, identifiers, cursors, and uploads require validation.
- Local client or MCP consumer to Worker: authenticated but not trusted for scope or role claims.
- Worker to GitHub: outbound destinations, redirects, scopes, tokens, and response shapes are constrained.
- Worker to D1/R2: D1 authorizes and names immutable R2 objects; no public bucket trust is assumed.
- GitHub Actions/webhooks to Worker: machine identity must be independently authenticated and replay-protected.

Secrets include OAuth client secrets, Git provider tokens, webhook secrets, MCP/local-client credentials, session tokens, and signing keys. Private data includes artifacts, graphs, source paths, repository metadata, snapshots, audit records, and membership data.

## Threats and mitigations

### Authentication

Threats: OAuth login forgery, session theft/fixation, expired-session reuse, credential leakage, and account confusion.

Mitigations:

- Use GitHub OAuth with minimal scopes and an exact configured callback origin.
- Generate high-entropy, short-lived OAuth state; store only its SHA-256 hash; bind it to an `HttpOnly` cookie; consume it atomically once.
- Issue high-entropy opaque sessions after login; store only token hashes; enforce expiry; invalidate on logout; rotate on privilege-sensitive changes.
- Use `Secure`, `HttpOnly`, explicit `SameSite`, `Path`, and bounded `Max-Age` cookie attributes.
- Require exact configured browser Origin for mutations and exact credentialed CORS responses.
- Keep provider secrets in Worker/CI secret stores. Never return or log provider/session tokens.
- Rate-limit unauthenticated OAuth initiation and remove expired state rows.

Current status: OAuth state, sessions, cookies, Origin checks, bounded state storage, and token non-persistence are implemented. Live-provider verification remains required.

### Authorization

Threats: missing checks, insecure direct object references, role bypass, confused-deputy operations, and authorization performed after data access.

Mitigations:

- Central request order: authenticate, validate scope, load project, verify direct membership, check role, then execute.
- Scope every query by authenticated user and project; scope child resources by both project ID and resource ID.
- Return `404` for inaccessible project resources and `403` only when a known member lacks an allowed capability.
- Re-authorize every request; never cache browser-provided roles or trust hidden UI controls.
- Keep authorization denial tests for every route family and mutation role.

Current status: enforced for current workspace, project, project-settings, project Activity, repository-resolution, Git, artifact publication/archive, authenticated human graph, snapshot, sync, sync-state, Context Engine, MCP, and team routes. Team project routes authenticate and resolve active project plus direct current membership before returning data; ADMIN is required for invite/revoke/role/removal, while acceptance is separately scoped to the exact authenticated invitee user ID. Workspace membership alone never grants project data. Snapshot requests authenticate first, resolve the project through direct current membership, permit ADMIN/EDITOR creation and all direct-member reads, and return nonleaking denial to outsiders and workspace-only users. Sync-state reads use human sessions and current direct membership; local writes use only the existing MCP/local principal Authorization contract. Their authorization-conditioned upsert atomically rechecks active credential/principal state, current workspace/direct membership, project and `sync_status` operation scope, optional principal repository binding, and the exact current verified project repository after server-verifying the reported Git and published graph tuple. Context search and MCP independently apply their existing authorization boundaries.

### Project isolation

Threats: cross-tenant query mistakes, shared-cache contamination, ambiguous repository selection, and indirect leakage through counts or errors.

Mitigations:

- Use project membership as the data boundary; workspace membership is insufficient.
- Include project predicates in D1 queries and project prefixes in R2 keys.
- Resolve repositories only among projects independently authorized for the caller.
- Require explicit selection when multiple authorized projects match.
- Namespace caches by authenticated principal and project; never cache authorization failures as global existence facts.
- Test users in multiple workspaces/projects plus workspace-only and outsider access.

Current status: direct membership, nonleaking denials, multi-workspace/project tests, authorized repository resolution, and project-predicated Context Engine retrieval are implemented. Context Engine graph selection also requires the immutable graph repository identity to match the project's current verified Git connection, preventing mixed old/new repository evidence. Artifact and graph retrieval now rejects malformed bounded ID/version/attempt/layout/publication components and any D1 storage key that is not the exact server-defined legacy or current key before R2 access. Phase 13 scenarios admit valid current artifact versions plus legacy and attempt-scoped graphs, reject malformed/cross-project shapes with zero R2 calls, and exercise overlapping foreign-project metadata, status/current-version/repository/order filtering, HEAD-before-get storage isolation, source errors, stable response fields, and repeated uncached searches; the single review and 200-test full gate are complete. The Context Engine creates no cache or persistent index, avoiding shared principal state; any future cache/index must use authenticated-principal plus project namespaces and invalidate authorization-sensitive entries.

### Git credentials

Threats: token theft, excessive provider scope, accidental browser exposure, persistence in logs/D1, and one project's credential used for another.

Mitigations:

- Keep GitHub App client secrets/private keys in Worker secret storage; D1 stores only installation/reference metadata.
- Request only Metadata read and Contents read, and mint short-lived exact-repository installation tokens just in time.
- Bind each setup/authorization state to the exact application session and each credential reference to its provider identity and authorized project/repository association.
- Redact authorization headers, callback codes, tokens, and credential references from logs and errors.
- Rotate/revoke credentials on disconnect, member removal, suspected compromise, or provider revocation.

Current status: the GitHub App connection flow, exact-session-bound one-time states, PKCE, specific-installation proof, transient App JWT/installation tokens, exact repository binding, stale-flow suppression, optimistic sync/disconnect, verified-link resolution, audit redaction, and role-aware project UI are implemented locally. The UI requests no token or installation identifier, maps callback errors to fixed copy, and discards stale project responses. Local fresh/upgrade migrations exercise uniqueness, foreign keys, and transaction rollback. Live browser/provider verification remains pending.

### MCP authentication

Threats: a public context gateway, stolen long-lived tokens, project spoofing, oversized requests, and administrative tool abuse.

Mitigations:

- Expose one authenticated multi-tenant endpoint; authenticate before project resolution.
- Use revocable, scoped credentials stored in OS credential storage where possible; never place secrets in repository files or prompts.
- Independently authorize every requested project, including each project in cross-project calls.
- Keep the MCP surface read-oriented and stable; do not expose administrative tools to normal agents.
- Apply request, result, rate, and token-size budgets; record auditable principal/project/tool outcomes without sensitive content.

Current status: accepted ADR 0007 and additive migration 0015 implement a separate MCP/local-client principal model, SHA-256-only 256-bit credentials, immutable exact project/tool scopes, optional exact repository binding, D1-clock expiry/last-use/rotation/revocation with exact-transition revoke auditing, pre-decode atomic one-hour nonce consumption, D1 request/live-nonce limits, immutable redacted outcomes, and one bounded Worker `GET/POST /mcp` transport. Phase 19 reuses that credential family for a narrow Authorization-only, repository-bound, monotonic sync-state report route; it does not add an authentication family or MCP tool. Its single review, consolidated four-item P1 correction, and 274-test root gate are complete; remote D1/client reporting evidence remains external. Human cookies are not accepted at MCP. The complete selected set is checked against current workspace membership, direct project membership/role, credential scope, and repository binding before any domain read; partial cross-project authorization fails without project detail. Phase 15 proves byte-identical six-tool schemas and bounded nonleaking responses. Phase 16/C adds a thin Pi consumer: ADMIN provisioning remains at the existing human lifecycle, the bearer is accepted only from `CONTEXT_HUB_MCP_TOKEN`, every request uses an exact manifest-matched API origin plus fresh nonce and manual redirects, and output redacts token-shaped values. Pi revalidates the live normalized Git remote against the manifest before MCP or cached graph access, validates the exact MCP initialize result before proceeding, streams responses to a 128 KiB ceiling, and aborts/generation-fences startup selection across shutdown. Pi stores only project selection/provenance in the existing safe manifest and the server reauthorizes every request. Phase 17's canonical deterministic audit uses fail-closed API/context traps to derive zero prompt/message/entry/tool/provider/model/active-tool/thinking/session mutation, proves constant registration for 1/10/100 authorized projects, and locks UTF-8-safe plus secret-redacted formatted notification payloads. Its one review, consolidated four-item P1 correction, and 249-test root gate are complete. Phase 16's single review, consolidated P1 pass, and 245-test root gate remain complete; live OS-helper/Pi/TUI/RPC/log/provider-payload evidence remains pending.

### Private artifact access

Threats: unauthorized listing/download, guessed artifact IDs, stale public links, content tampering, and historical-version leakage.

Mitigations:

- Authenticate and verify direct project membership before artifact metadata or R2 access.
- Query artifacts by both project and artifact ID; retrieve versions only through authorized D1 metadata.
- Keep R2 private and serve authorized payloads through the Worker; do not expose direct object URLs.
- Verify byte size and SHA-256 before returning content; fail closed without stale content on mismatch.
- Preserve immutable version history and audit publication events.

Current status: these controls are implemented for text artifacts; binary formats remain deferred. Phase 20A logical archive requires direct current ADMIN plus exact current artifact version/lifecycle revision, writes only a D1 tombstone and narrow immutable event, never deletes R2/version/snapshot rows, and excludes archived rows from default active list/count/detail, Context Engine, MCP artifact, MCP sources, and new snapshot selection. Exact authorized HTTP version history and sealed snapshot replay remain available. Restore and post-archive publication are forbidden. Phase 20A's single review, consolidated three-item P1 correction, and 302-test root gate are complete; remote D1/R2 contention evidence remains external. Phase 19 artifact responses classify freshness by importing the exact shared Context Engine classifier, expose only bounded source/current commit and connection-state provenance, and never update artifact or version rows. The UI uses explicit state text and symbols in addition to color, including disconnected, unverified, unavailable-commit, and invalid/missing-provenance warnings.

### Object storage

Threats: public bucket exposure, predictable-key bypass, overwrite, orphan deletion races, metadata/payload mismatch, and unbounded storage growth.

Mitigations:

- Keep buckets private and never treat key secrecy as authorization.
- Derive keys server-side under `projects/{projectId}/...`; never accept client storage keys.
- Use create-only writes, versioned keys, checksums, byte counts, content types, and request-scoped upload ownership metadata.
- Publish D1 metadata only after R2 staging. Before compensation, verify no D1 publication; prefer an orphan over deleting potentially referenced data.
- Add delayed grace-period orphan cleanup with publication rechecks when operational evidence requires it.
- Apply upload/version quotas and lifecycle monitoring before opening binary or large-file support.

Current status: private versioned keys, create-only writes, checksums, publication ordering, and request/upload ownership are implemented for text artifacts. Snapshot creation is capped at 20 artifact references and fully verified snapshot lists at four entries so integrity work stays below current D1 query and Worker service-subrequest ceilings; current immutable rows are obtained with one project/snapshot-predicated join without skipping any R2 HEAD/GET/checksum verification. Graph publication uses the attempt-scoped layout accepted by [`adr/0004-attempt-scoped-graph-payloads.md`](adr/0004-attempt-scoped-graph-payloads.md). That correction gives each claim a unique attempt/publication key and permits cleanup only for that exact failed/expired unpublished attempt after grace, serialized ownership, fresh no-reference proof, and exact HEAD checks. Snapshot manifests use random project/snapshot-derived create-only keys, a 64 KiB exact-byte ceiling, checksum/content-type/upload ownership metadata, HEAD+GET verification even after apparent success, and explicit created versus collision/ambiguous adoption outcomes. Adopted bytes are never compensation-deleted. D1-failure compensation is limited to request-created exact bytes and performs the freshest exact D1 no-reference proof immediately before delete; uncertainty retains an orphan. Matching idempotent replay, list, inspect, and retrieval share complete captured-reference/R2/schema/checksum/manifest verification and never return private storage keys. Remote R2 contention/ambiguity and orphan operations remain external evidence; storage quotas and binary objects remain deferred.

### Graph generation and publication

Threats: building the wrong or contaminated commit, untracked/symlink input injection, toolchain drift, malicious graph output, resource exhaustion, direct storage bypass, publication credential theft/replay, partial R2/D1 publication, and replacement of a valid graph.

Mitigations:

- Implement the build profile and logical version/schema decisions only from accepted [`adr/0003-graphify-canonical-build-profile.md`](adr/0003-graphify-canonical-build-profile.md), and implement attempt-scoped physical publication under accepted [`adr/0004-attempt-scoped-graph-payloads.md`](adr/0004-attempt-scoped-graph-payloads.md). The accepted profile runs pinned Graphify 0.9.58 with `code-only-clustered-v1` in GitHub Actions; the Worker never performs the heavy build.
- Before Graphify runs, require a detached exact 40-hex commit and reject dirty/untracked content, hidden index flags or other non-normal stage-0 states, every tracked symlink (including outside targets), every submodule/gitlink, and every tracked LFS pointer. Independently stream each no-follow worktree descriptor into its exact Git blob object ID and SHA-256 fingerprint, with descriptor/path identity checks, because porcelain status alone is insufficient; smudge/EOL-transformed bytes fail closed. The observed 0.9.58 difference between following an in-repository symlink and ignoring an outside absolute file symlink is untrusted and irrelevant to the reject-all v1 contract.
- Create a new empty absolute external directory; set the same `GRAPHIFY_OUT` in a scrubbed environment for both exact extract and cluster-only processes; synchronously terminate the owned process group on every completion path; and accept only its regular non-symlink `graph.json` after two zero exits. Compare its opened descriptor with the direct pathname, including device/inode/size/mtime/ctime, after close and again after bounded traversal plus root verification so an unlinked or replaced inode cannot be returned. Verify the checkout stayed untouched. Do not assume cluster-only supports `--out`.
- Hash-lock the complete Python dependency set and Action references in the implementation phases; verify the installed Graphify version and bound execution time, memory, disk, logs, output bytes, counts, paths, fields, and JSON structure.
- Enforce Context Hub format-v1, not an inferred upstream schema: exact top-level keys/types; false directed/multigraph flags; matching lowercase commit; required typed node/link records; confidence/location rules; unique IDs and valid endpoints; tracked regular non-symlink source paths; empty hyperedges; duplicate-key rejection; finite numbers; bounded scalar unknown fields; and explicit byte/depth/key/string/count limits. Unsupported variants fail closed and too-large output is not truncated.
- Compute `content_checksum_sha256` over exact stored bytes without reserialization. Keep source commit, checksum, graph version, Graphify version, adapter version, profile, and format version distinct; never trust Graphify manifest MD5 or cache hashes as payload integrity.
- Include repository provider, stable provider repository ID, immutable normalized identity snapshot, project ID, source commit, Graphify version, adapter version, profile, and format version in both dedup identity and graph metadata. Provider repository ID prevents a replacement repository at the same name/commit from reusing old output.
- Permit only an exact scoped, expiring, revocable machine principal to upload/finalize; bind credential, project, provider repository ID, operation, commit, nonce/idempotency key, logical version, attempt, lease, and random server-generated publication ID/key. ADMIN manages/triggers credentials but cannot publish through a browser session; reservation/retry atomically rechecks current direct ADMIN membership.
- Give every claim a never-reused attempt-scoped publication ID/key. Publish immutable private R2 bytes only at that exact key with `uploadId=publicationId`, then finalize only after fencing project/version/attempt/lease/publication/key/full build identity and exact content/checksum/metadata. Require lease expiry later than both the submitted publication time and D1's current UTC time, preventing backdated expiry bypass. Select that key and supersede only lower READY logical versions. Permit exact same-published-attempt replay even after SUPERSEDED; forbid cross-attempt adoption.
- Clean only an exact failed/expired unpublished attempt key after grace, serialized D1 cleanup ownership, fresh proof immediately before delete that no row references its key/publication ID, and matching exact R2 HEAD metadata. Any uncertainty retains it and releases exact cleanup ownership where possible; never prefix-delete. Let retries proceed with a distinct key regardless of old-attempt cleanup ownership. Keep legacy selected version-only objects immutable and queryable under an explicit layout marker and handle legacy orphan cleanup separately.
- Commit successful machine claim/fail/publish audit evidence in the same D1 statement as its attempt transition; record safely identified denial/failure outcomes separately. Monitor attempts, duration/resources, validation/too-large failures, conflicts, orphan age, integrity failures, and credential denials. Never log credentials, headers, repository/graph content, or uncontrolled tool output.

Current status: the isolated Node-only Phase 8 adapter implements accepted Git preflight and tracked-file authority. Phase 9 has constrained logical/attempt D1 rows and immutable events, attempt-scoped private R2 publication, duplicate-aware full Worker publication/read validation, and bounded authenticated human explorer routes. Worker path validation proves only schema-safe normalized relative POSIX paths because no checkout manifest exists there; the adapter separately proves tracked regular files. ADR 0004 is accepted and Phase 9 is locally complete through migration 0013 with final bounded review ACCEPT. Phase 10 machine principals, exact external publication transport, dependency hash lock, separately pinned trusted tooling workflow, and fail-closed cgroup/filesystem attestation are locally complete through migration 0014 under ADR 0005 after the single phase review and 154-test gate. Representative benchmarks and live bounded Actions/D1/R2 verification remain pending release evidence.

### Webhook spoofing

Threats: forged events, body alteration, replay, wrong-repository events, and secret leakage.

Mitigations:

- Verify provider signatures over the exact raw body using constant-time comparison before parsing or side effects.
- Enforce supported event/action allow-lists and match provider repository identity to the authorized project connection.
- Store delivery IDs with expiry and reject duplicates.
- Use bounded timestamps/body sizes, rate limits, secret rotation, and generic rejection responses.
- Make handlers idempotent; an accepted event schedules work rather than publishing a graph directly.

Status: webhooks are not implemented.

### SSRF

Threats: attacker-controlled repository URLs, redirects, private-network access, DNS rebinding, and credential forwarding.

Mitigations:

- Allow-list supported providers and exact HTTPS API hosts; use provider IDs instead of arbitrary fetch URLs.
- Normalize repository identities and reject credentials, unexpected ports, query strings, fragments, and unsupported protocols.
- Disable or validate redirects hop-by-hop; never forward secrets across hosts.
- Reject loopback, link-local, private, metadata-service, and non-routable destinations if arbitrary hosts are ever supported.
- Bound response size/time and parse only expected content types.

Current status: GitHub repository identity normalization rejects unsupported hosts, protocols, credentials, ports, queries, and fragments. The GitHub adapter uses only fixed `github.com` and `api.github.com` HTTPS endpoints, rejects redirects, and bounds response time, bytes, content type, and shape. No arbitrary host or DNS target is accepted; live-provider verification remains required.

### Path traversal

Threats: repository names, artifact names, archive entries, or local sync paths escaping their intended root.

Mitigations:

- Use generated IDs for storage keys and fixed key templates; never concatenate user paths into filesystem/R2 locations.
- For local sync, resolve canonical paths, require containment beneath the configured project root, reject absolute paths and `..`, and refuse symlink escapes.
- Validate archive entries before extraction and write to temporary directories before atomic replacement.
- Treat display names as metadata only, never as paths.

Current status: server-generated immutable R2 keys do not use display names or client paths. Phase 11 local sync uses only fixed paths beneath the canonical project root, validates every existing layout component and retained directory device/inode identity around operations, rejects symlinks and replaced parents, uses exclusive no-follow temporary files, and accepts no archives. An exclusive process-owned lock serializes cache recovery/read/mutation, and persisted rollback evidence recovers interrupted graph/meta/manifest replacement.

### Malicious uploads

Threats: oversized bodies, parser bombs, executable content, stored XSS, MIME confusion, decompression bombs, and malware.

Mitigations:

- Stream requests to hard byte limits and validate actual UTF-8 bytes, media type, metadata lengths, and declared JSON syntax.
- Store content as inert private payloads; render with `textContent`/escaped code, never raw HTML execution.
- Set explicit response content types and safe content disposition for downloads.
- Do not support archives, PDF, diagrams, multipart, or binary content until format-specific validation, sandboxing/scanning, and quotas are defined.
- Reject compressed uploads unless decompressed size can be bounded before storage.

Current status: bounded Markdown/text/JSON/YAML uploads are implemented. Context Engine artifact retrieval first requires the exact project/artifact/version key, then checks D1 size/checksum/content type against private-R2 HEAD HTTP/custom metadata and the 64 KiB source ceiling before download, and finally verifies exact returned bytes and UTF-8 before producing bounded evidence.

### Replay attacks

Threats: reused OAuth callbacks, webhook deliveries, sync commands, artifact mutations, and graph publication requests.

Mitigations:

- Atomically consume OAuth state once and enforce expiry.
- Deduplicate webhook delivery IDs and machine-operation idempotency keys with bounded retention.
- Bind sync/publication requests to principal, project, operation, commit/version, attempt, lease, publication ID/key, nonce, and expiry.
- Use optimistic expected versions for artifact mutation; never silently retry against a newer version.
- Make graph publication idempotent only for the same published attempt when full D1 identity and exact R2 checksum, size, content type, key, and `uploadId=publicationId` match; never adopt across attempts.

Current status: one-time OAuth state, session-bound one-time Git connection state with post-provider publication checks, optimistic artifact versions, exact project-settings revisions, exact artifact archive current-version/lifecycle revisions, and exact immutable-object recovery checks are implemented. Phase 9 graph replay is fenced to the exact attempt/publication key and remains valid after SUPERSEDED under accepted ADR 0004. Phase 10 external machine publication transport, hashed credentials, and bounded nonce records are implemented locally through migration 0014. Phase 14/B adds a distinct MCP/local-client credential family and atomically consumed unique nonce plus D1 rate/live-record checks through migration 0015; rotation/revocation and D1 expiry are rechecked on every request. Phase 11 local sync predicates server graph selection on the current repository, revalidates the live checkout remote before requests, accepts only the authorized server-selected immutable graph tuple with exact repository provenance and duplicate-aware full format-v1 validation, uploads nothing, and preserves prior cache state. Webhook delivery replay controls remain unimplemented; live remote evidence remains pending.

### Role escalation

Threats: users assigning themselves roles, workspace roles leaking into projects, mass assignment, and stale privileges after removal.

Mitigations:

- Derive roles only from D1 membership records; ignore client role/user fields.
- Require project `ADMIN` for invitations, removals, and role changes; prevent removal/demotion of the final project admin.
- Keep workspace and project roles separate; workspace membership alone grants no project data.
- Perform role changes transactionally, invalidate affected sessions/caches where required, and emit immutable audit events.
- Test ADMIN/EDITOR/VIEWER capabilities server-side; hiding UI controls is not authorization.

Status: migration 0018 and `team.ts` implement role management with exact expected current role/revision, same-write ACTIVE/current-ADMIN predicates, trigger-enforced final-admin protection, self-role rejection, exact-invitee one-time acceptance, and deterministic revision-bound transaction-coupled immutable success events guarded against duplicate or fabricated insertion. Migration 0019 applies the same current direct-ADMIN and active-project SQL fencing to approved project settings and artifact archive, rejects mass assignment, and records only bounded redacted before/after settings or tombstone metadata. Invitation login input is resolved through the bounded GitHub `IdentityLookupProvider` to the provider's current stable ID/login and matched only to an existing `(provider, provider_user_id)` D1 identity; cached usernames never grant authority, no identity is implicitly updated, and unavailable targets share one nonenumerating outcome. Team responses reuse exact-origin credentialed CORS and all mutation bodies use one 2 KiB streaming JSON-object boundary. Invitations store no email or bearer token; external email/delivery is not implemented. Role/removal transactions clear the affected user's project sync rows. Human, artifact, graph, context, sync, and MCP authorization has no hidden role cache and rechecks current D1 membership on every request; multi-project MCP credentials are not globally revoked, so unrelated project scopes continue working while the removed scope is immediately denied. Phase 20's single review, consolidated five-item P1 correction, and 290-test root gate are complete; remote contention and live revocation evidence remain external.

### Audit history

Threats: forged or mutable history, unaudited successful transitions, cross-project disclosure, secret/content capture, unbounded scans, and denial logging that exposes inaccessible identifiers.

Mitigations and current status: migration 0020 rederives every generalized field from exact immutable domain evidence through unique trigger bridges, adds append-only actor-bound graph reservation and sync-report evidence, caps canonical metadata at 2 KiB, rejects credential/content/path/query/PII key classes, and indexes project/time plus actor/action queries. Successful covered transitions roll back if their event bridge fails. Safely identified machine/MCP denials and failures, snapshot outcomes, and failed sync reports are retained; ordinary human authorization/validation denials and uncontrolled exceptions are intentionally omitted because a safe project/target may not be known. The project Activity API authenticates before reading, requires direct current membership even for archived projects, applies project predicates, a 30-day default/90-day maximum window, 50-row pages, and filter-bound stable cursors. The global Activity route also authenticates first and applies direct project plus current workspace membership inside its sole aggregate query; it returns only authorized project metadata, never inaccessible counts or gap markers, and explicitly includes active plus archived projects unless status-filtered. Workspace-only users and outsiders receive no project data. Both UIs render exact returned actor/action/target/outcome/time and allowlisted metadata using inert DOM text. General events are immutable and retained indefinitely up to 100,000 per project; a pre-backfill counter aborts event 100,001 and no silent pruning is allowed. The single review, consolidated four-P1 correction, and 309-test root gate are complete; remote D1 and live browser/accessibility evidence remain pending.

### Cross-project access

Threats: partial authorization, metadata leakage from inaccessible projects, mixed provenance, and one project's content consuming another's budget.

Mitigations:

- Require cross-project requests to be explicit and authorize every project independently before retrieval.
- Fail the whole request when any requested project is unauthorized; reveal no failing project metadata.
- Preserve project provenance on every result and apply one bounded response/token budget after deduplication.
- Never infer additional project scope from workspace membership or repository similarity.
- Namespace retrieval indexes/caches and test partially unauthorized project sets.

Current status: Task D is implemented and independently reviewed locally under accepted ADR 0008. The human route and MCP validate an explicit one-to-twenty-project selector and verify the complete active/current direct-member/current workspace-member set before retrieval. Each caller then constructs an opaque fixed-policy authorization fence. Every source metadata SELECT carries its trusted parameterized complete-set predicate; checks around metadata and immediately before each R2 HEAD/GET detect human removal/project deactivation or MCP principal/credential/scope/repository changes and abort with one generic whole-request denial. The engine accepts no caller SQL. Human and MCP race fakes prove generic failures and zero R2 reads.

The one engine uses caller-wide retrieval caps, global deterministic ranking with fair score ties, same-project-only exact excerpt deduplication, distinct project provenance, and one serialized token/byte/source budget. Phase 23 consolidates cross-project Git/artifact/graph metadata into three complete-set-fenced queries and caps source objects at eight artifacts plus eight graphs caller-wide (15 artifacts plus one graph for a single project); every admitted HEAD and GET retains its immediate D1 authorization recheck, keeping conservative 20-project human/MCP paths below the current 50-query boundary. It rejects an unencodable canonical minimum shell before retrieval, admits source errors only while the exact final serialization fits, marks omitted errors as truncation, and asserts the final byte ceiling. Authorized corruption is omitted with only an authorized project/source-class error. There is no retrieval cache/index or cache-state surface; any future cache requires complete project-set, principal, query/config, and provenance namespacing with no subset reuse. The complete two-item review P1 set is fixed and the 318-test root gate passes; external remote D1/R2/performance evidence remains pending. The management Settings route separately exposes only the current caller's bounded account/session fields and directly authorized project connection/graph/sync configuration. It returns no credential, provider payload, storage key, or invented preference; project mutation remains in the existing current-ADMIN Phase 20A route.

## Additional platform controls

- Validate all JSON, route identifiers, cursors, versions, lengths, content types, and provider responses.
- Use generic external errors and structured internal logs with secret/content redaction.
- Apply Cloudflare and application rate limits to authentication, uploads, search, MCP, sync, webhook, and graph-build triggers.
- Pin dependencies with the lockfile, audit production dependencies, restrict CI permissions, and protect deployment environments.
- Apply CSP, `frame-ancestors`, `X-Content-Type-Options`, strict `Referrer-Policy`/`Permissions-Policy`, frame denial, and production HSTS consistently. Phase 22 adds centralized Worker headers and build-generated Pages headers whose `connect-src` derives from the same exact normalized `VITE_API_URL` used by the browser; Pages builds reject an absent or unsafe origin. Edge behavior remains deployment verification.
- Back up D1 metadata, retain immutable R2 payloads, and test restoration without changing checksums or provenance. Phase 22 explicitly marks this BLOCKED until isolated deployed resources and a safe procedure exist.

## Verification requirements

Before each phase proceeds:

- Tests, typecheck, lint, and build pass.
- Authorization denial and cross-project isolation tests cover every new route.
- Mutations test replay/conflict behavior and audit outcomes.
- Payload operations test bounds, integrity failures, and compensation/data-loss cases.
- Security-sensitive provider behavior is tested against live sandbox resources before production.

The local Phase 22 audit is recorded in [`security-audit.md`](security-audit.md). Its one review, consolidated two-P1 correction, zero-vulnerability dependency audit, and 336-test root gate are complete. Phase 23's [`free-tier-audit.md`](free-tier-audit.md) is complete locally after its independent review, consolidated four-P1 correction, and 340-test root phase gate; it does not replace deployed CPU/subrequest/rows/storage evidence. It fixes the confirmed High local-code findings and exercises role/membership revocation, compromised/revoked/expired credentials, replay, corrupt artifact/graph/snapshot objects, and partially unauthorized cross-project requests. Webhook replay is N/A because no endpoint exists; complete account deletion is open; backup/restore is BLOCKED.

Phase 24's fail-fast local scenario and boundary matrix are recorded in [`e2e-report.md`](e2e-report.md). It exercises production authentication/session, direct membership, machine and MCP credentials, private local object integrity, complete-set denial, immutable graph replay, snapshot verification, CLI containment/atomic replacement, Pi output redaction, and next-request credential revocation on fresh migrated local bindings. The test scans retained output for issued tokens and credential patterns and exposes no debug/database route. Injected GitHub/provider and graph-runtime seams carry deterministic non-production identities only. This local evidence does not prove remote bucket privacy, edge logs, OAuth/provider behavior, protected runner isolation, OS secret storage, browser/accessibility, or live client hosts. Its independent review and consolidated six-P1 correction are complete; exact D1 `RETURNING` identities now avoid trigger-inflated mutation accounting, and the isolated harness fails closed on startup/process/output/request bounds. The repeated local E2E and 342-test root gate pass. Before public launch, rotate test credentials, verify no production bucket/database is public, inspect logs for secret leakage, and close every external/live gap in both audits.

Phase 25's [`final-qa.md`](final-qa.md) reconciles these controls in a deterministic 134-row normative matrix. Its hardened `npm run qa:architecture` derives provider, production route/auth, immutable-key, exact fresh-schema/FK, structural workflow, focused semantic-test, migration-integrity, and MCP/Pi runtime evidence under bounded credential-minimized subprocesses. The single review, consolidated correction, deterministic architecture QA, local E2E, and 342-test root gate are complete. Local MVP acceptance is `BLOCKED` on missing historical Phase 6 acceptance evidence, and production launch remains `BLOCKED` on account privacy/deletion, browser/accessibility, live GitHub, remote D1/R2/private storage, real Graphify/Actions, live MCP/Pi/OS secret storage, deployed edge/rate/log controls, backup/restore, telemetry, and deployment evidence.
