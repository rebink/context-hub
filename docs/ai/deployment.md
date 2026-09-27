# Production deployment preparation

Status: **PREPARATION ONLY; PRODUCTION BLOCKED**  
Official-source access date: **2026-09-15 UTC**  
Baseline: Phase 25 checkpoint `dd65ff65906bcfd4cd03032420ebc26c5fbae571`

This runbook separates offline preparation, read-only inventory, mutation, and destructive recovery. Nothing in Phase 26 authorizes a Cloudflare or GitHub network call, resource creation, secret change, DNS/domain change, D1 export/migration/restore, R2 policy change, upload, deployment, rollback, or production traffic. Commands marked **MUTATION** or **DESTRUCTIVE** are documentation and were not run. Production remains blocked by all live gates in [`final-qa.md`](final-qa.md); the separate local-process gaps are narrowed to Phase 6's historical review topology and absent contemporaneous Git checkpoint documented in [`phase-6-acceptance-evidence.md`](phase-6-acceptance-evidence.md).

## Approval boundary and owners

The release owner must obtain one exact manifest approved for one immutable commit and change window. The manifest names these accountable people or teams; aliases must resolve outside the repository:

| Owner | Approval boundary |
| --- | --- |
| Release | Immutable commit, gate receipts, ordered sequence, maintenance window, go/no-go and evidence custody |
| Cloudflare account | Account/zone, Worker/Pages/D1/R2 inventory, token scopes, route/domain, migration and traffic mutations |
| GitHub application | OAuth App/GitHub App IDs, exact URLs, permissions, environment protections and secret rotation |
| Security | secret delivery, log/retention/redaction policy, browser/OAuth/private-object checks and incident access |
| Incident | traffic stop, code forward-fix/rollback decision, data-recovery escalation and communications |
| Data/recovery | D1 export/Time Travel and isolated restore rehearsal; this may be the Cloudflare owner only when explicitly recorded |
| Product/privacy | account deletion, retention, metrics and alert policy; these remain blocked and cannot be inferred by operations |

Required prerequisites are: approved account and plan; repository visibility and GitHub-environment protection availability; account/zone/resource IDs and names; canonical HTTPS origins; domain/DNS ownership; OAuth and App ownership; least-privilege token summaries; private Standard R2 policy; migration/recovery owner; approved observability/rate/retention policy; protected runner; browser/accessibility identities; incident contacts; and closure of BLK-003 through BLK-011. Missing any item is a no-go.

## Source-of-truth manifest

`scripts/deployment-contract.mts` is the one production contract for scalar definitions, exact gate commands, limits, runtime validation, and generated `scripts/deployment-manifest.schema.json`; `npm run deploy:schema:check` rejects drift. Cross-field checks that JSON Schema cannot honestly prove (canonical public host classification, origin/callback/route equality, non-fixture identifiers, secret patterns, receipt contents and repository paths) remain explicit runtime checks in `scripts/deploy-preflight.mts`. Store the actual production manifest at ignored `.deployment/manifest.json`; `.deployment/` and `deployment-evidence/` are ignored because identifiers are nonsecret but operationally sensitive.

The manifest contains only:

