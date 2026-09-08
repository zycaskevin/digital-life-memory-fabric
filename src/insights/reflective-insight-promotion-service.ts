import { CanonicalMemoryAuthority } from "../authority/canonical-memory-authority.js";
import { MemoryCandidateService } from "../candidates/memory-candidate-service.js";
import { ValidationError } from "../domain/errors.js";
import type {
  CandidateInput,
  EvidenceRef,
  MemoryRevision,
  SourceExperienceRef,
} from "../domain/types.js";
import {
  SystemClock,
  sameScope,
  sha256,
  stableStringify,
  type Clock,
} from "../domain/utils.js";
import type { ProviderMemoryUnit } from "../distillation/types.js";
import {
  DeterministicSemanticMemoryGovernance,
  type SemanticMemoryGovernance,
} from "../semantic/deterministic-semantic-governance.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";
import type { InsightPromotionRecordStore } from "./insight-promotion-record-store.js";
import { ReflectiveInsightPromotionGate } from "./reflective-insight-promotion-gate.js";
import type { ReflectiveInsightStore } from "./reflective-insight-store.js";
import type {
  InsightPromotionRecord,
  InsightPromotionRecordId,
  InsightPromotionRequest,
  InsightPromotionResult,
  ReflectiveInsight,
} from "./types.js";

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new ValidationError(`${field} must not be empty`);
}

function promotionIdFor(
  scope: InsightPromotionRequest["scope"],
  idempotencyKey: string,
): InsightPromotionRecordId {
  const digest = sha256({ scope, idempotencyKey }).slice(
    "sha256:".length,
    "sha256:".length + 32,
  );
  return `prom_${digest}`;
}

function evidenceId(ref: EvidenceRef): string {
  return `${ref.sourceType}:${ref.sourceRef}`;
}

function evidenceRef(value: string): EvidenceRef {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new ValidationError(`supportingEvidenceId ${value} must be sourceType:sourceRef`);
  }
  return {
    sourceType: value.slice(0, separator),
    sourceRef: value.slice(separator + 1),
  };
}

function providerUnitFor(insight: ReflectiveInsight): ProviderMemoryUnit {
  return {
    providerUnitRef: insight.insightId,
    candidateType: "derived_insight_candidate",
    memoryClass: "semantic_assertion",
    memoryKind: "reflective_insight",
    proposedContent: { text: insight.proposition },
    evidenceRefs: insight.supportingEvidenceIds.map(evidenceRef),
    epistemicStatus: insight.epistemicStatus,
    speakerProvenance: "unknown",
    confidence: insight.confidence,
    producer: {
      kind: "provider",
      id: insight.derivationProvider,
      providerName: insight.derivationProvider,
    },
    sourceExperienceRefs: [
      { sourceType: "reflective_insight", sourceId: insight.insightId },
    ],
  };
}

export interface ReflectiveInsightPromotionServiceDependencies {
  canonicalStore: CanonicalMemoryStore;
  insightStore: ReflectiveInsightStore;
  promotionStore: InsightPromotionRecordStore;
  approvalVerifier: InsightPromotionApprovalVerifier;
  candidateService?: MemoryCandidateService;
  authority?: CanonicalMemoryAuthority;
  semanticGovernance?: SemanticMemoryGovernance;
  promotionGate?: ReflectiveInsightPromotionGate;
  clock?: Clock;
  promotionPolicyVersion?: string;
}

export interface InsightPromotionApprovalVerifier {
  verifyApproval(input: {
    request: InsightPromotionRequest;
    insight: ReflectiveInsight;
    promotionPolicyVersion: string;
  }): Promise<boolean>;
}

/**
 * Explicit DLMF-owned bridge from an accepted insight to canonical admission.
 * The derivation provider is provenance only; it never receives candidate or
 * canonical commit authority.
 */
export class ReflectiveInsightPromotionService {
  private readonly candidateService: MemoryCandidateService;
  private readonly authority: CanonicalMemoryAuthority;
  private readonly semanticGovernance: SemanticMemoryGovernance;
  private readonly promotionGate: ReflectiveInsightPromotionGate;
  private readonly clock: Clock;
  readonly promotionPolicyVersion: string;

  constructor(
    private readonly dependencies: ReflectiveInsightPromotionServiceDependencies,
  ) {
    this.candidateService =
      dependencies.candidateService ??
      new MemoryCandidateService(dependencies.canonicalStore);
    this.authority =
      dependencies.authority ??
      new CanonicalMemoryAuthority(dependencies.canonicalStore);
    this.semanticGovernance =
      dependencies.semanticGovernance ??
      new DeterministicSemanticMemoryGovernance();
    this.promotionGate =
      dependencies.promotionGate ?? new ReflectiveInsightPromotionGate();
    this.clock = dependencies.clock ?? new SystemClock();
    this.promotionPolicyVersion =
      dependencies.promotionPolicyVersion ?? "dlmf-insight-promotion-v1";
  }

