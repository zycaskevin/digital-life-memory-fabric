import { CanonicalMemoryAuthority } from "../authority/canonical-memory-authority.js";
import {
  MemoryCandidateService,
  candidateSemanticFingerprint,
} from "../candidates/memory-candidate-service.js";
import type {
  CanonicalAdmissionDecision,
  MemoryCurationProposal,
  MemoryCurationProvider,
  MemoryCurationRecord,
} from "../curation/types.js";
import { emptyCurationOutcomeCounts } from "../curation/types.js";
import type { CanonicalAdmissionPolicy } from "../curation/types.js";
import type { MemoryCurationRecordStore } from "../curation/memory-curation-record-store.js";
import { ValidationError } from "../domain/errors.js";
import type { CandidateInput, MemoryId } from "../domain/types.js";
import { SystemClock, sameScope, sha256, type Clock } from "../domain/utils.js";
import type { RawExperienceArchiveProvider } from "../archive/raw-experience-archive.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";
import type { DistillationReceiptStore } from "./distillation-receipt-store.js";
import type { MemoryCandidateGovernance } from "./governance.js";
import type { MemoryDistillationProvider } from "./memory-distillation-provider.js";
import type {
  DistillationReceipt,
  DistillationReceiptId,
  DistillationResult,
  MemoryCandidateType,
  ProviderMemoryUnit,
  TranscriptDistillationInput,
} from "./types.js";

const candidateTypes = new Set<MemoryCandidateType>([
  "fact_candidate",
  "event_candidate",
  "preference_candidate",
  "relationship_candidate",
  "project_state_candidate",
  "commitment_candidate",
  "habit_candidate",
  "derived_insight_candidate",
]);

export interface DistillationReceiptIdFactory {
  forIdempotencyKey(idempotencyKey: string): DistillationReceiptId;
}

export class DeterministicDistillationReceiptIdFactory
  implements DistillationReceiptIdFactory
{
  forIdempotencyKey(idempotencyKey: string): DistillationReceiptId {
    const digest = idempotencyKey.startsWith("sha256:")
      ? idempotencyKey.slice("sha256:".length)
      : sha256({ idempotencyKey }).slice("sha256:".length);
    return `dist_${digest}`;
  }
}

export interface TranscriptDistillationServiceOptions {
  canonicalStore: CanonicalMemoryStore;
  receiptStore: DistillationReceiptStore;
  archive: RawExperienceArchiveProvider;
  provider: MemoryDistillationProvider;
  curationProvider: MemoryCurationProvider;
  curationStore: MemoryCurationRecordStore;
  admissionPolicy: CanonicalAdmissionPolicy;
  governance: MemoryCandidateGovernance;
  candidateService?: MemoryCandidateService;
  canonicalAuthority?: CanonicalMemoryAuthority;
  clock?: Clock;
  receiptIds?: DistillationReceiptIdFactory;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new ValidationError(`${field} must not be empty`);
}

function validateInput(input: TranscriptDistillationInput): void {
  requireNonEmpty(input.scope.tenantId, "scope.tenantId");
  requireNonEmpty(input.scope.lifeDid, "scope.lifeDid");
  requireNonEmpty(input.scope.memoryNamespace, "scope.memoryNamespace");
  requireNonEmpty(input.origin.lifeDid, "origin.lifeDid");
  requireNonEmpty(input.sourceType, "sourceType");
  requireNonEmpty(input.sourceId, "sourceId");
  requireNonEmpty(input.content, "content");
  requireNonEmpty(input.contentType, "contentType");
  requireNonEmpty(input.distillationPolicyVersion, "distillationPolicyVersion");
  requireNonEmpty(input.canonicalizationPolicyVersion, "canonicalizationPolicyVersion");
  requireNonEmpty(input.retentionPolicyVersion, "retentionPolicyVersion");
  requireNonEmpty(input.admissionPolicyVersion, "admissionPolicyVersion");
  if (input.origin.lifeDid !== input.scope.lifeDid) {
    throw new ValidationError("origin.lifeDid must match scope.lifeDid");
  }
}

