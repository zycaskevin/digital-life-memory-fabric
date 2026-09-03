import type { MemoryScope } from "../domain/types.js";

export interface RawExperienceArchiveRequest {
  scope: MemoryScope;
  sourceType: string;
  sourceId: string;
  content: string;
  contentType: string;
  createdAt?: string;
  observedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ArchivedRawExperience extends RawExperienceArchiveRequest {
  archiveRef: string;
  checksum: string;
  archivedAt: string;
}

export interface RawExperienceArchiveProvider {
  readonly name: string;
  archive(request: RawExperienceArchiveRequest): Promise<ArchivedRawExperience>;
  resolve(archiveRef: string): Promise<ArchivedRawExperience>;
  verify(archiveRef: string, expectedChecksum: string): Promise<boolean>;
}
