# ADR 0001: Current Provider Boundaries

- Status: Accepted
- Date: 2026-09-11
- Scope: Phase 5A authentication and object-storage seams

## Context

The Worker already uses GitHub OAuth for human identity and Cloudflare R2 for immutable artifact bytes. Provider calls were embedded in application and artifact-domain code. The architecture requires provider-neutral seams before Git work, but additional providers, dynamic selection, and generalized plugin infrastructure are not approved.

The extraction must preserve the existing security boundaries: OAuth state and sessions are application data, while artifact keys, checksums, publication, recovery, and compensation decisions are domain behavior. D1 and R2 cannot share a transaction, so uncertain writes and conservative deletion remain important.

## Decision

Define a narrow `AuthProvider` contract with a normalized identity and exactly one `GithubAuthProvider` implementation. The adapter owns:

- the GitHub authorization URL;
- callback-code exchange and transient use of the returned token;
- exact GitHub request endpoints and headers;
- provider HTTP response checks;
- required `id` and non-empty `login` validation; and
- normalization of optional malformed `name` and `avatar_url` values to `null`.

The adapter never returns or persists the access token. The application continues to own random OAuth state, hashed state storage, the state cookie, atomic one-time state consumption, D1 user/session records, redirects, session cookies, roles, and authorization.

Define a narrow `ObjectStorage` byte/metadata contract with exactly one `R2ObjectStorage` implementation. The adapter owns:

- conditional create-only object writes;
- normalized head metadata;
- retrieval as bytes; and
- an explicitly named `compensationDelete` operation.

The artifact domain continues to own server-generated project keys, checksums, upload identifiers, authorization, D1 publication, collision/recovery interpretation, exact uncertain-write adoption checks, integrity validation, and whether compensation is safe. The Worker constructs the R2 adapter from the unchanged `Env.OBJECTS: R2Bucket` binding at its composition boundary. Health checks use the same adapter; a missing sentinel remains healthy.

There is no registry, factory, service locator, fallback, dynamic provider selection, additional provider implementation, dependency, or migration.

## Failure Semantics

- Missing GitHub configuration remains `503 AUTH_UNAVAILABLE`.
- GitHub non-success HTTP responses and missing/invalid required response shape become the existing `502 AUTH_FAILED` response.
- Invalid, expired, or replayed application OAuth state remains `400 INVALID_OAUTH_STATE` and is checked before provider exchange.
- Network errors and malformed provider JSON continue through the Worker generic boundary as `500 INTERNAL_ERROR`.
- R2 create-only success and collision remain distinct. R2 exceptions remain distinct from collisions in domain handling.
- A lost create acknowledgement is adopted only when head matches byte size, HTTP content type, custom content type, checksum, and upload ID exactly.
- D1 publication still precedes any compensation decision. Compensation deletes only after D1 proves no matching publication; D1/head/delete uncertainty leaves an orphan rather than risking published data.
- Artifact reads still validate D1 byte size and checksum and return the existing generic storage-integrity error without exposing keys.

## Alternatives Rejected

- Keeping direct provider calls was rejected because it leaves the approved current-provider boundary incomplete.
- A provider registry/factory or multiple implementations was rejected as speculative and would widen configuration and fallback behavior.
- Moving OAuth state, sessions, D1 publication, keys, checksums, or compensation policy into adapters was rejected because it would mix provider mechanics with application security and domain truth.
- Changing provider/network error mapping was rejected because this phase is behavior-preserving.

## Consequences

Provider mechanics now have focused contract tests and can be tested through injected fetch or R2 fakes without global state. Application and route regression tests continue to cover state, sessions, authorization, publication, recovery, integrity, and compensation. The seams remain intentionally small; future Git, graph, context, and MCP contracts require their own approved phases and ADRs.

## Security and Operations

Tokens remain transient within the GitHub adapter and are absent from returned identities, D1, responses, and logs. R2 remains private and Worker-only. Exact provider requests and storage metadata are contract-tested. Local fakes cannot prove live GitHub or Cloudflare behavior, so live OAuth and remote R2 validation remain production release gates.

## Rollback

The extraction can be reverted by inlining the single adapters into their current callers without a data migration. No schema, object key, stored metadata, route, environment binding, or public response changes are introduced.
