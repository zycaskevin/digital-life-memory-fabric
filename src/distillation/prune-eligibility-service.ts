import type { MemoryScope } from "../domain/types.js";
import { SystemClock, type Clock } from "../domain/utils.js";
import type { RawExperienceArchiveProvider } from "../archive/raw-experience-archive.js";
import type { DistillationReceiptStore } from "./distillation-receipt-store.js";
import type { DistillationReceipt, PruneEligibilityDecision } from "./types.js";

export interface RetentionPolicyDecision {
  satisfied: boolean;
  blockingReasons: string[];
}

export interface DistillationRetentionPolicy {
  readonly version: string;
  readonly admissionPolicyVersion: string;
  evaluate(receipt: DistillationReceipt): Promise<RetentionPolicyDecision>;
}

function curationOutcomeTotal(receipt: DistillationReceipt): number {
  return (
    receipt.curationOutcomes.supporting_evidence_only +
    receipt.curationOutcomes.rejected +
    receipt.curationOutcomes.pending_review +
    receipt.curationOutcomes.canonical_candidate
  );
}

export class PreservationCompleteRetentionPolicy implements DistillationRetentionPolicy {
  constructor(
    readonly version: string,
    readonly admissionPolicyVersion: string,
  ) {}

  async evaluate(receipt: DistillationReceipt): Promise<RetentionPolicyDecision> {
    const blockingReasons: string[] = [];
    if (receipt.status !== "complete") blockingReasons.push("receipt_not_complete");
    if (
      receipt.canonicalizationOutcome === "pending" ||
      receipt.canonicalizationOutcome === "pending_review"
    ) {
      blockingReasons.push("canonicalization_not_final");
    }
    if (receipt.rawArchiveRef === undefined || receipt.rawArchiveChecksum === undefined) {
      blockingReasons.push("raw_archive_not_recorded");
    }
    if (receipt.admissionPolicyVersion !== this.admissionPolicyVersion) {
      blockingReasons.push("admission_policy_version_mismatch");
    }
    if (!receipt.curationCoverageComplete) blockingReasons.push("curation_coverage_incomplete");
    if (!receipt.admissionComplete) blockingReasons.push("canonical_admission_incomplete");
    if (receipt.curationDecisionCount !== receipt.providerUnitCount) {
      blockingReasons.push("curation_decision_count_mismatch");
    }
    if (curationOutcomeTotal(receipt) !== receipt.providerUnitCount) {
      blockingReasons.push("curation_outcome_count_mismatch");
    }
    if (receipt.curationOutcomes.pending_review > 0) {
      blockingReasons.push("pending_review_present");
    }
    return { satisfied: blockingReasons.length === 0, blockingReasons };
  }
}

export class PruneEligibilityService {
  constructor(
    private readonly receipts: DistillationReceiptStore,
    private readonly archive: RawExperienceArchiveProvider,
    private readonly retentionPolicy: DistillationRetentionPolicy,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async evaluate(
    scope: MemoryScope,
    sourceType: string,
    sourceId: string,
  ): Promise<PruneEligibilityDecision> {
    const receipt = await this.receipts.getLatestBySource(scope, sourceType, sourceId);
    if (receipt === undefined) {
      return {
        sourceType,
        sourceId,
        eligible: false,
        archiveVerified: false,
        blockingReasons: ["no_distillation_receipt"],
      };
    }

    const blockingReasons: string[] = [];
    if (receipt.status !== "complete") blockingReasons.push(`receipt_status_${receipt.status}`);
    if (receipt.retentionPolicyVersion !== this.retentionPolicy.version) {
      blockingReasons.push("retention_policy_version_mismatch");
    }
    if (receipt.admissionPolicyVersion !== this.retentionPolicy.admissionPolicyVersion) {
      blockingReasons.push("admission_policy_version_mismatch");
    }
    const policy = await this.retentionPolicy.evaluate(receipt);
    blockingReasons.push(...policy.blockingReasons);

    let archiveVerified = false;
    if (receipt.rawArchiveRef !== undefined && receipt.rawArchiveChecksum !== undefined) {
      archiveVerified = await this.archive.verify(receipt.rawArchiveRef, receipt.rawArchiveChecksum);
    }
    if (!archiveVerified) blockingReasons.push("raw_archive_verification_failed");

    return {
      sourceType,
      sourceId,
      eligible: blockingReasons.length === 0,
      receiptId: receipt.receiptId,
      archiveVerified,
      retentionPolicyVersion: receipt.retentionPolicyVersion,
      admissionPolicyVersion: receipt.admissionPolicyVersion,
      canonicalizationOutcome: receipt.canonicalizationOutcome,
      curationCoverageComplete: receipt.curationCoverageComplete,
      admissionComplete: receipt.admissionComplete,
      blockingReasons: [...new Set(blockingReasons)],
    };
  }

  async refresh(
    scope: MemoryScope,
    sourceType: string,
    sourceId: string,
  ): Promise<PruneEligibilityDecision> {
    const decision = await this.evaluate(scope, sourceType, sourceId);
    const receipt = await this.receipts.getLatestBySource(scope, sourceType, sourceId);
    if (receipt !== undefined) {
      await this.receipts.put({
        ...receipt,
        pruneEligible: decision.eligible,
        retentionState: decision.eligible ? "prune_eligible" : "preserved",
        updatedAt: this.clock.now(),
      });
    }
    return decision;
  }
}
