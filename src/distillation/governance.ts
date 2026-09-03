import type { MemoryCandidate } from "../domain/types.js";

export type GovernanceDecision =
  | { action: "commit"; reason: string }
  | { action: "reject"; reason: string };

export interface MemoryCandidateGovernance {
  readonly policyVersion: string;
  evaluate(candidate: MemoryCandidate): Promise<GovernanceDecision>;
}

export class EvidenceBoundMemoryGovernance implements MemoryCandidateGovernance {
  constructor(readonly policyVersion: string) {}

  async evaluate(candidate: MemoryCandidate): Promise<GovernanceDecision> {
    if (candidate.evidenceRefs.length === 0 || candidate.sourceExperienceRefs.length === 0) {
      return { action: "reject", reason: "missing_grounding" };
    }
    if (candidate.epistemicStatus === "inferred") {
      return { action: "reject", reason: "inferred_requires_explicit_review" };
    }
    if (candidate.epistemicStatus === "uncertain") {
      return { action: "reject", reason: "uncertain_requires_explicit_review" };
    }
    return { action: "commit", reason: "evidence_bound_candidate" };
  }
}
