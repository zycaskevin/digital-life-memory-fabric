import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export interface ContainedSourceFile {
  text: string;
  sizeBytes: number;
  modifiedAt: string;
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (
    rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  );
}

async function openedTargetPath(
  fileDescriptor: number,
): Promise<string> {
  if (process.platform !== "linux") {
    throw new Error(
      "contained source descriptor verification is unavailable on this platform",
    );
  }
  return realpath(`/proc/self/fd/${fileDescriptor}`);
}

export async function readContainedSourceFile(
  path: string,
  root: string,
): Promise<ContainedSourceFile> {
  if (!isAbsolute(root)) {
    throw new Error("contained source root must be an absolute pinned path");
  }
  // Callers pin the canonical root once during reader initialization. Never
  // re-resolve it here: replacing that pathname with a symlink must not move
  // the trust root.
  const canonicalRoot = root;
  const resolvedBeforeOpen = await realpath(path);
  if (!isContained(canonicalRoot, resolvedBeforeOpen)) {
    throw new Error("source file escapes configured root");
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number"
    ? constants.O_NONBLOCK
    : 0;
  let handle;
  try {
    // O_NONBLOCK prevents a discovered regular file that is replaced by a FIFO
    // from hanging the polling worker before the regular-file check can reject it.
    // O_NOFOLLOW still protects the final component from symlink replacement.
    handle = await open(
      resolvedBeforeOpen,
      constants.O_RDONLY | noFollow | nonBlock,
    );
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ELOOP"
    ) {
      throw new Error("source file became a symlink before read");
    }
    throw error;
  }

  try {
    const openedPath = await openedTargetPath(handle.fd);
    if (!isContained(canonicalRoot, openedPath)) {
      throw new Error("opened source file escapes configured root");
    }
    const file = await handle.stat();
    if (!file.isFile()) throw new Error("source path is not a regular file");
    return {
      text: await handle.readFile({ encoding: "utf8" }),
      sizeBytes: file.size,
      modifiedAt: file.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

export async function readContainedSourceFirstLine(
  path: string,
  root: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<ContainedSourceFile> {
  if (!isAbsolute(root)) {
    throw new Error("contained source root must be an absolute pinned path");
  }
  const canonicalRoot = root;
  const resolvedBeforeOpen = await realpath(path);
  if (!isContained(canonicalRoot, resolvedBeforeOpen)) {
    throw new Error("source file escapes configured root");
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number"
    ? constants.O_NONBLOCK
    : 0;
  let handle;
  try {
    handle = await open(
      resolvedBeforeOpen,
      constants.O_RDONLY | noFollow | nonBlock,
    );
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ELOOP"
    ) {
      throw new Error("source file became a symlink before read");
    }
    throw error;
  }

  try {
    const openedPath = await openedTargetPath(handle.fd);
    if (!isContained(canonicalRoot, openedPath)) {
      throw new Error("opened source file escapes configured root");
    }
    const file = await handle.stat();
    if (!file.isFile()) throw new Error("source path is not a regular file");

    const chunks: Buffer[] = [];
    let consumed = 0;
    const chunkSize = 64 * 1024;
    while (consumed < Math.min(file.size, maxBytes)) {
      const length = Math.min(chunkSize, maxBytes - consumed);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, consumed);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return {
          text: Buffer.concat(chunks).toString("utf8").replace(/\r$/u, ""),
          sizeBytes: file.size,
          modifiedAt: file.mtime.toISOString(),
        };
      }
      chunks.push(chunk);
      consumed += bytesRead;
    }
    if (file.size > maxBytes) {
      throw new Error("source metadata line exceeds bounded read limit");
    }
    return {
      text: Buffer.concat(chunks).toString("utf8").replace(/\r$/u, ""),
      sizeBytes: file.size,
      modifiedAt: file.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}
