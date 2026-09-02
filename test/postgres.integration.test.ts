import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  CanonicalMemoryAuthority,
  CanonicalVerifier,
  CentralOperationsService,
  DeviceCheckpointConflictError,
  MaterializationWorker,
  MemoryCandidateService,
  MemorySyncService,
  OutboxClaimConflictError,
  PostgresCanonicalMemoryStore,
  RevisionConflictError,
  type MemoryFabricMaterializationEvent,
  type MemoryMaterializationDeliveryPort,
  type MemoryScope,
} from "../src/index.js";

const databaseUrl = process.env.DLFM_TEST_DATABASE_URL;
const maybeTest = databaseUrl === undefined ? test.skip : test;

maybeTest("PostgreSQL canonical core E2E preserves commit/revision/conflict/tombstone contracts", async () => {
  assert.ok(databaseUrl);
  const schema = `dlfm_test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);

  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  const store = new PostgresCanonicalMemoryStore(pool);

  try {
    const canonicalMigration = await readFile(
      "migrations/0001_canonical_core.sql",
      "utf8",
    );
    const operationsMigration = await readFile(
      "migrations/0002_central_operations.sql",
      "utf8",
    );
    await pool.query(canonicalMigration);
    await pool.query(operationsMigration);

    const candidates = new MemoryCandidateService(store);
    const authority = new CanonicalMemoryAuthority(store);
    const verifier = new CanonicalVerifier(store);
    const scope: MemoryScope = {
      tenantId: "tenant_pg",
      lifeDid: "did:life:nancy",
      memoryNamespace: "life.core",
    };

    const createCandidate = await candidates.ingest({
      scope,
      origin: {
        lifeDid: scope.lifeDid,
        agentId: "nancy",
        runtimeId: "hermes-gb10",
        deviceId: "gb10",
      },
      candidateType: "semantic_assertion",
      sourceType: "conversation",
      sourceId: "conversation:pg:1",
      memoryClass: "semantic_assertion",
      memoryKind: "architecture_boundary",
      proposedContent: { text: "OmniHarness does not own Agent orchestration." },
      evidenceRefs: [
        { sourceType: "conversation", sourceRef: "conversation:pg:1" },
      ],
      proposedOperation: "create",
    });

    const created = await authority.commit({
      candidateId: createCandidate.candidateId,
      idempotencyKey: "pg-create-1",
    });
    assert.equal(created.revision.revision, 1);
    assert.equal(created.change.commitSeq, 1);

    const retry = await authority.commit({
      candidateId: createCandidate.candidateId,
      idempotencyKey: "pg-create-1",
    });
    assert.equal(retry.change.eventId, created.change.eventId);

    const updateCandidate = await candidates.ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, runtimeId: "prime-mac", deviceId: "mac" },
      candidateType: "semantic_assertion_correction",
      sourceType: "conversation",
      sourceId: "conversation:pg:2",
      memoryClass: "semantic_assertion",
      memoryKind: "architecture_boundary",
      proposedContent: {
        text: "OmniHarness is provider abstraction only and does not own Agent orchestration.",
      },
      evidenceRefs: [
        { sourceType: "conversation", sourceRef: "conversation:pg:2" },
      ],
      proposedOperation: "update",
      baseMemoryId: created.head.memoryId,
      baseRevision: 1,
    });
    const updated = await authority.commit({
      candidateId: updateCandidate.candidateId,
      idempotencyKey: "pg-update-2",
    });
    assert.equal(updated.revision.revision, 2);
    assert.equal(updated.change.commitSeq, 2);

    const staleCandidate = await candidates.ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, runtimeId: "offline-mac", deviceId: "mac" },
      candidateType: "semantic_assertion_correction",
      sourceType: "conversation",
      sourceId: "conversation:pg:stale",
      memoryClass: "semantic_assertion",
      memoryKind: "architecture_boundary",
      proposedContent: { text: "Stale edit." },
      evidenceRefs: [
        { sourceType: "conversation", sourceRef: "conversation:pg:stale" },
      ],
      proposedOperation: "update",
      baseMemoryId: created.head.memoryId,
      baseRevision: 1,
    });
    await assert.rejects(
      authority.commit({
        candidateId: staleCandidate.candidateId,
        idempotencyKey: "pg-stale",
      }),
      RevisionConflictError,
    );
    assert.equal((await store.getCandidate(staleCandidate.candidateId))?.status, "CONFLICT");
    assert.equal((await store.listConflicts(scope)).length, 1);

    const tombstoneCandidate = await candidates.ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, runtimeId: "hermes-gb10", deviceId: "gb10" },
      candidateType: "deletion_request",
      sourceType: "user_explicit_statement",
      sourceId: "conversation:pg:delete",
      memoryClass: "semantic_assertion",
      memoryKind: "architecture_boundary",
      proposedContent: { text: "Delete this canonical memory." },
      evidenceRefs: [
        {
          sourceType: "user_explicit_statement",
          sourceRef: "conversation:pg:delete",
        },
      ],
      proposedOperation: "tombstone",
      baseMemoryId: created.head.memoryId,
      baseRevision: 2,
    });
    const tombstoned = await authority.commit({
      candidateId: tombstoneCandidate.candidateId,
      idempotencyKey: "pg-tombstone",
    });
    assert.equal(tombstoned.revision.revision, 3);
    assert.equal(tombstoned.change.commitSeq, 3);
    assert.deepEqual(await verifier.verify(created.head.memoryId, scope), {
      decision: "SUPPRESS",
      reason: "TOMBSTONED",
    });

    assert.deepEqual(
      (await store.listChangesAfter(scope, 0)).map((change) => change.commitSeq),
      [1, 2, 3],
    );

    const sync = new MemorySyncService(store);
    const firstPull = await sync.pullForDevice({
      scope,
      deviceId: "prime-mac",
      limit: 2,
    });
    assert.equal(firstPull.lastAppliedCommitSeq, 0);
    assert.deepEqual(
      firstPull.changes.map((entry) => entry.envelope.commitSeq),
      [1, 2],
    );
    assert.equal(
      firstPull.changes[0]?.revision.canonicalContent.text,
      "OmniHarness does not own Agent orchestration.",
    );
    assert.deepEqual(firstPull.changes[0]?.revision.evidenceRefs, [
      { sourceType: "conversation", sourceRef: "conversation:pg:1" },
    ]);
    assert.equal(firstPull.hasMore, true);
    assert.equal(await store.getDeviceCheckpoint(scope, "prime-mac"), undefined);

    const checkpoint = await sync.acknowledgeDeviceChanges({
      scope,
      deviceId: "prime-mac",
      expectedLastAppliedCommitSeq: 0,
      appliedThroughCommitSeq: firstPull.nextCommitSeq,
    });
    assert.equal(checkpoint.lastAppliedCommitSeq, 2);

    const secondPull = await sync.pullForDevice({
      scope,
      deviceId: "prime-mac",
      limit: 2,
    });
    assert.deepEqual(
      secondPull.changes.map((entry) => entry.envelope.commitSeq),
      [3],
    );

    await assert.rejects(
      sync.acknowledgeDeviceChanges({
        scope,
        deviceId: "prime-mac",
        expectedLastAppliedCommitSeq: 0,
        appliedThroughCommitSeq: 1,
      }),
      DeviceCheckpointConflictError,
    );

    await sync.acknowledgeDeviceChanges({
      scope,
      deviceId: "prime-mac",
      expectedLastAppliedCommitSeq: 2,
      appliedThroughCommitSeq: secondPull.nextCommitSeq,
    });
    assert.equal(
      (await store.getDeviceCheckpoint(scope, "prime-mac"))
        ?.lastAppliedCommitSeq,
      3,
    );

    const concurrentAcks = await Promise.allSettled([
      sync.acknowledgeDeviceChanges({
        scope,
        deviceId: "openclaw-laptop",
        expectedLastAppliedCommitSeq: 0,
        appliedThroughCommitSeq: 1,
      }),
      sync.acknowledgeDeviceChanges({
        scope,
        deviceId: "openclaw-laptop",
        expectedLastAppliedCommitSeq: 0,
        appliedThroughCommitSeq: 1,
      }),
    ]);
    assert.equal(
      concurrentAcks.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejectedAck = concurrentAcks.find(
      (result) => result.status === "rejected",
    );
    assert.ok(rejectedAck?.status === "rejected");
    assert.ok(rejectedAck.reason instanceof DeviceCheckpointConflictError);

    await assert.rejects(
      store.compareAndSetDeviceCheckpoint(
        {
          scope,
          deviceId: "openclaw-laptop",
          lastAppliedCommitSeq: 4,
          lastSyncAt: new Date().toISOString(),
        },
        1,
      ),
      /cannot exceed the committed change sequence/,
    );

    await assert.rejects(
      store.compareAndSetDeviceCheckpoint(
        {
          scope,
          deviceId: "openclaw-laptop",
          lastAppliedCommitSeq: 0,
          lastSyncAt: new Date().toISOString(),
        },
        1,
      ),
      /cannot move backward/,
    );

    for (let index = 1; index <= 2; index += 1) {
      const operationsCandidate = await candidates.ingest({
        scope,
        origin: { lifeDid: scope.lifeDid, runtimeId: "operations-test" },
        candidateType: "operations_episode",
        sourceType: "task_result",
        sourceId: `operations:pg:${index}`,
        memoryClass: "episode",
        memoryKind: "operations_acceptance",
        proposedContent: { text: `PostgreSQL operations event ${index}.` },
        evidenceRefs: [
          { sourceType: "task_result", sourceRef: `operations:pg:${index}` },
        ],
        proposedOperation: "create",
      });
      await authority.commit({
        candidateId: operationsCandidate.candidateId,
        idempotencyKey: `operations-pg-${index}`,
      });
    }

    const operations = new CentralOperationsService(store);
    const inventory = await operations.readMemoryInventory({
      scope,
      afterCommitSeq: 0,
    });
    assert.equal(inventory.entries.length, 3);
    assert.deepEqual(
      inventory.entries.map((entry) => entry.revision.commitSeq),
      [3, 4, 5],
    );
    assert.equal(inventory.entries[0]?.head.status, "tombstoned");

    const fleet = await operations.readDeviceFleet({ scope });
    assert.deepEqual(
      fleet.devices.map((device) => [device.checkpoint.deviceId, device.lag]),
      [
        ["openclaw-laptop", 4],
        ["prime-mac", 2],
      ],
    );

    const beforeClaims = await operations.getNamespaceSummary(scope);
    assert.deepEqual(beforeClaims.outbox, {
      pending: 5,
      processing: 0,
      done: 0,
      failed: 0,
    });

    const [workerA, workerB] = await Promise.all([
      operations.claimOutbox({
        scope,
        workerId: "postgres-worker-a",
        leaseMs: 30_000,
        limit: 2,
      }),
      operations.claimOutbox({
        scope,
        workerId: "postgres-worker-b",
        leaseMs: 30_000,
        limit: 2,
      }),
    ]);
    const claimed = [...workerA, ...workerB];
    assert.equal(claimed.length, 3);
    assert.equal(new Set(claimed.map((item) => item.record.outboxId)).size, 3);

    const expiring = claimed.find(
      (item) => item.record.memoryId === tombstoned.head.memoryId,
    );
    const independent = claimed.filter(
      (item) => item.record.memoryId !== tombstoned.head.memoryId,
    );
    const successful = independent[0];
    assert.ok(successful);
    await assert.rejects(
      operations.settleOutbox({
        scope,
        outboxId: successful.record.outboxId,
        workerId: successful.record.claimedBy,
        claimToken: "stale-token",
        outcomes: [{ providerName: "hindsight", status: "CURRENT" }],
      }),
      OutboxClaimConflictError,
    );
    const successSettlement = await operations.settleOutbox({
      scope,
      outboxId: successful.record.outboxId,
      workerId: successful.record.claimedBy,
      claimToken: successful.record.claimToken,
      outcomes: [
        {
          providerName: "hindsight",
          providerId: "hindsight:memory:1",
          status: "CURRENT",
        },
      ],
    });
    assert.equal(successSettlement.record.status, "DONE");

    const failed = independent[1];
    assert.ok(failed);
    const nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
    const failedSettlement = await operations.settleOutbox({
      scope,
      outboxId: failed.record.outboxId,
      workerId: failed.record.claimedBy,
      claimToken: failed.record.claimToken,
      outcomes: [
        {
          providerName: "vault",
          status: "FAILED",
          lastError: "provider timeout",
        },
      ],
      nextAttemptAt,
    });
    assert.equal(failedSettlement.record.status, "FAILED");
    assert.equal(failedSettlement.record.nextAttemptAt, nextAttemptAt);

    assert.ok(expiring);
    await pool.query(
      `UPDATE memory_outbox
          SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE outbox_id = $1`,
      [expiring.record.outboxId],
    );
    const reclaimed = await operations.claimOutbox({
      scope,
      workerId: "postgres-worker-c",
      leaseMs: 30_000,
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.record.outboxId, expiring.record.outboxId);
    assert.equal(reclaimed[0]?.record.attempts, 2);
    await assert.rejects(
      operations.settleOutbox({
        scope,
        outboxId: expiring.record.outboxId,
        workerId: expiring.record.claimedBy,
        claimToken: expiring.record.claimToken,
        outcomes: [{ providerName: "mem0", status: "CURRENT" }],
      }),
      OutboxClaimConflictError,
    );

    const materializations = await operations.readProviderMaterializations({
      scope,
    });
    assert.deepEqual(
      materializations.materializations.map((item) => [
        item.providerName,
        item.status,
      ]),
      [
        ["hindsight", "CURRENT"],
        ["vault", "FAILED"],
      ],
    );

    const afterSettlements = await operations.getNamespaceSummary(scope);
    assert.deepEqual(afterSettlements.outbox, {
      pending: 2,
      processing: 1,
      done: 1,
      failed: 1,
    });
    assert.equal(afterSettlements.materializations.current, 1);
    assert.equal(afterSettlements.materializations.failed, 1);

    const materializationScope: MemoryScope = {
      tenantId: "tenant_pg",
      lifeDid: "did:life:nancy",
      memoryNamespace: "dlfm-004.acceptance",
    };
    const materializationCandidate = await candidates.ingest({
      scope: materializationScope,
      origin: { lifeDid: materializationScope.lifeDid, runtimeId: "dlfm-004-test" },
      candidateType: "provider_materialization_acceptance",
      sourceType: "task_result",
      sourceId: "dlfm-004:postgres:1",
      memoryClass: "episode",
      memoryKind: "provider_delivery_acceptance",
      proposedContent: { text: "PostgreSQL outbox delivers through OH-MEM-002." },
      evidenceRefs: [
        { sourceType: "task_result", sourceRef: "dlfm-004:postgres:1" },
      ],
      proposedOperation: "create",
    });
    const materializationCommit = await authority.commit({
      candidateId: materializationCandidate.candidateId,
      idempotencyKey: "dlfm-004-postgres-1",
    });

    let failDelivery = false;
    const delivery: MemoryMaterializationDeliveryPort = {
      async execute(event: MemoryFabricMaterializationEvent) {
        if (failDelivery) throw new Error("OmniHarness unavailable");
        return {
          event_type: event.event_type,
          event_version: event.event_version,
          outbox_id: event.outbox_id,
          request_id: event.request_id,
          memory_id: event.memory_id,
          canonical_revision: event.canonical_revision,
          commit_seq: event.commit_seq,
          provider_id: "memory-reference",
          status: "SUCCESS",
          retryable: false,
          canonical_commit_affected: false,
          provider_receipt: {
            providerId: "memory-reference",
            memoryId: event.memory_id,
            canonicalRevision: event.canonical_revision,
            status: "SUCCESS",
            providerObjectId: `reference:${event.memory_id}:r${event.canonical_revision}`,
          },
        };
      },
    };
    const materializationOperations = new CentralOperationsService(store);
    const materializationWorker = new MaterializationWorker(
      materializationOperations,
      delivery,
    );
    const materialized = await materializationWorker.runOnce({
      scope: materializationScope,
      workerId: "postgres-oh-worker",
      leaseMs: 30_000,
      deliveryTimeoutMs: 5_000,
      retryDelayMs: 60_000,
    });
    assert.equal(materialized.items[0]?.event.event_id, materializationCommit.change.eventId);
    assert.equal(materialized.items[0]?.settlement.record.status, "DONE");
    assert.equal(
      materialized.items[0]?.settlement.materializations[0]?.providerId,
      `reference:${materializationCommit.head.memoryId}:r1`,
    );

    const unavailableCandidate = await candidates.ingest({
      scope: materializationScope,
      origin: { lifeDid: materializationScope.lifeDid, runtimeId: "dlfm-004-test" },
      candidateType: "provider_materialization_failure",
      sourceType: "task_result",
      sourceId: "dlfm-004:postgres:2",
      memoryClass: "episode",
      memoryKind: "provider_delivery_acceptance",
      proposedContent: { text: "Unresolved provider failure remains operational." },
      evidenceRefs: [
        { sourceType: "task_result", sourceRef: "dlfm-004:postgres:2" },
      ],
      proposedOperation: "create",
    });
    await authority.commit({
      candidateId: unavailableCandidate.candidateId,
      idempotencyKey: "dlfm-004-postgres-2",
    });
    failDelivery = true;
    const unavailable = await materializationWorker.runOnce({
      scope: materializationScope,
      workerId: "postgres-oh-worker",
      leaseMs: 30_000,
      deliveryTimeoutMs: 5_000,
      retryDelayMs: 60_000,
    });
    assert.equal(unavailable.items[0]?.settlement.record.status, "FAILED");
    assert.deepEqual(unavailable.items[0]?.settlement.materializations, []);
    assert.deepEqual(
      (await materializationOperations.readProviderMaterializations({
        scope: materializationScope,
      })).materializations.map((value) => value.providerName),
      ["memory-reference"],
    );
  } finally {
    await store.close();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});
