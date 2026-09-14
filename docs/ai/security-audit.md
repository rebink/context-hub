# Phase 22 Security Audit

Date: 2026-09-15
Baseline: clean management checkpoint `aebb49a75a29f6d164a1318e48539f0c57c25686`
State: complete locally after one independent review, one consolidated two-item P1 correction, and the root phase gate

## Scope and method

This audit reviewed the checked-in application and operational definitions, not a deployed environment. The review followed request and data flows from the browser, CLI, Pi, CI, and MCP boundaries through Worker authentication/authorization, D1 metadata, private immutable R2 objects, and fixed GitHub endpoints. It covered all accepted ADRs 0001-0008, migrations 0001-0020 and their integrity script, Cloudflare and GitHub configuration, both workflows, Graphify CI, rendering seams, and bounded transport/provider code.

Reproduce the local evidence without printing secret values:

```sh
git diff --check
npm audit --omit=dev --json > /tmp/context-hub-npm-audit.json
node -e 'const a=require("/tmp/context-hub-npm-audit.json"); console.log(a.metadata.vulnerabilities)'
rg -n --hidden -g '!node_modules' -g '!dist' -g '!package-lock.json' \
  '(BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._~-]{20,})' .
rg -n 'request\.json\(\)|request\.text\(\)|request\.arrayBuffer\(\)|response\.json\(\)' apps/api/src --glob '*.ts'
rg -n 'innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function' apps/web/src --glob '*.ts'
rg -n 'uses:' .github/workflows
npm test -w @context-hub/api
npm test -w @context-hub/web
npm run test:migrations -w @context-hub/api
npm run typecheck -w @context-hub/api
npm run typecheck -w @context-hub/web
./node_modules/.bin/biome check .github/workflows/ci.yml apps/api/src/bounded-json.ts apps/api/src/github-auth-provider.ts apps/api/src/index.ts apps/api/test/index.test.ts apps/api/test/providers.test.ts apps/web/src/api-origin.ts apps/web/src/api.ts apps/web/scripts/generate-security-headers.ts apps/web/test/security-headers.test.ts
npm run build -w @context-hub/api
VITE_API_URL=https://api.context-hub.example CONTEXT_HUB_PAGES_BUILD=1 npm run build -w @context-hub/web
rg -n 'connect-src' apps/web/dist/_headers
```

The targeted secret-pattern search matched only PEM marker handling and generated test keys, not a checked-in credential. The production dependency audit reported zero known vulnerabilities. The root gate passes 336 tests: 201 API, 42 web, 26 CLI, 26 Pi, and 41 adapter. The production dependency audit reports zero known vulnerabilities across 229 dependencies.

## Severity rubric

| Severity | Meaning |
| --- | --- |
| Critical | Direct unauthenticated compromise of production secrets, arbitrary code execution, or complete cross-tenant private-data access with practical exploitation. |
| High | Practical credential disclosure, authorization/isolation bypass, durable integrity loss, or remotely triggerable material availability failure at a public boundary. |
| Medium | Defense-in-depth or abuse weakness requiring additional conditions, limited disclosure, or material operational risk without a direct local bypass. |
| Low | Hardening, maintainability, or evidence gap with low direct security impact. |
| Informational | Verified control, intentional absence, or external evidence requirement. |

`Fixed` means code/config and regression evidence are present locally. `Open` means a confirmed control gap remains. `Accepted` means an accepted ADR explicitly owns the residual tradeoff. `Deferred` means it belongs to a later approved phase and is not represented as implemented. `N/A` means the attack surface does not exist.

## Findings

