# ADR 0005: CI machine graph publication

- Status: Accepted
- Date: 2026-09-13
- Scope: Master-plan Phase 10 machine authentication and canonical CI publication transport

## Context

Graph generation is too heavy and toolchain-sensitive for a Worker request. Human sessions can reserve builds, but allowing those sessions to upload graph bytes would combine interactive authority with a reusable publication capability. ADR 0003 fixes the build profile and ADR 0004 fixes attempt-scoped immutable storage; this decision defines the narrow external transport that may invoke the existing claim, publish, and fail operations.

## Decision

Use a separate machine principal, never a human session, for CI publication. An ADMIN issues a 256-bit one-time bearer secret; D1 stores only its SHA-256 hash. The principal is immutably bound to one project, repository provider, stable provider repository ID, and the fixed `GRAPH_CLAIM_PUBLISH_FAIL` scope. Credentials expire according to D1 current UTC time, rotate atomically by revoking the prior credential while creating its replacement, and revoke immediately. Revoking the last active credential also revokes its principal so repeated revoke-and-reissue cycles cannot exhaust the active-principal bound. ADMIN authorization is rechecked directly in each lifecycle mutation.

Every machine call supplies the exact project, provider repository ID, source commit, graph version, bounded unique nonce, and operation. Publish/fail additionally supply the exact attempt, lease, and publication identity; the server derives the storage key. A nonce is hashed, atomically inserted, retained for one hour, and rejected on replay. Claim is allowed only for an already `QUEUED` complete build identity, except that the same authenticated claim path first expires a D1-clock-expired attempt and requeues it with a distinct incremented attempt. Publication delegates to the Phase 9 create-only R2 and full exact-byte validation/finalization path, including its exact replay semantics; ambiguous responses retry identical bytes with a fresh request nonce, and only a definite failure is reported against the attempt. No route accepts a human cookie as publication authority, no webhook runs Graphify, and the Worker performs no graph generation.

Machine and credential lifecycle audit rows contain bounded identifiers, action, outcome, version, attempt, actor/principal, and D1 time only. D1 triggers commit successful machine claim/fail/publish audit evidence in the same statement as the attempt transition, so an audit failure rolls back the transition; safely identified denials and transport failures record bounded `DENIED` or `FAILED` outcomes. They never contain bearer secrets or hashes, authorization headers, nonces, leases, storage keys, graph bytes, or repository content. Lists omit hashes and secrets; issue/rotate responses display the bearer secret once. Authentication and binding failures use one nonleaking error.

The canonical workflow separately checks out the exact untrusted source commit and a protected full-SHA Context Hub tooling revision, executes npm and runner code only from the trusted checkout, installs the complete CPython 3.12 Linux x86-64 wheel lock with `--require-hashes --only-binary`, attests that its process is inside a bounded cgroup and that checkout/output are on a bounded filesystem, invokes the existing `GraphifyAdapter`, and publishes exact validated bytes or reports a bounded failure category. It uses a dedicated self-hosted runner because GitHub-hosted runners do not provide an attestable per-job writable-volume quota and delegated memory cgroup. Third-party Actions are pinned by full commit SHA and permissions are read-only.

## Consequences

A stolen credential can act only for its bound project/repository and fixed lifecycle scope until D1 expiry or revocation, but it remains sensitive and belongs only in the GitHub environment secret store. One active credential per principal makes rotation unambiguous. Nonce rows are bounded by expiry cleanup; immutable unexpired rows preserve replay evidence. Complete build identity uniqueness and queued claim exclusion prevent duplicate generation for an unchanged complete identity.

The checked-in workflow fails closed unless a runner satisfies the documented cgroup, volume, Python, Git, Node, and network prerequisites. Local source inspection and mock tests cannot prove live external package installation, Actions runner containment, remote D1/R2 behavior, or representative resource sizing; those remain release evidence, not reasons to weaken attestation.

## Rollback and recovery

Disable the workflow and machine routes, revoke all active machine credentials, and retain additive D1 tables, nonce/audit evidence, graph attempt rows, selected immutable objects, and uncertain orphans. Never restore human publication or version-only writers. Reads continue through the Phase 9 layout-aware path. Forward recovery rotates credentials, repairs the runner or transport, retries only an eligible failed logical version, and preserves exact attempt/replay fencing.
