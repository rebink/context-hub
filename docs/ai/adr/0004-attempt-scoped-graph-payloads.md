# ADR 0004: Attempt-scoped graph payloads

- Status: Accepted
- Date: 2026-09-12
- Independent review: Accepted on 2026-09-12; review found no blocking issue in the attempt-scoped correction
- Scope: Narrow Phase 9 correction to graph payload addressing, attempt metadata, publication fencing, and cleanup
- Supersedes: Only ADR 0003's version-only physical R2 key assumption
- Preserves: ADR 0003's canonical profile, format-v1 schema, logical graph version, build identity, lifecycle, provenance, authorization, and immutable-publication decisions

## Context

ADR 0003 correctly reserves one logical graph version for a complete build identity and permits `FAILED -> QUEUED` retry on that same version with an incremented attempt. The current Phase 9 implementation, however, maps every attempt for a logical version to one physical key:

```text
projects/{projectId}/graphs/v/{version}/graph.json
```

A shared physical key cannot safely represent independent retry attempts. A failed or late attempt can collide with bytes written by another attempt; recovery then needs adoption or deletion reasoning across attempts. Lease fencing in D1 prevents an old runner from finalizing, but it cannot make two independently produced R2 objects at the same key distinguishable. Create-only storage makes that ambiguity persistent rather than eliminating it.

This ADR corrects only that physical-storage and attempt-ownership mismatch. The browser-facing logical graph version and API remain unchanged. ADR 0003 remains authoritative for the canonical Graphify profile, exact-byte format-v1 validation, complete build identity, same-version retry semantics, status model, provenance, roles, and private storage.

## Decision

### Physical key and publication identity

Each claimed build attempt receives a random, server-generated `publicationId`. It is distinct from the lease token, is never accepted from a client, and is never reused, including after failure, expiry, cleanup, or rollback. The v2 physical key is derived by the server exactly as:

```text
projects/{projectId}/graphs/v/{version}/attempts/{attempt}/{publicationId}/graph.json
```

The logical version exposed by the human API does not change. A retry after `FAILED` remains the same logical version with an incremented attempt. Storage keys remain private implementation details and are never returned to the browser. The later Phase 10 machine claim response will receive the `publicationId` and exact expected key needed for upload; possession of either is not authorization.

### Additive D1 attempt metadata

Add `graph_build_attempts` metadata keyed by `(project_id, graph_version, attempt)`. Each row has a globally unique `publication_id` and a unique exact `storage_key`, both generated on the server. It records the immutable project/version/attempt/build identity, publication identity and key, claim/principal/time evidence, expected object metadata, terminal outcome, and bounded audit evidence. Guarded lifecycle fields may advance, but attempt identity and historical outcome are never reassigned, deleted to enable reuse, or rewritten as another attempt.

The attempt row owns its lease fencing and any orphan observation, grace deadline, and cleanup-claim owner/expiry. `graph_versions` remains the logical version and selected-publication truth; `graph_events` remains immutable transition evidence. The migration is additive: do not rewrite an applied migration or overload a logical version row so it loses attempt history.

### Reservation, retry, and claim

Every project-scoped request continues to authenticate, resolve the project, verify direct membership, and check role before access. Reservation and retry mutations must also atomically recheck that the initiating human still has direct `ADMIN` membership in the same D1 mutation that reserves or retries; a stale preflight role check is insufficient. Dedupe/conflict reads that can contribute graph metadata to the mutation response carry the same current-ADMIN predicate. If the predicate loses a removal or demotion race, a fresh direct-membership check returns nonleaking `404`, current non-admin `403`, or metadata-free `409` conflict.

Claiming queued work atomically verifies the current project, logical version, attempt, status, principal scope, and absence of an existing claim for that attempt; creates the attempt row; generates its never-reused `publicationId` and expected key; and installs the lease. A claim cannot adopt an object or attempt row created by any earlier or later attempt.

### Upload and finalize

