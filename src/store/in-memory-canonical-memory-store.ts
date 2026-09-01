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
  MemoryScope,
} from "../domain/types.js";
import { scopeKey } from "../domain/utils.js";
import type {
  CanonicalMemoryStore,
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

export class InMemoryCanonicalMemoryStore implements CanonicalMemoryStore {
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

  async getRevision(
    memoryId: MemoryId,
    revision: number,
  ): Promise<MemoryRevision | undefined> {
    await this.afterWrites();
    const value = this.state.revisions.get(revisionKey(memoryId, revision));
    return value === undefined ? undefined : clone(value);
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
}
