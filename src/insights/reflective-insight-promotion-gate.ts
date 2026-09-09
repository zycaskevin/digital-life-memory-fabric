import type {
  InsightPromotionEligibility,
  ReflectiveInsight,
  ReflectiveInsightStatus,
} from "./types.js";

export class ReflectiveInsightPromotionGate {
  constructor(readonly minimumConfidence = 0.75) {
    if (!Number.isFinite(minimumConfidence) || minimumConfidence <= 0 || minimumConfidence > 1) {
      throw new Error("minimumConfidence must be greater than 0 and at most 1");
    }
  }

  assess(
    insight: Pick<
      ReflectiveInsight,
      | "supportingMemoryIds"
      | "supportingEvidenceIds"
      | "contradictingMemoryIds"
      | "confidence"
    > & { status: ReflectiveInsightStatus },
  ): InsightPromotionEligibility {
    const reasonCodes: string[] = [];
    const evidenceClosure =
      insight.supportingMemoryIds.length > 0 &&
      insight.supportingEvidenceIds.length > 0 &&
      insight.confidence >= this.minimumConfidence;

    if (insight.supportingMemoryIds.length === 0) {
      reasonCodes.push("promotion:no_supporting_memories");
    }
    if (insight.supportingEvidenceIds.length === 0) {
      reasonCodes.push("promotion:no_supporting_evidence");
    }
    if (insight.confidence < this.minimumConfidence) {
      reasonCodes.push("promotion:confidence_below_threshold");
    }
    if (insight.contradictingMemoryIds.length > 0) {
      reasonCodes.push("promotion:unresolved_contradictions");
    }
    if (insight.status !== "accepted") {
      reasonCodes.push("promotion:explicit_acceptance_required");
    }

    return {
      eligible:
        evidenceClosure &&
        insight.contradictingMemoryIds.length === 0 &&
        insight.status === "accepted",
      evidenceClosure,
      requiresExplicitApproval: true,
      reasonCodes: reasonCodes.length === 0
        ? ["promotion:evidence_closed_and_explicitly_accepted"]
        : reasonCodes,
    };
  }
}
