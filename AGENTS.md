# Context Hub Agent Guide

- Read `docs/ai/project-discovery.md` and `docs/ai/architecture.md` before changing code.
- Treat Git as code truth, D1 as metadata truth, and R2 objects as immutable payloads.
- Every project-scoped request must authenticate, resolve the project, verify membership, and check the role on the server.
- Keep responses bounded and preserve source, version, commit, checksum, and project provenance.
- Do not implement a later playbook phase before `test`, `typecheck`, `lint`, and `build` pass.
