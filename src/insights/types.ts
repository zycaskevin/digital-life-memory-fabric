import type {
  CandidateId,
  EpistemicStatus,
  MemoryAuthor,
  MemoryId,
  MemoryScope,
  MemoryType,
} from "../domain/types.js";

export type ReflectiveInsightId = `insight_${string}`;
export type ReflectiveInsightStatus = "pending" | "accepted" | "rejected" | "superseded";

export interface InsightPromotionEligibility {
  eligible: boolean;
  evidenceClosure: boolean;
  requiresExplicitApproval: true;
  reasonCodes: string[];
}

export interface ReflectiveInsight {
  insightId: ReflectiveInsightId;
  scope: MemoryScope;
  proposition: string;
  epistemicStatus: Extract<EpistemicStatus, "inferred" | "synthesized" | "uncertain">;
  supportingMemoryIds: MemoryId[];
  supportingEvidenceIds: string[];
  contradictingMemoryIds: MemoryId[];
  confidence: number;
  derivationProvider: string;
  derivationModel: string;
  derivationRunId: string;
  status: ReflectiveInsightStatus;
  promotionEligibility: InsightPromotionEligibility;
  canonicalWritePerformed: false;
  createdAt: string;
  updatedAt: string;
}

export type InsightPromotionRecordId = `prom_${string}`;
export type InsightPromotionEventId = `promevt_${string}`;
export type InsightPromotionStatus = "approved" | "committed" | "rejected";
export type InsightPromotionEventType =
  | "approved"
  | "candidate_linked"
  | "committed"
  | "rejected";

export interface InsightPromotionRecord {
  promotionId: InsightPromotionRecordId;
  insightId: ReflectiveInsightId;
  scope: MemoryScope;
  idempotencyKey: string;
  promotionPolicyVersion: string;
  approvedBy: MemoryAuthor;
  approvalEvidenceIds: string[];
  eligibility: InsightPromotionEligibility;
  memoryType: MemoryType;
  semanticKey: string;
  status: InsightPromotionStatus;
  candidateId?: CandidateId;
  canonicalMemoryId?: MemoryId;
  createdAt: string;
  updatedAt: string;
}

export interface InsightPromotionEvent {
  eventId: InsightPromotionEventId;
  promotionId: InsightPromotionRecordId;
  insightId: ReflectiveInsightId;
  scope: MemoryScope;
  eventType: InsightPromotionEventType;
  status: InsightPromotionStatus;
  approvedBy: MemoryAuthor;
  approvalEvidenceIds: string[];
  eligibility: InsightPromotionEligibility;
  candidateId?: CandidateId;
  canonicalMemoryId?: MemoryId;
  occurredAt: string;
}

export interface InsightPromotionRequest {
  insightId: ReflectiveInsightId;
  scope: MemoryScope;
  approvedBy: MemoryAuthor;
  approvalEvidenceIds: string[];
  idempotencyKey: string;
}

export interface InsightPromotionResult {
  insight: ReflectiveInsight;
  record: InsightPromotionRecord;
  canonicalMemoryId: MemoryId;
}
