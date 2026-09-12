# Context Hub — Product Requirements Document

## 1. Product Vision

Context Hub is a free-first, open-source, provider-neutral platform for managing shared AI development context for software teams working on large repositories and monorepos.

The platform combines:

- Git repository state
- Graphify structural/code knowledge
- Architecture documentation
- ADRs
- API contracts
- Coding conventions
- Domain knowledge
- Glossaries
- Runbooks
- Ownership information
- Other project artifacts

and exposes targeted context through a universal MCP interface.

### Core idea

> Make the repository and engineering knowledge queryable, not memorized.

Instead of repeatedly sending large portions of a monorepo to an AI provider, Context Hub retrieves only the context relevant to the current task.

---

## 2. Problem

Large teams using AI coding agents face:

### Context duplication
Developers repeatedly explain architecture, package boundaries, conventions, ADRs, contracts, and ownership.

### Token waste
Agents inspect irrelevant files and documentation because they lack structured project knowledge.

### Inconsistent context
Different developers and agents learn different portions of the architecture.

### Context drift
Documentation and code evolve independently.

### Agent lock-in
Project knowledge becomes tied to a specific coding agent or provider.

### Collaboration problems
Teams lack one versioned, permission-controlled source of AI development context.

---

## 3. Product Solution

Context Hub becomes the team's shared AI-context control plane.

```text
Git
 +
Graphify
 +
Team artifacts
 +
Architecture knowledge
 +
Versioning
 +
Permissions
 +
Targeted retrieval
        ↓
    Context Hub
        ↓
       MCP
        ↓
Pi / Claude / Cursor / Codex / other agents
        ↓
    Any model/provider
```

Context Hub is not itself a coding agent.

---

## 4. Target Users

### Primary
- Software developers
- Teams working on large monorepos
- Teams using AI coding agents
- Distributed engineering teams

### Secondary
- Tech leads
- Architects
- Engineering managers
- Platform/developer productivity teams

---

## 5. Core Principles

1. Git is authoritative for source code.
2. Graphify is a derived artifact.
3. Graph versions are immutable.
4. Graphify files are never collaboratively edited.
5. Artifacts are versioned.
6. Context is retrieved selectively.
7. Permanent context must stay small.
8. Provider/agent lock-in should be avoided.
9. Local/offline workflows should remain possible.
10. The MVP must use free/open-source infrastructure.
11. Every important context result should have provenance.
12. Model-token efficiency is a first-class product goal.

---

# 6. Core Product Architecture

```text
                           Context Hub
                                │
             ┌──────────────────┼──────────────────┐
             │                  │                  │
            Git             Artifacts          Graphify
             │                  │                  │
             └──────────────────┼──────────────────┘
                                │
                       Context Engine
                                │
               ┌────────────────┼────────────────┐
               │                │                │
           Retrieval         Versioning      Permissions
               │                │                │
               └────────────────┼────────────────┘
                                │
                          Context MCP
                                │
             ┌──────────────────┼──────────────────┐
             ↓                  ↓                  ↓
            Pi               Claude             Cursor
```

---

# 7. Project Model

A project contains:

- Git repository connection
- AI-context artifacts
- Graphify versions
- Team members
- Roles/permissions
- Sync state
- Context snapshots
- Audit history

---

# 8. Git

Initial provider:

- GitHub

Design provider interfaces so GitLab and Bitbucket can be added later.

Store:

- repository URL
- owner/name
- default branch
- last known commit SHA
- credential reference
- connection metadata

Git remains the source of truth for code.

Do not copy the entire repository into the application database.

---

# 9. Artifact System

Initial artifact types:

- Architecture
- ADR
- API Contract
- Coding Convention
- Domain Knowledge
- Glossary
- Database Schema
- Runbook
- Deployment Guide
- Ownership
- Security Rule
- Product Requirement
- Custom

Supported formats can include Markdown, YAML, JSON, text, PDF and diagrams where practical.

Large objects belong in object storage.

Artifacts are versioned and never silently overwritten.

---

# 10. Artifact Roles

### ADMIN
- manage project
- connect Git
- manage members
- change permissions
- create/update/delete artifacts
- trigger/publish graph builds
- configure project settings

### EDITOR
- create/update permitted artifacts
- view/query Graphify
- use project context

### VIEWER
- read artifacts
- query context
- download permitted artifacts

