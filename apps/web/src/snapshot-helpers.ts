import type { GraphVersion, ProjectRole } from "./graph-helpers.js";

export type SnapshotArtifactChoice = { id: string; currentVersion: number };

export function canCreateSnapshot(role: ProjectRole): boolean {
  return role === "ADMIN" || role === "EDITOR";
}

export function buildSnapshotRequest(
  name: string,
  graph: GraphVersion,
  artifacts: SnapshotArtifactChoice[],
  selectedIds: ReadonlySet<string>,
  idempotencyKey: string,
) {
  return {
    name,
    gitSha: graph.sourceCommitSha,
    graphVersion: graph.version,
    artifacts: artifacts
      .filter((artifact) => selectedIds.has(artifact.id))
      .map((artifact) => ({ artifactId: artifact.id, version: artifact.currentVersion })),
    idempotencyKey,
  };
}
