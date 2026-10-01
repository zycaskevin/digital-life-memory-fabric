import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DistillationReceipt } from "../distillation/types.js";
import type { MemoryScope } from "../domain/types.js";
import type {
  ExperienceUnit,
  NormalizedExperience,
  SourceAdapterInspection,
  SourceFingerprint,
} from "./contracts.js";
import {
  projectDevelopmentExperienceReference,
  type DevelopmentExperienceDisposition,
  type DlmfDevelopmentExperienceReference,
} from "./development-experience-reference.js";
import type { MemorySourceAdapter } from "./source-adapter.js";
import type { NormalizedExperienceIngestor } from "./source-migration.js";
import { assertNormalizedExperience } from "./validation.js";

export const INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT =
  "dlmf/source-incremental-checkpoint/v1" as const;

export interface IncrementalSourceCheckpoint {
  contract: typeof INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT;
  adapterName: string;
  adapterVersion: string;
  sourceSystem: string;
  sourceType: string;
  scope: MemoryScope;
  processingMode: "reference_only" | "distillation";
  policyId: string;
  fingerprints: Record<string, string>;
  updatedAt: string;
}

export interface IncrementalSourceCheckpointStore {
  load(): Promise<IncrementalSourceCheckpoint | undefined>;
  save(checkpoint: IncrementalSourceCheckpoint): Promise<void>;
  /**
   * Optional O(1) durable per-source progress append. Stores that implement
   * this can preserve crash-safe progress without rewriting the full
   * fingerprint map for every source.
   */
  appendFingerprint?(
    checkpoint: IncrementalSourceCheckpoint,
    sourceId: string,
  ): Promise<void>;
  /**
   * Optional cross-instance/process single-writer boundary. Durable stores
   * should implement this so source submission and checkpoint advance cannot
   * overlap another run against the same checkpoint.
   */
  runExclusive?<T>(operation: () => Promise<T>): Promise<T>;
}

const inProcessStoreQueues = new WeakMap<
  IncrementalSourceCheckpointStore,
  Promise<void>
>();

async function runStoreExclusive<T>(
  store: IncrementalSourceCheckpointStore,
  operation: () => Promise<T>,
): Promise<T> {
  if (store.runExclusive !== undefined) {
    return store.runExclusive(operation);
  }
  const previous = inProcessStoreQueues.get(store) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  inProcessStoreQueues.set(store, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`incremental source checkpoint ${field} is invalid`);
  }
  return value;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`incremental source checkpoint ${field} must be a lowercase sha256 digest`);
  }
  return value;
}

export function validateIncrementalSourceCheckpoint(
  value: unknown,
): IncrementalSourceCheckpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("incremental source checkpoint must be an object");
  }
  const raw = value as Partial<IncrementalSourceCheckpoint>;
  if (raw.contract !== INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT) {
    throw new Error("unsupported incremental source checkpoint contract");
  }
  requireNonEmpty(raw.adapterName, "adapterName");
  requireNonEmpty(raw.adapterVersion, "adapterVersion");
  requireNonEmpty(raw.sourceSystem, "sourceSystem");
  requireNonEmpty(raw.sourceType, "sourceType");
  if (raw.scope === null || typeof raw.scope !== "object" || Array.isArray(raw.scope)) {
    throw new Error("incremental source checkpoint scope is invalid");
  }
  const checkpointScope = raw.scope as Partial<MemoryScope>;
  requireNonEmpty(checkpointScope.tenantId, "scope.tenantId");
  requireNonEmpty(checkpointScope.lifeDid, "scope.lifeDid");
  requireNonEmpty(checkpointScope.memoryNamespace, "scope.memoryNamespace");
  if (raw.processingMode !== "reference_only" && raw.processingMode !== "distillation") {
    throw new Error("incremental source checkpoint processingMode is invalid");
  }
  requireNonEmpty(raw.policyId, "policyId");
  requireNonEmpty(raw.updatedAt, "updatedAt");
  if (
    raw.fingerprints === null
    || typeof raw.fingerprints !== "object"
    || Array.isArray(raw.fingerprints)
  ) {
    throw new Error("incremental source checkpoint fingerprints are invalid");
  }
  for (const [sourceId, fingerprint] of Object.entries(raw.fingerprints)) {
    requireNonEmpty(sourceId, "fingerprints sourceId");
    requireSha256(fingerprint, `fingerprint for ${sourceId}`);
  }
  return structuredClone(raw as IncrementalSourceCheckpoint);
}

const INCREMENTAL_SOURCE_DELTA_CONTRACT =
  "dlmf/source-incremental-delta/v1" as const;

interface IncrementalSourceCheckpointDelta {
  contract: typeof INCREMENTAL_SOURCE_DELTA_CONTRACT;
  adapterName: string;
  adapterVersion: string;
  sourceSystem: string;
  sourceType: string;
  scope: MemoryScope;
  processingMode: IncrementalSourceCheckpoint["processingMode"];
  policyId: string;
  sourceId: string;
  fingerprint: string;
  updatedAt: string;
}

