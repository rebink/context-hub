#!/usr/bin/env node
import { connectProject, projectStatus, syncProject } from "./index.js";

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("INVALID_ARGUMENTS");
  return value;
}

function credential() {
  const value = process.env.CONTEXT_HUB_SESSION;
  if (!value) throw new Error("CREDENTIAL_REQUIRED");
  return value;
}

function credentialOrigin() {
  const value = process.env.CONTEXT_HUB_API;
  if (!value) throw new Error("CREDENTIAL_ORIGIN_REQUIRED");
  return value;
}

export async function run(
  args = process.argv.slice(2),
  directory = process.cwd(),
  write: (value: string) => void = (value) => process.stdout.write(`${value}\n`),
) {
  const command = args[0];
  if (command === "connect") {
    const apiOrigin = option(args, "--api");
    if (!apiOrigin) throw new Error("INVALID_ARGUMENTS");
    const manifest = await connectProject({
      directory,
      apiOrigin,
      projectId: option(args, "--project"),
      session: credential(),
    });
    write(JSON.stringify({ connected: true, projectId: manifest.projectId }));
    return;
  }
  if (command === "status") {
    const session = process.env.CONTEXT_HUB_SESSION;
    const status = await projectStatus({
      directory,
      session,
      credentialApiOrigin: session ? credentialOrigin() : undefined,
    });
    write(JSON.stringify(status));
    return;
  }
  if (command === "sync") {
    const manifest = await syncProject({
      directory,
      session: credential(),
      credentialApiOrigin: credentialOrigin(),
    });
    write(
      JSON.stringify({
        synced: true,
        projectId: manifest.projectId,
        graphVersion: manifest.graph?.version ?? null,
      }),
    );
    return;
  }
  throw new Error("USAGE: context connect --api <origin> [--project <id>] | status | sync");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error: unknown) => {
    const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
