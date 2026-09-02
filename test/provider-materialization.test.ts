import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalMemoryAuthority,
  CentralOperationsService,
  InMemoryCanonicalMemoryStore,
  MaterializationWorker,
  MemoryCandidateService,
  OutboxClaimConflictError,
  RandomIdFactory,
  type Clock,
  type MemoryFabricMaterializationEvent,
  type MemoryMaterializationDeliveryPort,
  type MemoryScope,
} from "../src/index.js";

class MutableClock implements Clock {
  private current = Date.parse("2026-09-02T12:00:00.000Z");

  now(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

interface StoredProviderRecord {
  revision: number;
  content: string;
  providerObjectId: string;
}

class DeterministicDeliveryPort implements MemoryMaterializationDeliveryPort {
  readonly events: MemoryFabricMaterializationEvent[] = [];
  private readonly records = new Map<string, StoredProviderRecord>();

  async execute(event: MemoryFabricMaterializationEvent): Promise<unknown> {
    this.events.push(event);
    const key = [
      event.tenant_id,
      event.life_did,
      event.memory_namespace,
      event.memory_id,
    ].join("\u001f");
    const current = this.records.get(key);

    if (event.intent === "DELETE") {
      this.records.delete(key);
      const status = current === undefined ? "NOT_FOUND" : "SUCCESS";
      return this.receipt(event, status, current?.providerObjectId);
    }

    assert.ok(event.canonical_content);
    if (current?.revision === event.canonical_revision) {
      assert.equal(current.content, event.canonical_content.text);
      return this.receipt(event, "ALREADY_CURRENT", current.providerObjectId);
    }
    const providerObjectId =
      `reference:${event.memory_id}:r${event.canonical_revision}`;
    this.records.set(key, {
      revision: event.canonical_revision,
      content: event.canonical_content.text,
      providerObjectId,
    });
    return this.receipt(event, "SUCCESS", providerObjectId);
  }

  private receipt(
    event: MemoryFabricMaterializationEvent,
    status: "SUCCESS" | "ALREADY_CURRENT" | "NOT_FOUND",
    providerObjectId: string | undefined,
  ): unknown {
    return {
      event_type: event.event_type,
      event_version: event.event_version,
      outbox_id: event.outbox_id,
      request_id: event.request_id,
      memory_id: event.memory_id,
      canonical_revision: event.canonical_revision,
      commit_seq: event.commit_seq,
      provider_id: "memory-reference",
      status,
      retryable: false,
      canonical_commit_affected: false,
      provider_receipt: {
        providerId: "memory-reference",
        memoryId: event.memory_id,
        canonicalRevision: event.canonical_revision,
        status,
        ...(providerObjectId === undefined ? {} : { providerObjectId }),
      },
    };
  }
}

const scope: MemoryScope = {
  tenantId: "tenant_materialization",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

function createHarness(delivery: MemoryMaterializationDeliveryPort) {
  const store = new InMemoryCanonicalMemoryStore();
  const ids = new RandomIdFactory();
  const clock = new MutableClock();
  const operations = new CentralOperationsService(store, clock);
  return {
    store,
    clock,
    candidates: new MemoryCandidateService(store, ids, clock),
    authority: new CanonicalMemoryAuthority(store, ids, clock),
    operations,
    worker: new MaterializationWorker(operations, delivery, clock),
  };
}

async function commitCreate(harness: ReturnType<typeof createHarness>) {
  const candidate = await harness.candidates.ingest({
    scope,
    origin: {
      lifeDid: scope.lifeDid,
      runtimeId: "hermes-gb10",
      deviceId: "gb10",
    },
    candidateType: "materialization_episode",
    sourceType: "task_result",
    sourceId: "materialization:create:1",
    memoryClass: "episode",
    memoryKind: "provider_delivery_acceptance",
    proposedContent: {
      text: "Canonical memory materializes through OmniHarness.",
      payload: { memoryClass: "episode", source: "dlfm-004-test" },
    },
    evidenceRefs: [
      { sourceType: "task_result", sourceRef: "materialization:create:1" },
    ],
    proposedOperation: "create",
  });
  return harness.authority.commit({
    candidateId: candidate.candidateId,
    idempotencyKey: "materialization-create-1",
  });
}

const workerInput = {
  scope,
  workerId: "omniharness-worker-1",
  leaseMs: 10_000,
  deliveryTimeoutMs: 1_000,
  retryDelayMs: 5_000,
} as const;

test("DLFM-004 emits the exact OH-MEM-002 event and settles provider state", async () => {
  const delivery = new DeterministicDeliveryPort();
  const harness = createHarness(delivery);
  const created = await commitCreate(harness);

  const run = await harness.worker.runOnce(workerInput);
  assert.equal(run.claimed, 1);
  const result = run.items[0];
  assert.ok(result);
  assert.equal(result.event.event_id, created.change.eventId);
  assert.equal(result.event.outbox_id, created.outbox.outboxId);
  assert.equal(result.event.request_id, `ohmat:${created.outbox.outboxId}`);
  assert.equal(result.event.intent, "UPSERT");
  assert.equal(result.event.canonical_content?.text, created.revision.canonicalContent.text);
  assert.deepEqual(result.event.canonical_content?.payload, {
    memoryClass: "episode",
    source: "dlfm-004-test",
  });
  assert.equal(
    result.event.idempotency_key,
    `memory.materialization:${created.head.memoryId}:1`,
  );
  assert.equal(result.receipt?.status, "SUCCESS");
  assert.equal(result.settlement.record.status, "DONE");

  const materializations = await harness.operations.readProviderMaterializations({
    scope,
  });
  assert.deepEqual(
    materializations.materializations.map((value) => ({
      providerName: value.providerName,
      providerId: value.providerId,
      status: value.status,
      canonicalRevision: value.canonicalRevision,
      materializedRevision: value.materializedRevision,
    })),
    [
      {
        providerName: "memory-reference",
        providerId: `reference:${created.head.memoryId}:r1`,
        status: "CURRENT",
        canonicalRevision: 1,
        materializedRevision: 1,
      },
    ],
  );
  assert.equal((await harness.worker.runOnce(workerInput)).claimed, 0);

  harness.clock.advance(1_000);
  const tombstone = await harness.candidates.ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, runtimeId: "hermes-gb10" },
    candidateType: "deletion_request",
    sourceType: "user_explicit_statement",
    sourceId: "materialization:tombstone:2",
    memoryClass: created.head.memoryClass,
    memoryKind: created.head.memoryKind,
    proposedContent: { text: "Delete this memory." },
    evidenceRefs: [
      {
        sourceType: "user_explicit_statement",
        sourceRef: "materialization:tombstone:2",
      },
    ],
    proposedOperation: "tombstone",
    baseMemoryId: created.head.memoryId,
    baseRevision: 1,
  });
  const tombstoned = await harness.authority.commit({
    candidateId: tombstone.candidateId,
    idempotencyKey: "materialization-tombstone-2",
  });
  const deletion = await harness.worker.runOnce(workerInput);
  assert.equal(deletion.items[0]?.event.intent, "DELETE");
  assert.equal("canonical_content" in (deletion.items[0]?.event ?? {}), false);
  assert.equal(deletion.items[0]?.receipt?.status, "SUCCESS");
  assert.equal(deletion.items[0]?.settlement.record.status, "DONE");
  assert.equal(
    deletion.items[0]?.event.event_id,
    tombstoned.change.eventId,
  );
});

