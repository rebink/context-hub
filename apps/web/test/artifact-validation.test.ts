import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateUpload } from "../src/artifact-validation.js";

const valid = {
  name: "Architecture",
  type: "architecture",
  description: "Current system map",
  contentType: "application/json; charset=utf-8",
  content: '{"ok":true}',
  sourceCommitSha: "abcdef0",
  changeNote: "Initial version",
};

describe("artifact upload validation", () => {
  it("accepts the backend upload contract", () => {
    assert.deepEqual(validateUpload(valid, true), {});
    assert.deepEqual(validateUpload({ ...valid, name: undefined, type: undefined }, false), {});
  });

  it("measures UTF-8 bytes and validates declared JSON and source SHA", () => {
    assert.equal(
      validateUpload({ ...valid, content: "😀".repeat(262_145) }, true).content,
      "Content must be 1 MiB or smaller when UTF-8 encoded.",
    );
    assert.match(validateUpload({ ...valid, content: "{" }, true).content ?? "", /parse/);
    assert.match(
      validateUpload({ ...valid, sourceCommitSha: "not-a-sha" }, true).sourceCommitSha ?? "",
      /hexadecimal/,
    );
  });
});
