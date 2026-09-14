import { ValidationError } from "../domain/errors.js";
import type { MemoryScope } from "../domain/types.js";
import { sameScope, sha256, stableStringify } from "../domain/utils.js";
import type {
  DistillationExperience,
  DistillationResult,
} from "./types.js";
import type { MemoryDistillationProvider } from "./memory-distillation-provider.js";

export const PROVIDER_EXTRACTION_ARTIFACT_CONTRACT =
  "dlmf/provider-extraction-artifact/v1" as const;

export interface ProviderExtractionArtifactIdentity {
  scope: MemoryScope;
  sourceType: string;
  sourceId: string;
  providerName: string;
  adapterVersion: string;
  providerVersion?: string;
  distillationPolicyVersion: string;
  experienceFingerprint: string;
}

export interface ProviderExtractionArtifact {
  contract: typeof PROVIDER_EXTRACTION_ARTIFACT_CONTRACT;
  identity: ProviderExtractionArtifactIdentity;
  result: DistillationResult;
  artifactRef: string;
  checksum: string;
  createdAt: string;
}

export interface ProviderExtractionArtifactWrite {
  identity: ProviderExtractionArtifactIdentity;
  result: DistillationResult;
  createdAt?: string;
}

export interface ProviderExtractionArtifactStore {
  get(
    identity: ProviderExtractionArtifactIdentity,
  ): Promise<ProviderExtractionArtifact | undefined>;
  put(input: ProviderExtractionArtifactWrite): Promise<ProviderExtractionArtifact>;
  resolve(artifactRef: string): Promise<ProviderExtractionArtifact>;
  verify(artifactRef: string, expectedChecksum: string): Promise<boolean>;
}

export function providerExtractionExperienceFingerprint(
  experience: DistillationExperience,
): string {
  return sha256({
    scope: experience.scope,
    sourceType: experience.sourceType,
    sourceId: experience.sourceId,
    contentType: experience.contentType,
    archiveRef: experience.archiveRef,
    checksum: experience.checksum,
    createdAt: experience.createdAt ?? null,
    observedAt: experience.observedAt ?? null,
    metadata: experience.metadata ?? null,
    sourceSegments: experience.sourceSegments ?? null,
  });
}

export function providerExtractionArtifactIdentity(
  experience: DistillationExperience,
  provider: Pick<MemoryDistillationProvider, "name" | "adapterVersion" | "providerVersion">,
  distillationPolicyVersion: string,
): ProviderExtractionArtifactIdentity {
  return {
    scope: structuredClone(experience.scope),
    sourceType: experience.sourceType,
    sourceId: experience.sourceId,
    providerName: provider.name,
    adapterVersion: provider.adapterVersion,
    ...(provider.providerVersion === undefined
      ? {}
      : { providerVersion: provider.providerVersion }),
    distillationPolicyVersion,
    experienceFingerprint: providerExtractionExperienceFingerprint(experience),
  };
}

export function providerExtractionArtifactIdentityKey(
  identity: ProviderExtractionArtifactIdentity,
): string {
  return sha256({
    contract: PROVIDER_EXTRACTION_ARTIFACT_CONTRACT,
    identity,
  });
}

export function providerExtractionArtifactChecksum(
  identity: ProviderExtractionArtifactIdentity,
  result: DistillationResult,
): string {
  return sha256({
    contract: PROVIDER_EXTRACTION_ARTIFACT_CONTRACT,
    identity,
    result,
  });
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new ValidationError(`${field} must not be empty`);
}

export function assertProviderExtractionArtifact(
  artifact: ProviderExtractionArtifact,
  expectedIdentity?: ProviderExtractionArtifactIdentity,
): void {
  if (artifact.contract !== PROVIDER_EXTRACTION_ARTIFACT_CONTRACT) {
    throw new ValidationError("provider extraction artifact contract mismatch");
  }
  const identity = artifact.identity;
  requireText(identity.scope.tenantId, "artifact.identity.scope.tenantId");
  requireText(identity.scope.lifeDid, "artifact.identity.scope.lifeDid");
  requireText(identity.scope.memoryNamespace, "artifact.identity.scope.memoryNamespace");
  requireText(identity.sourceType, "artifact.identity.sourceType");
  requireText(identity.sourceId, "artifact.identity.sourceId");
  requireText(identity.providerName, "artifact.identity.providerName");
  requireText(identity.adapterVersion, "artifact.identity.adapterVersion");
  requireText(identity.distillationPolicyVersion, "artifact.identity.distillationPolicyVersion");
  requireText(identity.experienceFingerprint, "artifact.identity.experienceFingerprint");
  requireText(artifact.artifactRef, "artifact.artifactRef");
  requireText(artifact.checksum, "artifact.checksum");
  requireText(artifact.createdAt, "artifact.createdAt");
  if (expectedIdentity !== undefined) {
    if (!sameScope(identity.scope, expectedIdentity.scope)
      || stableStringify(identity) !== stableStringify(expectedIdentity)) {
      throw new ValidationError("provider extraction artifact identity mismatch");
    }
  }
  if (artifact.result.providerName !== identity.providerName) {
    throw new ValidationError("provider extraction artifact providerName mismatch");
  }
  if (artifact.result.adapterVersion !== identity.adapterVersion) {
    throw new ValidationError("provider extraction artifact adapterVersion mismatch");
  }
  if ((artifact.result.providerVersion ?? null) !== (identity.providerVersion ?? null)) {
    throw new ValidationError("provider extraction artifact providerVersion mismatch");
  }
  if (providerExtractionArtifactChecksum(identity, artifact.result) !== artifact.checksum) {
    throw new ValidationError("provider extraction artifact checksum mismatch");
  }
}
