# Free-tier audit

Last updated: 2026-09-15

Status: **COMPLETE LOCALLY AFTER ONE INDEPENDENT REVIEW, ONE CONSOLIDATED FOUR-P1 CORRECTION, AND THE 340-TEST ROOT PHASE GATE.** This is a repository audit, not a zero-cost guarantee. Production Cloudflare/GitHub usage, account plans and shared workloads, remote D1 query plans, and a representative Graphify benchmark remain external blockers.

## Scope and method

This audit covers the checked-in Worker, Pages build, D1 migrations and query shapes, immutable R2 lifecycle, GitHub Actions workflows, browser behavior, local sync, MCP, and Pi from checkpoint `5682644`. It does not perform deployment, full E2E, product-metrics, or final-QA work and does not introduce paid infrastructure. Phase 27 later consumes these source-derived limits in [`metrics.md`](metrics.md) but does not reinterpret them as live Worker/D1/R2/Actions usage; the required provider receipts below remain blocked.

The reproducible command is:

```sh
npm run audit:free-tier
```

It builds the actual Worker and web app, gzips the emitted Worker with Node's standard library, inventories Pages output, applies every migration to a fresh Wrangler-local D1 database, reads SQLite page/schema counts and representative `EXPLAIN QUERY PLAN` output, parses workflow controls and application constants, checks production sources for interval polling, and calculates selected worst-case operation models. The audit script is dependency-free JavaScript at [`scripts/free-tier-audit.mjs`](../../scripts/free-tier-audit.mjs); it uses the already-required Wrangler executable and Python's standard-library SQLite module for local schema inspection. Its source-only assertions run in normal API tests.

Evidence is deliberately separated:

- **Measured locally:** emitted bytes/files, empty migrated local DB bytes/pages/tables/indexes, local SQLite query plans, source/workflow structure.
- **Calculated worst case:** requests, D1 statements, and R2 operations derived from checked-in route limits and control flow. These are conservative source models, not platform billing telemetry.
- **Unknown until deployed:** Worker request/CPU/memory/subrequest distributions, D1 rows read/written and remote optimizer plans, R2 daily-peak storage/Class A/Class B operations/orphans, Pages builds, cache hit/miss behavior at the edge, Actions billed minutes/storage, and all account-shared use.

Local SQLite can show that a representative query shape selects a checked-in index. It cannot prove the remote D1 optimizer, production data distribution, actual rows scanned, or billed rows read. Accordingly, this document does not translate local returned-row counts into remote `rows_read` claims.

## Current official limits

All limits in this section were accessed from first-party documentation on **2026-09-14 UTC**. Platform quotas and pricing are volatile and may change without repository changes or a guaranteed notice period. Recheck the linked pages at least quarterly and before launch. These values document present planning headroom; they are not permanent application authorization rules.

### Cloudflare Workers

Source: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

- Workers Free currently provides 100,000 requests per account per day, resetting at 00:00 UTC. Exhaustion can return Error 1027; a fail-open route can bypass the Worker and is inappropriate for this private API.
- Free HTTP requests and Cron invocations have a 10 ms CPU limit. Network/database wait is excluded; occasional CPU overage may pass, but consistently excessive work is terminated. Memory is 128 MB per isolate and startup is limited to one second.
- Each invocation permits 50 external subrequests, 1,000 Cloudflare-service subrequests, six simultaneous outbound connections waiting for headers, and 50 D1 queries on Free. Redirect-chain requests count as subrequests.
- A Worker on the Free plan has a 3 MiB compressed script-upload ceiling. Cloudflare's 64 MiB uncompressed bundle ceiling is a distinct upload/tooling constraint, not the Free-plan script allowance. Deployment limits also include 100 Workers/account, five Cron Triggers/account, 20,000 static assets/version, and 25 MiB/static asset. There is no checked-in Cron trigger.
- Free-zone inbound request bodies can be 100 MB, but that is a zone-plan limit, not a safe application allowance. Context Hub retains much lower route-specific body limits. URL and request/response header limits are 16 KB and 128 KB respectively.

The 10 ms CPU ceiling is the tightest unresolved Worker risk. Local Node timing is not equivalent to Workers CPU accounting. Full validation/hashing of an 8 MiB graph and multi-object snapshot integrity must be measured using deployed Workers Analytics before production suitability can be claimed.

