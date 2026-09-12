import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { GraphAdapterError } from "./types.js";

export interface TrustedExecutable {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export async function canonicalizeCheckoutPath(checkoutPath: string): Promise<string> {
  try {
    const canonicalPath = await realpath(checkoutPath);
    const stat = await lstat(canonicalPath);
    if (!path.isAbsolute(canonicalPath) || !stat.isDirectory()) throw new Error();
    return canonicalPath;
  } catch {
    throw new GraphAdapterError("INVALID_CHECKOUT");
  }
}

export async function trustExecutable(
  configuredPath: string | undefined,
  checkoutRoot: string,
): Promise<TrustedExecutable> {
  try {
    if (!configuredPath || !path.isAbsolute(configuredPath)) throw new Error();
    const canonicalPath = await realpath(configuredPath);
    if (canonicalPath !== configuredPath || isWithin(checkoutRoot, canonicalPath))
      throw new Error();
    await access(canonicalPath, fsConstants.X_OK);
    const stat = await lstat(canonicalPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    return Object.freeze({
      canonicalPath,
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    });
  } catch {
    throw new GraphAdapterError("TRUSTED_EXECUTABLE_INVALID");
  }
}

export async function verifyTrustedExecutable(executable: TrustedExecutable): Promise<void> {
  try {
    const canonicalPath = await realpath(executable.canonicalPath);
    const stat = await lstat(executable.canonicalPath, { bigint: true });
    await access(executable.canonicalPath, fsConstants.X_OK);
    if (
      canonicalPath !== executable.canonicalPath ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.dev !== executable.device ||
      stat.ino !== executable.inode ||
      stat.size !== executable.size ||
      stat.mtimeNs !== executable.mtimeNs ||
      stat.ctimeNs !== executable.ctimeNs
    ) {
      throw new Error();
    }
  } catch {
    throw new GraphAdapterError("TRUSTED_EXECUTABLE_INVALID");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
