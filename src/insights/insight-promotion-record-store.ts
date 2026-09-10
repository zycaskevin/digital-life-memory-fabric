import type { MemoryScope } from "../domain/types.js";
import type {
  InsightPromotionEvent,
  InsightPromotionRecord,
  InsightPromotionRecordId,
  ReflectiveInsightId,
} from "./types.js";

export interface InsightPromotionRecordStore {
  put(record: InsightPromotionRecord): Promise<void>;
  get(promotionId: InsightPromotionRecordId): Promise<InsightPromotionRecord | undefined>;
  getByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<InsightPromotionRecord | undefined>;
  getByInsightId(
    scope: MemoryScope,
    insightId: ReflectiveInsightId,
  ): Promise<InsightPromotionRecord | undefined>;
  listEvents(
    scope: MemoryScope,
    promotionId: InsightPromotionRecordId,
  ): Promise<InsightPromotionEvent[]>;
  withInsightLock<T>(
    scope: MemoryScope,
    insightId: ReflectiveInsightId,
    work: () => Promise<T>,
  ): Promise<T>;
}
