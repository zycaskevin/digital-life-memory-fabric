import type {
  MemoryId,
  MemoryScope,
  MemoryType,
  SemanticRelation,
  SpeakerProvenance,
} from "../domain/types.js";
import { ValidationError } from "../domain/errors.js";
import { sameScope, sha256, stableStringify } from "../domain/utils.js";
import type { ProviderMemoryUnit } from "../distillation/types.js";

export interface SemanticReviewCandidateFingerprintInput {
  scope: MemoryScope;
  sourceType: string;
  sourceId: string;
  providerUnitRef: string;
  providerUnitText: string;
  semanticKey: string;
  semanticPolicyVersion: string;
  memoryType: MemoryType;
  speakerProvenance: SpeakerProvenance;
  semanticRelation: SemanticRelation;
  targetMemoryId?: MemoryId;
}

export interface SemanticReviewRemediationMatch {
  scope: MemoryScope;
  sourceType: string;
  sourceId: string;
  providerUnitRef: string;
  reviewedCandidateFingerprint: string;
  semanticKey: string;
  semanticPolicyVersion: string;
  memoryType: MemoryType;
  speakerProvenance: SpeakerProvenance;
  semanticRelation: SemanticRelation;
  targetMemoryId?: MemoryId;
}

export interface InvalidCandidateSemanticReviewBinding
  extends SemanticReviewRemediationMatch {
  reviewCaseId: string;
  reviewDecisionId: string;
  sourceCurationRecordId: string;
  reviewCaseVersion: number;
  disposition: "invalid_candidate";
}

export interface SemanticReviewRemediationPolicy {
  readonly identity: string;
  resolveInvalidCandidate(
    input: SemanticReviewRemediationMatch,
  ): Promise<InvalidCandidateSemanticReviewBinding | undefined>;
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new ValidationError(`${field} must not be empty`);
}

function bindingMatchKey(binding: SemanticReviewRemediationMatch): string {
  return stableStringify({
    scope: binding.scope,
    sourceType: binding.sourceType,
    sourceId: binding.sourceId,
    providerUnitRef: binding.providerUnitRef,
    reviewedCandidateFingerprint: binding.reviewedCandidateFingerprint,
    semanticKey: binding.semanticKey,
    semanticPolicyVersion: binding.semanticPolicyVersion,
    memoryType: binding.memoryType,
    speakerProvenance: binding.speakerProvenance,
    semanticRelation: binding.semanticRelation,
    targetMemoryId: binding.targetMemoryId ?? null,
  });
}

function validateBinding(binding: InvalidCandidateSemanticReviewBinding, index: number): void {
  requireText(binding.scope.tenantId, `bindings[${index}].scope.tenantId`);
  requireText(binding.scope.lifeDid, `bindings[${index}].scope.lifeDid`);
  requireText(binding.scope.memoryNamespace, `bindings[${index}].scope.memoryNamespace`);
  requireText(binding.sourceType, `bindings[${index}].sourceType`);
  requireText(binding.sourceId, `bindings[${index}].sourceId`);
  requireText(binding.providerUnitRef, `bindings[${index}].providerUnitRef`);
  requireText(
    binding.reviewedCandidateFingerprint,
    `bindings[${index}].reviewedCandidateFingerprint`,
  );
  requireText(binding.semanticKey, `bindings[${index}].semanticKey`);
  requireText(binding.semanticPolicyVersion, `bindings[${index}].semanticPolicyVersion`);
  requireText(binding.reviewCaseId, `bindings[${index}].reviewCaseId`);
  requireText(binding.reviewDecisionId, `bindings[${index}].reviewDecisionId`);
  requireText(binding.sourceCurationRecordId, `bindings[${index}].sourceCurationRecordId`);
  if (!Number.isInteger(binding.reviewCaseVersion) || binding.reviewCaseVersion < 2) {
    throw new ValidationError(`bindings[${index}].reviewCaseVersion must be at least 2`);
  }
  if (binding.disposition !== "invalid_candidate") {
    throw new ValidationError(`bindings[${index}] must be an invalid_candidate decision`);
  }
}

export function semanticReviewCandidateFingerprint(
  input: SemanticReviewCandidateFingerprintInput,
): string {
  return sha256({
    scope: input.scope,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    providerUnitRef: input.providerUnitRef,
    providerUnitText: input.providerUnitText,
    semanticKey: input.semanticKey,
    semanticPolicyVersion: input.semanticPolicyVersion,
    memoryType: input.memoryType,
    speakerProvenance: input.speakerProvenance,
    semanticRelation: input.semanticRelation,
    targetMemoryId: input.targetMemoryId ?? null,
  });
}

export function semanticReviewProviderUnitFingerprint(unit: ProviderMemoryUnit): string {
  return sha256({
    providerUnitRef: unit.providerUnitRef,
    candidateType: unit.candidateType,
    memoryClass: unit.memoryClass,
    memoryKind: unit.memoryKind,
    memoryType: unit.memoryType ?? null,
    speakerProvenance: unit.speakerProvenance ?? null,
    semanticKey: unit.semanticKey ?? null,
    proposedContent: unit.proposedContent,
    providerDeclaredEpistemicStatus: unit.providerDeclaredEpistemicStatus ?? null,
    attributedEpistemicStatus: unit.epistemicStatus,
    epistemicAttributionBasis: unit.epistemicAttributionBasis ?? null,
    evidenceRefs: unit.evidenceRefs,
  });
}

/**
 * Content-free, exact-match admission remediation.
 *
 * A human review decision may reject one previously pending provider unit, but
 * it cannot broaden a semantic family, alter Canonical Memory, or authorize a
 * different source/unit/target. Any identity drift produces no match and the
 * normal fail-closed pending_review path remains in force.
 */
export class ExactInvalidCandidateSemanticReviewRemediation
  implements SemanticReviewRemediationPolicy
{
  readonly identity: string;
  private readonly bindings: ReadonlyMap<string, InvalidCandidateSemanticReviewBinding>;

  constructor(bindings: readonly InvalidCandidateSemanticReviewBinding[]) {
    if (bindings.length === 0) {
      throw new ValidationError("semantic review remediation requires at least one binding");
    }
    const indexed = new Map<string, InvalidCandidateSemanticReviewBinding>();
    for (const [index, binding] of bindings.entries()) {
      validateBinding(binding, index);
      const key = bindingMatchKey(binding);
      if (indexed.has(key)) {
        throw new ValidationError("semantic review remediation contains a duplicate binding");
      }
      indexed.set(key, structuredClone(binding));
    }
    this.bindings = indexed;
    this.identity = sha256({
      contract: "dlmf/semantic-review-invalid-candidate-remediation/v2",
      bindings: [...indexed.values()]
        .map((binding) => structuredClone(binding))
        .sort((left, right) => bindingMatchKey(left).localeCompare(bindingMatchKey(right))),
    });
  }

  async resolveInvalidCandidate(
    input: SemanticReviewRemediationMatch,
  ): Promise<InvalidCandidateSemanticReviewBinding | undefined> {
    const match = this.bindings.get(bindingMatchKey(input));
    if (match === undefined || !sameScope(match.scope, input.scope)) return undefined;
    return structuredClone(match);
  }
}
