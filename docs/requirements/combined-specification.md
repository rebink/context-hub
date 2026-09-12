# Context Hub — Updated Documentation Bundle

This bundle contains the latest versions of the PRD, technical architecture, and AI implementation playbook.

---

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


---

# Context Hub — Technical Architecture & Design

## 1. Architecture Goals

The architecture must optimize for:

1. Correctness
2. Simplicity
3. Security
4. Minimal AI context/token usage
5. Free-tier compatibility
6. Team collaboration
7. Reproducibility
8. Provider neutrality
9. Local/offline usability
10. Maintainability

---

# 2. System Overview

```text
                         WEB APPLICATION
                         Cloudflare Pages
                                │
                                ↓
                        Cloudflare Workers
                                │
             ┌──────────────────┼──────────────────┐
             ↓                  ↓                  ↓
             D1                 R2              GitHub
          metadata          artifacts/graph     OAuth/API
             │                  │
             └──────────────────┼──────────────────┘
                                ↓
                        Context Control Plane
                                │
              ┌─────────────────┼─────────────────┐
              ↓                 ↓                 ↓
           Artifacts         Graphify             Git
              │                 │                 │
              └─────────────────┼─────────────────┘
                                ↓
                         Context Engine
                                ↓
                          Context MCP
                                ↓
                ┌───────────────┼───────────────┐
                ↓               ↓               ↓
               Pi            Claude          Cursor
```

---

# 3. Source of Truth Rules

### Git

Source of truth for source code.

### Artifacts

Source of truth for team-maintained reference documents.

### Graphify

Derived structural representation of code/docs.

### Context Hub metadata

Source of truth for:

- project membership
- permissions
- artifact versions
- graph versions
- sync state
- snapshots
- audit history

---

# 4. Graph Model

Graphify output must be treated as an immutable build artifact.

```text
Git commit
    ↓
Graphify build
    ↓
Graph validation
    ↓
SHA-256 checksum
    ↓
R2 object
    ↓
D1 graph metadata
```

Graph version metadata:

```text
graph_versions
-----------------------------
id
project_id
version
source_commit_sha
graphify_version
storage_key
checksum
node_count
edge_count
status
generated_at
generated_by
```

Graph statuses:

```text
QUEUED
BUILDING
READY
FAILED
SUPERSEDED
```

---

# 5. No Graph Merge Model

Never merge graph JSONs.

Never let a user upload a replacement for an existing graph version.

The only valid operation is:

```text
new repository state
        ↓
new graph version
```

This makes graph synchronization deterministic.

---

# 6. Object Storage

Use R2 for large immutable objects.

Suggested layout:

```text
projects/{projectId}/
    artifacts/
        {artifactId}/
            v/{version}/content

    graphs/
        v/{graphVersion}/graph.json

    snapshots/
        {snapshotId}/manifest.json
```

All immutable objects should be content-addressable or otherwise protected by checksum/version metadata.

---

# 7. D1 Schema

Suggested tables:

### users

```text
id
provider
provider_user_id
username
display_name
avatar_url
created_at
last_login_at
```

### projects

```text
id
name
slug
description
created_by
status
created_at
updated_at
```

### git_connections

```text
id
project_id
provider
repository_url
owner
repository_name
default_branch
credential_reference
last_known_commit_sha
created_at
updated_at
```

### project_members

```text
project_id
user_id
role
invited_by
created_at
```

### artifacts

```text
id
project_id
type
name
description
current_version
status
created_at
updated_at
```

### artifact_versions

```text
id
artifact_id
version
storage_key
checksum
source_commit_sha
created_by
created_at
change_note
```

### graph_versions

```text
id
project_id
version
source_commit_sha
graphify_version
storage_key
checksum
node_count
edge_count
status
generated_by
generated_at
```

### context_snapshots

```text
id
project_id
name
git_sha
graph_version
created_by
created_at
```

### snapshot_artifacts

```text
snapshot_id
artifact_id
artifact_version
```

### sync_states

```text
project_id
client_id
local_git_sha
local_graph_version
remote_graph_version
status
last_sync_at
```

### audit_events

```text
id
project_id
actor_id
action
target_type
target_id
metadata
created_at
```