- release commit and asserted `main` branch context, change ID/window, five owners, incident and rollback references;
- Cloudflare account/zone IDs, Worker name/environment/origin/custom-domain route, tested compatibility date, explicitly approved Workers Logs sampling policy, D1 name/UUID, private R2 bucket, and Pages project/origin;
- GitHub nonsecret OAuth/App IDs and slug, exact URLs, identity-only OAuth scope, read-only App permissions, and environment-protection reference;
- exactly three required secret names: `GITHUB_CLIENT_SECRET`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_PRIVATE_KEY`;
- exact Node/npm/Wrangler versions, lockfile SHA-256 and conflict-free action SHAs;
- nine distinct ignored receipt paths for the exact commands `npm test`, typecheck, lint, build, architecture QA, local E2E, migration integrity, offline security audit, and free-tier audit.

`GITHUB_CLIENT_ID`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, and `GITHUB_APP_CLIENT_ID` are nonsecret identifiers and become Worker vars. `VITE_API_URL` is the only public Vite variable. The three required secret values are accepted only from the preflight process environment to check non-empty presence; they are never printed, hashed, passed to children, placed in generated config, or included in evidence. No other `VITE_*` setting is approved.

The production CLI rejects unknown/missing fields; placeholders; `.test`, `.example`, `.invalid`, localhost, IP/private/link-local/reserved/noncanonical/wildcard hosts; credential/path/query/fragment origins; callback/route mismatches; zero/repeated/fixture IDs and synthetic names; public R2/CORS/domains; Worker `workers.dev` or preview URLs; Pages previews; mutable refs/tool/action pins; conflicting action pins; wrong compatibility date; missing owners/window/runbooks; receipt path escapes/duplicates; wrong-command/prior-commit/self-attested/malformed receipts; unexpected secret names; recognizable secret values; and secret-shaped fields. GitHub client IDs accept only the currently documented `Iv1.` or `Ov23li` forms as lexical preparation checks, not proof that GitHub issued or owns the ID. No CLI flag enables synthetic values; tests inject only a process runner, sandbox and operational roots.

### Exact origin contract

For approved origins `WEB_ORIGIN=https://<PAGES_HOST>` and `API_ORIGIN=https://<WORKER_HOST>`, with no trailing slash:

- Pages `VITE_API_URL` = `API_ORIGIN` exactly.
- Worker `WEB_ORIGIN` = Pages origin exactly; credentialed CORS and browser mutation Origin checks use it.
- Worker `API_ORIGIN` = Worker origin exactly.
- OAuth callback = `API_ORIGIN/auth/github/callback`.
- GitHub App setup URL = `API_ORIGIN/auth/github-app/setup`.
- GitHub App user callback = `API_ORIGIN/auth/github-app/callback`.
- Worker custom-domain route hostname = the `API_ORIGIN` hostname.
- Production cookie behavior is `Secure; HttpOnly; SameSite=None`; browser evidence must prove this at the exact origins.

Wildcard callbacks/CORS, alternate/path origins, Worker preview URLs, Pages preview deployments, implicit `workers.dev`, and public R2 are forbidden for MVP. A later need for any preview or public hostname requires a separate approved policy, contract change, independent live verification and new candidate; it cannot be enabled in this manifest.

## Local preflight

Install from the committed lockfile before entering secret material. The command is offline by default and has no remote or mutation mode:

```sh
npm ci --ignore-scripts
npm run deploy:preflight -- --manifest .deployment/manifest.json
```

The preflight fails closed unless the worktree is clean at the exact manifest commit on `main`; exact staged, unstaged and untracked changes are rejected. A deliberately detached CI checkout must pass the same immutable SHA through `--ci-detached-sha`. It parses every distinct same-HEAD receipt: exact command, PASS, start/end UTC, bounded output byte count/digest, exact tool versions, local-process generator identity and receipt digest. Generic documentation references, duplicate paths/output/receipt digests, prior commits and self-attestation strings are rejected. `npm run deploy:gate-receipt -- --gate <gate> --output .deployment/receipts/<gate>.json` is the local receipt generator; it requires a clean worktree, executes the contract command directly, stores no output, and creates a mode-0600 receipt. This correction did not generate production gate receipts.

Every child process, including Git identity, local migrations, compiler/build, Worker dry-run and an active DNS/socket probe, runs inside an OS-enforced deny-network sandbox. Darwin requires canonical `/usr/bin/sandbox-exec`; Linux requires a validated `bwrap` or `unshare` network namespace; unsupported/unavailable enforcement fails closed. Children receive isolated HOME/TMP, fixed locale, no proxies or Cloudflare/GitHub credentials, bounded output/time, a contained process group, TERM/KILL escalation and an independent final deadline even if `close` never arrives. No `npx`, remote binding/dev, upload, deployment, or request exists in preflight.

