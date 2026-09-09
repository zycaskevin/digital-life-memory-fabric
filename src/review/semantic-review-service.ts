import type { MemoryCurationRecordStore } from "../curation/memory-curation-record-store.js";
import type { CurationRecordId, MemoryCurationRecord } from "../curation/types.js";
import { ValidationError } from "../domain/errors.js";
import type { MemoryAuthor } from "../domain/types.js";
import { SystemClock, sameScope, sha256, stableStringify, type Clock } from "../domain/utils.js";
import type { SemanticReviewStore } from "./semantic-review-store.js";
import { normalizeSemanticReviewIdentifiers } from "./normalization.js";
import type {
  SemanticReviewCase,
  SemanticReviewCaseId,
  SemanticReviewDecision,
  SemanticReviewDisposition,
  SemanticReviewEvent,
  SemanticReviewResolutionRequest,
  SemanticReviewTrigger,
} from "./types.js";

const pendingDispositions = new Set<SemanticReviewDisposition>([
  "confirmed_contradiction",
  "confirmed_unrelated",
  "invalid_candidate",
  "needs_more_evidence",
]);
const sampleDispositions = new Set<SemanticReviewDisposition>([
  "approved_as_classified",
  "misclassified",
  "needs_more_evidence",
]);

function digest(value: unknown): string {
  return sha256(value).slice("sha256:".length, "sha256:".length + 32);
}

function uniqueNonEmpty(values: readonly string[], field: string): string[] {
  const normalized = normalizeSemanticReviewIdentifiers(values);
  if (normalized.length === 0) throw new ValidationError(`${field} must not be empty`);
  return normalized;
}

function normalizedReviewer(reviewer: MemoryAuthor): MemoryAuthor {
  const allowed = new Set(["lifeDid", "agentId", "runtimeId", "deviceId"]);
  if (Object.keys(reviewer).some((key) => !allowed.has(key))) {
    throw new ValidationError("semantic review reviewer contains unsupported fields");
  }
  return {
    lifeDid: reviewer.lifeDid,
    ...(reviewer.agentId?.trim() ? { agentId: reviewer.agentId.trim() } : {}),
    ...(reviewer.runtimeId?.trim() ? { runtimeId: reviewer.runtimeId.trim() } : {}),
    ...(reviewer.deviceId?.trim() ? { deviceId: reviewer.deviceId.trim() } : {}),
  };
}

function caseIdFor(record: MemoryCurationRecord): SemanticReviewCaseId {
  return `semrev_${digest({ scope: record.scope, curationRecordId: record.recordId })}`;
}

function triggerFor(
  record: MemoryCurationRecord,
  sampleIds: ReadonlySet<CurationRecordId>,
): SemanticReviewTrigger | undefined {
  if (record.outcome === "pending_review") return "pending_review";
  return sampleIds.has(record.recordId) ? "canary_sample" : undefined;
}

function sameDecision(event: SemanticReviewEvent, request: SemanticReviewResolutionRequest): boolean {
  const decision = event.decision;
  return decision !== undefined &&
    event.caseId === request.caseId &&
    sameScope(event.scope, request.scope) &&
    decision.idempotencyKey === request.idempotencyKey &&
    decision.disposition === request.disposition &&
    stableStringify(decision.reviewer) === stableStringify(request.reviewer) &&
    stableStringify(decision.evidenceIds) ===
      stableStringify(normalizeSemanticReviewIdentifiers(request.evidenceIds)) &&
    stableStringify(decision.reasonCodes) ===
      stableStringify(normalizeSemanticReviewIdentifiers(request.reasonCodes));
}

export class SemanticReviewQueueService {
  private readonly clock: Clock;

  constructor(
    private readonly curationStore: MemoryCurationRecordStore,
    private readonly reviewStore: SemanticReviewStore,
    clock: Clock = new SystemClock(),
  ) {
    this.clock = clock;
  }

