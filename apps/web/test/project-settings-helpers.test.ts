import assert from "node:assert/strict";
import test from "node:test";
import { validateProjectSettings } from "../src/project-settings-helpers.js";

test("project settings validation mirrors the approved bounded fields", () => {
  assert.deepEqual(
    validateProjectSettings({
      name: " Payments Platform ",
      slug: "payments-platform",
      description: " Context for payment flows ",
    }),
    {},
  );
  assert.deepEqual(
    validateProjectSettings({ name: "", slug: "Bad--Slug", description: "x".repeat(501) }),
    {
      name: "Enter a project name.",
      slug: "Use lowercase letters, numbers, and single hyphens.",
      description: "Use 500 characters or fewer.",
    },
  );
});
