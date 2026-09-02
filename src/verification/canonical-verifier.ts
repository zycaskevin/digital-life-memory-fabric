import { ValidationError } from "../domain/errors.js";
import type {
  CanonicalMemoryHead,
  MemoryId,
  MemoryRevision,
  MemoryScope,
} from "../domain/types.js";
import {
  SystemClock,
  sameScope,
  sha256,
  stableStringify,
  type Clock,
} from "../domain/utils.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";

export type VerificationSuppressionReason =
  | "NOT_FOUND"
  | "SCOPE_MISMATCH"
  | "TOMBSTONED"
  | "SUPERSEDED"
  | "REVISION_MISSING"
  | "REVISION_MISMATCH"
  | "REVISION_INTEGRITY"
  | "NOT_YET_VALID"
  | "NO_LONGER_VALID"
  | "HEAD_CHANGED";

export type VerificationResult =
  | { decision: "ALLOW"; revision: MemoryRevision }
  | {
      decision: "SUPPRESS";
      reason: VerificationSuppressionReason;
    };

export interface VerificationRequest {
  readonly memoryId: MemoryId;
  readonly expectedRevision?: number;
}

export interface VerificationOptions {
  readonly expectedRevision?: number;
  readonly effectiveAt?: string;
}

export class CanonicalVerifier {
  constructor(
    private readonly store: CanonicalMemoryStore,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async verify(
    memoryId: MemoryId,
    scope: MemoryScope,
    options: VerificationOptions = {},
  ): Promise<VerificationResult> {
    const result = await this.verifyMany(
      [
        {
          memoryId,
          ...(options.expectedRevision === undefined
            ? {}
            : { expectedRevision: options.expectedRevision }),
        },
      ],
      scope,
      options.effectiveAt === undefined
        ? {}
        : { effectiveAt: options.effectiveAt },
    );
    const decision = result[0];
    if (decision === undefined) {
      throw new Error("Canonical verifier lost a single verification result");
    }
    return decision;
  }

  async verifyMany(
    requests: readonly VerificationRequest[],
    scope: MemoryScope,
    options: Pick<VerificationOptions, "effectiveAt"> = {},
  ): Promise<VerificationResult[]> {
    if (requests.length === 0) return [];
    const effectiveAt = options.effectiveAt ?? this.clock.now();
    const effectiveTime = Date.parse(effectiveAt);
    if (Number.isNaN(effectiveTime)) {
      throw new ValidationError("effectiveAt must be a valid ISO-8601 timestamp");
    }
    for (const request of requests) {
      if (
        request.expectedRevision !== undefined &&
        (!Number.isSafeInteger(request.expectedRevision) ||
          request.expectedRevision < 1)
      ) {
        throw new ValidationError(
          "expectedRevision must be a positive safe integer when present",
        );
      }
    }

    const memoryIds = requests.map((request) => request.memoryId);
    const initialHeads = await this.store.getHeads(memoryIds);
    const provisional: Array<VerificationResult | undefined> = requests.map(
      () => undefined,
    );
    const revisionReferences: Array<{
      requestIndex: number;
      memoryId: MemoryId;
      revision: number;
    }> = [];

    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const head = initialHeads[index];
      if (request === undefined) continue;
      const suppressed = suppressHead(head, request.expectedRevision, scope);
      if (suppressed !== undefined) {
        provisional[index] = suppressed;
        continue;
      }
      revisionReferences.push({
        requestIndex: index,
        memoryId: head!.memoryId,
        revision: head!.currentRevision,
      });
    }

    const revisions = await this.store.getRevisions(
      revisionReferences.map(({ memoryId, revision }) => ({ memoryId, revision })),
    );
    for (let index = 0; index < revisionReferences.length; index += 1) {
      const reference = revisionReferences[index];
      if (reference === undefined) continue;
      const head = initialHeads[reference.requestIndex];
      const revision = revisions[index];
      provisional[reference.requestIndex] = verifyRevision(
        head!,
        revision,
        scope,
        effectiveTime,
      );
    }

    // Re-read heads so an accepted revision has a stable linearization point
    // without taking write locks on the canonical commit path.
    const finalHeads = await this.store.getHeads(memoryIds);
    for (let index = 0; index < provisional.length; index += 1) {
      if (provisional[index]?.decision !== "ALLOW") continue;
      if (!sameHead(initialHeads[index], finalHeads[index])) {
        provisional[index] = { decision: "SUPPRESS", reason: "HEAD_CHANGED" };
      }
    }

    return provisional.map(
      (result) => result ?? { decision: "SUPPRESS", reason: "NOT_FOUND" },
    );
  }
}

function suppressHead(
  head: CanonicalMemoryHead | undefined,
  expectedRevision: number | undefined,
  scope: MemoryScope,
): VerificationResult | undefined {
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
    if (
      expectedRevision !== undefined &&
      head.currentRevision !== expectedRevision
    ) {
      return { decision: "SUPPRESS", reason: "REVISION_MISMATCH" };
    }
    return undefined;
}

function verifyRevision(
  head: CanonicalMemoryHead,
  revision: MemoryRevision | undefined,
  scope: MemoryScope,
  effectiveTime: number,
): VerificationResult {
  if (revision === undefined) {
    return { decision: "SUPPRESS", reason: "REVISION_MISSING" };
  }
  const validFromTime =
    revision.validFrom === undefined ? undefined : Date.parse(revision.validFrom);
  const validUntilTime =
    revision.validUntil === undefined ? undefined : Date.parse(revision.validUntil);
  if (
    revision.memoryId !== head.memoryId ||
    revision.revision !== head.currentRevision ||
    !sameScope(revision.scope, scope) ||
    revision.status !== head.status ||
    revision.memoryClass !== head.memoryClass ||
    revision.memoryKind !== head.memoryKind ||
    revision.contentHash !== sha256(revision.canonicalContent) ||
    (validFromTime !== undefined && Number.isNaN(validFromTime)) ||
    (validUntilTime !== undefined && Number.isNaN(validUntilTime)) ||
    (validFromTime !== undefined &&
      validUntilTime !== undefined &&
      validUntilTime < validFromTime)
  ) {
    return { decision: "SUPPRESS", reason: "REVISION_INTEGRITY" };
  }
  if (
    validFromTime !== undefined &&
    validFromTime > effectiveTime
  ) {
    return { decision: "SUPPRESS", reason: "NOT_YET_VALID" };
  }
  if (
    validUntilTime !== undefined &&
    validUntilTime < effectiveTime
  ) {
    return { decision: "SUPPRESS", reason: "NO_LONGER_VALID" };
  }
  return { decision: "ALLOW", revision };
}

function sameHead(
  left: CanonicalMemoryHead | undefined,
  right: CanonicalMemoryHead | undefined,
): boolean {
  return stableStringify(left) === stableStringify(right);
}
