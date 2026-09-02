import type { EventId, MemoryId, OutboxId } from "./types.js";

export class MemoryFabricError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends MemoryFabricError {
  constructor(message: string) {
    super("VALIDATION_ERROR", message);
  }
}

export class CandidateNotFoundError extends MemoryFabricError {
  constructor(candidateId: string) {
    super("CANDIDATE_NOT_FOUND", `Memory candidate not found: ${candidateId}`);
  }
}

export class CandidateNotPendingError extends MemoryFabricError {
  constructor(candidateId: string, status: string) {
    super(
      "CANDIDATE_NOT_PENDING",
      `Memory candidate ${candidateId} is ${status}, expected PENDING`,
    );
  }
}

export class MemoryNotFoundError extends MemoryFabricError {
  constructor(memoryId: MemoryId) {
    super("MEMORY_NOT_FOUND", `Canonical memory not found: ${memoryId}`);
  }
}

export class RevisionConflictError extends MemoryFabricError {
  constructor(
    public readonly memoryId: MemoryId,
    public readonly expectedRevision: number,
    public readonly currentRevision: number,
  ) {
    super(
      "REVISION_CONFLICT",
      `Revision conflict for ${memoryId}: expected ${expectedRevision}, current ${currentRevision}`,
    );
  }
}

export class ChangeSequenceGapError extends MemoryFabricError {
  constructor(
    public readonly expectedCommitSeq: number,
    public readonly actualCommitSeq: number | undefined,
  ) {
    super(
      "CHANGE_SEQUENCE_GAP",
      actualCommitSeq === undefined
        ? `Canonical change stream ended before commit_seq ${expectedCommitSeq}`
        : `Canonical change stream expected commit_seq ${expectedCommitSeq}, received ${actualCommitSeq}`,
    );
  }
}

export class DeviceCheckpointConflictError extends MemoryFabricError {
  constructor(
    public readonly deviceId: string,
    public readonly expectedLastAppliedCommitSeq: number,
    public readonly currentLastAppliedCommitSeq: number,
  ) {
    super(
      "DEVICE_CHECKPOINT_CONFLICT",
      `Device ${deviceId} checkpoint conflict: expected ${expectedLastAppliedCommitSeq}, current ${currentLastAppliedCommitSeq}`,
    );
  }
}

export class SyncRevisionIntegrityError extends MemoryFabricError {
  constructor(
    public readonly eventId: EventId,
    message: string,
  ) {
    super("SYNC_REVISION_INTEGRITY_ERROR", `Change ${eventId}: ${message}`);
  }
}

export class ScopeMismatchError extends MemoryFabricError {
  constructor(message: string) {
    super("SCOPE_MISMATCH", message);
  }
}

export class UnsupportedOperationError extends MemoryFabricError {
  constructor(operation: string) {
    super(
      "UNSUPPORTED_OPERATION",
      `Operation ${operation} is reserved by the v0.1 contract but is not enabled in DLFM-001`,
    );
  }
}

export class OutboxClaimConflictError extends MemoryFabricError {
  constructor(public readonly outboxId: OutboxId) {
    super(
      "OUTBOX_CLAIM_CONFLICT",
      `Outbox ${outboxId} is no longer owned by the supplied active claim`,
    );
  }
}

export class OperationsIntegrityError extends MemoryFabricError {
  constructor(message: string) {
    super("OPERATIONS_INTEGRITY_ERROR", message);
  }
}

export class MaterializationReceiptIntegrityError extends MemoryFabricError {
  constructor(
    public readonly outboxId: OutboxId,
    message: string,
  ) {
    super(
      "MATERIALIZATION_RECEIPT_INTEGRITY_ERROR",
      `Outbox ${outboxId}: ${message}`,
    );
  }
}

export class MaterializationTransportError extends MemoryFabricError {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super("MATERIALIZATION_TRANSPORT_ERROR", message);
  }
}

export class RetrievalResponseIntegrityError extends MemoryFabricError {
  constructor(message: string) {
    super(
      "RETRIEVAL_RESPONSE_INTEGRITY_ERROR",
      `Provider retrieval response: ${message}`,
    );
  }
}

export class RetrievalExecutionError extends MemoryFabricError {
  constructor(message: string) {
    super("RETRIEVAL_EXECUTION_ERROR", message);
  }
}
