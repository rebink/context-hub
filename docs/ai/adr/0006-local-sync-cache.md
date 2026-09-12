# ADR 0006: Local graph synchronization and offline cache

- Status: Accepted
- Date: 2026-09-14
- Scope: Master-plan Phase 11 local CLI, authenticated graph download transport, and repository-local cache

## Context

Context Hub needs a dependency-light local client that can retain a verified graph without making Git or normal development depend on service availability. Git remains source truth, D1 remains remote metadata truth, and R2 payloads remain immutable. The local filesystem is an untrusted boundary: a checkout can contain hostile symlinks or a partially completed update, and graph and metadata files cannot be replaced together by one portable filesystem operation.

Phase 11 does not authorize MCP, a Context Engine, artifact synchronization, or new local-client principal and credential lifecycle APIs.

## Decision

Add one Node 22 TypeScript CLI workspace exposing `context connect`, `context status`, and `context sync`. It uses only Node APIs and Fetch. The fixed project-local layout is:

```text
.ai-context/
  manifest.json
  graph/graph.json
  graph/meta.json
  artifacts/
  cache/
```

`artifacts/` and `cache/` are created empty in this phase. No archive is downloaded or extracted.

The manifest contains format version, API origin, project ID, normalized repository identity, and the selected local graph version, source commit, checksum, byte size, and sync time. It never contains a credential. `connect` resolves or validates the project through the existing authenticated human session boundary and writes only non-secret connection metadata. Until the separately designed local-client principal phase, the CLI accepts the existing opaque human session value through `CONTEXT_HUB_SESSION` or through an OS-secret helper that injects that environment value. Online status/sync also require an independently supplied `CONTEXT_HUB_API` origin that exactly matches the manifest; a repository edit therefore cannot redirect a credential. The CLI sends the value as the existing session cookie over HTTPS (HTTP is allowed only for loopback development), never accepts it as an argument, and never writes or logs it. This is a narrow integration boundary, not a new bearer principal or credential-management API.

The Worker adds two bounded GET routes. Metadata returns only the authorized project's normalized repository head, newest graph lifecycle metadata, and current READY graph metadata. Every graph result includes immutable repository provenance and is selected only when its provider, stable provider repository ID, and canonical URL match the project's current verified Git connection. Download returns exact bytes only when the requested version is the authorized project's current READY graph for that same repository, after the existing private-R2 size, checksum, metadata, and full format-v1 validation. Routes authenticate first using the existing session, verify direct project membership, predicate every query by project and repository, and expose no R2 key, publication identity, lease, direct URL, unrelated version set, or graph body in metadata.

Status uses this deterministic precedence:

1. `COMMIT_MISMATCH` when the local manifest/meta/bytes disagree, the connected repository identity differs, or online local and remote Git commits diverge / local is behind.
2. `GRAPH_BUILDING` when the newest remote graph is `QUEUED` or `BUILDING`.
3. `GRAPH_FAILED` when the newest remote graph is `FAILED` and no newer READY graph is available for download.
4. `NO_LOCAL_GRAPH` when no verified local graph exists.
5. `REMOTE_GRAPH_AHEAD` when the current remote READY version is greater than the verified local version.
6. `LOCAL_REPOSITORY_AHEAD` when the remote Git commit is an ancestor of local `HEAD`.
7. `GRAPH_STALE` when the verified local graph source commit differs from local `HEAD`, or the current remote READY graph is behind the remote Git commit.
8. `CURRENT` otherwise.

Every status and sync invocation re-reads and normalizes the checkout's current `origin`; a missing, changed, or copied-checkout remote is a highest-precedence `COMMIT_MISMATCH` and no credentialed request is sent. Offline status applies the same local integrity checks, then reports `NO_LOCAL_GRAPH`, `GRAPH_STALE`, or `CURRENT` with `offline: true`; it never deletes data or blocks Git. Network failures, timeouts, and retryable `408`, `425`, `429`, and `5xx` responses fall back to verified offline status, while authentication, authorization, malformed-response, and integrity failures remain visible. Git ancestry is checked with bounded `git` subprocesses and exact 40-hex SHAs.

