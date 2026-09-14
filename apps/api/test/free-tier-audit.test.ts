import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

type Audit = {
  workflows: Array<{
    file: string;
    timeoutMinutes: number[];
    concurrencyGroup: string | null;
    cancelInProgress: string | null;
  }>;
  appLimits: {
    snapshotArtifacts: number;
    snapshotPage: number;
    contextArtifactCandidatesSingleProject: number;
    contextArtifactCandidatesCrossProject: number;
    contextGraphEvidenceCrossProject: number;
  };
  operationModels: {
    snapshotCreate: { d1QueriesAtMax: number };
    snapshotList: { serviceBindingOperationsAtMax: number };
    contextTwentyProjectHuman: { d1QueriesAtMax: number };
    contextTwentyProjectMcp: { d1QueriesAtMax: number; boundParametersAtMax: number };
  };
  staticEvidence: {
    productionSetIntervalCalls: number;
    graphPublishRetryAttempts: number;
    snapshotIntegrityUsesJoinedCurrentReferences: boolean;
    completeGraphIdentityDeduplication: boolean;
  };
};

function audit(): Audit {
  return JSON.parse(
    execFileSync(process.execPath, [`${root}/scripts/free-tier-audit.mjs`, "--source-only"], {
      encoding: "utf8",
    }),
  ) as Audit;
}

describe("free-tier audit", () => {
  it("derives bounded snapshot, retry, deduplication, and no-polling evidence", () => {
    const result = audit();
    assert.equal(result.appLimits.snapshotArtifacts, 20);
    assert.equal(result.appLimits.snapshotPage, 4);
    assert.ok(result.operationModels.snapshotCreate.d1QueriesAtMax <= 50);
    assert.ok(result.operationModels.snapshotList.serviceBindingOperationsAtMax <= 1_000);
    assert.equal(result.appLimits.contextArtifactCandidatesSingleProject, 15);
    assert.equal(result.appLimits.contextArtifactCandidatesCrossProject, 8);
    assert.equal(result.appLimits.contextGraphEvidenceCrossProject, 8);
    assert.ok(result.operationModels.contextTwentyProjectHuman.d1QueriesAtMax <= 50);
    assert.ok(result.operationModels.contextTwentyProjectMcp.d1QueriesAtMax <= 50);
    assert.ok(result.operationModels.contextTwentyProjectMcp.boundParametersAtMax <= 100);
    assert.equal(result.staticEvidence.productionSetIntervalCalls, 0);
    assert.equal(result.staticEvidence.graphPublishRetryAttempts, 3);
    assert.equal(result.staticEvidence.snapshotIntegrityUsesJoinedCurrentReferences, true);
    assert.equal(result.staticEvidence.completeGraphIdentityDeduplication, true);
  });

  it("requires bounded and concurrency-controlled workflows", () => {
    const result = audit();
    const ci = result.workflows.find((item) => item.file.endsWith("ci.yml"));
    const graphify = result.workflows.find((item) => item.file.endsWith("graphify.yml"));
    assert.deepEqual(ci?.timeoutMinutes, [20]);
    assert.equal(ci?.cancelInProgress, "true");
    assert.match(ci?.concurrencyGroup ?? "", /^ci-/);
    assert.deepEqual(graphify?.timeoutMinutes, [30]);
    assert.equal(graphify?.cancelInProgress, "false");
    assert.equal(graphify?.concurrencyGroup, `graphify-$${"{{ inputs.project_id }"}}`);
  });
});
