import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MachineRequestError, retryAmbiguousPublish } from "../../../scripts/graphify-ci.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));

async function text(path: string) {
  return readFile(`${root}/${path}`, "utf8");
}

describe("canonical graph workflow assumptions", () => {
  it("pins Actions, uses least privilege, and requires the bounded self-hosted runner", async () => {
    const workflow = await text(".github/workflows/graphify.yml");
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s]+)$/gm)].map((match) => match[1]);
    assert.ok(uses.length >= 1);
    for (const action of uses) assert.match(action ?? "", /@[0-9a-f]{40}$/);
    assert.match(workflow, /permissions:\n\s+contents: read/);
    assert.match(workflow, /runs-on: \[self-hosted, linux, x64\]/);
    assert.match(workflow, /environment: context-hub-graphify/);
    assert.match(workflow, /timeout-minutes: 30/);
    assert.match(workflow, /group: graphify-\$\{\{ inputs\.project_id \}\}/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.doesNotMatch(workflow, /group: graphify-.*graph_version/);
    assert.match(workflow, /--only-binary=:all: --require-hashes/);
    assert.doesNotMatch(workflow, /pull_request:|push:|repository_dispatch:|workflow_run:/);
  });

  it("separates untrusted source from pinned tooling and never interpolates inputs into shell", async () => {
    const workflow = await text(".github/workflows/graphify.yml");
    assert.match(workflow, /repository: \$\{\{ inputs\.source_repository \}\}/);
    assert.match(workflow, /repository: \$\{\{ vars\.CONTEXT_HUB_TOOLING_REPOSITORY \}\}/);
    assert.match(workflow, /ref: \$\{\{ vars\.CONTEXT_HUB_TOOLING_SHA \}\}/);
    assert.doesNotMatch(workflow, /ref: \$\{\{ inputs\.commit \}\}\n\s+path: tooling/);
    for (const block of workflow.matchAll(/run: \|\n([\s\S]*?)(?=\n\s{6}- name:|\s*$)/g))
      assert.doesNotMatch(block[1] ?? "", /\$\{\{ inputs\./);
  });

  it("retries ambiguous publication with a fresh request but not definite rejection", async () => {
    let calls = 0;
    const response = await retryAmbiguousPublish(async () => {
      calls += 1;
      if (calls < 3) throw new MachineRequestError("publish", null, true);
      return new Response(null, { status: 200 });
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 3);

    calls = 0;
    await assert.rejects(
      retryAmbiguousPublish(async () => {
        calls += 1;
        throw new MachineRequestError("publish", 409, false);
      }),
      /Machine publish failed/,
    );
    assert.equal(calls, 1);
  });

  it("locks every resolved Python runtime package to one version and SHA-256", async () => {
    const lock = await text(
      "packages/graphify-adapter/python/requirements-linux-x86_64-py312.lock",
    );
    const requirements = lock
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    assert.equal(requirements.length, 30);
    for (const requirement of requirements)
      assert.match(requirement, /^[a-z0-9-]+==[^\s]+ --hash=sha256:[0-9a-f]{64}$/);
    assert.ok(
      requirements.includes(
        "graphifyy==0.9.58 --hash=sha256:e239803288e91c723d6e30540860bd6d5a1dc3f0914b9fc1104b0233e98aaeb8",
      ),
    );
  });

  it("uses the existing adapter and checks host-enforced memory and disk identity", async () => {
    const runner = await text("scripts/graphify-ci.ts");
    assert.match(runner, /new GraphifyAdapter/);
    assert.match(runner, /\/proc\/self\/cgroup/);
    assert.match(runner, /memory\.max/);
    assert.match(runner, /statfs/);
    assert.match(runner, /operation: "claim" \| "publish" \| "fail"/);
  });
});
