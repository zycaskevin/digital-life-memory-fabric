import { setTimeout as sleep } from "node:timers/promises";

const TRANSIENT_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Only recognize the installed Hindsight SDK's transport failure shape.
 * Never turn a schema, authorization, validation, cancellation, or admission
 * error into a retry. Error text/details are deliberately not logged.
 */
export function isTransientHindsightProjectionError(error) {
  if (!(error instanceof Error) || error.name !== "HindsightError") return false;
  if (error.statusCode !== undefined && error.statusCode !== null) {
    return TRANSIENT_HTTP_STATUS.has(error.statusCode);
  }
  return error.message === 'retainBatch failed: "fetch failed"'
    && error.details === "fetch failed";
}

function freezeTree(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}

/** Migration-local projection wrapper, not a distillation or Canonical writer.
 *
 * The existing projection port derives the same bank + documentId from the
 * pinned scope/memoryId/revision. The installed provider upserts document IDs;
 * DLMF Canonical commits are never repeated here. Only a fulfilled project()
 * returns success. Exhaustion still propagates failure to the checkpoint gate.
 * Default maxAttempts=1 preserves existing callers' behavior.
 */
export function withCanonicalProjectionRetry(port, {
  maxAttempts = 1,
  baseDelayMs = 1000,
  wait = sleep,
  onRetry = () => {},
} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("projection retry maxAttempts must be an integer from 1 to 3");
  }
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 10000) {
    throw new Error("projection retry baseDelayMs must be an integer from 0 to 10000");
  }
  if (!port || typeof port.project !== "function" || typeof port.search !== "function") {
    throw new Error("projection port must implement project and search");
  }
  if (typeof wait !== "function" || typeof onRetry !== "function") {
    throw new Error("projection retry callbacks must be functions");
  }
  return {
    async project(revision) {
      if (maxAttempts === 1) return port.project(revision);
      if (!revision || typeof revision.memoryId !== "string"
        || !/^mem_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(revision.memoryId)
        || !Number.isSafeInteger(revision.revision) || revision.revision < 1) {
        throw new Error("projection retry requires a stable Canonical revision identity");
      }
      const pinned = freezeTree(structuredClone(revision));
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await port.project(pinned);
        } catch (error) {
          if (attempt === maxAttempts || !isTransientHindsightProjectionError(error)) throw error;
          const delayMs = baseDelayMs * 2 ** (attempt - 1);
          onRetry({ code: "HINDSIGHT_PROJECTION_TRANSIENT", attempt, nextAttempt: attempt + 1, delayMs });
          await wait(delayMs);
        }
      }
      throw new Error("projection retry exhausted without a result");
    },
    search(...args) {
      return port.search(...args);
    },
  };
}
