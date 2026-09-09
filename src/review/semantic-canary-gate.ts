import { ValidationError } from "../domain/errors.js";
import { sameScope, stableStringify } from "../domain/utils.js";
import type { MemoryCurationRecord } from "../curation/types.js";
import type { SemanticCanaryAssessment, SemanticGovernanceTelemetry, SemanticReviewCase } from "./types.js";

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function telemetryFor(
  receiptId: string,
  records: readonly MemoryCurationRecord[],
  cases: readonly SemanticReviewCase[],
): SemanticGovernanceTelemetry {
  const outcomeCounts: Record<string, number> = {};
  const relationCounts: Record<string, number> = {};
  const memoryTypeCounts: Record<string, number> = {};
  const reviewStatusCounts: Record<string, number> = {};
  const dispositionCounts: Record<string, number> = {};
  for (const record of records) {
    increment(outcomeCounts, record.outcome);
    increment(memoryTypeCounts, record.memoryType);
    increment(relationCounts, record.semanticRelation ?? "none");
  }
  for (const reviewCase of cases) {
    increment(reviewStatusCounts, reviewCase.status);
    if (reviewCase.latestDecision !== undefined) {
      increment(dispositionCounts, reviewCase.latestDecision.disposition);
    }
  }
  return {
    receiptId,
    totalCurationRecords: records.length,
    outcomeCounts,
    relationCounts,
    memoryTypeCounts,
    reviewStatusCounts,
    dispositionCounts,
    rawContentIncluded: false,
    providerUnitTextIncluded: false,
  };
}

/** Read-only gate. It reports readiness and never activates policy or mutates memory. */
export class SemanticCanaryGate {
  assess(input: {
    receiptId: string;
    records: readonly MemoryCurationRecord[];
    reviewCases: readonly SemanticReviewCase[];
    expectedRecordCount: number;
    expectedSemanticPolicyVersion: string;
    minimumResolvedCanarySamples?: number;
  }): SemanticCanaryAssessment {
    if (!Number.isInteger(input.expectedRecordCount) || input.expectedRecordCount < 0) {
      throw new ValidationError("expectedRecordCount must be a non-negative integer");
    }
    const minimumSamples = input.minimumResolvedCanarySamples ?? 1;
    if (!Number.isInteger(minimumSamples) || minimumSamples < 1) {
      throw new ValidationError("minimumResolvedCanarySamples must be a positive integer");
    }
    const reasonCodes: string[] = [];
    const records = input.records.filter((record) => record.receiptId === input.receiptId);
    const cases = input.reviewCases.filter((reviewCase) => reviewCase.receiptId === input.receiptId);
    if (records.length !== input.records.length) {
      reasonCodes.push("canary:unexpected_receipt_records");
    }
    if (cases.length !== input.reviewCases.length) {
      reasonCodes.push("canary:unexpected_receipt_review_cases");
    }
    if (records.length !== input.expectedRecordCount) {
      reasonCodes.push("canary:curation_coverage_mismatch");
    }
    if (records.some((record) => record.semanticPolicyVersion !== input.expectedSemanticPolicyVersion)) {
      reasonCodes.push("canary:semantic_policy_mismatch");
    }
    const recordById = new Map(records.map((record) => [record.recordId, record]));
    if (
      new Set(cases.map((reviewCase) => reviewCase.curationRecordId)).size !== cases.length ||
      cases.some((reviewCase) => {
        const record = recordById.get(reviewCase.curationRecordId);
        return record === undefined ||
          !sameScope(reviewCase.scope, record.scope) ||
          reviewCase.semanticKey !== record.semanticKey ||
          reviewCase.semanticPolicyVersion !== record.semanticPolicyVersion ||
          reviewCase.memoryType !== record.memoryType ||
          reviewCase.semanticRelation !== record.semanticRelation ||
          stableStringify(reviewCase.triggerReasonCodes) !== stableStringify(record.reasonCodes) ||
          (reviewCase.trigger === "pending_review") !== (record.outcome === "pending_review");
      })
    ) {
      reasonCodes.push("canary:review_case_source_mismatch");
    }
    const pendingRecordIds = new Set(
      records.filter((record) => record.outcome === "pending_review").map((record) => record.recordId),
    );
    const queuedPendingIds = new Set(
      cases.filter((reviewCase) => reviewCase.trigger === "pending_review")
        .map((reviewCase) => reviewCase.curationRecordId),
    );
    if ([...pendingRecordIds].some((recordId) => !queuedPendingIds.has(recordId))) {
      reasonCodes.push("canary:pending_review_not_queued");
    }
    if (pendingRecordIds.size > 0) {
      reasonCodes.push("canary:pending_review_outcomes_present");
    }
    if (cases.some((reviewCase) => reviewCase.status !== "resolved")) {
      reasonCodes.push("canary:unresolved_review_cases");
    }
    const resolvedSamples = cases.filter((reviewCase) =>
      reviewCase.trigger === "canary_sample" &&
      reviewCase.status === "resolved" &&
      reviewCase.latestDecision?.disposition === "approved_as_classified",
    ).length;
    if (resolvedSamples < minimumSamples) {
      reasonCodes.push("canary:insufficient_approved_samples");
    }
    if (cases.some((reviewCase) => reviewCase.latestDecision?.disposition === "misclassified")) {
      reasonCodes.push("canary:misclassification_detected");
    }
    if (cases.some((reviewCase) => reviewCase.canonicalWritePerformed !== false)) {
      reasonCodes.push("canary:review_case_crossed_canonical_boundary");
    }
    return {
      eligibleForExpandedManualCanary: reasonCodes.length === 0,
      reasonCodes: reasonCodes.length === 0 ? ["canary:manual_expansion_eligible"] : reasonCodes,
      telemetry: telemetryFor(input.receiptId, records, cases),
      automaticPruningEnabled: false,
      automaticPromotionEnabled: false,
      canonicalWritePerformed: false,
    };
  }
}
