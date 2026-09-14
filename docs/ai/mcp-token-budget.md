# MCP Token Budget Audit

Phase 15 measures the Phase 14 universal MCP transport at checkpoint `cef956a` plus this audit change. It is evidence production, not a tokenizer benchmark or transport redesign.

## Reproducible method

Run from the repository root with Node.js 22 and the locked development dependencies:

```sh
npm run audit:mcp-tokens -w @context-hub/api
npx tsx --test apps/api/test/mcp-token-audit.test.ts apps/api/test/mcp-transport.test.ts
```

The dependency-free audit logic is in `apps/api/scripts/mcp-token-audit-lib.ts`. It imports the actual exported `MCP_TOOLS`, `MCP_TOOL_NAMES`, immutable `MCP_LIMITS`, and `WorkerMcpTransport`; it does not copy schemas or production limits from documentation. `apps/api/src/mcp.ts` uses the same object for domain validation and caller-wide allocation, while `apps/api/src/mcp-transport.ts` uses it for schemas and wire encoding. The executable wrapper prints machine-readable JSON. The regression test locks the complete limits object and the invariants below.

All byte counts are `TextEncoder` UTF-8 byte lengths over compact `JSON.stringify` output. All estimated token counts use the Context Engine convention `max(1, ceil(UTF-8 bytes / 4))` for measured strings. A missing model-visible text field is reported separately as zero bytes/tokens and is not passed to the string estimator. Byte/4 is the project's deliberately conservative planning estimator; it is deterministic and dependency-free, but it is not tokenizer-exact and must not be presented as a count from any model tokenizer.

The response fixtures are deterministic, bounded Context Engine-shaped results with artifact and graph evidence plus complete project/source/path/section/version/commit/checksum provenance. The audit passes those fixtures through the real transport encoder. It measures both the complete JSON-RPC response bytes and the decoded `result.content[0].text` presented to the model. The unauthorized fixture is encoded through the real transport's stable dispatch-failure path.

## Measured evidence

### Advertised tools and schemas

The complete advertised value is compact `JSON.stringify(MCP_TOOLS)`, including all six names, descriptions, and complete input schemas. It is **4,082 UTF-8 bytes**, estimated as **1,021 tokens**, with SHA-256 `3cd33a36192e35bdd8b6c195b27a5a2720db3cc992faa7b0c0699465e2044599`. The complete `tools/list` JSON-RPC envelope is **4,132 bytes**; that exact envelope size is regression-locked for every project-count run.

| Authorized projects | Tools | Complete schema bytes | Estimated tokens | Schema SHA-256 | Project enumeration |
| ---: | ---: | ---: | ---: | --- | --- |
| 1 | 6 | 4,082 | 1,021 | `3cd33a...4599` | none |
| 10 | 6 | 4,082 | 1,021 | `3cd33a...4599` | none |
| 100 | 6 | 4,082 | 1,021 | `3cd33a...4599` | none |

The complete bytes and hash are identical in all three runs. Tool names are unique, each tool appears once, schemas are not duplicated per project, and no authorized project identifier is embedded in the advertisement. The footprint is therefore exactly constant, not merely effectively constant, as project count changes.

### Representative responses

| Scenario | HTTP | JSON-RPC envelope bytes / est. tokens | Model-visible text bytes / est. tokens | Response SHA-256 |
| --- | ---: | ---: | ---: | --- |
| Single explicit project | 200 | 1,706 / 427 | 1,416 / 354 | `3dfd45d1...453dd` |
| Explicit two-project scope | 200 | 3,178 / 795 | 2,719 / 680 | `01a4756e...15172` |
| Partially unauthorized scope | 404 | 101 / 26 | 0 / 0 | `eead434c...af80` |

Across all three required scenarios, the rounded-up average complete envelope is **1,662 bytes / 416 estimated tokens**. Across the two successful, model-visible results, the rounded-up average text is **2,068 bytes / 517 estimated tokens**. The largest measured response is the explicit two-project result at **3,178 envelope bytes / 795 estimated tokens**; its model-visible text is 2,719 bytes / 680 estimated tokens.

The rejected partially unauthorized response is exactly the generic JSON-RPC `PROJECT_NOT_FOUND` error path. It has no model-visible tool content and contains none of either requested project ID, `provenance`, `checksum`, or `commit`. The test also verifies that the rejection fixture does not dispatch any project-specific result body.

These are representative deterministic fixtures, not claims about production workload distribution. No schema or result verbosity exceeded an accepted bound, so Phase 15 makes no behavior or wording trim.

## Calculated upper bounds

The current code-enforced limits come directly from the one deeply frozen production `MCP_LIMITS` object. Tests assert the complete object exactly so schema, domain, audit output, and documentation drift cannot pass silently:

```json
{
  "transport": { "requestBytes": 16384, "responseBytes": 131072 },
  "scope": { "minProjects": 1, "maxProjects": 20 },
  "searchContext": {
    "minTokens": 32,
    "maxTokens": 8000,
    "defaultTokens": 2000,
    "minBytes": 512,
    "maxBytes": 65536,
    "defaultBytes": 32768
  },
  "artifact": { "contentBytes": 49152 },
  "graph": { "minRecords": 1, "maxRecords": 25, "defaultRecords": 25 },
  "sources": { "minRecords": 1, "maxRecords": 50, "defaultRecords": 25 }
}
```

| Boundary | Limit |
| --- | ---: |
| MCP POST request body | 16,384 bytes |
| Encoded JSON-RPC response | 131,072 bytes |
| Explicit selected projects | 20 |
| `search_context` caller budget | 8,000 estimated tokens and 65,536 result bytes |
| `get_artifact` content allocation | 49,152 bytes total across selected projects |
| `query_graph` records | 25 total across selected projects |
| `get_sources` records | 50 total across selected projects |

`search_context` invokes the one multi-project Context Engine with one caller-provided token and byte budget across all authorized projects. Candidates are ranked globally and one fixed overall source cap applies; graph/source limits and artifact retrieval work also remain caller-wide. Every encoded transport response is then fail-closed at 128 KiB; a larger serialization is replaced by the small `RESPONSE_TOO_LARGE` error rather than sent to the model. Task D does not change any MCP schema/tool-list bytes or this audit's locked digest.

A conservative one-call model-context ceiling is the complete stable schema plus the maximum accepted response envelope:

```text
4,082 schema bytes + 131,072 response bytes = 135,154 bytes
ceil(135,154 / 4) = 33,789 estimated tokens
```

Both exact ceiling values are regression assertions derived from the production object and complete measured schema.

This **135,154-byte / 33,789-estimated-token** figure is a calculated protocol upper bound, not a measured normal response. It intentionally counts the whole JSON-RPC envelope even though only decoded tool text may be inserted into a model context. Request bytes, Authorization, nonce, HTTP headers, and server audit data are not model-visible and are excluded. A host client may add its own tool-call framing; that client-specific overhead is outside this server measurement.

The tighter `search_context` semantic ceiling remains the caller's 8,000-token / 65,536-byte domain budget before MCP wrapper and JSON escaping overhead. The transport ceiling is the final cross-tool safety bound.

## External and live evidence

No live MCP client, deployed Worker, remote D1/R2, production traffic sample, or model tokenizer was used. Live client framing/interoperability, edge/log redaction, remote contention, workload percentiles, and tokenizer-specific counts remain release evidence. Those external checks must not replace the deterministic schema and transport regression test, because they cannot prove byte-for-byte project-count independence.