---

# 8. Indexing

Indexes should exist for:

- project membership lookup
- artifacts by project/type
- artifact versions by artifact
- latest graph by project
- graph by source commit
- snapshots by project
- audit events by project/time
- sync state by project/client

Avoid table scans.

---

# 9. Authentication

Initial provider:

GitHub OAuth.

Use secure server-side sessions.

Never expose provider secrets to the browser.

Design authentication behind an interface so additional providers can be added later.

---

# 10. Authorization

Every protected request:

```text
Authenticate user
        ↓
Load project
        ↓
Verify membership
        ↓
Check role
        ↓
Authorize operation
        ↓
Execute
```

Never trust project/user/role values supplied by the browser.

---

# 11. Artifact Version Conflict

Artifacts use optimistic concurrency.

Example:

```text
Current version = 5

User A edits based on 5
User B publishes 6

User A submits change based on 5
        ↓
VERSION_CONFLICT
```

Never silently overwrite version 6.

---

# 12. Graph Build Lifecycle

State machine:

```text
QUEUED
  ↓
BUILDING
  ├────→ FAILED
  ↓
READY
  ↓
SUPERSEDED
```

A failed build never replaces the last READY version.

---

# 13. Graph Sync Lifecycle

Client compares:

```text
localGitSha
localGraphSha
remoteGitSha
remoteGraphSha
```

Decision matrix:

### Same commit, same graph

```text
CURRENT
```

### Local graph source commit older

```text
GRAPH_STALE
```

### Local repository ahead of published graph

```text
LOCAL_REPOSITORY_AHEAD
```

### Server has newer graph

```text
REMOTE_GRAPH_AHEAD
```

### No local graph

```text
NO_LOCAL_GRAPH
```

### Build in progress

```text
GRAPH_BUILDING
```

---

# 14. Atomic Local Graph Replacement

Algorithm:

```text
download graph
verify HTTP response
verify checksum
verify graph metadata
verify source commit
write temporary file
fsync where appropriate
rename atomically
update manifest
```

On failure, preserve the previous valid graph.

---

# 15. Context Engine

The Context Engine has four conceptual layers.

### Layer 1 — Retrieval

Find candidates from:

- artifact metadata
- artifact full text
- Graphify
- Git
- architecture maps

### Layer 2 — Ranking

Prioritize:

- direct task relevance
- source-backed evidence
- architecture relevance
- current versions
- exact package/domain match

### Layer 3 — Budgeting

Limit output according to token/size budget.

### Layer 4 — Provenance

Attach source/path/version/commit information.

---

# 16. Context Retrieval Pipeline

Example:

```text
Task:
"Add refund retry support"

             ↓
Identify domain:
payments/refunds

             ↓
Artifact candidates:
payment architecture
refund ADR
refund contract

             ↓
Graphify:
RefundService
RefundRepository
PaymentGateway
RefundCreated

             ↓
Exact sources:
RefundService.ts
RefundRepository.ts
refund events

             ↓
Rank + deduplicate

             ↓
Apply token budget

             ↓
Return compact context pack
```

---

# 17. Token Budget Strategy

Every retrieval request should accept a budget.

Example:

```json
{
  "query": "refund retry",
  "budget": 5000
}
```

The engine should prefer:

- fewer irrelevant files
- concise relevant excerpts
- precise graph evidence
- direct source references

over volume.

---

# 18. Context MCP Architecture

The MCP server should sit above Graphify.

```text
Agent
  ↓
Context MCP
  ↓
Context Engine
  ├── Graphify
  ├── Artifact store
  ├── Git metadata
  └── project metadata
```

Recommended initial tool surface:

```text
project_info
search_context
get_artifact
query_graph
get_sources
sync_status
```

Do not expose every underlying internal operation.

---

# 19. MCP Authentication

Authentication should establish:

```text
user
project
role
```

before serving context.

A context endpoint must never be a public unauthenticated gateway into private repositories or artifacts.

---

# 20. Pi Integration

Pi integration should be thin.

Possible implementation:

```text
Pi extension
    ↓
Context API / MCP
    ↓
Context Hub
```

The extension should not:

- modify system prompt heavily
- inject all artifacts
- register unnecessary tools
- duplicate Graphify logic

---

# 21. Local Client

Suggested local state:

```text
~/.context-hub/
    credentials/
    config.json

project/.ai-context/
    manifest.json
    graph/
    artifacts/
    cache/
```

Use secure credential storage where possible.

---

# 22. GitHub Actions

Preferred graph generation workflow:

```text
push/main merge
    ↓
GitHub Action
    ↓
checkout repo
    ↓
Graphify
    ↓
validate
    ↓
checksum
    ↓
upload graph
    ↓
publish graph metadata
```

Avoid generating a duplicate graph when the commit is already indexed.

---

# 23. Webhook Flow

Optional for MVP, recommended soon after:

```text
GitHub webhook
      ↓
authenticate webhook
      ↓
identify project
      ↓
record commit
      ↓
schedule graph build
```

Never run long graph builds directly inside the webhook request lifecycle.

---

# 24. Snapshot Model

A snapshot should reference existing versions rather than copying all contents.

```text
Snapshot
  git_sha
  graph_version
  artifact_versions[]
```

This makes snapshots cheap and reproducible.

---

# 25. Freshness Model

Artifact freshness can be:

```text
CURRENT
STALE
UNKNOWN
```

Possible heuristic:

- artifact created against current/known commit → current
- artifact references older commit → stale candidate
- no provenance → unknown

Do not automatically rewrite artifacts.

---

# 26. Security Threat Model

Threats include:

- unauthorized project access
- artifact data leakage
- Git credential theft
- malicious webhooks
- MCP abuse
- SSRF through repository endpoints
- object storage URL leakage
- path traversal
- malicious uploaded files
- broken role enforcement
- cross-project access
- replayed sync operations

Mitigations:

- server-side authorization
- secure secret storage
- signed/authenticated downloads
- checksum verification
- webhook signature validation
- allow-list repository providers
- careful URL handling
- audit events
- rate limits
- least privilege

---

# 27. Free Infrastructure Architecture

Use:

```text
Cloudflare Pages
Cloudflare Workers
Cloudflare D1
Cloudflare R2
GitHub OAuth
GitHub Actions
```

Use R2 for large immutable files.

Use D1 for metadata.

Avoid mandatory paid services.

---

# 28. Cloudflare Design Constraints

Design to reduce:

- Worker requests
- D1 full scans
- repeated writes
- duplicate graph builds
- duplicate uploads
- polling

Prefer:

- event-driven triggers
- caching
- indexes
- immutable objects
- content hashes
- commit-based deduplication

---

# 29. API Structure

Suggested endpoints:

```text
POST   /projects
GET    /projects
GET    /projects/:id

POST   /projects/:id/git
GET    /projects/:id/git
POST   /projects/:id/git/sync

GET    /projects/:id/artifacts
POST   /projects/:id/artifacts
GET    /projects/:id/artifacts/:id
GET    /projects/:id/artifacts/:id/versions

GET    /projects/:id/graphs
GET    /projects/:id/graphs/latest
GET    /projects/:id/graphs/:version
POST   /projects/:id/graphs/build

GET    /projects/:id/context/search
GET    /projects/:id/context/relevant

GET    /projects/:id/team
POST   /projects/:id/team/invite
PATCH  /projects/:id/team/:userId
DELETE /projects/:id/team/:userId

GET    /projects/:id/snapshots
POST   /projects/:id/snapshots

GET    /projects/:id/activity
```

---

# 30. Provider Interfaces

Keep interfaces around:

```text
GitProvider
ObjectStorage
AuthProvider
GraphProvider
ContextProvider
McpTransport
```

This allows later replacement of infrastructure or Git providers.

---

# 31. Repository Structure

Recommended monorepo:

```text
context-hub/
├── apps/
│   ├── web/
│   └── api/
│
├── packages/
│   ├── core/
│   ├── db/
│   ├── auth/
│   ├── storage/
│   ├── git/
│   ├── graphify/
│   ├── context-engine/
│   ├── mcp/
│   └── pi-integration/
│
├── docs/
│   ├── product/
│   ├── architecture/
│   └── ai/
│
├── .github/
│   └── workflows/
│
└── .ai-context/
```

