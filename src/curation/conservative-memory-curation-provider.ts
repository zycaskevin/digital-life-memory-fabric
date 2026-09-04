import type {
  MemoryCurationProposal,
  MemoryCurationProvider,
  MemoryCurationRequest,
  MemoryCurationResult,
  MemoryDurability,
  ProviderMemoryUnitOutcome,
} from "./types.js";

function classifyDurability(candidateType: string): MemoryDurability {
  switch (candidateType) {
    case "preference_candidate":
    case "relationship_candidate":
    case "habit_candidate":
      return "durable";
    case "commitment_candidate":
    case "project_state_candidate":
      return "time_bounded";
    case "event_candidate":
      return "transient";
    case "fact_candidate":
    default:
      return "unknown";
  }
}

function classifyOutcome(
  epistemicStatus: string,
  durability: MemoryDurability,
): ProviderMemoryUnitOutcome {
  if (
    epistemicStatus === "inferred" ||
    epistemicStatus === "synthesized" ||
    epistemicStatus === "uncertain"
  ) {
    return "pending_review";
  }
  if (
    durability === "transient" ||
    durability === "session_scoped" ||
    durability === "time_bounded"
  ) {
    return "supporting_evidence_only";
  }
  if (durability === "unknown") return "pending_review";
  return "canonical_candidate";
}

/**
 * Deliberately conservative baseline curator. Generic facts and all derived /
 * uncertain units fail closed to review. This provider can be replaced; DLMF
 * deterministic admission still owns the final outcome.
 */
export class ConservativeMemoryCurationProvider implements MemoryCurationProvider {
  readonly name = "dlmf-conservative-curation";

  constructor(readonly version = "md010-conservative-v1") {}

  async curate(request: MemoryCurationRequest): Promise<MemoryCurationResult> {
    const proposals: MemoryCurationProposal[] = request.units.map((unit) => {
      const durability = classifyDurability(unit.candidateType);
      const outcome = classifyOutcome(unit.epistemicStatus, durability);
      return {
        providerUnitRef: unit.providerUnitRef,
        outcome,
        epistemicAttribution: {
          status: unit.epistemicStatus,
          basis: "provider_declared",
        },
        memoryWorthy:
          outcome === "canonical_candidate" || outcome === "pending_review",
        durability,
        semanticDisposition: "novel",
        reasonCodes: [
          `baseline_epistemic:${unit.epistemicStatus}`,
          `baseline_durability:${durability}`,
          `baseline_outcome:${outcome}`,
        ],
      };
    });
    return {
      providerName: this.name,
      providerVersion: this.version,
      proposals,
      warnings: [],
    };
  }
}
