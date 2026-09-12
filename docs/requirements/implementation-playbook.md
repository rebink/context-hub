# Context Hub — AI Implementation Playbook

## Purpose

This playbook is for building Context Hub with an AI coding agent such as normal Pi.

The key rule is:

> Do not give the AI the entire repository + entire PRD + all architecture documents at every step.

Use staged discovery, short task prompts, local project artifacts, tests, and explicit gates.

---

# 1. Permanent Project Instructions

Create a small root `AGENTS.md` with:

```md
# Context Hub Engineering Rules

1. Git is authoritative for source code.
2. Graphify is a derived immutable artifact.
3. Never merge graph.json files.
4. Never overwrite a graph version.
5. Artifacts are immutable versions.
6. Context must be retrieved selectively.
7. Never inject the entire repository into model context.
8. Keep Context MCP tool schemas small.
9. Keep Pi integration lightweight.
10. Keep the product provider-neutral.
11. Prefer local-first workflows.
12. MVP must remain free/open-source infrastructure compatible.
13. Every important context result should have provenance.
14. Do not introduce unnecessary infrastructure.
15. Do not implement embeddings/vector search until actual retrieval requirements justify it.
16. Do not modify unrelated code.
17. Inspect existing code and documentation before introducing new patterns.
18. Optimize for useful context per token, not merely fewer tokens.
```

This file should stay small.

---

# 2. Development Rule for Every AI Session

Use this pattern:

```text
Task
 ↓
Relevant architecture
 ↓
Relevant code
 ↓
Relevant tests
 ↓
Implement
 ↓
Test
 ↓
Review diff
 ↓
Commit/checkpoint
```

Never start with:

```text
"Build the whole product."
```

---

# 3. Phase 0 — Discovery

## Prompt 0A — Repository Discovery

```text
We are about to build Context Hub.

Before writing application code, inspect the repository and determine:

- current structure
- language/framework
- package manager
- frontend
- backend
- database
- deployment
- authentication
- test setup
- linting
- type checking
- CI/CD
- existing reusable packages/components
- existing infrastructure
- environment configuration

Do NOT implement.

Create:

docs/ai/project-discovery.md

Include:
- current architecture
- important packages
- reusable components
- conventions
- technical risks
- unknowns
- likely extension points

Keep it concise and factual.
Do not invent architecture.
Do not modify unrelated code.
```

---

# 4. Phase 0 — Architecture

## Prompt 0B

```text
Read:

docs/ai/project-discovery.md

Using the approved Context Hub PRD, design the technical architecture.

Do NOT implement yet.

Create:

docs/ai/architecture.md

Include:

- system architecture
- frontend architecture
- Worker/API architecture
- database schema
- R2 object layout
- GitHub integration
- Graphify integration
- Context Engine
- MCP
- Pi integration
- authentication
- authorization
- graph synchronization
- artifact versioning
- context snapshots
- audit
- security
- free-tier constraints
- local/offline strategy

Mandatory principles:

Git = source of truth
Graphify = immutable derived artifact
Artifacts = immutable versions
No graph merging
Minimal model context
Provider-neutral MCP
Local-first
Free infrastructure

Do not introduce unnecessary infrastructure.
```

---

# 5. Security Architecture

## Prompt 0C

```text
Read docs/ai/architecture.md.

Create:

docs/ai/security.md

Threat model:

- authentication
- authorization
- project isolation
- Git credentials
- MCP authentication
- private artifact access
- object storage
- webhook spoofing
- SSRF
- path traversal
- malicious uploads
- replay attacks
- role escalation
- cross-project access

For each threat, provide mitigation.

Do NOT implement yet.
```

---

# 6. Phase 1 — Foundation

## Prompt 1

```text
Implement only the application foundation described by:

docs/ai/project-discovery.md
docs/ai/architecture.md

Set up:

- frontend
- API
- D1
- R2
- migrations
- environment configuration
- tests
- linting
- type checking
- local development

Do NOT implement:

- Git
- Graphify
- MCP
- Pi
- Context Engine

Use minimal dependencies.

Run tests and type checks.

Show the final git diff and explain every changed file.
```

Gate:

```text
PASS:
tests
typecheck
lint
build

FAIL:
do not continue.
```

---

# 7. Phase 2 — Authentication + Projects

## Prompt 2