test("delivery failure retries without inventing a provider materialization", async () => {
  const reference = new DeterministicDeliveryPort();
  let fail = true;
  const delivery: MemoryMaterializationDeliveryPort = {
    async execute(event, options) {
      assert.equal(options?.signal.aborted, false);
      if (fail) {
        fail = false;
        throw new Error("OmniHarness transport offline");
      }
      return reference.execute(event);
    },
  };
  const harness = createHarness(delivery);
  await commitCreate(harness);

  const first = await harness.worker.runOnce(workerInput);
  assert.equal(first.items[0]?.settlement.record.status, "FAILED");
  assert.equal(first.items[0]?.deliveryError, "OmniHarness transport offline");
  assert.deepEqual(first.items[0]?.settlement.materializations, []);
  assert.deepEqual(
    (await harness.operations.readProviderMaterializations({ scope }))
      .materializations,
    [],
  );
  assert.equal((await harness.worker.runOnce(workerInput)).claimed, 0);

  harness.clock.advance(5_000);
  const retry = await harness.worker.runOnce(workerInput);
  assert.equal(retry.claimed, 1);
  assert.equal(retry.items[0]?.receipt?.status, "SUCCESS");
  assert.equal(retry.items[0]?.settlement.record.status, "DONE");
  assert.equal(retry.items[0]?.settlement.record.attempts, 2);
  assert.deepEqual(
    (await harness.operations.readProviderMaterializations({ scope }))
      .materializations.map((value) => value.providerName),
    ["memory-reference"],
  );
});

