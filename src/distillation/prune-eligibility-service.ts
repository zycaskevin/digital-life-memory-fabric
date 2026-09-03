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
  evaluate(receipt: DistillationReceipt): Promise<RetentionPolicyDecision>;
}

export class PreservationCompleteRetentionPolicy implements DistillationRetentionPolicy {
  constructor(readonly version: string) {}

  async evaluate(receipt: DistillationReceipt): Promise<RetentionPolicyDecision> {
    const blockingReasons: string[] = [];
    if (receipt.status !== "complete") blockingReasons.push("receipt_not_complete");
    if (receipt.canonicalizationOutcome === "pending") {
      blockingReasons.push("canonicalization_not_decided");
    }
    if (receipt.rawArchiveRef === undefined || receipt.rawArchiveChecksum === undefined) {
      blockingReasons.push("raw_archive_not_recorded");
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
    const policy = await this.retentionPolicy.evaluate(receipt);
    blockingReasons.push(...policy.blockingReasons);

    let archiveVerified = false;
    if (receipt.rawArchiveRef !== undefined && receipt.rawArchiveChecksum !== undefined) {
      archiveVerified = await this.archive.verify(
        receipt.rawArchiveRef,
        receipt.rawArchiveChecksum,
      );
    }
    if (!archiveVerified) blockingReasons.push("raw_archive_verification_failed");

    return {
      sourceType,
      sourceId,
      eligible: blockingReasons.length === 0,
      receiptId: receipt.receiptId,
      archiveVerified,
      retentionPolicyVersion: receipt.retentionPolicyVersion,
      canonicalizationOutcome: receipt.canonicalizationOutcome,
      blockingReasons: [...new Set(blockingReasons)],
    };
  }

  /**
   * Persist the governed eligibility decision on the durable receipt. This
   * never deletes operational data; a Hermes maintenance adapter owns deletion.
   */
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
        retentionState: decision.eligible ? "prune_eligible" : receipt.retentionState,
        updatedAt: this.clock.now(),
      });
    }
    return decision;
  }
}
