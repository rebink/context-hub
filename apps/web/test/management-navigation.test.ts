import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SNAPSHOT_ARTIFACT_RESPONSE_FIELDS,
  SNAPSHOT_GRAPH_RESPONSE_FIELDS,
  SNAPSHOT_MANIFEST_RESPONSE_FIELDS,
} from "../../api/src/snapshots.js";
import { canManageArtifacts } from "../src/artifact-validation.js";
import { canManageGit } from "../src/git-helpers.js";
import { type GraphVersion, graphCapabilities } from "../src/graph-helpers.js";
import {
  ManagementCoordinator,
  resolveCurrentProject,
  restoreFocusAfterDialog,
} from "../src/management-coordinator.js";
import {
  appRoutePath,
  GLOBAL_VIEWS,
  isCurrentViewRequest,
  PROJECT_VIEWS,
  parseAppRoute,
  sameRoute,
} from "../src/navigation.js";
import { canManageProjectSettings } from "../src/project-settings-helpers.js";
import { buildSnapshotRequest, canCreateSnapshot } from "../src/snapshot-helpers.js";
import {
  SNAPSHOT_ARTIFACT_PROVENANCE_FIELDS,
  SNAPSHOT_GRAPH_PROVENANCE_FIELDS,
  SNAPSHOT_MANIFEST_PROVENANCE_FIELDS,
  snapshotArtifactProvenanceRows,
  snapshotGraphProvenanceRows,
  snapshotManifestProvenanceRows,
} from "../src/snapshots.js";
import { teamMemberControlState } from "../src/team-helpers.js";

class FakeHistory {
  pushes: string[] = [];
  replacements: string[] = [];
  pushState(_data: unknown, _unused: string, url?: string | URL | null): void {
    this.pushes.push(String(url));
  }
  replaceState(_data: unknown, _unused: string, url?: string | URL | null): void {
    this.replacements.push(String(url));
  }
}

test("management coordinator canonicalizes invalid routes and fails closed after auth teardown", () => {
  const history = new FakeHistory();
  const privateState = { user: "alice", projects: ["payments"], selected: "payments" };
  const coordinator = new ManagementCoordinator("/invalid/route", history, () => {
    privateState.user = "";
    privateState.projects = [];
    privateState.selected = "";
  });
  assert.deepEqual(history.replacements, ["/projects"]);
  coordinator.markAuthenticated();
  const current = coordinator.beginRender();
  assert.equal(coordinator.isCurrent(current), true);
  coordinator.navigate({ kind: "project", projectId: "payments", view: "git" });
  assert.equal(coordinator.projectAriaCurrent("payments"), "page");
  coordinator.clearAuthentication();
  assert.deepEqual(privateState, { user: "", projects: [], selected: "" });
  assert.equal(coordinator.isCurrent(coordinator.generation), false);
  coordinator.popstate("/projects/payments/team");
  assert.equal(coordinator.projectAriaCurrent("payments"), "page");
  assert.equal(coordinator.isCurrent(coordinator.generation), false);
  coordinator.popstate("/bad");
  assert.equal(history.replacements.at(-1), "/projects");
  coordinator.route = { kind: "global", view: "settings" };
  assert.equal(coordinator.projectAriaCurrent("payments"), null);

  const target = new EventTarget();
  let pathname = "/projects/payments/context";
  let changes = 0;
  const unmount = coordinator.mountPopstate(
    target,
    () => pathname,
    () => {
      changes += 1;
    },
  );
  target.dispatchEvent(new Event("popstate"));
  assert.equal(coordinator.route.kind, "project");
  assert.equal(changes, 1);
  unmount();
  pathname = "/activity";
  target.dispatchEvent(new Event("popstate"));
  assert.equal(changes, 1);
});

