import type {
  MemoryClass,
  MemoryRevision,
  MemoryScope,
  MemoryStatus,
  SourceExperienceRef,
  EpistemicStatus,
} from "../domain/types.js";

export const DLMF_DEVELOPMENT_REFERENCE_SCHEMA =
  "dlmf.development-reference.v1" as const;
export const DLMF_DEVELOPMENT_REFERENCE_AUTHORITY =
  "digital-life-memory-fabric" as const;

export interface DlmfDevelopmentCanonicalReference {
  readonly scope: MemoryScope;
  readonly memoryId: `mem_${string}`;
  readonly canonicalRevision: number;
  readonly status: MemoryStatus;
  readonly memoryClass: MemoryClass;
  readonly memoryKind: string;
  readonly contentHash: string;
  readonly commitSeq: number;
  readonly epistemicStatus: EpistemicStatus;
  readonly committedAt: string;
  readonly observedAt?: string;
  readonly sourceExperienceRefs: readonly SourceExperienceRef[];
}

export interface DlmfDevelopmentReferenceEnvelope {
  readonly schema: typeof DLMF_DEVELOPMENT_REFERENCE_SCHEMA;
  readonly authority: typeof DLMF_DEVELOPMENT_REFERENCE_AUTHORITY;
  readonly reference: DlmfDevelopmentCanonicalReference;
}

/**
 * DLMF-owned projection used for Development integration.
 *
 * This function is intentionally the process/transport boundary where
 * canonicalContent is discarded. Downstream consumers never need to receive
 * the autobiographical text/payload merely to reference canonical evidence.
 */
export function projectDevelopmentCanonicalReference(
  revision: MemoryRevision,
): DlmfDevelopmentCanonicalReference {
  return {
    scope: {
      tenantId: revision.scope.tenantId,
      lifeDid: revision.scope.lifeDid,
      memoryNamespace: revision.scope.memoryNamespace,
    },
    memoryId: revision.memoryId,
    canonicalRevision: revision.revision,
    status: revision.status,
    memoryClass: revision.memoryClass,
    memoryKind: revision.memoryKind,
    contentHash: revision.contentHash,
    commitSeq: revision.commitSeq,
    epistemicStatus: revision.epistemicStatus,
    committedAt: revision.committedAt,
    ...(revision.observedAt === undefined
      ? {}
      : { observedAt: revision.observedAt }),
    sourceExperienceRefs: revision.sourceExperienceRefs.map((source) => ({
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      ...(source.archiveRef === undefined ? {} : { archiveRef: source.archiveRef }),
      ...(source.checksum === undefined ? {} : { checksum: source.checksum }),
    })),
  };
}

export function createDevelopmentReferenceEnvelope(
  revision: MemoryRevision,
): DlmfDevelopmentReferenceEnvelope {
  return {
    schema: DLMF_DEVELOPMENT_REFERENCE_SCHEMA,
    authority: DLMF_DEVELOPMENT_REFERENCE_AUTHORITY,
    reference: projectDevelopmentCanonicalReference(revision),
  };
}
