import { MemoryCandidateService, candidateSemanticFingerprint } from "../candidates/memory-candidate-service.js";
import { ValidationError } from "../domain/errors.js";
import type { CandidateInput, MemoryCandidate } from "../domain/types.js";
import { SystemClock, type Clock } from "../domain/utils.js";
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
  private readonly candidateService: MemoryCandidateService;
  private readonly clock: Clock;

  constructor(
    private readonly canonicalStore: CanonicalMemoryStore,
    private readonly provider: MemoryDistillationProvider,
    candidateService?: MemoryCandidateService,
    clock: Clock = new SystemClock(),
  ) {
    this.candidateService = candidateService ?? new MemoryCandidateService(canonicalStore);
    this.clock = clock;
  }

  async reflect(input: ReflectiveDistillationInput): Promise<MemoryCandidate[]> {
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

    const candidates: MemoryCandidate[] = [];
    for (const draft of result.candidates) {
      const candidateInput: CandidateInput = {
        scope: input.scope,
        origin: input.origin,
        candidateType: draft.candidateType,
        sourceType: "reflection",
        sourceId: result.providerRunId,
        memoryClass: draft.memoryClass,
        memoryKind: draft.memoryKind,
        proposedContent: draft.proposedContent,
        evidenceRefs: draft.evidenceRefs,
        epistemicStatus: draft.epistemicStatus,
        ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
        producer: draft.producer,
        sourceExperienceRefs: draft.sourceExperienceRefs,
        distillationPolicyVersion: input.distillationPolicyVersion,
        providerRunId: result.providerRunId,
        proposedOperation: "create",
      };
      const fingerprint = candidateSemanticFingerprint(candidateInput, draft.epistemicStatus);
      candidateInput.candidateFingerprint = fingerprint;
      const current = await this.canonicalStore.findCurrentRevisionBySemanticFingerprint(
        input.scope,
        fingerprint,
      );
      // A canonical duplicate or governed tombstone blocks provider re-animation.
      if (current !== undefined) continue;
      const candidate = await this.candidateService.ingest(candidateInput);
      candidates.push(candidate);
    }
    return candidates;
  }
}
