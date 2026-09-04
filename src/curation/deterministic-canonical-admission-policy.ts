import { ValidationError } from "../domain/errors.js";
import type { EpistemicStatus } from "../domain/types.js";
import { stableStringify } from "../domain/utils.js";
import type {
  CanonicalAdmissionDecision,
  CanonicalAdmissionInput,
  CanonicalAdmissionPolicy,
  CuratedCandidateDraft,
  EpistemicAttribution,
} from "./types.js";

const directStatuses = new Set<EpistemicStatus>([
  "observed",
  "user_asserted",
  "system_observed",
]);

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quoteGrounded(rawContent: string, quote: string | undefined): boolean {
  if (quote === undefined || normalized(quote).length < 4) return false;
  return normalized(rawContent).includes(normalized(quote));
}

function attributionValid(
  providerStatus: EpistemicStatus,
  attribution: EpistemicAttribution,
  rawContent: string,
): boolean {
  switch (attribution.basis) {
    case "provider_declared":
      return attribution.status === providerStatus;
    case "direct_source_quote":
      return (
        providerStatus === "user_asserted" &&
        attribution.status === "user_asserted" &&
        quoteGrounded(rawContent, attribution.evidenceQuote)
      );
    case "system_record":
      return attribution.status === "system_observed" && providerStatus === "system_observed";
    case "derived":
      return (
        attribution.status === "inferred" ||
        attribution.status === "synthesized" ||
        attribution.status === "uncertain"
      );
    case "unknown":
      return attribution.status === "uncertain";
    default:
      return false;
  }
}

function defaultCandidate(input: CanonicalAdmissionInput): CuratedCandidateDraft {
  return {
    candidateType: input.unit.candidateType,
    memoryClass: input.unit.memoryClass,
    memoryKind: input.unit.memoryKind,
    proposedContent: input.unit.proposedContent,
    ...(input.unit.observedAt === undefined ? {} : { observedAt: input.unit.observedAt }),
    ...(input.unit.validFrom === undefined ? {} : { validFrom: input.unit.validFrom }),
    ...(input.unit.validUntil === undefined ? {} : { validUntil: input.unit.validUntil }),
  };
}

export class DeterministicCanonicalAdmissionPolicy implements CanonicalAdmissionPolicy {
  constructor(readonly policyVersion: string) {
    if (policyVersion.trim().length === 0) {
      throw new ValidationError("admission policyVersion must not be empty");
    }
  }

  evaluate(input: CanonicalAdmissionInput): CanonicalAdmissionDecision {
    const { unit, proposal } = input;
    if (proposal.providerUnitRef !== unit.providerUnitRef) {
      throw new ValidationError("curation proposal providerUnitRef does not match provider unit");
    }
    if (proposal.reasonCodes.length === 0) {
      throw new ValidationError(`curation proposal ${unit.providerUnitRef} must include reasonCodes`);
    }

    const reasons = [...proposal.reasonCodes];
    const attributed = proposal.epistemicAttribution.status;
    if (!attributionValid(unit.epistemicStatus, proposal.epistemicAttribution, input.rawContent)) {
      return {
        outcome: "pending_review",
        epistemicStatus: "uncertain",
        durability: proposal.durability,
        memoryWorthy: proposal.memoryWorthy,
        semanticDisposition: proposal.semanticDisposition,
        reasonCodes: [...reasons, "admission:epistemic_attribution_not_grounded"],
      };
    }

    if (proposal.semanticDisposition === "merge_required") {
      return {
        outcome: "pending_review",
        epistemicStatus: attributed,
        durability: proposal.durability,
        memoryWorthy: proposal.memoryWorthy,
        semanticDisposition: proposal.semanticDisposition,
        reasonCodes: [...reasons, "admission:semantic_merge_requires_review"],
        ...(proposal.targetMemoryId === undefined ? {} : { targetMemoryId: proposal.targetMemoryId }),
      };
    }

    if (proposal.semanticDisposition === "duplicate") {
      return {
        outcome: "supporting_evidence_only",
        epistemicStatus: attributed,
        durability: proposal.durability,
        memoryWorthy: proposal.memoryWorthy,
        semanticDisposition: proposal.semanticDisposition,
        reasonCodes: [...reasons, "admission:provider_marked_duplicate"],
        ...(proposal.targetMemoryId === undefined ? {} : { targetMemoryId: proposal.targetMemoryId }),
      };
    }

    if (proposal.outcome !== "canonical_candidate") {
      return {
        outcome: proposal.outcome,
        epistemicStatus: attributed,
        durability: proposal.durability,
        memoryWorthy: proposal.memoryWorthy,
        semanticDisposition: proposal.semanticDisposition,
        reasonCodes: reasons,
        ...(proposal.targetMemoryId === undefined ? {} : { targetMemoryId: proposal.targetMemoryId }),
      };
    }

    if (!proposal.memoryWorthy) {
      return {
        outcome: "rejected",
        epistemicStatus: attributed,
        durability: proposal.durability,
        memoryWorthy: false,
        semanticDisposition: proposal.semanticDisposition,
        reasonCodes: [...reasons, "admission:not_memory_worthy"],
      };
    }

    if (proposal.durability !== "durable" && proposal.durability !== "identity_long_term") {
      return {
        outcome: proposal.durability === "unknown" ? "pending_review" : "supporting_evidence_only",
        epistemicStatus: attributed,
        durability: proposal.durability,
        memoryWorthy: proposal.memoryWorthy,
        semanticDisposition: proposal.semanticDisposition,
        reasonCodes: [...reasons, "admission:durability_not_canonical"],
      };
    }

    if (!directStatuses.has(attributed)) {
      return {
        outcome: "pending_review",
        epistemicStatus: attributed,
        durability: proposal.durability,
        memoryWorthy: proposal.memoryWorthy,
        semanticDisposition: proposal.semanticDisposition,
        reasonCodes: [...reasons, "admission:derived_epistemic_requires_review"],
      };
    }

    const baselineCandidate = defaultCandidate(input);
    if (
      proposal.curatedCandidate !== undefined &&
      stableStringify(proposal.curatedCandidate) !== stableStringify(baselineCandidate)
    ) {
      return {
        outcome: "pending_review",
        epistemicStatus: attributed,
        durability: proposal.durability,
        memoryWorthy: proposal.memoryWorthy,
        semanticDisposition: proposal.semanticDisposition,
        reasonCodes: [...reasons, "admission:curated_rewrite_requires_review"],
      };
    }
    const candidateDraft = baselineCandidate;
    if (candidateDraft.memoryKind.trim().length === 0) {
      throw new ValidationError(`curated candidate ${unit.providerUnitRef} memoryKind must not be empty`);
    }
    if (candidateDraft.proposedContent.text.trim().length === 0) {
      throw new ValidationError(`curated candidate ${unit.providerUnitRef} text must not be empty`);
    }

    return {
      outcome: "canonical_candidate",
      epistemicStatus: attributed,
      durability: proposal.durability,
      memoryWorthy: true,
      semanticDisposition: proposal.semanticDisposition,
      reasonCodes: [...reasons, "admission:canonical_candidate_allowed"],
      candidateDraft,
    };
  }
}