function checkpointIdentityMatches(
  checkpoint: IncrementalSourceCheckpoint,
  identity: Omit<
    IncrementalSourceCheckpointDelta,
    "contract" | "sourceId" | "fingerprint" | "updatedAt"
  >,
): boolean {
  return checkpoint.adapterName === identity.adapterName
    && checkpoint.adapterVersion === identity.adapterVersion
    && checkpoint.sourceSystem === identity.sourceSystem
    && checkpoint.sourceType === identity.sourceType
    && checkpoint.scope.tenantId === identity.scope.tenantId
    && checkpoint.scope.lifeDid === identity.scope.lifeDid
    && checkpoint.scope.memoryNamespace === identity.scope.memoryNamespace
    && checkpoint.processingMode === identity.processingMode
    && checkpoint.policyId === identity.policyId;
}

function validateCheckpointDelta(value: unknown): IncrementalSourceCheckpointDelta {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("incremental source checkpoint delta must be an object");
  }
  const raw = value as Partial<IncrementalSourceCheckpointDelta>;
  if (raw.contract !== INCREMENTAL_SOURCE_DELTA_CONTRACT) {
    throw new Error("unsupported incremental source checkpoint delta contract");
  }
  requireNonEmpty(raw.adapterName, "delta.adapterName");
  requireNonEmpty(raw.adapterVersion, "delta.adapterVersion");
  requireNonEmpty(raw.sourceSystem, "delta.sourceSystem");
  requireNonEmpty(raw.sourceType, "delta.sourceType");
  if (raw.scope === null || typeof raw.scope !== "object" || Array.isArray(raw.scope)) {
    throw new Error("incremental source checkpoint delta scope is invalid");
  }
  const scope = raw.scope as Partial<MemoryScope>;
  requireNonEmpty(scope.tenantId, "delta.scope.tenantId");
  requireNonEmpty(scope.lifeDid, "delta.scope.lifeDid");
  requireNonEmpty(scope.memoryNamespace, "delta.scope.memoryNamespace");
  if (raw.processingMode !== "reference_only" && raw.processingMode !== "distillation") {
    throw new Error("incremental source checkpoint delta processingMode is invalid");
  }
  requireNonEmpty(raw.policyId, "delta.policyId");
  requireNonEmpty(raw.sourceId, "delta.sourceId");
  requireSha256(raw.fingerprint, "delta.fingerprint");
  requireNonEmpty(raw.updatedAt, "delta.updatedAt");
  return structuredClone(raw as IncrementalSourceCheckpointDelta);
}

interface IncrementalCheckpointPaths {
  checkpointPath: string;
  journalPath: string;
  lockPath: string;
  directory: string;
}

