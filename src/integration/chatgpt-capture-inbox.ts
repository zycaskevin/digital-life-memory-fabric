import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  validateChatGptCapturedConversation,
  type ChatGptCapturedConversation,
} from "../source-adapters/chatgpt-capture-adapter.js";
import { readContainedSourceFile } from "../source-adapters/contained-source-file.js";

export const CHATGPT_CAPTURE_INBOX_CONTRACT =
  "dlmf/chatgpt-capture-inbox/v1" as const;

export class ChatGptCaptureConflictError extends Error {
  constructor(
    readonly reason:
      | "stale"
      | "revision_conflict"
      | "lifecycle_regression"
      | "concurrent_update",
  ) {
    super(`ChatGPT capture conflict: ${reason}`);
    this.name = "ChatGptCaptureConflictError";
  }
}

export class ChatGptCaptureUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptCaptureUnavailableError";
  }
}

export interface ChatGptCaptureInboxWriteResult {
  outcome: "created" | "updated" | "idempotent";
  conversationIdHash: string;
  revisionHash: string;
  updatedAt: string;
  status: ChatGptCapturedConversation["status"];
}

export interface ChatGptCaptureInboxCurrentVersion {
  revision: string;
  updatedAt: string;
  status: ChatGptCapturedConversation["status"];
  contextCaptureDigest?: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function statusRank(status: ChatGptCapturedConversation["status"]): number {
  return status === "active" ? 0 : status === "completed" ? 1 : 2;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY
      | (typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const inboxWriteQueues = new Map<string, Promise<void>>();

async function runInboxExclusive<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = inboxWriteQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = previous.catch(() => undefined).then(() => gate);
  inboxWriteQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (inboxWriteQueues.get(key) === tail) inboxWriteQueues.delete(key);
  }
}

interface InboxProcessLockIdentity {
  pid: number;
  bootId: string;
  processStartTicks: string;
  createdAt: string;
}

async function inboxProcessIdentity(pid = process.pid): Promise<InboxProcessLockIdentity> {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const statText = await readFile(`/proc/${pid}/stat`, "utf8");
  const closeParen = statText.lastIndexOf(")");
  if (closeParen < 0) throw new Error("ChatGPT capture inbox process stat is invalid");
  const fields = statText.slice(closeParen + 2).trim().split(/\s+/u);
  const processStartTicks = fields[19];
  if (!bootId || !processStartTicks) {
    throw new Error("ChatGPT capture inbox process identity is unavailable");
  }
  return {
    pid,
    bootId,
    processStartTicks,
    createdAt: new Date().toISOString(),
  };
}

async function inspectInboxProcessLock(
  path: string,
): Promise<"missing" | "active" | "stale"> {
  const noFollow = typeof constants.O_NOFOLLOW === "number"
    ? constants.O_NOFOLLOW
    : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number"
    ? constants.O_NONBLOCK
    : 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "missing";
    }
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ELOOP"
    ) {
      throw new Error("ChatGPT capture inbox lock must not be a symlink");
    }
    throw error;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) return "stale";
    let value: Partial<InboxProcessLockIdentity>;
    try {
      value = JSON.parse(await handle.readFile({ encoding: "utf8" })) as Partial<InboxProcessLockIdentity>;
    } catch {
      return "stale";
    }
    if (
      !Number.isSafeInteger(value.pid)
      || Number(value.pid) <= 0
      || typeof value.bootId !== "string"
      || !value.bootId
      || typeof value.processStartTicks !== "string"
      || !value.processStartTicks
    ) {
      return "stale";
    }
    const currentBootId = (await readFile(
      "/proc/sys/kernel/random/boot_id",
      "utf8",
    )).trim();
    if (currentBootId !== value.bootId) return "stale";
    try {
      const current = await inboxProcessIdentity(Number(value.pid));
      return current.processStartTicks === value.processStartTicks
        ? "active"
        : "stale";
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return "stale";
      }
      return "active";
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class ChatGptCaptureInboxStore {
  readonly #requestedRoot: string;
  #root: string | undefined;

  constructor(root: string) {
    if (!root.trim()) throw new Error("ChatGPT capture inbox root must not be empty");
    this.#requestedRoot = resolve(root);
  }

  async ready(): Promise<{ ready: true; contract: typeof CHATGPT_CAPTURE_INBOX_CONTRACT }> {
    const root = await this.#ensureRoot();
    const recoveryState = await inspectInboxProcessLock(
      join(root, ".inbox-write.lock.recovery"),
    );
    if (recoveryState !== "missing") {
      throw new ChatGptCaptureUnavailableError(
        recoveryState === "active"
          ? "ChatGPT capture inbox recovery is in progress"
          : "ChatGPT capture inbox stale recovery lock requires operator review",
      );
    }
    const writeState = await inspectInboxProcessLock(
      join(root, ".inbox-write.lock"),
    );
    if (writeState === "stale") {
      throw new ChatGptCaptureUnavailableError(
        "ChatGPT capture inbox stale write lock requires operator review",
      );
    }
    return { ready: true, contract: CHATGPT_CAPTURE_INBOX_CONTRACT };
  }

  async currentVersion(
    conversationId: string,
  ): Promise<ChatGptCaptureInboxCurrentVersion | undefined> {
    if (
      conversationId !== conversationId.trim()
      || conversationId.length === 0
    ) {
      throw new Error("ChatGPT capture inbox conversationId is invalid");
    }
    const root = await this.#ensureRoot();
    const destination = join(root, `${sha256(conversationId)}.json`);
    let info;
    try {
      info = await lstat(destination);
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("ChatGPT capture inbox destination must be a regular non-symlink file");
    }
    const current = await readContainedSourceFile(destination, root);
    const snapshot = validateChatGptCapturedConversation(
      JSON.parse(current.text) as unknown,
    );
    if (snapshot.conversationId !== conversationId) {
      throw new Error("ChatGPT capture inbox identity collision");
    }
    const digest = snapshot.metadata?.contextCaptureDigest;
    return {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      status: snapshot.status,
      ...(typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest)
        ? { contextCaptureDigest: digest }
        : {}),
    };
  }

  async put(value: unknown): Promise<ChatGptCaptureInboxWriteResult> {
    const snapshot = validateChatGptCapturedConversation(value);
    const root = await this.#ensureRoot();
    const idHash = sha256(snapshot.conversationId);
    const revisionHash = sha256(snapshot.revision);
    const destination = join(root, `${idHash}.json`);
    const incomingSerialized = stableJson(snapshot);
    const incomingDigest = sha256(incomingSerialized);

    return runInboxExclusive(`${root}\u0000${idHash}`, async () => {
      const processLock = await this.#acquireProcessWriteLock(root);
      try {
    let existing: ChatGptCapturedConversation | undefined;
    try {
      const info = await lstat(destination);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("ChatGPT capture inbox destination must be a regular non-symlink file");
      }
      const current = await readContainedSourceFile(destination, root);
      existing = validateChatGptCapturedConversation(JSON.parse(current.text) as unknown);
      if (existing.conversationId !== snapshot.conversationId) {
        throw new Error("ChatGPT capture inbox identity collision");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT")) {
        if (existing === undefined && error instanceof SyntaxError) {
          throw new Error("ChatGPT capture inbox existing snapshot is invalid");
        }
        if (!(error instanceof Error && "code" in error
          && (error as NodeJS.ErrnoException).code === "ENOENT")) {
          throw error;
        }
      }
    }

    if (existing !== undefined) {
      const existingSerialized = stableJson(existing);
      const existingDigest = sha256(existingSerialized);
      if (existingDigest === incomingDigest) {
        return {
          outcome: "idempotent",
          conversationIdHash: idHash,
          revisionHash,
          updatedAt: snapshot.updatedAt,
          status: snapshot.status,
        };
      }
      const existingTime = Date.parse(existing.updatedAt);
      const incomingTime = Date.parse(snapshot.updatedAt);
      if (incomingTime < existingTime) throw new ChatGptCaptureConflictError("stale");
      if (
        incomingTime === existingTime
        || existing.revision === snapshot.revision
      ) {
        throw new ChatGptCaptureConflictError("revision_conflict");
      }
      if (statusRank(snapshot.status) < statusRank(existing.status)) {
        throw new ChatGptCaptureConflictError("lifecycle_regression");
      }
    }

    await this.#writeAtomic(root, destination, incomingSerialized);
    return {
      outcome: existing === undefined ? "created" : "updated",
      conversationIdHash: idHash,
      revisionHash,
      updatedAt: snapshot.updatedAt,
      status: snapshot.status,
    };
      } finally {
        await processLock.release();
      }
    });
  }

  async #acquireProcessWriteLock(
    root: string,
  ): Promise<{ release(): Promise<void> }> {
    const lockPath = join(root, ".inbox-write.lock");
    const recoveryPath = `${lockPath}.recovery`;
    const noFollow = typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0;

    const recoveryState = await inspectInboxProcessLock(recoveryPath);
    if (recoveryState === "active") {
      throw new ChatGptCaptureConflictError("concurrent_update");
    }
    if (recoveryState === "stale") {
      throw new ChatGptCaptureUnavailableError(
        "ChatGPT capture inbox stale recovery lock requires operator review",
      );
    }

    let published;
    try {
      published = await this.#publishProcessLock(root, lockPath);
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        const state = await inspectInboxProcessLock(lockPath);
        if (state === "active") {
          throw new ChatGptCaptureConflictError("concurrent_update");
        }
        // Automatic stale-lock reclamation is intentionally forbidden here.
        // Removing a stale path after a separate liveness check creates a
        // cross-process TOCTOU window in which a new writer's lock can be
        // deleted. Fail closed and require an explicit operator cleanup.
        throw new ChatGptCaptureUnavailableError(
          "ChatGPT capture inbox stale write lock requires operator review",
        );
      }
      throw error;
    }

    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        try {
          const current = await lstat(lockPath, { bigint: true });
          if (
            current.dev !== published.device
            || current.ino !== published.inode
          ) {
            throw new ChatGptCaptureUnavailableError(
              "ChatGPT capture inbox write lock ownership changed",
            );
          }
          await rm(lockPath);
          await syncDirectory(root);
        } finally {
          await published.handle.close().catch(() => undefined);
        }
      },
    };
  }

  async #publishProcessLock(
    root: string,
    lockPath: string,
  ): Promise<{
    handle: Awaited<ReturnType<typeof open>>;
    device: bigint;
    inode: bigint;
  }> {
    const noFollow = typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0;
    const temporary = join(
      root,
      `.${basename(lockPath)}.${randomUUID()}.publish.tmp`,
    );
    let handle;
    let published:
      | { device: bigint; inode: bigint }
      | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      const identity = await inboxProcessIdentity();
      await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
      await handle.sync();
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || (info.mode & 0o077n) !== 0n) {
        throw new Error("ChatGPT capture inbox lock must be owner-private");
      }
      if (
        typeof process.getuid === "function"
        && info.uid !== BigInt(process.getuid())
      ) {
        throw new Error("ChatGPT capture inbox lock owner mismatch");
      }

      // link() publishes the fully initialized inode only if lockPath does not
      // already exist; readers can therefore never observe an empty/partial lock.
      await link(temporary, lockPath);
      published = { device: info.dev, inode: info.ino };
      await syncDirectory(root);
      await rm(temporary);
      await syncDirectory(root);
      return {
        handle,
        device: info.dev,
        inode: info.ino,
      };
    } catch (error) {
      if (published !== undefined) {
        try {
          const current = await lstat(lockPath, { bigint: true });
          if (
            current.dev === published.device
            && current.ino === published.inode
          ) {
            await rm(lockPath, { force: true });
            await syncDirectory(root);
          }
        } catch (cleanupError) {
          if (!(
            cleanupError instanceof Error
            && "code" in cleanupError
            && (cleanupError as NodeJS.ErrnoException).code === "ENOENT"
          )) {
            // Preserve the original publication failure, but never risk
            // deleting a replacement lock whose ownership cannot be verified.
          }
        }
      }
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #ensureRoot(): Promise<string> {
    if (this.#root !== undefined) {
      const info = await lstat(this.#requestedRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("ChatGPT capture inbox root must remain a private directory");
      }
      if ((info.mode & 0o077) !== 0) {
        throw new Error("ChatGPT capture inbox root must not grant group/world permissions");
      }
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error("ChatGPT capture inbox root owner mismatch");
      }
      const current = await realpath(this.#requestedRoot);
      if (current !== this.#root) {
        throw new Error("ChatGPT capture inbox root changed after initialization");
      }
      return this.#root;
    }
    const parent = dirname(this.#requestedRoot);
    try {
      await lstat(this.#requestedRoot);
    } catch (error) {
      if (!(
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      )) {
        throw error;
      }
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
        throw new Error("ChatGPT capture inbox parent must be a real directory");
      }
      if (
        typeof process.getuid === "function"
        && parentInfo.uid !== process.getuid()
      ) {
        throw new Error("ChatGPT capture inbox parent owner mismatch");
      }
      try {
        await mkdir(this.#requestedRoot, { mode: 0o700 });
      } catch (mkdirError) {
        if (!(
          mkdirError instanceof Error
          && "code" in mkdirError
          && (mkdirError as NodeJS.ErrnoException).code === "EEXIST"
        )) {
          throw mkdirError;
        }
      }
    }
    // Always publish/confirm the root directory entry durably before caching
    // the root. This also repairs a prior initialization attempt where mkdir
    // succeeded but parent fsync failed, and closes concurrent initialization
    // races because every initializer performs its own parent fsync.
    await syncDirectory(parent);
    const info = await lstat(this.#requestedRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("ChatGPT capture inbox root must be a private directory");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error("ChatGPT capture inbox root must not grant group/world permissions");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("ChatGPT capture inbox root owner mismatch");
    }
    const canonical = await realpath(this.#requestedRoot);
    if (!isAbsolute(canonical)) throw new Error("ChatGPT capture inbox root must be absolute");
    this.#root = canonical;
    return canonical;
  }

  async #writeAtomic(root: string, destination: string, serialized: string): Promise<void> {
    if (dirname(destination) !== root || basename(destination).includes("/")) {
      throw new Error("ChatGPT capture inbox destination escaped root");
    }
    const temporary = join(root, `.${basename(destination)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0),
        0o600,
      );
      await handle.writeFile(`${serialized}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      await syncDirectory(root);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export interface ChatGptCaptureInboxHttpOptions {
  bearerToken: string;
  store: ChatGptCaptureInboxStore;
  maxBodyBytes?: number;
}

export class ChatGptCaptureInboxHttp {
  readonly #token: Buffer;
  readonly #store: ChatGptCaptureInboxStore;
  readonly #maxBodyBytes: number;

  constructor(options: ChatGptCaptureInboxHttpOptions) {
    if (options.bearerToken.length < 32) {
      throw new Error("ChatGPT capture inbox bearer token must be at least 32 characters");
    }
    this.#token = Buffer.from(options.bearerToken, "utf8");
    this.#store = options.store;
    this.#maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#maxBodyBytes)
      || this.#maxBodyBytes < 1024
      || this.#maxBodyBytes > 8 * 1024 * 1024
    ) {
      throw new Error("ChatGPT capture inbox maxBodyBytes is invalid");
    }
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return this.#json(200, {
        ok: true,
        contract: CHATGPT_CAPTURE_INBOX_CONTRACT,
        canonicalMemoryWrites: 0,
      });
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      try {
        await this.#store.ready();
        return this.#json(200, {
          ok: true,
          contract: CHATGPT_CAPTURE_INBOX_CONTRACT,
          ready: true,
          canonicalMemoryWrites: 0,
        });
      } catch {
        return this.#json(503, {
          ok: false,
          contract: CHATGPT_CAPTURE_INBOX_CONTRACT,
          ready: false,
        });
      }
    }
    if (url.pathname !== "/v1/chatgpt-capture" || request.method !== "POST") {
      return this.#json(404, { error: "not_found" });
    }

    if (!this.#authorized(request.headers.get("authorization"))) {
      return this.#json(401, { error: "unauthorized" });
    }
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return this.#json(415, { error: "unsupported_media_type" });
    }

    let value: unknown;
    try {
      const text = await this.#readBoundedBody(request);
      value = JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof RangeError) {
        return this.#json(413, { error: "body_too_large" });
      }
      return this.#json(400, { error: "invalid_json" });
    }

    try {
      const result = await this.#store.put(value);
      return this.#json(result.outcome === "created" ? 201 : 200, {
        ok: true,
        contract: CHATGPT_CAPTURE_INBOX_CONTRACT,
        outcome: result.outcome,
        conversationIdHash: result.conversationIdHash,
        revisionHash: result.revisionHash,
        updatedAt: result.updatedAt,
        status: result.status,
        canonicalMemoryWrites: 0,
      });
    } catch (error) {
      if (error instanceof ChatGptCaptureConflictError) {
        return this.#json(409, { error: "capture_conflict", reason: error.reason });
      }
      if (error instanceof ChatGptCaptureUnavailableError) {
        return this.#json(503, { error: "capture_unavailable" });
      }
      return this.#json(400, { error: "invalid_capture" });
    }
  }

  #authorized(header: string | null): boolean {
    if (header === null || !header.startsWith("Bearer ")) return false;
    const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
    if (provided.length !== this.#token.length) return false;
    return timingSafeEqual(provided, this.#token);
  }

  async #readBoundedBody(request: Request): Promise<string> {
    const declared = request.headers.get("content-length");
    if (declared !== null) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 0) throw new Error("invalid content length");
      if (length > this.#maxBodyBytes) throw new RangeError("body too large");
    }
    if (request.body === null) return "";
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > this.#maxBodyBytes) throw new RangeError("body too large");
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }

  #json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}
