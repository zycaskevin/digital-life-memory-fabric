import type { MemoryCandidate } from "../domain/types.js";
import {
  curationRecordBacksCanonicalAdmission,
  type MemoryCurationRecordStore,
} from "./memory-curation-record-store.js";
import type { MemoryCurationRecord } from "./types.js";

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryMemoryCurationRecordStore implements MemoryCurationRecordStore {
  private readonly records = new Map<string, MemoryCurationRecord>();

  async put(record: MemoryCurationRecord): Promise<void> {
    const existing = this.records.get(record.recordId);
    if (
      existing?.canonicalMemoryId !== undefined &&
      record.canonicalMemoryId === undefined
    ) {
      this.records.set(record.recordId, clone(existing));
      return;
    }
    this.records.set(record.recordId, clone({
      ...record,
      ...(record.candidateId === undefined && existing?.candidateId !== undefined
        ? { candidateId: existing.candidateId }
        : {}),
      ...(record.canonicalMemoryId === undefined && existing?.canonicalMemoryId !== undefined
        ? { canonicalMemoryId: existing.canonicalMemoryId }
        : {}),
    }));
  }

  async listByReceipt(receiptId: string): Promise<MemoryCurationRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.receiptId === receiptId)
      .sort((left, right) => left.providerUnitRef.localeCompare(right.providerUnitRef))
      .map(clone);
  }

  async verifyCanonicalAdmission(candidate: MemoryCandidate): Promise<boolean> {
    const proof = candidate.canonicalAdmission;
    if (proof === undefined) return false;
    return curationRecordBacksCanonicalAdmission(
      this.records.get(proof.curationRecordId),
      candidate,
    );
  }
}
