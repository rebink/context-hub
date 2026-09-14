# Phase 24 local end-to-end report

Last updated: 2026-09-15

Status: **COMPLETE LOCALLY AFTER ONE REVIEW, ONE CONSOLIDATED SIX-P1 CORRECTION, REPEATED LOCAL E2E, AND THE 342-TEST ROOT PHASE GATE. EXTERNAL/LIVE CHECKS REMAIN BLOCKED.**

## Reproduce

```sh
npm run test:e2e:local
```

The command creates isolated HOME/TMP/Git configuration and a temporary SHA-1 repository with asserted commits A and B, applies migrations 0001-0020 to a fresh Wrangler-local D1, starts the production `createApp` router under Wrangler on a reserved dynamic loopback port, executes production HTTP routes with bounded requests, drives the actual `context-cli` client/cache and native `context-pi` command, then terminates the Wrangler process group and destroys temporary state. Child environments are allowlisted, command/output/startup/teardown bounds fail closed, Python must resolve canonically to 3.11 or 3.12, and harness regressions cover failed migration, occupied-port startup, and forced subtree cleanup. Any locally required assertion fails the command; there are no local skips.

The latest post-review local run passed on 2026-09-15 with deterministic commit A `14e53285c954867aa267ba4127d59675418171de` and commit B `93129d1e48dd4df5cbca458b2d205711e83e2698`. Dynamic project, snapshot, publication, and checksum identifiers were printed by each command and are intentionally not checked in as fabricated production identifiers. The MCP six-tool schema digest was `3cd33a36192e35bdd8b6c195b27a5a2720db3cc992faa7b0c0699465e2044599`.

## Local boundaries

- **Real local seams:** production `createApp` routing and security boundary; fresh migrated D1 through 0020; local R2 private object binding; immutable artifact, graph, sync, snapshot, activity, team, Context Engine, MCP transport/domain formats; real Git commits/remotes; actual `context-cli` discovery/client/cache/atomic replacement; actual `context-pi` extension registration and command dispatch.
- **Injected provider seam:** the E2E-only Worker supplies deterministic GitHub OAuth/identity responses and a narrow `GitProvider` implementation. Production still defaults to `GithubGitProvider`; `createApp` accepts only an explicit test factory override. The scenario proves application flow and provider contracts, not GitHub behavior.
- **Injected graph runtime seam:** the actual `GraphifyAdapter`, real detached Git checkout/preflight/postflight, real process boundary, and real dependency-free Python validator run for commits A/B. A deterministic executable stands in only for the unavailable pinned Graphify binary and writes format-v1 bytes; those exact adapter bytes then pass the production Worker validator at machine publication, replay, explorer, Context Engine, snapshot, and CLI boundaries. The protected Actions job, real Graphify binary, and hosted/self-hosted runner are not run and remain BLOCKED.
- **Local platform boundary:** Wrangler-local D1/R2 semantics are exercised. They are not remote Cloudflare D1/R2, edge isolation, billing, contention, or private-bucket policy evidence.
- **Pi/MCP boundary:** production package code and HTTP protocol paths run, but no live Pi host/TUI/model, external MCP client, or telemetry is present. The extension proves one native command and no model/prompt/tool mutation locally only.

## Single-project sequence

