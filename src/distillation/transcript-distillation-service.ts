import { CanonicalMemoryAuthority } from "../authority/canonical-memory-authority.js";
import {
  MemoryCandidateService,
  candidateSemanticFingerprint,
} from "../candidates/memory-candidate-service.js";
import { ValidationError } from "../domain/errors.js";
import type { CandidateInput } from "../domain/types.js";
import { SystemClock, sha256, type Clock } from "../domain/utils.js";
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
  if (input.origin.lifeDid !== input.scope.lifeDid) {
    throw new ValidationError("origin.lifeDid must match scope.lifeDid");
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
  for (const [index, candidate] of result.candidates.entries()) {
    if (!candidateTypes.has(candidate.candidateType)) {
      throw new ValidationError(`candidate[${index}] has unsupported candidateType`);
    }
    if (candidate.candidateType === "derived_insight_candidate") {
      throw new ValidationError("distill() must not return derived_insight_candidate; use reflect()");
    }
    requireNonEmpty(candidate.memoryKind, `candidate[${index}].memoryKind`);
    requireNonEmpty(candidate.proposedContent.text, `candidate[${index}].proposedContent.text`);
    if (candidate.evidenceRefs.length === 0) {
      throw new ValidationError(`candidate[${index}] must include evidenceRefs`);
    }
    if (candidate.sourceExperienceRefs.length === 0) {
      throw new ValidationError(`candidate[${index}] must include sourceExperienceRefs`);
    }
    if (candidate.producer.kind !== "provider") {
      throw new ValidationError(`candidate[${index}].producer must identify a provider`);
    }
  }
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
      options.canonicalAuthority ?? new CanonicalMemoryAuthority(options.canonicalStore);
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
    const idempotencyKey = sha256({
      scope: input.scope,
      sourceExperienceId: `${input.sourceType}:${input.sourceId}`,
      distillationPolicyVersion: input.distillationPolicyVersion,
      provider: this.options.provider.name,
    });
    const previous = await this.options.receiptStore.getByIdempotencyKey(
      input.scope,
      idempotencyKey,
    );
    if (previous?.status === "complete") return previous;

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
          pruneEligible: false,
          attempts: previous.attempts + 1,
          updatedAt: startedAt,
        };
    await this.options.receiptStore.put(receipt);

    let stage: "ingestion" | "archive" | "provider" | "canonicalization" = "ingestion";
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
        warnings: [...receipt.warnings, ...result.warnings],
        updatedAt: this.clock.now(),
      };
      await this.options.receiptStore.put(receipt);

      stage = "canonicalization";
      let governanceRejected = 0;
      let suppressedOrDuplicate = 0;
      for (const draft of result.candidates) {
        const sourceExperienceRefs = draft.sourceExperienceRefs.map((ref) =>
          ref.sourceType === input.sourceType && ref.sourceId === input.sourceId
            ? {
                ...ref,
                archiveRef: archived.archiveRef,
                checksum: archived.checksum,
              }
            : ref,
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
          evidenceRefs: draft.evidenceRefs,
          epistemicStatus: draft.epistemicStatus,
          ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
          producer: draft.producer,
          sourceExperienceRefs,
          distillationPolicyVersion: input.distillationPolicyVersion,
          providerRunId: result.providerRunId,
          proposedOperation: "create",
          ...(draft.observedAt === undefined ? {} : { observedAt: draft.observedAt }),
          ...(draft.validFrom === undefined ? {} : { validFrom: draft.validFrom }),
          ...(draft.validUntil === undefined ? {} : { validUntil: draft.validUntil }),
        };
        const fingerprint = candidateSemanticFingerprint(
          candidateInput,
          draft.epistemicStatus,
        );
        candidateInput.candidateFingerprint = fingerprint;

        const current = await this.options.canonicalStore.findCurrentRevisionBySemanticFingerprint(
          input.scope,
          fingerprint,
        );
        if (current !== undefined) {
          suppressedOrDuplicate += 1;
          receipt.warnings.push(
            current.status === "tombstoned"
              ? `suppressed_by_governed_forget:${fingerprint}`
              : `duplicate_canonical_semantics:${fingerprint}`,
          );
          continue;
        }

        const candidate = await this.candidateService.ingest(candidateInput);
        receipt.candidateIds.push(candidate.candidateId);
        const decision = await this.options.governance.evaluate(candidate);
        if (decision.action === "reject") {
          governanceRejected += 1;
          await this.options.canonicalStore.transaction(async (tx) => {
            await tx.setCandidateStatus(candidate.candidateId, "REJECTED");
          });
          receipt.warnings.push(`governance_rejected:${decision.reason}:${candidate.candidateId}`);
          continue;
        }

        const committed = await this.canonicalAuthority.commit({
          candidateId: candidate.candidateId,
          idempotencyKey: sha256({
            distillationIdempotencyKey: receipt.idempotencyKey,
            candidateFingerprint: candidate.candidateFingerprint,
            operation: "canonical_commit",
          }),
        });
        if (!receipt.canonicalMemoryIds.includes(committed.head.memoryId)) {
          receipt.canonicalMemoryIds.push(committed.head.memoryId);
        }
      }

      const outcome = receipt.canonicalMemoryIds.length > 0
        ? "committed"
        : result.candidates.length === 0
          ? "no_memory_worthy_content"
          : receipt.candidateIds.length === 0 && suppressedOrDuplicate > 0
            ? "superseded"
            : governanceRejected > 0
              ? "rejected"
              : "no_memory_worthy_content";
      receipt = {
        ...receipt,
        status: "canonicalized",
        canonicalizedAt: this.clock.now(),
        canonicalizationOutcome: outcome,
        updatedAt: this.clock.now(),
      };
      await this.options.receiptStore.put(receipt);

      receipt = {
        ...receipt,
        status: "complete",
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
