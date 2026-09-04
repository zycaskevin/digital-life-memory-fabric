import {
  CandidateNotFoundError,
  CandidateNotPendingError,
  MemoryNotFoundError,
  RevisionConflictError,
  ScopeMismatchError,
  UnsupportedOperationError,
  ValidationError,
} from "../domain/errors.js";
import type {
  CanonicalCommitResult,
  CanonicalContent,
  CanonicalMemoryHead,
  CandidateId,
  MemoryCandidate,
  MemoryConflict,
  MemoryId,
  MemoryProvenance,
  MemoryRevision,
  MemoryStatus,
} from "../domain/types.js";
import {
  RandomIdFactory,
  SystemClock,
  sameScope,
  sha256,
  type Clock,
  type IdFactory,
} from "../domain/utils.js";
import type {
  CanonicalMemoryStore,
  CanonicalMemoryStoreTx,
} from "../store/canonical-memory-store.js";

export interface CanonicalCommitRequest {
  candidateId: CandidateId;
  idempotencyKey: string;
}

/** Trusted DLMF seam used by canonical authority to verify MD-010 audit evidence. */
export interface CanonicalAdmissionVerifier {
  verifyCanonicalAdmission(candidate: MemoryCandidate): Promise<boolean>;
}

type CommitOutcome =
  | { kind: "committed"; result: CanonicalCommitResult }
  | { kind: "conflict"; conflict: MemoryConflict };

function provenanceFor(candidate: MemoryCandidate): MemoryProvenance {
  const admission = candidate.canonicalAdmission === undefined
    ? {}
    : { canonicalAdmission: candidate.canonicalAdmission };
  if (candidate.sourceId === undefined) {
    return {
      sourceType: candidate.sourceType,
      candidateId: candidate.candidateId,
      candidateFingerprint: candidate.candidateFingerprint,
      producer: candidate.producer,
      sourceExperienceRefs: candidate.sourceExperienceRefs,
      ...admission,
    };
  }

  return {
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    candidateId: candidate.candidateId,
    candidateFingerprint: candidate.candidateFingerprint,
    producer: candidate.producer,
    sourceExperienceRefs: candidate.sourceExperienceRefs,
    ...admission,
  };
}

function requirePending(candidate: MemoryCandidate): void {
  if (candidate.status !== "PENDING") {
    throw new CandidateNotPendingError(candidate.candidateId, candidate.status);
  }
}

function providerAdmissionStateFingerprint(candidate: MemoryCandidate): string | undefined {
  if (candidate.producer.kind !== "provider") return undefined;

  const proof = candidate.canonicalAdmission;
  if (proof === undefined) {
    throw new ValidationError(
      `Provider candidate ${candidate.candidateId} requires canonical admission proof`,
    );
  }
  if (
    proof.outcome !== "canonical_candidate" ||
    proof.admissionPolicyVersion.trim().length === 0 ||
    proof.curationProvider.trim().length === 0 ||
    !proof.curationRecordId.startsWith("cur_")
  ) {
    throw new ValidationError(
      `Provider candidate ${candidate.candidateId} has invalid canonical admission proof`,
    );
  }
  if (
    candidate.epistemicStatus === "inferred" ||
    candidate.epistemicStatus === "synthesized" ||
    candidate.epistemicStatus === "uncertain"
  ) {
    throw new ValidationError(
      `Provider candidate ${candidate.candidateId} with epistemicStatus=${candidate.epistemicStatus} requires explicit review and cannot auto-commit`,
    );
  }
  return sha256({
    candidateId: candidate.candidateId,
    scope: candidate.scope,
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId ?? null,
    candidateType: candidate.candidateType,
    memoryClass: candidate.memoryClass,
    memoryKind: candidate.memoryKind,
    proposedContent: candidate.proposedContent,
    epistemicStatus: candidate.epistemicStatus,
    producer: candidate.producer,
    sourceExperienceRefs: candidate.sourceExperienceRefs,
    candidateFingerprint: candidate.candidateFingerprint,
    distillationPolicyVersion: candidate.distillationPolicyVersion ?? null,
    providerRunId: candidate.providerRunId ?? null,
    canonicalAdmission: proof,
  });
}

async function requireProviderAdmission(
  candidate: MemoryCandidate,
  verifier: CanonicalAdmissionVerifier | undefined,
): Promise<string | undefined> {
  const fingerprint = providerAdmissionStateFingerprint(candidate);
  if (fingerprint === undefined) return undefined;
  if (verifier === undefined) {
    throw new ValidationError(
      `Provider candidate ${candidate.candidateId} requires configured canonical admission verifier`,
    );
  }
  if (!(await verifier.verifyCanonicalAdmission(candidate))) {
    throw new ValidationError(
      `Provider candidate ${candidate.candidateId} canonical admission proof is not backed by an admitted curation record`,
    );
  }
  return fingerprint;
}

