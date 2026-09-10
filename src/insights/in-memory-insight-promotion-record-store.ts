import { ValidationError } from "../domain/errors.js";
import type { MemoryScope } from "../domain/types.js";
import { sameScope, scopeKey, sha256, stableStringify } from "../domain/utils.js";
import type { InsightPromotionRecordStore } from "./insight-promotion-record-store.js";
import type {
  InsightPromotionEvent,
  InsightPromotionEventType,
  InsightPromotionRecord,
  InsightPromotionRecordId,
  ReflectiveInsightId,
} from "./types.js";

const clone = <T>(value: T): T => structuredClone(value);
const idempotencyIndex = (scope: MemoryScope, key: string): string =>
  `${scopeKey(scope)}\u001f${key}`;

function immutableShape(record: InsightPromotionRecord): string {
  return stableStringify({
    promotionId: record.promotionId,
    insightId: record.insightId,
    scope: record.scope,
    idempotencyKey: record.idempotencyKey,
    promotionPolicyVersion: record.promotionPolicyVersion,
    approvedBy: record.approvedBy,
    approvalEvidenceIds: record.approvalEvidenceIds,
    eligibility: record.eligibility,
    memoryType: record.memoryType,
    semanticKey: record.semanticKey,
    createdAt: record.createdAt,
  });
}
function eventTypeFor(record: InsightPromotionRecord): InsightPromotionEventType {
  if (record.status === "rejected") return "rejected";
  if (record.status === "committed") return "committed";
  return record.candidateId === undefined ? "approved" : "candidate_linked";
}

function eventFor(record: InsightPromotionRecord): InsightPromotionEvent {
  const eventType = eventTypeFor(record);
  const digest = sha256({
    promotionId: record.promotionId,
    eventType,
    candidateId: record.candidateId ?? null,
    canonicalMemoryId: record.canonicalMemoryId ?? null,
  }).slice("sha256:".length, "sha256:".length + 32);
  return {
    eventId: `promevt_${digest}`,
    promotionId: record.promotionId,
    insightId: record.insightId,
    scope: record.scope,
    eventType,
    status: record.status,
    approvedBy: record.approvedBy,
    approvalEvidenceIds: record.approvalEvidenceIds,
    eligibility: record.eligibility,
    ...(record.candidateId === undefined ? {} : { candidateId: record.candidateId }),
    ...(record.canonicalMemoryId === undefined
      ? {}
      : { canonicalMemoryId: record.canonicalMemoryId }),
    occurredAt: record.updatedAt,
  };
}


export class InMemoryInsightPromotionRecordStore implements InsightPromotionRecordStore {
  private readonly records = new Map<InsightPromotionRecordId, InsightPromotionRecord>();
  private readonly idempotency = new Map<string, InsightPromotionRecordId>();
  private readonly insightIndex = new Map<ReflectiveInsightId, InsightPromotionRecordId>();
  private readonly events = new Map<InsightPromotionRecordId, InsightPromotionEvent[]>();
  private readonly locks = new Map<string, Promise<void>>();

  async put(record: InsightPromotionRecord): Promise<void> {
    if (!Array.isArray(record.approvalEvidenceIds) || record.approvalEvidenceIds.length === 0) {
      throw new ValidationError("insight promotion approval evidence is required");
    }
    const key = idempotencyIndex(record.scope, record.idempotencyKey);
    const indexedId = this.idempotency.get(key);
    if (indexedId !== undefined && indexedId !== record.promotionId) {
      throw new ValidationError("insight promotion idempotency key was reused");
    }
    const insightPromotionId = this.insightIndex.get(record.insightId);
    if (insightPromotionId !== undefined && insightPromotionId !== record.promotionId) {
      throw new ValidationError("reflective insight already has a promotion record");
    }
    const existing = this.records.get(record.promotionId);
    if (existing !== undefined) {
      if (!sameScope(existing.scope, record.scope) || immutableShape(existing) !== immutableShape(record)) {
        throw new ValidationError("insight promotion immutable fields changed");
      }
      if (
        existing.status !== record.status &&
        !(existing.status === "approved" && record.status === "committed")
      ) {
        throw new ValidationError("insight promotion status transition is not monotonic");
      }
      if (
        existing.candidateId !== undefined &&
        record.candidateId !== existing.candidateId
      ) {
        throw new ValidationError("insight promotion candidate linkage changed");
      }
      if (
        existing.canonicalMemoryId !== undefined &&
        record.canonicalMemoryId !== existing.canonicalMemoryId
      ) {
        throw new ValidationError("committed insight promotion canonical memory changed");
      }
      if (Date.parse(record.updatedAt) < Date.parse(existing.updatedAt)) {
        throw new ValidationError("insight promotion update time regressed");
      }
    }
    this.records.set(record.promotionId, clone(record));
    this.idempotency.set(key, record.promotionId);
    this.insightIndex.set(record.insightId, record.promotionId);
    const event = eventFor(record);
    const events = this.events.get(record.promotionId) ?? [];
    if (!events.some((value) => value.eventId === event.eventId)) {
      events.push(clone(event));
      this.events.set(record.promotionId, events);
    }
  }
  async get(promotionId: InsightPromotionRecordId): Promise<InsightPromotionRecord | undefined> {
    const record = this.records.get(promotionId);
    return record === undefined ? undefined : clone(record);
  }

  async getByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<InsightPromotionRecord | undefined> {
    const promotionId = this.idempotency.get(idempotencyIndex(scope, idempotencyKey));
    if (promotionId === undefined) return undefined;
    return this.get(promotionId);
  }
  async getByInsightId(
    scope: MemoryScope,
    insightId: ReflectiveInsightId,
  ): Promise<InsightPromotionRecord | undefined> {
    const promotionId = this.insightIndex.get(insightId);
    if (promotionId === undefined) return undefined;
    const record = this.records.get(promotionId);
    if (record === undefined || !sameScope(record.scope, scope)) return undefined;
    return clone(record);
  }

  async listEvents(
    scope: MemoryScope,
    promotionId: InsightPromotionRecordId,
  ): Promise<InsightPromotionEvent[]> {
    const record = this.records.get(promotionId);
    if (record === undefined || !sameScope(record.scope, scope)) return [];
    return clone(this.events.get(promotionId) ?? []);
  }

  async withInsightLock<T>(
    scope: MemoryScope,
    insightId: ReflectiveInsightId,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = scopeKey(scope) + "\u001f" + insightId;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

}