Viewers cannot edit artifacts.

No user manually edits Graphify data.

---

# 11. Graphify

Graphify is the structural/code intelligence layer.

It should provide access to information such as:

- package relationships
- dependency relationships
- callers/callees
- references
- shortest paths
- source locations
- relevant subgraphs

Do not rebuild Graphify's graph engine inside Context Hub.

Use the current Graphify project as an external/embedded capability.

---

# 12. Graph Lifecycle

The canonical lifecycle is:

```text
Git commit
    ↓
Graphify generation
    ↓
validation
    ↓
checksum
    ↓
publish
    ↓
immutable graph version
```

Every graph version records:

- project ID
- graph version
- source commit SHA
- Graphify version
- checksum
- generated timestamp
- generator
- status

---

# 13. Graph Conflict Model

There are no collaborative Graphify merge conflicts.

Example:

```text
Graph 41 → commit A
Graph 42 → commit B
Graph 43 → commit C
```

Each graph remains immutable.

Never use last-write-wins for graph files.

Never merge two graph JSON files.

---

# 14. Local Graph

Developers maintain a local cache:

```text
.ai-context/
├── manifest.json
├── graph/
│   ├── graph.json
│   └── meta.json
├── artifacts/
└── cache/
```

The local graph is a cache, not an editable source.

---

# 15. Sync

Compare:

- local Git SHA
- local graph SHA
- server Git SHA
- latest graph SHA

States:

- CURRENT
- GRAPH_STALE
- LOCAL_REPOSITORY_AHEAD
- REMOTE_GRAPH_AHEAD
- NO_LOCAL_GRAPH
- GRAPH_BUILDING
- GRAPH_FAILED
- COMMIT_MISMATCH

Updates must be atomic:

```text
download
→ verify checksum
→ verify commit
→ write temporary
→ atomically replace active graph
→ update manifest
```

If sync fails, keep the existing valid graph.

---

# 16. Automatic Graph Generation

Preferred workflow:

```text
Git change
   ↓
CI / Graphify
   ↓
new immutable graph
   ↓
cloud publish
   ↓
developers detect update
   ↓
local sync
```

Prefer GitHub Actions for repository-triggered builds.

Do not rebuild/upload the graph for every local keystroke.

---

# 17. Global Reference Context

Every project may have a small root `AGENTS.md`.

It should contain only high-value stable rules:

- repository structure
- architectural boundaries
- critical invariants
- important commands
- pointers to deeper documentation

It should be small, ideally a few hundred tokens rather than thousands.

The deeper knowledge must remain retrievable.

---

# 18. Recommended Knowledge Structure

```text
docs/
├── architecture/
│   ├── overview.md
│   ├── repository-structure.md
│   ├── boundaries.md
│   ├── dependency-rules.md
│   ├── data-flow.md
│   └── event-flow.md
│
├── adr/
│   ├── 0001-*.md
│   ├── 0002-*.md
│   └── ...
│
├── contracts/
├── ownership/
└── runbooks/
```

---

# 19. Architecture Maps

Support small machine-readable project maps such as:

```yaml
packages:
  billing:
    path: packages/billing
    owner: payments
    depends_on:
      - auth
      - users
      - database
    must_not_depend_on:
      - frontend
```

These maps are compact and useful for AI retrieval and validation.

---

# 20. Context Engine

The Context Engine is the central product intelligence layer.

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
- concise excerpts
- graph evidence
- source locations
- provenance
- token estimate

---

# 21. Context Retrieval Example

User asks:

> Add refund retry support.

The system should retrieve:

- payment architecture
- refund ADR
- refund API contract
- relevant Graphify relationships
- relevant source references

It should not retrieve:

- the whole repository
- the whole graph
- all ADRs
- all documentation

---

# 22. Context Budgets

Context retrieval supports explicit budgets.

Examples:

```text
Graph query: 1,500 tokens
Artifact excerpts: 3,000 tokens
Feature context pack: 5,000 tokens
```

Optimize for useful evidence per token.

---

# 23. Provenance

Every important retrieved result should identify:

- source
- version
- file/path
- line/section where possible
- commit if applicable

Example:

```text
PaymentService
Source:
packages/payments/PaymentService.ts:41

Why relevant:
Owns refund creation and is called by CheckoutService.
```

---

# 24. Context MCP

