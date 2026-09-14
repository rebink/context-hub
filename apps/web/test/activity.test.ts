import assert from "node:assert/strict";
import test from "node:test";
import { activityLabel, safeMetadataEntries } from "../src/activity.js";

test("activity presentation keeps exact source identifiers while formatting action labels", () => {
  assert.equal(activityLabel("GRAPH_BUILD_RESERVED"), "Graph Build Reserved");
  assert.deepEqual(
    safeMetadataEntries({
      attempt: 2,
      status: "CURRENT",
      failureCode: null,
      nested: { hidden: true },
    }),
    [
      ["attempt", "2"],
      ["status", "CURRENT"],
      ["failureCode", "None"],
    ],
  );
});
