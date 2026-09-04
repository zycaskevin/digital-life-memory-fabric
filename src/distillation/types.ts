import type {
  CandidateId,
  CanonicalContent,
  EpistemicStatus,
  EvidenceRef,
  MemoryAuthor,
  MemoryClass,
  MemoryId,
  MemoryProducer,
  MemoryRevision,
  MemoryScope,
  SourceExperienceRef,
} from "../domain/types.js";
import type { CurationOutcomeCounts } from "../curation/types.js";

export type MemoryCandidateType =
  | "fact_candidate"
  | "event_candidate"
  | "preference_candidate"
  | "relationship_candidate"
  | "project_state_candidate"
  | "commitment_candidate"
  | "habit_candidate"
  | "derived_insight_candidate";

export interface RawExperienceRef extends SourceExperienceRef {
  contentType: string;
  createdAt?: string;
}

export interface DistillationExperience {
  scope: MemoryScope;
  sourceType: string;
  sourceId: string;
  content: string;
  contentType: string;
  archiveRef: string;
  checksum: string;
  createdAt?: string;
  observedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface DistillationRequest {
  experience: DistillationExperience;
  distillationPolicyVersion: string;
  requestedAt: string;
}

/** Provider extraction output. This is never a DLMF MemoryCandidate. */
export interface ProviderMemoryUnit {
  providerUnitRef: string;
  candidateType: MemoryCandidateType;
  memoryClass: MemoryClass;
  memoryKind: string;
  proposedContent: CanonicalContent;
  evidenceRefs: EvidenceRef[];
  epistemicStatus: EpistemicStatus;
  confidence?: number;
  producer: MemoryProducer;
  sourceExperienceRefs: SourceExperienceRef[];
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
}

/** @deprecated Provider extraction yields ProviderMemoryUnit, not a DLMF MemoryCandidate. */
export type DistilledCandidateDraft = ProviderMemoryUnit;

export interface DerivedMemoryCandidateDraft {
  candidateType: "derived_insight_candidate";
  memoryClass: MemoryClass;
  memoryKind: string;
  proposedContent: CanonicalContent;
  evidenceRefs: EvidenceRef[];
  epistemicStatus: "inferred" | "synthesized" | "uncertain";
  confidence?: number;
  producer: MemoryProducer;
  sourceExperienceRefs: SourceExperienceRef[];
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
}

export interface DistillationResult {
  providerName: string;
  providerRunId: string;
  adapterVersion: string;
  providerVersion?: string;
  providerUnits: ProviderMemoryUnit[];
  warnings: string[];
}

export interface MemoryEvidence {
  evidenceRef: EvidenceRef;
  text?: string;
  providerName?: string;
  providerSourceId?: string;
  sourceExperienceRefs: SourceExperienceRef[];
  metadata?: Record<string, unknown>;
}

export interface RecallRequest {
  scope: MemoryScope;
  query: string;
  context?: Record<string, unknown>;
  requestedAt: string;
}

export interface CanonicalMemoryForReflection {
  memoryId: MemoryId;
  revision: number;
  text: string;
  epistemicStatus: EpistemicStatus;
  evidenceRefs: EvidenceRef[];
  sourceExperienceRefs: SourceExperienceRef[];
}

export interface ReflectRequest {
  scope: MemoryScope;
  context: string;
  evidence: MemoryEvidence[];
  canonicalMemories: CanonicalMemoryForReflection[];
  distillationPolicyVersion: string;
  requestedAt: string;
}

export interface ReflectResult {
  providerName: string;
  providerRunId: string;
  adapterVersion: string;
  providerVersion?: string;
  candidates: DerivedMemoryCandidateDraft[];
  warnings: string[];
}

export type DistillationReceiptId = `dist_${string}`;
export type DistillationReceiptStatus =
  | "pending"
  | "ingested"
  | "archived"
  | "distilled"
  | "curated"
  | "canonicalized"
  | "awaiting_review"
  | "complete"
  | "failed";

export type CanonicalizationOutcome =
  | "pending"
  | "committed"
  | "no_memory_worthy_content"
  | "rejected"
  | "superseded"
  | "pending_review";

export type RetentionState = "hot" | "preserved" | "prune_eligible";

export interface DistillationErrorRecord {
  stage:
    | "ingestion"
    | "archive"
    | "provider"
    | "curation"
    | "admission"
    | "canonicalization"
    | "retention";
  code: string;
  message: string;
  occurredAt: string;
}

export interface DistillationReceipt {
  receiptId: DistillationReceiptId;
  scope: MemoryScope;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  ingestedAt?: string;
  archivedAt?: string;
  distilledAt?: string;
  curatedAt?: string;
  canonicalizedAt?: string;
  rawArchiveRef?: string;
  rawArchiveChecksum?: string;
  provider: string;
  providerRunId?: string;
  distillationPolicyVersion: string;
  canonicalizationPolicyVersion: string;
  admissionPolicyVersion: string;
  retentionPolicyVersion: string;
  adapterVersion: string;
  providerVersion?: string;
  curationProvider: string;
  curationProviderVersion?: string;
  providerUnitCount: number;
  curationDecisionCount: number;
  curationOutcomes: CurationOutcomeCounts;
  curationCoverageComplete: boolean;
  admissionComplete: boolean;
  candidateIds: CandidateId[];
  canonicalMemoryIds: MemoryId[];
  status: DistillationReceiptStatus;
  errors: DistillationErrorRecord[];
  warnings: string[];
  canonicalizationOutcome: CanonicalizationOutcome;
  retentionState: RetentionState;
  pruneEligible: boolean;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptDistillationInput {
  scope: MemoryScope;
  origin: MemoryAuthor;
  sourceType: string;
  sourceId: string;
  content: string;
  contentType: string;
  createdAt?: string;
  observedAt?: string;
  metadata?: Record<string, unknown>;
  distillationPolicyVersion: string;
  canonicalizationPolicyVersion: string;
  admissionPolicyVersion: string;
  retentionPolicyVersion: string;
}

export interface ReflectiveDistillationInput {
  scope: MemoryScope;
  origin: MemoryAuthor;
  context: string;
  evidence: MemoryEvidence[];
  canonicalMemories: MemoryRevision[];
  distillationPolicyVersion: string;
}

export interface PruneEligibilityDecision {
  sourceType: string;
  sourceId: string;
  eligible: boolean;
  receiptId?: DistillationReceiptId;
  archiveVerified: boolean;
  retentionPolicyVersion?: string;
  admissionPolicyVersion?: string;
  canonicalizationOutcome?: CanonicalizationOutcome;
  curationCoverageComplete?: boolean;
  admissionComplete?: boolean;
  blockingReasons: string[];
}
