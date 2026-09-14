# ADR 0007: Universal MCP authentication and Worker transport

- Status: Accepted
- Date: 2026-09-15
- Scope: Master-plan Phase 14/B universal multi-project MCP

## Context

Context Hub needs one provider-neutral MCP endpoint whose six read-oriented tools remain stable as tenants add projects. Browser sessions are too broad and Phase 10 CI publication principals are bound to a different actor, operation, repository, and replay model. MCP requests can select one repository-resolved project, one explicit project, or an explicit cross-project set, so authorization must finish for the entire set before any artifact, graph, repository, or Context Engine read.

The endpoint is an internet-facing protocol boundary. Credentials, JSON-RPC bodies, nonces, result bytes, context tokens, rates, and project counts therefore need fixed limits and stable failures. MCP Streamable HTTP permits a server that does not offer server-initiated messages to reject GET while serving JSON-RPC over POST.

## Decision

### Principal and credential lifecycle

Add MCP/local-client-specific `mcp_principals`, project-scope, operation-scope, credential, nonce, and immutable audit tables. They do not reuse or extend Phase 10 `machine_principals`. A principal belongs to the human user who creates it, has an immutable set of one to twenty directly authorized projects, an immutable nonempty subset of the exact six tool operations, and an optional immutable repository binding. Repository binding records provider, stable provider repository ID, and normalized canonical identity together.

A credential contains a random 256-bit secret displayed exactly once as an Authorization bearer value. D1 stores only its SHA-256 hash. Metadata records issue time, D1-clock expiry (at most 90 days), monotonic last use, revocation, and rotation replacement. Rotation revokes the old credential before creating its replacement; revocation takes effect on the next request. Human-cookie lifecycle routes are `GET/POST /mcp-credentials`, `POST /mcp-credentials/{credentialId}/rotate`, and `DELETE /mcp-credentials/{credentialId}`. Mutations require the exact configured Origin. Every lifecycle operation rechecks current direct `ADMIN` membership for every scoped project; workspace membership alone is never authority. Tokens are never accepted from query strings or JSON bodies and never appear in list responses, audit metadata, or errors.

### Request authentication, replay, and rate model

`/mcp` accepts only `Authorization: Bearer chmcp_<credential-id>.<secret>`. Human cookies are ignored. Every GET negotiation and POST protocol request also supplies a unique bounded `X-Context-Nonce`. Before any POST body or JSON-RPC decoding, caller-owned preflight atomically consumes that nonce under the redacted `PROTOCOL` operation while rechecking the active principal, credential hash-derived identity, D1-clock expiry/revocation, one-hour retention, no prior nonce, at most 120 requests in the current D1 minute, and at most 1,000 retained live nonces per credential. Tool dispatch then rechecks the exact allowed operation and complete selected project set without consuming a second nonce. Expired records may be deleted only after D1 says they expired. A request updates `last_used_at` only after nonce consumption.

Audit rows contain principal/credential references, at most one project reference, stable operation, outcome, and D1 time. Cross-project audit rows intentionally omit project detail. Audits contain no credential, nonce, request arguments, result, source content, artifact/path/name, or authorization header. External failures use fixed nonleaking codes; a partially unauthorized explicit set fails as one `PROJECT_NOT_FOUND` before domain reads.

### Scope and authorization

Tool input has exactly one scope selector. Precedence is represented by mutually exclusive selectors rather than allowing contradictory values: normalized `repository`, explicit `projectId`, or explicit `projectIds`. Repository resolution considers only verified current links and returns explicit zero or ambiguous outcomes. Explicit cross-project scope is never inferred. Selection narrows requested scope and never grants access.

Before every domain read, the Worker authenticates the principal and verifies, for every selected project: immutable credential project scope, current project status, current direct project membership and role for the principal owner, and current workspace membership. If repository-bound, it also verifies the current exact provider, stable repository ID, canonical identity, and project link. The complete explicit set is compared by count in one authorization query. Any mismatch fails all-or-nothing without identifying the project. No project metadata, artifacts, graphs, sources, or Context Engine retrieval starts before that check succeeds.