---

# 32. Observability

Monitor:

- API errors
- graph build failures
- sync failures
- artifact conflicts
- MCP calls
- context retrieval size
- graph generation duration

Never log:

- secrets
- OAuth tokens
- private repository credentials
- unnecessary artifact contents

---

# 33. Performance Goals

Initial goals:

- project dashboard: <2 seconds for normal cached requests
- artifact metadata: near-instant
- context retrieval: bounded and predictable
- local graph queries: local/fast
- graph update: asynchronous
- sync should not block normal Pi usage

Do not let large graph generation block user-facing requests.

---

# 34. MVP Development Principle

Implement vertical slices.

Recommended sequence:

```text
Auth
 ↓
Projects
 ↓
Artifacts
 ↓
Git
 ↓
Graphify
 ↓
Graph storage/versioning
 ↓
Sync
 ↓
Context Engine
 ↓
MCP
 ↓
Pi
 ↓
Snapshots
 ↓
Team/Audit
 ↓
Optimization
```

---

# 35. Acceptance Criteria

The MVP is successful when:

- project can be created
- GitHub can be connected
- artifacts can be versioned
- team roles work
- Graphify versions are immutable
- graph provenance is recorded
- local graph can sync safely
- context can be searched
- graph can be queried
- Pi can consume project context
- snapshots are reproducible
- unauthorized access is blocked
- context retrieval is bounded
- infrastructure can run on free services


# Multi-Project Architecture

## Tenant hierarchy

```text
Account
  ↓
Workspace
  ↓
Project
  ↓
Repository
  ├── Graphify versions
  ├── Artifacts
  ├── Snapshots
  └── Sync state
```

A single account may belong to multiple workspaces. A workspace may contain multiple projects. A user may have different roles in different projects.

## Data model additions

### workspaces

```text
id
name
slug
created_by
created_at
updated_at
```

### workspace_members

```text
workspace_id
user_id
role
created_at
invited_by
```

### repository_identities

```text
id
provider
canonical_url
owner
repository_name
```

Repository identity must normalize SSH/HTTPS Git remote forms so local automatic project resolution is reliable.

## Universal MCP

Use one multi-tenant endpoint:

```text
POST /mcp
GET  /mcp
```

Authentication establishes the user identity. Project selection establishes scope. Authorization independently verifies membership and role.

### Request flow

```text
MCP request
   ↓
authenticate
   ↓
identify workspace
   ↓
resolve project
   ↓
verify project membership
   ↓
apply role permissions
   ↓
Context Engine
   ↓
bounded response
```

Do not create one MCP server per project as the default design.

## Project resolution

Preferred:

```text
local Git remote
      ↓
canonical repository identity
      ↓
matching project
```

Fallback:

```text
explicit project selection
```

If there are multiple matching projects, require explicit selection.

## Cross-project retrieval

For a request involving multiple projects:

```text
cross_project_context(
  projects=[payments, identity],
  query="How does Payments authenticate with Identity?"
)
```

The server must authorize each project independently before reading anything.

The result must preserve project provenance and respect one overall response/token budget.

Never leak inaccessible project metadata.

## Workspace context

Workspace-level context is optional. It should be a retrieval source rather than a permanent large system prompt.

## MCP tool stability

Keep the following model-facing tool surface stable:

```text
project_info
search_context
get_artifact
query_graph
get_sources
sync_status
```

The number of projects must not increase the number or size of MCP schemas.

## Multi-project API examples

```text
GET /me/projects
GET /workspaces/:workspaceId/projects
GET /projects/resolve?repository=<canonical-repository>
POST /projects/:projectId/context/search
POST /context/cross-project/search
```

The server performs authorization even when the client supplies project IDs.

## Multi-project acceptance criteria

1. One user can access many projects.
2. One workspace can contain many projects.
3. One MCP endpoint serves all authorized projects.
4. Local Git repository can select the active project.
5. Explicit project selection works.
6. Cross-project queries are explicit and authorized.
7. Graph and artifact retrieval are always project-scoped.
8. MCP tool schemas do not grow with project count.


---

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