async function syncDirectory(directory: string): Promise<void> {
  const flags = constants.O_RDONLY
    | (typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0);
  const handle = await open(directory, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class FileIncrementalSourceCheckpointStore
implements IncrementalSourceCheckpointStore {
  readonly #requestedPath: string;
  #pathsCache: IncrementalCheckpointPaths | undefined;
  #identityCache: IncrementalSourceCheckpoint | undefined;
  readonly #lockContext = new AsyncLocalStorage<symbol>();
  #activeLockToken: symbol | undefined;

  constructor(path: string) {
    if (!path.trim()) throw new Error("incremental source checkpoint path must not be empty");
    this.#requestedPath = resolve(path);
  }

  async load(): Promise<IncrementalSourceCheckpoint | undefined> {
    if (this.#ownsCurrentLockContext()) {
      return this.#loadUnlocked();
    }
    return this.runExclusive(() => this.#loadUnlocked());
  }

  #ownsCurrentLockContext(): boolean {
    const contextToken = this.#lockContext.getStore();
    return this.#activeLockToken !== undefined
      && contextToken === this.#activeLockToken;
  }

  async #loadUnlocked(): Promise<IncrementalSourceCheckpoint | undefined> {
    const paths = await this.#paths();
    const text = await this.#readOptionalPrivateText(paths.checkpointPath);
    const journal = await this.#readRecoverableJournal(paths);
    if (text === undefined) {
      if (journal !== undefined && journal.trim().length > 0) {
        throw new Error("incremental source checkpoint has an orphan delta journal");
      }
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("incremental source checkpoint file contains invalid JSON");
    }
    const checkpoint = validateIncrementalSourceCheckpoint(parsed);

    if (journal !== undefined) {
      for (const [index, rawLine] of journal.split(/\r?\n/u).entries()) {
        if (!rawLine.trim()) continue;
        let rawDelta: unknown;
        try {
          rawDelta = JSON.parse(rawLine);
        } catch {
          throw new Error(
            `incremental source checkpoint journal contains invalid JSON at line ${index + 1}`,
          );
        }
        const delta = validateCheckpointDelta(rawDelta);
        if (!checkpointIdentityMatches(checkpoint, delta)) {
          throw new Error(
            "incremental source checkpoint delta does not belong to checkpoint identity",
          );
        }
        Object.defineProperty(checkpoint.fingerprints, delta.sourceId, {
          value: delta.fingerprint,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        checkpoint.updatedAt = delta.updatedAt;
      }
    }
    this.#cacheIdentity(checkpoint);
    return checkpoint;
  }

  async save(checkpoint: IncrementalSourceCheckpoint): Promise<void> {
    if (this.#ownsCurrentLockContext()) {
      return this.#saveUnlocked(checkpoint, true);
    }
    return this.runExclusive(() => this.#saveUnlocked(checkpoint, false));
  }

  async #saveUnlocked(
    checkpoint: IncrementalSourceCheckpoint,
    allowReplaceCurrent: boolean,
  ): Promise<void> {
    const validated = validateIncrementalSourceCheckpoint(checkpoint);
    if (!allowReplaceCurrent) {
      const current = await this.#loadUnlocked();
      if (current !== undefined) {
        if (!checkpointIdentityMatches(current, {
          adapterName: validated.adapterName,
          adapterVersion: validated.adapterVersion,
          sourceSystem: validated.sourceSystem,
          sourceType: validated.sourceType,
          scope: validated.scope,
          processingMode: validated.processingMode,
          policyId: validated.policyId,
        })) {
          throw new Error(
            "incremental source checkpoint save identity conflicts with durable state",
          );
        }
        for (const [sourceId, fingerprint] of Object.entries(current.fingerprints)) {
          if (
            !Object.hasOwn(validated.fingerprints, sourceId)
            || validated.fingerprints[sourceId] !== fingerprint
          ) {
            throw new Error(
              "incremental source checkpoint save is stale and would overwrite durable progress",
            );
          }
        }
      }
    }
    const paths = await this.#paths();
    await this.#writeSnapshot(validated, paths);
    await rm(paths.journalPath, { force: true });
    // Publish journal retirement durably after the replacement snapshot.
    await syncDirectory(paths.directory);
    this.#cacheIdentity(validated);
  }

  async appendFingerprint(
    checkpoint: IncrementalSourceCheckpoint,
    sourceId: string,
  ): Promise<void> {
    if (this.#ownsCurrentLockContext()) {
      return this.#appendFingerprintUnlocked(checkpoint, sourceId);
    }
    return this.runExclusive(
      () => this.#appendFingerprintUnlocked(checkpoint, sourceId),
    );
  }

  async #appendFingerprintUnlocked(
    checkpoint: IncrementalSourceCheckpoint,
    sourceId: string,
  ): Promise<void> {
    requireNonEmpty(sourceId, "delta.sourceId");
    if (!Object.hasOwn(checkpoint.fingerprints, sourceId)) {
      throw new Error("incremental source checkpoint delta fingerprint is missing");
    }
    const fingerprint = checkpoint.fingerprints[sourceId]!;
    const delta: IncrementalSourceCheckpointDelta = {
      contract: INCREMENTAL_SOURCE_DELTA_CONTRACT,
      adapterName: checkpoint.adapterName,
      adapterVersion: checkpoint.adapterVersion,
      sourceSystem: checkpoint.sourceSystem,
      sourceType: checkpoint.sourceType,
      scope: structuredClone(checkpoint.scope),
      processingMode: checkpoint.processingMode,
      policyId: checkpoint.policyId,
      sourceId,
      fingerprint,
      updatedAt: checkpoint.updatedAt,
    };
    validateCheckpointDelta(delta);

    const paths = await this.#paths();
    // Recover only an uncommitted final fragment while the same writer lock is
    // held, so a public append cannot concatenate a new delta onto torn JSON.
    await this.#readRecoverableJournal(paths);

    if (this.#identityCache === undefined) {
      const baseText = await this.#readOptionalPrivateText(paths.checkpointPath);
      if (baseText === undefined) {
        const base: IncrementalSourceCheckpoint = {
          contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
          adapterName: delta.adapterName,
          adapterVersion: delta.adapterVersion,
          sourceSystem: delta.sourceSystem,
          sourceType: delta.sourceType,
          scope: structuredClone(delta.scope),
          processingMode: delta.processingMode,
          policyId: delta.policyId,
          fingerprints: {},
          updatedAt: delta.updatedAt,
        };
        await this.#writeSnapshot(base, paths);
        this.#cacheIdentity(base);
      } else {
        let rawBase: unknown;
        try {
          rawBase = JSON.parse(baseText);
        } catch {
          throw new Error("incremental source checkpoint file contains invalid JSON");
        }
        const base = validateIncrementalSourceCheckpoint(rawBase);
        this.#cacheIdentity(base);
      }
    }

    if (!checkpointIdentityMatches(this.#identityCache!, delta)) {
      throw new Error(
        "incremental source checkpoint delta does not belong to checkpoint identity",
      );
    }

    const noFollow = typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0;
    const nonBlock = typeof constants.O_NONBLOCK === "number"
      ? constants.O_NONBLOCK
      : 0;
    let journal;
    try {
      journal = await open(
        paths.journalPath,
        constants.O_WRONLY
          | constants.O_APPEND
          | constants.O_CREAT
          | noFollow
          | nonBlock,
        0o600,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new Error("incremental source checkpoint journal must not be a symlink");
      }
      if (isNodeError(error) && error.code === "ENXIO") {
        throw new Error("incremental source checkpoint journal must be a regular file");
      }
      throw error;
    }
    try {
      const info = await journal.stat();
      if (!info.isFile()) {
        throw new Error("incremental source checkpoint journal must be a regular file");
      }
      // Tighten privacy before disclosing any checkpoint identity/source IDs.
      await journal.chmod(0o600);
      await journal.writeFile(`${JSON.stringify(delta)}\n`, "utf8");
      await journal.sync();
    } finally {
      await journal.close();
    }
    await syncDirectory(paths.directory);
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const paths = await this.#paths();
    let lock;
    try {
      lock = await open(paths.lockPath, "wx", 0o600);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(
          "incremental source checkpoint already has an active writer; "
          + "stale lock cleanup requires explicit operator review",
        );
      }
      throw error;
    }
    try {
      await lock.chmod(0o600);
      await lock.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await lock.sync();
      await syncDirectory(paths.directory);
      this.#identityCache = undefined;
      const token = Symbol("incremental-source-run-lock");
      this.#activeLockToken = token;
      return await this.#lockContext.run(token, operation);
    } finally {
      this.#activeLockToken = undefined;
      await lock.close().catch(() => undefined);
      await rm(paths.lockPath, { force: true }).catch(() => undefined);
      await syncDirectory(paths.directory).catch(() => undefined);
    }
  }

  #cacheIdentity(checkpoint: IncrementalSourceCheckpoint): void {
    this.#identityCache = {
      contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
      adapterName: checkpoint.adapterName,
      adapterVersion: checkpoint.adapterVersion,
      sourceSystem: checkpoint.sourceSystem,
      sourceType: checkpoint.sourceType,
      scope: structuredClone(checkpoint.scope),
      processingMode: checkpoint.processingMode,
      policyId: checkpoint.policyId,
      fingerprints: {},
      updatedAt: checkpoint.updatedAt,
    };
  }

  async #paths(): Promise<IncrementalCheckpointPaths> {
    const requestedDirectory = dirname(this.#requestedPath);
    if (this.#pathsCache !== undefined) {
      const currentDirectory = await realpath(requestedDirectory);
      if (currentDirectory !== this.#pathsCache.directory) {
        throw new Error(
          "incremental source checkpoint directory changed after initialization",
        );
      }
      return this.#pathsCache;
    }

    await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(requestedDirectory);

    try {
      const requested = await lstat(this.#requestedPath);
      if (requested.isSymbolicLink()) {
        throw new Error("incremental source checkpoint path must not be a symlink");
      }
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
    }

    const checkpointPath = join(
      canonicalDirectory,
      basename(this.#requestedPath),
    );
    this.#pathsCache = {
      checkpointPath,
      journalPath: `${checkpointPath}.journal`,
      lockPath: `${checkpointPath}.run.lock`,
      directory: canonicalDirectory,
    };
    return this.#pathsCache;
  }

  async #readOptionalPrivateText(path: string): Promise<string | undefined> {
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
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new Error("incremental source checkpoint file must not be a symlink");
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new Error("incremental source checkpoint path must be a regular file");
      }
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  }

  async #readRecoverableJournal(
    paths: IncrementalCheckpointPaths,
  ): Promise<string | undefined> {
    const noFollow = typeof constants.O_NOFOLLOW === "number"
      ? constants.O_NOFOLLOW
      : 0;
    const nonBlock = typeof constants.O_NONBLOCK === "number"
      ? constants.O_NONBLOCK
      : 0;
    let handle;
    try {
      handle = await open(
        paths.journalPath,
        constants.O_RDWR | noFollow | nonBlock,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new Error("incremental source checkpoint journal must not be a symlink");
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new Error("incremental source checkpoint journal must be a regular file");
      }
      await handle.chmod(0o600);
      let text = await handle.readFile({ encoding: "utf8" });
      if (text.length > 0 && !text.endsWith("\n")) {
        // Writers always terminate committed records with a newline. A final
        // unterminated fragment is therefore a torn append: retain all complete
        // preceding records and truncate only the uncommitted tail.
        const lastBoundary = text.lastIndexOf("\n");
        const complete = lastBoundary < 0 ? "" : text.slice(0, lastBoundary + 1);
        await handle.truncate(Buffer.byteLength(complete, "utf8"));
        await handle.sync();
        await syncDirectory(paths.directory);
        text = complete;
      }
      return text;
    } finally {
      await handle.close();
    }
  }

  async #writeSnapshot(
    checkpoint: IncrementalSourceCheckpoint,
    paths?: IncrementalCheckpointPaths,
  ): Promise<void> {
    const resolvedPaths = paths ?? await this.#paths();
    const temporary = `${resolvedPaths.checkpointPath}.tmp-${process.pid}-${randomUUID()}`;
    let temporaryHandle;
    try {
      temporaryHandle = await open(temporary, "wx", 0o600);
      await temporaryHandle.writeFile(
        `${JSON.stringify(checkpoint, null, 2)}\n`,
        "utf8",
      );
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await rename(temporary, resolvedPaths.checkpointPath);
      // The snapshot bytes and directory entry are durable before callers are
      // allowed to retire the delta journal.
      await syncDirectory(resolvedPaths.directory);
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export type IncrementalSourceDecision =
  | { action: "distill" }
  | {
      action: "source_only";
      reasonCode: string;
      disposition?: Extract<
        DevelopmentExperienceDisposition,
        "TRANSIENT_SOURCE_ONLY" | "REFERENCE_ONLY"
      >;
    }
  | { action: "defer"; reasonCode: string };

export interface GenericIncrementalSourceSyncOptions<TSourcePayload> {
  adapter: MemorySourceAdapter<TSourcePayload>;
  checkpointStore: IncrementalSourceCheckpointStore;
  scope: MemoryScope;
  ingestor?: NormalizedExperienceIngestor;
  referenceOnly?: boolean;
  policyId?: string;
  decide?: (
    experience: NormalizedExperience,
  ) => IncrementalSourceDecision | Promise<IncrementalSourceDecision>;
  /**
   * Source-policy state that is intentionally separate from the evidence
   * fingerprint (for example active/completed status or journal mtime).
   * When provided, the service re-reads the source and requires this key to
   * remain stable before any distillation decision is acted on.
   */
  eligibilityStateKey?: (
    experience: NormalizedExperience,
  ) => string;
  /**
   * Optional durable sink for a content-free Development reference that must
   * succeed before the corresponding source fingerprint is checkpointed.
   * This allows sidecar workers to make reference journaling crash-safe without
   * moving memory authority outside DLMF.
   */
  beforeCheckpointReference?: (
    reference: DlmfDevelopmentExperienceReference,
  ) => Promise<void>;
  pageSize?: number;
  clock?: () => Date;
}

export interface IncrementalSourceSyncResult {
  scanned: number;
  changed: number;
  ingested: number;
  sourceOnly: number;
  deferred: number;
  noTextualEvidence: number;
  unchanged: number;
  receipts: Array<Pick<DistillationReceipt, "receiptId" | "status">>;
  experiences: DlmfDevelopmentExperienceReference[];
}

function sameFingerprint(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function validateFingerprint(fingerprint: SourceFingerprint): void {
  if (
    fingerprint.algorithm !== "sha256"
    || !/^[0-9a-f]{64}$/.test(fingerprint.value)
  ) {
    throw new Error("source adapter returned an invalid source fingerprint");
  }
}

function terminalReceipt(receipt: Pick<DistillationReceipt, "status">): boolean {
  return receipt.status === "complete" || receipt.status === "awaiting_review";
}

function hasTextualEvidence(experience: NormalizedExperience): boolean {
  return experience.events.some(
    (event) => typeof event.content === "string" && event.content.trim().length > 0,
  ) || experience.content.some(
    (content) => typeof content.text === "string" && content.text.trim().length > 0,
  );
}

function validateDecision(decision: IncrementalSourceDecision): void {
  const raw = decision as unknown as {
    action?: unknown;
    reasonCode?: unknown;
    disposition?: unknown;
  };
  if (
    raw.action !== "distill"
    && raw.action !== "source_only"
    && raw.action !== "defer"
  ) {
    throw new Error("incremental source decision action is invalid");
  }
  if (raw.action === "distill") return;
  if (
    typeof raw.reasonCode !== "string"
    || !raw.reasonCode.trim()
    || raw.reasonCode.length > 128
  ) {
    throw new Error("incremental source decision reasonCode must contain 1..128 characters");
  }
  if (
    raw.action === "source_only"
    && raw.disposition !== undefined
    && raw.disposition !== "TRANSIENT_SOURCE_ONLY"
    && raw.disposition !== "REFERENCE_ONLY"
  ) {
    throw new Error("incremental source decision disposition is invalid");
  }
}

function emptyResult(): IncrementalSourceSyncResult {
  return {
    scanned: 0,
    changed: 0,
    ingested: 0,
    sourceOnly: 0,
    deferred: 0,
    noTextualEvidence: 0,
    unchanged: 0,
    receipts: [],
    experiences: [],
  };
}

/**
 * Source-neutral polling bridge for mutable external Experience Units.
 *
 * It deliberately owns only source observation/checkpoint semantics. Memory
 * worthiness remains downstream DLMF governance. A deferred source version is
 * never checkpointed, allowing a later session-close/idle decision to admit the
 * exact same fingerprint without requiring another content mutation.
 */
export class GenericIncrementalSourceSyncService<TSourcePayload> {
  readonly #adapter: MemorySourceAdapter<TSourcePayload>;
  readonly #checkpointStore: IncrementalSourceCheckpointStore;
  readonly #scope: MemoryScope;
  readonly #ingestor: NormalizedExperienceIngestor | undefined;
  readonly #referenceOnly: boolean;
  readonly #policyId: string;
  readonly #decide: GenericIncrementalSourceSyncOptions<TSourcePayload>["decide"];
  readonly #eligibilityStateKey:
    | GenericIncrementalSourceSyncOptions<TSourcePayload>["eligibilityStateKey"]
    | undefined;
  readonly #beforeCheckpointReference:
    | GenericIncrementalSourceSyncOptions<TSourcePayload>["beforeCheckpointReference"]
    | undefined;
  readonly #pageSize: number;
  readonly #clock: () => Date;

  constructor(options: GenericIncrementalSourceSyncOptions<TSourcePayload>) {
    this.#adapter = options.adapter;
    this.#checkpointStore = options.checkpointStore;
    this.#scope = structuredClone(options.scope);
    this.#ingestor = options.ingestor;
    this.#referenceOnly = options.referenceOnly === true;
    this.#policyId = options.policyId ?? "default";
    if (!this.#policyId.trim() || this.#policyId !== this.#policyId.trim()) {
      throw new Error("incremental source policyId must not be empty or padded");
    }
    this.#decide = options.decide;
    this.#eligibilityStateKey = options.eligibilityStateKey;
    this.#beforeCheckpointReference = options.beforeCheckpointReference;
    this.#pageSize = options.pageSize ?? 250;
    this.#clock = options.clock ?? (() => new Date());
    if (!Number.isInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 1000) {
      throw new Error("incremental source pageSize must be an integer between 1 and 1000");
    }
    for (const [field, value] of Object.entries(this.#scope)) {
      if (
        typeof value !== "string"
        || value.trim().length === 0
        || value !== value.trim()
      ) {
        throw new Error(
          `incremental source scope.${field} must not be empty or padded`,
        );
      }
    }
    if (this.#referenceOnly && this.#ingestor !== undefined) {
      throw new Error("reference-only incremental source sync must not receive an ingestor");
    }
  }

  baselineCurrent(): Promise<IncrementalSourceSyncResult> {
    return runStoreExclusive(
      this.#checkpointStore,
      () => this.#baselineCurrentUnlocked(),
    );
  }

  async #baselineCurrentUnlocked(): Promise<IncrementalSourceSyncResult> {
    const inspection = await this.#inspection();
    if (await this.#checkpointStore.load() !== undefined) {
      throw new Error("incremental source baseline requires an empty checkpoint store");
    }
    const checkpoint = this.#newCheckpoint(inspection);
    const result = emptyResult();
    await this.#scan(inspection, async (unit) => {
      result.scanned += 1;

      if (!this.#referenceOnly && this.#decide !== undefined) {
        const read = await this.#adapter.read(unit);
        const normalized = await this.#adapter.normalize(read);
        assertNormalizedExperience(normalized);
        this.#assertNormalizedMatchesUnit(normalized, unit, inspection);

        const stableExperience = this.#eligibilityStateKey === undefined
          ? normalized
          : await this.#revalidateEligibilityState(
              normalized,
              unit,
              inspection,
            );
        const decision = await this.#decide(stableExperience);
        validateDecision(decision);
        if (decision.action === "defer") {
          result.deferred += 1;
          result.experiences.push(
            projectDevelopmentExperienceReference(
              stableExperience,
              this.#scope,
              "REFERENCE_ONLY",
            ),
          );
          return;
        }

        // The policy callback may be asynchronous. Revalidate lifecycle state
        // after it returns and before baseline marks this exact evidence version
        // as already observed. Otherwise completed -> active drift with unchanged
        // evidence could be checkpointed and never reconsidered later.
        const finalExperience = this.#eligibilityStateKey === undefined
          ? stableExperience
          : await this.#revalidateEligibilityState(
              stableExperience,
              unit,
              inspection,
            );
        validateFingerprint(finalExperience.provenance.sourceFingerprint);
        this.#setFingerprint(
          checkpoint,
          unit.source.sourceId,
          finalExperience.provenance.sourceFingerprint.value,
        );
        result.unchanged += 1;
        return;
      }

      const fingerprint = await this.#adapter.fingerprint(unit);
      validateFingerprint(fingerprint);
      this.#setFingerprint(checkpoint, unit.source.sourceId, fingerprint.value);
      result.unchanged += 1;
    });
    checkpoint.updatedAt = this.#clock().toISOString();
    await this.#checkpointStore.save(checkpoint);
    return result;
  }

  runOnce(): Promise<IncrementalSourceSyncResult> {
    return runStoreExclusive(
      this.#checkpointStore,
      () => this.#runOnceUnlocked(),
    );
  }

  async #runOnceUnlocked(): Promise<IncrementalSourceSyncResult> {
    const inspection = await this.#inspection();
    const prior = await this.#checkpointStore.load();
    if (prior !== undefined) this.#assertCompatible(prior, inspection);
    const checkpoint = prior === undefined
      ? this.#newCheckpoint(inspection)
      : structuredClone(prior);
    const result = emptyResult();

    await this.#scan(inspection, async (unit) => {
      result.scanned += 1;
      const beforeRead = await this.#adapter.fingerprint(unit);
      validateFingerprint(beforeRead);
      const priorFingerprint = Object.hasOwn(checkpoint.fingerprints, unit.source.sourceId)
        ? checkpoint.fingerprints[unit.source.sourceId]
        : undefined;
      if (priorFingerprint === beforeRead.value) {
        result.unchanged += 1;
        return;
      }
      result.changed += 1;

      const read = await this.#adapter.read(unit);
      const normalized = await this.#adapter.normalize(read);
      assertNormalizedExperience(normalized);
      this.#assertNormalizedMatchesUnit(normalized, unit, inspection);

      const afterNormalize = await this.#adapter.fingerprint(unit);
      validateFingerprint(afterNormalize);
      validateFingerprint(normalized.provenance.sourceFingerprint);
      if (!sameFingerprint(afterNormalize, normalized.provenance.sourceFingerprint)) {
        throw new Error("source changed between normalization and fingerprint verification");
      }

      if (this.#referenceOnly) {
        result.sourceOnly += 1;
        const reference = projectDevelopmentExperienceReference(
          normalized,
          this.#scope,
          "REFERENCE_ONLY",
        );
        await this.#persistBeforeCheckpoint(reference);
        result.experiences.push(reference);
        await this.#advance(checkpoint, normalized, afterNormalize);
        return;
      }

      const stableExperience = this.#eligibilityStateKey === undefined
        ? normalized
        : await this.#revalidateEligibilityState(normalized, unit, inspection);

      const decision = this.#decide === undefined
        ? { action: "distill" } as const
        : await this.#decide(stableExperience);
      validateDecision(decision);

      if (decision.action === "defer") {
        result.deferred += 1;
        result.experiences.push(
          projectDevelopmentExperienceReference(
            stableExperience,
            this.#scope,
            "REFERENCE_ONLY",
          ),
        );
        return;
      }

      // A policy callback may be asynchronous. Revalidate lifecycle/eligibility
      // once more after the decision and immediately before any checkpointed or
      // distillation side effect so stale completed/idle state cannot authorize
      // work after the source has regressed to active.
      const finalExperience = this.#eligibilityStateKey === undefined
        ? stableExperience
        : await this.#revalidateEligibilityState(
            stableExperience,
            unit,
            inspection,
          );

      if (decision.action === "source_only") {
        result.sourceOnly += 1;
        const reference = projectDevelopmentExperienceReference(
          finalExperience,
          this.#scope,
          decision.disposition ?? "TRANSIENT_SOURCE_ONLY",
        );
        await this.#persistBeforeCheckpoint(reference);
        result.experiences.push(reference);
        await this.#advance(checkpoint, finalExperience, afterNormalize);
        return;
      }

      if (!hasTextualEvidence(finalExperience)) {
        result.noTextualEvidence += 1;
        const reference = projectDevelopmentExperienceReference(
          finalExperience,
          this.#scope,
          "NO_TEXTUAL_EVIDENCE",
        );
        await this.#persistBeforeCheckpoint(reference);
        result.experiences.push(reference);
        await this.#advance(checkpoint, finalExperience, afterNormalize);
        return;
      }

      if (this.#ingestor === undefined) {
        throw new Error("incremental source sync requires an ingestor for distillation");
      }
      const rawReceipt = await this.#ingestor.ingest(finalExperience);
      const receipt: Pick<DistillationReceipt, "receiptId" | "status"> = {
        receiptId: rawReceipt.receiptId,
        status: rawReceipt.status,
      };
      result.receipts.push(receipt);
      const reference = projectDevelopmentExperienceReference(
        finalExperience,
        this.#scope,
        "DISTILLATION_SUBMITTED",
        receipt,
      );
      result.experiences.push(reference);
      if (!terminalReceipt(receipt)) return;
      await this.#persistBeforeCheckpoint(reference);
      result.ingested += 1;
      await this.#advance(checkpoint, finalExperience, afterNormalize);
    });

    checkpoint.updatedAt = this.#clock().toISOString();
    await this.#checkpointStore.save(checkpoint);
    return result;
  }

  async #persistBeforeCheckpoint(
    reference: DlmfDevelopmentExperienceReference,
  ): Promise<void> {
    if (this.#beforeCheckpointReference !== undefined) {
      await this.#beforeCheckpointReference(reference);
    }
  }

  async #revalidateEligibilityState(
    initial: NormalizedExperience,
    unit: ExperienceUnit,
    inspection: SourceAdapterInspection,
  ): Promise<NormalizedExperience> {
    if (this.#eligibilityStateKey === undefined) return initial;
    const initialKey = this.#eligibilityStateKey(initial);
    if (!initialKey.trim()) {
      throw new Error("incremental source eligibility state key must not be empty");
    }

    const reread = await this.#adapter.read(unit);
    const current = await this.#adapter.normalize(reread);
    assertNormalizedExperience(current);
    this.#assertNormalizedMatchesUnit(current, unit, inspection);
    validateFingerprint(current.provenance.sourceFingerprint);

    // The reread itself is the final source sample for both lifecycle state
    // and evidence. Do not issue another evidence-only fingerprint read here:
    // that could observe a later lifecycle regression without carrying the
    // corresponding state into the policy decision.
    if (
      !sameFingerprint(
        current.provenance.sourceFingerprint,
        initial.provenance.sourceFingerprint,
      )
    ) {
      throw new Error("source changed during eligibility-state revalidation");
    }

    const currentKey = this.#eligibilityStateKey(current);
    if (!currentKey.trim()) {
      throw new Error("incremental source eligibility state key must not be empty");
    }
    if (currentKey !== initialKey) {
      throw new Error("source eligibility state changed before distillation");
    }
    return current;
  }

  async #inspection(): Promise<SourceAdapterInspection> {
    const inspection = await this.#adapter.inspect();
    if (
      inspection.capabilities.incrementalSync !== "full"
      && inspection.capabilities.incrementalSync !== "partial"
    ) {
      throw new Error("source adapter does not declare incremental sync support");
    }
    for (const [field, value] of [
      ["adapterName", inspection.adapterName],
      ["adapterVersion", inspection.adapterVersion],
      ["sourceSystem", inspection.sourceSystem],
      ["sourceType", inspection.sourceType],
    ] as const) {
      if (!value.trim()) throw new Error(`source adapter inspection ${field} must not be empty`);
    }
    return inspection;
  }

  async #scan(
    inspection: SourceAdapterInspection,
    consume: (unit: ExperienceUnit) => Promise<void>,
  ): Promise<void> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await this.#adapter.discover({
        limit: this.#pageSize,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const unit of page.units) {
        if (
          unit.source.sourceSystem !== inspection.sourceSystem
          || unit.source.sourceType !== inspection.sourceType
        ) {
          throw new Error("source adapter discovered a unit outside its inspected source identity");
        }
        await consume(unit);
      }
      const next = page.nextCursor;
      if (next !== undefined) {
        if (!next.trim() || next === cursor || seenCursors.has(next)) {
          throw new Error("source adapter incremental cursor did not advance");
        }
        seenCursors.add(next);
      }
      cursor = next;
    } while (cursor !== undefined);
  }

  #newCheckpoint(inspection: SourceAdapterInspection): IncrementalSourceCheckpoint {
    return {
      contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
      adapterName: inspection.adapterName,
      adapterVersion: inspection.adapterVersion,
      sourceSystem: inspection.sourceSystem,
      sourceType: inspection.sourceType,
      scope: structuredClone(this.#scope),
      processingMode: this.#referenceOnly ? "reference_only" : "distillation",
      policyId: this.#policyId,
      fingerprints: {},
      updatedAt: this.#clock().toISOString(),
    };
  }

  async #advance(
    checkpoint: IncrementalSourceCheckpoint,
    experience: NormalizedExperience,
    fingerprint: SourceFingerprint,
  ): Promise<void> {
    this.#setFingerprint(checkpoint, experience.sourceId, fingerprint.value);
    checkpoint.updatedAt = this.#clock().toISOString();
    if (this.#checkpointStore.appendFingerprint !== undefined) {
      await this.#checkpointStore.appendFingerprint(
        checkpoint,
        experience.sourceId,
      );
    } else {
      await this.#checkpointStore.save(checkpoint);
    }
  }

  #assertCompatible(
    checkpoint: IncrementalSourceCheckpoint,
    inspection: SourceAdapterInspection,
  ): void {
    if (
      checkpoint.adapterName !== inspection.adapterName
      || checkpoint.adapterVersion !== inspection.adapterVersion
      || checkpoint.sourceSystem !== inspection.sourceSystem
      || checkpoint.sourceType !== inspection.sourceType
      || checkpoint.scope.tenantId !== this.#scope.tenantId
      || checkpoint.scope.lifeDid !== this.#scope.lifeDid
      || checkpoint.scope.memoryNamespace !== this.#scope.memoryNamespace
      || checkpoint.processingMode !== (this.#referenceOnly ? "reference_only" : "distillation")
      || checkpoint.policyId !== this.#policyId
    ) {
      throw new Error("incremental source checkpoint does not belong to configured adapter/source");
    }
  }

  #setFingerprint(
    checkpoint: IncrementalSourceCheckpoint,
    sourceId: string,
    value: string,
  ): void {
    Object.defineProperty(checkpoint.fingerprints, sourceId, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  #assertNormalizedMatchesUnit(
    experience: NormalizedExperience,
    unit: ExperienceUnit,
    inspection: SourceAdapterInspection,
  ): void {
    if (
      experience.experienceId !== unit.experienceId
      || experience.sourceSystem !== inspection.sourceSystem
      || experience.sourceType !== inspection.sourceType
      || experience.sourceId !== unit.source.sourceId
    ) {
      throw new Error("normalized experience identity does not match discovered unit");
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