  async promote(request: InsightPromotionRequest): Promise<InsightPromotionResult> {
    requireNonEmpty(request.idempotencyKey, "idempotencyKey");
    if (request.approvedBy.lifeDid !== request.scope.lifeDid) {
      throw new ValidationError("approvedBy.lifeDid must match scope.lifeDid");
    }

    const prior = await this.dependencies.promotionStore.getByIdempotencyKey(
      request.scope,
      request.idempotencyKey,
    );
    if (prior !== undefined) {
      this.validateReplay(prior, request);
      if (prior.status === "rejected") {
        throw new ValidationError("insight promotion was previously rejected");
      }
      if (prior.status === "committed") return this.committedResult(prior);
    }

    const insight = await this.dependencies.insightStore.get(request.insightId);
    if (insight === undefined) {
      throw new ValidationError(`reflective insight ${request.insightId} was not found`);
    }
    if (!sameScope(insight.scope, request.scope)) {
      throw new ValidationError("reflective insight scope does not match promotion scope");
    }
    if (insight.status === "rejected" || insight.status === "superseded") {
      throw new ValidationError(
        `reflective insight status=${insight.status} cannot be promoted`,
      );
    }
    if (!(await this.dependencies.approvalVerifier.verifyApproval({
      request,
      insight,
      promotionPolicyVersion: this.promotionPolicyVersion,
    }))) {
      throw new ValidationError("insight promotion approval could not be verified");
    }

    const support = await this.requireEvidenceClosure(insight);
    const acceptedAssessment = this.promotionGate.assess({
      ...insight,
      status: "accepted",
    });
    const unit = providerUnitFor(insight);
    const classification = this.semanticGovernance.classify(unit);
    unit.memoryType = classification.memoryType;
    unit.speakerProvenance = classification.speakerProvenance;
    unit.semanticKey = classification.semanticKey;

    const timestamp = this.clock.now();
    const baseRecord: InsightPromotionRecord = prior ?? {
      promotionId: promotionIdFor(request.scope, request.idempotencyKey),
      insightId: request.insightId,
      scope: request.scope,
      idempotencyKey: request.idempotencyKey,
      promotionPolicyVersion: this.promotionPolicyVersion,
      approvedBy: request.approvedBy,
      eligibility: acceptedAssessment,
      memoryType: classification.memoryType,
      semanticKey: classification.semanticKey,
      status: acceptedAssessment.eligible ? "approved" : "rejected",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (!acceptedAssessment.eligible) {
      await this.dependencies.promotionStore.put(baseRecord);
      throw new ValidationError(
        `insight is not promotion eligible: ${acceptedAssessment.reasonCodes.join(",")}`,
      );
    }

    const acceptedInsight: ReflectiveInsight = {
      ...insight,
      status: "accepted",
      promotionEligibility: acceptedAssessment,
      canonicalWritePerformed: false,
      updatedAt: timestamp,
    };
    await this.dependencies.insightStore.put(acceptedInsight);
    await this.dependencies.promotionStore.put(baseRecord);

    let candidateId = baseRecord.candidateId;
    if (candidateId === undefined) {
      const candidateInput = await this.candidateInput(
        acceptedInsight,
        unit,
        classification.semanticKey,
        support,
        request,
      );
      const candidate = await this.candidateService.ingest(candidateInput);
      candidateId = candidate.candidateId;
      await this.dependencies.promotionStore.put({
        ...baseRecord,
        candidateId,
        updatedAt: this.clock.now(),
      });
    }

    const committed = await this.authority.commit({
      candidateId,
      idempotencyKey: `insight-promotion:${baseRecord.promotionId}`,
    });
    const finalRecord: InsightPromotionRecord = {
      ...baseRecord,
      status: "committed",
      candidateId,
      canonicalMemoryId: committed.head.memoryId,
      updatedAt: this.clock.now(),
    };
    await this.dependencies.promotionStore.put(finalRecord);
    return {
      insight: acceptedInsight,
      record: finalRecord,
      canonicalMemoryId: committed.head.memoryId,
    };
  }

  private validateReplay(
    record: InsightPromotionRecord,
    request: InsightPromotionRequest,
  ): void {
    if (
      record.insightId !== request.insightId ||
      !sameScope(record.scope, request.scope) ||
      stableStringify(record.approvedBy) !== stableStringify(request.approvedBy) ||
      record.promotionPolicyVersion !== this.promotionPolicyVersion
    ) {
      throw new ValidationError(
        "insight promotion idempotency key was reused with different approval input",
      );
    }
  }

  private async committedResult(
    record: InsightPromotionRecord,
  ): Promise<InsightPromotionResult> {
    const insight = await this.dependencies.insightStore.get(record.insightId);
    if (insight === undefined || record.canonicalMemoryId === undefined) {
      throw new ValidationError(
        "committed insight promotion is missing its insight or canonical memory",
      );
    }
    const head = await this.dependencies.canonicalStore.getHead(
      record.canonicalMemoryId,
    );
    if (head === undefined || !sameScope(head.scope, record.scope)) {
      throw new ValidationError(
        "committed insight promotion points to a missing canonical head",
      );
    }
    return { insight, record, canonicalMemoryId: record.canonicalMemoryId };
  }

  private async requireEvidenceClosure(
    insight: ReflectiveInsight,
  ): Promise<MemoryRevision[]> {
    if (
      insight.supportingMemoryIds.length === 0 ||
      insight.supportingEvidenceIds.length === 0
    ) {
      return [];
    }
    const heads = await this.dependencies.canonicalStore.getHeads(
      insight.supportingMemoryIds,
    );
    const support: MemoryRevision[] = [];
    for (let index = 0; index < heads.length; index += 1) {
      const head = heads[index];
      const memoryId = insight.supportingMemoryIds[index];
      if (
        head === undefined ||
        memoryId === undefined ||
        head.status !== "active" ||
        !sameScope(head.scope, insight.scope)
      ) {
        throw new ValidationError(
          `supporting canonical memory ${memoryId ?? "unknown"} is not current and active in scope`,
        );
      }
      const revision = await this.dependencies.canonicalStore.getRevision(
        head.memoryId,
        head.currentRevision,
      );
      if (revision === undefined) {
        throw new ValidationError(
          `supporting canonical memory ${head.memoryId} has no current revision`,
        );
      }
      support.push(revision);
    }
    const evidence = new Set(
      support.flatMap((revision) => revision.evidenceRefs.map(evidenceId)),
    );
    const missing = insight.supportingEvidenceIds.filter((id) => !evidence.has(id));
    if (missing.length > 0) {
      throw new ValidationError(
        `supporting evidence closure is missing: ${missing.join(",")}`,
      );
    }
    return support;
  }

  private async candidateInput(
    insight: ReflectiveInsight,
    unit: ProviderMemoryUnit,
    semanticKey: string,
    support: MemoryRevision[],
    request: InsightPromotionRequest,
  ): Promise<CandidateInput> {
    const memoryType = unit.memoryType;
    if (memoryType === undefined) {
      throw new ValidationError("promoted insight must have a DLMF memory type");
    }
    const current =
      await this.dependencies.canonicalStore.findCurrentRevisionBySemanticKey(
        request.scope,
        semanticKey,
      );
    const sourceExperienceRefs: SourceExperienceRef[] = [
      { sourceType: "reflective_insight", sourceId: insight.insightId },
      ...support.map((revision) => ({
        sourceType: "canonical_memory",
        sourceId: `${revision.memoryId}@${revision.revision}`,
      })),
    ];
    const common = {
      scope: request.scope,
      origin: request.approvedBy,
      candidateType: "derived_insight_candidate",
      sourceType: "reflective_insight_promotion",
      sourceId: insight.insightId,
      memoryClass: "semantic_assertion" as const,
      memoryKind: "reflective_insight",
      memoryType,
      speakerProvenance: "unknown" as const,
      semanticKey,
      proposedContent: { text: insight.proposition },
      evidenceRefs: insight.supportingEvidenceIds.map(evidenceRef),
      epistemicStatus: insight.epistemicStatus,
      confidence: insight.confidence,
      producer: { kind: "runtime" as const, id: "dlmf-insight-promotion" },
      sourceExperienceRefs,
      distillationPolicyVersion: this.promotionPolicyVersion,
      providerRunId: insight.derivationRunId,
    };
    if (current === undefined) {
      return { ...common, proposedOperation: "create" };
    }
    const relation = this.semanticGovernance.relate(unit, current);
    if (relation === "contradicts" || relation === "unrelated") {
      throw new ValidationError(
        `accepted insight cannot auto-merge semantic relation=${relation}`,
      );
    }
    return {
      ...common,
      proposedContent: current.canonicalContent,
      proposedOperation: "merge",
      baseMemoryId: current.memoryId,
      baseRevision: current.revision,
    };
  }
}
