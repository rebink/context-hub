import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROJECT_AUDIT_ACTIONS } from "../../../packages/project-audit-contract.js";
import { activityFilters, decodeActivityCursor } from "../src/activity.js";

test("activity filters enforce bounded time, page, action, and complete actor selectors", () => {
  const now = new Date("2026-09-14T12:00:00.000Z");
  const valid = activityFilters(
    new URL(
      "https://api.test/projects/p/activity?limit=50&action=GRAPH_PUBLISHED&actorKind=MACHINE&actorId=runner-1",
    ),
    now,
  );
  assert.deepEqual(valid, {
    limit: 50,
    filters: {
      from: "2026-08-15T12:00:00.000Z",
      to: "2026-09-14T12:00:00.000Z",
      action: "GRAPH_PUBLISHED",
      actorKind: "MACHINE",
      actorId: "runner-1",
    },
  });
  assert.equal(
    activityFilters(new URL("https://api.test/projects/p/activity?limit=51"), now),
    null,
  );
  assert.equal(
    activityFilters(new URL("https://api.test/projects/p/activity?action=FUTURE_ACTION"), now),
    null,
  );
  assert.equal(
    activityFilters(new URL("https://api.test/projects/p/activity?actorKind=HUMAN"), now),
    null,
  );
  assert.equal(
    activityFilters(new URL("https://api.test/projects/p/activity?unexpected=true"), now),
    null,
  );
  assert.equal(
    activityFilters(new URL("https://api.test/projects/p/activity?limit=10&limit=20"), now),
    null,
  );
  assert.equal(
    activityFilters(
      new URL("https://api.test/projects/p/activity?from=2025-01-01&to=2026-01-01"),
      now,
    ),
    null,
  );
});

test("activity cursor decoding fails closed on malformed and oversized input", () => {
  assert.equal(decodeActivityCursor(null), null);
  assert.equal(decodeActivityCursor("not_json"), null);
  assert.equal(decodeActivityCursor("a".repeat(2049)), null);
  const value = Buffer.from(
    JSON.stringify({
      occurredAt: "2026-09-14T12:00:00.000Z",
      id: "git:event-1",
      filters: {
        from: "2026-08-15T12:00:00.000Z",
        to: "2026-09-14T12:00:00.000Z",
        action: null,
        actorKind: null,
        actorId: null,
      },
    }),
  ).toString("base64url");
  assert.equal(decodeActivityCursor(value)?.id, "git:event-1");
  const unknownAction = Buffer.from(
    JSON.stringify({
      occurredAt: "2026-09-14T12:00:00.000Z",
      id: "git:event-1",
      filters: {
        from: "2026-08-15T12:00:00.000Z",
        to: "2026-09-14T12:00:00.000Z",
        action: "FUTURE_ACTION",
        actorKind: null,
        actorId: null,
      },
    }),
  ).toString("base64url");
  assert.equal(decodeActivityCursor(unknownAction), null);
});

test("shared action contract exactly matches the migration CHECK", () => {
  const migration = readFileSync(
    new URL("../migrations/0020_generalized_project_audit.sql", import.meta.url),
    "utf8",
  );
  const match = migration.match(/action TEXT NOT NULL CHECK\(action IN \(([\s\S]*?)\n {2}\)\),/);
  assert.ok(match);
  const sqlActions = [...(match[1] ?? "").matchAll(/'([A-Z_]+)'/g)].map((item) => item[1]);
  assert.deepEqual(sqlActions, [...PROJECT_AUDIT_ACTIONS]);
});
