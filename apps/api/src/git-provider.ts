export type GitRepositoryInspection = {
  provider: "github";
  providerRepositoryId: string;
  owner: string;
  name: string;
  canonicalUrl: string;
  defaultBranch: string;
  headSha: string;
};

export type GitAuthorizationResult = {
  providerUserId: string;
  repository: GitRepositoryInspection;
};

export interface GitProvider {
  installationUrl(state: string): string;
  userAuthorizationUrl(redirectUri: string, state: string, codeChallenge: string): string;
  authorizeAndInspect(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    installationId: string;
    owner: string;
    repository: string;
  }): Promise<GitAuthorizationResult>;
  inspectInstallation(input: {
    installationId: string;
    owner: string;
    repository: string;
  }): Promise<GitRepositoryInspection>;
}

export type GitProviderFailureKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "rate-limited"
  | "unavailable"
  | "timeout"
  | "network"
  | "invalid-response"
  | "identity-mismatch"
  | "installation-mismatch"
  | "repository-mismatch";

export class GitProviderError extends Error {
  constructor(readonly kind: GitProviderFailureKind) {
    super(`Git provider failure: ${kind}`);
    this.name = "GitProviderError";
  }
}
