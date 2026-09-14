export function canManageGit(role: "ADMIN" | "EDITOR" | "VIEWER"): boolean {
  return role === "ADMIN";
}

export type GitCallback = {
  projectId: string | null;
  kind: "success" | "error";
  message: string;
};

export type GitLoadAnnouncement = {
  message: string;
  isError: boolean;
};

export type GitLoadState =
  | { kind: "pending" }
  | { kind: "success"; callback: GitCallback | null; connectionStatus: string | null }
  | { kind: "error"; message: string };

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_REPOSITORY_INPUT = 512;

const CALLBACK_ERRORS: Record<string, string> = {
  invalid_setup: "GitHub returned an invalid installation response. Start the connection again.",
  invalid_configuration: "GitHub connection is not configured for this environment.",
  invalid_callback:
    "GitHub returned an incomplete authorization response. Start the connection again.",
  invalid_state: "The GitHub connection request expired or was already used. Start again.",
  forbidden: "Your project role no longer permits repository connections.",
  identity_mismatch: "The authorized GitHub identity did not match your signed-in account.",
  stale_connection:
    "The project connection changed before authorization finished. Review its current status.",
  provider_failed: "GitHub could not verify the repository. Try again later.",
  connection_failed: "The repository connection could not be completed. Try again.",
};

export function validateRepositoryUrl(value: string): string | null {
  const input = value.trim();
  if (!input) return "Repository URL is required.";
  if (input.length > MAX_REPOSITORY_INPUT) {
    return `Repository URL must be ${MAX_REPOSITORY_INPUT} characters or fewer.`;
  }

  let owner: string | undefined;
  let repository: string | undefined;
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/i.exec(input);
  if (scp) {
    [, owner, repository] = scp;
  } else {
    try {
      const url = new URL(input);
      if (
        !["https:", "ssh:"].includes(url.protocol) ||
        url.hostname.toLowerCase() !== "github.com" ||
        url.port ||
        url.search ||
        url.hash ||
        (url.username && url.username !== "git") ||
        url.password
      ) {
        return "Enter a GitHub HTTPS or SSH repository URL.";
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 2) return "Enter a GitHub repository URL with an owner and name.";
      [owner, repository] = parts;
    } catch {
      return "Enter a GitHub HTTPS or SSH repository URL.";
    }
  }

  repository = repository?.replace(/\.git$/i, "");
  if (!owner || !repository || !GITHUB_OWNER.test(owner) || !GITHUB_REPOSITORY.test(repository)) {
    return "Enter a valid GitHub repository owner and name.";
  }
  return null;
}

export function parseGitCallback(search: string): GitCallback | null {
  const query = new URLSearchParams(search);
  const rawProject = query.get("project");
  const projectId =
    rawProject && rawProject.length <= 100 && /^[A-Za-z0-9_-]+$/.test(rawProject)
      ? rawProject
      : null;
  const rawError = query.get("git_error");
  if (rawError !== null) {
    const message = rawError.length <= 40 ? CALLBACK_ERRORS[rawError] : undefined;
    return {
      projectId,
      kind: "error",
      message: message ?? "The GitHub connection could not be completed. Start again or try later.",
    };
  }
  if (query.get("git") === "connected") {
    return {
      projectId,
      kind: "success",
      message: "GitHub authorization returned. Verifying this project's repository status...",
    };
  }
  return null;
}

export function matchGitCallbackProject(
  callback: GitCallback | null,
  authorizedProjectIds: readonly string[],
): GitCallback | null {
  return callback?.projectId && authorizedProjectIds.includes(callback.projectId) ? callback : null;
}

export function gitLoadAnnouncement(state: GitLoadState): GitLoadAnnouncement {
  if (state.kind === "pending") {
    return { message: "Loading repository status...", isError: false };
  }
  if (state.kind === "error") return { message: state.message, isError: true };
  if (state.callback?.kind === "error") {
    return { message: state.callback.message, isError: true };
  }
  if (state.callback?.kind === "success") {
    return state.connectionStatus === "VERIFIED"
      ? { message: "GitHub repository connected and verified.", isError: false }
      : {
          message:
            "GitHub authorization returned, but no verified repository connection was found.",
          isError: true,
        };
  }
  return { message: "Repository status loaded.", isError: false };
}

export function callbackFreeUrl(url: URL): string {
  const clean = new URL(url.toString());
  clean.searchParams.delete("project");
  clean.searchParams.delete("git");
  clean.searchParams.delete("git_error");
  return `${clean.pathname}${clean.search}${clean.hash}`;
}

export function isCurrentGitRequest(
  requestedGeneration: number,
  requestedProjectId: string,
  currentGeneration: number,
  currentProjectId: string,
): boolean {
  return requestedGeneration === currentGeneration && requestedProjectId === currentProjectId;
}
