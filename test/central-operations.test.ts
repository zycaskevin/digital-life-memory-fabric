import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalMemoryAuthority,
  CentralOperationsService,
  InMemoryCanonicalMemoryStore,
  MemoryCandidateService,
  MemorySyncService,
  OutboxClaimConflictError,
  RandomIdFactory,
  ValidationError,
  type ClaimTokenFactory,
  type Clock,
  type MemoryScope,
} from "../src/index.js";

class MutableClock implements Clock {
  private current = Date.parse("2026-09-02T08:00:00.000Z");

  now(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

class SequentialClaimTokens implements ClaimTokenFactory {
  private value = 0;

  create(): string {
    this.value += 1;
    return `claim-${this.value}`;
  }
}

const scope: MemoryScope = {
  tenantId: "tenant_operations",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

function createHarness() {
  const store = new InMemoryCanonicalMemoryStore();
  const ids = new RandomIdFactory();
  const clock = new MutableClock();
  return {
    store,
    clock,
    candidates: new MemoryCandidateService(store, ids, clock),
    authority: new CanonicalMemoryAuthority(store, ids, clock),
    sync: new MemorySyncService(store, clock),
    operations: new CentralOperationsService(
      store,
      clock,
      new SequentialClaimTokens(),
    ),
  };
}

async function commitEpisodes(
  harness: ReturnType<typeof createHarness>,
  count: number,
  requestedScope: MemoryScope = scope,
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    harness.clock.advance(1_000);
    const candidate = await harness.candidates.ingest({
      scope: requestedScope,
      origin: {
        lifeDid: requestedScope.lifeDid,
        runtimeId: "hermes-gb10",
        deviceId: "gb10",
      },
      candidateType: "operations_episode",
      sourceType: "task_result",
      sourceId: `${requestedScope.memoryNamespace}:operations:${index}`,
      memoryClass: "episode",
      memoryKind: "operations_acceptance",
      proposedContent: { text: `Central operations event ${index}.` },
      evidenceRefs: [
        {
          sourceType: "task_result",
          sourceRef: `${requestedScope.memoryNamespace}:operations:${index}`,
        },
      ],
      proposedOperation: "create",
    });
    await harness.authority.commit({
      candidateId: candidate.candidateId,
      idempotencyKey: `${requestedScope.memoryNamespace}:operations:${index}`,
    });
  }
}

test("central inventory and device fleet are scoped, bounded, and lag-aware", async () => {
  const harness = createHarness();
  await commitEpisodes(harness, 3);

  await harness.sync.acknowledgeDeviceChanges({
    scope,
    deviceId: "gb10",
    expectedLastAppliedCommitSeq: 0,
    appliedThroughCommitSeq: 1,
  });
  await harness.sync.acknowledgeDeviceChanges({
    scope,
    deviceId: "prime-mac",
    expectedLastAppliedCommitSeq: 0,
    appliedThroughCommitSeq: 2,
  });

  const first = await harness.operations.readMemoryInventory({
    scope,
    afterCommitSeq: 0,
    limit: 2,
  });
  assert.deepEqual(
    first.entries.map((entry) => entry.revision.commitSeq),
    [1, 2],
  );
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCommitSeq, 2);
  assert.equal(first.entries[0]?.revision.evidenceRefs.length, 1);

  const second = await harness.operations.readMemoryInventory({
    scope,
    afterCommitSeq: first.nextCommitSeq,
    limit: 2,
  });
  assert.deepEqual(
    second.entries.map((entry) => entry.revision.commitSeq),
    [3],
  );
  assert.equal(second.hasMore, false);

  const fleet = await harness.operations.readDeviceFleet({ scope, limit: 1 });
  assert.equal(fleet.devices[0]?.checkpoint.deviceId, "gb10");
  assert.equal(fleet.devices[0]?.lag, 2);
  assert.equal(fleet.hasMore, true);
  assert.ok(fleet.nextDeviceId);
  const fleetTail = await harness.operations.readDeviceFleet({
    scope,
    afterDeviceId: fleet.nextDeviceId,
    limit: 1,
  });
  assert.equal(fleetTail.devices[0]?.checkpoint.deviceId, "prime-mac");
  assert.equal(fleetTail.devices[0]?.lag, 1);

  const summary = await harness.operations.getNamespaceSummary(scope);
  assert.deepEqual(summary.memories, {
    total: 3,
    active: 3,
    tombstoned: 0,
    superseded: 0,
  });
  assert.deepEqual(summary.outbox, {
    pending: 3,
    processing: 0,
    done: 0,
    failed: 0,
  });
  assert.deepEqual(summary.devices, { total: 2, maxLag: 2 });
});

test("outbox claims are exclusive, fenced, recoverable, and atomically materialized", async () => {
  const harness = createHarness();
  await commitEpisodes(harness, 3);

  const [workerA, workerB] = await Promise.all([
    harness.operations.claimOutbox({
      scope,
      workerId: "worker-a",
      leaseMs: 10_000,
      limit: 2,
    }),
    harness.operations.claimOutbox({
      scope,
      workerId: "worker-b",
      leaseMs: 10_000,
      limit: 2,
    }),
  ]);
  const claimed = [...workerA, ...workerB];
  assert.equal(claimed.length, 3);
  assert.equal(new Set(claimed.map((item) => item.record.outboxId)).size, 3);
  assert.deepEqual(
    (await harness.operations.getNamespaceSummary(scope)).outbox,
    { pending: 0, processing: 3, done: 0, failed: 0 },
  );

  const success = workerA[0];
  assert.ok(success);
  await assert.rejects(
    harness.operations.settleOutbox({
      scope,
      outboxId: success.record.outboxId,
      workerId: success.record.claimedBy,
      claimToken: "stale-token",
      outcomes: [{ providerName: "hindsight", status: "CURRENT" }],
    }),
    OutboxClaimConflictError,
  );

  const settled = await harness.operations.settleOutbox({
    scope,
    outboxId: success.record.outboxId,
    workerId: success.record.claimedBy,
    claimToken: success.record.claimToken,
    outcomes: [
      {
        providerName: "hindsight",
        providerId: "provider-memory-1",
        status: "CURRENT",
      },
    ],
  });
  assert.equal(settled.record.status, "DONE");
  assert.equal(settled.materializations[0]?.materializedRevision, 1);

  const failed = workerA[1] ?? workerB[0];
  assert.ok(failed);
  const retryAt = new Date(Date.parse(harness.clock.now()) + 60_000).toISOString();
  const failedSettlement = await harness.operations.settleOutbox({
    scope,
    outboxId: failed.record.outboxId,
    workerId: failed.record.claimedBy,
    claimToken: failed.record.claimToken,
    outcomes: [
      {
        providerName: "vault",
        status: "UNAVAILABLE",
        lastError: "provider offline",
      },
    ],
    nextAttemptAt: retryAt,
  });
  assert.equal(failedSettlement.record.status, "FAILED");
  assert.equal(failedSettlement.record.nextAttemptAt, retryAt);
  assert.equal((await harness.operations.claimOutbox({
    scope,
    workerId: "worker-c",
    leaseMs: 10_000,
  })).length, 0);

  const stillLeased = claimed.find(
    (item) =>
      item.record.outboxId !== success.record.outboxId &&
      item.record.outboxId !== failed.record.outboxId,
  );
  assert.ok(stillLeased);
  harness.clock.advance(11_000);
  const reclaimed = await harness.operations.claimOutbox({
    scope,
    workerId: "worker-c",
    leaseMs: 10_000,
  });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0]?.record.outboxId, stillLeased.record.outboxId);
  assert.equal(reclaimed[0]?.record.attempts, 2);

