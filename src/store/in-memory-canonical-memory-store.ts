import { ValidationError } from "../domain/errors.js";
import type {
  CanonicalCommitResult,
  CanonicalMemoryHead,
  CandidateId,
  CandidateStatus,
  DeviceCheckpoint,
  MemoryCandidate,
  MemoryChangeEnvelope,
  MemoryConflict,
  MemoryId,
  MemoryOutboxRecord,
  MemoryRevision,
  MemoryRevisionRef,
  MemoryScope,
  ProviderMaterialization,
} from "../domain/types.js";
import { scopeKey } from "../domain/utils.js";
import type {
  CentralOperationsStore,
  CurrentHeadCursorRecord,
  SettleClaimRequest,
  SettledClaim,
} from "../operations/central-operations-store.js";
import type {
  ClaimedOutboxRecord,
  NamespaceOperationsSummary,
  ProviderMaterializationCursor,
} from "../operations/types.js";
import type {
  CanonicalMemoryStoreTx,
} from "./canonical-memory-store.js";

interface InMemoryState {
  candidates: Map<CandidateId, MemoryCandidate>;
  heads: Map<MemoryId, CanonicalMemoryHead>;
  revisions: Map<string, MemoryRevision>;
  commitSeqByScope: Map<string, number>;
  changes: MemoryChangeEnvelope[];
  outbox: MemoryOutboxRecord[];
  conflicts: MemoryConflict[];
  deviceCheckpoints: Map<string, DeviceCheckpoint>;
  providerMaterializations: Map<string, ProviderMaterialization>;
  idempotency: Map<string, CanonicalCommitResult>;
}

function emptyState(): InMemoryState {
  return {
    candidates: new Map(),
    heads: new Map(),
    revisions: new Map(),
    commitSeqByScope: new Map(),
    changes: [],
    outbox: [],
    conflicts: [],
    deviceCheckpoints: new Map(),
    providerMaterializations: new Map(),
    idempotency: new Map(),
  };
}

function revisionKey(memoryId: MemoryId, revision: number): string {
  return `${memoryId}:${revision}`;
}

function scopedIdempotencyKey(scope: MemoryScope, key: string): string {
  return `${scopeKey(scope)}\u001f${key}`;
}

function deviceCheckpointKey(scope: MemoryScope, deviceId: string): string {
  return `${scopeKey(scope)}\u001f${deviceId}`;
}

function providerMaterializationKey(providerName: string, memoryId: MemoryId): string {
  return `${providerName}\u001f${memoryId}`;
}