### Protocol and tool boundary

Define the provider-neutral `McpTransport` only as bounded MCP protocol decoding/encoding plus stable dispatch. Ship exactly one `WorkerMcpTransport`, instantiated for the one `GET/POST /mcp` route. There is no factory, registry, alternate transport, per-project server, AI provider, session store, or Graphify MCP reuse.

POST accepts at most 16 KiB of UTF-8 `application/json`, implements JSON-RPC 2.0 `initialize`, `ping`, `tools/list`, `tools/call`, and empty-body `202` notification handling for protocol version `2025-03-26`, and maps parser, method, parameter, authorization, rate, and domain failures to stable JSON-RPC errors. Encoded responses are capped at 128 KiB. GET authenticates and consumes replay/rate capacity, then returns the Streamable HTTP `405 SERVER_NOTIFICATIONS_UNSUPPORTED` response because this server has no server-initiated stream. The response is private/no-store and never establishes a per-project MCP session.

The transport always advertises exactly `project_info`, `search_context`, `get_artifact`, `query_graph`, `get_sources`, and `sync_status`. Schemas contain selectors and bounded scalar arguments, never project enumerations. Domain dispatch revalidates arguments. Results preserve project plus source/version/commit/checksum provenance where applicable. `search_context` reuses the one `ContextEngine`; graph queries reuse verified private-R2 loading and the bounded explorer query; artifact reads derive and verify the exact project key, HEAD metadata, byte size, checksum, and UTF-8 before returning a bounded excerpt. Source and sync outputs are metadata-only and bounded. No administrative or full Graphify operation is exposed.

## Alternatives rejected

- Human session cookies at `/mcp` are broad, CSRF-oriented browser credentials and do not provide operation/project/repository scope, one-time display, rotation, replay, or local secret-store semantics.
- Phase 10 CI credentials authorize graph lifecycle mutation and must not become context-read credentials.
- One endpoint or tool set per project makes schemas/configuration grow with project count and creates ambiguity during switching.
- Upstream Graphify MCP lacks Context Hub tenancy, direct membership, immutable project resolution, credential lifecycle, replay/rate controls, and Context Engine behavior.
- API keys in query/body fields, plaintext D1 secrets, long-lived static keys, implicit global project scope, partial cross-project success, and workspace-derived project access violate the threat model.
- SSE/server-initiated messages and a transport factory add behavior the six request/response tools do not need.

## Consequences

MCP clients must provision a scoped credential through an ADMIN human session, store the displayed secret in OS credential storage where possible, send a fresh nonce per HTTP request, and explicitly supply repository/project scope. Repository-bound credentials stop working after repository replacement. Membership removal, workspace removal, role loss for lifecycle administration, expiry, rotation, and revocation are observed from current D1 state.

Cross-project Context Engine searches use one caller budget across the already-authorized projects; too-small budgets never exceed the total. ADR 0008 replaces the provisional per-project split with one globally ranked/deduplicated engine result and one token/byte/source budget. Tool results can report individual source unavailability only after scope authorization. The six schemas and transport response ceiling remain constant with project count.

## Security and operations

Keep Authorization and nonce headers out of logs. Apply edge rate limiting in addition to the D1 enforcement when deployment evidence is available. Monitor only redacted operation/outcome counts, replay/rate denials, integrity failures, result-limit failures, and lifecycle events. D1 is the clock and lifecycle truth; R2 remains private and every payload read is metadata- and checksum-verified.

Live MCP client interoperability, OS secret-store handoff, edge/log redaction, remote D1 contention, and production rate tuning remain release evidence. Phase 15 separately measures model-visible token costs and may trim descriptions/results without adding tools or weakening provenance.

## Rollback and recovery

Disable `/mcp` and the lifecycle routes, then revoke affected principals/credentials in D1. Additive tables may remain because audit and hash metadata are non-secret and immutable. Do not restore an old credential during rollback. Forward recovery may issue a new credential or protocol version while retaining the same six stable tool names and all-or-nothing authorization rules.
