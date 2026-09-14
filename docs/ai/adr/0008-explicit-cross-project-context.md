# ADR 0008: Explicit cross-project context retrieval

- Status: Accepted
- Date: 2026-09-16
- Scope: Master-plan Task D explicit cross-project context

## Context

The current `ContextProvider` retrieves one authorized project's bounded artifact, current verified Git, current repository-matched graph, and built-in guidance. MCP can authorize an explicit project set, but `search_context` calls the engine once per project with divided budgets and concatenates those project results. That is not global relevance ranking and can multiply retrieval work or make the caller's project order affect selection.

Task D requires one explicit set of one to twenty projects, all-or-nothing current authorization before source reads, exact project provenance, deterministic global ranking and deduplication, and one caller-wide response budget. The design must preserve the existing single-project API and the stable six-tool MCP protocol. There is currently no retrieval cache or index.

## Decision

### Scope and authorization

Extend the one `ContextProvider`/`ContextEngine` seam with a multi-project search accepting an explicit project ID array, query, optional domain/package, and one token/byte/source budget. Project IDs are validated, deduplicated, and canonically sorted, with one to twenty unique IDs. The existing single-project `search` input and result remain supported by adapting through the same implementation.

Authentication and authorization remain caller-owned. The human cross-project route authenticates first, validates the complete selector, then uses one project-count authorization query that requires every selected project to be active and the user to have current direct project membership and a current workspace membership. MCP retains its scoped-principal checks and revalidates credential scope, active project, current direct role/workspace membership, `search_context` operation scope, and optional repository binding for the complete set immediately before calling the engine.

Callers construct one opaque `ContextAuthorizationFence` through fixed human or MCP policy factories; no request value can supply SQL. The D1 query layer appends its trusted parameterized complete-canonical-set predicate to every Context Engine Git, artifact, and graph metadata SELECT. Human fences recheck active projects plus current direct role/workspace membership. MCP fences additionally recheck the active principal, unrevoked/unexpired credential, complete project and operation scopes, and any exact repository binding. The engine checks the fence around each metadata query and immediately before every private R2 HEAD/GET. A mismatch aborts the entire request with the existing generic nonleaking project response. No source metadata or storage read proceeds under a stale initial authorization decision.

### Retrieval, ranking, deduplication, and budget

The engine retrieves each authorized project through the existing project-predicated source logic. Archived artifacts remain excluded. Artifact and graph key derivation, private R2 HEAD-before-get, metadata/byte/checksum/schema verification, graph repository identity matching, freshness classification, and complete provenance are unchanged.

Candidates from all projects enter one global ranking. Score is primary. Equal scores use a deterministic fair tie: each project's first candidate precedes any project's second candidate, with canonical project ID and stable source key breaking remaining ties. Caller project order therefore cannot change output. Exact byte-for-byte excerpt duplicates are removed only within the same project; equal evidence from different projects remains distinct because project provenance is semantically significant.

After global ranking and deduplication, the engine applies one serialized-result byte ceiling, one complete-evidence token ceiling, and one overall source count. It never multiplies budgets by project count or reserves a private per-project response budget. Retrieval caps are also caller-wide: the fixed candidate/source limits are shared deterministically across the canonical project set. Before retrieval, the engine computes the exact UTF-8 fixed-point byte size of the complete canonical empty response shell and rejects a budget that cannot encode it. Source errors are admitted only while the complete final shell still fits; omitted errors make truncation truthful. A final exact serialization assertion fails closed against any oversized result. A budget that fits the shell but not evidence returns a valid truncated empty result.

Authorized source corruption is bounded and fail-closed. Corrupt evidence is omitted and a finite source error identifies only its already-authorized project and source class. One project's source failure does not invent, relabel, or suppress another project's provenance. Infrastructure failure at the route boundary remains one generic unavailable response.

### Cache and transport

No cache, vector index, persistent retrieval index, provider registry/factory, alternate transport, or alternate backend is introduced. Therefore Task D exposes zero cache-state API, storage, invalidation, or reuse surface. If a cache/index is approved later, its key must include the complete canonical authorized project set, authenticated principal, query/domain/package, all budget/config versions, and complete source provenance; entries for a superset or subset may never be reused.

MCP `search_context` calls the one multi-project engine once after authorization. The endpoint, transport, six tool names, schemas, tool-list bytes, token-audit digest, replay/rate limits, response ceiling, and caller-wide selector limits remain unchanged. Project selection never grants access.

## Alternatives rejected

- Per-project engine loops with divided budgets or concatenated output are order-sensitive, are not globally ranked, and can starve a relevant project.
- Partial authorization or partial results disclose scope and violate the tenancy boundary.
- Deduplicating across project provenance can falsely attribute evidence to the wrong repository.
- Inferring workspace-wide or repository-similar scope is not explicit authorization.
- Adding a cache, vector database, provider factory, per-project MCP tool/server, or new transport is unnecessary for this bounded phase and widens security and operational scope.

## Consequences

Cross-project latency includes bounded source verification for each selected project, but caller-wide caps limit work and response size. Canonical ordering and fair score ties make repeated calls deterministic. The single-project contract remains source compatible, while cross-project consumers receive one globally ranked evidence list with project IDs on every provenance record and project-safe bounded source errors.

The human endpoint is API-only; no global management navigation or cross-project UI is added. Live performance at twenty projects and remote D1/R2 behavior remain external evidence.

## Security and operations

External authorization failures use one status/code/body independent of which project failed and include no selected ID, name, count, or order. CORS reflects only the configured exact web origin and all responses are private/no-store. Queries remain parameterized and bounded. Logs and audit records must not contain query text, excerpts, storage keys, inaccessible selectors, or failure details.

Monitor only bounded aggregate latency, result size, and source-class integrity failures after log-redaction and privacy design are approved. There is no cache to inspect, flush, poison, or partition in the current implementation.

## Rollback and recovery

Disable the cross-project human route and make MCP `search_context` reject multi-project selectors while retaining single-project retrieval. The additive domain types and ADR may remain. No migration, cached state, index, or payload rollback is required. Recovery re-enables the same route and one-engine MCP dispatch after authorization and integrity checks pass.