```text
Implement GitHub authentication.

Then implement:

- users
- sessions
- project creation
- project listing
- project detail
- project authorization

Roles:

ADMIN
EDITOR
VIEWER

Server-side authorization is mandatory.

Add tests for:

- unauthenticated access
- authenticated access
- cross-project access
- role enforcement

Do not implement artifacts, Graphify, or MCP yet.
```

---

# 8. Project UI

## Prompt 3

```text
Implement the project dashboard UI using real API data.

Show:

- project
- Git status placeholder
- Graphify status placeholder
- artifact count
- member count
- sync status

Do not create fake backend functionality.

Do not implement Git/Graphify behavior yet.
```

---

# 9. Phase 3 — Artifacts

## Prompt 4

```text
Implement artifact storage and versioning.

Support:

- artifact metadata
- upload
- version creation
- version listing
- retrieval
- checksum
- R2
- permissions
- optimistic conflict detection

Types:

architecture
adr
api-contract
coding-convention
domain-knowledge
glossary
database-schema
runbook
deployment-guide
ownership
security-rule
product-requirement
custom

Rules:

- never silently overwrite
- preserve historical versions
- viewers cannot edit
- large objects go to R2

Add tests.
```

---

# 10. Artifact UI

## Prompt 5

```text
Build the Context UI.

Implement:

- category navigation
- artifact list
- artifact detail
- version history
- viewer read-only behavior
- editor controls
- admin controls

Use real data.

Do not implement Graphify yet.
```

---

# 11. Phase 4 — GitHub

## Prompt 6

```text
Implement GitHub repository connection.

Support:

- connect repository
- verify repository
- default branch
- current commit SHA
- update known commit SHA

Do not clone or persist the full repository into D1.

Do not expose GitHub credentials to clients.

Add tests.

Only implement the Git integration layer.
```

---

# 12. Phase 5 — Graphify Research

## Prompt 7

```text
Before integrating Graphify, inspect the CURRENT Graphify source/documentation.

Determine:

- current CLI
- output format
- watch mode
- incremental capabilities
- MCP/HTTP capabilities
- checksum/version information
- authentication options
- deployment assumptions

Do not guess.

Create:

docs/ai/graphify-integration.md

Document:

- selected integration approach
- inputs
- outputs
- lifecycle
- failure handling
- security considerations
- local mode
- cloud mode

Do not implement yet.
```

---

# 13. Graphify Adapter

## Prompt 8

```text
Implement a thin GraphifyAdapter based on:

docs/ai/graphify-integration.md

Responsibilities:

- identify graph output
- associate source commit SHA
- identify Graphify version
- calculate/verify checksum
- prepare immutable graph metadata

Do NOT reimplement Graphify traversal.
Do NOT modify Graphify internals.
Do NOT add agent tools.
```

---

# 14. Graph Versioning

## Prompt 9

```text
Implement immutable graph versioning.

Statuses:

QUEUED
BUILDING
READY
FAILED
SUPERSEDED

Each graph version must record:

- project
- version
- source commit SHA
- Graphify version
- checksum
- storage key
- status
- generated timestamp
- generator

Rules:

- never overwrite graph versions
- failed builds do not replace current READY graph
- duplicate commit should not produce duplicate graph version unless explicitly required
- concurrent build behavior must be deterministic

Add tests.
```

---

# 15. Phase 6 — CI Graph Build

## Prompt 10

```text
Implement the GitHub Actions graph workflow.

Flow:

checkout
→ Graphify
→ validate
→ checksum
→ publish
→ register graph version

Prevent duplicate graph generation for the same commit.

Do not run heavy builds inside a Cloudflare Worker request.

Document setup.

Test the workflow assumptions locally where possible.
```

---

# 16. Phase 7 — Local Sync

## Prompt 11

```text
Implement local project synchronization.

Local layout:

.ai-context/
  manifest.json
  graph/
  artifacts/
  cache/

Support:

context connect
context status
context sync

States:

CURRENT
GRAPH_STALE
LOCAL_REPOSITORY_AHEAD
REMOTE_GRAPH_AHEAD
NO_LOCAL_GRAPH
GRAPH_BUILDING
GRAPH_FAILED
COMMIT_MISMATCH

Sync algorithm:

download
→ verify checksum
→ verify source commit
→ write temporary
→ atomic replacement
→ update manifest

Never destroy a valid existing graph because an update fails.

Add offline behavior and tests.
```

---

