import { ValidationError } from "../domain/errors.js";
import {
  PROVIDER_EXTRACTION_ARTIFACT_CONTRACT,
  assertProviderExtractionArtifact,
  providerExtractionArtifactChecksum,
  providerExtractionArtifactIdentityKey,
  type ProviderExtractionArtifact,
  type ProviderExtractionArtifactIdentity,
  type ProviderExtractionArtifactStore,
  type ProviderExtractionArtifactWrite,
} from "./provider-extraction-artifact-store.js";

export class InMemoryProviderExtractionArtifactStore
  implements ProviderExtractionArtifactStore
{
  readonly #byIdentity = new Map<string, ProviderExtractionArtifact>();
  readonly #byRef = new Map<string, ProviderExtractionArtifact>();

  async get(
    identity: ProviderExtractionArtifactIdentity,
  ): Promise<ProviderExtractionArtifact | undefined> {
    const stored = this.#byIdentity.get(providerExtractionArtifactIdentityKey(identity));
    if (stored === undefined) return undefined;
    assertProviderExtractionArtifact(stored, identity);
    return structuredClone(stored);
  }

  async put(input: ProviderExtractionArtifactWrite): Promise<ProviderExtractionArtifact> {
    const identityKey = providerExtractionArtifactIdentityKey(input.identity);
    const checksum = providerExtractionArtifactChecksum(input.identity, input.result);
    const artifactRef = `memory-provider-extraction://${identityKey.slice("sha256:".length)}`;
    const existing = this.#byIdentity.get(identityKey);
    if (existing !== undefined) {
      assertProviderExtractionArtifact(existing, input.identity);
      if (existing.checksum !== checksum) {
        throw new ValidationError("provider extraction artifact identity collision");
      }
      return structuredClone(existing);
    }
    const artifact: ProviderExtractionArtifact = {
      contract: PROVIDER_EXTRACTION_ARTIFACT_CONTRACT,
      identity: structuredClone(input.identity),
      result: structuredClone(input.result),
      artifactRef,
      checksum,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    assertProviderExtractionArtifact(artifact, input.identity);
    this.#byIdentity.set(identityKey, structuredClone(artifact));
    this.#byRef.set(artifactRef, structuredClone(artifact));
    return structuredClone(artifact);
  }

  async resolve(artifactRef: string): Promise<ProviderExtractionArtifact> {
    const artifact = this.#byRef.get(artifactRef);
    if (artifact === undefined) {
      throw new ValidationError(`provider extraction artifact not found: ${artifactRef}`);
    }
    assertProviderExtractionArtifact(artifact);
    return structuredClone(artifact);
  }

  async verify(artifactRef: string, expectedChecksum: string): Promise<boolean> {
    try {
      const artifact = await this.resolve(artifactRef);
      return artifact.checksum === expectedChecksum;
    } catch {
      return false;
    }
  }
}