test("correlation mismatch fails closed and schedules a provider-neutral retry", async () => {
  const delivery: MemoryMaterializationDeliveryPort = {
    async execute(event) {
      return {
        event_type: event.event_type,
        event_version: event.event_version,
        outbox_id: "out_wrong",
        request_id: event.request_id,
        memory_id: event.memory_id,
        canonical_revision: event.canonical_revision,
        commit_seq: event.commit_seq,
        provider_id: "memory-reference",
        status: "SUCCESS",
        retryable: false,
        canonical_commit_affected: false,
      };
    },
  };
  const harness = createHarness(delivery);
  await commitCreate(harness);

  const run = await harness.worker.runOnce(workerInput);
  assert.match(run.items[0]?.deliveryError ?? "", /outbox_id does not match/);
  assert.equal(run.items[0]?.settlement.record.status, "FAILED");
  assert.deepEqual(run.items[0]?.settlement.materializations, []);
});

test("delivery timeout aborts the port and schedules retry before lease expiry", async () => {
  let aborted = false;
  const delivery: MemoryMaterializationDeliveryPort = {
    async execute(_event, options) {
      return new Promise((_resolve, reject) => {
        options?.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("delivery aborted"));
          },
          { once: true },
        );
      });
    },
  };
  const harness = createHarness(delivery);
  await commitCreate(harness);

  const run = await harness.worker.runOnce({
    scope,
    workerId: "timeout-worker",
    leaseMs: 1_000,
    deliveryTimeoutMs: 100,
    retryDelayMs: 1_000,
  });
  assert.equal(aborted, true);
  assert.equal(run.items[0]?.settlement.record.status, "FAILED");
  assert.match(run.items[0]?.deliveryError ?? "", /delivery aborted|timed out/);
  assert.deepEqual(run.items[0]?.settlement.materializations, []);
});

test("provider idempotency closes a replay after the first claim lease expires", async () => {
  const reference = new DeterministicDeliveryPort();
  let first = true;
  let harness!: ReturnType<typeof createHarness>;
  const delivery: MemoryMaterializationDeliveryPort = {
    async execute(event, options) {
      const receipt = await reference.execute(event);
      if (first) {
        first = false;
        harness.clock.advance(10_001);
      }
      return receipt;
    },
  };
  harness = createHarness(delivery);
  await commitCreate(harness);

  await assert.rejects(
    harness.worker.runOnce(workerInput),
    OutboxClaimConflictError,
  );
  const replay = await harness.worker.runOnce(workerInput);
  assert.equal(replay.items[0]?.receipt?.status, "ALREADY_CURRENT");
  assert.equal(replay.items[0]?.settlement.record.status, "DONE");
  assert.equal(replay.items[0]?.settlement.record.attempts, 2);
  assert.equal(reference.events.length, 2);
  assert.equal(reference.events[0]?.event_id, reference.events[1]?.event_id);
  assert.equal(reference.events[0]?.request_id, reference.events[1]?.request_id);
  assert.equal(
    reference.events[0]?.idempotency_key,
    reference.events[1]?.idempotency_key,
  );
});