function validateCheckpointCas(
  checkpoint: DeviceCheckpoint,
  expectedLastAppliedCommitSeq: number,
): void {
  if (
    !Number.isSafeInteger(expectedLastAppliedCommitSeq) ||
    expectedLastAppliedCommitSeq < 0 ||
    !Number.isSafeInteger(checkpoint.lastAppliedCommitSeq) ||
    checkpoint.lastAppliedCommitSeq < expectedLastAppliedCommitSeq
  ) {
    throw new ValidationError(
      "Device checkpoint CAS requires non-negative safe integers and cannot move backward",
    );
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class InMemoryTx implements CanonicalMemoryStoreTx {
  constructor(private readonly state: InMemoryState) {}

  async getCandidate(candidateId: CandidateId): Promise<MemoryCandidate | undefined> {
    const value = this.state.candidates.get(candidateId);
    return value === undefined ? undefined : clone(value);
  }

  async putCandidate(candidate: MemoryCandidate): Promise<void> {
    this.state.candidates.set(candidate.candidateId, clone(candidate));
  }

  async setCandidateStatus(
    candidateId: CandidateId,
    status: CandidateStatus,
  ): Promise<void> {
    const candidate = this.state.candidates.get(candidateId);
    if (candidate === undefined) {
      throw new ValidationError(`Cannot update missing candidate ${candidateId}`);
    }
    candidate.status = status;
  }

  async getHead(memoryId: MemoryId): Promise<CanonicalMemoryHead | undefined> {
    const value = this.state.heads.get(memoryId);
    return value === undefined ? undefined : clone(value);
  }

  async putHead(head: CanonicalMemoryHead): Promise<void> {
    this.state.heads.set(head.memoryId, clone(head));
  }

  async getRevision(
    memoryId: MemoryId,
    revision: number,
  ): Promise<MemoryRevision | undefined> {
    const value = this.state.revisions.get(revisionKey(memoryId, revision));
    return value === undefined ? undefined : clone(value);
  }

  async appendRevision(revision: MemoryRevision): Promise<void> {
    const key = revisionKey(revision.memoryId, revision.revision);
    if (this.state.revisions.has(key)) {
      throw new ValidationError(`Revision already exists: ${key}`);
    }
    this.state.revisions.set(key, clone(revision));
  }

  async nextCommitSeq(scope: MemoryScope): Promise<number> {
    const key = scopeKey(scope);
    const next = (this.state.commitSeqByScope.get(key) ?? 0) + 1;
    this.state.commitSeqByScope.set(key, next);
    return next;
  }

  async appendChange(change: MemoryChangeEnvelope): Promise<void> {
    this.state.changes.push(clone(change));
  }

  async appendOutbox(record: MemoryOutboxRecord): Promise<void> {
    this.state.outbox.push(clone(record));
  }

  async appendConflict(conflict: MemoryConflict): Promise<void> {
    this.state.conflicts.push(clone(conflict));
  }

  async getCommitResultByIdempotencyKey(
    scope: MemoryScope,
    key: string,
  ): Promise<CanonicalCommitResult | undefined> {
    const result = this.state.idempotency.get(scopedIdempotencyKey(scope, key));
    return result === undefined ? undefined : clone(result);
  }

  async putCommitResultByIdempotencyKey(
    scope: MemoryScope,
    key: string,
    result: CanonicalCommitResult,
  ): Promise<void> {
    this.state.idempotency.set(scopedIdempotencyKey(scope, key), clone(result));
  }
}

export class InMemoryCanonicalMemoryStore implements CentralOperationsStore {
  private state: InMemoryState = emptyState();
  private writeBarrier: Promise<void> = Promise.resolve();

  async transaction<T>(work: (tx: CanonicalMemoryStoreTx) => Promise<T>): Promise<T> {
    const previous = this.writeBarrier;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeBarrier = previous.then(() => gate);
    await previous;

    try {
      const draft = clone(this.state);
      const result = await work(new InMemoryTx(draft));
      this.state = draft;
      return clone(result);
    } finally {
      release();
    }
  }

  private async afterWrites(): Promise<void> {
    await this.writeBarrier;
  }

  private async withExclusiveWrite<T>(work: (state: InMemoryState) => T): Promise<T> {
    const previous = this.writeBarrier;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeBarrier = previous.then(() => gate);
    await previous;
    try {
      const draft = clone(this.state);
      const result = work(draft);
      const clonedResult = clone(result);
      this.state = draft;
      return clonedResult;
    } finally {
      release();
    }
  }

  async getCandidate(candidateId: CandidateId): Promise<MemoryCandidate | undefined> {
    await this.afterWrites();
    const value = this.state.candidates.get(candidateId);
    return value === undefined ? undefined : clone(value);
  }

  async getHead(memoryId: MemoryId): Promise<CanonicalMemoryHead | undefined> {
    await this.afterWrites();
    const value = this.state.heads.get(memoryId);
    return value === undefined ? undefined : clone(value);
  }

  async getHeads(
    memoryIds: readonly MemoryId[],
  ): Promise<Array<CanonicalMemoryHead | undefined>> {
    await this.afterWrites();
    return memoryIds.map((memoryId) => {
      const value = this.state.heads.get(memoryId);
      return value === undefined ? undefined : clone(value);
    });
  }

  async getRevision(
    memoryId: MemoryId,
    revision: number,
  ): Promise<MemoryRevision | undefined> {
    await this.afterWrites();
    const value = this.state.revisions.get(revisionKey(memoryId, revision));
    return value === undefined ? undefined : clone(value);
  }

  async findCurrentRevisionBySemanticFingerprint(
    scope: MemoryScope,
    semanticFingerprint: string,
  ): Promise<MemoryRevision | undefined> {
    await this.afterWrites();
    for (const head of this.state.heads.values()) {
      if (scopeKey(head.scope) !== scopeKey(scope)) continue;
      const revision = this.state.revisions.get(
        revisionKey(head.memoryId, head.currentRevision),
      );
      if (revision?.semanticFingerprint === semanticFingerprint) {
        return clone(revision);
      }
    }
    return undefined;
  }

  async getRevisions(
    references: readonly MemoryRevisionRef[],
  ): Promise<Array<MemoryRevision | undefined>> {
    await this.afterWrites();
    return references.map((reference) => {
      const value = this.state.revisions.get(
        revisionKey(reference.memoryId, reference.revision),
      );
      return value === undefined ? undefined : clone(value);
    });
  }

  async listChangesAfter(
    scope: MemoryScope,
    afterCommitSeq: number,
    limit?: number,
  ): Promise<MemoryChangeEnvelope[]> {
    if (
      !Number.isSafeInteger(afterCommitSeq) ||
      afterCommitSeq < 0 ||
      (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    ) {
      throw new ValidationError(
        "Change feed cursor must be non-negative and limit must be a positive safe integer",
      );
    }
    await this.afterWrites();
    const changes = this.state.changes
      .filter(
        (change) =>
          scopeKey(change.scope) === scopeKey(scope) &&
          change.commitSeq > afterCommitSeq,
      )
      .sort((left, right) => left.commitSeq - right.commitSeq);
    return clone(limit === undefined ? changes : changes.slice(0, limit));
  }

  async getChangesByCommitSeqs(
    scope: MemoryScope,
    commitSeqs: readonly number[],
  ): Promise<Array<MemoryChangeEnvelope | undefined>> {
    await this.afterWrites();
    return commitSeqs.map((commitSeq) => {
      const value = this.state.changes.find(
        (change) =>
          scopeKey(change.scope) === scopeKey(scope) &&
          change.commitSeq === commitSeq,
      );
      return value === undefined ? undefined : clone(value);
    });
  }

  async getDeviceCheckpoint(
    scope: MemoryScope,
    deviceId: string,
  ): Promise<DeviceCheckpoint | undefined> {
    await this.afterWrites();
    const value = this.state.deviceCheckpoints.get(
      deviceCheckpointKey(scope, deviceId),
    );
    return value === undefined ? undefined : clone(value);
  }

  async compareAndSetDeviceCheckpoint(
    checkpoint: DeviceCheckpoint,
    expectedLastAppliedCommitSeq: number,
  ): Promise<boolean> {
    validateCheckpointCas(checkpoint, expectedLastAppliedCommitSeq);
    const previous = this.writeBarrier;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeBarrier = previous.then(() => gate);
    await previous;

    try {
      const key = deviceCheckpointKey(checkpoint.scope, checkpoint.deviceId);
      const current = this.state.deviceCheckpoints.get(key);
      const currentCommitSeq = current?.lastAppliedCommitSeq ?? 0;
      if (currentCommitSeq !== expectedLastAppliedCommitSeq) return false;
      const highestCommitted =
        this.state.commitSeqByScope.get(scopeKey(checkpoint.scope)) ?? 0;
      if (checkpoint.lastAppliedCommitSeq > highestCommitted) {
        throw new ValidationError(
          "Device checkpoint cannot exceed the committed change sequence",
        );
      }
      this.state.deviceCheckpoints.set(key, clone(checkpoint));
      return true;
    } finally {
      release();
    }
  }

  async listConflicts(scope: MemoryScope): Promise<MemoryConflict[]> {
    await this.afterWrites();
    return clone(
      this.state.conflicts.filter(
        (conflict) => scopeKey(conflict.scope) === scopeKey(scope),
      ),
    );
  }

  async listCurrentHeadsAfter(
    scope: MemoryScope,
    afterCommitSeq: number,
    limit: number,
  ): Promise<CurrentHeadCursorRecord[]> {
    await this.afterWrites();
    const records: CurrentHeadCursorRecord[] = [];
    for (const head of this.state.heads.values()) {
      if (scopeKey(head.scope) !== scopeKey(scope)) continue;
      const revision = this.state.revisions.get(
        revisionKey(head.memoryId, head.currentRevision),
      );
      if (revision === undefined || revision.commitSeq <= afterCommitSeq) continue;
      records.push({ head: clone(head), commitSeq: revision.commitSeq });
    }
    records.sort(
      (left, right) =>
        left.commitSeq - right.commitSeq ||
        left.head.memoryId.localeCompare(right.head.memoryId),
    );
    return clone(records.slice(0, limit));
  }

  async getScopeHighWatermark(scope: MemoryScope): Promise<number> {
    await this.afterWrites();
    return this.state.commitSeqByScope.get(scopeKey(scope)) ?? 0;
  }

  async listDeviceCheckpointsAfter(
    scope: MemoryScope,
    afterDeviceId: string | undefined,
    limit: number,
  ): Promise<DeviceCheckpoint[]> {
    await this.afterWrites();
    return clone(
      [...this.state.deviceCheckpoints.values()]
        .filter(
          (checkpoint) =>
            scopeKey(checkpoint.scope) === scopeKey(scope) &&
            (afterDeviceId === undefined || checkpoint.deviceId > afterDeviceId),
        )
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
        .slice(0, limit),
    );
  }

  async listProviderMaterializationsAfter(
    scope: MemoryScope,
    after: ProviderMaterializationCursor | undefined,
    limit: number,
  ): Promise<ProviderMaterialization[]> {
    await this.afterWrites();
    return clone(
      [...this.state.providerMaterializations.values()]
        .filter((materialization) => {
          const head = this.state.heads.get(materialization.memoryId);
          if (head === undefined || scopeKey(head.scope) !== scopeKey(scope)) {
            return false;
          }
          return (
            after === undefined ||
            materialization.providerName > after.providerName ||
            (materialization.providerName === after.providerName &&
              materialization.memoryId > after.memoryId)
          );
        })
        .sort(
          (left, right) =>
            left.providerName.localeCompare(right.providerName) ||
            left.memoryId.localeCompare(right.memoryId),
        )
        .slice(0, limit),
    );
  }

  async getNamespaceOperationsSummary(
    scope: MemoryScope,
  ): Promise<NamespaceOperationsSummary> {
    await this.afterWrites();
    const key = scopeKey(scope);
    const highWatermark = this.state.commitSeqByScope.get(key) ?? 0;
    const heads = [...this.state.heads.values()].filter(
      (head) => scopeKey(head.scope) === key,
    );
    const outbox = this.state.outbox.filter(
      (record) => scopeKey(record.scope) === key,
    );
    const devices = [...this.state.deviceCheckpoints.values()].filter(
      (checkpoint) => scopeKey(checkpoint.scope) === key,
    );
    const memoryIds = new Set(heads.map((head) => head.memoryId));
    const materializations = [...this.state.providerMaterializations.values()].filter(
      (materialization) => memoryIds.has(materialization.memoryId),
    );
    return {
      scope: clone(scope),
      highWatermark,
      memories: {
        total: heads.length,
        active: heads.filter((head) => head.status === "active").length,
        tombstoned: heads.filter((head) => head.status === "tombstoned").length,
        superseded: heads.filter((head) => head.status === "superseded").length,
      },
      outbox: {
        pending: outbox.filter((record) => record.status === "PENDING").length,
        processing: outbox.filter((record) => record.status === "PROCESSING").length,
        done: outbox.filter((record) => record.status === "DONE").length,
        failed: outbox.filter((record) => record.status === "FAILED").length,
      },
      devices: {
        total: devices.length,
        maxLag: devices.reduce(
          (maximum, checkpoint) =>
            Math.max(maximum, highWatermark - checkpoint.lastAppliedCommitSeq),
          0,
        ),
      },
      materializations: {
        current: materializations.filter((value) => value.status === "CURRENT").length,
        lagging: materializations.filter((value) => value.status === "LAGGING").length,
        failed: materializations.filter((value) => value.status === "FAILED").length,
        unavailable: materializations.filter(
          (value) => value.status === "UNAVAILABLE",
        ).length,
        rebuilding: materializations.filter(
          (value) => value.status === "REBUILDING",
        ).length,
      },
    };
  }

  async claimOutboxBatch(
    scope: MemoryScope,
    workerId: string,
    claimToken: string,
    claimedAt: string,
    leaseExpiresAt: string,
    limit: number,
  ): Promise<ClaimedOutboxRecord[]> {
    return this.withExclusiveWrite((state) => {
      const now = Date.parse(claimedAt);
      const claimable = state.outbox
        .filter((record) => {
          if (scopeKey(record.scope) !== scopeKey(scope)) return false;
          const earlierUnfinished = state.outbox.some(
            (earlier) =>
              earlier.memoryId === record.memoryId &&
              earlier.revision < record.revision &&
              earlier.status !== "DONE",
          );
          if (earlierUnfinished) return false;
          if (record.status === "PENDING") return true;
          if (record.status === "FAILED") {
            return record.nextAttemptAt === undefined || Date.parse(record.nextAttemptAt) <= now;
          }
          return (
            record.status === "PROCESSING" &&
            record.leaseExpiresAt !== undefined &&
            Date.parse(record.leaseExpiresAt) <= now
          );
        })
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.outboxId.localeCompare(right.outboxId),
        )
        .slice(0, limit);

      for (const record of claimable) {
        record.status = "PROCESSING";
        record.attempts += 1;
        record.claimedBy = workerId;
        record.claimToken = claimToken;
        record.leaseExpiresAt = leaseExpiresAt;
        record.updatedAt = claimedAt;
        delete record.nextAttemptAt;
        delete record.lastError;
      }
      return claimable as ClaimedOutboxRecord[];
    });
  }

  async settleOutboxClaim(
    request: SettleClaimRequest,
  ): Promise<SettledClaim | undefined> {
    return this.withExclusiveWrite((state) => {
      const record = state.outbox.find(
        (candidate) =>
          candidate.outboxId === request.outboxId &&
          scopeKey(candidate.scope) === scopeKey(request.scope),
      );
      if (
        record === undefined ||
        record.status !== "PROCESSING" ||
        record.claimedBy !== request.workerId ||
        record.claimToken !== request.claimToken ||
        record.leaseExpiresAt === undefined ||
        Date.parse(record.leaseExpiresAt) <= Date.parse(request.settledAt)
      ) {
        return undefined;
      }

      const failed = request.outcomes.filter((outcome) => outcome.status !== "CURRENT");
      const materializations: ProviderMaterialization[] = [];
      for (const outcome of request.outcomes) {
        const key = providerMaterializationKey(outcome.providerName, record.memoryId);
        const previous = state.providerMaterializations.get(key);
        if (
          previous !== undefined &&
          previous.canonicalRevision > record.revision
        ) {
          throw new ValidationError(
            `Provider materialization ${outcome.providerName}/${record.memoryId} cannot move backward`,
          );
        }
        const materialization: ProviderMaterialization = {
          providerName: outcome.providerName,
          memoryId: record.memoryId,
          canonicalRevision: record.revision,
          materializedRevision:
            outcome.status === "CURRENT"
              ? record.revision
              : previous?.materializedRevision ?? 0,
          status: outcome.status,
          lastAttempt: request.settledAt,
          ...(outcome.providerId === undefined
            ? previous?.providerId === undefined
              ? {}
              : { providerId: previous.providerId }
            : { providerId: outcome.providerId }),
          ...(outcome.lastError === undefined ? {} : { lastError: outcome.lastError }),
        };
        state.providerMaterializations.set(key, materialization);
        materializations.push(materialization);
      }

      record.status =
        request.lastError === undefined && failed.length === 0
          ? "DONE"
          : "FAILED";
      record.updatedAt = request.settledAt;
      delete record.claimedBy;
      delete record.claimToken;
      delete record.leaseExpiresAt;
      if (request.lastError === undefined && failed.length === 0) {
        delete record.lastError;
        delete record.nextAttemptAt;
      } else {
        record.lastError =
          request.lastError ??
          failed
            .map((outcome) => `${outcome.providerName}: ${outcome.lastError}`)
            .join("; ");
        if (request.nextAttemptAt !== undefined) {
          record.nextAttemptAt = request.nextAttemptAt;
        }
      }
      return { record, materializations };
    });
  }
}
