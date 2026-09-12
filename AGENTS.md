# Context Hub Agent Guide

- Read `docs/ai/project-discovery.md` and `docs/ai/architecture.md` before changing code.
- Treat Git as code truth, D1 as metadata truth, and R2 objects as immutable payloads.
- Every project-scoped request must authenticate, resolve the project, verify membership, and check the role on the server.
- Keep responses bounded and preserve source, version, commit, checksum, and project provenance.
- Do not implement a later playbook phase before `test`, `typecheck`, `lint`, and `build` pass.
- Use exactly one independent review per phase. Do not launch separate layer reviews or repeat a broad review after fixes.
- Review only the phase diff after implementation and targeted tests. The reviewer must report all P0/P1 blockers in one pass; record P2 findings in the backlog.
- If review blocks, fix all P0/P1 findings in one consolidated pass, add regression evidence, and run the full phase gate. Do not launch a second reviewer; the implementation owner verifies the bounded findings against tests and the gate.
- Keep one writer per phase. Use parallel read-only agents only for genuinely independent work, reuse existing agent context, and avoid duplicate repository-wide analysis.
- Run targeted checks while implementing, then one full phase gate after review/fixes. Create a Git checkpoint after the gate so the next phase and its reviewer operate on a focused diff.
