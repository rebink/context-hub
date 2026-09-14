# Context Hub

A source-backed context control plane for teams and coding agents. The current boundary includes immutable artifacts and snapshots, GitHub identity/repository integration, Graphify publication/exploration, team and audit management, local sync/offline graph cache, the bounded universal MCP endpoint, and the thin Pi package. The management UI now provides URL-backed global/project navigation, directly authorized global Activity, real read-only account/configuration Settings, and all implemented project surfaces. Its independent review/root gate and live browser/accessibility evidence remain pending alongside remote release evidence; see the [implementation status](docs/ai/implementation-status.md), [master plan](docs/ai/master-plan.md), and [architecture](docs/ai/architecture.md).

## Local setup

Requires Node.js 22+ and a Cloudflare account only for remote resources.

```sh
npm install
npm run db:migrate:local
npm run dev
```

The web app runs at `http://localhost:5173`; its API and authentication requests proxy to the Worker at `http://localhost:8787`.

## Quality gate

```sh
npm test # migration integrity plus all workspace unit tests
npm run typecheck
npm run lint
npm run build
```

## Artifact API

Direct project members can use these authenticated routes:

- `GET/POST /projects/:projectId/artifacts`
- `GET /projects/:projectId/artifacts/:artifactId`
- `GET/POST /projects/:projectId/artifacts/:artifactId/versions`
- `GET /projects/:projectId/artifacts/:artifactId/versions/:version`

`ADMIN` and `EDITOR` members can publish; `VIEWER` members have read-only access. Lists default to 50 records, accept `limit` up to 100, and return `nextCursor`; artifact lists also accept a canonical `type` filter.

Uploads are JSON bodies containing UTF-8 text, not base64 or multipart data. This phase accepts Markdown (`text/markdown`), plain text (`text/plain`), JSON (`application/json`), and YAML (`application/yaml`, `text/yaml`, or `application/x-yaml`), optionally with `charset=utf-8`. Content is limited to 1 MiB and total JSON requests to 6 MiB plus 64 KiB; bodies are streamed up to that bound, with `Content-Length` checked early when supplied. Declared JSON content must parse as JSON. PDF, diagrams, binary data, and multipart uploads remain deferred.

Canonical artifact types are `architecture`, `adr`, `api-contract`, `coding-convention`, `domain-knowledge`, `glossary`, `database-schema`, `runbook`, `deployment-guide`, `ownership`, `security-rule`, `product-requirement`, and `custom`.

Every version is stored at an immutable R2 key and published to D1 only after the object write succeeds. Version-detail responses return verified historical content; artifact detail returns metadata and its current version pointer. Clients creating a version must send the artifact's `expectedVersion`; stale writers receive `409 CONFLICT` with the authorized current version.

The project dashboard uses URL-backed Overview, Context, Graphify, Git, Team, Snapshots, Activity, and Settings views. Context supports canonical artifact type filtering, bounded pagination, verified current and historical content, freshness, logical archive, and role-aware creation/version publication. Conflicted drafts are preserved until the author explicitly reviews the latest version; the UI never retries publication automatically.

## Graph API

All direct project members may read bounded graph metadata and query published READY or SUPERSEDED graphs:

- `GET /projects/:projectId/graphs` (latest 50 metadata records)
- `GET /projects/:projectId/graphs/latest`
- `GET /projects/:projectId/graphs/:version`
- `POST /projects/:projectId/graphs/:version/query`

The query body selects `search`, `node`, `neighbors`, `callers`, `callees`, `path`, or `sources`. Result limits are at most 25, paths at most 8 directed source-to-target hops, and traversal is capped at 5,000 nodes and 20,000 links. Responses contain focused projections and graph/project/commit/checksum provenance, never the raw graph, private key, or lease. Although format v1 records `directed=false`, callers, callees, and paths preserve each link's `source -> target` semantics.

`ADMIN` members may send an empty exact-origin `POST /projects/:projectId/graphs/build`. The Worker derives the verified repository and pinned `0.9.58` / `1.0.0` / `code-only-clustered-v1` / format-1 identity server-side and reserves or retries deterministically. ADMIN-only credential routes issue, list, rotate, and revoke one-time CI machine credentials; dedicated bearer-authenticated machine routes claim the queued version, publish exact validated bytes, or report failure. Human sessions cannot publish graph bytes.

New published bytes remain private in R2 at `projects/{projectId}/graphs/v/{version}/attempts/{attempt}/{publicationId}/graph.json`; selected legacy version-only objects remain readable without rewrite. Publication and every explorer read independently apply the Worker-safe format-v1 validator to the exact bytes, including duplicate-key-aware JSON parsing and all schema, UTF-8, path, count, and scalar bounds. The Worker requires schema-safe normalized relative POSIX source paths; the Node adapter remains the authority that proves each path is a tracked regular checkout file. Reads also verify exact object content type, upload ownership metadata, byte size, and SHA-256.