On success, preflight atomically retains a mode-0700 ignored candidate under `.deployment/candidates/`. It contains mode-0600 canonical manifest, generated top-level production `wrangler.toml`, copied ordered migrations and gate receipts, exact Pages bytes/headers, Worker dry-run bytes/source maps, redacted evidence, canonical file inventory and `candidate.digest`. All config, manifest, receipts, child output, headers, Worker/Pages files and maps are scanned before temporary data is discarded. `npm run deploy:candidate:verify -- "$CANDIDATE" --expect "$CANDIDATE_DIGEST"` rehashes every retained payload and checks modes; any byte change fails.

## Inventory and sequence

### 0. Stop conditions

Stop before any remote call when the manifest/gates differ from HEAD, the window/owner is absent, account or plan is unknown, resource inventory differs, a token has broader scope, a domain change is unapproved, a secret appears in output, backups lack isolated restore proof, or any live prerequisite remains blocked.

### 1. Read-only remote inventory (not run)

These commands contact control planes. Use a separate read-only token, canonical locked local Wrangler, an isolated shell, bounded capture, and owner approval even though they should not mutate:

```sh
# REQUIRED BEFORE EACH REMOTE BLOCK — local verification, no network
npm run deploy:candidate:verify -- "$CANDIDATE" --expect "$CANDIDATE_DIGEST"

# READ-ONLY REMOTE INVENTORY — NOT RUN; checked-in placeholder config is forbidden
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" d1 migrations list DB --remote
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" d1 time-travel info DB
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" r2 bucket list
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" r2 bucket cors list <APPROVED_BUCKET>
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" pages project list --json
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" versions list
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" deployments list
```

Also inspect, without changing: Worker `workers.dev` state/routes/bindings; R2 `r2.dev` and custom domains; D1 UUID/migrations/plan; Pages project/production branch/domains; GitHub callback wildcard setting; GitHub App permissions; production-environment reviewers/branch controls/prevent-self-review/plan support; token TTL/IP/resource scopes; account-shared quota use; and DNS/certificate state. Redact account/resource identifiers from broadly visible evidence.

`wrangler tail` is read-only but may expose request data and is lossy; it is **NOT RUN** until security approves operators, filters, capture, and retention.

### 2. Staging and isolated rehearsal

Use separately named non-production resources, identities, OAuth callbacks, buckets, secrets, domains, and evidence. Rehearse the exact immutable commit and tested compatibility date. Apply migrations only to empty/disposable D1, verify all 20 migrations, run remote query plans and D1/R2 integrity/contention tests, prove bucket privacy, and exercise browser/OAuth/Graphify/MCP/Pi. No staging result may be copied into production evidence.

Backup/restore remains **BLOCKED** until an isolated rehearsal proves: export provenance and SHA-256; parsing/import into a disposable database; row/reference counts; full application integrity; every restored immutable object checksum, size, content type, source version/commit and project provenance; pre/post Time Travel bookmark custody; and a documented application-compatible recovery. D1 export can block database requests and has virtual-table and numeric-precision caveats. Time Travel retention is currently 7 days Free/30 days Paid and restore overwrites the target and cancels in-flight work. R2 ordinary buckets have no established WORM guarantee; application create-only keys are not platform Object Lock.

### 3. Production preparation mutations (not run)

Resource creation, secret mutation, R2 CORS/public/custom-domain changes and DNS changes require separate owner procedures and are intentionally listed without executable commands; none is part of candidate rollout. Context Hub requires no R2 CORS/public domain: `OBJECTS` stays private, `r2.dev` disabled and custom domains empty.

```sh
# REQUIRED FIRST — NOT a remote operation
npm run deploy:candidate:verify -- "$CANDIDATE" --expect "$CANDIDATE_DIGEST"

# MUTATION — NOT RUN: secret change creates an unpromoted Worker version
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" versions secret put GITHUB_CLIENT_SECRET
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" versions secret put GITHUB_APP_CLIENT_SECRET
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" versions secret put GITHUB_APP_PRIVATE_KEY

# READ-ONLY DATA EXTRACTION / SERVICE IMPACT — NOT RUN
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" d1 export DB --remote --output=<SECURE_PATH>
```

