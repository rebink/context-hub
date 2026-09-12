import type { ArtifactFreshness } from "./context-provider.js";

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Shared artifact freshness semantics for Context Engine and the later artifact UI. */
export function classifyArtifactFreshness(
  artifactSourceCommit: string | null | undefined,
  currentRepositoryCommit: string | null | undefined,
): ArtifactFreshness {
  if (
    !artifactSourceCommit ||
    !currentRepositoryCommit ||
    !COMMIT_SHA.test(artifactSourceCommit) ||
    !COMMIT_SHA.test(currentRepositoryCommit)
  ) {
    return "UNKNOWN";
  }
  return artifactSourceCommit === currentRepositoryCommit ? "CURRENT" : "STALE";
}