# 17. Phase 8 — Context Engine

This is the main intelligence layer.

## Prompt 12

```text
Implement the Context Engine.

Inputs:

- project
- query
- optional domain
- optional package
- token/size budget

Sources:

- artifact metadata
- artifact contents
- Graphify
- Git metadata
- architecture maps

Outputs:

- relevant artifacts
- relevant excerpts
- relevant graph evidence
- relevant source locations
- provenance
- token estimate

Requirements:

- bounded output
- relevance-first
- provenance
- no full repository output
- no full graph output
- no duplicate context
- configurable budgets

Do NOT implement embeddings or vector search yet.
```

---

# 18. Context Engine Test Cases

## Prompt 13

```text
Create tests for Context Engine scenarios:

1. Query finds relevant architecture.
2. Query ignores unrelated artifacts.
3. Graph evidence is included when relevant.
4. Output respects token/size budget.
5. Sources have provenance.
6. Duplicate context is removed.
7. Stale artifacts are marked appropriately.
8. Private project data never leaks across projects.
```

---

# 19. Phase 9 — MCP

## Prompt 14

```text
Implement the Context Hub MCP interface.

Initial tools:

project_info
search_context
get_artifact
query_graph
get_sources
sync_status

Requirements:

- small schemas
- authenticated
- project scoped
- role aware
- bounded responses
- provenance
- read-only by default

Do NOT expose the entire Graphify tool surface unless required.

Do NOT implement administrative MCP tools for normal agents.
```

---

# 20. MCP Token Audit

## Prompt 15

```text
Measure the MCP tool schema footprint.

Report:

- number of tools
- schema tokens/size
- average response size
- largest response
- worst-case context output

Reduce unnecessary schema verbosity while preserving correctness.

Create:

docs/ai/mcp-token-budget.md
```

---

# 21. Phase 10 — Pi Integration

## Prompt 16

```text
Implement a lightweight Pi integration.

Possible commands:

/context connect
/context status
/context sync
/context search <query>
/context graph <node>
/context snapshot

Requirements:

- native Pi extension APIs
- minimal permanent prompt impact
- no large context injection
- no new agent architecture
- no unnecessary tools
- no provider-specific behavior

The extension should call Context Hub rather than reimplementing Context Engine logic.
```

---

# 22. Pi Integration Token Audit

## Prompt 17

```text
Audit the Pi integration.

Verify that it does NOT:

- enlarge system prompt unnecessarily
- register unnecessary LLM tools
- inject all artifacts
- inject the entire graph
- duplicate Graphify data
- modify provider behavior

Report estimated model-visible token overhead.

Target:

approximately zero permanent additional context.
```

---

# 23. Phase 11 — Snapshots

## Prompt 18

```text
Implement immutable Context Snapshots.

A snapshot stores:

- project
- Git SHA
- graph version
- artifact versions

Do not duplicate entire files.

Support:

- create
- list
- inspect
- retrieve

Add tests for reproducibility.
```

---

# 24. Phase 12 — Freshness

## Prompt 19

```text
Implement artifact freshness detection.

States:

CURRENT
STALE
UNKNOWN

Use available provenance:

artifact source commit
current repository commit

Do not rewrite artifacts.

Expose freshness in UI and context results.
```

---

# 25. Phase 13 — Team

## Prompt 20

```text
Implement team management.

Support:

- invite
- accept
- remove
- role change

Roles:

ADMIN
EDITOR
VIEWER

Test every mutation against permissions.

A viewer must never be able to mutate an artifact, Graphify version, or project.
```

---

# 26. Phase 14 — Audit

## Prompt 21

```text
Implement audit events:

project creation
Git connection
artifact creation
artifact version creation
member invite
role change
member removal
graph build
graph publish
graph failure
snapshot creation
sync

Do not log credentials or sensitive payloads.
```

---

# 27. Phase 15 — Security Audit

## Prompt 22

```text
Perform a complete security audit.

Inspect:

- authentication
- authorization
- project isolation
- R2 access
- D1 queries
- GitHub OAuth
- webhooks
- MCP authentication
- artifact downloads
- local sync
- path traversal
- SSRF
- secret handling

Create:

docs/ai/security-audit.md

Fix critical/high-risk findings.

Do not introduce unrelated refactors.
```

---

# 28. Phase 16 — Free-Tier Audit

## Prompt 23

