import type {
  CandidateId,
  CanonicalContent,
  EpistemicStatus,
  MemoryClass,
  MemoryId,
  MemoryScope,
} from "../domain/types.js";
import type {
  MemoryCandidateType,
  ProviderMemoryUnit,
} from "../distillation/types.js";

export type ProviderMemoryUnitOutcome =
  | "supporting_evidence_only"
  | "rejected"
  | "pending_review"
  | "canonical_candidate";

export type MemoryDurability =
  | "transient"
  | "session_scoped"
  | "time_bounded"
  | "durable"
  | "identity_long_term"
  | "unknown";

export type SemanticDisposition = "novel" | "duplicate" | "merge_required";

export type EpistemicAttributionBasis =
  | "provider_declared"
  | "direct_source_quote"
  | "system_record"
  | "derived"
  | "unknown";

export interface EpistemicAttribution {
  status: EpistemicStatus;
  basis: EpistemicAttributionBasis;
  evidenceQuote?: string;
}

export interface CuratedCandidateDraft {
  candidateType: MemoryCandidateType;
  memoryClass: MemoryClass;
  memoryKind: string;
  proposedContent: CanonicalContent;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
}

export interface MemoryCurationProposal {
  providerUnitRef: string;
  outcome: ProviderMemoryUnitOutcome;
  epistemicAttribution: EpistemicAttribution;
  memoryWorthy: boolean;
  durability: MemoryDurability;
  semanticDisposition: SemanticDisposition;
  reasonCodes: string[];
  targetMemoryId?: MemoryId;
  curatedCandidate?: CuratedCandidateDraft;
}

export interface MemoryCurationRequest {
  scope: MemoryScope;
  sourceType: string;
  sourceId: string;
  rawContent: string;
  providerName: string;
  providerRunId: string;
  admissionPolicyVersion: string;
  units: ProviderMemoryUnit[];
  requestedAt: string;
}

export interface MemoryCurationResult {
  providerName: string;
  providerVersion?: string;
  proposals: MemoryCurationProposal[];
  warnings: string[];
}

/**
 * Replaceable memory-intelligence seam. A cloud model, local model, or
 * OmniHarness-backed implementation may produce proposals. It never owns
 * canonical IDs, canonical truth, or commit authority.
 */
export interface MemoryCurationProvider {
  readonly name: string;
  readonly version?: string;
  curate(request: MemoryCurationRequest): Promise<MemoryCurationResult>;
}

export interface CanonicalAdmissionInput {
  unit: ProviderMemoryUnit;
  proposal: MemoryCurationProposal;
  rawContent: string;
}

export interface CanonicalAdmissionDecision {
  outcome: ProviderMemoryUnitOutcome;
  epistemicStatus: EpistemicStatus;
  durability: MemoryDurability;
  memoryWorthy: boolean;
  semanticDisposition: SemanticDisposition;
  reasonCodes: string[];
  targetMemoryId?: MemoryId;
  candidateDraft?: CuratedCandidateDraft;
}

/** DLMF-owned deterministic admission boundary; not a model/provider authority. */
export interface CanonicalAdmissionPolicy {
  readonly policyVersion: string;
  evaluate(input: CanonicalAdmissionInput): CanonicalAdmissionDecision;
}

export type CurationRecordId = `cur_${string}`;

export interface MemoryCurationRecord {
  recordId: CurationRecordId;
  receiptId: string;
  scope: MemoryScope;
  sourceType: string;
  sourceId: string;
  providerName: string;
  providerRunId: string;
  providerUnitRef: string;
  providerUnitText: string;
  providerUnitFingerprint: string;
  providerEpistemicStatus: EpistemicStatus;
  curationProvider: string;
  curationProviderVersion?: string;
  admissionPolicyVersion: string;
  outcome: ProviderMemoryUnitOutcome;
  attributedEpistemicStatus: EpistemicStatus;
  durability: MemoryDurability;
  memoryWorthy: boolean;
  semanticDisposition: SemanticDisposition;
  reasonCodes: string[];
  targetMemoryId?: MemoryId;
  candidateId?: CandidateId;
  canonicalMemoryId?: MemoryId;
  createdAt: string;
}

export interface CurationOutcomeCounts {
  supporting_evidence_only: number;
  rejected: number;
  pending_review: number;
  canonical_candidate: number;
}

export function emptyCurationOutcomeCounts(): CurationOutcomeCounts {
  return {
    supporting_evidence_only: 0,
    rejected: 0,
    pending_review: 0,
    canonical_candidate: 0,
  };
}
