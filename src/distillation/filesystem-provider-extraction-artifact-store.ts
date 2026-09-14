import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

const PREFIX = "provider-extraction+filesystem://";

function relativeFor(identity: ProviderExtractionArtifactIdentity): string {
  const digest = providerExtractionArtifactIdentityKey(identity).slice("sha256:".length);
  return join(digest.slice(0, 2), `${digest}.json`);
}

function notFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function alreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

export class FilesystemProviderExtractionArtifactStore
  implements ProviderExtractionArtifactStore
{
  readonly #root: string;

  constructor(rootDirectory: string) {
    if (rootDirectory.trim().length === 0) {
      throw new ValidationError("provider extraction artifact rootDirectory must not be empty");
    }
    this.#root = resolve(rootDirectory);
  }

  async get(
    identity: ProviderExtractionArtifactIdentity,
  ): Promise<ProviderExtractionArtifact | undefined> {
    const artifactRef = `${PREFIX}${relativeFor(identity)}`;
    try {
      const artifact = await this.resolve(artifactRef);
      assertProviderExtractionArtifact(artifact, identity);
      return artifact;
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  }

  async put(input: ProviderExtractionArtifactWrite): Promise<ProviderExtractionArtifact> {
    const relative = relativeFor(input.identity);
    const artifactRef = `${PREFIX}${relative}`;
    const target = this.#target(relative);
    const checksum = providerExtractionArtifactChecksum(input.identity, input.result);
    const artifact: ProviderExtractionArtifact = {
      contract: PROVIDER_EXTRACTION_ARTIFACT_CONTRACT,
      identity: structuredClone(input.identity),
      result: structuredClone(input.result),
      artifactRef,
      checksum,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    assertProviderExtractionArtifact(artifact, input.identity);

    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await chmod(dirname(target), 0o700);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(artifact), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await link(temp, target);
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      const existing = await this.resolve(artifactRef);
      assertProviderExtractionArtifact(existing, input.identity);
      if (existing.checksum !== checksum) {
        throw new ValidationError("provider extraction artifact identity collision");
      }
      return existing;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    return structuredClone(artifact);
  }

  async resolve(artifactRef: string): Promise<ProviderExtractionArtifact> {
    if (!artifactRef.startsWith(PREFIX)) {
      throw new ValidationError(`Unsupported provider extraction artifact ref: ${artifactRef}`);
    }
    const relative = artifactRef.slice(PREFIX.length);
    const target = this.#target(relative);
    const parsed = JSON.parse(await readFile(target, "utf8")) as ProviderExtractionArtifact;
    if (parsed.artifactRef !== artifactRef) {
      throw new ValidationError("provider extraction artifact ref does not match stored record");
    }
    assertProviderExtractionArtifact(parsed);
    return structuredClone(parsed);
  }

  async verify(artifactRef: string, expectedChecksum: string): Promise<boolean> {
    try {
      const artifact = await this.resolve(artifactRef);
      return artifact.checksum === expectedChecksum;
    } catch {
      return false;
    }
  }

  #target(relative: string): string {
    const target = resolve(this.#root, relative);
    if (target !== this.#root && !target.startsWith(`${this.#root}/`)) {
      throw new ValidationError("provider extraction artifact ref escapes configured rootDirectory");
    }
    return target;
  }
}
