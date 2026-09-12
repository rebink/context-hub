import { constants as fsConstants } from "node:fs";
import { GraphAdapterError } from "./types.js";

export type RuntimeCapability = "posixProcessGroups" | "O_NOFOLLOW" | "O_NONBLOCK";

const POSIX_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
]);

export function requirePosixProcessGroups(
  testOnlyDisabledCapabilities: readonly RuntimeCapability[] = [],
): void {
  if (
    !POSIX_PLATFORMS.has(process.platform) ||
    testOnlyDisabledCapabilities.includes("posixProcessGroups")
  ) {
    throw new GraphAdapterError("UNSUPPORTED_PLATFORM");
  }
}

export function requireAdapterRuntime(
  testOnlyDisabledCapabilities: readonly RuntimeCapability[] = [],
): void {
  requirePosixProcessGroups(testOnlyDisabledCapabilities);
  if (
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    typeof fsConstants.O_NONBLOCK !== "number" ||
    testOnlyDisabledCapabilities.includes("O_NOFOLLOW") ||
    testOnlyDisabledCapabilities.includes("O_NONBLOCK")
  ) {
    throw new GraphAdapterError("UNSUPPORTED_PLATFORM");
  }
}
