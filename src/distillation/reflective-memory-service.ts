import { randomUUID } from "node:crypto";
import { ValidationError } from "../domain/errors.js";
import type { MemoryId } from "../domain/types.js";
import { SystemClock, type Clock } from "../domain/utils.js";
import { InMemoryReflectiveInsightStore } from "../insights/in-memory-reflective-insight-store.js";
import { ReflectiveInsightPromotionGate } from "../insights/reflective-insight-promotion-gate.js";
import type { ReflectiveInsightStore } from "../insights/reflective-insight-store.js";
import type { ReflectiveInsight } from "../insights/types.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";
import type { MemoryDistillationProvider } from "./memory-distillation-provider.js";
import type { ReflectResult, ReflectiveDistillationInput } from "./types.js";

function validateReflectResult(result: ReflectResult, provider: MemoryDistillationProvider): void {
  if (result.providerName !== provider.name || result.adapterVersion !== provider.adapterVersion) {
    throw new ValidationError("reflect provider identity/version mismatch");
  }
  if (result.providerRunId.trim().length === 0) {
    throw new ValidationError("reflect providerRunId must not be empty");
  }
  for (const [index, candidate] of result.candidates.entries()) {
    if (candidate.candidateType !== "derived_insight_candidate") {
      throw new ValidationError(`reflect candidate[${index}] must be derived_insight_candidate`);
    }
    if (candidate.proposedContent.text.trim().length === 0) {
      throw new ValidationError(`reflect candidate[${index}] proposition must not be empty`);
    }
    if (
      candidate.confidence !== undefined &&
      (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1)
    ) {
      throw new ValidationError(`reflect candidate[${index}] confidence must be between 0 and 1`);
    }
    if (candidate.derivationModel !== undefined && candidate.derivationModel.trim().length === 0) {
      throw new ValidationError(`reflect candidate[${index}] derivationModel must not be empty`);
    }
    const epistemicStatus: string = candidate.epistemicStatus;
    if (
      epistemicStatus === "observed" ||
      epistemicStatus === "user_asserted" ||
      epistemicStatus === "system_observed"
    ) {
      throw new ValidationError(`reflect candidate[${index}] cannot claim observed epistemic status`);
    }
    if (candidate.evidenceRefs.length === 0) {
      throw new ValidationError(`reflect candidate[${index}] must be evidence-grounded`);
    }
    if (candidate.sourceExperienceRefs.length === 0) {
      throw new ValidationError(`reflect candidate[${index}] must retain source experience provenance`);
    }
  }
}

export class ReflectiveMemoryService {
  private readonly clock: Clock;

  constructor(
    _canonicalStore: CanonicalMemoryStore,
    private readonly provider: MemoryDistillationProvider,
    private readonly insightStore: ReflectiveInsightStore = new InMemoryReflectiveInsightStore(),
    private readonly promotionGate = new ReflectiveInsightPromotionGate(),
    clock: Clock = new SystemClock(),
  ) {
    this.clock = clock;
  }

  async reflect(input: ReflectiveDistillationInput): Promise<ReflectiveInsight[]> {
    const result = await this.provider.reflect({
      scope: input.scope,
      context: input.context,
      evidence: input.evidence,
      canonicalMemories: input.canonicalMemories.map((revision) => ({
        memoryId: revision.memoryId,
        revision: revision.revision,
        text: revision.canonicalContent.text,
        epistemicStatus: revision.epistemicStatus,
        evidenceRefs: revision.evidenceRefs,
        sourceExperienceRefs: revision.sourceExperienceRefs,
      })),
      distillationPolicyVersion: input.distillationPolicyVersion,
      requestedAt: this.clock.now(),
    });
    validateReflectResult(result, this.provider);

    const knownMemoryIds = new Set(input.canonicalMemories.map((memory) => memory.memoryId));
    const knownEvidenceIds = new Set([
      ...input.evidence.map(
        (evidence) => `${evidence.evidenceRef.sourceType}:${evidence.evidenceRef.sourceRef}`,
      ),
      ...input.canonicalMemories.flatMap((memory) =>
        memory.evidenceRefs.map((evidence) => `${evidence.sourceType}:${evidence.sourceRef}`),
      ),
    ]);
    const insights: ReflectiveInsight[] = [];
    for (const draft of result.candidates) {
      const supportingMemoryIds = [...new Set(draft.supportingMemoryIds ?? [])]
        .filter((memoryId): memoryId is MemoryId => knownMemoryIds.has(memoryId));
      const supportingEvidenceIds = [...new Set(draft.supportingEvidenceIds ?? [])]
        .filter((evidenceId) => knownEvidenceIds.has(evidenceId));
      const contradictingMemoryIds = [...new Set(draft.contradictingMemoryIds ?? [])]
        .filter((memoryId): memoryId is MemoryId => knownMemoryIds.has(memoryId));
      const confidence = draft.confidence ?? 0;
      const status = "pending" as const;
      const promotionEligibility = this.promotionGate.assess({
        supportingMemoryIds,
        supportingEvidenceIds,
        contradictingMemoryIds,
        confidence,
        status,
      });
      const timestamp = this.clock.now();
      const insight: ReflectiveInsight = {
        insightId: `insight_${randomUUID().replaceAll("-", "")}`,
        scope: input.scope,
        proposition: draft.proposedContent.text,
        epistemicStatus: draft.epistemicStatus,
        supportingMemoryIds,
        supportingEvidenceIds,
        contradictingMemoryIds,
        confidence,
        derivationProvider: result.providerName,
        derivationModel: draft.derivationModel ?? result.providerVersion ?? result.adapterVersion,
        derivationRunId: result.providerRunId,
        status,
        promotionEligibility,
        canonicalWritePerformed: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.insightStore.put(insight);
      insights.push(insight);
    }
    return insights;
  }
}