function requireVerifiedProviderAdmissionState(
  candidate: MemoryCandidate,
  verifiedFingerprint: string | undefined,
): void {
  const currentFingerprint = providerAdmissionStateFingerprint(candidate);
  if (currentFingerprint !== verifiedFingerprint) {
    throw new ValidationError(
      `Candidate ${candidate.candidateId} changed after canonical admission verification`,
    );
  }
}

export class CanonicalMemoryAuthority {
  constructor(
    private readonly store: CanonicalMemoryStore,
    private readonly ids: IdFactory = new RandomIdFactory(),
    private readonly clock: Clock = new SystemClock(),
    private readonly admissionVerifier?: CanonicalAdmissionVerifier,
  ) {}

  async commit(request: CanonicalCommitRequest): Promise<CanonicalCommitResult> {
    if (request.idempotencyKey.trim().length === 0) {
      throw new ValidationError("idempotencyKey must not be empty");
    }

    const admissionCandidate = await this.store.getCandidate(request.candidateId);
    if (admissionCandidate === undefined) {
      throw new CandidateNotFoundError(request.candidateId);
    }
    const verifiedAdmissionFingerprint = await requireProviderAdmission(
      admissionCandidate,
      this.admissionVerifier,
    );

    const outcome = await this.store.transaction((tx) =>
      this.commitInTransaction(tx, request, verifiedAdmissionFingerprint),
    );

    if (outcome.kind === "conflict") {
      throw new RevisionConflictError(
        outcome.conflict.memoryId,
        outcome.conflict.expectedRevision,
        outcome.conflict.currentRevision,
      );
    }

    return outcome.result;
  }