### 4. Upload and promotion (not run)

The only allowed rollout order is additive/rehearsed D1 migration, Worker upload and promotion plus API verification, then compatible Pages deployment and verification. Never deploy new Pages against the old API.

```sh
# REQUIRED FIRST AND AGAIN BEFORE EACH MUTATION — local, NOT RUN here
npm run deploy:candidate:verify -- "$CANDIDATE" --expect "$CANDIDATE_DIGEST"

# MUTATION — NOT RUN: additive migration from retained candidate migrations
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" d1 migrations apply DB --remote

npm run deploy:candidate:verify -- "$CANDIDATE" --expect "$CANDIDATE_DIGEST"
# MUTATION / UPLOAD — NOT RUN: unpromoted Worker version from retained candidate Worker entry
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" versions upload --message=<CHANGE_ID> --tag=<40_HEX_COMMIT>
# MUTATION / PRODUCTION TRAFFIC — NOT RUN
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" versions deploy
# LIVE API VERIFICATION — NOT RUN
curl --fail-with-body --show-error "<API_ORIGIN>/api/health"

npm run deploy:candidate:verify -- "$CANDIDATE" --expect "$CANDIDATE_DIGEST"
# MUTATION / UPLOAD — NOT RUN: exact retained Pages bytes, never apps/web/dist
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" pages deploy "$CANDIDATE/pages" --project-name=<APPROVED_PROJECT> --branch=main
# LIVE PAGES VERIFICATION — NOT RUN
curl --fail-with-body --show-error "<WEB_ORIGIN>/"
```

Pages has no reviewed dry-run equivalent; the retained exact Pages directory is its no-mutation gate and only upload source. Any failed API check stops before Pages. If a dependency or compatibility check fails after migration, prefer an approved compatible forward fix or traffic stop; do not assume old code can read new schema.

No deployment workflow is checked in. Exact accounts/resources, environment-protection plan, approvals, rate/log policy, recovery proof, and upload/promote ordering are unresolved; generic automation would put secrets next to unsafe mutations. A future manual-only workflow must use `workflow_dispatch` with literal confirmation and immutable SHA, non-cancelling production concurrency, `environment: production`, `contents: read`, full-SHA actions, root/preflight before environment secrets, locked local Wrangler, and separate upload/promote approvals. It must never auto-trigger.

## Permissions and secrets

### Cloudflare tokens

Use separate expiring tokens where practical:

- inventory token: only the exact account/zone read permissions required for listed inventory; add `Workers Tail Read` only to the approved diagnostic operator;
- Worker upload/promote token: `Workers Scripts Write` scoped to one account/service; no DNS/zone write unless the separately approved route operation requires it;
- D1 migration token: `D1 Write` for the exact account and window, held by the data owner only;
- Pages upload token: `Pages Write` for the exact account/project;
- R2 setup token: `Workers R2 Storage Write` only for initial approved bucket policy work, never normal application deploy.

Cloudflare Write/Edit can include create, update, list, and delete. Restrict account/zone, TTL, and source IP where runner egress permits; record the live permission summary because catalog names change. Runtime D1/R2 bindings require no broad API token in application code. Never grant DNS, R2 public-domain/CORS, D1 restore, secret deletion, or resource deletion merely for deploy convenience.

### GitHub production environment

Pre-create and lock the literal `production` environment; require non-self reviewer(s), selected protected `main`, and CODEOWNERS/branch protection for workflows. Verify plan/visibility support: private/internal environment secrets/branches require eligible plans, and reviewer/wait-timer availability varies; a displayed environment alone is not approval proof. Workflow permissions are `contents: read`; no OIDC, issues, pull requests, packages, deployments write, or repository administration is needed by current preparation.