| ID | Severity | Status | Finding and disposition | Exact evidence |
| --- | --- | --- | --- | --- |
| SA-01 | High | Fixed | Worker responses had no consistent browser hardening policy. A single outer response boundary now applies CSP, frame denial, nosniff, no-referrer, restrictive permissions, and production-only HSTS to JSON, redirects, downloads, preflights, MCP, and errors. | `apps/api/src/index.ts` (`applySecurityHeaders`, `createApp`); `apps/api/test/index.test.ts` (security-header/HSTS acceptance). |
| SA-02 | High | Fixed | Pages had no safe exact-origin header generation. The web build now parses `VITE_API_URL` through the same normalization used by browser requests, generates only `dist/_headers`, and fails before Vite in Pages mode when the origin is absent, placeholder, malformed, credential-bearing, non-origin, or non-HTTPS. The CSP permits only self plus that exact normalized API origin. | `apps/web/src/api-origin.ts`; `apps/web/src/api.ts`; `apps/web/scripts/generate-security-headers.ts`; `apps/web/test/security-headers.test.ts`; guarded Pages build evidence. |
| SA-03 | High | Fixed | Identity OAuth provider responses used automatic redirects and unbounded `response.json()`, allowing provider/gateway behavior to forward sensitive requests or consume unbounded memory. Both fixed GitHub calls now reject redirects, time out, require JSON, stream to 64 KiB, validate UTF-8/object shape, and map every fetch/read/cancel/release/decode/JSON failure to the existing redacted provider error. Rejected/unread bodies are canceled and readers are released. | `apps/api/src/github-auth-provider.ts`; token/identity stream-error and cancellation tests in `apps/api/test/providers.test.ts`; callback `AUTH_FAILED` regression in `apps/api/test/index.test.ts`. |
| SA-04 | High | Fixed | Workspace/project creation were the remaining unbounded request JSON buffers. They now reuse the streaming two-KiB object reader while preserving the existing optional-content-type behavior for these legacy endpoints. | `apps/api/src/index.ts`; `apps/api/src/bounded-json.ts`; `apps/api/test/index.test.ts`. Static search now finds no direct Worker request buffering APIs. |
| SA-05 | High | Fixed | The general CI workflow used floating major action tags and implicit token permissions. It now pins both actions to full commits and declares read-only repository contents. | `.github/workflows/ci.yml`; `.github/workflows/graphify.yml` already pins checkout and declares `contents: read`. |
| SA-06 | High | Open / BLOCKED | No safe local backup/restore procedure exists for production D1/R2, and no deployed resources are configured. A restore exercise could falsely claim platform guarantees or damage data, so it was not run. | `apps/api/wrangler.toml` contains production placeholders; EG-04. Must be completed in the production deployment phase with isolated resources and checksum/provenance comparison. |
| SA-07 | Medium | Deferred | Application rate controls exist for MCP credentials/nonces and bounded OAuth-state capacity, but edge/per-principal limits are not configured for login, human search, uploads, snapshot/build triggers, or general API traffic. This is an approved production control gap, not a local authorization bypass. | `apps/api/src/mcp.ts`, `apps/api/src/machine-graphs.ts`, `apps/api/src/index.ts`; `docs/ai/security.md`; production configuration absent. |
| SA-08 | Medium | Deferred | Retention/privacy policy and operational log inspection/redaction cannot be verified locally. General audit events intentionally retain indefinitely up to the guarded per-project cap. | migration `apps/api/migrations/0020_generalized_project_audit.sql`; `docs/ai/security.md`; no production logging sink or retention configuration. |
| SA-09 | Medium | Accepted | D1 and R2 cannot share a transaction. Artifact, graph, and snapshot flows publish object-first and use ownership/fresh-reference compensation; uncertainty intentionally retains an orphan rather than risking referenced data loss. | `apps/api/src/artifacts.ts`, `apps/api/src/graphs.ts`, `apps/api/src/snapshots.ts`; ADR 0004; corruption/compensation tests in corresponding test files. |
| SA-10 | Medium | Open | There is no account-deletion API or policy. Project membership removal and role revocation are immediate and tested, but complete identity/session/privacy removal needs an approved lifecycle and retention decision. | `apps/api/src/team.ts`, `apps/api/src/security.ts`, migrations 0001/0018/0020; no account deletion route. |
| SA-11 | Low | Open | The legacy workspace/project bounded parser returns generic `400 INVALID_INPUT` for oversized or wrong-media requests rather than distinct `413`/`415`. The memory safety boundary is fixed; status precision is not security-critical. | `apps/api/src/index.ts`; `apps/api/src/bounded-json.ts`; regression test expects bounded generic denial. |
| SA-12 | Informational | N/A | No webhook endpoint exists, so signature and delivery replay testing is not applicable. Enabling webhooks requires raw-body signature verification, delivery-ID deduplication, exact repository binding, and bounded event/action allowlists before routing. | No webhook route/migration/config under `apps/api`; `docs/ai/security.md` webhook section. |
| SA-13 | Informational | Verified locally | D1 calls are parameterized and project-child reads use project predicates; migrations add foreign keys, checks, immutable triggers, race predicates, unique constraints, indexes, audit anti-forgery guards, and the 100,000-event capacity guard. No caller SQL enters Context Engine fences. | `apps/api/src/**/*.ts`, `apps/api/migrations/*.sql`, `apps/api/test/migration-integrity.sh`, `apps/api/src/context-authorization.ts`. Remote D1 semantics remain external. |
| SA-14 | Informational | Verified locally | R2 keys are derived from server/D1 identity, writes are create-only, private reads use HEAD plus exact metadata/bytes/checksum/UTF-8 or graph schema validation, and compensation is ownership/reference fenced. No direct object URL or key is returned. | `apps/api/src/r2-object-storage.ts`, `apps/api/src/artifacts.ts`, `apps/api/src/graphs.ts`, `apps/api/src/snapshots.ts`, `apps/api/src/sync.ts`, `apps/api/src/context-engine.ts`, tests for each domain. |
| SA-15 | Informational | Verified locally | GitHub App traffic uses fixed HTTPS hosts, rejects redirects, bounds time/content type/bytes, validates provider shape, creates in-memory short-lived JWT/tokens, and binds repository/installation/session state. Repository normalization rejects protocols, credentials, ports, queries, fragments, and unsupported hosts. | `apps/api/src/github-git-provider.ts`, `apps/api/src/repository-identity.ts`, `apps/api/test/providers.test.ts`, `apps/api/test/index.test.ts`. Live revocation/provider behavior is EG-02. |
| SA-16 | Informational | Verified locally | MCP and machine credentials are independent hash-only, expiring, revocable scoped principals with nonce replay control and rate caps. Human cookies are rejected; every selected project is completely authorized before reads and rechecked at storage seams. | migrations 0014/0015; `apps/api/src/mcp.ts`, `apps/api/src/machine-graphs.ts`, `apps/api/src/context-authorization.ts`; credential/replay/race tests. |
| SA-17 | Informational | Verified locally | Local sync/Pi use fixed contained cache paths, no-follow/exclusive writes, symlink and retained inode/device checks, rollback and mutation locks, exact origin matching, redirect rejection, bounded responses, and environment-only credential inputs. Successful Pi output is token-redacted and bounded. | ADR 0006; `packages/context-cli/src`, `packages/context-pi/src`; CLI/Pi tests and `docs/ai/pi-token-budget.md`. Live OS helper/TUI evidence is EG-03. |
| SA-18 | Informational | Verified locally | Text uploads are byte/media/UTF-8 bounded and rendered as inert DOM text. No archive/binary/decompression surface exists. Static `innerHTML` templates contain fixed markup; untrusted values are assigned by `textContent`, attributes, or DOM construction. | `apps/api/src/artifacts.ts`, `apps/web/src/artifacts.ts`, `apps/web/src/main.ts`, web/API validation tests. CSP adds a second execution boundary. |
| SA-19 | Informational | Verified locally | Lists/cursors/tool selectors, MCP requests/responses, context tokens/bytes/sources, graph traversals, sync downloads, snapshots, provider responses, and audit windows/pages are bounded. Cross-project retrieval authorizes the complete set before reads and returns a generic whole-request denial with zero R2 access on races. | route modules and Task D tests in `apps/api/test/context-route.test.ts`, `apps/api/test/context-engine-scenarios.test.ts`, `apps/api/test/mcp.test.ts`. |
| SA-20 | Informational | Verified locally | Session/OAuth state tokens are random and hash-only in D1, expiry is checked, state is session-cookie bound and atomically consumed, logout deletes the exact hash, cookies are HttpOnly with explicit path/SameSite/max-age and production Secure. Mutation Origin and credentialed CORS compare the exact configured origin. | `apps/api/src/security.ts`, `apps/api/src/index.ts`, `apps/api/src/cors.ts`, OAuth/session/CORS tests. Live cookie behavior is EG-02. |

