# ADR 0003: Graphify canonical build profile

- Status: Accepted
- Date: 2026-09-11
- Review date: 2026-09-12
- Approver: Independent final review
- Review evidence: ACCEPT with no P0 or P1 findings
- Scope: Master-plan Phase 7 research and the contract for later Graphify adapter, graph-version, and CI phases

## Context

Context Hub needs structural code knowledge derived from an exact Git commit while preserving Git as source truth, D1 as metadata truth, and immutable R2 objects as payload truth. Graphify has a Python CLI, mutable/watch behavior, and MCP/HTTP capabilities, but it does not supply Context Hub tenancy, authorization, publication lifecycle, an authoritative payload checksum, or a formally versioned output schema.

Research of [`Graphify-Labs/graphify`](https://github.com/Graphify-Labs/graphify) official tag [`v0.9.58`](https://github.com/Graphify-Labs/graphify/tree/v0.9.58) with an isolated Python 3.11 Git fixture established a finite code-only extraction/clustering path and observed NetworkX node-link JSON. Normal untracked files could be included. One fixture followed an in-repository tracked symlink, while another ignored a tracked absolute file symlink to an outside target. This variability cannot be a security boundary. Full findings, exact official-tag source citations, the upstream CLI/watch/incremental/MCP/auth capability matrix, and the implementable Context Hub acceptance contract are in [`graphify-integration.md`](../graphify-integration.md).

Independent final review accepted this ADR and the research contract on 2026-09-12 with no P0 or P1 findings. Acceptance is documentation-only and does not start the adapter or any later implementation phase.

## Decision

Adopt exactly one profile, `code-only-clustered-v1`, using `graphifyy==0.9.58` and CLI `graphify` on Python 3.11 or 3.12. The researched wheel SHA-256 is `e239803288e91c723d6e30540860bd6d5a1dc3f0914b9fc1104b0233e98aaeb8`; implementation must hash-lock all resolved dependencies and Action references.

Require host configuration of Git, Python, and Graphify as canonical absolute paths to trusted regular executable files outside the canonical checkout. Reject missing, relative, symlinked, non-executable, checkout-local, or changed paths before any subprocess or temporary output; never resolve bare executable names. Give subprocesses the fixed absolute-only `PATH=/usr/bin:/bin`, never ambient `PATH`.

Before Graphify runs, require a detached exact-commit checkout and reject every dirty or untracked file (including ignored-but-present files found by inventory), every tracked symlink (Git mode `120000`), every submodule/gitlink (mode `160000` or declared/materialized submodule), and every tracked Git LFS pointer. A clean Git status alone is insufficient because ignored files, symlinks, gitlinks, and LFS pointers can all be clean. The profile rejects all tracked symlinks regardless of target or Graphify's observed behavior.

Create a new empty absolute temporary directory outside the checkout. In a scrubbed environment, set `GRAPHIFY_OUT` to that same directory for both exact processes:

```text
graphify extract <checkout> --code-only --no-cluster
graphify cluster-only <checkout> --no-label --no-viz
```

Both processes read/write external state via `GRAPHIFY_OUT`; do not assume a `--out` option on `cluster-only`. After both exit zero, accept exactly `${GRAPHIFY_OUT}/graph.json`, require it to be a regular non-symlink file, and verify the checkout remained untouched. Parse only for validation and compute SHA-256 over unchanged source bytes; never reserialize before hashing/storage.

Define one future minimal `GraphProvider` and one Graphify adapter, with no factory. It returns exact bytes, SHA-256, byte size, derived counts, generator, and complete immutable provenance. It owns no project/version allocation, authorization, credentials, R2/D1 key or lifecycle decision.

Build/dedup identity and stored graph metadata must include all of:

- repository provider;
- stable provider repository ID;
- immutable normalized repository identity snapshot, including provider, provider repository ID, normalized owner/name, and canonical URL;
- project ID;
- source commit;
- Graphify version;
- adapter version;
- profile; and
- format version.

Repository owner/name or URL alone is not identity. A replacement repository at the same name and even the same commit SHA has a different provider repository ID and can never reuse the prior repository's graph. An exact unchanged tuple may reuse its reservation/result; any tuple component change creates a distinct build identity.

## Format-v1 acceptance

These are Context Hub acceptance rules derived from observed 0.9.58 output, not an upstream formal schema. Unsupported/unobserved variants fail closed. The normative detailed field and parser contract is [`graphify-integration.md`](../graphify-integration.md); the decision requires:

- exact UTF-8 JSON no larger than 8 MiB, maximum depth 12, maximum 64 keys per object, duplicate-key rejection at every depth, and no reserialization before SHA-256;
- exactly the top-level keys `directed`, `multigraph`, `graph`, `nodes`, `links`, `hyperedges`, and `built_at_commit`, with their documented types; `directed=false`, `multigraph=false`, lowercase exact 40-hex commit, bounded `graph`, and empty `hyperedges` are mandatory;
- node records containing required strings `id`, `label`, `file_type`, `source_file`, and `source_location`; unique nonempty IDs; the documented typed optional fields; and unknown fields only under the bounded scalar rule below;
- link records containing required strings `source`, `target`, `relation`, `confidence`, `source_file`, and `source_location`; finite-number `confidence_score` and `weight`; endpoints referencing unique node IDs; `confidence` exactly `EXTRACTED`, `INFERRED`, or `AMBIGUOUS`; the documented typed optional fields; and unknown fields only under the bounded scalar rule below;
- source locations matching `L<positive integer>` and source files that are normalized checkout-relative POSIX paths with no empty/absolute/dot/dot-dot/NUL/backslash/escape and that exactly correspond to tracked regular non-symlink files from preflight;
- every string/key/ID/label/relation/context/type/community-name/path/location bound measured in UTF-8 bytes: generic strings at most 4,096 bytes; ID/label/relation/context/type/origin/normalized-label/confidence/community-name strings at most 512; paths 1,024; locations 32; keys 64; and every ASCII JSON numeric token at most 128 characters and finite after JavaScript binary64 conversion (including JavaScript-compatible underflow); and
- unknown top-level fields rejected; unknown `graph`, node, and link fields accepted only when their keys are bounded and values are bounded scalars (null, boolean, finite JSON number, or bounded string), never nested arrays/objects. Accepted unknown scalar bytes remain untouched in the stored payload.

The existing hard ceilings remain 50,000 nodes, 100,000 links, 10,000 hyperedges, and a 4 KiB adapter/publication metadata envelope; format v1 nevertheless requires exactly zero hyperedges. Counts are derived from accepted arrays and output is never truncated.

## Lifecycle and security

Reserve one monotonic graph version at queue time. Payload/storage/checksum/count/generated fields remain nullable until `READY`; `generated_at` means READY publication. Allow `FAILED -> QUEUED` only on the same unready reservation with incremented attempt. Runner termination or lease expiry makes the active attempt `FAILED`; any late upload/finalize is rejected by current lease plus attempt identity. READY is immutable forever.

GitHub Actions is the canonical heavy executor; the Worker authorizes and publishes only. Publication is immutable R2 object-first, followed by transactional D1 READY transition and prior-READY supersede. Failures preserve prior READY. Idempotency requires complete identity, version, size, counts, and checksum equality. Uncertain objects are retained for grace-period reconciliation rather than deleted speculatively.

Direct members may later read/query bounded READY graphs. ADMIN alone may trigger/retry builds and manage publication credentials; interactive cancellation is deferred beyond MVP. Only an exact scoped machine principal, never a human browser session, uploads/finalizes. Credentials bind principal, project, provider repository ID, operation, commit, reservation, lease, attempt, expiry/revocation, and nonce/idempotency state. R2 remains private. Logs exclude credentials, repository/graph bodies, and uncontrolled tool output.

Execution receives no model/API key. Upstream query/MCP transport is rejected; optional query logging remains default-off during any isolated research. Bound runtime resources and diagnostics and treat the repository and output as hostile.

## Alternatives rejected

- **Embedded library or Worker/webhook execution:** couples runtime internals or exceeds bounded request lifecycles.
- **Hosted Graphify service or upstream MCP/HTTP:** adds trust/hosting and lacks Context Hub authorization and publication semantics.
- **Direct R2 or local authoritative publication:** bypasses controlled checkout, identity, authorization, replay, metadata, and audit boundaries.
- **Watch/update/incremental output:** optional-watchdog/debounced rebuilds, mutable lock/queue state, MD5 manifests, salted SHA-256 caches, tier-preserving AST/semantic replacement, pending semantic flags, and shrink handling weaken canonical provenance and retry semantics.
- **Allowing selected symlinks, submodules, or LFS in v1:** clean status does not establish safe, complete, immutable source provenance.
- **Semantic docs/media, merge/global/PR graphs, editing/normalization, reimplementation, multiple profiles/providers:** outside the accepted MVP product boundary.

## Consequences

The artifact is strongly provenance-bound but not claimed byte-deterministic across paths, platforms, Python minors, architectures, locale/timezone, or dependency resolutions. Two fresh same-path Python 3.11 fixture runs were byte-identical; the retained notes did not preserve the digest. Strict validation may reject a future Graphify variant until deliberately reviewed, which is preferable to silent conversion.

The bounds may reject large repositories and no partial graph is published. All symlink, submodule, and LFS repositories are unsupported for this initial profile. The format contract must be fixture-locked before implementation and reviewed on every tool/profile/format change.

This decision is documentation only. It does not start or complete `GraphProvider`, adapter, schema/migrations, routes, workflow, credentials, explorer, deployment, or live verification.

## Operations

Before production, verify the complete dependency lock, Action commit pins, exact environment recipe, output isolation, clean/index preflight, fixture schema, checksums, bounds, redaction, and both supported Python minors. Benchmark representative repositories. Monitor queue/build timing, resource use, validation categories, oversized results, conflicts, orphans, integrity failures, credential denials, and stale READY versions.

Known unknowns remain representative resource sizing, cross-environment determinism, future upstream compatibility, any safe future support for symlinks/submodules/LFS, and live Actions/D1/R2 publication behavior.

## Rollback and forward recovery

Before READY publication, rollback disables triggers/credentials and removes only proven-unreferenced test objects. After publication, never edit/delete a READY version or repoint it to different bytes. Disable new triggers, preserve the latest valid READY graph, revoke compromised credentials, and retain failures/audit evidence.

Forward recovery changes the adapter/workflow under a new adapter version or approved tool/profile/format identity, updates this ADR when its contract changes, reserves a distinct immutable version, and supersedes only after READY. Transient unchanged-identity failures retry the same unready reservation. Orphan cleanup requires a grace period and a D1/R2 publication recheck.