| Step | Result | Executable evidence |
| --- | --- | --- |
| 1. Admin signs in | PASS | `PASS 1`: HTTP `/auth/github` plus callback, state cookie, injected OAuth response, hashed session. |
| 2. Create Payments Platform | PASS | `PASS 2`: production workspace/project routes create Acme and Payments; Identity/Mobile peers support the later scenario. |
| 3. Connect GitHub | PASS | `PASS 3`: production Git App setup/callback state machine uses the injected `GitProvider`; normalized repository is `github.com/acme/payments-platform`. |
| 4. Upload architecture | PASS | `PASS 4`: artifact route publishes private immutable architecture v1 with commit-A provenance. |
| 5. Upload refund ADR | PASS | `PASS 5`: artifact route publishes targeted refund ADR v1 with commit-A provenance. |
| 6. Graph v1 from commit A | PASS | `PASS 6`: ADMIN reservation, scoped machine credential/nonce/claim, actual `GraphifyAdapter` detached-checkout execution with an injected deterministic Graphify executable, exact format/provenance/checksum validation, create-only R2 publication, READY transition. Protected Actions and the real Graphify binary are BLOCKED. |
| 7. Invite developer | PASS | `PASS 7`: current provider login resolves to stable Alice identity and creates exact EDITOR invitation. |
| 8. Developer accepts | PASS | `PASS 8`: Alice's separate OAuth session accepts once and receives EDITOR. |
| 9. Sync local context | PASS | `PASS 9`: actual `runCli(["sync"])` remote resolution, metadata/download clients, format validation, manifest-last atomic cache sync, and repository-bound sync-state reporting return exact `reporting: REPORTED`. Credential is exact repository-bound and tool-scoped. |
| 10. Connect Pi | PASS | `PASS 10`: actual extension registers `/context`, dispatches connect, and exposes no model/prompt/LLM tool hook. Live Pi host is BLOCKED. |
| 11. Ask refund retry | PASS | `PASS 11`: native Pi `search` command executes. |
| 12. Targeted retrieval | PASS | `PASS 12`: Pi initializes MCP and invokes actual `search_context`; output is bounded, source-backed, Payments-only, and contains no Identity/Mobile source. |
| 13. Implement feature | PASS | `PASS 13`: source is changed in the temporary real repository. |
| 14. Create commit B | PASS | `PASS 14`: real Git commit B differs from A. |
| 15. Build graph v2 | PASS | `PASS 15`: Git provider truth advances to B; v2 is reserved and the actual adapter/preflight/validator produces exact bytes against detached commit B through the declared executable seam. |
| 16. Publish graph v2 | PASS | `PASS 16`: CI machine principal publishes v2 and supersedes v1 transactionally. |
| 17. Detect stale v1 | PASS | `PASS 17`: actual CLI reports `REMOTE_GRAPH_AHEAD` from verified server metadata. |
| 18. Sync v2 safely | PASS | `PASS 18`: actual CLI verifies and atomically replaces cache; v2 metadata/checksum are selected. Failed-update preservation remains covered by CLI regression tests. |
| 19. Graph v1 remains intact | PASS | `PASS 19`: exact same-attempt publication replay revalidates original v1 bytes/checksum after supersession; authorized explorer loading revalidates and queries that immutable object. Raw graph bytes intentionally remain private and are not exposed by a human download route. |
| 20. Snapshot exact state | PASS | `PASS 20`: raw retrieved manifest bytes match response and create-response checksum/size evidence; exact snapshot/Git/repository/graph generator/publication fields and the complete two-artifact version/checksum/content/provenance set are asserted. |
| Audit/freshness/team | PASS | Named assertion verifies Git/graph/snapshot generalized audits, Alice EDITOR membership, CLI `CURRENT` plus `reporting: REPORTED`, current persisted sync state, and coupled `sync_state:sync:` source/generalized audit identifiers. |
| Authorization/revocation | PASS | Named assertion revokes without replacement, verifies repeated revoke fails closed, checks the exact `MCP_CREDENTIAL_REVOKED` human audit target/outcome, and verifies the same token's immediate next MCP request returns exact `401 INVALID_CREDENTIAL`. |
| Rollback/cache safety | PASS | After the required v2 snapshot/current assertions, a local v3 safety probe injects a corrupt download at the CLI transport seam; actual CLI validation rejects it and exact cached v2 bytes/metadata remain selected. Filesystem interruption recovery additionally remains covered by `packages/context-cli/test/sync.test.ts`. |
| Secret leakage | PASS | Named assertion scans retained scenario output/notifications/results for both issued tokens and credential patterns; denials remain generic. No token enters Git or `.ai-context`. |

## Multi-project sequence