function validateProviderUnit(unit: ProviderMemoryUnit, index: number): void {
  requireNonEmpty(unit.providerUnitRef, `providerUnit[${index}].providerUnitRef`);
  if (!candidateTypes.has(unit.candidateType)) {
    throw new ValidationError(`providerUnit[${index}] has unsupported candidateType`);
  }
  if (unit.candidateType === "derived_insight_candidate") {
    throw new ValidationError("distill() must not return derived_insight_candidate; use reflect()");
  }
  requireNonEmpty(unit.memoryKind, `providerUnit[${index}].memoryKind`);
  requireNonEmpty(unit.proposedContent.text, `providerUnit[${index}].proposedContent.text`);
  if (unit.evidenceRefs.length === 0) {
    throw new ValidationError(`providerUnit[${index}] must include evidenceRefs`);
  }
  if (unit.sourceExperienceRefs.length === 0) {
    throw new ValidationError(`providerUnit[${index}] must include sourceExperienceRefs`);
  }
  if (unit.producer.kind !== "provider") {
    throw new ValidationError(`providerUnit[${index}].producer must identify a provider`);
  }
}

function validateProviderResult(
  result: DistillationResult,
  provider: MemoryDistillationProvider,
): void {
  if (result.providerName !== provider.name) {
    throw new ValidationError("provider result name does not match configured provider");
  }
  if (result.adapterVersion !== provider.adapterVersion) {
    throw new ValidationError("provider result adapterVersion does not match configured adapter");
  }
  requireNonEmpty(result.providerRunId, "providerRunId");
  const refs = new Set<string>();
  for (const [index, unit] of result.providerUnits.entries()) {
    validateProviderUnit(unit, index);
    if (refs.has(unit.providerUnitRef)) {
      throw new ValidationError(`duplicate providerUnitRef ${unit.providerUnitRef}`);
    }
    refs.add(unit.providerUnitRef);
  }
}

function proposalsByUnit(
  result: Awaited<ReturnType<MemoryCurationProvider["curate"]>>,
  provider: MemoryCurationProvider,
  units: readonly ProviderMemoryUnit[],
): Map<string, MemoryCurationProposal> {
  if (result.providerName !== provider.name) {
    throw new ValidationError("curation result providerName does not match configured provider");
  }
  if (provider.version !== undefined && result.providerVersion !== provider.version) {
    throw new ValidationError("curation result providerVersion does not match configured provider");
  }
  if (result.proposals.length !== units.length) {
    throw new ValidationError(
      `curation coverage mismatch: ${result.proposals.length} proposals for ${units.length} provider units`,
    );
  }
  const unitRefs = new Set(units.map((unit) => unit.providerUnitRef));
  const proposals = new Map<string, MemoryCurationProposal>();
  for (const proposal of result.proposals) {
    requireNonEmpty(proposal.providerUnitRef, "curation proposal providerUnitRef");
    if (!unitRefs.has(proposal.providerUnitRef)) {
      throw new ValidationError(`curation proposal references unknown provider unit ${proposal.providerUnitRef}`);
    }
    if (proposals.has(proposal.providerUnitRef)) {
      throw new ValidationError(`duplicate curation proposal for ${proposal.providerUnitRef}`);
    }
    proposals.set(proposal.providerUnitRef, proposal);
  }
  return proposals;
}

function sourceRefsWithArchive(
  unit: ProviderMemoryUnit,
  input: TranscriptDistillationInput,
  archiveRef: string,
  checksum: string,
) {
  return unit.sourceExperienceRefs.map((ref) =>
    ref.sourceType === input.sourceType && ref.sourceId === input.sourceId
      ? { ...ref, archiveRef, checksum }
      : ref,
  );
}

function curationRecordId(receiptId: string, providerUnitRef: string): MemoryCurationRecord["recordId"] {
  return `cur_${sha256({ receiptId, providerUnitRef }).slice("sha256:".length)}`;
}

function providerUnitFingerprint(unit: ProviderMemoryUnit): string {
  return sha256({
    providerUnitRef: unit.providerUnitRef,
    candidateType: unit.candidateType,
    memoryClass: unit.memoryClass,
    memoryKind: unit.memoryKind,
    proposedContent: unit.proposedContent,
    epistemicStatus: unit.epistemicStatus,
    evidenceRefs: unit.evidenceRefs,
  });
}

export class TranscriptDistillationService {
  private readonly candidateService: MemoryCandidateService;
  private readonly canonicalAuthority: CanonicalMemoryAuthority;
  private readonly clock: Clock;
  private readonly receiptIds: DistillationReceiptIdFactory;