  async enqueueRecord(
    record: MemoryCurationRecord,
    trigger: SemanticReviewTrigger,
  ): Promise<SemanticReviewCase> {
    if (trigger === "pending_review" && record.outcome !== "pending_review") {
      throw new ValidationError("pending review trigger requires a pending_review curation record");
    }
    if (trigger === "canary_sample" && record.outcome === "pending_review") {
      throw new ValidationError("pending_review curation records cannot be canary samples");
    }
    const timestamp = this.clock.now();
    const reviewCase: SemanticReviewCase = {
      caseId: caseIdFor(record),
      scope: record.scope,
      curationRecordId: record.recordId,
      receiptId: record.receiptId,
      trigger,
      semanticKey: record.semanticKey,
      semanticPolicyVersion: record.semanticPolicyVersion,
      memoryType: record.memoryType,
      ...(record.semanticRelation === undefined ? {} : { semanticRelation: record.semanticRelation }),
      triggerReasonCodes: uniqueNonEmpty(record.reasonCodes, "record.reasonCodes"),
      status: "pending",
      version: 1,
      canonicalWritePerformed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const event: SemanticReviewEvent = {
      eventId: `semevt_${digest({ caseId: reviewCase.caseId, eventType: "enqueued" })}`,
      caseId: reviewCase.caseId,
      scope: record.scope,
      eventType: "enqueued",
      caseVersion: 1,
      reasonCodes: [
        trigger === "pending_review" ? "review:pending_outcome" : "review:canary_sample",
      ],
      occurredAt: timestamp,
    };
    return this.reviewStore.enqueue(reviewCase, event);
  }

  async enqueueReceipt(input: {
    receiptId: string;
    canarySampleRecordIds?: CurationRecordId[];
  }): Promise<SemanticReviewCase[]> {
    if (input.receiptId.trim().length === 0) throw new ValidationError("receiptId must not be empty");
    const records = await this.curationStore.listByReceipt(input.receiptId);
    const available = new Set(records.map((record) => record.recordId));
    const sampleIds = new Set(input.canarySampleRecordIds ?? []);
    for (const recordId of sampleIds) {
      if (!available.has(recordId)) {
        throw new ValidationError(`canary sample ${recordId} is not part of receipt ${input.receiptId}`);
      }
    }
    const queued: SemanticReviewCase[] = [];
    for (const record of records) {
      const trigger = triggerFor(record, sampleIds);
      if (trigger !== undefined) queued.push(await this.enqueueRecord(record, trigger));
    }
    return queued;
  }

  async resolve(request: SemanticReviewResolutionRequest): Promise<SemanticReviewCase> {
    if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
      throw new ValidationError("expectedVersion must be a positive integer");
    }
    if (request.idempotencyKey.trim().length === 0) {
      throw new ValidationError("idempotencyKey must not be empty");
    }
    if (request.reviewer.lifeDid !== request.scope.lifeDid) {
      throw new ValidationError("reviewer.lifeDid must match review scope");
    }
    const reviewer = normalizedReviewer(request.reviewer);
    if (![reviewer.agentId, reviewer.runtimeId, reviewer.deviceId]
      .some((value) => value !== undefined && value.trim().length > 0)) {
      throw new ValidationError("semantic review requires an identified reviewer actor");
    }
    const evidenceIds = uniqueNonEmpty(request.evidenceIds, "evidenceIds");
    const reasonCodes = uniqueNonEmpty(request.reasonCodes, "reasonCodes");

    const current = await this.reviewStore.get(request.scope, request.caseId);
    if (current === undefined) {
      throw new ValidationError(`semantic review case ${request.caseId} was not found`);
    }
    if (!sameScope(current.scope, request.scope)) {
      throw new ValidationError("semantic review scope mismatch");
    }
    if (!evidenceIds.includes(`curation:${current.curationRecordId}`)) {
      throw new ValidationError("semantic review evidence must bind the governed curation record");
    }
    const prior = await this.reviewStore.getEventByIdempotencyKey(
      request.scope,
      request.idempotencyKey,
    );
    if (prior !== undefined) {
      if (!sameDecision(prior, { ...request, reviewer, evidenceIds, reasonCodes })) {
        throw new ValidationError("semantic review idempotency key was reused with different input");
      }
      const replay = await this.reviewStore.get(request.scope, request.caseId);
      if (replay === undefined) throw new ValidationError("semantic review replay target is missing");
      return replay;
    }
    if (current.status === "resolved") {
      throw new ValidationError("resolved semantic review case cannot be decided again");
    }
    const allowed = current.trigger === "pending_review" ? pendingDispositions : sampleDispositions;
    if (!allowed.has(request.disposition)) {
      throw new ValidationError(
        `disposition ${request.disposition} is not allowed for ${current.trigger}`,
      );
    }
    const timestamp = this.clock.now();
    const decision: SemanticReviewDecision = {
      decisionId: `semdec_${digest({ scope: request.scope, idempotencyKey: request.idempotencyKey })}`,
      idempotencyKey: request.idempotencyKey,
      disposition: request.disposition,
      reviewer,
      evidenceIds,
      reasonCodes,
      decidedAt: timestamp,
    };
    const deferred = request.disposition === "needs_more_evidence";
    const next: SemanticReviewCase = {
      ...current,
      status: deferred ? "deferred" : "resolved",
      version: current.version + 1,
      latestDecision: decision,
      canonicalWritePerformed: false,
      updatedAt: timestamp,
    };
    const event: SemanticReviewEvent = {
      eventId: `semevt_${digest({ decisionId: decision.decisionId })}`,
      caseId: current.caseId,
      scope: current.scope,
      eventType: deferred ? "deferred" : "resolved",
      caseVersion: next.version,
      reasonCodes,
      decision,
      occurredAt: timestamp,
    };
    return this.reviewStore.resolve(current.caseId, request.expectedVersion, next, event);
  }
}
