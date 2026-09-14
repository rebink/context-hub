# Pi Token Budget Audit

Phase 17 audits the Phase 16 Context Hub extension at checkpoint `b7307a0`; Phase 18 refreshes its canonical fixture after replacing the misleading snapshot-unavailable placeholder with a truthful fixed availability notice. Phase 19 refreshes only the user-visible sync result to include its separate reporting outcome. The notice remains non-mutating and adds no Pi retrieval, snapshot creation, freshness, team, generalized audit, deployment, model-facing tool, or UI capability.

## Reproducible method

Run from the repository root with Node.js 22 and the locked development dependencies:

```sh
npm run audit:pi-tokens -w @context-hub/context-pi
npx tsx --test packages/context-pi/test/pi-token-audit.test.ts packages/context-pi/test/extension.test.ts
```

The dependency-free measurement in [`../../packages/context-pi/scripts/pi-token-audit-lib.ts`](../../packages/context-pi/scripts/pi-token-audit-lib.ts) activates the real exported `createContextExtension`, invokes its registered handler for all six exported `PI_COMMAND` subcommands, executes both lifecycle handlers, and imports the real `PI_OUTPUT_LIMITS`. It does not copy command names, descriptions, formatters, or bounds.

The executable emits `{ "audit": ..., "auditSha256": ... }`. `auditSha256` is SHA-256 over the compact deterministic `JSON.stringify(audit)` payload before the digest field is added, so the hash is canonical and not self-referential. The accepted payload digest is **`9ae7b270a3a64257fc58825710cffe6418f64e7f95d40ec3fae75ed64ff04382`**. Tests recompute and exact-lock it.

All byte counts are `TextEncoder` UTF-8 byte lengths. The Context Engine estimator is `ceil(bytes / 4)`, but this audit applies it only to genuinely model-visible bytes. Structural evidence proves no model-visible insertion API or hook is used, so estimated permanent model-visible overhead is **0 tokens**. Formatted notification/status payloads and MCP wire envelopes receive no token estimate. Tokenizer-specific counts and live provider telemetry were not measured.

## Measurement boundary

Measured UI values are **formatted payload bytes passed to `ctx.ui.notify` or `ctx.ui.setStatus`**. They are not measured TUI or RPC bytes. Terminal rendering, line wrapping, ANSI styling, UI component overhead, and RPC `extension_ui_request` JSON framing are explicitly excluded.

Pi 0.85.1 documents `registerCommand` as immediate slash-command dispatch. `ctx.ui.notify` and `ctx.ui.setStatus` are UI operations, unlike `sendMessage` and `sendUserMessage`, which create model-visible messages. Command registration metadata is command-discovery data, not system-prompt or conversation content. Phase 15 remains authoritative for model-facing MCP server schemas and response envelopes.

## Fail-closed context evidence

The audit uses Proxy-backed traps rather than hard-coded context claims. It records Pi 0.85.1 API access and return values across:

- `registerTool`, `sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`, and `setLabel`;
- `registerProvider`, `unregisterProvider`, `setModel`, `setActiveTools`, and `setThinkingLevel`;
- model/provider/context mutation hooks, including `before_agent_start`, `before_provider_request`, and `context`;
- command/lifecycle context session controls plus `sendMessage` and `sendUserMessage` if exposed there; and
- non-void lifecycle returns that could carry an unexpected payload.

Any trapped mutation, unknown API/context call, mutation hook, or non-void lifecycle return aborts the audit with `PI_CONTEXT_MUTATION`; any derived nonzero permanent-context field aborts with `PI_PERMANENT_CONTEXT_NOT_ZERO`. The resulting zero fields are sums derived from recorded calls and handler returns across all activation, lifecycle, command, and boundary runs.

The result is zero registered LLM tools, prompt-mutation hooks, model-visible message calls, hidden context entries, provider mutations, model mutations, active-tool mutations, thinking mutations, session mutations, and unexpected mutations. Accordingly, model-visible bytes and estimated tokens are both derived as zero. This is **structural no-mutation evidence**, not a claimed byte comparison against a real Pi system prompt. Live system-prompt/provider payload capture remains external evidence.

## Activation and project-count footprint

The accepted startup budget is zero model-visible bytes/tokens, one native registration, two lifecycle handlers, at most 256 formatted UI payload bytes for these deterministic fixtures, and no mutation.

