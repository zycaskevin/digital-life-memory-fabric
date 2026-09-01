import { ValidationError } from "../domain/errors.js";
import type {
  CandidateInput,
  MemoryCandidate,
} from "../domain/types.js";
import {
  RandomIdFactory,
  SystemClock,
  type Clock,
  type IdFactory,
} from "../domain/utils.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} must not be empty`);
  }
}

function validateTimestamp(value: string | undefined, field: string): void {
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a valid ISO-8601 timestamp`);
  }
}

function validateInput(input: CandidateInput): void {
  requireNonEmpty(input.scope.tenantId, "scope.tenantId");
  requireNonEmpty(input.scope.lifeDid, "scope.lifeDid");
  requireNonEmpty(input.scope.memoryNamespace, "scope.memoryNamespace");
  requireNonEmpty(input.origin.lifeDid, "origin.lifeDid");
  requireNonEmpty(input.memoryKind, "memoryKind");
  requireNonEmpty(input.candidateType, "candidateType");
  requireNonEmpty(input.sourceType, "sourceType");
  requireNonEmpty(input.proposedContent.text, "proposedContent.text");

  if (input.origin.lifeDid !== input.scope.lifeDid) {
    throw new ValidationError("origin.lifeDid must match scope.lifeDid");
  }

  if (input.evidenceRefs.length === 0) {
    throw new ValidationError("At least one evidenceRef is required");
  }

  if (
    input.confidence !== undefined &&
    (input.confidence < 0 || input.confidence > 1)
  ) {
    throw new ValidationError("confidence must be between 0 and 1");
  }

  validateTimestamp(input.observedAt, "observedAt");
  validateTimestamp(input.validFrom, "validFrom");
  validateTimestamp(input.validUntil, "validUntil");
  if (
    input.validFrom !== undefined &&
    input.validUntil !== undefined &&
    Date.parse(input.validUntil) < Date.parse(input.validFrom)
  ) {
    throw new ValidationError("validUntil must not be earlier than validFrom");
  }

  if (input.proposedOperation === "create") {
    if (input.baseMemoryId !== undefined || input.baseRevision !== undefined) {
      throw new ValidationError("create must not include baseMemoryId/baseRevision");
    }
    return;
  }

  if (input.baseMemoryId === undefined || input.baseRevision === undefined) {
    throw new ValidationError(
      `${input.proposedOperation} requires baseMemoryId and baseRevision`,
    );
  }

  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 1) {
    throw new ValidationError("baseRevision must be a positive integer");
  }
}

export class MemoryCandidateService {
  constructor(
    private readonly store: CanonicalMemoryStore,
    private readonly ids: IdFactory = new RandomIdFactory(),
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async ingest(input: CandidateInput): Promise<MemoryCandidate> {
    validateInput(input);

    const candidate: MemoryCandidate = {
      ...input,
      candidateId: this.ids.candidateId(),
      status: "PENDING",
      createdAt: this.clock.now(),
    };

    return this.store.transaction(async (tx) => {
      await tx.putCandidate(candidate);
      return candidate;
    });
  }
}