Environment secrets are Cloudflare deploy-token material only if a future approved workflow exists. Worker runtime secret values stay in Cloudflare encrypted secrets. GitHub Graphify secrets remain in its separately protected `context-hub-graphify` boundary and are not production deployment credentials. Anyone able to edit a workflow can target a new unprotected environment, so environment name and workflow changes require owner review.

## Migrations and private data

Migrations are exactly `apps/api/migrations/0001_...sql` through `0020_...sql`, lexically ordered and additive. Never edit an applied migration. Compare local, staging, and read-only production migration inventories before apply. Capture D1 bookmark/export checksum only after the isolated restore procedure is proven. A successful migration command is not proof that old code, R2 references, OAuth, or clients remain compatible.

`DB` is the only D1 binding and must use the approved UUID. `OBJECTS` is the only R2 binding and must use the approved private Standard bucket. No client receives a storage key/direct URL; verify private denial through R2 public URLs/domains without putting credentials in a URL. Code rollback never rolls back D1 rows, schema, R2 payloads, OAuth configuration, DNS, secrets, or provider state.

## Headers, cache, logs and usage

Preflight must reproduce Pages `_headers` exactly from `generatePagesHeaders`: CSP `connect-src 'self' <API_ORIGIN>` and no other connect target; restrictive default/base/object/frame/form/script/style/img policies; permissions denial; no-referrer; nosniff; frame denial; HSTS; and immutable cache only under `/assets/*`. Worker tests require the centralized headers and production HSTS. Verify redirects, errors, preflights, JSON, MCP, downloads, HTML and static assets at the edge.

No new runtime cache, edge rate binding, sampling rate, log sink, metric, alert, or traffic-shedding behavior is approved by this preparation. The manifest requires an approved observability-policy reference before it can pass. Workers Logs sampling must be deliberate (an unspecified rate defaults to 1); tail can drop messages and is not an audit trail. Application/platform logs must exclude Authorization, Cookie/Set-Cookie, OAuth code/state, request bodies, source queries/excerpts, object keys/content, provider payloads, secret references/values, and private identifiers not explicitly allowlisted. Validate 429/error sampling and retention without using rate limiting for quotas, billing, uniqueness, or authorization; Cloudflare rate limiting is local/eventually consistent and may permit bursts.

Check the current free-tier thresholds and account-shared use from [`free-tier-audit.md`](free-tier-audit.md): Worker requests/CPU/exceeded limits, D1 rows read/written/storage/query plans, R2 Standard storage and Class A/B/orphans, Pages builds/assets/Functions (expected zero), Actions minutes/storage/log retention, and representative Graphify runtime. Thresholds in that report are signals, not approved launch policy.

## Live verification checklist

All are **NOT RUN / BLOCKED** until upload and explicit traffic approval:

1. DNS/TLS and exact canonical origins; unintended `workers.dev`, Pages preview, R2 `r2.dev`, custom domain and CORS exposure absent.
2. `GET API_ORIGIN/api/health` returns bounded dependency readiness with no ID/secret; a 2xx alone is insufficient.
3. Unauthenticated, outsider, workspace-only, Viewer, Editor and Admin checks prove authenticate -> project resolve -> direct membership -> role -> execute, nonleaking 404/403, Origin enforcement and secure cookies.
4. D1 migration/table/index/trigger/FK inventory and representative remote query plans match the candidate; R2 objects remain private and authorized reads revalidate HEAD/bytes/checksum/provenance.
5. Browser desktop/mobile, keyboard/focus/labels, screen-reader, responsive, dark/reduced-motion and automated/manual accessibility pass.
6. Identity OAuth and GitHub App exact setup/callback, state/PKCE, installation proof, suspension/revocation, rate/error behavior and credential rotation pass with redacted logs.
7. Real protected Graphify workflow and bounded runner publish exact commit provenance; MCP six-tool client, sync, Pi/TUI and OS-secret helper pass revocation, bounds and output secrecy.
8. Snapshot/artifact/graph corruption, immutable replay, authorization races, D1/R2 contention and failed-update cache preservation pass without exposing keys/content.
9. Workers Logs/tail/redaction sampling, rate/429 behavior, account-shared usage, CPU/subrequests/rows/storage/build minutes and alerts match approved policy.
10. Record immutable release evidence, rotate canary/test credentials, then make an explicit go/no-go. Do not collect Phase 27 product metrics in Phase 26.