### Cloudflare Pages

Sources: [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) and [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/).

- Pages Free currently allows 500 builds/month, one concurrent build/account, 20-minute build timeout, 20,000 files/site, 25 MiB/file, 100 projects/account, 100 custom domains/project, and unlimited preview deployments.
- Static asset requests are documented as free and unlimited. This is not a contractual byte-transfer or abuse-exempt SLA.
- Pages Functions share the Workers Free 100,000-request/day pool. Context Hub's Vite output contains static files and no Pages Functions, so normal static requests do not consume Worker requests.

### Cloudflare D1

Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [free-tier enforcement notice](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/), and [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

- D1 Free currently allows 10 databases, 500 MB/database, 5 GB/account, 5 million rows read/day, and 100,000 rows written/day. Daily row pools reset at 00:00 UTC and queries fail after exhaustion.
- Rows read means rows scanned, not rows returned. Index maintenance contributes row writes; DDL can consume reads and writes. Tables, indexes, and triggers all consume storage.
- A Free Worker invocation permits 50 D1 queries. SQL query/batch duration is 30 seconds, simultaneous D1 connections are six, parameters are capped at 100/query, SQL text at 100 KB, and a string/BLOB/table row at 2,000,000 bytes.
- D1 publishes no separate aggregate query-result byte/row limit. Result serialization still shares the Worker memory and CPU boundary, so application pagination remains mandatory.
- Time Travel is always on and free, with a current seven-day Free recovery window and at most 10 restores per 10 minutes per database. Restore is destructive to current state and cancels in-flight queries. The older D1 backup page conflicts with current Time Travel documentation; no legacy backup command is treated as a release control.

### Cloudflare R2

Sources: [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [R2 limits](https://developers.cloudflare.com/r2/platform/limits/).

- R2 Standard currently includes 10 GB-month storage, 1 million Class A operations/month, 10 million Class B operations/month, and free direct egress.
- Storage billing uses the average of each day's peak. Class A includes writes, multipart operations, copies, and listings. Class B includes reads and heads. Deletes/aborts are free.
- Direct Workers/S3/`r2.dev` egress is free, but an attached metered service can still charge. Infrequent Access has no equivalent free quantities in the pricing examples, retrieval charges, and a 30-day minimum; Context Hub assumes Standard.
- R2 object/account maxima are far above application bounds, but Worker request bodies and subrequests remain controlling limits. Same-key writes are limited to one/second; Context Hub uses server-generated create-only immutable keys.

### GitHub Actions

Sources: [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [included usage](https://docs.github.com/en/billing/reference/product-usage-included), [Actions limits](https://docs.github.com/en/actions/reference/limits), [artifact retention](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/removing-workflow-artifacts), [Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository), and [Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions).

- Standard GitHub-hosted runners are free for public repositories. Private repositories owned by GitHub Free users/organizations currently include 2,000 minutes/month and 500 MB artifact/Packages shared storage; cache has a separate 10 GB/repository allowance.
- Self-hosted runners have no GitHub compute-minute charge, but hardware, electricity, network, maintenance, availability, and security are external costs. Larger runners are charged even for public repositories.
- GitHub-hosted jobs max at six hours; self-hosted jobs max at five days and queue for at most 24 hours. `GITHUB_TOKEN` expires after 24 hours, constraining long self-hosted jobs.
- Default artifact/log retention is 90 days. Public repositories can configure 1-90 days and private repositories 1-400 days. Context Hub workflows upload no Actions artifacts, so no per-artifact retention setting applies; logs retain according to repository settings.
- Included execution is subject to fair-use/project-related restrictions. Actions must not become a CDN, serverless app, resale service, unauthorized-access mechanism, or workload disproportionate to repository benefit.

## Measured repository consumption

Results from `npm run audit:free-tier` on 2026-09-14:

| Dimension | Measured result | Current official ceiling | Repository headroom |
| --- | ---: | ---: | ---: |
| Worker emitted module, local gzip level 9 | 74,698 bytes | 3,145,728 compressed bytes (Free) | 97.63% |
| Wrangler upload, gzip | 75,100 bytes (73.34 KiB) | 3,145,728 compressed bytes (Free) | 97.61% |
| Worker emitted module, uncompressed | 373,291 bytes | 67,108,864 uncompressed bytes (tooling) | 99.44% |
| Pages files | 5 | 20,000 | 99.98% |
| Pages total output | 131,260 bytes | No aggregate published | N/A |
| Largest Pages asset | 99,813 bytes | 26,214,400 bytes | 99.62% |
| Fresh migrated D1 file | 847,872 bytes | 524,288,000 bytes/database | 99.84% |
| D1 schema | 40 application/domain tables, 62 explicit/non-auto indexes (plus Wrangler `_cf_METADATA` and migration ledger `d1_migrations`) | No table/index-count quota published | N/A |
| Project-first indexes | 34 local schema indexes whose SQL starts with/includes `project_id` | Shape evidence only | N/A |
| Migrations | 20 ordered migrations | Storage/write usage applies | N/A |

Wrangler's own dry-run reported 364.54 KiB total upload / 73.34 KiB gzip during the same run. The script's exact module/gzip counts differ slightly because Wrangler's upload reporting includes its own packaging/accounting and gzip settings. The Wrangler gzip result is the decisive Free-plan comparison; the local gzip result is a reproducible cross-check, while the emitted uncompressed size is compared separately with the 64 MiB tooling ceiling.

Representative fresh-schema local SQLite plans selected:

- `artifacts_project_status_created_idx` for active artifact pagination.
- `context_snapshots_project_created_idx` for snapshot pagination.
- `project_audit_events_project_time_idx` for project Activity.
- `graph_versions_project_status_version_idx` for current READY graph selection.
- `sync_states_project_seen` for project sync selection, with a temporary B-tree for the final two order terms. This is bounded by at most 20 retained clients per principal/project and does not demonstrate a missing index worth another write/storage cost.
- Exported production builders for the 20-project Context artifact query and 20-reference snapshot artifact query; local SQLite selects the project/status or artifact/project indexes and uses bounded temporary ordering.

No new D1 index is added: representative high-frequency project filters use project-first indexes, and the only observed temporary sort is bounded. Remote D1 plans and production row distributions remain required evidence.

## Request and operation budgets

Every HTTP call is one Worker request. D1 statements/batch members and R2 operations additionally consume service/binding and product quotas. Counts below include route authentication/membership where it is structurally part of the request; provider HTTP calls are called out separately. Error/compensation paths can add narrow audit/recheck operations, but remain bounded.

### High-cost calculated paths

Let `A` be artifact references, `S` snapshots on a list page, and `P` explicitly selected projects.

| Path | Bound | D1 query/subrequest model | R2 model | Main cost/risk |
| --- | --- | --- | --- | --- |
| Snapshot create | `A <= 20`, body 32 KiB, manifest 64 KiB | Normal routed max is 28: authentication, membership, idempotency, graph, one bounded project-scoped artifact query, D1 time, and an `A+2` batch; tested collision/ambiguity/failure/concurrent recovery paths stay below query 51 | <=45: graph HEAD/GET, `A` artifact HEAD/GET, manifest create/HEAD/GET | Fixed from prior theoretical >50 D1 statements at 100 refs; integrity unchanged |
| Snapshot inspect/retrieve | One snapshot, `A <= 20` | <=5: membership, snapshot, captured refs, sealed graph, one joined current-reference query | `4 + 2A <= 44`: graph, artifacts, manifest HEAD/GET | Full checksum/schema/canonical integrity intentionally retained |
| Snapshot list | `S <= 4`, each `A <= 20` | `2 + 3S <= 14` | `S(4 + 2A) <= 176`; combined service-binding upper bound 190 | Fixed prior 100x100 integrity multiplication and per-artifact D1 N+1 |
| Context search, one project | 15 artifact candidates plus at most one graph source, graph <=512 KiB, 64 KiB response, 80 sources | Conservative whole-request model <=43 D1 including auth and every pre-object recheck | <=32 R2 for 16 source objects | Reduced from a confirmed >50 D1 path; 10 ms CPU and actual candidate hit rate remain unknown |
| Context search, 20 projects | `P <= 20`, three caller-wide metadata queries, caller-wide eight artifact/eight graph source objects, 64 KiB response | Human route observes 41 D1; repository-bound MCP is 46 from its measured seven-query transport plus the 39-query engine; artifact metadata reaches exactly 100 parameters with 32 search terms | <=32 R2 under one 16-object caller-wide allocation | Preserves complete-set authorization and 1/10/20 scope without per-project multiplication |
| MCP request | 16 KiB request, 128 KiB response, `P <= 20`, 120/minute/credential | Auth/nonce/rate/audit plus selected tool; search delegates to context bound | Delegated tool model; artifact/graph use HEAD+GET | D1 nonce/audit writes per call make sustained 120/min incompatible with account-wide free usage |
| Graph explorer | One selected graph <=8 MiB; <=25 results; path <=8; visits <=5,000 nodes/20,000 links | Membership + graph metadata | One HEAD + one GET | Worker CPU/memory is the blocker, not request count |
| Graph reserve/build | One complete build identity; one active attempt lifecycle | Bounded reservation/claim/publish transitions and trigger-derived audit | One create-only graph write plus verification HEAD/GET; ambiguous publish retries <=3 exact replays | Heavy generation is outside Worker; orphan retention is conservative |
| Artifact create/version | Content <=1 MiB, JSON request <=6 MiB+64 KiB | Bounded membership/current-version/publication batch | One create-only PUT; recovery HEAD; authorized read GET | Identical bytes intentionally remain separate immutable versions/provenance |
| Artifact list/history | Page <=100 | One indexed page query after membership | None until content detail/read | Cursor bounded |
| Activity, project/global | Page <=50, 30-day default/90-day max | One indexed event query after auth; global query joins current authorized scope | None | Indefinite 100,000/project event cap creates long-term D1 write/storage risk |
| Global Settings | At most 100 authorized projects | Session query + one bounded joined project/configuration query | None | Correlated latest graph/sync reads need deployed rows-read evidence |
| Sync metadata/download | One project/current selected graph <=8 MiB | Membership + verified repository/current graph | Download uses graph HEAD/GET | CLI performs explicit commands only and keeps valid local cache |
| Sync-state write/read | One client report; <=20 clients per principal/project; read page bounded | One authorization-conditioned upsert or bounded indexed read | None | Best-effort report failure never retries in a loop |

The script fails if the modeled snapshot-create D1 count exceeds 50 or snapshot-list service binding count exceeds 1,000. The new 20-reference cap is justified by the current hard D1-per-invocation execution boundary, not used as an authorization control. If Cloudflare changes the quota, increasing the product bound still requires renewed CPU/memory/R2 evidence rather than automatic relaxation.

### Other route families

- Health uses one D1 scalar query and one R2 HEAD. Do not use it as a high-frequency public monitor without deployed request budgets.
- OAuth/session/workspace/project/team/Git/credential routes use bounded point/index queries and fixed batches. GitHub OAuth/App operations can make bounded external calls; live provider rate/latency telemetry is unknown.
- Team lists cap members and pending invitations at 100. Invitation inbox and credential lists are cursor/fixed bounded.
- Graph metadata history returns at most 50 rows and no payload. Graph latest/detail/query verifies one selected private payload.
- Artifact default/current/history lists cap at 100; graph query results cap at 25; Activity caps at 50; global Settings caps projects at 100.

No static route has a theoretical service-subrequest count above 1,000 or D1 query count above 50 after the snapshot fixes. This is a source-control-flow assertion, not proof against platform retries, future route edits, or hidden provider behavior.

## Polling, retries, builds, caching, and uploads

### Confirmed controls

- Production source contains zero `setInterval` calls. Browser status refresh is navigation-, mutation-, or user-action-driven. One `setTimeout` performs a single 900 ms Team conflict refresh; it does not reschedule itself.
- CLI sync/status and Pi commands run on explicit invocation. Offline graph reads use the verified local cache and make no request. There is no background sync daemon or automatic polling.
- CI runs only for pull requests and pushes to `main`, now has a 20-minute job timeout, and cancels superseded runs for the same workflow/ref. No Actions artifact is uploaded.
- Graphify is manual `workflow_dispatch`, has a 30-minute timeout, and is serialized per project. `cancel-in-progress: false` is mandatory because cancellation after object-first publication could strand lifecycle state. It uses the exact GitHub-hosted `ubuntu-24.04` runner; standard hosted minutes are currently free for public repositories, subject to GitHub terms and fair use.
- Complete graph build identity uniqueness prevents rebuilding the same repository identity/commit/toolchain/profile. The machine publisher retries only ambiguous publication, at most three attempts, with exact immutable identity and create-only recovery; definite rejection is not retried.
- R2 keys are server-generated and create-only. Artifact, graph, and snapshot reads verify D1 metadata, R2 metadata, bytes, size, and SHA-256. No direct client R2 upload exists.
- Context retrieval has no remote cache, eliminating authorization-cache contamination but causing a cache miss on every online search. This is an explicit correctness-first tradeoff pending deployed demand evidence.

### Duplicate content and lifecycle findings

- **Graph content:** unchanged complete build identity is deduplicated before generation. Same-attempt ambiguous publication reuses/verifies the exact key; cross-attempt adoption is forbidden.
- **Artifact content:** publishing identical bytes as a new version creates another immutable version/key. Deduplicating across logical versions would complicate upload ownership, compensation, retention, and provenance, so no speculative content-addressed rewrite is made. Monitor duplicate checksum bytes and revisit only with measured pressure and an accepted lifecycle design.
- **Snapshots:** reference existing graph/artifact payloads and store only one <=64 KiB canonical manifest, so they do not copy source payloads.
- **Orphans:** uncertain artifact/snapshot publication and failed graph attempts intentionally prefer retained bytes over unsafe deletion. Exact graph cleanup exists after grace; artifact/snapshot orphan sweeping and storage retention policy are open because a broad lifecycle rule could delete referenced immutable data.
- **Cache misses:** Pages assets may use Cloudflare's static delivery, but no application cache header/hit telemetry was measured. Private Worker payloads are verified per request; snapshot manifest download is `private, immutable`. No claim of edge cache savings is made.

## Workflow capacity models

| Workflow | Trigger/concurrency | Hard repository control | Included-use model |
| --- | --- | --- | --- |
| Quality CI | PR + push to `main`; cancel superseded same ref | 20-minute timeout, one quality job, no matrix, no uploaded artifact, pinned actions, read-only token | Private worst case: 20 billed minutes/run; 100 full-timeout runs/month would consume 2,000 included minutes. Public standard runner minutes are currently free. Actual visibility/plan/run duration unknown. |
| Graphify publication | Manual dispatch; one non-cancelled run/project at a time | 30-minute timeout, one job, exact GitHub-hosted ubuntu-24.04 runner, no Actions artifact | Public-repository standard GitHub-hosted minutes are currently free; Oracle Free Tier self-hosting is only an optional later fallback. Representative runtime/disk/memory/network remains unmeasured. |

Path filters are not added to quality CI: documentation, migrations, workflow security, and package-boundary changes are all gate-relevant, so a repository-wide skip could hide correctness regressions. Graphify has no push/PR trigger to filter. Least retention is achieved by uploading no workflow artifact; repository log retention remains an external setting.

## Risk and headroom

| Risk | Repository position | Threshold/headroom interpretation | Status |
| --- | --- | --- | --- |
| Worker compressed upload/assets | Worker gzip uses 2.30% of the Free ceiling; Pages uses five of 20,000 files | 97.70% compressed-upload headroom; large asset-count headroom | Low, measured |
| Worker requests/day | Organic/account-shared traffic unknown | Alert at 70k, page at 85k, shed optional work before 95k of current 100k/day | External blocker |
| Worker 10 ms CPU/128 MB | Graph/snapshot/context hashing/validation unmeasured remotely | Use p95/p99 CPU and exceeded-limit analytics; any sustained approach to 7/8.5/9.5 ms is actionable | High external blocker |
| D1 rows read/day | Indexed/bounded shapes, remote scans unknown | 3.5M/4.25M/4.75M current daily thresholds | High external blocker |
| D1 rows written/day | MCP nonces/audits and immutable events amplify calls | 70k/85k/95k current daily thresholds | High under sustained MCP traffic |
| D1 DB storage | Fresh schema 0.81 MiB; production rows unknown | 350/425/475 MiB per current 500 MiB DB | Medium external |
| D1 statements/invocation | Snapshot normal create <=28 and recovery paths are fail-at-51 tested; Context engine is 39 before transport | The snapshot production-route wrapper and Context authorization-fence wrapper reject query 51 and parameter 101 | Fixed locally; deployed retries remain unknown |
| R2 service subrequests | Snapshot list corrected to <=190 combined operations | Below current 1,000; CPU likely controls first | Fixed locally |
| R2 storage | Immutable payload/orphan inventory unknown | 7/8.5/9.5 GB-month current allowance thresholds | High external |
| R2 Class A/B | Bounded per route, traffic unknown | 700k/850k/950k A and 7M/8.5M/9.5M B monthly | External blocker |
| Pages builds | CI does not deploy Pages; external hooks unknown | 350/425/475 current builds/month | External blocker |
| Actions minutes/storage | Visibility/plan and actual runtime unknown; no artifacts | Private Free: 1,400/1,700/1,900 minutes; repository logs/settings separate | External blocker |
| Graphify runtime | 30-minute cap, serial/project, no benchmark | Benchmark representative and largest approved repository before launch | High external blocker |
| R2 orphan growth | Safety-first retention, no complete inventory/sweeper | Alert on count/age/bytes; no safe numeric quota can be derived locally | Open lifecycle risk |
| Audit-event growth | Immutable cap 100,000/project; no retention policy | Alert at 70k/85k/95k rows/project | Open product/retention decision |

Thresholds are operational signals, not guarantees or billing promises. At 70%, investigate trend and ownership; at 85%, freeze optional high-cost operations and prepare traffic shedding; at 95%, disable optional graph reservations/search/reporting as safely configured at the edge while preserving authentication, authorization, integrity reads, and local/offline use. Exact shutdown behavior requires deployment operations work and is not encoded in this phase.

## Required deployed evidence

Collect all of the following for the same UTC day/billing month and record account scope:

1. Workers Analytics export by route/status: requests, CPU time distribution, wall time, memory/exceeded-limit errors, external/service subrequests, and Error 1027 behavior; verify no fail-open API route.
2. D1 dashboard/API usage: database size, daily rows read/written, query count/latency/failures, and remote `EXPLAIN QUERY PLAN`/query insights for artifact, graph, snapshot, Activity, Settings, sync, MCP, and one-/twenty-project context shapes against representative cardinalities.
3. R2 usage/inventory: Standard storage daily peak, object count/bytes by artifacts/graphs/snapshots, Class A/B totals, direct egress path, incomplete/failed-attempt object count/age/bytes, compensation outcomes, and duplicate artifact checksums/bytes.
4. Pages analytics/build history: project count, builds/month, duration, concurrent queue/cancellations, deployed file count/max file, Functions invocation count (expected zero), and actual cache status for static assets.
5. GitHub billing/usage: owner plan, repository visibility, included/used hosted minutes, artifact/Packages storage, cache storage, log retention, budget stop-overage setting, workflow run count/duration/cancellations, and confirmation that the Graphify runner is GitHub-hosted Ubuntu and public-repository usage remains eligible.
6. One representative plus one largest-approved Graphify run: checkout/install/build/validation/publication duration, CPU, memory, bounded-volume peak disk, graph bytes/nodes/links, network, retries, and D1/R2 operations. Confirm complete-build dedup on a repeat dispatch.
7. Account-shared inventory for every other Worker, Pages Function/project, D1 database, R2 bucket, and Actions repository charged to the same owner. Repository-local traffic alone cannot establish headroom.

## Findings ledger

### Fixed locally

- Snapshot creation previously permitted 100 references, producing a theoretical success batch/path above D1's 50-query-per-Free-invocation limit. It now permits 20 and remains fully authorized, immutable, checksummed, and provenance-sealed.
- Snapshot creation and later integrity checks previously performed one D1 metadata query per captured artifact. One bounded project-scoped create query and one project/snapshot-predicated integrity join now obtain immutable rows while every referenced R2 object is still independently HEAD/GET/checksum verified.
- Snapshot listing previously allowed 100 fully verified snapshots, each with up to 100 artifacts, creating a theoretical service-subrequest explosion. Pages now contain at most four snapshots, each with at most 20 references.
- Context retrieval previously multiplied three metadata query families and authorization checks per project and allowed enough object reads for both single- and 20-project requests to exceed D1's 50-query boundary. Cross-project Git/artifact/graph metadata now uses three complete-set-fenced caller-wide queries; source objects are caller-wide capped at 16, with an immediate authorization recheck before every HEAD and GET. Single-project candidates are capped at 15 artifacts plus one graph.
- Query-count regression executes the real 20-project human `createApp` route, the real repository-bound MCP transport, and both production authorization fences; proves exactly 16 HEAD/GET pairs, fails at query 51, and rejects parameter 101 while retaining canonical scope, deterministic allocation, provenance, global ranking, bounded corruption reporting, and zero cache state. The MCP artifact metadata path reaches exactly the current 100-parameter limit only with the maximum 32 unique search terms and 20 projects.
- Quality CI now has a 20-minute timeout and same-ref cancellation. Graphify concurrency is now per project rather than per project/version while retaining non-cancellation across irreversible publication.
- Executable audit/test evidence now fails on interval polling, missing workflow timeouts, snapshot D1 >50, snapshot service-binding >1,000, lost graph identity dedup, or weakened joined integrity retrieval.

### Open repository/design findings

- Worker CPU suitability for 8 MiB graph validation and multi-payload integrity is unknown and potentially incompatible with 10 ms Free CPU.
- Artifact/snapshot orphan retention and indefinite audit history can grow without a safe deletion policy. Safety and provenance take priority over speculative cleanup.
- Identical artifact content across versions is duplicated in R2 by design. No safe content-address/ownership/compensation change is approved from repository evidence alone.
- Context has no shared cache; every online search rereads verified sources. Add no cache until deployed hit-rate/cost evidence and authorization-safe complete-scope namespacing justify it.
- MCP's 120 request/minute security cap is not a free-tier budget. Sustained use can exceed D1 daily writes through nonce/audit records well before the per-credential rate limit.
- Account deletion/privacy retention, backup/restore, production edge rate limits/logging, and metric retention remain release blockers owned by later operational phases.

### External blockers

- Current Cloudflare account plan/shared usage, GitHub owner plan/repository visibility/billing settings, remote D1 plans and rows scanned, actual R2 usage/inventory, Pages build history, and Actions usage are unavailable locally.
- Production resources/origins remain placeholders. No deployed Worker/D1/R2/Pages measurement is claimed.
- Representative Graphify runtime/resource publication benchmark remains unavailable.
- The current official quotas can change; quarterly verification and pre-release recheck remain mandatory.

## No-cost assumptions

The architecture requires no paid component only under these explicit assumptions:

- Cloudflare Workers/Pages/D1/R2 remain on currently documented Free tiers and all account-shared usage remains under their pools.
- Pages stays static with no Functions; D1 remains one metadata database; R2 remains private Standard storage; Graphify never runs in the Worker.
- The quality repository is public for free standard hosted minutes **or** private hosted use remains under the owner's included allowance with overage stopped. Graphify continues on operator-provided self-hosted capacity whose real-world costs are accepted outside GitHub billing.
- Traffic is modest, clients do not poll, MCP use is bounded well below its abuse ceiling, graph builds are manually/event driven and complete-identity deduplicated, and immutable storage growth is monitored.
- Production alerts and budget stop controls are configured externally. Source code cannot prevent other account workloads, dashboard/API writes, provider policy changes, or organic traffic from exhausting shared quotas.

Therefore the correct conclusion is **free-tier-compatible by bounded architecture, not proven zero-cost in deployment**.

## Private-pilot profile update

The public source repository's canonical Graphify workflow now uses exact GitHub-hosted `ubuntu-24.04`, whose standard runner minutes are currently free for public repositories. Oracle Free Tier self-hosting is documented only as a later optional fallback, not the pilot runtime. `FREE_PILOT` constrains entry to an encrypted bounded GitHub stable-ID hash allowlist and exact assigned `pages.dev`/`workers.dev` hosts. These controls reduce accidental and abusive use but cannot mathematically guarantee $0 under unbounded traffic, account-shared consumption, provider changes, or platform enforcement behavior. No live usage, billing, or deployment evidence is claimed.

GitHub-hosted runner isolation and the 30-minute job timeout are provider-enforced dependencies. The workflow attests the hosted runner context and minimum workspace capacity but does not claim a configurable cgroup or hard filesystem ceiling on GitHub-hosted VMs. The legacy bounded self-hosted attestation remains solely for a future Oracle Free Tier fallback.
