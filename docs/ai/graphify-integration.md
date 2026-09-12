# Graphify Integration Research

Accepted research contract for master-plan Phase 7 (the implementation playbook's source label is "Phase 5 - Graphify Research," Prompt 7). Independent final review accepted ADR 0003 and this research on 2026-09-12 with no P0 or P1 findings. Phase 8 implements the isolated adapter described here. Phase 9 human routes, attempt-scoped publication/storage, bounded explorer API, and status/focused-explorer frontend implement accepted [`adr/0004-attempt-scoped-graph-payloads.md`](adr/0004-attempt-scoped-graph-payloads.md) locally. Phase 9 is locally complete through migration 0013 with final bounded review ACCEPT; Phase 10 machine publication transport/workflow and live execution have not started.

## Decision summary

Context Hub will use Graphify as a pinned build-time CLI in GitHub Actions, not as a hosted service or application library. The accepted MVP profile is `code-only-clustered-v1`, using `graphifyy==0.9.58` (CLI `graphify`) on Python 3.11 or 3.12. The researched wheel SHA-256 is `e239803288e91c723d6e30540860bd6d5a1dc3f0914b9fc1104b0233e98aaeb8`; the future implementation must hash-lock the complete dependency set and Action references.

The isolated `packages/graphify-adapter` workspace has one minimal `GraphProvider` and exactly one `GraphifyAdapter`, with no factory, registry, fallback, or second implementation. GitHub Actions remains the planned canonical executor in Phase 10. The v1 canonical executor is POSIX-only: it requires detached process-group signaling plus `O_NOFOLLOW` and `O_NONBLOCK` safe output primitives before any Git, Python, or Graphify subprocess or temporary output creation. Unsupported hosts fail closed with redacted `UNSUPPORTED_PLATFORM`; Windows remains unsupported until a Job Object or equivalent process-tree containment and safe output implementation is implemented and tested. The Worker will coordinate and authorize immutable publication; local MVP clients will only download and query verified cached graphs.

The profile fails closed. Unsupported platforms and unobserved Graphify variants are not inferred from available runtime behavior or NetworkX conventions and require new evidence plus an ADR/profile or format-version review.

## Researched upstream

- Canonical source: [`Graphify-Labs/graphify`](https://github.com/Graphify-Labs/graphify), active/default branch [`v8`](https://github.com/Graphify-Labs/graphify/tree/v8).
- Distribution: PyPI [`graphifyy` 0.9.58](https://pypi.org/project/graphifyy/0.9.58/), released 2026-09-10, Python `>=3.10`, Apache-2.0.
- Researched source: official tag [`v0.9.58`](https://github.com/Graphify-Labs/graphify/tree/v0.9.58), resolving to commit [`23f2ffaa43fd12f25d9eabe91e6d184b5d89b474`](https://github.com/Graphify-Labs/graphify/commit/23f2ffaa43fd12f25d9eabe91e6d184b5d89b474).
- Wheel SHA-256: `e239803288e91c723d6e30540860bd6d5a1dc3f0914b9fc1104b0233e98aaeb8`.

## Upstream 0.9.58 capability matrix

This matrix records the upstream surface so the canonical boundary is explicit. Every capability marked in the decision column is rejected from Context Hub canonical generation/publication; only the accepted exact two-process code-only recipe in the next section is allowed.

| Upstream area | Graphify 0.9.58 capability | Context Hub canonical-publication decision | Official tag source |
| --- | --- | --- | --- |
| Relevant CLI | `extract` performs headless AST plus optional semantic extraction and supports `--code-only`, `--no-cluster`, and output selection; `update` incrementally rebuilds an existing graph; `watch` monitors a corpus; `check-update` reports pending semantic work; `cluster-only` reclusters an existing graph; `query`, `affected`, and `god-nodes` read/traverse it; `python -m graphify.serve` exposes MCP. | Reject all alternate generation, mutation, watch, query, and serving paths. Canonical publication admits only `extract <checkout> --code-only --no-cluster` followed by `cluster-only <checkout> --no-label --no-viz` under the controlled recipe. | [`graphify/__main__.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/graphify/__main__.py#L559-L647), [`README.md`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/README.md#L469-L489) |
| Watch | `watch` optionally imports `watchdog`, defaults to a 3-second debounce, rebuilds code changes, and writes `needs_update` for semantic doc/media work. Rebuilds mutate shared output and coordinate with a per-repository advisory `.rebuild.lock` plus queued `.pending_changes`; the POSIX lock degrades to a no-op where `fcntl` is unavailable. | Reject watch, flags, mutable lock-coordinated output, and background rebuilds as publication inputs. | [`graphify/watch.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/graphify/watch.py#L19-L218), [`graphify/watch.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/graphify/watch.py#L2182-L2281) |
| Update/incremental | The mutable incremental path uses a manifest with mtime plus MD5 content hashes and separate AST/semantic stamps. Extraction caches use SHA-256 over content plus a lowercased relative-path salt; AST caches are Graphify-version/schema namespaced, while semantic caches are intentionally unversioned but prompt-fingerprinted/mode-separated. Merge behavior replaces the re-extracted source's own AST or semantic tier, preserves the other tier and untouched sources, prunes deleted sources, and flags an unverified semantic-node shrink rather than silently treating it as verified. | Reject manifests, caches, partial AST/semantic replacement, shrink-guard override, and any mutable update result from canonical publication. A canonical run starts from the exact checkout and new empty external output. | [`graphify/detect.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/graphify/detect.py#L2058-L2534), [`graphify/cache.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/graphify/cache.py#L21-L84), [`graphify/cache.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/graphify/cache.py#L428-L529), [`graphify/build.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/graphify/build.py#L1647-L1800) |
| MCP transport/tools | The server supports stdio and MCP Streamable HTTP, defaulting to `127.0.0.1:8080` at `/mcp`. It exposes ten tools: `query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`, `list_prs`, `get_pr_impact`, and `triage_prs`; every tool receives optional client-supplied `project_path` for multi-project graph selection. | Reject the entire upstream MCP surface and client-selected filesystem scope. It is not the planned Context Hub six-tool MCP contract. | [`README.md`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/README.md#L475-L504), [`graphify/serve.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/graphify/serve.py#L1693-L1848) |
| MCP security | HTTP may require one static `--api-key`/`GRAPHIFY_API_KEY`, accepted as either `Authorization: Bearer <key>` or `X-API-Key`; without it, HTTP has no authentication. The upstream server supplies no Context Hub TLS termination, OAuth, operation/project scopes, membership/role enforcement, tenant isolation, credential lifecycle, replay controls, or rate limits. | Reject it as a Context Hub production transport or authorization boundary, even when its optional static key is set. | [`README.md`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/README.md#L491-L509), [`graphify/serve.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/graphify/serve.py#L2256-L2433) |
| Extraction auth/privacy | Code-only AST extraction is local and needs no key. Semantic backends use backend-specific API keys/credentials or local/CLI backends. HTTP MCP has only the optional static key above. Query logging is opt-in/default-off through `GRAPHIFY_QUERY_LOG_ENABLE` or `GRAPHIFY_QUERY_LOG`, with an explicit disable override and response logging separately opt-in. | The canonical code-only environment receives no model/backend/MCP key. Semantic backends, upstream HTTP auth, and query logging are rejected from generation/publication. | [`README.md`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/README.md#L515-L568), [`graphify/querylog.py`](https://github.com/Graphify-Labs/graphify/blob/v0.9.58/graphify/querylog.py) |

## Canonical input preflight

The adapter input is a detached checkout at the exact expected lowercase 40-hex commit, the fixed profile, and repository identity supplied by the authorized domain layer. Clean Git status is necessary but insufficient. Before either Graphify process starts, the v1 preflight must:

1. Resolve `HEAD`, require detached state, normalize it to lowercase, and require exact equality with the expected source commit.
2. Require no staged/unstaged change and no file outside the tracked-file set. Use `git status --porcelain=v1 --untracked-files=all` for ordinary changes and untracked files, plus an ignored-file/filesystem inventory so ignored but present files are also rejected (excluding Git's own administrative directory). The executor must not add files to the checkout.
3. Inspect the index, not only the worktree: reject every tracked symlink (`git ls-files --stage` mode `120000`) and every gitlink/submodule (mode `160000`) before Graphify runs. All tracked symlinks are unsupported, whether their target is inside, outside, relative, absolute, present, or broken.
4. Reject any submodule declaration/materialization and any tracked Git LFS pointer. LFS detection must inspect tracked non-symlink file content for the LFS pointer signature `version https://git-lfs.github.com/spec/v1`; it must not trust a clean pointer checkout as source content.
5. Snapshot the tracked regular-file path set for later `source_file` validation and verify after execution that the checkout remains unchanged.

This contract intentionally does not attempt safe symlink resolution. In one 0.9.58 fixture Graphify followed an in-repository tracked symlink; in another it ignored a tracked absolute file symlink whose target was outside the repository. That variation is empirical behavior, not a security boundary. Because v1 rejects every tracked symlink before execution, neither behavior is trusted or supported.

## Exact external-output recipe

The adapter must implement this recipe literally rather than infer an undocumented `--out` flag. Before step 1, both the adapter and its Node process boundary independently enforce their POSIX process-group requirements; the adapter also requires numeric `O_NOFOLLOW` and `O_NONBLOCK`. The deterministic-test seam can only disable detected capabilities and cannot let a caller attest an unsupported capability as present.

1. Create a new, empty, dedicated temporary directory, resolve it to an absolute path, and require it to be outside the checkout.
2. Require host configuration of Git, Python, and Graphify as canonical absolute paths to trusted regular executable files outside the canonical checkout. Reject missing, relative, symlinked, non-executable, checkout-local, or changed paths with a stable redacted error before any subprocess or temporary output. Construct a scrubbed subprocess environment with the fixed absolute-only `PATH=/usr/bin:/bin`, locale, and isolated temporary `HOME`/`TMPDIR`; never inherit ambient `PATH` or other configuration. Set `GRAPHIFY_OUT=<absolute-directory>` in that same environment.
3. With that environment, run `graphify extract <checkout> --code-only --no-cluster` and wait for exit zero.
4. With the same `GRAPHIFY_OUT` and scrubbed environment, run `graphify cluster-only <checkout> --no-label --no-viz` and wait for exit zero. There is deliberately no `--out` assumption on `cluster-only`; both processes read and write their shared state through `GRAPHIFY_OUT`.
5. Retain the created output directory's canonical path, directory/non-symlink status, and device/inode identity. Verify that identity before output scanning/open and after reading. Inspect the direct entry with `lstat`, then open it read-only with no-follow and nonblocking flags, verify the opened descriptor is a bounded regular file, read its exact bytes, and compare device, inode, size, mtime, and ctime between the descriptor and direct pathname both after close and after bounded traversal/root re-verification. A platform without those safe primitives fails closed. Reject a missing, unlinked, replaced, symlinked, non-regular, oversized, or alternate nested `graph.json`; never return bytes from an old unlinked inode, block on a FIFO/socket/device, or reserialize bytes.
6. Re-run the checkout preflight/status checks and fail if the worktree or index changed. Remove the external directory only after exact bytes have been consumed or retained for controlled publication. Cleanup failure after an otherwise successful build is the stable redacted `CLEANUP_FAILED`; an existing build/process/validation failure remains primary if cleanup also fails.

Commands, shown separately only for readability:

```sh
PATH="/usr/bin:/bin" GRAPHIFY_OUT="/absolute/new-empty-temp-dir" /trusted/absolute/graphify extract "/absolute/checkout" --code-only --no-cluster
PATH="/usr/bin:/bin" GRAPHIFY_OUT="/absolute/new-empty-temp-dir" /trusted/absolute/graphify cluster-only "/absolute/checkout" --no-label --no-viz
```

The adapter verifies the installed executable reports 0.9.58, enforces process timeout/tree termination on every completion path, and captures only bounded diagnostics that are never exposed publicly. Preflight accepts only normal stage-0 regular entries: NUL-delimited index inspection rejects `assume-unchanged`, `skip-worktree`, and other non-normal states, while a no-follow descriptor streams each worktree file into both its repository-format Git blob hash (`blob <size>\0` plus exact bytes) and SHA-256 fingerprint with before/after identity checks. Smudge filters or EOL conversion that make worktree bytes differ from the stage-0 blob are therefore conservatively rejected even when porcelain status reports clean. The adapter requires an attested host memory/disk policy but does not claim Node enforces those host limits; real enforcement and benchmarking remain Phase 10 blockers. `--code-only`, `--no-label`, and `--no-viz` require no model credential. Query/MCP mode is rejected; if its optional query logging is ever inspected during research, logging remains default-off and is not a production transport.

## Context Hub format-v1 acceptance contract

These are Context Hub's fail-closed `format_version=1` acceptance rules derived from observed Graphify 0.9.58 code-only output. They are not an upstream formal schema or compatibility guarantee.

### JSON and top level

The exact bytes must be at most 8 MiB, valid UTF-8, and one JSON object. The top-level object must contain exactly these keys and types; no other top-level key is accepted:

| Key | Required type and v1 rule |
| --- | --- |
| `directed` | boolean; must be `false` |
| `multigraph` | boolean; must be `false` |
| `graph` | object; bounded by the generic object/key/scalar rules below |
| `nodes` | array; at most 50,000 records |
| `links` | array; at most 100,000 records |
| `hyperedges` | array; must be empty in v1 (and therefore within the existing 10,000 hard ceiling) |
| `built_at_commit` | string; lowercase 40-hex and exactly equal to the expected source commit |

An `edges` key or a nonempty `hyperedges` array is unsupported. Hyperedge references are not guessed or accepted until separately evidenced and reviewed.

Use a JSON parser mode that reports object member pairs before map materialization (for example Python `json.loads(..., object_pairs_hook=...)`) and reject duplicate keys at every object depth. A parser that has already overwritten duplicate members is not acceptable. Parsing is for validation only: SHA-256 and storage use the untouched input bytes, with no canonicalization or reserialization.

### Node records

Every node is an object with these required string fields:

- `id`, nonempty and unique across nodes;
- `label`;
- `file_type`;
- `source_file`; and
- `source_location`.

Documented typed optional fields accepted by v1 are `_origin` string, `community` nonnegative integer, `community_name` string, `norm_label` string, `_callable` boolean, and `_callable_class` boolean. `community` must also be a JSON integer rather than a boolean. Other node fields are accepted only by the bounded unknown-scalar rule below.

### Link records

Every link is an object with required string fields `source`, `target`, `relation`, `confidence`, `source_file`, and `source_location`, plus required finite-number fields `confidence_score` and `weight`. `source`, `target`, and `relation` must be nonempty. Every endpoint must exactly reference one of the unique node IDs. Accepted `confidence` values are exactly `EXTRACTED`, `INFERRED`, and `AMBIGUOUS`.

Documented typed optional link fields accepted by v1 are `_origin` string and `context` string. Other link fields are accepted only by the bounded unknown-scalar rule below. NaN, positive/negative infinity, and non-JSON numeric extensions are rejected.

### Paths and locations

Every required node/link `source_location` is exactly `L<positive-integer>` (regex `^L[1-9][0-9]*$`) for this profile. Every `source_file` must:

- be nonempty UTF-8 and at most 1,024 bytes;
- use normalized checkout-relative POSIX separators;
- contain no NUL or backslash, have no leading slash, drive/UNC form, empty segment, `.` segment, or `..` segment, and equal its own POSIX normalization;
- remain lexically and canonically inside the checkout; and
- exactly match a path in the preflight snapshot of tracked, regular, non-symlink files.

A path that merely points at an existing file, or resolves through a symlink, is not accepted.

### Structural and scalar bounds

Limits apply while parsing, before allocation or publication where streaming/parser support permits:

| Dimension | Maximum |
| --- | ---: |
| Exact graph bytes | 8 MiB |
| JSON nesting depth | 12, counting the top-level object as depth 1 |
| Keys in any object | 64 |
| UTF-8 bytes in any object key | 64 |
| Generic string, UTF-8 bytes | 4,096 |
| `id`, `label`, `relation`, `context`, `file_type`, `_origin`, `norm_label`, `confidence`, `community_name`, each in UTF-8 bytes | 512 each |
| `source_file` path, UTF-8 bytes | 1,024 |
| `source_location`, UTF-8 bytes | 32 |
| Nodes | 50,000 |
| Links | 100,000 |
| Hyperedges | 10,000 hard ceiling; v1 accepted count is exactly 0 |
| Adapter/publication metadata envelope | 4 KiB |

Every stated bound for a string, object key, ID, label, relation, context, type (`file_type`), community name, path, or location is measured in UTF-8 bytes, never Unicode code points or UTF-16 units. Every raw number token must use the ASCII JSON number grammar, contain at most 128 characters, and convert to a finite JavaScript binary64 value. Thus overflow such as `1e999` is rejected while underflow such as `1e-999` is accepted with JavaScript-compatible conversion behavior. Fields specified as integers must additionally use JSON integer syntax and not be booleans.

Accepted node/link records therefore consist of their required typed fields, the documented typed optional fields, and unknown fields only under this bounded rule: the key is at most 64 UTF-8 bytes and the value is a bounded scalar (null, boolean, finite JSON number, or a string at most 4,096 UTF-8 bytes). `graph` may contain at most 64 keys and follows the same scalar-only value rule. Unknown top-level fields and any unknown nested field whose value is an array or object are rejected; no nested extension object or array is accepted in `graph`, a node, or a link. Exact original bytes, including accepted unknown scalar fields, are retained unchanged.

Node, link, and hyperedge counts are derived only from accepted array lengths. Declared counts, if an unreviewed output adds them, are unknown top-level fields and therefore rejected.

## Adapter output and immutable identity

On success, the future provider returns exact graph bytes; exact byte size and SHA-256; derived counts; expected/source commit; generator; and all immutable identity metadata below. The provider does not own project authority, version allocation, R2 keys, D1 records, credentials, lifecycle transitions, or superseding decisions.

Build/deduplication identity and graph metadata both include:

```text
repository_provider
provider_repository_id
repository_identity_snapshot
project_id
source_commit_sha
Graphify_version
adapter_version
profile
format_version
```

Field spelling in an implementation should follow the surrounding API/database convention; `Graphify_version` above means the versioned Graphify component and is normally serialized as `graphify_version`. `repository_identity_snapshot` is an immutable normalized snapshot containing at least provider, provider repository ID, normalized owner/name, and canonical repository URL as known at reservation time. The stable provider repository ID, not owner/name or URL alone, binds the repository. A replacement repository at the same normalized name/URL has a different provider repository ID and can never reuse the old graph, even at the same commit SHA. The project ID remains part of identity so graphs are not deduplicated across projects.

An exact unchanged identity may reuse its existing reservation/result. Any repository ID, snapshot, project, commit, Graphify version, adapter version, profile, or format-version change creates a distinct identity. `generator` identifies Graphify plus adapter/profile; `generated_by` separately identifies the scoped machine principal.

## Lifecycle, publication, and failures

A graph row and monotonic version are reserved at queue time. Output/storage/checksum/count/generated fields remain nullable until `READY`; `generated_at` means successful READY publication. The lifecycle is:

```text
QUEUED -> BUILDING -> READY -> SUPERSEDED
   ^         |
   |         v
   +------ FAILED
```

`FAILED` may retry to `QUEUED` on the same unready reservation with an incremented attempt; the logical version and human API remain unchanged. Reservation and retry atomically recheck current direct `ADMIN` membership. Under accepted ADR 0004, claim atomically creates an attempt row and a random server-generated, never-reused `publicationId` with exact key `projects/{projectId}/graphs/v/{version}/attempts/{attempt}/{publicationId}/graph.json`. Runner termination or lease expiry transitions the active attempt to `FAILED`; it is not an interactive cancel operation. Upload/finalize fences the current project/version/attempt/lease/publication/key/full build identity and exact content/checksum/`uploadId=publicationId`, so no attempt adopts another's object. `READY` is immutable forever. Finalize selects the attempt key, marks the logical version READY, then supersedes only lower READY versions. Repeated finalize is idempotent for that exact published attempt even after SUPERSEDED.

A late attempt can orphan only its own key. Cleanup targets only an exact failed/expired unpublished attempt after grace, a serialized D1 cleanup claim, fresh no-reference proof, and exact HEAD metadata checks; uncertainty retains and prefix deletion is forbidden. Existing version-only READY/SUPERSEDED objects remain immutable and queryable through a storage-layout marker without rewrite or move; existing unready rows may retry with v2 keys, while legacy orphan cleanup remains conservative and separate. These physical-key changes supersede no ADR 0003 profile, schema, build-identity, or logical-version decision.

Stable failure categories include invalid checkout/commit; dirty/untracked content; tracked symlink; unsupported submodule/LFS; tool/version mismatch; process timeout/resource/nonzero exit; missing/ambiguous external output; invalid UTF-8/JSON/schema or duplicate key; commit, endpoint, relation, confidence, location, path, or tracked-file mismatch; bounds exceeded; checksum/size mismatch; credential/scope/replay denial; immutable storage conflict; and D1 publication failure. Output is never truncated, repaired, merged, or rewritten.

Direct `ADMIN`, `EDITOR`, and `VIEWER` members can read/query bounded READY graphs through the authenticated human routes. `ADMIN` alone can reserve/retry builds, subject to the atomic current-membership recheck; Phase 10 will add CI credential management and dispatch. Interactive cancellation is deferred beyond MVP. Only the future exact project/repository/commit/operation/version/lease/attempt/publication-bound machine principal may upload/finalize through external transport; its claim response receives the publication ID and expected key, but neither is authority. Browser APIs remain unchanged, a browser session never publishes bytes, and R2 remains private.

## Reproducible fixture evidence

The original Phase 7 research example used CPython 3.11 in an isolated virtual environment with `graphifyy==0.9.58`; the researched wheel had SHA-256 `e239803288e91c723d6e30540860bd6d5a1dc3f0914b9fc1104b0233e98aaeb8`. That tiny explanatory repository committed exactly these two ordinary Python files:

```python
# helper.py
def greet(name: str) -> str:
    return f"Hello, {name}!"
```

```python
# main.py
from helper import greet


def run(name: str) -> str:
    return greet(name)
```

The retained adapter fixture is deliberately different from that two-file research example. It is a captured clean canonical-profile build from commit `9ebc249f02b2a66257816378f73683566aded0ed` (tree `1a19b33ffe05726edd03adfff4920e0cfd7ce6f0`), the clean parent of a later symlink experiment. It contains exactly three retained regular files: `main.py`, `pkg/__init__.py`, and `pkg/core.py`. A fresh `--no-local` detached clone was verified clean with no ignored/untracked files or symlinks, then Graphify 0.9.58 on CPython 3.11.15 ran the accepted two commands with one new absolute external `GRAPHIFY_OUT`. The exact retained output is 5,242 bytes with SHA-256 `25a9311a26ea28bf3d87a1cf186e4f1d10e962381bc39fdc815687dea57f085c`, 7 nodes, 10 links, and 0 hyperedges. [`graphify-0.9.58.provenance.json`](../../packages/graphify-adapter/test/fixtures/graphify-0.9.58.provenance.json) records command argv, versions, wheel hash, commit/tree identity, and per-file mode/blob/SHA-256; the three exact source files are retained beside it under `source/`. No temporary checkout or output path is provenance authority.

A reproducer should use a fresh committed checkout, record `git rev-parse HEAD`, create a new absolute output directory, set `GRAPHIFY_OUT` for both commands in the scrubbed environment, and run the exact two commands in the external-output recipe.

The 0.9.58 final `graph.json` observations included top-level `directed: false`, `multigraph: false`, object `graph`, arrays `nodes`, `links`, and empty `hyperedges`, and `built_at_commit` equal to fixture `HEAD`. Node records included values shaped like `source_file: "main.py"` and `source_location: "L1"`, plus the required node fields and observed optionals listed above. Link records included a node-ID `source`/`target`, string `relation`, `confidence: "EXTRACTED"` (with the other two accepted values observed by the contract research), finite `confidence_score` and `weight`, and file/location provenance. These examples document shape, not a promise that every fixture emits every optional field or relation.

Two fresh builds at the same checkout path produced byte-identical files and therefore the same SHA-256; the retained research notes did not record the digest value, so this document does not invent one. Reproduction should report both `sha256sum "$GRAPHIFY_OUT/graph.json"` values, exact byte size, top-level keys/values, derived array counts, and representative redacted records. Same-path equality is not evidence of cross-path, cross-platform, Python 3.12, architecture, locale, timezone, or transitive-dependency determinism.

Separate source-inclusion fixtures observed that a normal untracked file could be included, a tracked in-repository symlink was followed, and a tracked absolute file symlink to an outside target was ignored. Those observations explain the conservative preflight; all tracked symlinks, all untracked/dirty content, submodules, and LFS pointers remain rejected regardless of observed behavior.

## Evidence ledger

| Claim | Evidence | Kind | Limitation |
| --- | --- | --- | --- |
| Repository, release, source commit, license, Python requirement, wheel hash | Upstream repository/source and PyPI 0.9.58 metadata linked above | Official | Complete future dependency lock still required |
| Exact two-process external-output recipe and final fields | Isolated Python 3.11 fixture with `GRAPHIFY_OUT` shared by both commands | Empirical | Must become a fixture-locked adapter test |
| Format-v1 field/type/value rules | Parsed 0.9.58 code-only clustered fixture | Empirical Context Hub contract | Not an upstream formal schema; unobserved variants fail closed |
| Same-path exact-byte repeatability | Two fresh runs at one checkout path | Empirical | Digest not retained; no cross-environment proof |
| Untracked inclusion and differing symlink behavior | Separate temporary Git fixtures | Empirical | Behavior is not trusted; preflight rejects all such inputs |
| No embedded tool/schema/checksum metadata | Pinned source inspection and output | Source + empirical | External immutable metadata is mandatory |
| Watch/update manifests and query/MCP surface | Pinned source/docs inspection | Source + documentation | Rejected for authoritative publication |

## Unknowns and future verification

- Benchmark CPU, memory, duration, disk, and Actions minutes below and near every accepted bound.
- Compare fixtures across checkout paths, Python 3.11/3.12, operating systems, architectures, locale/timezone, and fully locked dependency resolutions. Checksum differences remain distinct outputs; never normalize silently.
- Re-run the complete schema fixture suite and update ADR/profile/format decisions for every Graphify upgrade. No upstream formal compatibility is assumed.
- Submodules, LFS, and all tracked symlinks remain unsupported in v1; future support requires dedicated provenance, path, credential, and output evidence, not relaxation in the adapter.
- Before Phase 10, the accepted ADR 0004 attempt-scoped metadata/publication implementation must pass independent Phase 9 review; migration and race/cleanup/legacy tests are local evidence. Live Actions, machine-principal publication transport, remote D1/R2 partial-failure behavior, and production redaction remain future Phase 10 verification.

## Explicitly rejected scope

This decision rejects embedding Graphify as an application library, Worker/webhook execution, a hosted Graphify service, upstream MCP/HTTP production transport, direct R2 publication, local authoritative generation, watch/update/incremental publication, semantic docs/media extraction, graph merge/global/PR output, graph JSON editing/normalization, and reimplementation of Graphify traversal/query internals. Versioned Context Hub artifacts remain the MVP documentation source.