```text
Audit the application against the current free-tier constraints of:

- Cloudflare Workers
- Pages
- D1
- R2
- GitHub Actions

Look for:

- polling
- repeated graph builds
- duplicate uploads
- excessive database scans
- unnecessary Worker requests
- duplicate artifact storage

Create:

docs/ai/free-tier-audit.md

Optimize the design without reducing correctness.
```

---

# 29. Phase 17 — End-to-End Test

## Prompt 24

```text
Run the complete end-to-end scenario:

1. Admin signs in.
2. Admin creates Payments Platform.
3. Admin connects GitHub.
4. Admin uploads architecture.
5. Admin uploads refund ADR.
6. Graph v1 is created from commit A.
7. Admin invites developer.
8. Developer accepts.
9. Developer syncs local context.
10. Developer connects Pi.
11. Developer asks for refund retry support.
12. Pi retrieves targeted context.
13. Developer implements feature.
14. Git commit B is created.
15. Graph v2 is generated.
16. Graph v2 is published.
17. Developer detects stale graph.
18. Developer syncs v2.
19. Graph v1 remains intact.
20. Snapshot records Git + graph + artifact versions.

Verify every step.

Create an end-to-end test/report.
```

---

# 30. Final Architecture Review

## Prompt 25

```text
Perform a final architecture review.

Check the implementation against:

PRD
docs/ai/architecture.md
docs/ai/security.md

Verify:

- Git remains source of truth
- Graphify remains derived
- graph versions are immutable
- no graph merge logic exists
- artifacts are versioned
- permissions are enforced
- MCP is provider-neutral
- Pi integration is lightweight
- context is bounded
- provenance exists
- local sync is safe
- free-tier architecture is preserved

Identify deviations.

Do not make speculative improvements.
```

---

# 31. Final Product Review Prompt

```text
Act as a product QA reviewer.

Review the application as a real developer would.

Test:

- create project
- connect Git
- upload architecture
- upload ADR
- invite teammate
- assign viewer/editor/admin
- generate graph
- inspect graph
- sync local graph
- search context
- query graph
- connect Pi
- create snapshot
- inspect audit

Focus on:

- clarity
- reliability
- token efficiency
- security
- developer experience

List:
PASS
FAIL
BLOCKED
NICE TO HAVE

Do not rewrite working architecture merely for aesthetics.
```

---

# 32. AI Development Rules

During every coding task:

### Rule A — One feature at a time

Do not mix:

- authentication
- Graphify
- MCP
- frontend redesign
- billing
- infrastructure

in the same task.

### Rule B — Read before editing

First inspect the files relevant to the task.

### Rule C — Keep task context small

Use:

```text
PRD section
+
architecture section
+
relevant files
+
tests
```

not the entire knowledge base.

### Rule D — Review diffs

Always run:

```text
git diff
tests
typecheck
lint
build
```

as appropriate.

### Rule E — No speculative infrastructure

If a service isn't required, don't add it.

---

# 33. Suggested AI Session Pattern

For an implementation task:

```text
You are implementing [TASK].

Read only:

- relevant section of PRD
- relevant section of architecture
- relevant files
- relevant tests

Do not inspect unrelated packages unless necessary.

Before editing:
1. identify implementation files
2. identify tests
3. state assumptions

Implement.

After editing:
1. run tests
2. run typecheck
3. run lint
4. inspect git diff
5. report changed files
6. report any architectural impact

Do not refactor unrelated code.
```

---

# 34. Branch/Checkpoint Strategy

Prefer:

```text
feature/project-foundation
feature/artifacts
feature/git
feature/graphify
feature/context-engine
feature/mcp
feature/pi
```

Create a checkpoint after each completed phase.

---

# 35. Documentation Policy

Every significant architectural decision should create or update an ADR.

Example:

```text
docs/adr/0001-graph-as-derived-artifact.md
docs/adr/0002-context-mcp.md
docs/adr/0003-local-first-sync.md
```

Do not put the full explanation into `AGENTS.md`.

---

# 36. Product Success Metrics

Measure:

### Context efficiency
- average context tokens per task
- irrelevant context ratio
- Graphify response size
- artifact retrieval size

### Reliability
- graph build success rate
- sync success rate
- failed update preservation
- artifact conflict rate

### Developer experience
- time to connect project
- time to onboard developer
- number of manual context-paste actions avoided

