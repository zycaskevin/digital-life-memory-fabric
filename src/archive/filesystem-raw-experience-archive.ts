import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ValidationError } from "../domain/errors.js";
import { sha256 } from "../domain/utils.js";
import type {
  ArchivedRawExperience,
  RawExperienceArchiveProvider,
  RawExperienceArchiveRequest,
} from "./raw-experience-archive.js";

const PREFIX = "filesystem://";

export class FilesystemRawExperienceArchiveProvider
  implements RawExperienceArchiveProvider
{
  readonly name = "filesystem";

  constructor(private readonly rootDirectory: string) {
    if (rootDirectory.trim().length === 0) {
      throw new ValidationError("rootDirectory must not be empty");
    }
  }

  async archive(request: RawExperienceArchiveRequest): Promise<ArchivedRawExperience> {
    if (request.content.length === 0) throw new ValidationError("archive content must not be empty");
    const checksum = sha256({ content: request.content });
    const identity = sha256({
      scope: request.scope,
      sourceType: request.sourceType,
      sourceId: request.sourceId,
    }).replace("sha256:", "");
    const contentHash = checksum.replace("sha256:", "");
    const relative = join(identity.slice(0, 2), identity, `${contentHash}.json`);
    const target = resolve(this.rootDirectory, relative);
    await mkdir(dirname(target), { recursive: true });

    const archived: ArchivedRawExperience = {
      ...request,
      archiveRef: `${PREFIX}${relative}`,
      checksum,
      archivedAt: new Date().toISOString(),
    };
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(archived), { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temp, target);
    } catch (error) {
      // Concurrent/idempotent writers may have already created the same content-addressed file.
      try {
        const existing = await this.resolve(archived.archiveRef);
        if (existing.checksum === checksum) return existing;
      } catch {
        // Preserve the original archive error below.
      }
      throw error;
    }
    return archived;
  }

  async resolve(archiveRef: string): Promise<ArchivedRawExperience> {
    if (!archiveRef.startsWith(PREFIX)) {
      throw new ValidationError(`Unsupported filesystem archive ref: ${archiveRef}`);
    }
    const relative = archiveRef.slice(PREFIX.length);
    const target = resolve(this.rootDirectory, relative);
    const root = resolve(this.rootDirectory);
    if (target !== root && !target.startsWith(`${root}/`)) {
      throw new ValidationError("archiveRef escapes configured rootDirectory");
    }
    const parsed = JSON.parse(await readFile(target, "utf8")) as ArchivedRawExperience;
    if (parsed.archiveRef !== archiveRef) {
      throw new ValidationError("archiveRef does not match archived record");
    }
    return parsed;
  }

  async verify(archiveRef: string, expectedChecksum: string): Promise<boolean> {
    try {
      const archived = await this.resolve(archiveRef);
      return (
        archived.checksum === expectedChecksum &&
        sha256({ content: archived.content }) === expectedChecksum
      );
    } catch {
      return false;
    }
  }
}
