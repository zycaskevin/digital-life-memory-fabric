import { ValidationError } from "../domain/errors.js";
import type { MemoryScope } from "../domain/types.js";
import { sameScope, scopeKey, stableStringify } from "../domain/utils.js";
import type { InsightPromotionRecordStore } from "./insight-promotion-record-store.js";
import type {
  InsightPromotionRecord,
  InsightPromotionRecordId,
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
    eligibility: record.eligibility,
    memoryType: record.memoryType,
    semanticKey: record.semanticKey,
    createdAt: record.createdAt,
  });
}

export class InMemoryInsightPromotionRecordStore implements InsightPromotionRecordStore {
  private readonly records = new Map<InsightPromotionRecordId, InsightPromotionRecord>();
  private readonly idempotency = new Map<string, InsightPromotionRecordId>();

  async put(record: InsightPromotionRecord): Promise<void> {
    const key = idempotencyIndex(record.scope, record.idempotencyKey);
    const indexedId = this.idempotency.get(key);
    if (indexedId !== undefined && indexedId !== record.promotionId) {
      throw new ValidationError("insight promotion idempotency key was reused");
    }
    const existing = this.records.get(record.promotionId);
    if (existing !== undefined) {
      if (!sameScope(existing.scope, record.scope) || immutableShape(existing) !== immutableShape(record)) {
        throw new ValidationError("insight promotion immutable fields changed");
      }
      if (existing.status === "committed" && record.status !== "committed") {
        throw new ValidationError("committed insight promotion cannot regress");
      }
      if (existing.status === "rejected" && record.status !== "rejected") {
        throw new ValidationError("rejected insight promotion cannot be reopened");
      }
      if (
        existing.canonicalMemoryId !== undefined &&
        record.canonicalMemoryId !== existing.canonicalMemoryId
      ) {
        throw new ValidationError("committed insight promotion canonical memory changed");
      }
    }
    this.records.set(record.promotionId, clone(record));
    this.idempotency.set(key, record.promotionId);
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
}
