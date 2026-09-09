import type {
  MemoryAuthor,
  MemoryScope,
  MemoryType,
  SemanticRelation,
} from "../domain/types.js";
import type { CurationRecordId } from "../curation/types.js";

export type SemanticReviewCaseId = `semrev_${string}`;
export type SemanticReviewDecisionId = `semdec_${string}`;
export type SemanticReviewEventId = `semevt_${string}`;

export type SemanticReviewTrigger = "pending_review" | "canary_sample";
export type SemanticReviewStatus = "pending" | "deferred" | "resolved";
export type SemanticReviewDisposition =
  | "approved_as_classified"
  | "confirmed_contradiction"
  | "confirmed_unrelated"
  | "misclassified"
  | "invalid_candidate"
  | "needs_more_evidence";

export interface SemanticReviewDecision {
  decisionId: SemanticReviewDecisionId;
  idempotencyKey: string;
  disposition: SemanticReviewDisposition;
  reviewer: MemoryAuthor;
  evidenceIds: string[];
  reasonCodes: string[];
  decidedAt: string;
}

/**
 * Content-minimized DLMF review record. The source text remains in the governed
 * curation record and is never copied into this operational queue.
 */
export interface SemanticReviewCase {
  caseId: SemanticReviewCaseId;
  scope: MemoryScope;
  curationRecordId: CurationRecordId;
  receiptId: string;
  trigger: SemanticReviewTrigger;
  semanticKey: string;
  semanticPolicyVersion: string;
  memoryType: MemoryType;
  semanticRelation?: SemanticRelation;
  triggerReasonCodes: string[];
  status: SemanticReviewStatus;
  version: number;
  latestDecision?: SemanticReviewDecision;
  canonicalWritePerformed: false;
  createdAt: string;
  updatedAt: string;
}

export interface SemanticReviewEvent {
  eventId: SemanticReviewEventId;
  caseId: SemanticReviewCaseId;
  scope: MemoryScope;
  eventType: "enqueued" | "deferred" | "resolved";
  caseVersion: number;
  reasonCodes: string[];
  decision?: SemanticReviewDecision;
  occurredAt: string;
}

export interface SemanticReviewResolutionRequest {
  caseId: SemanticReviewCaseId;
  scope: MemoryScope;
  expectedVersion: number;
  idempotencyKey: string;
  disposition: SemanticReviewDisposition;
  reviewer: MemoryAuthor;
  evidenceIds: string[];
  reasonCodes: string[];
}

export interface SemanticReviewListOptions {
  status?: SemanticReviewStatus;
  limit?: number;
}

export interface SemanticGovernanceTelemetry {
  receiptId: string;
  totalCurationRecords: number;
  outcomeCounts: Record<string, number>;
  relationCounts: Record<string, number>;
  memoryTypeCounts: Record<string, number>;
  reviewStatusCounts: Record<string, number>;
  dispositionCounts: Record<string, number>;
  rawContentIncluded: false;
  providerUnitTextIncluded: false;
}

export interface SemanticCanaryAssessment {
  eligibleForExpandedManualCanary: boolean;
  reasonCodes: string[];
  telemetry: SemanticGovernanceTelemetry;
  automaticPruningEnabled: false;
  automaticPromotionEnabled: false;
  canonicalWritePerformed: false;
}
