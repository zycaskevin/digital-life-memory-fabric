import { ValidationError } from "../domain/errors.js";
import type { MemoryId, MemoryRevision } from "../domain/types.js";

/**
 * Selects bounded canonical evidence for reflection. Preferred memories are used
 * when the designated source produced canonical state; otherwise reflection
 * falls back to the available canonical set instead of silently not running.
 */
export function selectCanonicalReflectionSource(
  available: readonly MemoryRevision[],
  preferredMemoryIds: readonly MemoryId[],
  limit = 5,
): MemoryRevision[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ValidationError("reflection source limit must be a positive integer");
  }
  const latestByMemoryId = new Map<MemoryId, MemoryRevision>();
  for (const revision of available) {
    const current = latestByMemoryId.get(revision.memoryId);
    if (current === undefined || revision.revision > current.revision) {
      latestByMemoryId.set(revision.memoryId, revision);
    }
  }
  const distinctLatest = [...latestByMemoryId.values()];
  const preferredIds = new Set(preferredMemoryIds);
  const preferred = distinctLatest.filter((revision) => preferredIds.has(revision.memoryId));
  return (preferred.length > 0 ? preferred : distinctLatest).slice(0, limit);
}
