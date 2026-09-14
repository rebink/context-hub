# Phase 27 metrics and launch-acceptance evidence

Date: 2026-09-16  
Baseline: `978f964e9819b6d6e1ebbf1553f5f310bb97fa5d`  
Status: **LOCAL IMPLEMENTATION EVIDENCE PASS; OVERALL LAUNCH BLOCKED**

Allowed results are `PASS | BLOCKED | NOT RUN`. A local `PASS` is not production evidence. This phase did not deploy, create a production resource, contact a production service, collect user telemetry, add analytics, or attempt to recreate Phase 6 evidence; the later archive recovery is recorded independently.

## Latest local metrics audit

`npm run audit:metrics` returned `PASS` in a local synthetic environment (`Node v26.3.0`, Darwin arm64). Environment details are descriptive, not a supported-host or SLA claim.

| Sample | Size | Latest result | Boundary |
| --- | ---: | --- | --- |
| Registry | 26 metrics | All canonical fields, exact requirement sources, finite dimensions and generated docs valid; 10 mutation traps pass; 8 live-only metrics locked `BLOCKED_LIVE` | Contract validation, not observations |
| MCP single-project accepted | 1 | 1,706 envelope bytes; 427 estimated envelope tokens; 1,416 model-visible bytes | Existing production encoder + synthetic fixture |
| MCP explicit two-project accepted | 1 | 3,178 envelope bytes; 795 estimated envelope tokens; 2,719 model-visible bytes | Existing production encoder + synthetic fixture |
| MCP partially unauthorized | 1 | 101 envelope bytes; 26 estimated tokens; 0 model-visible bytes; no rejected-project leak | Existing production nonleaking denial fixture |
| Context response | 1 | 902 exact serialized bytes; 192 estimated evidence tokens; 1 source; configured 32,768-byte/2,000-token defaults | Empty-source synthetic D1/R2 seam plus production engine; not relevance data |
| Graph projection | 1 | 2,960 serialized bytes; 25 returned records, equal to production record cap | 100-node/200-link synthetic graph through production `queryGraph` |
| Artifact | 0 payloads | 49,152-byte MCP content maximum derived from production `MCP_LIMITS` | Exported bound, not a measured retrieval distribution |
| Local graph query | 200 unmeasured warmups + 2,000 measured calls | Latest p50 0.007209 ms; p70 0.007417 ms; p85 0.007666 ms; p95 0.008167 ms | One machine/run, in-process synthetic fixture; not production or disk/network latency |
| Dashboard timing | 0 | BLOCKED | No reproducible browser harness; no value invented |
| Structured E2E stages | 0 | NOT RUN | Current E2E emits named results but no structured redacted timing |

The local audit output is intentionally run-specific. Re-running updates the evidence in command output; this checked-in result is the latest implementation sample and is not an SLA.

## Review correction disposition

The only Phase 27 review reported six P1 findings. One consolidated correction pass fixes all six: artifact versions now join through `artifacts.project_id`; `CLEANED` is a failed terminal outcome using `failed_at`; D1 windows are exact `[from,to)`; the executable registry generates/checks every normative documentation field and maps all 26 IDs to the exact 15 playbook metrics or explicit architecture sources; every dimension has a finite allowlist; and a fresh isolated Wrangler-local D1 test exercises the production route and SQL on schema through migration 0020 with cross-project artifacts, published/failed/cleaned/out-of-window graph attempts, source-bridged audit events, and snapshot failure evidence. The benchmark also performs 200 unmeasured warmup calls, and Context `sourceCount` mismatch is mutation-tested. No second review ran. The deterministic metrics/docs audits, fresh real-D1 integration, and parent-owned root gate pass.

## Correction validation

| Command/check | Result |
| --- | --- |
| `npm run audit:metrics` and `npm run audit:metrics:docs` | PASS; 26 metrics, 10 mutation traps including Context mismatch, 8 live-only metrics still blocked, generated table exact |
| API tests matching metrics/Context | PASS; 211 API tests reported, including SQL-sensitive route/accounting regressions; one additional isolated fresh-D1 integration test passed |
| `npm run test:metrics-integration -w @context-hub/api` | PASS; fresh isolated Wrangler-local final migration-0020 schema, production HTTP route and exact SQL |
| MCP and Pi token audits | PASS; bounded response changes retain the documented MCP envelopes and Pi zero permanent model-visible bytes |
| `npm run qa:architecture` | PASS; digest `21daca0456215c1ccb7133af76cd0c18a74d52bc0c1abed3713a1b850fc8d6f2` |
| Workspace typechecks and builds | PASS for all five workspaces; Worker build is dry-run only |
| Targeted Biome, docs generation check, secret-pattern scan, and `git diff --check` | PASS; no staged files |
| Editor LSP diagnostics | No standalone LSP tool is exposed in this CLI; TypeScript and Biome diagnostics are clean for the changed implementation/tests/scripts |

The parent-owned root gate also passes: deterministic docs/metrics audits, fresh real-D1 integration, migration integrity, 346 tests, typecheck, Biome lint, and all builds.

## Implemented measurement surface

