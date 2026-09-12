import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  callbackFreeUrl,
  gitLoadAnnouncement,
  isCurrentGitRequest,
  matchGitCallbackProject,
  parseGitCallback,
  validateRepositoryUrl,
} from "../src/git-helpers.js";

describe("Git repository input", () => {
  it("accepts the GitHub HTTPS and SSH forms normalized by the backend", () => {
    for (const value of [
      "https://github.com/Owner/Repository",
      "https://github.com/Owner/Repository.git/",
      "ssh://git@github.com/Owner/Repository.git",
      "git@github.com:Owner/Repository.git",
    ]) {
      assert.equal(validateRepositoryUrl(value), null, value);
    }
  });

  it("enforces bounded GitHub-only owner and repository input", () => {
    assert.match(validateRepositoryUrl(" ") ?? "", /required/);
    assert.match(validateRepositoryUrl(`https://github.com/${"a".repeat(40)}/repo`) ?? "", /valid/);
    assert.match(validateRepositoryUrl(`https://github.com/o/${"r".repeat(101)}`) ?? "", /valid/);
    assert.match(validateRepositoryUrl(`https://github.com/o/${"r".repeat(600)}`) ?? "", /512/);
    assert.match(validateRepositoryUrl("http://github.com/owner/repo") ?? "", /HTTPS or SSH/);
    assert.match(
      validateRepositoryUrl("https://github.com/owner/repo?token=secret") ?? "",
      /HTTPS or SSH/,
    );
    assert.match(validateRepositoryUrl("https://example.com/owner/repo") ?? "", /HTTPS or SSH/);
  });
});

describe("Git callback handling", () => {
  it("maps success and known errors to fixed copy without reflecting input", () => {
    assert.deepEqual(parseGitCallback("?project=p_1&git=connected"), {
      projectId: "p_1",
      kind: "success",
      message: "GitHub authorization returned. Verifying this project's repository status...",
    });
    const known = parseGitCallback("?project=p_1&git_error=identity_mismatch");
    assert.equal(known?.kind, "error");
    assert.match(known?.message ?? "", /identity/);

    const unknown = parseGitCallback("?git_error=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    assert.equal(unknown?.message.includes("script"), false);
    assert.equal(parseGitCallback("?unrelated=value"), null);
  });

  it("bounds project/error parameters and removes only callback parameters", () => {
    const callback = parseGitCallback(`?project=${"p".repeat(101)}&git_error=${"x".repeat(41)}`);
    assert.equal(callback?.projectId, null);
    assert.equal(callback?.message.includes("xxx"), false);
    assert.equal(
      callbackFreeUrl(
        new URL("https://web.example/dashboard?project=p&git=connected&keep=yes#status"),
      ),
      "/dashboard?keep=yes#status",
    );
  });

  it("accepts callback notices only for an authorized exact project match", () => {
    const callback = parseGitCallback("?project=project-a&git=connected");
    assert.equal(matchGitCallbackProject(callback, ["project-a", "project-b"]), callback);
    assert.equal(matchGitCallbackProject(callback, ["project-b"]), null);
    assert.equal(matchGitCallbackProject(parseGitCallback("?git=connected"), ["project-a"]), null);
  });

  it("derives truthful one-time callback announcements", () => {
    const success = parseGitCallback("?project=project-a&git=connected");
    assert.deepEqual(
      gitLoadAnnouncement({ kind: "success", callback: success, connectionStatus: "VERIFIED" }),
      {
        message: "GitHub repository connected and verified.",
        isError: false,
      },
    );
    assert.deepEqual(
      gitLoadAnnouncement({ kind: "success", callback: success, connectionStatus: null }),
      {
        message: "GitHub authorization returned, but no verified repository connection was found.",
        isError: true,
      },
    );
    assert.deepEqual(
      gitLoadAnnouncement({ kind: "success", callback: null, connectionStatus: null }),
      {
        message: "Repository status loaded.",
        isError: false,
      },
    );
    const fixedError = gitLoadAnnouncement({
      kind: "success",
      callback: parseGitCallback("?project=project-a&git_error=identity_mismatch"),
      connectionStatus: null,
    });
    assert.equal(fixedError.isError, true);
    assert.match(fixedError.message, /identity/);
    assert.equal(fixedError.message.includes("identity_mismatch"), false);
  });

  it("clears stale error semantics while a retry is pending before either outcome", () => {
    const failed = gitLoadAnnouncement({ kind: "error", message: "Status unavailable." });
    const retrying = gitLoadAnnouncement({ kind: "pending" });
    const recovered = gitLoadAnnouncement({
      kind: "success",
      callback: null,
      connectionStatus: "VERIFIED",
    });
    const failedAgain = gitLoadAnnouncement({ kind: "error", message: "Still unavailable." });

    assert.equal(failed.isError, true);
    assert.deepEqual(retrying, {
      message: "Loading repository status...",
      isError: false,
    });
    assert.equal(recovered.isError, false);
    assert.equal(failedAgain.isError, true);
  });
});

describe("Git stale request guard", () => {
  it("requires both the request generation and project to remain current", () => {
    assert.equal(isCurrentGitRequest(2, "project-a", 2, "project-a"), true);
    assert.equal(isCurrentGitRequest(1, "project-a", 2, "project-a"), false);
    assert.equal(isCurrentGitRequest(2, "project-a", 2, "project-b"), false);
  });
});
