import assert from "node:assert/strict";
import test from "node:test";
import {
  OMNIHARNESS_MEMORY_MATERIALIZATION_EVENT,
  OMNIHARNESS_MEMORY_MATERIALIZATION_EVENT_VERSION,
  toOmniHarnessMaterializationEvent,
  type CanonicalCommitResult,
} from "../src/index.js";

function commit(operation: CanonicalCommitResult["change"]["operation"] = "create"): CanonicalCommitResult {
  return {
    head: {
      memoryId: "mem_01ABC",
      scope: { tenantId: "tenant_01", lifeDid: "did:life:nancy", memoryNamespace: "life.core" },
      memoryClass: "semantic_assertion",
      memoryKind: "architecture",
      currentRevision: 7,
      status: operation === "tombstone" ? "tombstoned" : "active",
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
    revision: {
      memoryId: "mem_01ABC",
      revision: 7,
      scope: { tenantId: "tenant_01", lifeDid: "did:life:nancy", memoryNamespace: "life.core" },
      memoryClass: "semantic_assertion",
      memoryKind: "architecture",
      status: operation === "tombstone" ? "tombstoned" : "active",
      canonicalContent: { text: "OmniHarness is a provider fabric." },
      contentHash: "sha256:test",
      author: { lifeDid: "did:life:nancy", agentId: "agent-1" },
      provenance: { sourceType: "test", candidateId: "cand_01" },
      evidenceRefs: [],
      committedAt: "2026-09-01T12:00:00.000Z",
      commitSeq: 10527,
    },
    change: {
      eventId: "evt_01",
      scope: { tenantId: "tenant_01", lifeDid: "did:life:nancy", memoryNamespace: "life.core" },
      commitSeq: 10527,
      memoryId: "mem_01ABC",
      operation,
      baseRevision: 6,
      newRevision: 7,
      idempotencyKey: "commit:mem_01ABC:7",
      author: { lifeDid: "did:life:nancy", agentId: "agent-1" },
      committedAt: "2026-09-01T12:00:00.000Z",
      payloadHash: "sha256:payload",
    },
    outbox: {
      outboxId: "out_01",
      scope: { tenantId: "tenant_01", lifeDid: "did:life:nancy", memoryNamespace: "life.core" },
      commitSeq: 10527,
      memoryId: "mem_01ABC",
      revision: 7,
      operation,
      status: "PENDING",
      attempts: 0,
      createdAt: "2026-09-01T12:00:00.000Z",
    },
  };
}

test("OH-MEM-002 maps a committed revision into a versioned UPSERT event", () => {
  const event = toOmniHarnessMaterializationEvent(commit(), { traceId: "trace_01" });
  assert.equal(event.event_type, OMNIHARNESS_MEMORY_MATERIALIZATION_EVENT);
  assert.equal(event.event_version, OMNIHARNESS_MEMORY_MATERIALIZATION_EVENT_VERSION);
  assert.equal(event.outbox_id, "out_01");
  assert.equal(event.request_id, "ohmat:out_01");
  assert.equal(event.trace_id, "trace_01");
  assert.equal(event.tenant_id, "tenant_01");
  assert.equal(event.life_did, "did:life:nancy");
  assert.equal(event.memory_namespace, "life.core");
  assert.equal(event.memory_id, "mem_01ABC");
  assert.equal(event.canonical_revision, 7);
  assert.equal(event.commit_seq, 10527);
  assert.equal(event.intent, "UPSERT");
  assert.equal(event.canonical_content?.text, "OmniHarness is a provider fabric.");
  assert.equal(event.idempotency_key, "memory.materialization:mem_01ABC:7");
});

test("OH-MEM-002 maps tombstone commits to provider DELETE without canonical payload", () => {
  const event = toOmniHarnessMaterializationEvent(commit("tombstone"));
  assert.equal(event.intent, "DELETE");
  assert.equal("canonical_content" in event, false);
});