## Release evidence

Retain access-controlled, checksummed evidence with UTC timestamps and collector/approver: manifest digest and immutable commit; clean status; Node/npm/Wrangler/action/lock versions; root/audit/preflight receipts; inventory-before/after diff; token permission summaries (never tokens); resource/deployment/version IDs; compatibility date; migration list/bookmark and approved export checksum; generated config digest; Worker bundle/Pages asset/header digests; DNS/TLS/origin results; browser/OAuth/private-object/Graphify/MCP/Pi results; redacted log/rate/usage results; approvals; incident/rollback selection; and credential rotation confirmation. Preserve source/version/commit/checksum/project provenance. `docs/ai/deployment-evidence.md` records only current repository preparation and must not be overwritten with fabricated live PASS rows.

## Incident decision tree

1. Secret/token suspected exposed: stop promotion, revoke/rotate at the owning provider, preserve redacted audit evidence, invalidate affected application credentials, and investigate before any redeploy. Never restore an old credential.
2. Authorization/private-object/origin bypass: remove traffic through an approved route action or promote a known safe compatible version; preserve D1/R2; security owner decides notification. Do not delete objects to hide exposure.
3. Availability/code defect before schema mutation: choose an approved forward fix or Worker/Pages code rollback after binding compatibility checks.
4. Defect after D1 migration or writes: stop mutations/traffic, assess schema and data compatibility, and prefer an approved forward fix. Code rollback is not database rollback.
5. R2 integrity/reference mismatch: stop writes, retain every uncertain object, compare D1 references and immutable checksum/provenance, and escalate; no prefix delete or overwrite.
6. Usage/limit exhaustion: execute only the approved traffic-shedding plan, preserving authentication/authorization/integrity and local offline use. Do not invent a cache or rate policy during incident response.

## Rollback decision tree

- **Code only, compatible external state:** select an exact previously verified Worker version or successful Pages production deployment and obtain incident/release approval.
- **Binding/route incompatibility:** repair/forward-promote exact compatible config; rollback can fail if referenced resources were deleted. A split Worker rollback promotes one target to 100%.
- **Schema/data changed:** do not promote old code until compatibility is proven. Use an approved forward migration/fix or stop traffic.
- **D1 recovery required:** remains **BLOCKED** unless the isolated rehearsal and checksum/provenance proof exists. Time Travel restore is **DESTRUCTIVE**, overwrites live state and cancels in-flight work:

```sh
# DESTRUCTIVE — NOT RUN
npm run deploy:candidate:verify -- "$CANDIDATE" --expect "$CANDIDATE_DIGEST"
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" d1 time-travel restore DB --bookmark=<APPROVED_BOOKMARK>
```

- **R2 recovery required:** there is no general rollback command and no proven WORM control. Reconcile immutable objects and D1 references through approved incident tooling; never overwrite or broad-delete.
- **Worker rollback:**

```sh
# INCIDENT MUTATION / PRODUCTION TRAFFIC — NOT RUN
npm run deploy:candidate:verify -- "$CANDIDATE" --expect "$CANDIDATE_DIGEST"
./node_modules/.bin/wrangler --config "$CANDIDATE/wrangler.toml" rollback <APPROVED_VERSION_ID>
```

Worker/Pages rollback does not restore D1/R2, GitHub configuration, secrets, DNS, external clients, or in-flight effects. Capture post-action health, authorization, integrity and redaction evidence before reopening traffic.

## Official references and caveats

These first-party sources were accessed **2026-09-15 UTC** and must be reopened immediately before execution because commands, permissions, plans, pricing and limits change:

