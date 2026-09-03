import { randomUUID } from "node:crypto";
import { ValidationError } from "../domain/errors.js";
import type {
  EpistemicStatus,
  MemoryClass,
  MemoryProducer,
  MemoryScope,
  SourceExperienceRef,
} from "../domain/types.js";
import type { MemoryDistillationProvider } from "./memory-distillation-provider.js";
import type {
  DerivedMemoryCandidateDraft,
  DistillationRequest,
  DistillationResult,
  MemoryCandidateType,
  MemoryEvidence,
  RecallRequest,
  ReflectRequest,
  ReflectResult,
} from "./types.js";

export type HindsightBudget = "low" | "mid" | "high";
export type HindsightFactType = "world" | "experience" | "observation";

export interface HindsightRecallResult {
  id: string;
  text: string;
  type?: string | null;
  entities?: string[] | null;
  context?: string | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
  mentioned_at?: string | null;
  document_id?: string | null;
  metadata?: Record<string, string> | null;
  chunk_id?: string | null;
}

export interface HindsightRecallResponse {
  results: HindsightRecallResult[];
  trace?: Record<string, unknown> | null;
}

export interface HindsightMemoryUnit extends HindsightRecallResult {
  bank_id?: string;
  created_at?: string | null;
  updated_at?: string | null;
  consolidation_state?: string | null;
  source_memory_ids?: string[];
  invalidated_by?: string | null;
}

export interface HindsightListMemoriesResponse {
  items: HindsightMemoryUnit[];
  total: number;
  limit: number;
  offset: number;
}

export interface HindsightReflectFact {
  id?: string | null;
  text: string;
  type?: string | null;
  context?: string | null;
  occurred_start?: string | null;
  occurred_end?: string | null;
}

export interface HindsightReflectResponse {
  text: string;
  based_on?: HindsightReflectFact[];
}

export interface HindsightRetainResponse {
  success: boolean;
  bank_id: string;
  items_count: number;
  async: boolean;
}

/** Provider-specific port. These Hindsight shapes never enter the canonical domain. */
export interface HindsightClientPort {
  retain(
    bankId: string,
    content: string,
    options?: {
      timestamp?: Date | string;
      context?: string;
      metadata?: Record<string, string>;
      documentId?: string;
      tags?: string[];
      async?: boolean;
    },
  ): Promise<HindsightRetainResponse>;
  listMemories(
    bankId: string,
    options?: {
      limit?: number;
      offset?: number;
      type?: HindsightFactType;
      state?: "valid" | "invalidated";
      documentId?: string;
    },
  ): Promise<HindsightListMemoriesResponse>;
  recall(
    bankId: string,
    query: string,
    options?: {
      types?: HindsightFactType[];
      maxTokens?: number;
      budget?: HindsightBudget;
      trace?: boolean;
      queryTimestamp?: string;
      includeEntities?: boolean;
      maxEntityTokens?: number;
      includeChunks?: boolean;
      maxChunkTokens?: number;
    },
  ): Promise<HindsightRecallResponse>;
  reflect(
    bankId: string,
    query: string,
    options?: { context?: string; budget?: HindsightBudget; maxTokens?: number },
  ): Promise<HindsightReflectResponse>;
}

export interface HindsightPlaneResolver {
  distillationBankId(scope: MemoryScope): string;
  projectionBankId(scope: MemoryScope): string;
}

export interface HindsightMemoryAdapterOptions {
  client: HindsightClientPort;
  banks: HindsightPlaneResolver;
  adapterVersion: string;
  providerVersion?: string;
  recallBudget?: HindsightBudget;
  reflectBudget?: HindsightBudget;
}

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

const memoryClasses = new Set<MemoryClass>([
  "episode",
  "semantic_assertion",
  "preference",
  "relationship_fact",
]);

const DISTILLATION_MEMORY_PAGE_SIZE = 1000;
const DISTILLATION_MEMORY_MAX_UNITS = 10_000;

const epistemicStatuses = new Set<EpistemicStatus>([
  "observed",
  "user_asserted",
  "system_observed",
  "inferred",
  "synthesized",
  "uncertain",
]);

