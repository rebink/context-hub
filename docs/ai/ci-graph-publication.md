# CI graph publication setup

Phase 10 uses `.github/workflows/graphify.yml` only through manual `workflow_dispatch`. The canonical public-repository workflow runs on exact GitHub-hosted `ubuntu-24.04`; it does not use a webhook and cannot run Graphify in the Worker.

## Project setup

1. Connect and sync the exact GitHub repository, reserve a graph build as a current project ADMIN, then issue a machine credential with `POST /projects/{projectId}/machine-credentials`. Store the returned `token` immediately; it is never available again.
2. Put `CONTEXT_HUB_MACHINE_TOKEN` in the protected `context-hub-graphify` GitHub Environment. Add a read-only `CONTEXT_HUB_SOURCE_TOKEN` limited to the bound source repository. Set `CONTEXT_HUB_API_URL`, `CONTEXT_HUB_TOOLING_REPOSITORY`, and `CONTEXT_HUB_TOOLING_SHA` as protected Environment variables. The tooling repository is Context Hub and the tooling SHA is a reviewed full 40-hex release commit; neither may come from dispatch input.
3. Run the workflow from the trusted Context Hub repository and dispatch `Publish Graphify graph` with the exact source `owner/repository`, queued version, lowercase commit, `github`, and stable GitHub repository ID. The workflow verifies the source repository ID through GitHub before checkout. The API rejects any mismatch and the complete build identity prevents duplicate unchanged builds.
4. Rotate with `POST /projects/{projectId}/machine-credentials/{credentialId}/rotate` and replace the secret before the next run. Revoke with `DELETE` immediately on membership or secret compromise.

Issue and rotate JSON is bounded to `name` (1-80 characters) and `expiresInDays` (1-90). Lists return at most 50 records and never return secret hashes.

## Canonical hosted runner contract

The protected Environment gates secrets and variables before the job runs. The workflow itself sets `CONTEXT_HUB_RUNNER_MODE=github-hosted`, `CONTEXT_HUB_RUNNER_ENVIRONMENT=${{ runner.environment }}`, and `CONTEXT_HUB_EXPECTED_RUNNER_LABEL=ubuntu-24.04`; these are not Environment variables to configure manually.

Before claiming a build, `scripts/graphify-ci.ts` fails closed unless the runner attests all of: `GITHUB_ACTIONS=true`, `runner.environment=github-hosted`, `RUNNER_OS=Linux`, `RUNNER_ARCH=X64`, expected label `ubuntu-24.04`, and `ImageOS=ubuntu24`. It also requires the checkout to remain beneath `GITHUB_WORKSPACE` and verifies at least 2 GiB workspace capacity. A mismatch fails before the claim.

GitHub provides the ephemeral hosted VM isolation and the workflow enforces the 30-minute job timeout. Those are vendor-enforced controls, not a claim that the workflow can attest a configurable cgroup or hard filesystem ceiling. The workflow still retains application-enforced source/input/output/temp/repository byte and count bounds, GraphifyAdapter subprocess timeouts and detached process-group termination, trusted absolute executable checks, clean tracked-file checks, and bounded publication retries.

The workflow separately checks out the untrusted source commit and the protected full-SHA Context Hub tooling revision. It runs npm, the runner script, and `GraphifyAdapter` only from the trusted tooling checkout. It installs `packages/graphify-adapter/python/requirements-linux-x86_64-py312.lock` with `--only-binary=:all: --require-hashes`, verifies Graphify 0.9.58, and lets `GraphifyAdapter` enforce clean tracked-file and output rules. Dispatch values reach shell validation only through quoted environment variables. Ambiguous publication responses retry the same bytes with fresh nonces so Phase 9 exact replay can recover; definite failures alone report the claimed attempt failed. Do not add caches, mutable dependency ranges, alternate Python minors, container images, or unpinned Actions without a reviewed lock/profile update.

## Inactive future self-hosted fallback

Oracle Free Tier self-hosting is not the canonical workflow and has no active deployment instruction. If separately approved later, it must select `CONTEXT_HUB_RUNNER_MODE=self-hosted` and provide `CONTEXT_HUB_MEMORY_CGROUP`. That inactive mode retains the cgroup-v2 numeric `memory.max` 1-8 GiB and dedicated 2-16 GiB filesystem attestations. It requires a separate runner/isolation decision, workflow change, protected-environment review, and live evidence; it must not be inferred from this hosted setup.

## Release blockers and verification

This repository can validate lock metadata, hosted-runner workflow assumptions, and the fail-closed runner-mode contract locally. It cannot prove a live GitHub-hosted execution, Environment protection, ephemeral isolation, timeout enforcement, provider log redaction, or publication. Before enabling the Environment, capture a protected hosted-runner execution proving:

- GitHub-hosted/Linux/X64/Ubuntu-24.04 context attestation, minimum workspace capacity, timeout, and failure reporting;
- every locked wheel installs under CPython 3.12 with hashes and no source build;
- representative repository duration, workspace use, and Actions usage remain within the approved profile;
- exact commit checkout, successful machine claim/publication, nonce replay denial, and remote D1/R2 idempotent retry; and
- secret/header/body redaction from Actions, Worker, and platform logs.

Until that evidence exists, leave the protected Environment without approval or secret access. The workflow intentionally fails closed rather than treating local mock evidence as live release evidence.
