import type { MemoryScope } from "../domain/types.js";
import type {
  InsightPromotionRecord,
  InsightPromotionRecordId,
} from "./types.js";

export interface InsightPromotionRecordStore {
  put(record: InsightPromotionRecord): Promise<void>;
  get(promotionId: InsightPromotionRecordId): Promise<InsightPromotionRecord | undefined>;
  getByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<InsightPromotionRecord | undefined>;
}
