import assert from "node:assert/strict";
import test from "node:test";
import { teamMemberControlState } from "../src/team-helpers.js";

test("team controls are read-only for non-admins and self-role changes", () => {
  assert.deepEqual(teamMemberControlState("EDITOR", 1, false, false), {
    showControls: false,
    disableRole: true,
    disableRemoval: true,
  });
  assert.deepEqual(teamMemberControlState("ADMIN", 2, true, true), {
    showControls: false,
    disableRole: true,
    disableRemoval: true,
  });
});

test("team controls protect the final admin but allow two-admin transitions", () => {
  assert.deepEqual(teamMemberControlState("ADMIN", 1, false, true), {
    showControls: true,
    disableRole: true,
    disableRemoval: true,
  });
  assert.deepEqual(teamMemberControlState("ADMIN", 2, false, true), {
    showControls: true,
    disableRole: false,
    disableRemoval: false,
  });
  assert.deepEqual(teamMemberControlState("VIEWER", 1, false, true), {
    showControls: true,
    disableRole: false,
    disableRemoval: false,
  });
});