  private async commitInTransaction(
    tx: CanonicalMemoryStoreTx,
    request: CanonicalCommitRequest,
    verifiedAdmissionFingerprint: string | undefined,
  ): Promise<CommitOutcome> {
    const candidate = await tx.getCandidate(request.candidateId);
    if (candidate === undefined) {
      throw new CandidateNotFoundError(request.candidateId);
    }

    const prior = await tx.getCommitResultByIdempotencyKey(
      candidate.scope,
      request.idempotencyKey,
    );
    if (prior !== undefined) {
      if (prior.revision.provenance.candidateId !== candidate.candidateId) {
        throw new ValidationError(
          `idempotencyKey ${request.idempotencyKey} was already used by another candidate`,
        );
      }
      return { kind: "committed", result: prior };
    }

    requirePending(candidate);
    requireVerifiedProviderAdmissionState(candidate, verifiedAdmissionFingerprint);

    if (
      candidate.proposedOperation === "supersede" ||
      candidate.proposedOperation === "merge"
    ) {
      throw new UnsupportedOperationError(candidate.proposedOperation);
    }

    const committedAt = this.clock.now();
    let memoryId: MemoryId;
    let baseRevision: number | null;
    let newRevision: number;
    let status: MemoryStatus;
    let canonicalContent: CanonicalContent;
    let headCreatedAt: string;
    let observedAt: string | undefined;
    let validFrom: string | undefined;
    let validUntil: string | undefined;
    let memoryClass = candidate.memoryClass;
    let memoryKind = candidate.memoryKind;
    let epistemicStatus = candidate.epistemicStatus;
    let producer = candidate.producer;
    let sourceExperienceRefs = candidate.sourceExperienceRefs;
    let semanticFingerprint = candidate.candidateFingerprint;

    if (candidate.proposedOperation === "create") {
      memoryId = this.ids.memoryId();
      baseRevision = null;
      newRevision = 1;
      status = "active";
      canonicalContent = candidate.proposedContent;
      observedAt = candidate.observedAt;
      validFrom = candidate.validFrom;
      validUntil = candidate.validUntil;
      headCreatedAt = committedAt;
    } else {
      const baseMemoryId = candidate.baseMemoryId;
      const expectedRevision = candidate.baseRevision;
      if (baseMemoryId === undefined || expectedRevision === undefined) {
        throw new ValidationError(
          `${candidate.proposedOperation} requires baseMemoryId/baseRevision`,
        );
      }

      const currentHead = await tx.getHead(baseMemoryId);
      if (currentHead === undefined) {
        throw new MemoryNotFoundError(baseMemoryId);
      }
      if (!sameScope(currentHead.scope, candidate.scope)) {
        throw new ScopeMismatchError(
          `Candidate ${candidate.candidateId} cannot mutate memory in another scope`,
        );
      }

      if (currentHead.currentRevision !== expectedRevision) {
        const conflict: MemoryConflict = {
          conflictId: this.ids.conflictId(),
          candidateId: candidate.candidateId,
          scope: candidate.scope,
          memoryId: baseMemoryId,
          expectedRevision,
          currentRevision: currentHead.currentRevision,
          detectedAt: committedAt,
        };
        await tx.setCandidateStatus(candidate.candidateId, "CONFLICT");
        await tx.appendConflict(conflict);
        return { kind: "conflict", conflict };
      }

      if (
        currentHead.memoryClass !== candidate.memoryClass ||
        currentHead.memoryKind !== candidate.memoryKind
      ) {
        throw new ValidationError(
          "update/tombstone/restore cannot change memoryClass or memoryKind",
        );
      }

      const currentRevision = await tx.getRevision(
        baseMemoryId,
        currentHead.currentRevision,
      );
      if (currentRevision === undefined) {
        throw new ValidationError(
          `Head ${baseMemoryId} points to missing revision ${currentHead.currentRevision}`,
        );
      }

      memoryId = baseMemoryId;
      baseRevision = expectedRevision;
      newRevision = expectedRevision + 1;
      headCreatedAt = currentHead.createdAt;
      memoryClass = currentHead.memoryClass;
      memoryKind = currentHead.memoryKind;

      switch (candidate.proposedOperation) {
        case "update":
          if (currentHead.status !== "active") {
            throw new ValidationError(
              `Cannot update ${baseMemoryId} while status=${currentHead.status}`,
            );
          }
          status = "active";
          canonicalContent = candidate.proposedContent;
          observedAt = candidate.observedAt;
          validFrom = candidate.validFrom;
          validUntil = candidate.validUntil;
          break;
        case "tombstone":
          if (currentHead.status === "tombstoned") {
            throw new ValidationError(`${baseMemoryId} is already tombstoned`);
          }
          status = "tombstoned";
          canonicalContent = currentRevision.canonicalContent;
          observedAt = currentRevision.observedAt;
          validFrom = currentRevision.validFrom;
          validUntil = currentRevision.validUntil;
          epistemicStatus = currentRevision.epistemicStatus;
          producer = currentRevision.producer;
          sourceExperienceRefs = currentRevision.sourceExperienceRefs;
          semanticFingerprint = currentRevision.semanticFingerprint;
          break;
        case "restore":
          if (currentHead.status !== "tombstoned") {
            throw new ValidationError(
              `Cannot restore ${baseMemoryId} while status=${currentHead.status}`,
            );
          }
          status = "active";
          canonicalContent = currentRevision.canonicalContent;
          observedAt = currentRevision.observedAt;
          validFrom = currentRevision.validFrom;
          validUntil = currentRevision.validUntil;
          epistemicStatus = currentRevision.epistemicStatus;
          producer = currentRevision.producer;
          sourceExperienceRefs = currentRevision.sourceExperienceRefs;
          semanticFingerprint = currentRevision.semanticFingerprint;
          break;
        default:
          throw new UnsupportedOperationError(candidate.proposedOperation);
      }
    }

    const commitSeq = await tx.nextCommitSeq(candidate.scope);
    const contentHash = sha256(canonicalContent);
    const revision: MemoryRevision = {
      memoryId,
      revision: newRevision,
      scope: candidate.scope,
      memoryClass,
      memoryKind,
      status,
      canonicalContent,
      contentHash,
      author: candidate.origin,
      provenance: provenanceFor(candidate),
      evidenceRefs: candidate.evidenceRefs,
      epistemicStatus,
      producer,
      sourceExperienceRefs,
      semanticFingerprint,
      committedAt,
      commitSeq,
    };
    if (observedAt !== undefined) revision.observedAt = observedAt;
    if (validFrom !== undefined) revision.validFrom = validFrom;
    if (validUntil !== undefined) revision.validUntil = validUntil;

    const head: CanonicalMemoryHead = {
      memoryId,
      scope: candidate.scope,
      memoryClass,
      memoryKind,
      currentRevision: newRevision,
      status,
      createdAt: headCreatedAt,
      updatedAt: committedAt,
    };

    const payloadHash = sha256({
      memoryId,
      revision: newRevision,
      status,
      canonicalContent,
      contentHash,
      epistemicStatus,
      semanticFingerprint,
    });

    const change = {
      eventId: this.ids.eventId(),
      scope: candidate.scope,
      commitSeq,
      memoryId,
      operation: candidate.proposedOperation,
      baseRevision,
      newRevision,
      idempotencyKey: request.idempotencyKey,
      author: candidate.origin,
      committedAt,
      payloadHash,
    } as const;

    const outbox = {
      outboxId: this.ids.outboxId(),
      scope: candidate.scope,
      commitSeq,
      memoryId,
      revision: newRevision,
      operation: candidate.proposedOperation,
      status: "PENDING" as const,
      attempts: 0,
      createdAt: committedAt,
    };

    await tx.putHead(head);
    await tx.appendRevision(revision);
    await tx.appendChange(change);
    await tx.appendOutbox(outbox);
    await tx.setCandidateStatus(candidate.candidateId, "ACCEPTED");

    const result: CanonicalCommitResult = { head, revision, change, outbox };
    await tx.putCommitResultByIdempotencyKey(
      candidate.scope,
      request.idempotencyKey,
      result,
    );

    return { kind: "committed", result };
  }
}