Publication remains exact-byte, create-only R2 upload followed by D1 finalization. Upload is authorized only for the exact claimed project/version/attempt/lease/publication identity and exact expected key. R2 metadata must identify `uploadId=publicationId` and the exact content type, byte size, and SHA-256 checksum. Recovery accepts only that same attempt's exact key, content, checksum, and metadata. No cross-attempt object adoption is allowed, even when bytes and checksum happen to match.

Finalize fences all of the current project, logical version, attempt, lease, `publicationId`, exact storage key, complete build identity, checksum, size, counts, content type, and upload metadata. The terminal D1 guard requires lease expiry to be later than both the publication timestamp and D1's current UTC time, so a caller cannot revive an expired lease by backdating publication. In one guarded D1 transaction it selects that physical key as the logical version's payload, marks the version `READY`, and then supersedes only lower `READY` logical versions. A higher existing `READY` version still blocks stale promotion. The selected payload and immutable logical version metadata can never be replaced.

A replay of the same successfully published attempt is idempotent only when every fenced D1 field and exact R2 HEAD field matches. This exact replay remains valid after the logical version is `SUPERSEDED`. A late, expired, or losing attempt cannot alter the logical row, adopt another attempt's bytes, or affect another key; at most it can orphan its own unique key.

### Cleanup

Cleanup may target only the exact key owned by a failed or expired, unpublished attempt and only after its grace period. It first acquires a serialized cleanup claim in D1 for that attempt. Immediately before deletion it must freshly prove:

- the attempt is still failed or expired and unpublished;
- no logical graph version or other attempt references the exact key or `publicationId`;
- the cleanup claim still belongs to this worker; and
- exact R2 HEAD metadata matches the attempt's key, `uploadId=publicationId`, content type, byte size, and checksum.

Any missing, conflicting, stale, unavailable, or uncertain evidence retains the object for later reconciliation and releases the cleanup claim through its exact ownership fence when D1 is available. Retry does not wait for an old attempt's cleanup claim: the incremented attempt receives a distinct physical key while exact prior-attempt `FAILED` evidence remains mandatory. Cleanup never deletes by prefix, never deletes a legacy version-only object through the v2 path, and never deletes a selected `READY` or `SUPERSEDED` payload. After an exact delete, D1 records the terminal cleanup result without making the publication identity reusable.

### Legacy coexistence

Existing version-only `READY` and `SUPERSEDED` payloads remain immutable and queryable at their existing keys. An additive storage-layout marker distinguishes legacy version-only publications from attempt-scoped v2 publications so reads and explorer queries resolve the selected key through D1. There is no rewrite, copy, move, rename, or backfill of legacy published bytes.

Existing unready logical graph rows may retry under the v2 layout: the retry increments the attempt and its claim creates a new attempt-scoped key. Legacy orphan cleanup is conservative and separate because legacy objects lack a unique publication identity; this ADR does not authorize treating them as v2 attempts or deleting them with v2 cleanup logic.

## Alternatives rejected

- **Keep a shared version key and delete on failure:** lease checks cannot prove which attempt produced shared bytes, so cleanup can delete a winner or a later retry.
- **Keep a shared version key and adopt matching bytes:** checksum equality does not establish attempt ownership and weakens lease, principal, audit, and replay boundaries.
- **Overwrite the version key:** violates immutable payload storage and can silently change a published logical version.
- **Allocate a new logical version for every retry:** avoids collision but changes the accepted API/lifecycle semantics, creates user-visible versions for transient execution failures, and discards ADR 0003's same-version retry decision.
- **Upload to staging and copy into a version key:** copy introduces another partial-failure and identity boundary, still converges on a shared destination, increases R2 operations, and provides no benefit over selecting an immutable attempt key in D1.

## Migration and compatibility

