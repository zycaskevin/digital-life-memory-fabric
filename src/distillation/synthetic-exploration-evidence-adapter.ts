import { createHash } from "node:crypto";
import { ValidationError } from "../domain/errors.js";
import type { MemoryDistillationProvider } from "./memory-distillation-provider.js";
import type {
  DistillationRequest,
  DistillationResult,
  MemoryEvidence,
  RecallRequest,
  ReflectRequest,
  ReflectResult,
} from "./types.js";

/**
 * Bounded extraction adapter for Agent-Factory autonomous exploration evidence.
 *
 * This adapter does not decide canonical memory-worthiness. It emits exactly one
 * synthesized semantic evidence unit. Existing DLMF curation/admission/governance
 * then classify synthesized evidence as supporting evidence only, so one
 * autonomous exploration cannot directly create canonical autobiographical memory.
 */
export class SyntheticExplorationEvidenceAdapter implements MemoryDistillationProvider {
  readonly name = "synthetic-exploration-evidence";
  readonly adapterVersion: string;
  readonly providerVersion: string | undefined;

  constructor(options: { adapterVersion?: string; providerVersion?: string } = {}) {
    this.adapterVersion = options.adapterVersion ?? "synthetic-exploration-v1";
    this.providerVersion = options.providerVersion ?? "1";
    if (!this.adapterVersion.trim()) throw new ValidationError("synthetic exploration adapterVersion must not be empty");
  }

  async distill(request: DistillationRequest): Promise<DistillationResult> {
    const experience = request.experience;
    if (experience.sourceType !== "autonomous_exploration") {
      throw new ValidationError("synthetic exploration adapter accepts autonomous_exploration only");
    }
    if (experience.metadata?.origin !== "SYNTHETIC") {
      throw new ValidationError("synthetic exploration adapter requires SYNTHETIC provenance");
    }
    const text = experience.content.trim();
    if (!text) throw new ValidationError("synthetic exploration evidence content must not be empty");
    if (!experience.archiveRef.trim() || !experience.checksum.trim()) {
      throw new ValidationError("synthetic exploration evidence requires archived source grounding");
    }

    const fingerprint = createHash("sha256")
      .update(`${experience.scope.lifeDid}\u0000${experience.sourceId}\u0000${experience.checksum}`, "utf8")
      .digest("hex");
    const providerUnitRef = `synthetic_exploration_${fingerprint}`;
    const sourceExperienceRefs = [{
      sourceType: experience.sourceType,
      sourceId: experience.sourceId,
      archiveRef: experience.archiveRef,
      checksum: experience.checksum,
    }];

    return {
      providerName: this.name,
      providerRunId: `synthetic_exploration_run_${fingerprint}`,
      adapterVersion: this.adapterVersion,
      ...(this.providerVersion === undefined ? {} : { providerVersion: this.providerVersion }),
      providerUnits: [{
        providerUnitRef,
        candidateType: "fact_candidate",
        memoryClass: "semantic_assertion",
        memoryKind: "autonomous_exploration_synthesis",
        proposedContent: { text },
        evidenceRefs: [
          { sourceType: experience.sourceType, sourceRef: experience.sourceId },
          { sourceType: "archive", sourceRef: experience.archiveRef },
        ],
        epistemicStatus: "synthesized",
        speakerProvenance: "system",
        producer: {
          kind: "provider",
          id: this.name,
          providerName: this.name,
          adapterVersion: this.adapterVersion,
          ...(this.providerVersion === undefined ? {} : { providerVersion: this.providerVersion }),
        },
        sourceExperienceRefs,
        ...(experience.observedAt === undefined ? {} : { observedAt: experience.observedAt }),
      }],
      warnings: ["autonomous_exploration_synthetic_evidence_not_direct_canonical_memory"],
    };
  }

  async recall(_request: RecallRequest): Promise<MemoryEvidence[]> {
    return [];
  }

  async reflect(_request: ReflectRequest): Promise<ReflectResult> {
    return {
      providerName: this.name,
      providerRunId: "synthetic_exploration_reflect_unused",
      adapterVersion: this.adapterVersion,
      ...(this.providerVersion === undefined ? {} : { providerVersion: this.providerVersion }),
      candidates: [],
      warnings: ["synthetic_exploration_adapter_reflection_not_used"],
    };
  }
}
