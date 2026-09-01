import type {
  CanonicalCommitResult,
  CanonicalMemoryHead,
  CandidateId,
  CandidateStatus,
  MemoryCandidate,
  MemoryChangeEnvelope,
  MemoryConflict,
  MemoryId,
  MemoryOutboxRecord,
  MemoryRevision,
  MemoryScope,
} from "../domain/types.js";

export interface CanonicalMemoryStoreTx {
  getCandidate(candidateId: CandidateId): Promise<MemoryCandidate | undefined>;
  putCandidate(candidate: MemoryCandidate): Promise<void>;
  setCandidateStatus(candidateId: CandidateId, status: CandidateStatus): Promise<void>;

  getHead(memoryId: MemoryId): Promise<CanonicalMemoryHead | undefined>;
  putHead(head: CanonicalMemoryHead): Promise<void>;

  getRevision(memoryId: MemoryId, revision: number): Promise<MemoryRevision | undefined>;
  appendRevision(revision: MemoryRevision): Promise<void>;

  nextCommitSeq(scope: MemoryScope): Promise<number>;
  appendChange(change: MemoryChangeEnvelope): Promise<void>;
  appendOutbox(record: MemoryOutboxRecord): Promise<void>;
  appendConflict(conflict: MemoryConflict): Promise<void>;

  getCommitResultByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<CanonicalCommitResult | undefined>;
  putCommitResultByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
    result: CanonicalCommitResult,
  ): Promise<void>;
}

export interface CanonicalMemoryStore {
  transaction<T>(work: (tx: CanonicalMemoryStoreTx) => Promise<T>): Promise<T>;
  getCandidate(candidateId: CandidateId): Promise<MemoryCandidate | undefined>;
  getHead(memoryId: MemoryId): Promise<CanonicalMemoryHead | undefined>;
  getRevision(memoryId: MemoryId, revision: number): Promise<MemoryRevision | undefined>;
  listChangesAfter(scope: MemoryScope, afterCommitSeq: number): Promise<MemoryChangeEnvelope[]>;
  listConflicts(scope: MemoryScope): Promise<MemoryConflict[]>;
}