function parseConfidence(metadata: Record<string, string> | null | undefined): number | undefined {
  const raw = metadata?.dlmf_confidence ?? metadata?.confidence;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function mappedType(result: HindsightRecallResult): {
  candidateType: MemoryCandidateType;
  memoryClass: MemoryClass;
  memoryKind: string;
} {
  const declaredCandidate = result.metadata?.dlmf_candidate_type as MemoryCandidateType | undefined;
  const declaredClass = result.metadata?.dlmf_memory_class as MemoryClass | undefined;
  const declaredKind = result.metadata?.dlmf_memory_kind;
  if (
    declaredCandidate !== undefined &&
    candidateTypes.has(declaredCandidate) &&
    declaredClass !== undefined &&
    memoryClasses.has(declaredClass) &&
    declaredKind !== undefined &&
    declaredKind.trim().length > 0
  ) {
    return {
      candidateType: declaredCandidate,
      memoryClass: declaredClass,
      memoryKind: declaredKind,
    };
  }

  if (result.type === "experience") {
    return {
      candidateType: "event_candidate",
      memoryClass: "episode",
      memoryKind: "hindsight_experience",
    };
  }
  return {
    candidateType: "fact_candidate",
    memoryClass: "semantic_assertion",
    memoryKind: result.type === "observation" ? "hindsight_observation" : "hindsight_world_fact",
  };
}

function mappedEpistemicStatus(result: HindsightRecallResult): EpistemicStatus {
  const declared = result.metadata?.dlmf_epistemic_status as EpistemicStatus | undefined;
  return declared !== undefined && epistemicStatuses.has(declared) ? declared : "synthesized";
}

export class HindsightMemoryAdapter implements MemoryDistillationProvider {
  readonly name = "hindsight";
  readonly adapterVersion: string;
  readonly providerVersion: string | undefined;

  constructor(private readonly options: HindsightMemoryAdapterOptions) {
    if (options.adapterVersion.trim().length === 0) {
      throw new ValidationError("Hindsight adapterVersion must not be empty");
    }
    this.adapterVersion = options.adapterVersion;
    this.providerVersion = options.providerVersion;
  }

  private bankIds(scope: MemoryScope): { distillation: string; projection: string } {
    const distillation = this.options.banks.distillationBankId(scope);
    const projection = this.options.banks.projectionBankId(scope);
    if (distillation.trim().length === 0 || projection.trim().length === 0) {
      throw new ValidationError("Hindsight bank IDs must not be empty");
    }
    if (distillation === projection) {
      throw new ValidationError(
        "Hindsight distillation plane and canonical projection plane must use distinct banks",
      );
    }
    return { distillation, projection };
  }

  private async listDocumentMemories(
    bankId: string,
    documentId: string,
  ): Promise<HindsightMemoryUnit[]> {
    const items: HindsightMemoryUnit[] = [];
    let offset = 0;
    while (true) {
      const page = await this.options.client.listMemories(bankId, {
        limit: DISTILLATION_MEMORY_PAGE_SIZE,
        offset,
        state: "valid",
        documentId,
      });
      if (!Number.isSafeInteger(page.total) || page.total < 0) {
        throw new Error("Hindsight listMemories returned an invalid total");
      }
      if (page.total > DISTILLATION_MEMORY_MAX_UNITS) {
        throw new Error(
          `Hindsight document produced too many memory units: ${page.total} > ${DISTILLATION_MEMORY_MAX_UNITS}`,
        );
      }
      if (!Array.isArray(page.items)) {
        throw new Error("Hindsight listMemories returned invalid items");
      }
      for (const item of page.items) {
        if (item.document_id !== documentId) {
          throw new Error("Hindsight document-scoped memory listing returned a mismatched document_id");
        }
        items.push(item);
      }
      if (items.length >= page.total || page.items.length === 0) break;
      offset += page.items.length;
      if (offset > DISTILLATION_MEMORY_MAX_UNITS) {
        throw new Error("Hindsight document memory pagination exceeded the bounded limit");
      }
    }
    return items;
  }

  async distill(request: DistillationRequest): Promise<DistillationResult> {
    const { distillation } = this.bankIds(request.experience.scope);
    const providerRunId = `hs_distill_${randomUUID().replaceAll("-", "")}`;
    const documentId = `${request.experience.sourceType}:${request.experience.sourceId}`;
    const timestamp = request.experience.observedAt ?? request.experience.createdAt;
    const retained = await this.options.client.retain(distillation, request.experience.content, {
      ...(timestamp === undefined ? {} : { timestamp }),
      context: request.experience.contentType,
      documentId,
      async: false,
      tags: ["dlmf", "distillation"],
      metadata: {
        dlmf_plane: "distillation",
        dlmf_source_type: request.experience.sourceType,
        dlmf_source_id: request.experience.sourceId,
        dlmf_archive_ref: request.experience.archiveRef,
        dlmf_checksum: request.experience.checksum,
        dlmf_policy_version: request.distillationPolicyVersion,
        dlmf_provider_run_id: providerRunId,
      },
    });
    if (!retained.success) {
      throw new Error("Hindsight retain reported success=false");
    }
    if (retained.async) {
      throw new Error("Hindsight retain remained asynchronous; distillation is not complete");
    }
    if (retained.bank_id !== distillation) {
      throw new Error("Hindsight retain returned a mismatched bank_id");
    }
    if (!Number.isSafeInteger(retained.items_count) || retained.items_count < 1) {
      throw new Error("Hindsight retain did not durably accept the source experience");
    }

    const documentMemories = await this.listDocumentMemories(distillation, documentId);

    const sourceExperienceRefs: SourceExperienceRef[] = [
      {
        sourceType: request.experience.sourceType,
        sourceId: request.experience.sourceId,
        archiveRef: request.experience.archiveRef,
        checksum: request.experience.checksum,
      },
    ];
    const producerBase: MemoryProducer = {
      kind: "provider",
      id: "hindsight",
      providerName: "hindsight",
      adapterVersion: this.adapterVersion,
      ...(this.providerVersion === undefined ? {} : { providerVersion: this.providerVersion }),
    };

    // Strict document filtering prevents unrelated memories already present in the
    // distillation bank from becoming candidates for this source experience.
    const candidates = documentMemories
      .filter((result) => result.text.trim().length > 0)
      .map((result) => {
        const mapped = mappedType(result);
        const confidence = parseConfidence(result.metadata);
        return {
          ...mapped,
          proposedContent: {
            text: result.text,
            ...(result.entities == null && result.context == null
              ? {}
              : {
                  payload: {
                    ...(result.entities == null ? {} : { entities: result.entities }),
                    ...(result.context == null ? {} : { sourceContext: result.context }),
                  },
                }),
          },
          evidenceRefs: [
            { sourceType: "hindsight", sourceRef: result.id },
            {
              sourceType: request.experience.sourceType,
              sourceRef: request.experience.sourceId,
            },
          ],
          epistemicStatus: mappedEpistemicStatus(result),
          ...(confidence === undefined ? {} : { confidence }),
          producer: producerBase,
          sourceExperienceRefs,
          ...(result.occurred_start == null
            ? request.experience.observedAt === undefined
              ? {}
              : { observedAt: request.experience.observedAt }
            : { observedAt: result.occurred_start }),
          providerCandidateRef: result.id,
        };
      });

    return {
      providerName: this.name,
      providerRunId,
      adapterVersion: this.adapterVersion,
      ...(this.providerVersion === undefined ? {} : { providerVersion: this.providerVersion }),
      candidates,
      warnings: [],
    };
  }

  async recall(request: RecallRequest): Promise<MemoryEvidence[]> {
    const { projection } = this.bankIds(request.scope);
    const response = await this.options.client.recall(projection, request.query, {
      budget: this.options.recallBudget ?? "mid",
      includeEntities: true,
      trace: true,
      queryTimestamp: request.requestedAt,
    });
    return response.results.map((result) => ({
      evidenceRef: { sourceType: "hindsight", sourceRef: result.id },
      text: result.text,
      providerName: this.name,
      providerSourceId: result.id,
      sourceExperienceRefs:
        result.document_id == null
          ? []
          : [{ sourceType: "hindsight_document", sourceId: result.document_id }],
      metadata: {
        ...(result.type == null ? {} : { type: result.type }),
        ...(result.context == null ? {} : { context: result.context }),
      },
    }));
  }

  async reflect(request: ReflectRequest): Promise<ReflectResult> {
    const { projection } = this.bankIds(request.scope);
    const providerRunId = `hs_reflect_${randomUUID().replaceAll("-", "")}`;
    const canonicalContext = request.canonicalMemories
      .map((memory) =>
        `[${memory.memoryId}@${memory.revision} epistemic=${memory.epistemicStatus}] ${memory.text}`,
      )
      .join("\n");
    const evidenceContext = request.evidence
      .map((evidence) => `${evidence.evidenceRef.sourceType}:${evidence.evidenceRef.sourceRef} ${evidence.text ?? ""}`)
      .join("\n");
    const response = await this.options.client.reflect(projection, request.context, {
      budget: this.options.reflectBudget ?? "mid",
      context: [canonicalContext, evidenceContext].filter(Boolean).join("\n\n"),
    });

    const candidates: DerivedMemoryCandidateDraft[] = [];
    if (response.text.trim().length > 0) {
      const providerEvidence = (response.based_on ?? [])
        .filter((fact) => fact.id != null)
        .map((fact) => ({ sourceType: "hindsight", sourceRef: fact.id as string }));
      const callerEvidence = request.evidence.map((evidence) => evidence.evidenceRef);
      const sourceExperienceRefs = [
        ...request.evidence.flatMap((evidence) => evidence.sourceExperienceRefs),
        ...request.canonicalMemories.flatMap((memory) => memory.sourceExperienceRefs),
      ];
      candidates.push({
        candidateType: "derived_insight_candidate",
        memoryClass: "semantic_assertion",
        memoryKind: "reflective_insight",
        proposedContent: { text: response.text },
        evidenceRefs: [...providerEvidence, ...callerEvidence],
        epistemicStatus: "synthesized",
        producer: {
          kind: "provider",
          id: "hindsight",
          providerName: "hindsight",
          adapterVersion: this.adapterVersion,
          ...(this.providerVersion === undefined ? {} : { providerVersion: this.providerVersion }),
        },
        sourceExperienceRefs,
      });
    }

    return {
      providerName: this.name,
      providerRunId,
      adapterVersion: this.adapterVersion,
      ...(this.providerVersion === undefined ? {} : { providerVersion: this.providerVersion }),
      candidates,
      warnings: [],
    };
  }
}
