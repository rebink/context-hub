# CI graph publication setup

Phase 10 uses `.github/workflows/graphify.yml` only on a dedicated self-hosted Linux x86-64 runner. It does not use a webhook and cannot run Graphify in the Worker.

## Project setup

1. Connect and sync the exact GitHub repository, reserve a graph build as a current project ADMIN, then issue a machine credential with `POST /projects/{projectId}/machine-credentials`. Store the returned `token` immediately; it is never available again.
2. Put the token in the protected `context-hub-graphify` GitHub Environment as `CONTEXT_HUB_MACHINE_TOKEN`. Add a read-only `CONTEXT_HUB_SOURCE_TOKEN` that can read only the bound source repository. Set `CONTEXT_HUB_API_URL`, `CONTEXT_HUB_MEMORY_CGROUP`, `CONTEXT_HUB_TOOLING_REPOSITORY`, and `CONTEXT_HUB_TOOLING_SHA` as protected Environment variables. The tooling repository is Context Hub and the tooling SHA is a reviewed full 40-hex release commit; neither may come from dispatch input.
3. Run this workflow from the trusted Context Hub repository and dispatch `Publish Graphify graph` with the exact source `owner/repository`, queued version, lowercase commit, `github`, and stable GitHub repository ID. The workflow verifies the source repository ID through GitHub before checkout. The API rejects any mismatch and the complete build identity prevents duplicate unchanged builds.
4. Rotate with `POST /projects/{projectId}/machine-credentials/{credentialId}/rotate` and replace the secret before the next run. Revoke with `DELETE` immediately on runner, membership, or secret compromise.

Issue and rotate JSON is bounded to `name` (1-80 characters) and `expiresInDays` (1-90). Lists return at most 50 records and never return secret hashes.

## Runner contract

The runner must carry labels `self-hosted`, `linux`, and `x64`, and be dedicated to the protected `context-hub-graphify` Environment, disposable, or reset after each job. Install native Git, GitHub CLI, Node 22+, npm, and a regular non-symlink Python 3.12 used to create the locked virtual environment. Restrict outbound traffic to GitHub, npm, PyPI files used by the lock, and the configured Context Hub API.

Run the Actions worker itself inside a cgroup-v2 leaf with numeric `memory.max` between 1 GiB and 8 GiB. Set `CONTEXT_HUB_MEMORY_CGROUP` to its exact `/proc/self/cgroup` path (for example `/context-hub/runner-1`). Mount the complete `GITHUB_WORKSPACE` filesystem on a dedicated 2-16 GiB filesystem; `statfs` total size is the disk limit attested by the runner. The source checkout, Python environment, and external Graphify output all remain on that filesystem. A shared or larger root filesystem is rejected even when free space happens to be low.

The workflow separately checks out the untrusted source commit and the protected full-SHA Context Hub tooling revision. It runs npm, the runner script, and `GraphifyAdapter` only from the trusted tooling checkout. It installs `packages/graphify-adapter/python/requirements-linux-x86_64-py312.lock` with `--only-binary=:all: --require-hashes`, verifies Graphify 0.9.58, and lets `GraphifyAdapter` enforce clean tracked-file and output rules. Dispatch values reach shell validation only through quoted environment variables. Ambiguous publication responses retry the same bytes with fresh nonces so Phase 9 exact replay can recover; definite failures alone report the claimed attempt failed. Do not add caches, mutable dependency ranges, alternate Python minors, container images, or unpinned Actions without a reviewed lock/profile update.

## Release blockers and verification

This repository can validate the lock metadata and workflow assumptions locally, but this macOS checkout cannot attest a Linux cgroup-v2 process, the dedicated filesystem mount, or a live GitHub Actions installation/publication. Before enabling the environment, capture one disposable-runner execution proving:

- every locked wheel installs under CPython 3.12 with hashes and no source build;
- cgroup membership and numeric `memory.max`, bounded workspace `statfs`, timeout, and failure reporting;
- representative repository peak memory, disk, duration, and Actions minutes below the configured limits;
- exact commit checkout, successful machine claim/publication, nonce replay denial, and remote D1/R2 idempotent retry; and
- secret/header/body redaction from Actions, Worker, and platform logs.

Until that evidence exists, leave the protected environment without approval or secret access. The workflow intentionally fails closed rather than treating local mock evidence as live release evidence.
