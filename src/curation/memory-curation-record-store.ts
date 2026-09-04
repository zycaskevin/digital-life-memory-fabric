import type { CanonicalAdmissionVerifier } from "../authority/canonical-memory-authority.js";
import type { MemoryCandidate } from "../domain/types.js";
import { sameScope } from "../domain/utils.js";
import type { MemoryCurationRecord } from "./types.js";

export function curationRecordBacksCanonicalAdmission(
  record: MemoryCurationRecord | undefined,
  candidate: MemoryCandidate,
): boolean {
  const proof = candidate.canonicalAdmission;
  if (record === undefined || proof === undefined || candidate.sourceId === undefined) return false;
  const producerName = candidate.producer.providerName ?? candidate.producer.id;
  return (
    record.recordId === proof.curationRecordId &&
    record.candidateId === candidate.candidateId &&
    sameScope(record.scope, candidate.scope) &&
    record.sourceType === candidate.sourceType &&
    record.sourceId === candidate.sourceId &&
    record.providerName === producerName &&
    candidate.providerRunId !== undefined &&
    record.providerRunId === candidate.providerRunId &&
    record.providerUnitText === candidate.proposedContent.text &&
    record.outcome === "canonical_candidate" &&
    record.attributedEpistemicStatus === candidate.epistemicStatus &&
    record.memoryWorthy === true &&
    (record.durability === "durable" || record.durability === "identity_long_term") &&
    record.semanticDisposition === "novel" &&
    record.admissionPolicyVersion === proof.admissionPolicyVersion &&
    record.curationProvider === proof.curationProvider &&
    (record.curationProviderVersion ?? null) === (proof.curationProviderVersion ?? null)
  );
}

export interface MemoryCurationRecordStore extends CanonicalAdmissionVerifier {
  put(record: MemoryCurationRecord): Promise<void>;
  listByReceipt(receiptId: string): Promise<MemoryCurationRecord[]>;
  verifyCanonicalAdmission(candidate: MemoryCandidate): Promise<boolean>;
}
