import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { measureMcpTokenAudit } from "../scripts/mcp-token-audit-lib.js";
import { MCP_LIMITS, MCP_TOOL_NAMES } from "../src/mcp-transport.js";

describe("MCP token audit invariants", () => {
  it("keeps one six-tool schema byte-identical for 1, 10, and 100 authorized projects", async () => {
    const audit = await measureMcpTokenAudit();
    assert.deepEqual(audit.toolNames, [...MCP_TOOL_NAMES]);
    assert.equal(new Set(audit.toolNames).size, 6);
    assert.deepEqual(
      audit.schema.runs.map((run) => run.projectCount),
      [1, 10, 100],
    );
    assert.equal(audit.schema.bytes, 4_082);
    assert.equal(audit.schema.estimatedTokens, 1_021);
    assert.equal(
      audit.schema.sha256,
      "3cd33a36192e35bdd8b6c195b27a5a2720db3cc992faa7b0c0699465e2044599",
    );
    for (const run of audit.schema.runs) {
      assert.equal(run.toolCount, 6);
      assert.equal(run.schemaBytes, audit.schema.bytes);
      assert.equal(run.estimatedTokens, audit.schema.estimatedTokens);
      assert.equal(run.sha256, audit.schema.sha256);
      assert.equal(run.containsProjectEnumeration, false);
      assert.equal(run.toolsListEnvelopeBytes, 4_132);
    }
  });

  it("measures actual envelopes and keeps partial authorization rejection nonleaking", async () => {
    const audit = await measureMcpTokenAudit();
    assert.deepEqual(
      audit.responses.scenarios.map((scenario) => scenario.name),
      ["single-project", "explicit-two-project", "rejected-partially-unauthorized"],
    );
    const [single, two, rejected] = audit.responses.scenarios;
    assert.equal(single?.status, 200);
    assert.ok((single?.modelVisibleTextBytes ?? 0) > 0);
    assert.equal(two?.status, 200);
    assert.ok((two?.modelVisibleTextBytes ?? 0) > (single?.modelVisibleTextBytes ?? 0));
    assert.equal(rejected?.status, 404);
    assert.equal(rejected?.modelVisibleTextBytes, 0);
    assert.equal(rejected?.leaksRejectedProjectData, false);
    assert.deepEqual(
      audit.responses.scenarios.map((scenario) => ({
        envelopeBytes: scenario.envelopeBytes,
        envelopeEstimatedTokens: scenario.envelopeEstimatedTokens,
        modelVisibleTextBytes: scenario.modelVisibleTextBytes,
        modelVisibleTextEstimatedTokens: scenario.modelVisibleTextEstimatedTokens,
      })),
      [
        {
          envelopeBytes: 1_706,
          envelopeEstimatedTokens: 427,
          modelVisibleTextBytes: 1_416,
          modelVisibleTextEstimatedTokens: 354,
        },
        {
          envelopeBytes: 3_178,
          envelopeEstimatedTokens: 795,
          modelVisibleTextBytes: 2_719,
          modelVisibleTextEstimatedTokens: 680,
        },
        {
          envelopeBytes: 101,
          envelopeEstimatedTokens: 26,
          modelVisibleTextBytes: 0,
          modelVisibleTextEstimatedTokens: 0,
        },
      ],
    );
    assert.deepEqual(
      audit.responses.scenarios.map((scenario) => scenario.responseSha256),
      [
        "3dfd45d17b53a5c7356b6780c2fbb2e9257b66398480579aefb1e4ca41c453dd",
        "01a4756e61c338ea12c94fc00135635e809eb793296b0c575148f3a8e0a15172",
        "eead434c5850cbf377774b9fbfb28eb760c8d06423dc5be6753091a3bceeaf80",
      ],
    );
    assert.equal(audit.responses.averageEnvelopeBytes, 1_662);
    assert.equal(audit.responses.averageEnvelopeEstimatedTokens, 416);
    assert.equal(audit.responses.averageModelVisibleTextBytes, 2_068);
    assert.equal(audit.responses.averageModelVisibleTextEstimatedTokens, 517);
    assert.equal(audit.responses.largestMeasuredEnvelopeBytes, 3_178);
    assert.equal(audit.responses.largestMeasuredModelVisibleTextBytes, 2_719);
    assert.ok(audit.responses.largestMeasuredEnvelopeBytes <= MCP_LIMITS.transport.responseBytes);
  });

  it("locks production limits and the conservative protocol/context bound", async () => {
    const audit = await measureMcpTokenAudit();
    const expectedLimits = {
      transport: { requestBytes: 16_384, responseBytes: 131_072 },
      scope: { minProjects: 1, maxProjects: 20 },
      searchContext: {
        minTokens: 32,
        maxTokens: 8_000,
        defaultTokens: 2_000,
        minBytes: 512,
        maxBytes: 65_536,
        defaultBytes: 32_768,
      },
      artifact: { contentBytes: 49_152 },
      graph: { minRecords: 1, maxRecords: 25, defaultRecords: 25 },
      sources: { minRecords: 1, maxRecords: 50, defaultRecords: 25 },
    };
    assert.deepEqual(MCP_LIMITS, expectedLimits);
    assert.deepEqual(audit.limits, expectedLimits);
    assert.equal(Object.isFrozen(MCP_LIMITS), true);
    for (const limits of Object.values(MCP_LIMITS)) assert.equal(Object.isFrozen(limits), true);
    assert.deepEqual(audit.worstCase, {
      schemaPlusMaximumResponseBytes: 135_154,
      estimatedTokens: 33_789,
    });
    assert.equal(
      audit.worstCase.schemaPlusMaximumResponseBytes,
      audit.schema.bytes + MCP_LIMITS.transport.responseBytes,
    );
    assert.equal(
      audit.worstCase.estimatedTokens,
      Math.ceil(audit.worstCase.schemaPlusMaximumResponseBytes / 4),
    );
  });
});
