# Project Discovery

Repository discovery for Prompt 0A. This document describes the checked-in working tree as it exists now; planned product capabilities are explicitly separated from implemented code.

## Product and current boundary

Context Hub is a provider-neutral control plane for giving coding agents bounded, source-backed project context. The repository currently implements the foundation, GitHub identity authentication behind a minimal `AuthProvider` seam, workspace/project authorization and resolution, a real-data dashboard, immutable text artifacts behind a minimal `ObjectStorage` seam, the GitHub App repository connection backend and project UI behind a minimal `GitProvider` seam, the independently reviewed isolated Node-only Graphify adapter, and Phase 9 internal graph publication/storage, authenticated human graph routes, and Graphify status/focused-explorer frontend. Phase 10 machine publication transport and the fail-closed canonical workflow are locally complete through migration 0014 after the single phase review and 154-test gate; live bounded-runner execution and remote D1/R2 evidence remain pending release gates. Local sync, Context Engine, MCP, Pi, snapshots, team administration, and generalized audit are not implemented.

The source-of-truth split is an architectural invariant:

- Git is source-code truth.
- D1 is current metadata truth for implemented tenancy, authorization, sessions, repository identities, artifact versions, and artifact audit events; planned metadata is listed in [`architecture.md`](architecture.md).
- R2 stores immutable artifact and graph payloads today and is planned to store immutable snapshot payloads.

## Repository structure

