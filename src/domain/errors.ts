import type { MemoryId } from "./types.js";

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
