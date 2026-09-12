# Pi integration

Phase 16/C implements the thin Context Hub Pi client in [`../../packages/context-pi`](../../packages/context-pi). This document records implementation assumptions from the exact researched Pi installation; Phase 17's deterministic measurements are in [`pi-token-budget.md`](pi-token-budget.md).

## Researched Pi contract

Implementation was checked against `@earendil-works/pi-coding-agent` version `0.85.1` installed locally. The package README and the complete `docs/extensions.md`, `docs/tui.md`, `docs/sdk.md`, `docs/keybindings.md`, and `docs/packages.md` were read before implementation, together with the directly relevant extension command, status, shutdown, and package examples.

The current-version assumptions are:

- A Pi extension is a TypeScript module whose default export is a synchronous or asynchronous factory receiving the native `ExtensionAPI`; Pi loads TypeScript through jiti.
- One `pi.registerCommand("context", ...)` registration receives the remaining command text as `args`, so native invocations are `/context connect`, `/context status`, `/context sync`, `/context search <query>`, `/context graph <node>`, and `/context snapshot`.
- Command feedback uses `ExtensionCommandContext.ui.notify`; ambiguity uses `ctx.ui.select` only when `ctx.hasUI` is true. The extension does not require a custom TUI component or keybinding.
- `session_start` is the supported lifecycle point for session-scoped initialization and UI status. `session_shutdown` fires for quit, reload, new, resume, and fork and is the supported cleanup boundary. The extension clears its status and drops its in-memory MCP client there; it starts no process, socket, watcher, timer, provider, or LLM tool.
- Pi packages declare extension entry points in `package.json` under `pi.extensions`. Pi's bundled extension packages, including `@earendil-works/pi-coding-agent`, belong in `peerDependencies` with `"*"`; the Context Hub runtime dependency is the workspace local CLI.
- Native command registrations do not add a custom LLM tool schema. This extension does not call `registerTool`, `sendMessage`, `sendUserMessage`, `appendEntry`, `before_agent_start`, provider hooks, `registerProvider`, or system-prompt APIs.
- Pi extension errors are otherwise logged while the agent continues, so command handlers catch failures and emit bounded stable text without credentials or private response bodies.

A future Pi version must be checked against these assumptions before raising the supported version. External live Pi/TUI installation, command rendering, reload, and shutdown evidence remains pending.

## Client boundary

The extension reuses `@context-hub/context-cli` for Git root/remote discovery, canonical GitHub normalization, fixed `.ai-context` layout, connection, offline status, verified graph cache reads, and atomic sync. It adds only command orchestration, bounded local graph projection, and a minimal MCP JSON-RPC client.

Repository resolution uses the existing authorized human-session route because it returns the zero, unique, or bounded ambiguous authorized candidate set needed for explicit selection. `CONTEXT_HUB_SESSION` is environment-only and is used only by existing CLI connect/status/sync requests. Search and online graph requests use the separate Phase 14 scoped bearer supplied as `CONTEXT_HUB_MCP_TOKEN`. ADMIN users provision that credential through the existing human-cookie `/mcp-credentials` lifecycle; Pi neither accepts the secret in command arguments nor implements a second issuance flow.

Before every MCP search/graph call and every credential-free cached graph read, Pi re-reads and normalizes the checkout's live `origin` through the shared CLI seams and requires it to equal the selected manifest repository. Online calls additionally require the independently configured API origin to equal the manifest API origin. A missing, invalid, or changed remote returns `COMMIT_MISMATCH` before any credential, MCP request, or old graph projection is used.

Every MCP request uses that exact validated origin, rejects redirects, supplies a fresh `X-Context-Nonce`, and sends the secret only in `Authorization`. The minimal client negotiates protocol version `2025-03-26` and validates the exact bounded Worker initialize result, including capabilities and server identity, before sending `notifications/initialized`; malformed or wrong-version negotiation stops without notification or tool dispatch. MCP bodies are streamed into a 128 KiB ceiling and the reader is cancelled immediately on overflow even without `Content-Length`. Requests and displayed output are independently bounded. Server project scope and membership are reauthorized for every call; a cached project ID only selects scope and never grants access.

Automatic resolution runs without making the model or cached local operations depend on its result. A unique authorized match updates the same non-secret CLI manifest; zero and many matches remain explicit. The documented async `session_start` handler returns its initialization promise and carries an abort signal plus lifecycle generation through resolution and CLI connect. `session_shutdown` aborts and invalidates that generation, preventing stale cache selection or notification after reload/session replacement. `status` works without network. An online graph network failure falls back to a compact projection from the CLI-verified local graph only after the live remote check. Search has no fabricated local fallback because this phase does not add a local Context Engine cache.

## Review correction

The single Phase 16/C review's complete four-item P1 set is fixed in one consolidated pass: live repository and API-origin fencing, initialize-result validation, streaming response bounds, and abortable generation-fenced startup selection. Regression tests cover changed remotes for search/online graph/credential-free graph, malformed negotiation, chunked overflow cancellation, and shutdown during deferred resolution/connect. The Phase 16 root gate is complete; Phase 17's root gate and live Pi/TUI evidence remain pending.

Snapshots remain unavailable. `/context snapshot` reports a fixed non-mutating Phase 18 placeholder and creates no metadata or payload.