Graph publication favors availability and data safety over eager cleanup. A failed attempt never blocks retry because each claim has a distinct key. Cleanup waits a five-minute grace period, takes a bounded D1 ownership lease, and freshly rechecks failed status/attempt, publication references, and exact R2 head metadata before deleting only that attempt key. R2/D1 uncertainty retains the candidate, and READY, SUPERSEDED, mismatched-attempt, or active objects are never cleanup candidates.

The Graphify tab shows separate newest-attempt/current-READY state, immutable provenance and history, role-aware generation reservation, and the bounded focused explorer. Refresh, build, and query use independently cancellable operation state. Global navigation is exactly Projects, Activity, and Settings; global Activity is a time/page-bounded direct-member aggregate, while global Settings is a bounded read-only account/session and authorized connection overview. GitHub Actions dispatch configuration is documented separately and is not simulated by the browser.

## Pi integration

`packages/context-pi` registers the native `/context connect`, `status`, `sync`, `search`, `graph`, and `snapshot` command forms without adding LLM tools or prompt/provider behavior. It reuses `packages/context-cli` and the existing MCP endpoint, automatically resolves one authorized project from the canonical local GitHub remote, and requires explicit selection when multiple projects match. Status and verified cached graph queries remain useful offline. Snapshot is intentionally unavailable until Phase 18.

ADMIN-provisioned Phase 14 MCP credentials are injected from an OS secret helper through `CONTEXT_HUB_MCP_TOKEN`; existing CLI connect/sync operations use environment-only `CONTEXT_HUB_SESSION`. Both require the independently supplied exact `CONTEXT_HUB_API` origin. Do not put either secret in arguments, repository files, prompts, logs, or output. See [`packages/context-pi/README.md`](packages/context-pi/README.md).

## GitHub OAuth

Create a GitHub OAuth App with its callback URL set to `API_ORIGIN` plus `/auth/github/callback` (`http://localhost:8787/auth/github/callback` locally). The application needs identity only and requests no repository scope.

Make `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` available only to the Worker. For local development, put them in an untracked `apps/api/.dev.vars` file. For production, use Wrangler's secret store or equivalent CI secret bindings; never add either value to `wrangler.toml`, Pages variables, or `VITE_*` variables.

```sh
cd apps/api
npx wrangler secret put GITHUB_CLIENT_ID --env production
npx wrangler secret put GITHUB_CLIENT_SECRET --env production
```

## GitHub repository connection

Repository access uses a separate GitHub App; the identity-only OAuth flow above remains unchanged. Configure the App setup URL as `API_ORIGIN/auth/github-app/setup`, the user authorization callback as `API_ORIGIN/auth/github-app/callback`, and grant only Metadata read and Contents read. Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, and `GITHUB_APP_CLIENT_ID` as Worker configuration. Store `GITHUB_APP_CLIENT_SECRET` and `GITHUB_APP_PRIVATE_KEY` only as Worker secrets (standard GitHub App PKCS#1 and PKCS#8 PEM keys are accepted):

```sh
cd apps/api
npx wrangler secret put GITHUB_APP_CLIENT_SECRET --env production
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env production
```

The App flow uses short-lived, exact-repository installation tokens. D1 stores the installation reference and hashed one-time state/PKCE verifier only; it never stores user tokens, App JWTs, installation tokens, the client secret, or the private key.

## Deployment configuration

Configure the `env.production` D1 ID, R2 bucket, exact `WEB_ORIGIN`, and public Worker `API_ORIGIN` in `apps/api/wrangler.toml`, apply all D1 migrations, then deploy with `wrangler deploy --env production`. The API permits credentialed browser requests only from `WEB_ORIGIN`; production cookies are `Secure`, `HttpOnly`, and `SameSite=None` so credentialed requests work when Pages and the Worker are on separate sites. Local non-TLS development uses `SameSite=Lax`.

Cloudflare Pages should build `@context-hub/web` with `npm run build -w @context-hub/web`, publish `apps/web/dist`, and set `VITE_API_URL` to the production Worker origin. OAuth credentials belong only on the Worker and must not be configured in Pages.

## Documentation

- `docs/ai/project-discovery.md`: active stack and phase boundaries.
- `docs/ai/architecture.md`: runtime, tenancy, and source-of-truth rules.
- `docs/requirements/`: original supplied PRD, architecture, and implementation playbook.