test("dialog focus restoration and generation checks reject stale creation completions", () => {
  const history = new FakeHistory();
  const coordinator = new ManagementCoordinator("/projects", history);
  coordinator.markAuthenticated();
  const requestGeneration = coordinator.beginRender();
  coordinator.navigate({ kind: "global", view: "activity" });
  assert.equal(coordinator.isCurrent(requestGeneration), false);
  let focused = 0;
  restoreFocusAfterDialog({
    isConnected: true,
    focus: () => {
      focused += 1;
    },
  });
  restoreFocusAfterDialog({
    isConnected: false,
    focus: () => {
      focused += 1;
    },
  });
  assert.equal(focused, 1);
});

test("global and project navigation contracts expose every required route exactly once", () => {
  assert.deepEqual(GLOBAL_VIEWS, ["projects", "activity", "settings"]);
  assert.deepEqual(PROJECT_VIEWS, [
    "overview",
    "context",
    "graphify",
    "git",
    "team",
    "snapshots",
    "activity",
    "settings",
  ]);
  for (const view of GLOBAL_VIEWS) {
    const route = { kind: "global" as const, view };
    assert.deepEqual(parseAppRoute(appRoutePath(route)), route);
  }
  for (const view of PROJECT_VIEWS) {
    const route = { kind: "project" as const, projectId: "project_1", view };
    assert.deepEqual(parseAppRoute(appRoutePath(route)), route);
  }
  assert.deepEqual(parseAppRoute("/projects/project_1"), {
    kind: "project",
    projectId: "project_1",
    view: "overview",
  });
});

test("deep links, reload parsing, and back-forward route restoration are deterministic", () => {
  const history = [
    "/projects",
    "/projects/payments/context",
    "/projects/payments/snapshots",
    "/activity",
  ];
  const parsed = history.map(parseAppRoute);
  const context = parsed[1];
  const snapshots = parsed[2];
  const activity = parsed[3];
  assert.ok(context && snapshots && activity);
  assert.equal(appRoutePath(context), "/projects/payments/context");
  assert.equal(appRoutePath(snapshots), "/projects/payments/snapshots");
  assert.deepEqual(parseAppRoute(appRoutePath(context)), context);
  assert.deepEqual(parseAppRoute(appRoutePath(activity)), activity);
  assert.equal(sameRoute(context, snapshots), false);
  assert.equal(sameRoute(context, parseAppRoute("/projects/payments/context")), true);
  assert.deepEqual(parseAppRoute("/projects/payments/unknown"), {
    kind: "global",
    view: "projects",
  });
  assert.deepEqual(parseAppRoute("/projects/../settings"), { kind: "global", view: "projects" });
  assert.equal(
    readFileSync(new URL("../public/_redirects", import.meta.url), "utf8"),
    "/* /index.html 200\n",
  );
  assert.equal(isCurrentViewRequest(8, 8), true);
  assert.equal(isCurrentViewRequest(8, 9), false);
});

test("snapshot creation is viewer-safe and preserves exact selected graph and artifact provenance", () => {
  assert.equal(canCreateSnapshot("ADMIN"), true);
  assert.equal(canCreateSnapshot("EDITOR"), true);
  assert.equal(canCreateSnapshot("VIEWER"), false);
  const graph = { version: 7, sourceCommitSha: "a".repeat(40) } as GraphVersion;
  const request = buildSnapshotRequest(
    "Release candidate",
    graph,
    [
      { id: "architecture", currentVersion: 3 },
      { id: "adr", currentVersion: 2 },
    ],
    new Set(["adr"]),
    "snapshot-request-1",
  );
  assert.deepEqual(request, {
    name: "Release candidate",
    gitSha: "a".repeat(40),
    graphVersion: 7,
    artifacts: [{ artifactId: "adr", version: 2 }],
    idempotencyKey: "snapshot-request-1",
  });
});

