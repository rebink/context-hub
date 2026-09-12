import { spawn } from "node:child_process";
import path from "node:path";
import { type RuntimeCapability, requirePosixProcessGroups } from "./runtime.js";
import type { ProcessBoundary, ProcessRequest, ProcessResult } from "./types.js";
import { GraphAdapterError } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const HARD_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface NodeProcessBoundaryOptions {
  /** Test-only fail-closed seam; capabilities can be disabled but never attested present. */
  readonly testOnlyDisabledRuntimeCapabilities?: readonly RuntimeCapability[];
}

export class NodeProcessBoundary implements ProcessBoundary {
  readonly #testOnlyDisabledRuntimeCapabilities: readonly RuntimeCapability[];

  constructor(options: NodeProcessBoundaryOptions = {}) {
    this.#testOnlyDisabledRuntimeCapabilities = Object.freeze([
      ...(options.testOnlyDisabledRuntimeCapabilities ?? []),
    ]);
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    requirePosixProcessGroups(this.#testOnlyDisabledRuntimeCapabilities);
    if (!path.isAbsolute(request.executable) || !hasSafePath(request.env.PATH)) {
      throw new GraphAdapterError("PROCESS_FAILED");
    }
    const requestedLimit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0)
      throw new GraphAdapterError("PROCESS_FAILED");
    return await new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: { ...request.env },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const outputLimit = Math.min(requestedLimit, HARD_MAX_OUTPUT_BYTES);
      let stdoutSize = 0;
      let stderrSize = 0;
      let timedOut = false;
      let overflow = false;
      let stdinFailed = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const settle = (error?: GraphAdapterError, result?: ProcessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const stop = () => {
        terminate(child.pid);
        if (!killTimer) {
          killTimer = setTimeout(() => terminate(child.pid, "SIGKILL"), 250);
          killTimer.unref();
        }
      };
      const collect = (chunks: Buffer[], isStdout: boolean) => (chunk: Buffer) => {
        const size = isStdout ? stdoutSize : stderrSize;
        if (size + chunk.length > outputLimit) {
          overflow = true;
          stop();
          return;
        }
        chunks.push(chunk);
        if (isStdout) stdoutSize += chunk.length;
        else stderrSize += chunk.length;
      };
      child.stdout.on("data", collect(stdout, true));
      child.stderr.on("data", collect(stderr, false));
      child.stdin.on("error", () => {
        stdinFailed = true;
        stop();
      });
      child.on("error", () => settle(new GraphAdapterError("PROCESS_FAILED")));
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs);
      timer.unref();
      child.on("close", (code) => {
        // The leader can exit while detached descendants remain in our owned process group.
        terminate(child.pid, "SIGKILL");
        if (timedOut) return settle(new GraphAdapterError("PROCESS_TIMEOUT"));
        if (overflow || stdinFailed || code !== 0)
          return settle(new GraphAdapterError("PROCESS_FAILED"));
        settle(undefined, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      child.stdin.end(request.stdin ? Buffer.from(request.stdin) : undefined, () => undefined);
    });
  }
}

function hasSafePath(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value.split(path.delimiter).every((entry) => entry.length > 0 && path.isAbsolute(entry));
}

function terminate(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process may already have exited.
  }
}
