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
