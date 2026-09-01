import {
  ChangeSequenceGapError,
  DeviceCheckpointConflictError,
  SyncRevisionIntegrityError,
  ValidationError,
} from "../domain/errors.js";
import type {
  AcknowledgeDeviceChangesInput,
  DeviceCheckpoint,
  DeviceSyncPull,
  MemoryChangeEnvelope,
  MemoryChangePage,
  MemoryScope,
  MemorySyncChange,
  PullDeviceChangesInput,
  ReadChangesInput,
} from "../domain/types.js";
import { sameScope, sha256, SystemClock, type Clock } from "../domain/utils.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";

export const DEFAULT_SYNC_BATCH_SIZE = 100;
export const MAX_SYNC_BATCH_SIZE = 1_000;

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} is required`);
  }
}

function validateScope(scope: MemoryScope): void {
  requireNonEmpty(scope.tenantId, "scope.tenantId");
  requireNonEmpty(scope.lifeDid, "scope.lifeDid");
  requireNonEmpty(scope.memoryNamespace, "scope.memoryNamespace");
}

function validateCommitSeq(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative safe integer`);
  }
}

function resolveLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_SYNC_BATCH_SIZE;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_SYNC_BATCH_SIZE
  ) {
    throw new ValidationError(
      `limit must be an integer between 1 and ${MAX_SYNC_BATCH_SIZE}`,
    );
  }
  return resolved;
}

function assertContiguous(
  changes: MemoryChangeEnvelope[],
  afterCommitSeq: number,
): void {
  for (const [index, change] of changes.entries()) {
    const expectedCommitSeq = afterCommitSeq + index + 1;
    if (change.commitSeq !== expectedCommitSeq) {
      throw new ChangeSequenceGapError(expectedCommitSeq, change.commitSeq);
    }
  }
}

async function hydrateChanges(
  store: CanonicalMemoryStore,
  envelopes: MemoryChangeEnvelope[],
): Promise<MemorySyncChange[]> {
  const revisions = await store.getRevisions(
    envelopes.map((envelope) => ({
      memoryId: envelope.memoryId,
      revision: envelope.newRevision,
    })),
  );
  return envelopes.map((envelope, index) => {
    const revision = revisions[index];
    if (revision === undefined) {
      throw new SyncRevisionIntegrityError(
        envelope.eventId,
        `missing immutable revision ${envelope.memoryId}@${envelope.newRevision}`,
      );
    }
    if (
      revision.memoryId !== envelope.memoryId ||
      revision.revision !== envelope.newRevision ||
      revision.commitSeq !== envelope.commitSeq ||
      !sameScope(revision.scope, envelope.scope) ||
      envelope.payloadHash !==
        sha256({
          memoryId: revision.memoryId,
          revision: revision.revision,
          status: revision.status,
          canonicalContent: revision.canonicalContent,
          contentHash: revision.contentHash,
        })
    ) {
      throw new SyncRevisionIntegrityError(
        envelope.eventId,
        "change envelope and immutable revision do not match",
      );
    }
    return { envelope, revision };
  });
}

export class MemorySyncService {
  constructor(
    private readonly store: CanonicalMemoryStore,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async readChanges(input: ReadChangesInput): Promise<MemoryChangePage> {
    validateScope(input.scope);
    validateCommitSeq(input.afterCommitSeq, "afterCommitSeq");
    const limit = resolveLimit(input.limit);
    const fetched = await this.store.listChangesAfter(
      input.scope,
      input.afterCommitSeq,
      limit + 1,
    );
    assertContiguous(fetched, input.afterCommitSeq);

    const hasMore = fetched.length > limit;
    const pageEnvelopes = fetched.slice(0, limit);
    const changes = await hydrateChanges(this.store, pageEnvelopes);
    const nextCommitSeq =
      pageEnvelopes.at(-1)?.commitSeq ?? input.afterCommitSeq;
    return {
      scope: { ...input.scope },
      afterCommitSeq: input.afterCommitSeq,
      nextCommitSeq,
      changes,
      hasMore,
    };
  }

  async replay(input: ReadChangesInput): Promise<MemoryChangePage> {
    return this.readChanges(input);
  }

  async pullForDevice(input: PullDeviceChangesInput): Promise<DeviceSyncPull> {
    validateScope(input.scope);
    requireNonEmpty(input.deviceId, "deviceId");
    const checkpoint = await this.store.getDeviceCheckpoint(
      input.scope,
      input.deviceId,
    );
    const lastAppliedCommitSeq = checkpoint?.lastAppliedCommitSeq ?? 0;
    const page = await this.readChanges({
      scope: input.scope,
      afterCommitSeq: lastAppliedCommitSeq,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return {
      ...page,
      deviceId: input.deviceId,
      lastAppliedCommitSeq,
    };
  }

  async acknowledgeDeviceChanges(
    input: AcknowledgeDeviceChangesInput,
  ): Promise<DeviceCheckpoint> {
    validateScope(input.scope);
    requireNonEmpty(input.deviceId, "deviceId");
    validateCommitSeq(
      input.expectedLastAppliedCommitSeq,
      "expectedLastAppliedCommitSeq",
    );
    validateCommitSeq(input.appliedThroughCommitSeq, "appliedThroughCommitSeq");
    if (input.appliedThroughCommitSeq < input.expectedLastAppliedCommitSeq) {
      throw new ValidationError(
        "appliedThroughCommitSeq must not move a device checkpoint backward",
      );
    }

    const advanceBy =
      input.appliedThroughCommitSeq - input.expectedLastAppliedCommitSeq;
    if (advanceBy > MAX_SYNC_BATCH_SIZE) {
      throw new ValidationError(
        `A device checkpoint may advance by at most ${MAX_SYNC_BATCH_SIZE} changes per acknowledgement`,
      );
    }

    if (advanceBy > 0) {
      const appliedChanges = await this.store.listChangesAfter(
        input.scope,
        input.expectedLastAppliedCommitSeq,
        advanceBy,
      );
      assertContiguous(appliedChanges, input.expectedLastAppliedCommitSeq);
      if (appliedChanges.length !== advanceBy) {
        throw new ChangeSequenceGapError(
          input.expectedLastAppliedCommitSeq + appliedChanges.length + 1,
          undefined,
        );
      }
    }

    const checkpoint: DeviceCheckpoint = {
      scope: { ...input.scope },
      deviceId: input.deviceId,
      lastAppliedCommitSeq: input.appliedThroughCommitSeq,
      lastSyncAt: this.clock.now(),
    };
    const advanced = await this.store.compareAndSetDeviceCheckpoint(
      checkpoint,
      input.expectedLastAppliedCommitSeq,
    );
    if (!advanced) {
      const current = await this.store.getDeviceCheckpoint(
        input.scope,
        input.deviceId,
      );
      throw new DeviceCheckpointConflictError(
        input.deviceId,
        input.expectedLastAppliedCommitSeq,
        current?.lastAppliedCommitSeq ?? 0,
      );
    }
    return checkpoint;
  }
}