- Cloudflare: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [environments](https://developers.cloudflare.com/workers/wrangler/environments/), [compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/), [routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [bundling](https://developers.cloudflare.com/workers/wrangler/bundling/), [commands](https://developers.cloudflare.com/workers/wrangler/commands/), [versions/deployments](https://developers.cloudflare.com/workers/versions-and-deployments/), [deployment management](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/), and [rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
- D1: [Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/), [migrations](https://developers.cloudflare.com/d1/reference/migrations/), [import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), and [limits](https://developers.cloudflare.com/d1/platform/limits/). The Time Travel overview's generic 30-day wording conflicts with plan-specific 7-day Free/30-day Paid detail; use plan-specific current evidence.
- R2: [bucket creation](https://developers.cloudflare.com/r2/buckets/create-buckets/), [Worker bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/), [CORS](https://developers.cloudflare.com/r2/buckets/cors/), [public buckets/domains](https://developers.cloudflare.com/r2/buckets/public-buckets/), [API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [limits](https://developers.cloudflare.com/r2/platform/limits/), and [pricing](https://developers.cloudflare.com/r2/pricing/). No current first-party R2 Object Lock/WORM page was found; an anticipated URL returned 404, so no platform immutability claim is made.
- Variables/secrets/frontend: [Worker variables](https://developers.cloudflare.com/workers/configuration/environment-variables/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Pages bindings/variables/secrets](https://developers.cloudflare.com/pages/functions/bindings/), and [Vite environment variables](https://vite.dev/guide/env-and-mode).
- Pages: [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/), [build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/), [custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/), [rollback](https://developers.cloudflare.com/pages/configuration/rollbacks/), and [Wrangler configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/). Pages rollback covers prior successful production deployments, not previews or backing state.
- Operations: [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/), [Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/), and [Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). No fetched first-party passage proved query-string redaction covers Live logs/tail; application-side minimization is mandatory.
- GitHub: [create OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app), [authorize OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [environments](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment), [deployment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions), [`GITHUB_TOKEN`](https://docs.github.com/actions/reference/authentication-in-a-workflow), and [secure use](https://docs.github.com/en/actions/reference/security-for-github-actions/security-hardening-for-github-actions).
- Cloudflare token ownership: [create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), [permission catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), and [GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/). Current UI may say Write where older material says Edit; record the live catalog summary.

Community posts, blogs, videos, Stack Overflow and vendor comparisons are not authority where these first-party sources exist.

## Launch profiles

The manifest has an explicit `profile`: `CUSTOM_DOMAIN` preserves the existing strict production contract (`workersDev=false`, exact custom-domain route, no previews). `FREE_PILOT` is the only permitted zero-purchase pilot alternative. It requires `workersDev=true`, `customDomain=false`, an API origin exactly equal to `https://<worker name>.<workersDevSubdomain>.workers.dev`, and a Pages origin exactly equal to `https://<pages project>.pages.dev`. Both profiles retain exact callbacks/origins, disabled Pages/Worker previews, and private R2 with disabled `r2.dev`, no custom domains, and no CORS. The runtime rejects suffix confusion, placeholder/reserved names, and cross-profile combinations before candidate generation.

`FREE_PILOT` adds `PILOT_GITHUB_USER_ID_HASHES` to the encrypted Worker-secret contract. Set it only to one through 100 comma-separated lowercase SHA-256 values of `github:<stable GitHub user ID>`. It is never placed in the manifest, generated vars, receipts, or documentation examples. In production FREE_PILOT, a missing or malformed value fails closed and an unlisted identity receives a nonrevealing OAuth failure; every session is rechecked on every authenticated request.

The canonical Graphify workflow uses the exact GitHub-hosted `ubuntu-24.04` runner for this public repository. Oracle Free Tier self-hosting is only an optional future fallback requiring a separate runner/isolation decision and evidence; it is not the current runtime.

The profile requires no purchase, but no architecture can guarantee $0 under abusive/unbounded traffic, provider changes, or shared account consumption. Allowlisting and monitoring reduce exposure; they are not billing proofs. All live deployment, quota, and host evidence remains not run.
