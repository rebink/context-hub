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
  operations = { connectProject, projectStatus, syncProject },
) {
  const command = args[0];
  if (command === "connect") {
    const apiOrigin = option(args, "--api");
    if (!apiOrigin) throw new Error("INVALID_ARGUMENTS");
    const manifest = await operations.connectProject({
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
    const status = await operations.projectStatus({
      directory,
      session,
      credentialApiOrigin: session ? credentialOrigin() : undefined,
      reportToken: session ? process.env.CONTEXT_HUB_MCP_TOKEN : undefined,
    });
    write(JSON.stringify(status));
    return;
  }
  if (command === "sync") {
    const session = credential();
    const origin = credentialOrigin();
    let manifest: Awaited<ReturnType<typeof syncProject>>;
    try {
      manifest = await operations.syncProject({
        directory,
        session,
        credentialApiOrigin: origin,
      });
    } catch (error) {
      const failureCode =
        error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)
          ? error.message
          : "SYNC_FAILED";
      if (process.env.CONTEXT_HUB_MCP_TOKEN) {
        await operations
          .projectStatus({
            directory,
            session,
            credentialApiOrigin: origin,
            reportToken: process.env.CONTEXT_HUB_MCP_TOKEN,
            reportOutcome: "SYNC_FAILED",
            failureCode,
          })
          .catch(() => undefined);
      }
      throw error;
    }
    let reporting: "REPORTED" | "FAILED" | "NOT_CONFIGURED" = "NOT_CONFIGURED";
    if (process.env.CONTEXT_HUB_MCP_TOKEN) {
      try {
        const status = await operations.projectStatus({
          directory,
          session,
          credentialApiOrigin: origin,
          reportToken: process.env.CONTEXT_HUB_MCP_TOKEN,
          reportOutcome: "SYNC_SUCCEEDED",
        });
        reporting = status.reporting ?? "FAILED";
      } catch {
        reporting = "FAILED";
      }
    }
    write(
      JSON.stringify({
        synced: true,
        projectId: manifest.projectId,
        graphVersion: manifest.graph?.version ?? null,
        reporting,
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