No confirmed Critical finding remains. All confirmed High local-code findings found in this pass are fixed; SA-06 is an external operational High blocker and is not misclassified as fixed.

## Required safe scenarios

| Scenario | Result | Reproducible evidence |
| --- | --- | --- |
| Human role revocation/removal | PASS locally | Team role/removal tests plus graph reservation demotion/removal races and fresh web authorization tests prove next-request authority loss and affected sync-row deletion. |
| MCP role/membership revocation | PASS locally | `apps/api/test/mcp.test.ts` credential/membership/race cases prove generic denial before source/R2 reads while unrelated scopes remain independent. |
| Sync role/membership revocation | PASS locally | `apps/api/test/sync-states.test.ts` rechecks active credential, workspace/direct membership, operation, repository binding, and exact current repository in the conditioned write. |
| Compromised/revoked/expired credential | PASS locally | Machine and MCP lifecycle tests cover wrong bearer, rotation, revoke, expiry, wrong binding, and human-cookie rejection without secret/hash return. |
| Replay | PASS locally | OAuth state callback, Git App state, machine/MCP nonce, artifact expected-version, settings/lifecycle revisions, and graph exact-attempt replay tests pass. Webhook replay is N/A because no endpoint exists. |
| Corrupt artifact object | PASS locally | Artifact, Context Engine, MCP, and snapshot tests reject HEAD metadata, byte count, checksum, and UTF-8 mismatch without returning content/key. |
| Corrupt graph object | PASS locally | Graph explorer, sync, Context Engine, MCP, and snapshot tests reject metadata/checksum/schema corruption. |
| Corrupt snapshot object/reference | PASS locally | Snapshot list/inspect/retrieve/idempotent replay share full captured-reference and canonical-manifest verification and fail closed. |
| Partially unauthorized cross-project request | PASS locally | Human and MCP Task D tests authorize the whole set before retrieval, return one nonleaking denial, and assert zero source/R2 reads on denial/race. |
| Account/membership removal | PARTIAL | Direct membership removal is covered across human/MCP/sync. Complete account deletion is not implemented (SA-10). |
| Backup/restore | BLOCKED | No safe local production-equivalent procedure or isolated deployed resource exists. No restore command was run. See SA-06/EG-04. |

