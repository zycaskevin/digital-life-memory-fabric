import type {
  MemoryId,
  MemoryRevision,
  MemoryScope,
} from "../domain/types.js";
import { sameScope } from "../domain/utils.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";

export type VerificationResult =
  | { decision: "ALLOW"; revision: MemoryRevision }
  | {
      decision: "SUPPRESS";
      reason:
        | "NOT_FOUND"
        | "SCOPE_MISMATCH"
        | "TOMBSTONED"
        | "SUPERSEDED"
        | "REVISION_MISSING";
    };

export class CanonicalVerifier {
  constructor(private readonly store: CanonicalMemoryStore) {}

  async verify(memoryId: MemoryId, scope: MemoryScope): Promise<VerificationResult> {
    const head = await this.store.getHead(memoryId);
    if (head === undefined) {
      return { decision: "SUPPRESS", reason: "NOT_FOUND" };
    }

    if (!sameScope(head.scope, scope)) {
      return { decision: "SUPPRESS", reason: "SCOPE_MISMATCH" };
    }

    if (head.status === "tombstoned") {
      return { decision: "SUPPRESS", reason: "TOMBSTONED" };
    }

    if (head.status === "superseded") {
      return { decision: "SUPPRESS", reason: "SUPERSEDED" };
    }

    const revision = await this.store.getRevision(
      head.memoryId,
      head.currentRevision,
    );
    if (revision === undefined) {
      return { decision: "SUPPRESS", reason: "REVISION_MISSING" };
    }

    return { decision: "ALLOW", revision };
  }
}