Sync accepts only the server-selected current READY graph. It bounds headers and response bytes, checks content type, version, checksum, byte size, source commit, immutable repository identity, graph metadata, and exact graph bytes before touching the selected cache. Downloaded and locally cached bytes pass the same dependency-free duplicate-aware full format-v1 validation used at the Worker boundary, including node/link records, endpoints, paths, locations, extensions, numeric syntax, and counts. All paths are fixed normalized relative paths beneath the canonical project root. Existing path components and selected files must be real directories or regular files, never symlinks; absolute, dot, dot-dot, backslash, NUL, and containment escapes are rejected. Directory device/inode identity is retained and rechecked around filesystem operations so replaced parent paths fail closed.

The client serializes every cache read/recovery/mutation with an exclusive no-follow project-contained lock; a live owner causes a bounded `SYNC_IN_PROGRESS` failure and a dead process owner is recovered before work begins. It opens project-contained temporary files with exclusive create and no-follow flags, writes exact bytes, fsyncs each file, and fsyncs its directory. Temporary preparation is encompassed by cleanup so every successfully created temporary is removed if a later preparation fails. Before replacement it creates no-follow recovery copies of any prior selected graph/meta/manifest and persists a transaction marker. It atomically renames graph and meta, fsyncs their directory, then atomically replaces and fsyncs the manifest last. Successful completion removes recovery files and marker and fsyncs directories. On any HTTP, authentication, offline, validation, corruption, mismatch, write, fsync, or rename failure, it restores the prior files. At startup, a persisted marker triggers the same rollback before reads or a new sync, covering process interruption. If no prior file existed, rollback removes only the newly installed fixed-path file.

Local graph reads parse only the verified bounded `graph/graph.json` selected by the manifest/meta tuple. They remain available offline and do not contact the service. Phase 11 exposes this read seam to the CLI status/sync implementation but does not add search, MCP, Pi, or Context Engine commands.

## Alternatives rejected

- Direct or presigned R2 URLs expose storage addressing and weaken authorization and integrity mediation.
- Storing a token in `.ai-context`, Git config, command arguments, or manifest risks repository, process-list, shell-history, and log disclosure.
- Adding a local-client principal now would implement the later credential/API phase prematurely.
- Replacing graph and meta without recovery can destroy the last valid pair after a second rename or process interruption.
- Version directories or archive extraction widen the required fixed layout and introduce unsupported artifact/archive behavior.
- Treating the network as required for status would make local development fail during outages.

## Consequences

The repository may contain non-secret project and graph provenance. A human session must currently be supplied for online commands and retains its existing authority and expiry; dedicated scoped local credentials remain a later decision. A short recovery window leaves bounded hidden transaction files under `.ai-context`; every command resolves it before use. Local files are a cache, not metadata truth, and are never uploaded.

The fixed pair plus rollback protocol is more code than an unguarded rename but retains the exact requested paths and preserves the prior verified cache across anticipated failures. POSIX `O_NOFOLLOW` is required for mutation; unsupported platforms fail closed for connect/sync while read-only offline status can report an unsafe layout error.

## Security and operations

Requests and files are bounded to the accepted 8 MiB graph maximum and small metadata/manifest envelopes. Redirects are rejected, credentials are sent only to the configured origin, response errors are stable, and secrets and graph bytes are not logged. Operators must keep R2 private and monitor sync authorization, integrity, size, and availability failures without payloads or credentials.

Live browser/session handoff, OS secret-store helper integration, remote Worker/D1/R2 behavior, crash injection on target filesystems, Windows support, and production rate limits remain external release evidence.

## Rollback and recovery

Disable the sync routes and stop distributing the CLI. Existing verified local caches remain usable offline. Do not delete them automatically. A later invocation of the same CLI restores any transaction marker before proceeding. Forward recovery preserves the manifest format or introduces an explicitly versioned migration, continues to validate exact immutable graph provenance, and never interprets uncertain partial files as selected cache state.