```text
.
|-- .github/workflows/ci.yml       GitHub Actions quality gate
|-- apps/
|   |-- api/
|   |   |-- migrations/            Ordered D1 SQL migrations 0001-0014
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
|-- packages/graphify-adapter/     Isolated Node GraphProvider, validator, fixtures, tests
`-- tsconfig.base.json             Shared strict TypeScript options
```

There is no ORM, application framework, component framework, generated API client, local CLI, MCP package, or provider registry/factory. `packages/graphify-adapter` is the only Node-only package and is not imported by either application.

## Language, runtime, and package management

- TypeScript/ES modules across both npm workspaces; shared compiler target is ES2022 with `strict`, `noUncheckedIndexedAccess`, `noEmit`, and bundler module resolution.
- Node.js 22 or newer is required for local tooling and CI.
- npm workspaces (`apps/*` and `packages/*`) and `package-lock.json` are the package-management boundary. There is no pnpm, Yarn, Turborepo, or Nx configuration.
- Dependencies are deliberately small: Vite, Wrangler, TypeScript, `tsx`, Biome, Cloudflare Worker types, and `concurrently`. No runtime web framework or ORM is installed.

## Implemented architecture

### Frontend

- `apps/web` is a vanilla TypeScript single-page app built by Vite for static hosting on Cloudflare Pages.
- `src/main.ts` owns authentication bootstrap, workspace/project selection, project creation, dashboard rendering, and switching between Overview, Artifacts, and Graphify.
- `src/git.ts` owns project-scoped repository status and ADMIN connect/refresh/disconnect controls; `src/git-helpers.ts` owns browser-independent input, callback, and stale-request helpers.
- `src/artifacts.ts` owns the category/list/detail/history/create/publish artifact experience. DOM nodes containing uploaded content are created with `textContent`; content is not interpreted as HTML.
- `src/api.ts` is the credentialed Fetch wrapper and bounded JSON error mapping seam. Client validation mirrors public artifact and repository constraints for feedback; the Worker remains authoritative.
- Local project selection is stored in `localStorage`; no credential or authorization decision is stored there.
- The UI has real project/member/artifact/Git data plus role-aware Graphify lifecycle, provenance, version history, and bounded explorer queries; it retains an honest `Not configured` sync placeholder.

### Worker/API

- `apps/api` is a Cloudflare Worker using the native Fetch API. `src/index.ts` is a hand-written route dispatcher and contains OAuth, session, workspace, project, and repository-resolution handlers.
- `src/artifacts.ts` is the artifact route module. It validates bounded uploads, authorizes direct project members, writes immutable objects to R2, publishes D1 metadata, compensates safe unpublished writes, and verifies size/checksum before retrieval.
- `src/security.ts` contains reusable random-token, SHA-256, cookie serialization/parsing, and cookie-name helpers.
- Current routes are health; GitHub login/callback/session/logout; workspace list/create; project list/create/detail; authorized repository resolution; artifact list/create/detail/version list/publish/read; graph list/latest/detail/build reservation plus bounded explorer queries; ADMIN machine-credential lifecycle; and dedicated bearer-auth graph claim/publish/fail.
- Authentication, project scope, role checks, Origin checks, CORS, and nonleaking errors are server concerns. Browser-provided identity/role is never authoritative.

### Database and object storage

- Ordered SQL migrations under `apps/api/migrations` own the D1 schema. There is no schema generator or ORM migration layer.
- Implemented tables: `users`, `sessions`, `oauth_states`, `workspaces`, `workspace_members`, `projects`, `project_members`, `repository_identities`, `project_repositories`, `artifacts`, `artifact_versions`, artifact-specific `audit_events`, `github_connection_states`, `git_connections`, `git_audit_events`, `graph_versions`, `graph_build_attempts`, and `graph_events`.
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

- Tests use Node's built-in `node:test` and `node:assert` through `tsx --test`; API tests use in-memory D1/R2/provider fakes rather than deployed Cloudflare resources.
- Existing tests cover Worker health/auth/projects/isolation, session-bound and race-safe repository connection/resolution, optimistic Git mutations, exact callback-origin validation, and artifact validation, authorization, immutability, integrity, conflicts, pagination, and compensation, plus focused GitHub `AuthProvider`, GitHub App `GitProvider`, and R2 `ObjectStorage` adapter contracts. A Wrangler local-D1 check, included in root `npm test`, covers fresh/staged-through-0013 migrations, restored graph bounds, database-time lease expiry, exact attempt-backed graph lifecycle constraints, immutable attempt/event history, migration-event consistency, attempt-scoped cleanup/retry ownership, link uniqueness, foreign keys, and transactional rollback. Browser-independent web tests cover upload validation plus Git repository input, callback mapping, callback cleanup, and stale-request guards; there is no browser E2E suite.
- Type checking is workspace-local `tsc` against the shared strict base config.
- Biome supplies root recommended linting and formatting. Generated/build directories and `graphify-out` are excluded.
- Builds are a Wrangler dry-run Worker bundle and a TypeScript-plus-Vite web build.
- `.github/workflows/ci.yml` runs on pull requests and pushes to `main`: `npm ci`, local D1 migrations, tests, typecheck, lint, and build.
- Deployment targets are Cloudflare Pages for `apps/web` and Workers with D1/R2 bindings for `apps/api`. Production resource IDs, bucket names, and origins are placeholders; GitHub/Cloudflare secrets are external bindings, not source values.
- The repository has the Phase 9 baseline checkpoint `cad3dce`, but remote CI has not run. Browser, live OAuth, remote D1/R2, live graph workflow, and production deployment verification have not run.

## Reusable code and conventions

- **API helpers:** `createApp(outboundFetch)` makes the Worker and GitHub adapter testable without global state; `authenticate`, response/CORS helpers, bounded body parsing, slug/ID validation, and `normalizeGithubRepository` are current seams, though several remain local to `index.ts`.
- **Provider seams:** `AuthProvider`/`GithubAuthProvider` own identity-provider mechanics; `ObjectStorage`/`R2ObjectStorage` own byte and metadata operations. [`adr/0001-provider-boundaries.md`](adr/0001-provider-boundaries.md) records ownership and failures.
- **Security helpers:** token generation, hashing, cookie read/write/clear functions in `apps/api/src/security.ts`.
- **Artifact helpers:** canonical artifact/content-type sets, cursor encoding, immutable put/recovery, safe compensation, row mapping, and checksum verification in `apps/api/src/artifacts.ts`.
- **Web helpers:** generic credentialed `api<T>`, `ApiError`, upload validation, artifact mount/unmount lifecycle, safe DOM construction, and request cancellation/generation guards.
- **Testing conventions:** colocated workspace `test/**/*.test.ts`, descriptive behavior tests, structural Cloudflare fakes, and dependency injection only where needed (`outboundFetch`).
- **Data/API conventions:** UUID IDs generated server-side; snake_case D1 columns; camelCase artifact response fields but snake_case project response fields; ISO timestamps; parameterized SQL; ordered migrations; explicit size/page limits; opaque cursors; uppercase roles/statuses and stable uppercase error codes.
- **Change convention:** one phase at a time, no later-phase implementation before the root quality gate passes, and an ADR before significant architecture decisions.

## Implemented versus deferred

| Area | Implemented now | Deferred/planned |
| --- | --- | --- |
| Identity | GitHub OAuth identity, users, hashed states/sessions, logout | Additional auth providers; machine principals/credentials |
| Tenancy | Workspaces, projects, direct memberships, role checks | Invitations, role changes/removal, project administration |
| Git | GitHub remote normalization, GitHub App connect/read/sync/disconnect backend and project UI, real identity links, commit tracking, and authorized resolution | Live-provider/browser deployment verification |
| Artifacts | Bounded text formats, immutable R2 versions, checksums, conflicts, UI | Binary/multipart formats, archive lifecycle, freshness UI |
| Graph | Independently reviewed isolated `GraphProvider`; constrained graph versions/events; internal immutable publication/storage; authenticated human metadata/build reservation and bounded explorer routes; status/focused-explorer frontend | Machine credentials/publication transport; CI workflow |
| Context/clients | None | Context Engine, universal MCP, Pi, local/offline sync, cross-project retrieval |
| Operations | Local scripts, migrations, GitHub Actions definition | Remote CI evidence, production resources/deploy, rate limits/observability/backups |
| Audit/snapshots | Artifact publication events only | General audit model/UI and immutable context snapshots |

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
- Keep Graphify execution behind the implemented single minimal `GraphProvider` and independently reviewed `GraphifyAdapter`; add `ContextProvider` and `McpTransport` only in their own later phases.
- Add new D1 migrations, never rewrite applied migrations; add indexed project predicates and tests with each table/route family.
- Add graph and snapshot R2 prefixes beneath the existing server-generated `projects/{projectId}/...` namespace, preserving immutable publication and checksum metadata.
- Split Worker route modules by feature while retaining the required authenticate -> resolve -> direct-membership -> role -> execute sequence.
- Extend the web through the existing API client and mount/unmount view pattern until repeated evidence justifies a broader frontend architecture decision.
