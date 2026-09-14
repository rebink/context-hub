const STORAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PUBLICATION_ID = /^[A-Za-z0-9_-]{32,128}$/;

function id(value: string, name: string): string {
  if (!STORAGE_ID.test(value)) throw new Error(`INVALID_${name}`);
  return value;
}

function version(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new Error(`INVALID_${name}`);
  return value;
}

export function artifactObjectKey(projectId: string, artifactId: string, artifactVersion: number) {
  return `projects/${id(projectId, "PROJECT_ID")}/artifacts/${id(artifactId, "ARTIFACT_ID")}/v/${version(artifactVersion, "ARTIFACT_VERSION")}/content`;
}

export function legacyGraphObjectKey(projectId: string, graphVersion: number) {
  return `projects/${id(projectId, "PROJECT_ID")}/graphs/v/${version(graphVersion, "GRAPH_VERSION")}/graph.json`;
}

export function attemptGraphObjectKey(
  projectId: string,
  graphVersion: number,
  attempt: number,
  publicationId: string,
) {
  if (!PUBLICATION_ID.test(publicationId)) throw new Error("INVALID_PUBLICATION_ID");
  return `projects/${id(projectId, "PROJECT_ID")}/graphs/v/${version(graphVersion, "GRAPH_VERSION")}/attempts/${version(attempt, "GRAPH_ATTEMPT")}/${publicationId}/graph.json`;
}

export function snapshotManifestObjectKey(projectId: string, snapshotId: string) {
  return `projects/${id(projectId, "PROJECT_ID")}/snapshots/${id(snapshotId, "SNAPSHOT_ID")}/manifest.json`;
}