Expose a small, provider-neutral MCP surface.

Initial tools:

- project_info
- search_context
- get_artifact
- query_graph
- get_sources
- sync_status

Potential future tools:

- create_snapshot
- get_snapshot

Keep schemas small.

Avoid exposing a large collection of unnecessary tools because tool definitions themselves contribute to model context.

---

# 25. Provider Neutrality

The platform must not depend on one AI provider.

Target:

```text
Context Hub MCP
      ↓
Pi
Claude
Cursor
Codex
Gemini CLI
future agents
```

The project's context belongs to the team.

It does not belong to a model provider.

---

# 26. Pi Integration

Provide a lightweight Pi integration.

Possible commands:

```text
/context connect
/context status
/context sync
/context search payments
/context graph RefundService
/context snapshot
```

The Pi integration should:

- use native Pi extension mechanisms
- remain lightweight
- avoid large permanent prompts
- avoid injecting every artifact
- avoid adding unnecessary tools

---

# 27. Context Snapshots

A snapshot records the exact context baseline associated with a task/feature.

Example:

```text
Refund Retry Feature

Git:            abc123
Graph:          42
Architecture:   v8
ADR-17:         v3
Refund Contract: v12
```

Snapshots are immutable.

They allow the team to answer:

> What context did the AI have when this implementation was created?

---

# 28. Context Freshness

Artifacts can be stale.

Example:

```text
Architecture v8 references commit abc123
Current repository is def456
```

Display:

```text
WARNING: artifact may be stale
```

Do not silently modify the documentation.

---

# 29. Team Sharing

Admin can invite team members.

Membership:

```text
project_id
user_id
role
created_at
invited_by
```

Every API request must validate project membership server-side.

---

# 30. Web Application

The web application is the control plane.

Main navigation:

- Projects
- Activity
- Settings

Project navigation:

- Overview
- Context
- Graphify
- Git
- Team
- Snapshots
- Activity
- Settings

---

# 31. Project Dashboard

Show:

- project name
- Git repository
- branch
- current commit
- Graphify version
- graph status
- artifact count
- member count
- sync status

---

# 32. Context UI

Categories:

- Architecture
- ADRs
- Contracts
- Conventions
- Domain
- Runbooks
- Ownership
- Custom

Each artifact shows:

- current version
- author
- update timestamp
- freshness
- permissions

---

# 33. Graphify UI

Show:

- current graph version
- source commit
- Graphify version
- node count
- edge count
- checksum
- generated timestamp
- sync status
- build status

Graphify editing is never offered.

---

# 34. Graph Explorer

Support:

- search node
- inspect node
- neighbors
- callers/callees
- path
- source location

Render focused subgraphs rather than an entire graph.

---

# 35. Audit Log

Record events such as:

- project created
- Git connected
- artifact created
- artifact version created
- role changed
- member invited
- graph generated
- graph published
- graph failed
- snapshot created
- sync requested

Do not log secrets.

---

# 36. Free Infrastructure

Preferred MVP stack:

```text
Frontend:
Cloudflare Pages

API:
Cloudflare Workers

Database:
Cloudflare D1

Object storage:
Cloudflare R2

Authentication:
GitHub OAuth

CI:
GitHub Actions
```

Use D1 for metadata.

Use R2 for large artifact/graph objects.

Avoid paid mandatory infrastructure.

---

# 37. Local-first

A developer should still work when the Context Hub is unavailable.

Local:

- Git repository
- graph cache
- cached artifacts
- manifest

Online:

- reconcile
- sync
- update

---

# 38. Security

Mandatory:

- project isolation
- server-side authorization
- secure Git credentials
- authenticated artifact access
- checksum validation
- rate limiting where practical
- audit logging
- safe secret handling
- no credential exposure to browser
- no cross-project access

---

# 39. Token Efficiency

This is a core product requirement.

Never:

- inject the full repo
- inject the full graph
- inject all artifacts
- inject all ADRs
- duplicate context
- use a giant permanent prompt

Prefer:

```text
small permanent rules
+
targeted retrieval
+
bounded graph query
+
exact source references
```

---

# 40. Token Awareness

Optionally show:

```text
Context selected

Global rules:        420 tokens
Architecture:        850
Graph evidence:      620
ADR:                 430
Total:             2,320
```

This information is primarily for developers, not permanent model context.