test("snapshot inspector field contract renders every API graph, artifact, and manifest provenance key", () => {
  assert.deepEqual(SNAPSHOT_GRAPH_PROVENANCE_FIELDS, SNAPSHOT_GRAPH_RESPONSE_FIELDS);
  assert.deepEqual(SNAPSHOT_ARTIFACT_PROVENANCE_FIELDS, SNAPSHOT_ARTIFACT_RESPONSE_FIELDS);
  assert.deepEqual(SNAPSHOT_MANIFEST_PROVENANCE_FIELDS, SNAPSHOT_MANIFEST_RESPONSE_FIELDS);
  const graphRows = snapshotGraphProvenanceRows({
    version: 9,
    sourceCommitSha: "1".repeat(40),
    storageLayout: "ATTEMPT_V2",
    publicationId: "publication-9",
    publishedAttempt: 2,
    publishedLeaseId: "lease-9",
    uploadId: "upload-9",
    checksum: "2".repeat(64),
    byteSize: 4096,
    contentType: "application/json",
    repository: {
      provider: "github",
      providerRepositoryId: "repo-9",
      owner: "acme",
      name: "payments",
      canonicalUrl: "https://github.com/acme/payments",
    },
    graphifyVersion: "0.9.58",
    adapterVersion: "1.0.0",
    profile: "code-only-clustered-v1",
    formatVersion: 1,
    generator: "graphify",
    generatedBy: "runner-9",
    generatedAt: "2026-09-15T00:00:00.000Z",
  });
  const artifactRows = snapshotArtifactProvenanceRows({
    artifactId: "artifact-9",
    version: 3,
    type: "architecture",
    checksum: "3".repeat(64),
    byteSize: 512,
    contentType: "text/markdown",
    uploadId: "artifact-upload-9",
    sourceCommitSha: "4".repeat(40),
    changeNote: "sealed",
    createdBy: "user-9",
    createdAt: "2026-09-14T00:00:00.000Z",
  });
  const manifestRows = snapshotManifestProvenanceRows({
    checksum: "5".repeat(64),
    byteSize: 1024,
    contentType: "application/json",
  });
  assert.equal(graphRows.length, SNAPSHOT_GRAPH_RESPONSE_FIELDS.length);
  assert.equal(artifactRows.length, SNAPSHOT_ARTIFACT_RESPONSE_FIELDS.length);
  assert.equal(manifestRows.length, SNAPSHOT_MANIFEST_RESPONSE_FIELDS.length);
  assert.ok(graphRows.every(([label, value]) => label.length <= 32 && value.length > 0));
  assert.ok(artifactRows.every(([label, value]) => label.length <= 32 && value.length > 0));
  assert.ok(manifestRows.every(([label, value]) => label.length <= 32 && value.length > 0));
});

test("fresh project authorization replaces cached roles and rejects removal", () => {
  const cached = { id: "payments", role: "ADMIN" as const };
  const demoted = { id: "payments", role: "VIEWER" as const };
  assert.deepEqual(resolveCurrentProject("payments", [cached], demoted), demoted);
  assert.deepEqual(resolveCurrentProject("payments", [demoted], cached), demoted);
  assert.equal(resolveCurrentProject("payments", [], demoted), null);
  assert.equal(
    resolveCurrentProject("payments", [cached], { id: "identity", role: "ADMIN" }),
    null,
  );
});

test("fresh viewer role keeps every project management surface read only", () => {
  assert.equal(canManageArtifacts("VIEWER"), false);
  assert.equal(canManageGit("VIEWER"), false);
  assert.equal(graphCapabilities("VIEWER").canBuild, false);
  assert.equal(canCreateSnapshot("VIEWER"), false);
  assert.equal(teamMemberControlState("EDITOR", 1, false, false).showControls, false);
  assert.equal(canManageProjectSettings("VIEWER"), false);
  assert.equal(canManageArtifacts("EDITOR"), true);
  assert.equal(canCreateSnapshot("EDITOR"), true);
  assert.equal(canManageGit("EDITOR"), false);
  assert.equal(canManageProjectSettings("EDITOR"), false);
});
