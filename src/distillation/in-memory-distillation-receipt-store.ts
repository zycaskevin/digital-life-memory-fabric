import type { MemoryScope } from "../domain/types.js";
import { scopeKey } from "../domain/utils.js";
import type { DistillationReceiptStore } from "./distillation-receipt-store.js";
import type { DistillationReceipt } from "./types.js";

const clone = <T>(value: T): T => structuredClone(value);
const key = (scope: MemoryScope, idempotencyKey: string): string =>
  `${scopeKey(scope)}\u001f${idempotencyKey}`;

export class InMemoryDistillationReceiptStore implements DistillationReceiptStore {
  private readonly receipts = new Map<string, DistillationReceipt>();

  async getByIdempotencyKey(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<DistillationReceipt | undefined> {
    const value = this.receipts.get(key(scope, idempotencyKey));
    return value === undefined ? undefined : clone(value);
  }

  async getLatestBySource(
    scope: MemoryScope,
    sourceType: string,
    sourceId: string,
  ): Promise<DistillationReceipt | undefined> {
    const scoped = scopeKey(scope);
    let latest: DistillationReceipt | undefined;
    for (const receipt of this.receipts.values()) {
      if (
        scopeKey(receipt.scope) !== scoped ||
        receipt.sourceType !== sourceType ||
        receipt.sourceId !== sourceId
      ) continue;
      if (latest === undefined || receipt.updatedAt > latest.updatedAt) latest = receipt;
    }
    return latest === undefined ? undefined : clone(latest);
  }

  async put(receipt: DistillationReceipt): Promise<void> {
    const storageKey = key(receipt.scope, receipt.idempotencyKey);
    const existing = this.receipts.get(storageKey);
    const merged: DistillationReceipt = existing === undefined
      ? receipt
      : {
          ...receipt,
          receiptId: existing.receiptId,
          candidateIds: [...new Set([...existing.candidateIds, ...receipt.candidateIds])],
          canonicalMemoryIds: [
            ...new Set([...existing.canonicalMemoryIds, ...receipt.canonicalMemoryIds]),
          ],
          status: existing.status === "complete" ? "complete" : receipt.status,
          canonicalizationOutcome:
            existing.canonicalizationOutcome === "committed" ||
            receipt.canonicalizationOutcome === "committed"
              ? "committed"
              : receipt.canonicalizationOutcome,
          retentionState:
            existing.retentionState === "prune_eligible"
              ? "prune_eligible"
              : receipt.retentionState,
          pruneEligible: existing.pruneEligible || receipt.pruneEligible,
        };
    this.receipts.set(storageKey, clone(merged));
  }
}