---

# 41. Free-tier Efficiency

Use:

- caching
- batching
- indexed D1 queries
- immutable R2 objects
- event-driven sync
- commit-based graph generation
- deduplication

Never poll unnecessarily.

Never rebuild an unchanged graph.

Never upload identical graph content repeatedly.

---

# 42. MVP Scope

The first release must support:

1. Sign in
2. Create project
3. Connect GitHub
4. Add artifacts
5. Version artifacts
6. Invite team
7. Assign roles
8. Generate/store Graphify versions
9. Download local graph
10. Sync local/cloud
11. Search context
12. Query graph
13. Connect Pi
14. Create context snapshot
15. Audit history

---

# 43. Explicitly Out of MVP

Do not initially build:

- billing
- SAML/enterprise SSO
- advanced vector search
- AI-generated documentation
- full IDE replacement
- giant visual graph UI
- complex workflow engine
- multi-cloud infrastructure

---

# 44. Future Roadmap

Potential future work:

- GitLab
- Bitbucket
- multiple repositories per project
- graph diff
- architecture drift detection
- artifact approval workflow
- context quality scoring
- PR-aware context
- organization-wide context
- advanced semantic retrieval
- additional agent adapters

---

# 45. Recommended End State

```text
                         CONTEXT HUB
                              │
             ┌────────────────┼────────────────┐
             ↓                ↓                ↓
            Git           Artifacts         Graphify
             │                │                │
             └────────────────┼────────────────┘
                              ↓
                       Context Engine
                              ↓
                    relevance + provenance
                              ↓
                     bounded output
                              ↓
                         Context MCP
                              ↓
                 ┌────────────┼────────────┐
                 ↓            ↓            ↓
                Pi          Claude       Cursor
                              ↓
                         Any model
```

The product is successful when teams can connect a repository once, maintain project context once, and let many developers and coding agents retrieve the right information without repeatedly stuffing the monorepo into the model.


## Multi-Project / Multi-Workspace Architecture

Context Hub must support a user working across many projects without requiring a separate MCP configuration for every project.

### Hierarchy

```text
Account
  ↓
Workspace
  ├── Global Context
  ├── Members
  └── Projects
       ├── Git
       ├── Graphify versions
       ├── Artifacts
       ├── Snapshots
       └── Sync state
```

A user may belong to multiple workspaces and multiple projects.

### Universal MCP model

Use one authenticated MCP endpoint, for example:

```text
https://api.example.com/mcp
```

The MCP connection is account/workspace scoped, not project-exclusive.

The server resolves the effective project scope for every request using:

1. local repository identity when supplied by the client;
2. explicit project selection when necessary;
3. explicit cross-project scope for multi-repository questions.

The client should NOT require one MCP server entry per project.

### Project discovery from Git

When Pi runs inside a repository, the local integration should read the normalized Git remote and resolve it to a Context Hub project.

Example:

```text
~/code/payments
   ↓
Git remote: github.com/acme/payments
   ↓
Context Hub project: Payments
```

If multiple projects match the same repository, allow explicit selection.

### Cross-project context

Some features span projects, for example Payments communicating with Identity.

Support an explicit cross-project context request containing the requested project IDs.

Before returning any data, the server must independently authorize every project.

If a requested project is unauthorized, do not leak its existence, name, artifacts, graph nodes, source paths, or metadata.

### Workspace-level context

Workspace-level context is optional and may contain:

- organization engineering rules
- shared coding conventions
- global glossary
- security principles

Workspace context is retrievable and must remain small; it must not become a giant permanent prompt.

### MCP tool footprint

The MCP tool set must NOT increase as project count increases.

Initial tools remain:

- project_info
- search_context
- get_artifact
- query_graph
- get_sources
- sync_status

A developer with 2 projects and a developer with 50 projects should see essentially the same tool schemas.

### Multi-project acceptance criteria

- one user can belong to many projects;
- one workspace can contain many projects;
- one MCP endpoint serves all authorized projects;
- project authorization is independent of project selection;
- local repository can auto-resolve the active project;
- explicit project selection is available;
- cross-project queries are explicit and authorized;
- Graphify and artifact access are always project-scoped;
- MCP schema size does not grow with project count.


### MCP connection principle
Configure Context Hub once per account/workspace. Do not require one MCP server configuration per project.
