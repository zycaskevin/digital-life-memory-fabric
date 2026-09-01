import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalMemoryAuthority,
  ChangeSequenceGapError,
  DeviceCheckpointConflictError,
  InMemoryCanonicalMemoryStore,
  MemoryCandidateService,
  MemorySyncService,
  RandomIdFactory,
  SyncRevisionIntegrityError,
  ValidationError,
  type Clock,
  type MemoryId,
  type MemoryChangeEnvelope,
  type MemoryRevision,
  type MemoryRevisionRef,
  type MemoryScope,
} from "../src/index.js";

class SyncTestClock implements Clock {
  private tick = 0;

  now(): string {
    const value = new Date(Date.UTC(2026, 8, 1, 15, 0, this.tick));
    this.tick += 1;
    return value.toISOString();
  }
}

const scope: MemoryScope = {
  tenantId: "tenant_sync",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

function createHarness(
  store: InMemoryCanonicalMemoryStore = new InMemoryCanonicalMemoryStore(),
) {
  const ids = new RandomIdFactory();
  const clock = new SyncTestClock();
  return {
    store,
    candidates: new MemoryCandidateService(store, ids, clock),
    authority: new CanonicalMemoryAuthority(store, ids, clock),
    sync: new MemorySyncService(store, clock),
  };
}

class MissingRevisionStore extends InMemoryCanonicalMemoryStore {
  override async getRevisions(
    references: readonly MemoryRevisionRef[],
  ): Promise<Array<MemoryRevision | undefined>> {
    return references.map(() => undefined);
  }
}

class CorruptChangeStore extends InMemoryCanonicalMemoryStore {
  override async listChangesAfter(
    requestedScope: MemoryScope,
    afterCommitSeq: number,
    limit?: number,
  ): Promise<MemoryChangeEnvelope[]> {
    const changes = await super.listChangesAfter(
      requestedScope,
      afterCommitSeq,
      limit,
    );
    const first = changes[0];
    if (first !== undefined) {
      first.payloadHash = "sha256:corrupt";
    }
    return changes;
  }
}

class CountingBulkStore extends InMemoryCanonicalMemoryStore {
  bulkReads = 0;
  singleReads = 0;

  override async getRevision(
    memoryId: MemoryId,
    revision: number,
  ): Promise<MemoryRevision | undefined> {
    this.singleReads += 1;
    return super.getRevision(memoryId, revision);
  }

  override async getRevisions(
    references: readonly MemoryRevisionRef[],
  ): Promise<Array<MemoryRevision | undefined>> {
    this.bulkReads += 1;
    return super.getRevisions(references);
  }
}

async function commitEpisodes(
  harness: ReturnType<typeof createHarness>,
  count: number,
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const candidate = await harness.candidates.ingest({
      scope,
      origin: {
        lifeDid: scope.lifeDid,
        runtimeId: "hermes-gb10",
        deviceId: "gb10",
      },
      candidateType: "sync_episode",
      sourceType: "task_result",
      sourceId: `sync:${index}`,
      memoryClass: "episode",
      memoryKind: "sync_acceptance",
      proposedContent: { text: `Canonical sync event ${index}.` },
      evidenceRefs: [{ sourceType: "task_result", sourceRef: `sync:${index}` }],
      proposedOperation: "create",
    });
    await harness.authority.commit({
      candidateId: candidate.candidateId,
      idempotencyKey: `sync-commit-${index}`,
    });
  }
}

