import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function ensurePrivateParent(path, { create = true } = {}) {
  const parent = dirname(resolve(path));
  if (create) await ensureDurableDirectory(parent, 0o700);
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("multi-source state parent must be an owner-private directory");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("multi-source state parent owner mismatch");
  }
  return realpath(parent);
}

export async function assertSecureSourceDirectory(path) {
  const requested = resolve(path);
  const info = await lstat(requested);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("multi-source source root must be a stable directory");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("multi-source source root owner mismatch");
  }
  if ((info.mode & 0o002) !== 0) {
    throw new Error("multi-source source root must not be world-writable");
  }
  if ((info.mode & 0o020) !== 0) {
    if (
      typeof process.getuid !== "function"
      || typeof process.getgid !== "function"
      || process.getuid() !== process.getgid()
      || info.uid !== process.getuid()
      || info.gid !== process.getgid()
    ) {
      throw new Error(
        "group-writable multi-source root requires the owner's private primary group",
      );
    }
  }
  return realpath(requested);
}

export async function processLockIdentity(pid = process.pid) {
  const bootId = (await readFile(
    "/proc/sys/kernel/random/boot_id",
    "utf8",
  )).trim();
  const statText = await readFile(`/proc/${pid}/stat`, "utf8");
  const closeParen = statText.lastIndexOf(")");
  if (closeParen < 0) throw new Error("process stat identity is invalid");
  const fields = statText.slice(closeParen + 2).trim().split(/\s+/u);
  const processStartTicks = fields[19];
  if (!bootId || !processStartTicks) {
    throw new Error("process lock identity is unavailable");
  }
  return { pid, bootId, processStartTicks };
}

export async function tryAcquireWorkerLock(checkpointPath) {
  await ensurePrivateParent(checkpointPath);
  const lockPath = `${resolve(checkpointPath)}.worker.lock`;
  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  let handle;
  try {
    handle = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ELOOP"
    ) {
      throw new Error("multi-source worker lock must not be a symlink");
    }
    if (
      error instanceof Error
      && "code" in error
      && error.code === "EEXIST"
    ) {
      const state = await inspectExistingWorkerLock(lockPath);
      if (state === "active") return undefined;
      throw new Error(
        "multi-source worker lock is stale and requires operator review",
      );
    }
    throw error;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error("multi-source worker lock must be owner-private");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("multi-source worker lock owner mismatch");
    }
    const identity = await processLockIdentity();
    await handle.writeFile(
      `${JSON.stringify({
        ...identity,
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true });
    },
  };
}

export async function appendPrivateJournal(path, values) {
  if (values.length === 0) return;
  await ensurePrivateParent(path);
  const journalPath = resolve(path);
  const lockPath = `${journalPath}.append.lock`;
  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number"
    ? constants.O_NONBLOCK
    : 0;

  let appendLock;
  try {
    appendLock = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ELOOP"
    ) {
      throw new Error("multi-source Development reference journal lock must not be a symlink");
    }
    if (
      error instanceof Error
      && "code" in error
      && error.code === "EEXIST"
    ) {
      const state = await inspectExistingWorkerLock(lockPath);
      if (state === "active") {
        throw new Error(
          "multi-source Development reference journal already has an active writer",
        );
      }
      throw new Error(
        "multi-source Development reference journal lock is stale and requires operator review",
      );
    }
    throw error;
  }
  try {
    const identity = await processLockIdentity();
    await appendLock.writeFile(
      `${JSON.stringify({
        ...identity,
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await appendLock.sync();
    await syncDirectory(dirname(lockPath));
  } catch (error) {
    await appendLock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }

  let handle;
  try {
    handle = await open(
      journalPath,
      constants.O_RDWR
        | constants.O_APPEND
        | constants.O_CREAT
        | noFollow
        | nonBlock,
      0o600,
    );
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error("multi-source Development reference journal must be owner-private");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("multi-source Development reference journal owner mismatch");
    }
    await truncateUnterminatedTail(handle, info.size);
    const text = values.map((value) => JSON.stringify(value)).join("\n") + "\n";
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await syncDirectory(dirname(journalPath));
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENXIO"
    ) {
      throw new Error("multi-source Development reference journal must be a regular file");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await appendLock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function inspectExistingWorkerLock(lockPath) {
  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number"
    ? constants.O_NONBLOCK
    : 0;
  let handle;
  try {
    handle = await open(
      lockPath,
      constants.O_RDONLY | noFollow | nonBlock,
    );
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink?.()) return "stale";
    let value;
    try {
      value = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    } catch {
      return "stale";
    }
    const pid = Number(value?.pid);
    const bootId = typeof value?.bootId === "string" ? value.bootId : "";
    const processStartTicks = typeof value?.processStartTicks === "string"
      ? value.processStartTicks
      : "";
    if (
      !Number.isSafeInteger(pid)
      || pid <= 0
      || !bootId
      || !processStartTicks
    ) {
      return "stale";
    }
    let currentBootId;
    try {
      currentBootId = (await readFile(
        "/proc/sys/kernel/random/boot_id",
        "utf8",
      )).trim();
    } catch {
      return "active";
    }
    if (currentBootId !== bootId) return "stale";
    try {
      const currentIdentity = await processLockIdentity(pid);
      return currentIdentity.processStartTicks === processStartTicks
        ? "active"
        : "stale";
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && error.code === "ENOENT"
      ) {
        return "stale";
      }
      return "active";
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function truncateUnterminatedTail(handle, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return;
  const last = Buffer.allocUnsafe(1);
  const tail = await handle.read(last, 0, 1, size - 1);
  if (tail.bytesRead === 1 && last[0] === 0x0a) return;

  const chunkSize = 64 * 1024;
  let cursor = size;
  while (cursor > 0) {
    const start = Math.max(0, cursor - chunkSize);
    const length = cursor - start;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead <= 0) break;
    const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) {
      await handle.truncate(start + newline + 1);
      await handle.sync();
      return;
    }
    cursor = start;
  }
  await handle.truncate(0);
  await handle.sync();
}

async function ensureDurableDirectory(directory, mode) {
  const target = resolve(directory);
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("multi-source state path parent must be a directory");
    }
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const parent = dirname(target);
  if (parent === target) {
    throw new Error("multi-source state directory root is unavailable");
  }
  await ensureDurableDirectory(parent, mode);
  let created = false;
  try {
    await mkdir(target, { mode });
    created = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
  if (created) await syncDirectory(parent);
}

async function syncDirectory(directory) {
  const flags = constants.O_RDONLY
    | (typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0);
  const handle = await open(directory, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function scopeFromEnv(prefix, requiredEnv) {
  return {
    tenantId: requiredEnv(`${prefix}_TENANT_ID`),
    lifeDid: requiredEnv(`${prefix}_LIFE_DID`),
    memoryNamespace: requiredEnv(`${prefix}_MEMORY_NAMESPACE`),
  };
}

export function isPreflight(argv = process.argv.slice(2)) {
  return argv.includes("--preflight");
}

export function isBaseline(argv = process.argv.slice(2)) {
  return argv.includes("--baseline-current");
}
