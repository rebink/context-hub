import assert from "node:assert/strict";
import test from "node:test";
import { type ArtifactFreshness, freshnessMessage } from "../src/artifact-freshness-ui.js";

const base: ArtifactFreshness = {
  state: "UNKNOWN",
  artifactSourceCommitSha: "a".repeat(40),
  currentRepositoryCommitSha: "b".repeat(40),
  repositoryStatus: "VERIFIED",
};

test("freshness copy identifies all three classifier states without relying on color", () => {
  assert.match(
    freshnessMessage({ ...base, state: "CURRENT", currentRepositoryCommitSha: "a".repeat(40) }),
    /^Current -/,
  );
  assert.match(freshnessMessage({ ...base, state: "STALE" }), /^Stale -/);
  assert.match(
    freshnessMessage({ ...base, state: "UNKNOWN", artifactSourceCommitSha: null }),
    /no source commit provenance/,
  );
});

test("freshness copy distinguishes repository provenance edges", () => {
  assert.match(
    freshnessMessage({
      ...base,
      repositoryStatus: "DISCONNECTED",
      currentRepositoryCommitSha: null,
    }),
    /repository disconnected/,
  );
  assert.match(
    freshnessMessage({ ...base, repositoryStatus: "UNVERIFIED", currentRepositoryCommitSha: null }),
    /connection is unverified/,
  );
  assert.match(
    freshnessMessage({ ...base, currentRepositoryCommitSha: null }),
    /no available current commit/,
  );
  assert.match(freshnessMessage({ ...base, state: "UNKNOWN" }), /invalid or cannot be verified/);
});