### Infrastructure
- Worker requests/project
- D1 reads/writes/project
- R2 storage/project
- GitHub Actions minutes/project

---

# 37. Long-Term AI Workflow

Eventually the ideal developer workflow is:

```text
Developer
   ↓
Pi / Cursor / Claude / other agent
   ↓
Context MCP
   ↓
Context Engine
   ├── Graphify
   ├── Artifacts
   ├── Architecture maps
   ├── Git metadata
   └── Snapshots
   ↓
small relevant context
   ↓
LLM
```

The developer should almost never need to manually explain the project's architecture again.

---

# 38. Final Guiding Principle

Build the product so that the answer to:

> "How do I teach another AI everything about this repository?"

is not:

> "Give it a giant prompt."

Instead:

> "Connect it to Context Hub and let it query the right context."


# Multi-Project Implementation Tasks

## Task A — Workspace and Multi-Project Foundation

```text
Before implementing MCP, implement the tenant hierarchy.

Requirements:
- one user can belong to multiple workspaces;
- one workspace can contain multiple projects;
- one user can have different project roles;
- project membership remains the authorization boundary;
- workspace-level context is optional and separate from project context;
- repository identities are normalized for project auto-discovery.

Add database migrations, typed models, API helpers, authorization helpers, and tests.

Do not implement MCP yet.
```

### Required tests

- user in two workspaces;
- user in multiple projects;
- workspace membership without project membership does not grant project access;
- unauthorized project cannot be queried;
- repository remote resolves the correct project;
- ambiguous repository match requires explicit project selection.

## Task B — Universal Multi-Project MCP

```text
Implement ONE authenticated Context Hub MCP endpoint.

Endpoint:
https://api.example.com/mcp

Do not create one MCP configuration/server per project.

Initial tools:
- project_info
- search_context
- get_artifact
- query_graph
- get_sources
- sync_status

Project scope preference:
1. repository identity from local agent integration;
2. explicit project selection;
3. explicit cross-project request.

For every project scope:
- authenticate user;
- verify workspace access;
- verify project membership;
- verify role;
- then retrieve context.

For cross-project queries, authorize every project independently.

Do not leak inaccessible project names, metadata, graph nodes, artifact names, or source paths.

Keep MCP schemas small and stable regardless of project count.
```

### MCP tests

Test:

1. one user / many projects;
2. one workspace / many projects;
3. automatic project selection from Git remote;
4. explicit project switching;
5. unauthorized project access;
6. cross-project authorized query;
7. cross-project partially unauthorized query;
8. unchanged MCP tool count with many projects.

## Task C — Automatic Project Resolution in Pi

```text
Implement repository-aware Context Hub project resolution in the Pi integration.

When Pi starts in a repository:
- read the Git remote locally;
- normalize it;
- resolve the Context Hub project;
- cache the selected project locally;
- expose project status in local UI.

If zero matches exist, report that Context Hub is not connected for the repository.
If multiple matches exist, require explicit selection.

Do not add a large permanent prompt and do not add unnecessary LLM tools.
```

## Task D — Cross-Project Context

```text
Implement explicit cross-project context retrieval.

Input:
- authorized project IDs
- query
- overall token/size budget

Process:
- independently authorize every requested project;
- query each project's context sources;
- preserve project provenance;
- deduplicate results;
- apply one overall budget.

Never leak data from an unauthorized project.
```

# Multi-Project End-to-End Scenario

```text
1. Alice belongs to Workspace Acme.
2. Acme has Payments, Identity and Mobile projects.
3. Alice can access Payments and Identity.
4. Alice cannot access Mobile.
5. Alice launches Pi in Payments.
6. The local Git remote resolves Payments automatically.
7. Pi searches refund context.
8. Only Payments context is returned.
9. Alice switches to Identity repository.
10. Context automatically resolves Identity.
11. Alice requests a Payments + Identity architecture query.
12. Both projects are authorized, so bounded context from both is returned.
13. Alice attempts Payments + Mobile.
14. Mobile authorization fails and no Mobile metadata is leaked.
15. MCP tool count remains unchanged.
```

# Multi-Project Token Audit

```text
Measure MCP schema size with:
- 1 project
- 10 projects
- 100 projects

The model-facing schema footprint should remain effectively constant.
Project count must not be represented by duplicating MCP tools or schemas.

Also measure context response size for:
- single-project query
- two-project query
- rejected unauthorized project query
```
