# Context Hub Pi extension

Phase 16/C adds one native Pi slash command with these forms:

```text
/context connect [project-id]
/context status
/context sync
/context search <query>
/context graph <node>
/context snapshot
```

Install the package as a trusted local Pi package or load `src/index.ts` with Pi's `-e` option. The extension registers no LLM tool and does not alter the system prompt, model, provider, or agent architecture.

## Credentials

An ADMIN first creates a scoped MCP/local-client credential through Context Hub's existing `/mcp-credentials` human-session lifecycle. The one-time bearer value must be placed in an OS credential store and injected into the Pi process as `CONTEXT_HUB_MCP_TOKEN`. It is accepted only from the environment and sent only in `Authorization`; it is never accepted as a command argument or written to `.ai-context`.

The existing local CLI still uses `CONTEXT_HUB_SESSION` for its human-session `connect` and `sync` routes. An OS secret helper should inject that value into the process environment. Both credential families require an independently supplied `CONTEXT_HUB_API`. The origin must be origin-only HTTPS (or loopback HTTP), must exactly match the cached manifest for CLI status/sync, and redirects are rejected.

```sh
export CONTEXT_HUB_API="https://api.example.com"
export CONTEXT_HUB_SESSION="$(your-os-secret-helper read context-hub-session)"
export CONTEXT_HUB_MCP_TOKEN="$(your-os-secret-helper read context-hub-mcp)"
pi -e ./packages/context-pi/src/index.ts
```

`connect` normalizes the current GitHub `origin` through `@context-hub/context-cli`, resolves only authorized projects, selects an exact single match, and requires an explicit TUI selection or project ID for ambiguity. Reconnecting with another matching ID switches the non-secret selection in `.ai-context/manifest.json`; the server reauthorizes every later request.

`status` remains local/offline-capable. `graph` uses the bounded MCP query and falls back to the already verified local graph cache on network failure. `search` is cloud-backed because Phase 16 adds no local Context Engine. `snapshot` is a non-mutating availability message because snapshot storage belongs to Phase 18.
