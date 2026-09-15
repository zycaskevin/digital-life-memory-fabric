import { isOneShotOperationalDirective } from "../semantic/memory-language-signals.js";
import type { ProviderMemoryUnit } from "../distillation/types.js";
import type {
  MemoryCurationProposal,
  MemoryCurationProvider,
  MemoryCurationRequest,
  MemoryCurationResult,
  MemoryDurability,
  ProviderMemoryUnitOutcome,
} from "./types.js";

function classifyDurability(unit: ProviderMemoryUnit): MemoryDurability {
  if (
    unit.memoryType === "transient_state" ||
    isOneShotOperationalDirective(unit.proposedContent.text)
  ) {
    return "transient";
  }
  const candidateType = unit.candidateType;
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
    return "supporting_evidence_only";
  }
  if (
    durability === "transient" ||
    durability === "session_scoped" ||
    durability === "time_bounded"
  ) {
    return "supporting_evidence_only";
  }
  if (durability === "unknown") return "supporting_evidence_only";
  return "canonical_candidate";
}

/**
 * Deliberately conservative baseline curator. Derived/uncertain units and
 * unknown-durability facts terminate as supporting evidence instead of creating
 * an unbounded human-review queue. Genuine admission ambiguity (for example a
 * merge, rewrite, or ungrounded epistemic upgrade) is still escalated by the
 * deterministic DLMF admission policy. This provider can be replaced; DLMF
 * deterministic admission still owns the final outcome.
 */
export class ConservativeMemoryCurationProvider implements MemoryCurationProvider {
  readonly name = "dlmf-conservative-curation";

  constructor(readonly version = "md010-conservative-v3-lifetime-governance") {}

  async curate(request: MemoryCurationRequest): Promise<MemoryCurationResult> {
    const proposals: MemoryCurationProposal[] = request.units.map((unit) => {
      const operationalDirective = isOneShotOperationalDirective(unit.proposedContent.text);
      const durability = classifyDurability(unit);
      const outcome = classifyOutcome(unit.epistemicStatus, durability);
      return {
        providerUnitRef: unit.providerUnitRef,
        outcome,
        epistemicAttribution: {
          status: unit.epistemicStatus,
          basis: unit.epistemicAttributionBasis ?? "provider_declared",
        },
        memoryWorthy: outcome === "canonical_candidate" || outcome === "pending_review",
        durability,
        semanticDisposition: "novel",
        reasonCodes: [
          `baseline_epistemic:${unit.epistemicStatus}`,
          `baseline_durability:${durability}`,
          ...(operationalDirective
            ? ["curation:lifetime:operational_directive_ephemeral"]
            : []),
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
