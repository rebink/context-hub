# Project Discovery

Repository discovery for Prompt 0A. This document describes the checked-in working tree as it exists now; planned product capabilities are explicitly separated from implemented code.

## Product and current boundary

Context Hub is a provider-neutral control plane for giving coding agents bounded, source-backed project context. The repository currently implements the foundation, GitHub identity authentication behind a minimal `AuthProvider` seam, workspace/project authorization and resolution, a real-data dashboard, immutable text artifacts behind a minimal `ObjectStorage` seam, the GitHub App repository connection backend and project UI behind a minimal `GitProvider` seam, the independently reviewed isolated Node-only Graphify adapter, Phase 9 graph publication/query/UI, reviewed Phase 10 machine publication, and reviewed Phase 11 local sync/offline cache. Phase 12 has the minimal `ContextProvider` and one bounded non-vector `ContextEngine`; Phase 13's independently reviewed executable scenarios cover key/provenance/budget/isolation boundaries. Task D now locally extends that same seam with accepted ADR 0008, explicit all-authorized one-to-twenty-project retrieval, per-read opaque authorization fences, exact complete-response budgeting, global deterministic ranking/provenance-safe deduplication, a human API, and one-engine MCP search; its one review, consolidated two-P1 fix pass, and 318-test root gate are complete. Phase 14/B now has accepted ADR 0007, separate hash-only MCP/local-client principals, one bounded `WorkerMcpTransport`, the universal six-tool `GET/POST /mcp` route, explicit all-authorized cross-project scope, and targeted transport/lifecycle/replay/isolation/migration evidence. Its one independent review, consolidated seven-item P1 correction pass, and 219-test root gate are complete. Phase 15 adds a deterministic executable audit of the exported schemas and encoder, proving an exactly constant six-tool footprint for 1, 10, and 100 authorized projects plus bounded representative and nonleaking denial responses; its single independent review, consolidated two-item P1 fix pass, and 222-test root gate are complete. Phase 16/C now has an implemented thin Pi package with one native command family, CLI/cache reuse, repository-aware project selection, bounded MCP search/graph requests, and verified offline graph fallback. Its single review, consolidated four-item P1 correction pass, and 245-test root gate are complete. Phase 17 adds a canonical deterministic audit over actual Pi registration/lifecycle/formatting/limits that derives zero permanent model context through fail-closed mutation traps, proves constant registration for 1/10/100 authorized projects, and locks UTF-8-safe/redacted bounded formatted notification payloads; its one review, consolidated four-item P1 correction, and 249-test root gate are complete. External live Pi/TUI evidence remains pending. Phase 18 implements authenticated immutable snapshot create/list/inspect/retrieve with sealed exact graph/artifact provenance, canonical private R2 manifests, shared integrity verification, D1-authoritative narrow outcomes, and ownership-safe compensation; its single review, consolidated seven-item P1 correction, and 261-test root gate are complete. Phase 19 freshness UI plus bounded per-client sync-state persistence/reporting are complete locally after one review, one consolidated four-P1 correction, and the 274-test root gate. Live browser/accessibility, runner, remote D1/R2/sync/MCP reporting, OS secret-helper, and live MCP-client evidence remain release gates. Phase 20 team administration is complete locally through additive migration 0018 and the role-aware Team surface after one review, one consolidated five-P1 correction, and the 290-test root gate. Phase 20A project settings and logical artifact archive are complete locally through additive migration 0019 after one review, one consolidated three-P1 correction, and the 302-test root gate. Phase 21 generalized project audit materialization, bounded direct-member Activity API, and role-neutral project Activity UI are complete locally through additive migration 0020 after one review, one consolidated four-P1 correction, and the 309-test root gate. Management UI completion is complete locally on top of Task D checkpoint `5b3b0c9`: URL-backed global/project navigation, authorized global Activity and read-only Settings APIs/UI, real current Overview status, and snapshot create/list/inspect UI passed one review, one consolidated six-P1 correction, and the 330-test root gate. No live browser/accessibility run is claimed.

The source-of-truth split is an architectural invariant:

- Git is source-code truth.
- D1 is current metadata truth for implemented tenancy, authorization, sessions, repository identities, artifact/graph versions, snapshot references, bounded sync states, and narrow domain audit evidence; planned metadata is listed in [`architecture.md`](architecture.md).
- R2 stores immutable artifact and graph payloads plus canonical immutable snapshot manifests.

## Repository structure

```text
.
|-- .github/workflows/ci.yml       GitHub Actions quality gate
|-- apps/
|   |-- api/
|   |   |-- migrations/            Ordered D1 SQL migrations 0001-0019
|   |   |-- src/                   Worker router, provider adapters, security, artifacts
|   |   |-- test/                  Worker unit/integration-style tests with fakes
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   `-- wrangler.toml          Worker, D1, R2, origins, production placeholders
|   `-- web/
|       |-- src/                   Browser app, API client, artifacts UI/validation, CSS
|       |-- test/                  Browser-independent validation tests
|       |-- .env.example
|       |-- package.json
|       |-- tsconfig.json
|       `-- vite.config.ts         Development proxy
|-- docs/
|   |-- ai/                        Active discovery, architecture, security, plan/status
|   `-- requirements/              Approved PRD, architecture, and playbook inputs
|-- AGENTS.md                      Small permanent engineering invariants
|-- biome.json                     Root formatting/lint policy
|-- package.json                   npm workspace scripts and tool versions
|-- package-lock.json              Locked npm dependency graph
|-- packages/context-cli/          Node local sync CLI, atomic cache, offline status, tests
|-- packages/context-pi/          Thin native Pi commands, MCP client, resolution, tests
|-- packages/graphify-adapter/     Isolated Node GraphProvider, validator, fixtures, tests
`-- tsconfig.base.json             Shared strict TypeScript options
```

There is no ORM, application framework, component framework, generated API client, or provider registry/factory. `packages/graphify-adapter` remains isolated from both applications; `packages/context-cli` is the dependency-light Node-only local sync client, and `packages/context-pi` is a thin package over that CLI/cache plus the existing MCP endpoint.

## Language, runtime, and package management

- TypeScript/ES modules across both npm workspaces; shared compiler target is ES2022 with `strict`, `noUncheckedIndexedAccess`, `noEmit`, and bundler module resolution.
- Node.js 22 or newer is required for local tooling and CI.
- npm workspaces (`apps/*` and `packages/*`) and `package-lock.json` are the package-management boundary. There is no pnpm, Yarn, Turborepo, or Nx configuration.
- Dependencies are deliberately small: Vite, Wrangler, TypeScript, `tsx`, Biome, Cloudflare Worker types, and `concurrently`. No runtime web framework or ORM is installed.

## Implemented architecture

### Frontend

- `apps/web` is a vanilla TypeScript single-page app built by Vite for static hosting on Cloudflare Pages.
- `src/main.ts` owns authentication bootstrap, URL/history-backed global and project navigation, workspace/project selection, project creation, and view lifecycle. Global routes are exactly Projects, Activity, and Settings; project routes are exactly Overview, Context, Graphify, Git, Team, Snapshots, Activity, and Settings.
- `src/git.ts` owns project-scoped repository status and ADMIN connect/refresh/disconnect controls; `src/git-helpers.ts` owns browser-independent input, callback, and stale-request helpers.
- `src/artifacts.ts` owns the category/list/detail/history/create/publish artifact experience. DOM nodes containing uploaded content are created with `textContent`; content is not interpreted as HTML.
- `src/api.ts` is the credentialed Fetch wrapper and bounded JSON error mapping seam. Client validation mirrors public artifact and repository constraints for feedback; the Worker remains authoritative.
- Local project selection is stored in `localStorage`; no credential or authorization decision is stored there.
- The UI has real project/member/artifact/Git data plus role-aware Graphify lifecycle, provenance, version history, bounded explorer queries, Team, snapshot create/list/inspect, project Activity, global authorized Activity, read-only account/configuration Settings, and the ADMIN project Settings/archive controls. Overview obtains current Git, READY graph, and reported sync state rather than displaying placeholders.

### Worker/API

- `apps/api` is a Cloudflare Worker using the native Fetch API. `src/index.ts` is a hand-written route dispatcher and contains OAuth, session, workspace, project, and repository-resolution handlers.
- `src/artifacts.ts` is the artifact route module. It validates bounded uploads, authorizes direct project members, writes immutable objects to R2, publishes D1 metadata, compensates safe unpublished writes, verifies size/checksum before retrieval, and applies ADMIN-only revision-fenced logical archive without deleting R2 or versions. `src/project-administration.ts` owns the exact-field ADMIN settings mutation.
- `src/security.ts` contains reusable random-token, SHA-256, cookie serialization/parsing, and cookie-name helpers.
- Current routes are health; GitHub login/callback/session/logout; workspace list/create; project list/create/detail/settings update; bounded project Activity list/detail; bounded direct-member global Activity; bounded read-only account/session and authorized project configuration Settings; authorized repository resolution; artifact list/create/detail/version list/publish/read plus logical archive with freshness; graph list/latest/detail/build reservation plus bounded explorer queries; immutable snapshot create/list/inspect/manifest retrieval; bounded human sync-state list/current and Authorization-only local-principal current upsert; ADMIN CI machine-credential lifecycle and dedicated graph claim/publish/fail; ADMIN MCP/local-client credential lifecycle; and one bearer-authenticated universal `GET/POST /mcp` endpoint.
- Authentication, project scope, role checks, Origin checks, CORS, and nonleaking errors are server concerns. Browser-provided identity/role is never authoritative.

### Database and object storage

- Ordered SQL migrations under `apps/api/migrations` own the D1 schema. There is no schema generator or ORM migration layer.
- Implemented tables include identity/session, workspace/project membership, normalized repositories/Git connections, immutable artifact and attempt-scoped graph metadata, separate CI and MCP principal/credential/nonce/audit tables, migration 0016's immutable context snapshots, migration 0017's bounded indexed project/principal/client sync states, migration 0018's exact-user project invitations plus narrow team outcomes, migration 0019's project settings revisions/artifact tombstones/narrow administration outcomes, and migration 0020's immutable graph-reservation/sync-report evidence plus exact-source-sealed generalized `project_audit_events` materialization.
- Implemented indexes cover session/state expiry and lookup, workspace/project membership, projects by workspace, repository resolution and Git connections, artifact project/type pagination and history, and domain audit lookup.
- R2 is accessed only through the Worker `OBJECTS` binding and the single `R2ObjectStorage` adapter. Artifact and graph keys are server generated beneath `projects/{projectId}/`; D1 records immutable key, SHA-256, content type, byte size, provenance, author/principal, and time.
- Minimal provider-neutral `AuthProvider` and `ObjectStorage` contracts have exactly one GitHub and R2 implementation respectively; there are no factories, registries, fallbacks, or speculative providers.

### Authentication and authorization

- GitHub OAuth is identity-only (`scope` is empty). State is random, short-lived, stored only as a SHA-256 hash, bound to an `HttpOnly` cookie, and atomically consumed once.
- The callback exchanges the code, fetches `/user`, discards the access token after that request, upserts the GitHub identity, and creates an opaque session whose token is stored only as a hash.
- Exact configured origins are used for credentialed CORS and mutation protection. Production cookies use `Secure; SameSite=None`; local HTTP cookies use `SameSite=Lax`.
- Workspace `ADMIN` membership permits project creation. Project reads and artifact operations require direct `project_members` membership; `VIEWER` is read-only and inaccessible resources return nonleaking `404` responses.
- This OAuth app does not grant repository API access. Repository access uses the separate accepted GitHub App flow in ADR 0002, with transient exact-repository installation tokens and no persisted provider token.

## Tooling, tests, and delivery

- Tests use Node's built-in `node:test` and `node:assert` through `tsx --test`; API tests use in-memory D1/R2/provider fakes rather than deployed Cloudflare resources. The Phase 15 `audit:mcp-tokens` script imports the actual MCP schema/transport exports and emits reproducible UTF-8 byte, byte/4 estimate, hash, response, and upper-bound evidence without a tokenizer/runtime dependency. The Phase 17 `audit:pi-tokens` script activates the actual extension and locks a canonical digest plus registration, lifecycle, formatted UI payload, fail-closed no-mutation, and 1/10/100-project invariants while keeping transport bytes separate from model context.
- Existing tests cover Worker health/auth/projects/isolation, session-bound and race-safe repository connection/resolution, optimistic Git mutations, exact callback-origin validation, and artifact validation, authorization, immutability, integrity, conflicts, pagination, and compensation, plus focused GitHub `AuthProvider`, GitHub App `GitProvider`, and R2 `ObjectStorage` adapter contracts. Phase 13 adds executable Context Engine scenarios with SQL/order-aware D1 and HEAD-before-get R2 fakes for combined relevance, capped graph evidence, independently measured budgets, per-state provenance, calibrated pre-budget deduplication, freshness, current-row selection, valid legacy/current and malformed storage-key matrices, error shape, and repeated-search isolation behavior. A Wrangler local-D1 check, included in root `npm test`, covers fresh/staged-through-0013 migrations, restored graph bounds, database-time lease expiry, exact attempt-backed graph lifecycle constraints, immutable attempt/event history, migration-event consistency, attempt-scoped cleanup/retry ownership, link uniqueness, foreign keys, and transactional rollback. Browser-independent web tests cover upload validation plus Git repository input, callback mapping, callback cleanup, and stale-request guards; there is no browser E2E suite.
- Type checking is workspace-local `tsc` against the shared strict base config.
- Biome supplies root recommended linting and formatting. Generated/build directories and `graphify-out` are excluded.
- Builds are a Wrangler dry-run Worker bundle and a TypeScript-plus-Vite web build.
- `.github/workflows/ci.yml` runs on pull requests and pushes to `main`: `npm ci`, local D1 migrations, tests, typecheck, lint, and build.
- Deployment targets are Cloudflare Pages for `apps/web` and Workers with D1/R2 bindings for `apps/api`. Production resource IDs, bucket names, and origins are placeholders; GitHub/Cloudflare secrets are external bindings, not source values.
- The repository has the Phase 9 baseline checkpoint `cad3dce`, but remote CI has not run. Browser, live OAuth, remote D1/R2, live graph workflow, and production deployment verification have not run.

## Reusable code and conventions

- **API helpers:** `createApp(outboundFetch)` makes the Worker and GitHub adapter testable without global state; `authenticate`, response/CORS helpers, bounded body parsing, slug/ID validation, and `normalizeGithubRepository` are current seams, though several remain local to `index.ts`.
- **Provider seams:** `AuthProvider`/`GithubAuthProvider` own login mechanics; the narrow `IdentityLookupProvider`/`GithubIdentityLookupProvider` resolves current public GitHub login to stable identity for invitation targeting; `ObjectStorage`/`R2ObjectStorage` own byte and metadata operations. [`adr/0001-provider-boundaries.md`](adr/0001-provider-boundaries.md) records ownership and failures.
- **Security helpers:** token generation, hashing, cookie read/write/clear functions in `apps/api/src/security.ts`.
- **Artifact helpers:** canonical artifact/content-type sets, cursor encoding, immutable put/recovery, safe compensation, row mapping, and checksum verification in `apps/api/src/artifacts.ts`.
- **Web helpers:** generic credentialed `api<T>`, `ApiError`, upload validation, artifact mount/unmount lifecycle, safe DOM construction, and request cancellation/generation guards.
- **Testing conventions:** colocated workspace `test/**/*.test.ts`, descriptive behavior tests, structural Cloudflare fakes, and dependency injection only where needed (`outboundFetch`).
- **Data/API conventions:** UUID IDs generated server-side; snake_case D1 columns; camelCase artifact response fields but snake_case project response fields; ISO timestamps; parameterized SQL; ordered migrations; explicit size/page limits; opaque cursors; uppercase roles/statuses and stable uppercase error codes.
- **Change convention:** one phase at a time, no later-phase implementation before the root quality gate passes, and an ADR before significant architecture decisions.

## Implemented versus deferred

| Area | Implemented now | Deferred/planned |
| --- | --- | --- |
| Identity | GitHub OAuth identity plus separate hash-only CI and MCP/local-client principals/credentials | Additional identity providers; OS secret-store client handoff |
| Tenancy | Workspaces, projects, direct memberships, role checks, bounded exact-user invitations, acceptance, role changes/removal, final-admin protection, URL-backed management navigation, and revision-fenced project administration | Project archive |
| Git | GitHub remote normalization, GitHub App connect/read/sync/disconnect backend and project UI, real identity links, commit tracking, and authorized resolution | Live-provider/browser deployment verification |
| Artifacts | Bounded text formats, immutable R2 versions, checksums, conflicts, shared-classifier freshness API/UI, and logical archive with default active exclusion and exact historical retrieval | Binary/multipart formats and restore |
| Graph | Independently reviewed isolated `GraphProvider`; constrained graph versions/events; private immutable publication; CI machine transport/workflow; human metadata/build and bounded explorer | Live runner/provider/remote publication evidence |
| Context/clients | Node local sync CLI; reviewed bounded single/explicit cross-project Context Engine with per-read authorization fences; stable six-tool MCP transport; thin native Pi commands; deterministic token audits; bounded best-effort sync-state reporting | Live Pi/remote D1/R2/performance evidence; artifact sync |
| Operations | Local scripts, migrations, GitHub Actions definition | Remote CI evidence, production resources/deploy, rate limits/observability/backups |
| Audit/snapshots | General immutable per-project audit materialization, project/global authorized Activity API/UI, artifact/team/Git/graph/snapshot/sync/credential source evidence, immutable snapshot references/manifests, and snapshot create/list/inspect UI | Live browser/accessibility evidence |

## Risks and unknowns

- `src/index.ts` combines routing and multiple domains; the Git routes use a narrow module/provider seam, but future route families could still increase dispatcher coupling.
- GitHub OAuth remains identity-only and the separate GitHub App credential design is accepted and implemented locally. Live installation, callback, revocation, key-formatting, and API/rate-limit behavior still require deployed provider verification.
- D1 `batch` behavior and R2 create-only/recovery are tested with fakes but still require remote integration validation. D1 and R2 cannot provide a cross-service transaction, so publication ordering and conservative orphan handling remain important.
- Graphify 0.9.58 CLI/output/version/auth/deployment behavior and the `code-only-clustered-v1` profile are documented in [`graphify-integration.md`](graphify-integration.md) and accepted by [`adr/0003-graphify-canonical-build-profile.md`](adr/0003-graphify-canonical-build-profile.md). The isolated adapter implements accepted preflight, execution, and tracked-file validation; the Worker implements internal lease-fenced publication/storage and bounded human graph queries. Representative resource sizing, cross-environment determinism, complete Python dependency hash locking, host-enforced memory/disk sandboxing, machine transport, future schema compatibility, and live Actions publication remain Phase 10 blockers.
- Cloudflare/GitHub current free-tier limits, production rate limits, cache policy, logging, backup/restore, and secret operations remain unverified.
- The frontend is hand-built DOM code with no router or component framework. This is adequate now, but management and graph surfaces may expose repeated view/state patterns; framework adoption is not approved merely because expansion is likely.
- API naming is not uniform between project and artifact payloads. New contracts should choose and test an existing boundary deliberately rather than silently spreading both styles.
- Unit-style fakes do not replace browser, accessibility, live OAuth, Worker/D1/R2, provider, or end-to-end tests.

## Likely extension points

These are locations implied by approved requirements, not implemented modules:

- Extend Git connection behavior only through the accepted `GitProvider` boundary; keep normalized `repository_identities` and `project_repositories` as the resolution boundary.
- Keep Graphify execution behind the implemented single minimal `GraphProvider`; Context retrieval behind the one `ContextProvider`; and MCP protocol behavior behind the one minimal `McpTransport`. Do not add factories or alternate providers/transports without an owning accepted decision.
- Add new D1 migrations, never rewrite applied migrations; add indexed project predicates and tests with each table/route family.
- Add graph and snapshot R2 prefixes beneath the existing server-generated `projects/{projectId}/...` namespace, preserving immutable publication and checksum metadata.
- Split Worker route modules by feature while retaining the required authenticate -> resolve -> direct-membership -> role -> execute sequence.
- Extend the web through the existing API client and mount/unmount view pattern until repeated evidence justifies a broader frontend architecture decision.
