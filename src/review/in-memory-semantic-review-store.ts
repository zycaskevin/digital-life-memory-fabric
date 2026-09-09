import { SemanticReviewConflictError, ValidationError } from "../domain/errors.js";
import type { MemoryScope } from "../domain/types.js";
import { sameScope, stableStringify } from "../domain/utils.js";
import type { SemanticReviewStore } from "./semantic-review-store.js";
import type {
  SemanticReviewCase,
  SemanticReviewCaseId,
  SemanticReviewEvent,
  SemanticReviewListOptions,
} from "./types.js";

const clone = <T>(value: T): T => structuredClone(value);
const scopeKey = (scope: MemoryScope): string =>
  `${scope.tenantId}\u0000${scope.lifeDid}\u0000${scope.memoryNamespace}`;
const idempotencyKey = (scope: MemoryScope, key: string): string =>
  `${scopeKey(scope)}\u0000${key}`;

function immutableCase(reviewCase: SemanticReviewCase): string {
  const {
    status: _status,
    version: _version,
    latestDecision: _latestDecision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...immutable
  } = reviewCase;
  return stableStringify(immutable);
}

function immutableResolutionCase(reviewCase: SemanticReviewCase): string {
  const {
    status: _status,
    version: _version,
    latestDecision: _latestDecision,
    updatedAt: _updatedAt,
    ...immutable
  } = reviewCase;
  return stableStringify(immutable);
}

function sameEventIntent(left: SemanticReviewEvent, right: SemanticReviewEvent): boolean {
  const normalize = (event: SemanticReviewEvent) => ({
    caseId: event.caseId,
    scope: event.scope,
    eventType: event.eventType,
    caseVersion: event.caseVersion,
    reasonCodes: event.reasonCodes,
    decision: event.decision === undefined ? undefined : {
      decisionId: event.decision.decisionId,
      idempotencyKey: event.decision.idempotencyKey,
      disposition: event.decision.disposition,
      reviewer: event.decision.reviewer,
      evidenceIds: event.decision.evidenceIds,
      reasonCodes: event.decision.reasonCodes,
    },
  });
  return stableStringify(normalize(left)) === stableStringify(normalize(right));
}

export class InMemorySemanticReviewStore implements SemanticReviewStore {
  private readonly cases = new Map<SemanticReviewCaseId, SemanticReviewCase>();
  private readonly caseByCurationRecord = new Map<string, SemanticReviewCaseId>();
  private readonly events = new Map<SemanticReviewCaseId, SemanticReviewEvent[]>();
  private readonly eventsByIdempotency = new Map<string, SemanticReviewEvent>();

  async enqueue(
    reviewCase: SemanticReviewCase,
    event: SemanticReviewEvent,
  ): Promise<SemanticReviewCase> {
    if (
      reviewCase.canonicalWritePerformed !== false ||
      reviewCase.status !== "pending" ||
      reviewCase.version !== 1 ||
      reviewCase.latestDecision !== undefined ||
      reviewCase.createdAt !== reviewCase.updatedAt ||
      event.caseId !== reviewCase.caseId ||
      !sameScope(event.scope, reviewCase.scope) ||
      event.eventType !== "enqueued" ||
      event.caseVersion !== 1 ||
      event.decision !== undefined ||
      event.occurredAt !== reviewCase.createdAt
    ) {
      throw new ValidationError("semantic review enqueue event is invalid");
    }
    const priorId = this.caseByCurationRecord.get(reviewCase.curationRecordId);
    const existing = priorId === undefined ? this.cases.get(reviewCase.caseId) : this.cases.get(priorId);
    if (existing !== undefined) {
      if (immutableCase(existing) !== immutableCase(reviewCase)) {
        throw new ValidationError("semantic review enqueue changed immutable case fields");
      }
      const existingEvent = this.events.get(existing.caseId)?.[0];
      if (existingEvent === undefined || !sameEventIntent(existingEvent, event)) {
        throw new ValidationError("semantic review enqueue event changed immutable fields");
      }
      return clone(existing);
    }
    this.cases.set(reviewCase.caseId, clone(reviewCase));
    this.caseByCurationRecord.set(reviewCase.curationRecordId, reviewCase.caseId);
    this.events.set(reviewCase.caseId, [clone(event)]);
    return clone(reviewCase);
  }