| Requirement | Result | Executable evidence |
| --- | --- | --- |
| Acme has Payments, Identity, Mobile | PASS | Created through production project route in `PASS 2`; all three connect through the Git route/provider seam. |
| Alice directly accesses only Payments + Identity | PASS | `multi-membership` compares production `/projects` result to the exact two IDs despite workspace membership; Mobile is absent. |
| Remotes auto-resolve Payments then Identity | PASS | Initial CLI connect auto-resolves Payments; `multi-resolution` changes the real Git remote and invokes CLI connect without `projectId` to auto-resolve Identity. Production resolve routes additionally validate HTTPS/SCP normalization. |
| Explicit switch works | PASS | `multi-resolution` switches back to Payments with an explicit project ID and verifies persisted selection. |
| Single-project searches isolate | PASS | `multi-isolation` invokes both production Context Engine routes and asserts opposing artifact/project provenance is absent. |
| Combined Payments + Identity is globally bounded | PASS | `multi-combined` invokes one cross-project Context Engine call, checks both project provenances, one 1,800-token/18,000-byte/8-source budget, and final byte bound. |
| Payments + Mobile fails all-or-nothing | PASS | `multi-denial` receives generic `404`; response contains no Mobile ID, name, repository, or source. Retrieval begins only after complete-set authorization in production code. |
| Six tools/schema unchanged | PASS | `six-tool-invariant` calls actual MCP `tools/list` twice, compares exact exported schemas, count 6, and stable digest. |

## External/live matrix

| Check | Result | Exact prerequisite and unblock procedure |
| --- | --- | --- |
| Browser UI/accessibility | BLOCKED | Current MCP has 0 browser servers/tools and no browser runtime. Install an approved browser harness, run deployed/local UI flows for navigation, keyboard, focus, labels, responsive/mobile, dark/reduced-motion, and automated/manual accessibility; attach artifacts without changing this local result. |
| Live GitHub OAuth/identity/App | BLOCKED | Provision canary OAuth/App credentials and exact callbacks in an isolated private-data-safe environment; run login, cookies, installation, suspension/revocation, rate/error, and credential-rotation checks, inspect redacted logs, then rotate canary secrets. |
| Remote D1/R2/private bucket | BLOCKED | Provision isolated Cloudflare D1 and private R2, apply 0001-0020, run this scenario against deployed bindings, test contention/object privacy/checksum failure and backup/restore in separate resources, then destroy/rotate test resources. |
| Protected Actions Graphify | BLOCKED | Configure protected environment secrets, exact repository/machine binding, pinned Graphify/tooling checkout and bounded runner; publish A/B through `.github/workflows/graphify.yml`, capture run/provenance/resource evidence, then revoke credentials. |
| Live MCP client | BLOCKED | Supply deployed origin and repository-bound credential to an approved external MCP client; verify initialization, six schemas, queries, revocation, output/log redaction, and response ceilings. |
| Live Pi host/TUI/model | BLOCKED | Install the pinned Pi 0.85.1-compatible host, provide environment/secret-helper credentials, run native command/TUI lifecycle and telemetry inspection, and confirm zero prompt/model/tool mutation. No model call is needed for the local package assertion. |
| OS secret store | BLOCKED | Configure an approved OS helper that injects the human session/MCP token without arguments/files; verify process/log/cache redaction and rotation on supported target operating systems. |
| Deployment/edge/observability | BLOCKED | Complete Phase 26 resource/origin/secret/rate-limit/log/alert configuration and deploy a candidate before edge headers, origin behavior, privacy, rate tuning, and operational recovery can be verified. |
| Product metrics/final QA | BLOCKED | Explicitly belongs to Phases 25/27 and is not implemented or claimed by Phase 24. |

## Findings surfaced

The first real migrated-D1 run exposed false stale/not-found responses because D1 `meta.changes` includes migration-0020 trigger work. The consolidated review correction replaces trigger-sensitive success accounting for authoritative Git connect/sync/disconnect, MCP revoke, and sync-state reporting with `RETURNING` rows and exact expected base-row identity/cardinality checks while preserving guarded predicates and response mappings. Focused fakes cover zero/one/multiple returned rows; Wrangler-local E2E proves successful base mutation, trigger-coupled generalized audit insertion, zero-row repeated revoke, and immediate credential invalidation. The same correction hardens deterministic/offline harness lifecycle, actual CLI auto-resolution/reporting, structural isolation assertions, and byte-exact snapshot evidence. The required single review, consolidated correction, and parent-owned root gate are complete; no second review was performed.
