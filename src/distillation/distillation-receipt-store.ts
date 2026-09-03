import type { MemoryScope } from "../domain/types.js";
import type { DistillationReceipt } from "./types.js";

export interface DistillationReceiptStore {
  getByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<DistillationReceipt | undefined>;
  getLatestBySource(
    scope: MemoryScope,
    sourceType: string,
    sourceId: string,
  ): Promise<DistillationReceipt | undefined>;
  put(receipt: DistillationReceipt): Promise<void>;
}
