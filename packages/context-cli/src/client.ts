import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  CHECKSUM,
  type GraphMetadata,
  isGraphMetadata,
  isRepositoryIdentity,
  isSafeInteger,
  MAX_GRAPH_BYTES,
  MAX_METADATA_BYTES,
  SHA,
  type SyncMetadata,
} from "./types.js";

const execFile = promisify(execFileCallback);
const REQUEST_TIMEOUT_MS = 10_000;

export class ClientError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
  }
}

export function validateApiOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClientError("INVALID_API_ORIGIN");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new ClientError("INVALID_API_ORIGIN");
  return url.origin;
}

async function boundedBytes(response: Response, maximum: number) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new ClientError("RESPONSE_TOO_LARGE");
  if (!response.body) throw new ClientError("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new ClientError("RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateMetadata(value: unknown): SyncMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ClientError("INVALID_RESPONSE");
  const item = value as Record<string, unknown>;
  if (
    typeof item.projectId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(item.projectId) ||
    !item.repository ||
    typeof item.repository !== "object" ||
    Array.isArray(item.repository) ||
    !isRepositoryIdentity(item.repository)
  )
    throw new ClientError("INVALID_RESPONSE");
  const repository = item.repository as Record<string, unknown>;
  if (
    typeof repository.defaultBranch !== "string" ||
    repository.defaultBranch.length < 1 ||
    repository.defaultBranch.length > 255 ||
    typeof repository.remoteCommitSha !== "string" ||
    !SHA.test(repository.remoteCommitSha) ||
    (item.newestGraph !== null && !isGraphMetadata(item.newestGraph)) ||
    (item.readyGraph !== null && !isGraphMetadata(item.readyGraph))
  )
    throw new ClientError("INVALID_RESPONSE");
  return value as SyncMetadata;
}

export class SyncClient {
  readonly apiOrigin: string;

  constructor(
    apiOrigin: string,
    private session: string,
    private fetchImplementation: typeof fetch = fetch,
  ) {
    this.apiOrigin = validateApiOrigin(apiOrigin);
    if (!session || session.length > 4096 || /[\r\n;]/.test(session))
      throw new ClientError("CREDENTIAL_REQUIRED");
  }

  private async request(pathname: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.apiOrigin}${pathname}`, {
        method: "GET",
        redirect: "manual",
        headers: { cookie: `context_hub_session=${encodeURIComponent(this.session)}` },
        signal: controller.signal,
      });
    } catch {
      throw new ClientError("OFFLINE");
    } finally {
      clearTimeout(timeout);
    }
    if (response.status >= 300 && response.status < 400) throw new ClientError("REDIRECT_REJECTED");
    if (!response.ok) {
      const code =
        response.status === 401
          ? "UNAUTHENTICATED"
          : response.status === 404
            ? "NOT_FOUND"
            : "HTTP_ERROR";
      throw new ClientError(code, response.status);
    }
    return response;
  }

  async metadata(projectId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new ClientError("INVALID_PROJECT_ID");
    const response = await this.request(`/projects/${encodeURIComponent(projectId)}/sync`);
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
      throw new ClientError("INVALID_RESPONSE");
    const bytes = await boundedBytes(response, MAX_METADATA_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ClientError("INVALID_RESPONSE");
    }
    return validateMetadata(value);
  }

  async resolve(repository: string) {
    if (repository.length > 1024) throw new ClientError("INVALID_REPOSITORY");
    const response = await this.request(
      `/projects/resolve?repository=${encodeURIComponent(repository)}`,
    );
    const bytes = await boundedBytes(response, MAX_METADATA_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ClientError("INVALID_RESPONSE");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ClientError("INVALID_RESPONSE");
    const result = value as Record<string, unknown>;
    if (
      result.match !== "unique" ||
      !result.project ||
      typeof result.project !== "object" ||
      typeof (result.project as Record<string, unknown>).id !== "string"
    )
      throw new ClientError(
        result.match === "ambiguous" ? "AMBIGUOUS_PROJECT" : "PROJECT_NOT_FOUND",
      );
    const projectId = (result.project as Record<string, unknown>).id as string;
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new ClientError("INVALID_RESPONSE");
    return projectId;
  }

  async download(projectId: string, graph: GraphMetadata) {
    if (
      graph.status !== "READY" ||
      !graph.checksum ||
      !CHECKSUM.test(graph.checksum) ||
      !isSafeInteger(graph.byteSize, 0, MAX_GRAPH_BYTES)
    )
      throw new ClientError("INVALID_GRAPH_METADATA");
    const response = await this.request(
      `/projects/${encodeURIComponent(projectId)}/sync/graph/${graph.version}`,
    );
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json")
      throw new ClientError("INVALID_RESPONSE");
    if (
      response.headers.get("x-context-graph-version") !== String(graph.version) ||
      response.headers.get("x-context-source-commit") !== graph.sourceCommitSha ||
      response.headers.get("x-context-checksum-sha256") !== graph.checksum
    )
      throw new ClientError("GRAPH_METADATA_MISMATCH");
    const bytes = await boundedBytes(response, MAX_GRAPH_BYTES);
    if (bytes.byteLength !== graph.byteSize) throw new ClientError("GRAPH_SIZE_MISMATCH");
    return bytes;
  }
}

export async function gitOutput(root: string, args: string[]) {
  try {
    const { stdout } = await execFile("git", ["-C", root, ...args], {
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    return stdout.trim();
  } catch {
    throw new ClientError("GIT_ERROR");
  }
}

export async function repositoryRoot(directory: string) {
  return gitOutput(directory, ["rev-parse", "--show-toplevel"]);
}

export async function localHead(root: string) {
  const sha = await gitOutput(root, ["rev-parse", "HEAD"]);
  if (!SHA.test(sha)) throw new ClientError("GIT_ERROR");
  return sha;
}

export async function localRemote(root: string) {
  const remote = await gitOutput(root, ["remote", "get-url", "origin"]);
  if (!remote || remote.length > 1024) throw new ClientError("GIT_ERROR");
  return remote;
}

export async function isAncestor(root: string, ancestor: string, descendant: string) {
  if (!SHA.test(ancestor) || !SHA.test(descendant)) return false;
  try {
    await execFile("git", ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant], {
      timeout: 5_000,
      maxBuffer: 1024,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    return true;
  } catch {
    return false;
  }
}