  async get(caseId: SemanticReviewCaseId): Promise<SemanticReviewCase | undefined> {
    const value = this.cases.get(caseId);
    return value === undefined ? undefined : clone(value);
  }

  async listByReceipt(receiptId: string): Promise<SemanticReviewCase[]> {
    return [...this.cases.values()]
      .filter((reviewCase) => reviewCase.receiptId === receiptId)
      .sort((left, right) => left.caseId.localeCompare(right.caseId))
      .map(clone);
  }

  async list(
    scope: MemoryScope,
    options: SemanticReviewListOptions = {},
  ): Promise<SemanticReviewCase[]> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ValidationError("semantic review list limit must be between 1 and 1000");
    }
    return [...this.cases.values()]
      .filter((reviewCase) =>
        sameScope(reviewCase.scope, scope) &&
        (options.status === undefined || reviewCase.status === options.status),
      )
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.caseId.localeCompare(right.caseId),
      )
      .slice(0, limit)
      .map(clone);
  }

  async getEventByIdempotencyKey(
    scope: MemoryScope,
    key: string,
  ): Promise<SemanticReviewEvent | undefined> {
    const value = this.eventsByIdempotency.get(idempotencyKey(scope, key));
    return value === undefined ? undefined : clone(value);
  }

  async resolve(
    caseId: SemanticReviewCaseId,
    expectedVersion: number,
    next: SemanticReviewCase,
    event: SemanticReviewEvent,
  ): Promise<SemanticReviewCase> {
    const current = this.cases.get(caseId);
    if (current === undefined) throw new ValidationError(`semantic review case ${caseId} was not found`);
    if (event.decision === undefined) {
      throw new ValidationError("semantic review resolution requires a bound decision");
    }
    const reviewer = event.decision.reviewer;
    const reviewerIdentified = [reviewer.agentId, reviewer.runtimeId, reviewer.deviceId]
      .some((value) => value !== undefined && value.trim().length > 0);
    const eventKey = idempotencyKey(current.scope, event.decision.idempotencyKey);
    const prior = this.eventsByIdempotency.get(eventKey);
    if (prior !== undefined) {
      if (!sameEventIntent(prior, event)) {
        throw new ValidationError("semantic review idempotency key already exists");
      }
      return clone(current);
    }
    if (current.version !== expectedVersion) {
      throw new SemanticReviewConflictError(caseId, expectedVersion, current.version);
    }
    if (
      next.canonicalWritePerformed !== false ||
      next.caseId !== caseId ||
      immutableResolutionCase(next) !== immutableResolutionCase(current) ||
      next.version !== expectedVersion + 1 ||
      next.latestDecision === undefined ||
      event.caseId !== caseId ||
      !sameScope(event.scope, next.scope) ||
      event.caseVersion !== next.version ||
      event.decision.decisionId !== next.latestDecision.decisionId ||
      stableStringify(event.decision) !== stableStringify(next.latestDecision) ||
      stableStringify(event.reasonCodes) !== stableStringify(event.decision.reasonCodes) ||
      reviewer.lifeDid !== next.scope.lifeDid ||
      !reviewerIdentified ||
      !event.decision.evidenceIds.includes(`curation:${next.curationRecordId}`) ||
      event.occurredAt !== next.updatedAt ||
      event.decision.decidedAt !== next.updatedAt ||
      next.updatedAt < current.updatedAt ||
      (event.decision.disposition === "needs_more_evidence"
        ? next.status !== "deferred" || event.eventType !== "deferred"
        : next.status !== "resolved" || event.eventType !== "resolved")
    ) {
      throw new ValidationError("semantic review resolution changed immutable or bound fields");
    }
    this.cases.set(caseId, clone(next));
    this.events.set(caseId, [...(this.events.get(caseId) ?? []), clone(event)]);
    this.eventsByIdempotency.set(eventKey, clone(event));
    return clone(next);
  }

  async listEvents(caseId: SemanticReviewCaseId): Promise<SemanticReviewEvent[]> {
    return (this.events.get(caseId) ?? [])
      .slice()
      .sort((left, right) => left.caseVersion - right.caseVersion)
      .map(clone);
  }
}
