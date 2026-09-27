import { readFile, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GraphAdapterError, GraphifyAdapter } from "../packages/graphify-adapter/src/index.js";

const MAX_MEMORY = 8 * 1024 ** 3;
const MAX_DISK = 16 * 1024 ** 3;
const MIN_MEMORY = 1024 ** 3;
const MIN_DISK = 2 * 1024 ** 3;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function nonce(): string {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

async function attestResources(checkout: string) {
  if (process.platform !== "linux") throw new Error("Canonical CI requires Linux");
  const volume = await realpath(required("CONTEXT_HUB_BUILD_VOLUME"));
  const checkoutPath = await realpath(checkout);
  if (checkoutPath !== volume && !checkoutPath.startsWith(`${volume}${path.sep}`))
    throw new Error("Checkout is not on the bounded build volume");
  const disk = await statfs(volume, { bigint: true });
  const diskLimitBytes = Number(disk.blocks * disk.bsize);
  if (!Number.isSafeInteger(diskLimitBytes) || diskLimitBytes < MIN_DISK)
    throw new Error("Runner volume has insufficient free space");

  const mode = required("CONTEXT_HUB_RUNNER_MODE");
  if (mode === "github-hosted") {
    if (
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.CONTEXT_HUB_RUNNER_ENVIRONMENT !== "github-hosted" ||
      process.env.RUNNER_OS !== "Linux" ||
      process.env.RUNNER_ARCH !== "X64" ||
      required("CONTEXT_HUB_EXPECTED_RUNNER_LABEL") !== "ubuntu-24.04" ||
      process.env.ImageOS !== "ubuntu24"
    )
      throw new Error("GitHub-hosted runner attestation failed");
    // GitHub enforces the ephemeral VM and workflow timeout; cgroup ceilings are not configurable here.
    return { attested: true as const, memoryLimitBytes: MAX_MEMORY, diskLimitBytes };
  }
  if (mode !== "self-hosted") throw new Error("Unsupported runner mode");
  const cgroup = required("CONTEXT_HUB_MEMORY_CGROUP");
  const membership = await readFile("/proc/self/cgroup", "utf8");
  if (!membership.split("\n").some((line) => line.endsWith(`:${cgroup}`)))
    throw new Error("Runner process is not in the configured cgroup");
  const rawMemory = (
    await readFile(path.join("/sys/fs/cgroup", cgroup, "memory.max"), "utf8")
  ).trim();
  if (!/^\d+$/.test(rawMemory)) throw new Error("Memory cgroup is unbounded");
  const memoryLimitBytes = Number(rawMemory);
  if (
    !Number.isSafeInteger(memoryLimitBytes) ||
    memoryLimitBytes < MIN_MEMORY ||
    memoryLimitBytes > MAX_MEMORY ||
    diskLimitBytes > MAX_DISK
  )
    throw new Error("Host resource limits are outside the accepted bounds");
  return { attested: true as const, memoryLimitBytes, diskLimitBytes };
}

export class MachineRequestError extends Error {
  constructor(
    readonly operation: "claim" | "publish" | "fail",
    readonly status: number | null,
    readonly ambiguous: boolean,
  ) {
    super(`Machine ${operation} failed${status ? ` (${status})` : ""}`);
  }
}

async function machineFetch(
  api: string,
  token: string,
  projectId: string,
  version: string,
  operation: "claim" | "publish" | "fail",
  repositoryProvider: string,
  repositoryId: string,
  commit: string,
  init: RequestInit = {},
) {
  let response: Response;
  try {
    response = await fetch(`${api}/machine/projects/${projectId}/graphs/${version}/${operation}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "x-context-nonce": nonce(),
        "x-context-repository-provider": repositoryProvider,
        "x-context-repository-id": repositoryId,
        "x-context-source-commit": commit,
        ...init.headers,
      },
    });
  } catch {
    throw new MachineRequestError(operation, null, true);
  }
  if (!response.ok)
    throw new MachineRequestError(operation, response.status, response.status >= 500);
  return response;
}

export async function retryAmbiguousPublish(
  send: () => Promise<Response>,
  attempts = 3,
): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      last = error;
      if (!(error instanceof MachineRequestError) || !error.ambiguous) throw error;
    }
  }
  throw last;
}

async function main() {
  const api = required("CONTEXT_HUB_API_URL").replace(/\/$/, "");
  const token = required("CONTEXT_HUB_MACHINE_TOKEN");
  const projectId = required("CONTEXT_HUB_PROJECT_ID");
  const version = required("CONTEXT_HUB_GRAPH_VERSION");
  const repositoryProvider = required("CONTEXT_HUB_REPOSITORY_PROVIDER");
  const repositoryId = required("CONTEXT_HUB_REPOSITORY_ID");
  const commit = required("CONTEXT_HUB_SOURCE_COMMIT");
  const checkout = required("CONTEXT_HUB_CHECKOUT");
  const policy = await attestResources(checkout);
  const claimed = await machineFetch(
    api,
    token,
    projectId,
    version,
    "claim",
    repositoryProvider,
    repositoryId,
    commit,
    { method: "POST" },
  );
  const envelope = (await claimed.json()) as {
    claim: { attempt: number; leaseId: string; publicationId: string };
    build: {
      projectId: string;
      repositoryProvider: string;
      providerRepositoryId: string;
      repositoryIdentitySnapshot: {
        provider: string;
        providerRepositoryId: string;
        owner: string;
        name: string;
        canonicalUrl: string;
      };
      sourceCommitSha: string;
    };
  };
  const claimHeaders = {
    "x-context-attempt": String(envelope.claim.attempt),
    "x-context-lease-id": envelope.claim.leaseId,
    "x-context-publication-id": envelope.claim.publicationId,
  };
  try {
    const adapter = new GraphifyAdapter({
      gitExecutable: required("CONTEXT_HUB_GIT_EXECUTABLE"),
      pythonExecutable: required("CONTEXT_HUB_PYTHON_EXECUTABLE"),
      graphifyExecutable: required("CONTEXT_HUB_GRAPHIFY_EXECUTABLE"),
      tempRoot: required("CONTEXT_HUB_TEMP_ROOT"),
    });
    const result = await adapter.build({
      checkoutPath: checkout,
      projectId: envelope.build.projectId,
      repositoryProvider: envelope.build.repositoryProvider,
      providerRepositoryId: envelope.build.providerRepositoryId,
      repositoryIdentitySnapshot: envelope.build.repositoryIdentitySnapshot,
      sourceCommitSha: envelope.build.sourceCommitSha,
      executorPolicy: policy,
    });
    await retryAmbiguousPublish(() =>
      machineFetch(
        api,
        token,
        projectId,
        version,
        "publish",
        repositoryProvider,
        repositoryId,
        commit,
        {
          method: "PUT",
          body: new Uint8Array(result.bytes).buffer,
          headers: {
            ...claimHeaders,
            "content-type": "application/json",
            "content-length": String(result.byteSize),
            "x-context-checksum-sha256": result.contentChecksumSha256,
            "x-context-node-count": String(result.nodeCount),
            "x-context-link-count": String(result.linkCount),
            "x-context-hyperedge-count": String(result.hyperedgeCount),
          },
        },
      ),
    );
  } catch (error) {
    const publishIsUncertain =
      error instanceof MachineRequestError && error.operation === "publish" && error.ambiguous;
    if (!publishIsUncertain) {
      const failureCategory = error instanceof GraphAdapterError ? error.kind : "RUNNER_FAILED";
      await machineFetch(
        api,
        token,
        projectId,
        version,
        "fail",
        repositoryProvider,
        repositoryId,
        commit,
        {
          method: "POST",
          body: JSON.stringify({ failureCategory }),
          headers: { ...claimHeaders, "content-type": "application/json" },
        },
      ).catch(() => undefined);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Graph build failed");
    process.exitCode = 1;
  });
