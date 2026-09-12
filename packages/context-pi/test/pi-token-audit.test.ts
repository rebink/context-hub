import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { measurePiTokenAudit } from "../scripts/pi-token-audit-lib.ts";
import { PI_COMMAND } from "../src/index.ts";

const zeroMutationEvidence = {
  registeredLlmTools: 0,
  promptMutationRegistrations: 0,
  modelVisibleMessageCalls: 0,
  hiddenContextEntryCalls: 0,
  providerMutationCalls: 0,
  modelMutationCalls: 0,
  activeToolMutationCalls: 0,
  thinkingMutationCalls: 0,
  agentMutationCalls: 0,
  sessionMutationCalls: 0,
  unexpectedMutationCalls: 0,
};

describe("Pi token audit invariants", () => {
  it("derives zero context mutation and constant registration for 1, 10, and 100 projects", async () => {
    const { audit } = await measurePiTokenAudit();
    assert.deepEqual(
      audit.activationRuns.map((run) => ({
        projectCount: run.projectCount,
        commandCount: run.commandCount,
        registrationBytes: run.registrationBytes,
        registrationSha256: run.registrationSha256,
        formattedStatusPayloadBytes: run.formattedStatusPayloadBytes,
        formattedNotificationPayloadBytes: run.formattedNotificationPayloadBytes,
      })),
      [
        {
          projectCount: 1,
          commandCount: 1,
          registrationBytes: 107,
          registrationSha256: "a67bbb2810c1fc8cef785900e14d6d4cf6bbdfaa9249a8240d296062274f7eed",
          formattedStatusPayloadBytes: 14,
          formattedNotificationPayloadBytes: 40,
        },
        {
          projectCount: 10,
          commandCount: 1,
          registrationBytes: 107,
          registrationSha256: "a67bbb2810c1fc8cef785900e14d6d4cf6bbdfaa9249a8240d296062274f7eed",
          formattedStatusPayloadBytes: 14,
          formattedNotificationPayloadBytes: 69,
        },
        {
          projectCount: 100,
          commandCount: 1,
          registrationBytes: 107,
          registrationSha256: "a67bbb2810c1fc8cef785900e14d6d4cf6bbdfaa9249a8240d296062274f7eed",
          formattedStatusPayloadBytes: 14,
          formattedNotificationPayloadBytes: 69,
        },
      ],
    );
    for (const run of audit.activationRuns) {
      assert.deepEqual(run.eventNames, ["session_shutdown", "session_start"]);
      assert.deepEqual(run.lifecycleHandlersExecuted, ["session_start", "session_shutdown"]);
      assert.deepEqual(run.mutationEvidence, zeroMutationEvidence);
    }
    assert.deepEqual(audit.permanentModelContext, {
      evidenceKind: "structural-no-mutation",
      ...zeroMutationEvidence,
      modelVisibleBytes: 0,
      estimatedTokens: 0,
    });
  });

  it("executes all native commands and locks formatted notification payloads", async () => {
    const { audit } = await measurePiTokenAudit();
    assert.deepEqual(audit.command, PI_COMMAND);
    assert.deepEqual(
      audit.commands.map(({ name, formattedNotificationPayloadBytes, sha256 }) => ({
        name,
        formattedNotificationPayloadBytes,
        sha256,
      })),
      [
        [
          "connect-two-project",
          40,
          "ecef7d08a2010525e3a4336ecf5951a0ee78da3f90e0ea4c9c00e83e815bce37",
        ],
        ["status", 202, "831746915ffbdd9d702d9d93cc93d4a025b548b51bfbdf96f43e7a5c404e36cf"],
        ["sync", 46, "2924a88e33face4b4532d0ff6a0c42a86839580eebb57123b602fba12d8de573"],
        [
          "search-single-project",
          658,
          "105c40a4426f3884a8c7dc20dd63cd708ce3f46e4add121d47a5a30b5b0cabcc",
        ],
        [
          "graph-single-project",
          458,
          "cb3a3315bc3354fe22579f61fc0ac0abc4efea84f51ec5ef2566ec5e5ad2e1c8",
        ],
        ["snapshot", 132, "da68db1f47c6ae26943b7e51081467fe931196b9e3708f043c0fbda8c16e10e7"],
        [
          "unauthorized-search",
          33,
          "486a3ae72242a33fb4761bc77f1c90bca14b071fc1ba9ab3b41da10eea9aabcc",
        ],
        ["offline-graph", 225, "52f11a187d9d59625d78dd502637cec58bb71f51e5c2bfea063e9ae57ee6a878"],
        ["usage-error", 21, "dec7e6a2cdc935783c8202e7bed1e1ef5a31d00287bb0be7515669928ecfd94b"],
      ].map(([name, formattedNotificationPayloadBytes, sha256]) => ({
        name,
        formattedNotificationPayloadBytes,
        sha256,
      })),
    );
    assert.deepEqual(PI_COMMAND.subcommands, [
      "connect",
      "status",
      "sync",
      "search",
      "graph",
      "snapshot",
    ]);
    for (const command of audit.commands) {
      assert.deepEqual(command.mutationEvidence, zeroMutationEvidence);
      assert.equal(command.containsCompleteCredential, false);
      assert.equal(command.validUtf8, true);
    }
  });

  it("locks UTF-8 truncation, successful redaction, production limits, and audit digest", async () => {
    const result = await measurePiTokenAudit();
    assert.deepEqual(result.audit.limits, {
      notificationBytes: 16_384,
      searchRequestBytes: 12_288,
      mcpResponseBytes: 131_072,
    });
    assert.deepEqual(
      result.audit.boundaryEvidence.map((entry) => ({
        name: entry.name,
        bytes: entry.formattedNotificationPayloadBytes,
        marker: entry.containsTruncationMarker,
        credential: entry.containsCompleteCredential,
        validUtf8: entry.validUtf8,
        sha256: entry.sha256,
      })),
      [
        {
          name: "utf8-boundary",
          bytes: 16_384,
          marker: true,
          credential: false,
          validUtf8: true,
          sha256: "a7ddadac5cea3fba7c4fc9d3fb59b5ae01c24c31156927ccf518c702eb9d44a6",
        },
        {
          name: "successful-status-secret-redaction",
          bytes: 37,
          marker: false,
          credential: false,
          validUtf8: true,
          sha256: "1e7aa9954affac619ee03f74dc015eda90b73a3dccc959f0af465f436e7d4495",
        },
        {
          name: "successful-search-secret-redaction",
          bytes: 668,
          marker: false,
          credential: false,
          validUtf8: true,
          sha256: "220d74f9129bb0b10f937a7b11fc57bcb502ab31f700a974aa8b6a1d8b815660",
        },
      ],
    );
    assert.equal(
      createHash("sha256").update(JSON.stringify(result.audit)).digest("hex"),
      result.auditSha256,
    );
    assert.equal(
      result.auditSha256,
      "582ca398d6c8ad4db1db7e6158a87cb9673e5227df1b2fbdd0bb0de8a0fbdca0",
    );
  });
});
