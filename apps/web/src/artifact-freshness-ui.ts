export type ArtifactFreshness = {
  state: "CURRENT" | "STALE" | "UNKNOWN";
  artifactSourceCommitSha: string | null;
  currentRepositoryCommitSha: string | null;
  repositoryStatus: "VERIFIED" | "UNVERIFIED" | "DISCONNECTED";
};

export function freshnessMessage(freshness: ArtifactFreshness): string {
  if (freshness.repositoryStatus === "DISCONNECTED") {
    return "Unknown - repository disconnected; no current commit is available for comparison.";
  }
  if (freshness.repositoryStatus === "UNVERIFIED") {
    return "Unknown - repository connection is unverified; provenance cannot be compared safely.";
  }
  if (!freshness.currentRepositoryCommitSha) {
    return "Unknown - the verified repository has no available current commit.";
  }
  if (!freshness.artifactSourceCommitSha) {
    return "Unknown - this artifact has no source commit provenance.";
  }
  if (freshness.state === "STALE") {
    return "Stale - this artifact references a different commit and may need review.";
  }
  if (freshness.state === "CURRENT") {
    return "Current - artifact provenance matches the current repository commit.";
  }
  return "Unknown - source commit provenance is invalid or cannot be verified.";
}