| Check | Result | Evidence |
| --- | --- | --- |
| Exact registry and privacy allowlist | PASS | [`metrics.md`](metrics.md) is generated/checkable from `scripts/metrics-registry.mts`; executable formula/source/target/threshold/privacy/live-status/dimension/requirement mutation traps |
| Project aggregate route | PASS | `GET /projects/:id/metrics?windowDays={7,30,90}`; current direct membership, archived-project support, three project-predicated aggregate queries, exact `[from,to)` windows/counts/nulls, plus fresh Wrangler-local migration-0020 route/SQL integration |
| Reliability arithmetic | PASS | `PUBLISHED` successes; `FAILED` plus retained `CLEANED` failures by their correct terminal timestamps; accepted sync/snapshot outcomes; zero-denominator `null`; exact sample counts |
| Graph timing | PASS | `published_at - claimed_at` for `PUBLISHED` and `failed_at - claimed_at` for `FAILED`/`CLEANED`; average/min/max/sample count |
| Immutable object metadata | PASS | D1-known referenced artifact/selected-graph/manifest bytes separated from `orphanBytes: null` and `actualBilledStorageBytes: null` |
| Authorization/nonleakage/bounds | PASS | ADMIN/EDITOR/VIEWER, outsider `404` before aggregates, archived project, invalid/duplicate window tests |
| Context response-local accounting | PASS | Fixed-point exact `byteSize`, exact `sourceCount`, existing `tokenEstimate`; no write/log side effect |
| New raw telemetry storage | PASS | No migration/table/usage record added |
| In-product UI | PASS (intentionally absent) | A partial project dashboard cannot combine provider account analytics/manual studies; API plus existing Overview/Activity is the honest minimum |

## Live and study evidence

| Requirement | Result | Exact unblock evidence |
| --- | --- | --- |
| Relevance and tokens/task | BLOCKED | Approved consent/rubric, >=30 completed tasks, two-reviewer relevance ratings, aggregate-only retained results |
| Connect/onboard/paste avoided | BLOCKED | Facilitated study with stated cohort/sample, stopwatch/task sheet, no clipboard/query/content telemetry |
| Worker/API latency/errors/requests | NOT RUN | Deployed first-party Workers Analytics aggregate receipt with account scope and period |
| D1 rows/operations/query latency | NOT RUN | Remote D1 analytics/query-insight receipt; local returned rows are not billed rows |
| R2 billed storage/Class A/Class B/orphans | NOT RUN | Private bucket inventory and account-period analytics; D1 referenced bytes remain separate |
| GitHub Actions minutes and Graphify benchmark | NOT RUN | Owner plan/visibility/billing receipt and representative/largest protected run |
| Dashboard/browser and live Pi timing | NOT RUN | Approved first-party/manual browser and pinned Pi host acceptance with sample/device details |
| Alerts/rate/retention operations | BLOCKED | Approved production policy and configured alert receipts; source thresholds alone are not configuration |

## Launch acceptance

| Acceptance group | Result | Reason |
| --- | --- | --- |
| Phase 27 local implementation | PASS | Registry, local audit, project aggregates, response-local accounting, targeted tests and documentation are present |
| MVP functional implementation | PASS locally except process-checkpoint disposition | Phase 25 matrix and Phase 24 E2E retain existing code evidence |
| Historical Phase 6 review/root gate | PASS after separate recovery | Original reviewer/root records are preserved in `phase-6-acceptance-evidence.md`; this metrics phase is not their source |
| Phase 6 historical protocol | BLOCKED | `BLK-001` remains because split/post-fix reviews violate the current exactly-one rule and the repository had no `HEAD`; this phase neither resolves nor relabels those facts |
| Phase 26 production/live gates | BLOCKED / NOT RUN | No production resources/deployment, browser, live providers, remote D1/R2, protected runner, live MCP/Pi, privacy deletion, alert policy, backup/restore, or deployment evidence |
| Free-services production suitability | BLOCKED | Bounded architecture/local audit exists; account-shared usage, remote CPU/rows/storage/operations and plan evidence do not |
| Overall production launch | BLOCKED | Every live/study/operations prerequisite above must close for the same approved candidate and evidence period |

## Reconciliation

- [`README.md`](../../README.md), [`master-plan.md`](master-plan.md), [`implementation-status.md`](implementation-status.md), [`project-discovery.md`](project-discovery.md), [`architecture.md`](architecture.md), and [`security.md`](security.md) now describe the local Phase 27 surface while retaining live blockers.
- [`final-qa.md`](final-qa.md) retains `BLK-001` for Phase 6's historical review-topology deviation and absent Git checkpoint; `BLK-009` is narrowed from missing metric definition to missing approved/live telemetry, studies, and alerts. No live acceptance row is promoted.
- [`deployment-evidence.md`](deployment-evidence.md) remains `BLOCKED / NOT RUN` for production metrics. Phase 26 evidence is not rewritten as Phase 27 collection.
- [`free-tier-audit.md`](free-tier-audit.md) remains authoritative for source-derived limits and required provider receipts. This phase does not infer Worker/D1/R2/Actions analytics from D1.
- [`e2e-report.md`](e2e-report.md) remains authoritative for local product-flow evidence; its named stages are not retroactively assigned timing values.