test("change feed replay is ordered and device pull advances only after acknowledgement", async () => {
  const harness = createHarness();
  await commitEpisodes(harness, 3);

  const replay = await harness.sync.replay({
    scope,
    afterCommitSeq: 0,
    limit: 2,
  });
  assert.deepEqual(
    replay.changes.map((entry) => entry.envelope.commitSeq),
    [1, 2],
  );
  assert.equal(
    replay.changes[0]?.revision.canonicalContent.text,
    "Canonical sync event 1.",
  );
  assert.equal(replay.nextCommitSeq, 2);
  assert.equal(replay.hasMore, true);

  const firstPull = await harness.sync.pullForDevice({
    scope,
    deviceId: "prime-mac",
    limit: 2,
  });
  assert.equal(firstPull.lastAppliedCommitSeq, 0);
  assert.deepEqual(
    firstPull.changes.map((entry) => entry.envelope.commitSeq),
    [1, 2],
  );
  assert.equal(await harness.store.getDeviceCheckpoint(scope, "prime-mac"), undefined);

  const retryBeforeAcknowledgement = await harness.sync.pullForDevice({
    scope,
    deviceId: "prime-mac",
    limit: 2,
  });
  assert.deepEqual(retryBeforeAcknowledgement.changes, firstPull.changes);

  const checkpoint = await harness.sync.acknowledgeDeviceChanges({
    scope,
    deviceId: "prime-mac",
    expectedLastAppliedCommitSeq: 0,
    appliedThroughCommitSeq: firstPull.nextCommitSeq,
  });
  assert.equal(checkpoint.lastAppliedCommitSeq, 2);

  const secondPull = await harness.sync.pullForDevice({
    scope,
    deviceId: "prime-mac",
    limit: 2,
  });
  assert.equal(secondPull.lastAppliedCommitSeq, 2);
  assert.deepEqual(
    secondPull.changes.map((entry) => entry.envelope.commitSeq),
    [3],
  );
  assert.equal(secondPull.hasMore, false);

  await harness.sync.acknowledgeDeviceChanges({
    scope,
    deviceId: "prime-mac",
    expectedLastAppliedCommitSeq: 2,
    appliedThroughCommitSeq: 3,
  });
  const caughtUp = await harness.sync.pullForDevice({
    scope,
    deviceId: "prime-mac",
  });
  assert.equal(caughtUp.lastAppliedCommitSeq, 3);
  assert.deepEqual(caughtUp.changes, []);
  assert.equal(caughtUp.nextCommitSeq, 3);
});

test("device checkpoints reject stale, backward, and non-contiguous acknowledgements", async () => {
  const harness = createHarness();
  await commitEpisodes(harness, 2);

  await harness.sync.acknowledgeDeviceChanges({
    scope,
    deviceId: "gb10",
    expectedLastAppliedCommitSeq: 0,
    appliedThroughCommitSeq: 1,
  });

  await assert.rejects(
    harness.sync.acknowledgeDeviceChanges({
      scope,
      deviceId: "gb10",
      expectedLastAppliedCommitSeq: 0,
      appliedThroughCommitSeq: 2,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DeviceCheckpointConflictError);
      assert.equal(error.currentLastAppliedCommitSeq, 1);
      return true;
    },
  );

  await assert.rejects(
    harness.sync.acknowledgeDeviceChanges({
      scope,
      deviceId: "gb10",
      expectedLastAppliedCommitSeq: 1,
      appliedThroughCommitSeq: 0,
    }),
    ValidationError,
  );

  await assert.rejects(
    harness.sync.acknowledgeDeviceChanges({
      scope,
      deviceId: "gb10",
      expectedLastAppliedCommitSeq: 1,
      appliedThroughCommitSeq: 3,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChangeSequenceGapError);
      assert.equal(error.expectedCommitSeq, 3);
      return true;
    },
  );

  assert.equal(
    (await harness.store.getDeviceCheckpoint(scope, "gb10"))
      ?.lastAppliedCommitSeq,
    1,
  );
  await assert.rejects(
    harness.store.compareAndSetDeviceCheckpoint(
      {
        scope,
        deviceId: "gb10",
        lastAppliedCommitSeq: 0,
        lastSyncAt: "2026-09-01T16:00:00.000Z",
      },
      1,
    ),
    ValidationError,
  );
  assert.equal(await harness.store.getDeviceCheckpoint(scope, "prime-mac"), undefined);
  assert.equal(
    await harness.store.getDeviceCheckpoint(
      { ...scope, memoryNamespace: "project:omniharness" },
      "gb10",
    ),
    undefined,
  );
});

test("change replay fails closed when an immutable revision is unavailable", async () => {
  const harness = createHarness(new MissingRevisionStore());
  await commitEpisodes(harness, 1);

  await assert.rejects(
    harness.sync.readChanges({ scope, afterCommitSeq: 0 }),
    SyncRevisionIntegrityError,
  );
});

test("change replay fails closed when the envelope payload hash is corrupt", async () => {
  const harness = createHarness(new CorruptChangeStore());
  await commitEpisodes(harness, 1);

  await assert.rejects(
    harness.sync.readChanges({ scope, afterCommitSeq: 0 }),
    SyncRevisionIntegrityError,
  );
});

test("change replay hydrates an entire page through one bulk revision read", async () => {
  const store = new CountingBulkStore();
  const harness = createHarness(store);
  await commitEpisodes(harness, 3);

  const page = await harness.sync.readChanges({
    scope,
    afterCommitSeq: 0,
    limit: 3,
  });
  assert.equal(page.changes.length, 3);
  assert.equal(store.bulkReads, 1);
  assert.equal(store.singleReads, 0);
});