## External and live gaps

- **EG-01 Production headers/origins:** set exact HTTPS `VITE_API_URL` in the Cloudflare Pages build environment (`CF_PAGES=1` is platform-provided); the guarded build generates `dist/_headers` from that normalized origin and rejects absent/placeholder/unsafe values. Then verify every Pages/Worker/error/download response at the edge. Confirm HSTS ownership before enabling preload; preload is intentionally not asserted locally.
- **EG-02 GitHub/Cloudflare:** verify OAuth callback registration, cross-site cookie delivery, App private-key formatting, installation suspension/revocation, provider rate behavior, redirect rejection, and log redaction using canary credentials; rotate all test material afterward.
- **EG-03 Clients/runners:** verify the OS secret helper, real Pi/TUI/RPC output, self-hosted runner cgroup/filesystem bounds, untrusted source checkout behavior, and remote graph publication with environment protection.
- **EG-04 Recovery/privacy:** provision isolated private D1/R2, define encrypted backup access and retention, restore into separate resources, run migrations safely, and compare row/reference counts plus every restored immutable checksum/provenance before production approval.
- **EG-05 Edge abuse/observability:** configure and tune login/upload/search/snapshot/build/general rate limits, alerts, redacted structured logs, incident access, and privacy retention. Do not store headers, cookies, callback codes, queries, content, keys, or provider payloads.
- **EG-06 End-to-end:** browser/accessibility, remote D1/R2 isolation/contention, live sync/MCP/Pi, private bucket denial, and deployment checks remain Phase 24/production gates, not Phase 22 local claims.

## Review correction and disposition

The one independent Phase 22 review reported exactly two P1 findings. This single consolidated writer pass fixes both: exact parsed-origin Pages CSP generation/validation without tracked build mutation, and complete redacted OAuth stream/body cleanup failure handling. No second review is planned.

P2 backlog only:

- Broaden representative Worker-header assertions beyond the current centralized-boundary test.
- Cancel the shared bounded JSON body on early media-type and declared-length rejection.
- Final root-gate evidence is recorded: 336 tests (201 API, 42 web, 26 CLI, 26 Pi, 41 adapter), migrations through 0020, typecheck, lint, and all builds.

The single root test/typecheck/lint/build gate passes locally; the parent owns the checkpoint. Free-tier analysis, product metrics, deployment, and full E2E remain explicitly out of scope.