1. Add `graph_build_attempts`, uniqueness constraints, project-first lookup/cleanup indexes, and the storage-layout/selected-publication metadata needed to distinguish legacy and v2 rows.
2. Classify existing published version-key rows as legacy without changing their object key or immutable payload metadata. Validate that every selected legacy key remains readable under its marker.
3. Leave existing unready rows unselected. Their next authorized retry/claim creates the incremented attempt under v2.
4. Change internal claim, publication, finalize, replay, read, and cleanup paths together. Do not enable Phase 10 machine publication against the version-only implementation.
5. Keep the browser API and logical graph version responses stable; future machine claim transport adds `publicationId` and expected key only to its private machine contract.

No migration scans or moves R2. D1 remains metadata truth for which immutable physical object a logical version selects.

## Rollback and forward recovery

Before any v2 publication, rollback may disable v2 claims and revert the additive application path while retaining unused additive tables/columns. After any v2 object or selected publication exists, rollback must not run version-only writers against that logical row. Disable new claims/finalization, preserve all selected legacy and v2 objects, keep reads layout-aware, and retain attempt/audit rows and uncertain orphans.

Forward recovery fixes code under this ADR, reconciles exact attempt identities, and resumes v2 claims. Never convert v2 payloads back to the shared version key, reuse a `publicationId`, or delete uncertain objects to force rollback.

## Security consequences

Attempt-scoped keys reduce cross-attempt confused-deputy and deletion races but are not secrets or capabilities. Authorization still derives from current D1 membership or a separately authenticated scoped machine principal. Finalize and cleanup require full identity fencing, parameterized project predicates, exact object metadata, bounded inputs, private R2, and redacted logs. `publicationId`, keys, leases, credentials, checksums, and graph content must not appear in browser responses, audit metadata beyond operational need, or uncontrolled logs.

Current direct `ADMIN` membership must be rechecked atomically for every reservation/retry mutation. Phase 10 credentials must bind the machine principal to the exact project, repository, commit, operation, version, attempt, lease, and publication identity; a `publicationId` or expected key alone grants nothing.

## Operational consequences

Attempt-scoped storage may retain more failed-attempt objects, intentionally preferring bounded storage leakage over deletion of referenced data. Monitor attempts per version, claim/finalize conflicts, orphan count/age/bytes, cleanup claim contention, HEAD uncertainty, metadata mismatch, and selected-key integrity. Apply quotas and alerts before external publication opens. Operators need layout-aware diagnostics that identify logical version and attempt without exposing full private keys or payloads.

Legacy objects require a separate conservative reconciliation runbook. Prefix deletion, bucket lifecycle rules covering selected graph prefixes, and manual key reuse are prohibited.

## Test consequences

Phase 9 cannot complete until tests demonstrate:

- additive fresh and upgrade migration integrity, unique publication IDs/keys, immutable attempt identity, and legacy marker compatibility;
- atomic direct-`ADMIN` rechecks for reservation and retry, including demotion/removal races;
- atomic claim creation and concurrent-claim exclusion with a new publication identity per attempt;
- same-version retry to a distinct attempt key, create-only upload metadata, and rejection of cross-attempt adoption;
- finalize fencing across project/version/attempt/lease/publication/key/full build identity and superseding only lower `READY` versions;
- exact replay of the selected attempt in both `READY` and `SUPERSEDED` states;
- late/expired attempt isolation so it can orphan only its own key;
- serialized grace-period cleanup with fresh no-reference and exact HEAD checks, uncertainty retention, and no prefix delete;
- immutable, queryable legacy `READY`/`SUPERSEDED` reads plus v2 retry for existing unready rows; and
- unchanged browser contracts, bounded explorer behavior, private-key non-disclosure, and future machine-claim contract expectations.

The additive migration, implementation, and local quality gates provide the implementation evidence for this accepted decision. Independent Phase 9 acceptance and live browser/remote Cloudflare evidence remain separate gates.

## Status consequence

ADR 0004 is accepted and the attempt-scoped Phase 9 implementation is locally complete through migration 0013 with final bounded review ACCEPT. Phase 10 machine publication remains out of scope until its own prerequisites are satisfied.