  constructor(private readonly options: TranscriptDistillationServiceOptions) {
    this.candidateService =
      options.candidateService ?? new MemoryCandidateService(options.canonicalStore);
    this.canonicalAuthority =
      options.canonicalAuthority ??
      new CanonicalMemoryAuthority(
        options.canonicalStore,
        undefined,
        undefined,
        options.curationStore,
      );
    this.clock = options.clock ?? new SystemClock();
    this.receiptIds = options.receiptIds ?? new DeterministicDistillationReceiptIdFactory();
  }

  async run(input: TranscriptDistillationInput): Promise<DistillationReceipt> {
    validateInput(input);
    if (input.canonicalizationPolicyVersion !== this.options.governance.policyVersion) {
      throw new ValidationError(
        `canonicalizationPolicyVersion ${input.canonicalizationPolicyVersion} does not match governance policy ${this.options.governance.policyVersion}`,
      );
    }
    if (input.admissionPolicyVersion !== this.options.admissionPolicy.policyVersion) {
      throw new ValidationError(
        `admissionPolicyVersion ${input.admissionPolicyVersion} does not match admission policy ${this.options.admissionPolicy.policyVersion}`,
      );
    }

    const idempotencyKey = sha256({
      scope: input.scope,
      sourceExperienceId: `${input.sourceType}:${input.sourceId}`,
      distillationPolicyVersion: input.distillationPolicyVersion,
      canonicalizationPolicyVersion: input.canonicalizationPolicyVersion,
      provider: this.options.provider.name,
      curationProvider: this.options.curationProvider.name,
      curationProviderVersion: this.options.curationProvider.version ?? null,
      admissionPolicyVersion: input.admissionPolicyVersion,
    });
    const previous = await this.options.receiptStore.getByIdempotencyKey(
      input.scope,
      idempotencyKey,
    );
    if (previous?.status === "complete" || previous?.status === "awaiting_review") {
      return previous;
    }

    const startedAt = this.clock.now();
    let receipt: DistillationReceipt = previous === undefined
      ? {
          receiptId: this.receiptIds.forIdempotencyKey(idempotencyKey),
          scope: input.scope,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          idempotencyKey,
          provider: this.options.provider.name,
          distillationPolicyVersion: input.distillationPolicyVersion,
          canonicalizationPolicyVersion: input.canonicalizationPolicyVersion,
          retentionPolicyVersion: input.retentionPolicyVersion,
          adapterVersion: this.options.provider.adapterVersion,
          ...(this.options.provider.providerVersion === undefined
            ? {}
            : { providerVersion: this.options.provider.providerVersion }),
          curationProvider: this.options.curationProvider.name,
          ...(this.options.curationProvider.version === undefined
            ? {}
            : { curationProviderVersion: this.options.curationProvider.version }),
          admissionPolicyVersion: input.admissionPolicyVersion,
          providerUnitCount: 0,
          curationDecisionCount: 0,
          curationOutcomes: emptyCurationOutcomeCounts(),
          curationCoverageComplete: false,
          admissionComplete: false,
          candidateIds: [],
          canonicalMemoryIds: [],
          status: "pending",
          errors: [],
          warnings: [],
          canonicalizationOutcome: "pending",
          retentionState: "hot",
          pruneEligible: false,
          attempts: 1,
          createdAt: startedAt,
          updatedAt: startedAt,
        }
      : {
          ...previous,
          status: "pending",
          curationCoverageComplete: false,
          admissionComplete: false,
          pruneEligible: false,
          retentionState: "hot",
          attempts: previous.attempts + 1,
          updatedAt: startedAt,
        };
    await this.options.receiptStore.put(receipt);

    let stage: "ingestion" | "archive" | "provider" | "curation" | "admission" | "canonicalization" = "ingestion";
    try {
      receipt = {
        ...receipt,
        status: "ingested",
        ingestedAt: this.clock.now(),
        updatedAt: this.clock.now(),
      };
      await this.options.receiptStore.put(receipt);

      stage = "archive";
      const archived = await this.options.archive.archive({
        scope: input.scope,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        content: input.content,
        contentType: input.contentType,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
        ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      receipt = {
        ...receipt,
        status: "archived",
        archivedAt: archived.archivedAt,
        rawArchiveRef: archived.archiveRef,
        rawArchiveChecksum: archived.checksum,
        updatedAt: this.clock.now(),
      };
      await this.options.receiptStore.put(receipt);

      stage = "provider";
      const result = await this.options.provider.distill({
        experience: {
          scope: archived.scope,
          sourceType: archived.sourceType,
          sourceId: archived.sourceId,
          content: archived.content,
          contentType: archived.contentType,
          archiveRef: archived.archiveRef,
          checksum: archived.checksum,
          ...(archived.createdAt === undefined ? {} : { createdAt: archived.createdAt }),
          ...(archived.observedAt === undefined ? {} : { observedAt: archived.observedAt }),
          ...(archived.metadata === undefined ? {} : { metadata: archived.metadata }),
        },
        distillationPolicyVersion: input.distillationPolicyVersion,
        requestedAt: this.clock.now(),
      });
      validateProviderResult(result, this.options.provider);
      receipt = {
        ...receipt,
        status: "distilled",
        distilledAt: this.clock.now(),
        providerRunId: result.providerRunId,
        providerUnitCount: result.providerUnits.length,
        warnings: [...receipt.warnings, ...result.warnings],
        updatedAt: this.clock.now(),
      };
      await this.options.receiptStore.put(receipt);

      stage = "curation";
      const curationResult = await this.options.curationProvider.curate({
        scope: input.scope,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        rawContent: archived.content,
        providerName: result.providerName,
        providerRunId: result.providerRunId,
        admissionPolicyVersion: input.admissionPolicyVersion,
        units: result.providerUnits,
        requestedAt: this.clock.now(),
      });
      const proposals = proposalsByUnit(
        curationResult,
        this.options.curationProvider,
        result.providerUnits,
      );
      receipt = {
        ...receipt,
        status: "curated",
        curatedAt: this.clock.now(),
        curationDecisionCount: proposals.size,
        curationCoverageComplete: proposals.size === result.providerUnits.length,
        warnings: [...receipt.warnings, ...curationResult.warnings],
        updatedAt: this.clock.now(),
      };
      await this.options.receiptStore.put(receipt);

      stage = "admission";
      const outcomeCounts = emptyCurationOutcomeCounts();
      let exactDuplicates = 0;

      for (const unit of result.providerUnits) {
        const recordId = curationRecordId(receipt.receiptId, unit.providerUnitRef);
        const proposal = proposals.get(unit.providerUnitRef);
        if (proposal === undefined) {
          throw new ValidationError(`missing curation proposal for ${unit.providerUnitRef}`);
        }
        let decision: CanonicalAdmissionDecision = this.options.admissionPolicy.evaluate({
          unit,
          proposal,
          rawContent: archived.content,
        });
        let candidateId: MemoryCurationRecord["candidateId"] | undefined;
        let canonicalMemoryId: MemoryId | undefined;

        if (decision.semanticDisposition === "duplicate") {
          const targetMemoryId = decision.targetMemoryId;
          if (targetMemoryId === undefined) {
            decision = {
              ...decision,
              outcome: "pending_review",
              reasonCodes: [...decision.reasonCodes, "admission:duplicate_target_missing"],
            };
          } else {
            const targetHead = await this.options.canonicalStore.getHead(targetMemoryId);
            if (targetHead === undefined || !sameScope(targetHead.scope, input.scope)) {
              decision = {
                ...decision,
                outcome: "pending_review",
                reasonCodes: [...decision.reasonCodes, "admission:duplicate_target_invalid"],
              };
            }
          }
        }

        if (decision.outcome === "canonical_candidate") {
          const draft = decision.candidateDraft;
          if (draft === undefined) {
            throw new ValidationError(`canonical admission ${unit.providerUnitRef} has no candidate draft`);
          }
          const sourceExperienceRefs = sourceRefsWithArchive(
            unit,
            input,
            archived.archiveRef,
            archived.checksum,
          );
          const candidateInput: CandidateInput = {
            scope: input.scope,
            origin: input.origin,
            candidateType: draft.candidateType,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            memoryClass: draft.memoryClass,
            memoryKind: draft.memoryKind,
            proposedContent: draft.proposedContent,
            evidenceRefs: unit.evidenceRefs,
            epistemicStatus: decision.epistemicStatus,
            ...(unit.confidence === undefined ? {} : { confidence: unit.confidence }),
            producer: unit.producer,
            sourceExperienceRefs,
            distillationPolicyVersion: input.distillationPolicyVersion,
            providerRunId: result.providerRunId,
            canonicalAdmission: {
              admissionPolicyVersion: input.admissionPolicyVersion,
              curationProvider: this.options.curationProvider.name,
              ...(this.options.curationProvider.version === undefined
                ? {}
                : { curationProviderVersion: this.options.curationProvider.version }),
              curationRecordId: recordId,
              outcome: "canonical_candidate",
            },
            proposedOperation: "create",
            ...(draft.observedAt === undefined ? {} : { observedAt: draft.observedAt }),
            ...(draft.validFrom === undefined ? {} : { validFrom: draft.validFrom }),
            ...(draft.validUntil === undefined ? {} : { validUntil: draft.validUntil }),
          };
          const fingerprint = candidateSemanticFingerprint(
            candidateInput,
            decision.epistemicStatus,
          );
          candidateInput.candidateFingerprint = fingerprint;

          const current = await this.options.canonicalStore.findCurrentRevisionBySemanticFingerprint(
            input.scope,
            fingerprint,
          );
          if (current !== undefined) {
            exactDuplicates += 1;
            receipt.warnings.push(
              current.status === "tombstoned"
                ? `suppressed_by_governed_forget:${fingerprint}`
                : `duplicate_canonical_semantics:${fingerprint}`,
            );
            decision = {
              ...decision,
              outcome: "supporting_evidence_only",
              semanticDisposition: "duplicate",
              targetMemoryId: current.memoryId,
              reasonCodes: [
                ...decision.reasonCodes,
                current.status === "tombstoned"
                  ? "admission:suppressed_by_governed_forget"
                  : "admission:exact_canonical_duplicate",
              ],
            };
          } else {
            // Persist the admission decision before a provider-produced DLMF
            // candidate exists. If audit persistence fails, no committable
            // provider candidate is created.
            const precanonicalRecord: MemoryCurationRecord = {
              recordId,
              receiptId: receipt.receiptId,
              scope: input.scope,
              sourceType: input.sourceType,
              sourceId: input.sourceId,
              providerName: result.providerName,
              providerRunId: result.providerRunId,
              providerUnitRef: unit.providerUnitRef,
              providerUnitText: unit.proposedContent.text,
              providerUnitFingerprint: providerUnitFingerprint(unit),
              providerEpistemicStatus: unit.epistemicStatus,
              curationProvider: this.options.curationProvider.name,
              ...(this.options.curationProvider.version === undefined
                ? {}
                : { curationProviderVersion: this.options.curationProvider.version }),
              admissionPolicyVersion: input.admissionPolicyVersion,
              outcome: decision.outcome,
              attributedEpistemicStatus: decision.epistemicStatus,
              durability: decision.durability,
              memoryWorthy: decision.memoryWorthy,
              semanticDisposition: decision.semanticDisposition,
              reasonCodes: [...decision.reasonCodes, "audit:precanonical_recorded"],
              ...(decision.targetMemoryId === undefined
                ? {}
                : { targetMemoryId: decision.targetMemoryId }),
              createdAt: this.clock.now(),
            };
            await this.options.curationStore.put(precanonicalRecord);

            const candidate = await this.candidateService.ingest(candidateInput);
            candidateId = candidate.candidateId;
            if (!receipt.candidateIds.includes(candidate.candidateId)) {
              receipt.candidateIds.push(candidate.candidateId);
            }

            // Link the audit record to the concrete candidate before governance
            // or canonical authority may run. CanonicalMemoryAuthority verifies
            // this linkage independently.
            await this.options.curationStore.put({
              ...precanonicalRecord,
              candidateId: candidate.candidateId,
              createdAt: this.clock.now(),
            });

            stage = "canonicalization";
            const governanceDecision = await this.options.governance.evaluate(candidate);
            stage = "admission";
            if (governanceDecision.action === "reject") {
              await this.options.canonicalStore.transaction(async (tx) => {
                await tx.setCandidateStatus(candidate.candidateId, "REJECTED");
              });
              decision = {
                ...decision,
                outcome: "rejected",
                reasonCodes: [
                  ...decision.reasonCodes,
                  `governance:${governanceDecision.reason}`,
                ],
              };
            } else {
              stage = "canonicalization";
              const committed = await this.canonicalAuthority.commit({
                candidateId: candidate.candidateId,
                idempotencyKey: sha256({
                  distillationIdempotencyKey: receipt.idempotencyKey,
                  providerUnitRef: unit.providerUnitRef,
                  candidateFingerprint: candidate.candidateFingerprint,
                  operation: "canonical_commit",
                }),
              });
              stage = "admission";
              canonicalMemoryId = committed.head.memoryId;
              if (!receipt.canonicalMemoryIds.includes(committed.head.memoryId)) {
                receipt.canonicalMemoryIds.push(committed.head.memoryId);
              }
            }
          }
        }

        outcomeCounts[decision.outcome] += 1;
        const record: MemoryCurationRecord = {
          recordId,
          receiptId: receipt.receiptId,
          scope: input.scope,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          providerName: result.providerName,
          providerRunId: result.providerRunId,
          providerUnitRef: unit.providerUnitRef,
          providerUnitText: unit.proposedContent.text,
          providerUnitFingerprint: providerUnitFingerprint(unit),
          providerEpistemicStatus: unit.epistemicStatus,
          curationProvider: this.options.curationProvider.name,
          ...(this.options.curationProvider.version === undefined
            ? {}
            : { curationProviderVersion: this.options.curationProvider.version }),
          admissionPolicyVersion: input.admissionPolicyVersion,
          outcome: decision.outcome,
          attributedEpistemicStatus: decision.epistemicStatus,
          durability: decision.durability,
          memoryWorthy: decision.memoryWorthy,
          semanticDisposition: decision.semanticDisposition,
          reasonCodes:
            candidateId === undefined
              ? decision.reasonCodes
              : [...decision.reasonCodes, "audit:precanonical_recorded"],
          ...(decision.targetMemoryId === undefined
            ? {}
            : { targetMemoryId: decision.targetMemoryId }),
          ...(candidateId === undefined ? {} : { candidateId }),
          ...(canonicalMemoryId === undefined ? {} : { canonicalMemoryId }),
          createdAt: this.clock.now(),
        };
        await this.options.curationStore.put(record);
      }

      const coverageComplete =
        receipt.curationCoverageComplete &&
        outcomeCounts.supporting_evidence_only +
          outcomeCounts.rejected +
          outcomeCounts.pending_review +
          outcomeCounts.canonical_candidate ===
          result.providerUnits.length;
      const admissionComplete = coverageComplete && outcomeCounts.pending_review === 0;
      const canonicalizationOutcome = outcomeCounts.pending_review > 0
        ? "pending_review"
        : receipt.canonicalMemoryIds.length > 0
          ? "committed"
          : result.providerUnits.length === 0
            ? "no_memory_worthy_content"
            : exactDuplicates > 0 && outcomeCounts.supporting_evidence_only === result.providerUnits.length
              ? "superseded"
              : outcomeCounts.rejected === result.providerUnits.length
                ? "rejected"
                : "no_memory_worthy_content";

      stage = "canonicalization";
      receipt = {
        ...receipt,
        status: "canonicalized",
        canonicalizedAt: this.clock.now(),
        curationOutcomes: outcomeCounts,
        curationCoverageComplete: coverageComplete,
        admissionComplete,
        canonicalizationOutcome,
        updatedAt: this.clock.now(),
      };
      await this.options.receiptStore.put(receipt);

      receipt = {
        ...receipt,
        status: admissionComplete ? "complete" : "awaiting_review",
        retentionState: "preserved",
        pruneEligible: false,
        updatedAt: this.clock.now(),
      };
      await this.options.receiptStore.put(receipt);
      return (
        (await this.options.receiptStore.getByIdempotencyKey(input.scope, idempotencyKey)) ??
        receipt
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      receipt = {
        ...receipt,
        status: "failed",
        admissionComplete: false,
        pruneEligible: false,
        errors: [
          ...receipt.errors,
          {
            stage,
            code: error instanceof ValidationError ? "VALIDATION_ERROR" : "DISTILLATION_ERROR",
            message,
            occurredAt: this.clock.now(),
          },
        ],
        updatedAt: this.clock.now(),
      };
      await this.options.receiptStore.put(receipt);
      return (
        (await this.options.receiptStore.getByIdempotencyKey(input.scope, idempotencyKey)) ??
        receipt
      );
    }
  }
}
