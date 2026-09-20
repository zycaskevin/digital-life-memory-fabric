import type { DistillationReceipt } from "../distillation/types.js";
import type { MemoryScope } from "../domain/types.js";
import type {
  ExperienceId,
  ExperienceTimestamp,
  NormalizedExperience,
  SourceFingerprint,
  SourceIdentity,
  SourceVersion,
} from "./contracts.js";

export const DLMF_DEVELOPMENT_EXPERIENCE_REFERENCE_SCHEMA =
  "dlmf.normalized-experience.reference.v1" as const;
export const DLMF_DEVELOPMENT_EXPERIENCE_REFERENCE_AUTHORITY =
  "digital-life-memory-fabric" as const;

export type DevelopmentExperienceDisposition =
  | "TRANSIENT_SOURCE_ONLY"
  | "REFERENCE_ONLY"
  | "DISTILLATION_SUBMITTED"
  | "NO_TEXTUAL_EVIDENCE";

/**
 * Content-free reference to one observed version of a Normalized Experience.
 *
 * This projection exists so Development can know that an experience happened
 * without requiring that the experience first become canonical long-term memory.
 * It deliberately contains no event/content payload, transcript, assistant output,
 * provider-private identifier, or semantic/personality conclusion.
 */
export interface DlmfDevelopmentExperienceReference {
  readonly schema: typeof DLMF_DEVELOPMENT_EXPERIENCE_REFERENCE_SCHEMA;
  readonly authority: typeof DLMF_DEVELOPMENT_EXPERIENCE_REFERENCE_AUTHORITY;
  readonly scope: MemoryScope;
  readonly experienceId: ExperienceId;
  readonly source: SourceIdentity;
  readonly sourceVersion?: SourceVersion;
  readonly sourceFingerprint: SourceFingerprint;
  readonly startedAt: ExperienceTimestamp;
  readonly endedAt: ExperienceTimestamp;
  readonly normalizedAt: string;
  readonly disposition: DevelopmentExperienceDisposition;
  readonly distillation?: {
    readonly receiptId: string;
    readonly status: DistillationReceipt["status"];
  };
}

export function projectDevelopmentExperienceReference(
  experience: NormalizedExperience,
  scope: MemoryScope,
  disposition: DevelopmentExperienceDisposition,
  receipt?: Pick<DistillationReceipt, "receiptId" | "status">,
): DlmfDevelopmentExperienceReference {
  if (
    experience.sourceSystem !== experience.provenance.source.sourceSystem
    || experience.sourceType !== experience.provenance.source.sourceType
    || experience.sourceId !== experience.provenance.source.sourceId
  ) {
    throw new Error("normalized experience source/provenance identity mismatch");
  }
  if (!experience.provenance.sourceFingerprint.value.trim()) {
    throw new Error("normalized experience source fingerprint is required");
  }
  if (!experience.provenance.normalizedAt.trim()) {
    throw new Error("normalized experience normalizedAt is required");
  }
  if (disposition === "DISTILLATION_SUBMITTED" && receipt === undefined) {
    throw new Error("distillation-submitted experience reference requires receipt metadata");
  }
  if (disposition !== "DISTILLATION_SUBMITTED" && receipt !== undefined) {
    throw new Error("non-distilled experience reference must not carry distillation metadata");
  }

  return {
    schema: DLMF_DEVELOPMENT_EXPERIENCE_REFERENCE_SCHEMA,
    authority: DLMF_DEVELOPMENT_EXPERIENCE_REFERENCE_AUTHORITY,
    scope: {
      tenantId: scope.tenantId,
      lifeDid: scope.lifeDid,
      memoryNamespace: scope.memoryNamespace,
    },
    experienceId: experience.experienceId,
    source: { ...experience.provenance.source },
    ...(experience.sourceVersion === undefined
      ? {}
      : { sourceVersion: { ...experience.sourceVersion } }),
    sourceFingerprint: { ...experience.provenance.sourceFingerprint },
    startedAt: { ...experience.startedAt },
    endedAt: { ...experience.endedAt },
    normalizedAt: experience.provenance.normalizedAt,
    disposition,
    ...(receipt === undefined
      ? {}
      : { distillation: { receiptId: receipt.receiptId, status: receipt.status } }),
  };
}