| Authorized projects | Native commands | Registration bytes | Registration SHA-256 | Formatted status payload bytes | Formatted notification payload bytes | LLM tools | Model-visible bytes |
| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 1 | 107 | `a67bbb28...7eed` | 14 | 40 | 0 | 0 |
| 10 | 1 | 107 | `a67bbb28...7eed` | 14 | 69 | 0 | 0 |
| 100 | 1 | 107 | `a67bbb28...7eed` | 14 | 69 | 0 | 0 |

The complete registration bytes and hash are identical at all project counts. `/context` is registered once; its six subcommands are handler branches, not schemas or per-project registrations. Ten and 100 projects use the same fixed ambiguity notification. Project count therefore changes neither model context nor registration footprint.

## Command payload measurements

| Command/scenario | Formatted notification payload bytes | Level | Model-visible bytes / est. tokens | Output SHA-256 |
| --- | ---: | --- | ---: | --- |
| `/context connect project-2`, two authorized matches | 40 | info | 0 / 0 | `ecef7d08...bce37` |
| `/context status`, local/offline | 202 | info | 0 / 0 | `83174691...e36cf` |
| `/context sync` with reporting not configured | 64 | info | 0 / 0 | `77fecd26...938b` |
| `/context search payment retries`, single project | 658 | info | 0 / 0 | `105c40a4...cabcc` |
| `/context graph RetryPayment`, single project | 458 | info | 0 / 0 | `cb3a3315...e1c8` |
| `/context snapshot` truthful web/API availability and Pi mutation-auth notice | 132 | warning | 0 / 0 | `da68db1f...10e7` |
| Unauthorized search | 33 | error | 0 / 0 | `486a3ae7...abcc` |
| Offline verified local graph fallback | 225 | warning | 0 / 0 | `52f11a18...a878` |
| Invalid subcommand/usage | 21 | error | 0 / 0 | `dec7e6a2...fd94b` |

These runs execute all six native commands and representative single-project, two-project ambiguity, unauthorized, and offline paths. Pi has no cross-project result command; cross-project MCP response cost remains Phase 15 evidence.

## Output-boundary evidence

The accepted interactive budget is zero model-visible bytes/tokens and at most 16,384 UTF-8 bytes per formatted notification payload. Production now backs off to a valid UTF-8 boundary before appending the truncation marker instead of decoding an arbitrary byte cutoff.

| Boundary scenario | Formatted bytes | Marker | Valid UTF-8 | Complete credential present | SHA-256 |
| --- | ---: | --- | --- | --- | --- |
| Multibyte status crossing the ceiling | 16,384 | yes | yes | no | `a7ddadac...d44a6` |
| Successful status containing valid credential | 37 | no | yes | no | `1e7aa995...d4495` |
| Successful MCP search containing valid credential | 668 | no | yes | no | `220d74f9...15660` |

Both successful secret fixtures pass the valid `chmcp_` credential through real command handlers and production formatting; output contains `[REDACTED]` and no complete credential. Search requests remain capped at 12,288 result bytes and MCP response reading at 131,072 bytes.

## Supporting transport bytes

The audit records exact compact JSON-RPC request/response byte counts and hashes for initialize, initialized notification, successful search/graph, unauthorized search, and the successful secret-redaction search. These are supporting transport bytes only. Authorization headers, nonce/header framing, terminal rendering, and RPC UI framing are excluded. Pi parses returned text and sends a formatted notification; it does not invoke a model-message API.

[`mcp-token-budget.md`](mcp-token-budget.md) remains authoritative for MCP schemas, envelopes, model-visible server responses, and calculated protocol bounds. This audit does not add those bytes to Pi context or double-count them.

## Review and residual evidence

The one Phase 17 review reported four P1 findings. Its consolidated pass fixed all four: derived fail-closed mutation evidence, canonical final audit digest, UTF-8-safe truncation plus successful-output secret regression coverage, and accurate formatted-payload labeling. Phase 18 changes only the fixed snapshot notice and refreshes its exact byte/hash fixture plus the resulting canonical digest; the six-command and zero-mutation invariants are unchanged.

The remaining P2/release evidence is limited to typechecking against Pi's exported API with an install fixture, Node >=22.19/package installation evidence, and live TUI/RPC/provider/reload/shutdown telemetry. No live model tokenizer, hosted telemetry, deployed Worker, or production traffic was used.
