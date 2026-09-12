import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { type TrustedExecutable, verifyTrustedExecutable } from "./executable.js";
import type { ProcessBoundary } from "./types.js";
import { GraphAdapterError } from "./types.js";

const EMPTY_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  LANG: "C",
});
const LFS_HEADER = Buffer.from("version https://git-lfs.github.com/spec/v1");

export interface CheckoutSnapshot {
  readonly root: string;
  readonly paths: readonly string[];
  readonly fingerprint: string;
  readonly manifestBytes: Uint8Array;
  readonly manifestSha256: string;
}

async function git(
  boundary: ProcessBoundary,
  executable: TrustedExecutable,
  root: string,
  args: readonly string[],
): Promise<Buffer> {
  try {
    await verifyTrustedExecutable(executable);
    const result = await boundary.run({
      executable: executable.canonicalPath,
      args,
      cwd: root,
      env: EMPTY_ENV,
      timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    return Buffer.from(result.stdout);
  } catch (error) {
    if (
      error instanceof GraphAdapterError &&
      (error.kind === "PROCESS_TIMEOUT" || error.kind === "TRUSTED_EXECUTABLE_INVALID")
    ) {
      throw error;
    }
    throw new GraphAdapterError("INVALID_CHECKOUT");
  }
}

function splitNul(bytes: Buffer): Buffer[] {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new GraphAdapterError("INVALID_CHECKOUT");
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      records.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  return records;
}

function safePath(raw: Buffer): string {
  const value = raw.toString("utf8");
  if (
    !raw.equals(Buffer.from(value)) ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.normalize(value) !== value ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new GraphAdapterError("UNSUPPORTED_REPOSITORY_CONTENT");
  }
  return value;
}

export async function inspectCheckout(
  boundary: ProcessBoundary,
  executable: TrustedExecutable,
  checkoutPath: string,
  expectedCommit: string,
): Promise<CheckoutSnapshot> {
  let root: string;
  try {
    root = await realpath(checkoutPath);
    if (!(await lstat(root)).isDirectory() || !path.isAbsolute(root)) throw new Error();
  } catch {
    throw new GraphAdapterError("INVALID_CHECKOUT");
  }
  const head = (await git(boundary, executable, root, ["rev-parse", "--verify", "HEAD"]))
    .toString("ascii")
    .trim()
    .toLowerCase();
  const branch = (await git(boundary, executable, root, ["rev-parse", "--abbrev-ref", "HEAD"]))
    .toString("utf8")
    .trim();
  if (branch !== "HEAD" || head !== expectedCommit) throw new GraphAdapterError("COMMIT_MISMATCH");

  const status = await git(boundary, executable, root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const ignored = await git(boundary, executable, root, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
  ]);
  if (status.length !== 0 || ignored.length !== 0) throw new GraphAdapterError("DIRTY_CHECKOUT");

  const objectFormat = (
    await git(boundary, executable, root, ["rev-parse", "--show-object-format"])
  )
    .toString("ascii")
    .trim();
  const objectAlgorithm =
    objectFormat === "sha1" ? "sha1" : objectFormat === "sha256" ? "sha256" : undefined;
  const objectIdLength = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
  if (!objectAlgorithm) throw new GraphAdapterError("INVALID_CHECKOUT");

  // -v makes hidden index flags explicit: only uppercase H is a normal tracked entry.
  const records = splitNul(
    await git(boundary, executable, root, ["ls-files", "--stage", "-v", "-z"]),
  );
  const paths: string[] = [];
  const hashes: string[] = [];
  for (const record of records) {
    const tab = record.indexOf(9);
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^H ([0-7]{6}) ([0-9a-f]+) ([0-3])$/.exec(header);
    if (
      tab < 0 ||
      !match ||
      match[3] !== "0" ||
      match[2]?.length !== objectIdLength ||
      (match[1] !== "100644" && match[1] !== "100755")
    ) {
      throw new GraphAdapterError("UNSUPPORTED_REPOSITORY_CONTENT");
    }
    const mode = match[1];
    const objectId = match[2];
    const relative = safePath(record.subarray(tab + 1));
    if (relative === ".gitmodules") throw new GraphAdapterError("UNSUPPORTED_REPOSITORY_CONTENT");
    let sha256: string;
    try {
      const full = path.join(root, ...relative.split("/"));
      const canonical = await realpath(full);
      const containment = path.relative(root, canonical);
      if (containment === "" || containment === ".." || containment.startsWith(`..${path.sep}`))
        throw new Error();
      const direct = await lstat(full, { bigint: true });
      if (!direct.isFile() || direct.isSymbolicLink()) throw new Error();
      if (!("O_NOFOLLOW" in fsConstants)) throw new Error();
      const handle = await open(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const opened = await handle.stat({ bigint: true });
        if (!sameFile(opened, direct)) throw new Error();
        const blob = createHash(objectAlgorithm).update(`blob ${opened.size}\0`);
        const content = createHash("sha256");
        const prefix = Buffer.alloc(LFS_HEADER.length);
        let prefixSize = 0;
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let offset = 0n;
        while (offset < opened.size) {
          const length = Number(
            opened.size - offset > BigInt(chunk.length)
              ? BigInt(chunk.length)
              : opened.size - offset,
          );
          const read = await handle.read(chunk, 0, length, null);
          if (read.bytesRead === 0) throw new Error();
          const bytes = chunk.subarray(0, read.bytesRead);
          blob.update(bytes);
          content.update(bytes);
          if (prefixSize < prefix.length) {
            const copied = bytes.copy(prefix, prefixSize, 0, prefix.length - prefixSize);
            prefixSize += copied;
          }
          offset += BigInt(read.bytesRead);
        }
        const finalDescriptor = await handle.stat({ bigint: true });
        const finalPath = await lstat(full, { bigint: true });
        if (!sameFile(opened, finalDescriptor) || !sameFile(opened, finalPath)) throw new Error();
        if (blob.digest("hex") !== objectId) throw new Error();
        if (prefixSize === prefix.length && prefix.equals(LFS_HEADER)) throw new Error();
        sha256 = content.digest("hex");
      } finally {
        await handle.close();
      }
    } catch {
      throw new GraphAdapterError("UNSUPPORTED_REPOSITORY_CONTENT");
    }
    paths.push(relative);
    hashes.push(`${mode} ${objectId} ${sha256} ${relative}`);
  }
  paths.sort();
  const manifestBytes = Buffer.from(paths.map((item) => `${item}\0`).join(""));
  return {
    root,
    paths: Object.freeze(paths),
    fingerprint: createHash("sha256").update(hashes.sort().join("\n")).digest("hex"),
    manifestBytes,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  };
}

function sameFile(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export async function verifyCheckout(
  boundary: ProcessBoundary,
  executable: TrustedExecutable,
  before: CheckoutSnapshot,
  expectedCommit: string,
): Promise<void> {
  const after = await inspectCheckout(boundary, executable, before.root, expectedCommit);
  if (after.fingerprint !== before.fingerprint || after.manifestSha256 !== before.manifestSha256) {
    throw new GraphAdapterError("DIRTY_CHECKOUT");
  }
}