  await assert.rejects(
    harness.operations.settleOutbox({
      scope,
      outboxId: stillLeased.record.outboxId,
      workerId: stillLeased.record.claimedBy,
      claimToken: stillLeased.record.claimToken,
      outcomes: [{ providerName: "mem0", status: "CURRENT" }],
    }),
    OutboxClaimConflictError,
  );

  harness.clock.advance(50_000);
  const retry = await harness.operations.claimOutbox({
    scope,
    workerId: "worker-d",
    leaseMs: 10_000,
  });
  assert.equal(
    retry.some((item) => item.record.outboxId === failed.record.outboxId),
    true,
  );

  const materializations = await harness.operations.readProviderMaterializations({
    scope,
  });
  assert.deepEqual(
    materializations.materializations.map((item) => [item.providerName, item.status]),
    [
      ["hindsight", "CURRENT"],
      ["vault", "UNAVAILABLE"],
    ],
  );
});

test("outbox preserves per-memory revision order", async () => {
  const harness = createHarness();
  await commitEpisodes(harness, 1);
  const inventory = await harness.operations.readMemoryInventory({
    scope,
    afterCommitSeq: 0,
  });
  const created = inventory.entries[0];
  assert.ok(created);

  harness.clock.advance(1_000);
  const update = await harness.candidates.ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, runtimeId: "hermes-gb10" },
    candidateType: "operations_episode_update",
    sourceType: "task_result",
    sourceId: "operations:update:2",
    memoryClass: created.head.memoryClass,
    memoryKind: created.head.memoryKind,
    proposedContent: { text: "Central operations event updated." },
    evidenceRefs: [
      { sourceType: "task_result", sourceRef: "operations:update:2" },
    ],
    proposedOperation: "update",
    baseMemoryId: created.head.memoryId,
    baseRevision: created.head.currentRevision,
  });
  await harness.authority.commit({
    candidateId: update.candidateId,
    idempotencyKey: "operations-update-2",
  });

  const first = await harness.operations.claimOutbox({
    scope,
    workerId: "worker-a",
    leaseMs: 10_000,
    limit: 2,
  });
  assert.deepEqual(first.map((item) => item.record.revision), [1]);
  assert.equal(
    (await harness.operations.claimOutbox({
      scope,
      workerId: "worker-b",
      leaseMs: 10_000,
      limit: 2,
    })).length,
    0,
  );

  const firstItem = first[0];
  assert.ok(firstItem);
  await harness.operations.settleOutbox({
    scope,
    outboxId: firstItem.record.outboxId,
    workerId: firstItem.record.claimedBy,
    claimToken: firstItem.record.claimToken,
    outcomes: [{ providerName: "hindsight", status: "CURRENT" }],
  });
  const second = await harness.operations.claimOutbox({
    scope,
    workerId: "worker-b",
    leaseMs: 10_000,
  });
  assert.deepEqual(second.map((item) => item.record.revision), [2]);
});

test("central operations reject invalid settlement and preserve namespace isolation", async () => {
  const harness = createHarness();
  const otherScope = { ...scope, memoryNamespace: "project:omniharness" };
  await commitEpisodes(harness, 1, scope);
  await commitEpisodes(harness, 1, otherScope);

  const claimed = await harness.operations.claimOutbox({
    scope,
    workerId: "worker-a",
    leaseMs: 10_000,
  });
  assert.equal(claimed.length, 1);
  assert.equal((await harness.operations.getNamespaceSummary(otherScope)).outbox.pending, 1);

  const work = claimed[0];
  assert.ok(work);
  await assert.rejects(
    harness.operations.settleOutbox({
      scope,
      outboxId: work.record.outboxId,
      workerId: work.record.claimedBy,
      claimToken: work.record.claimToken,
      outcomes: [
        { providerName: "vault", status: "FAILED", lastError: "timeout" },
      ],
    }),
    ValidationError,
  );

  await assert.rejects(
    harness.operations.readMemoryInventory({
      scope,
      afterCommitSeq: -1,
    }),
    ValidationError,
  );
});
