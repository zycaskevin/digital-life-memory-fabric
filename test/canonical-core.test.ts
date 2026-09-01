import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalMemoryAuthority,
  CanonicalVerifier,
  InMemoryCanonicalMemoryStore,
  MemoryCandidateService,
  RevisionConflictError,
  type Clock,
  type ConflictId,
  type EventId,
  type IdFactory,
  type MemoryId,
  type MemoryScope,
  type OutboxId,
  type CandidateId,
} from "../src/index.js";

class TestClock implements Clock {
  private tick = 0;

  now(): string {
    const value = new Date(Date.UTC(2026, 8, 1, 12, 0, this.tick));
    this.tick += 1;
    return value.toISOString();
  }
}

class TestIds implements IdFactory {
  private candidate = 0;
  private memory = 0;
  private event = 0;
  private outbox = 0;
  private conflict = 0;

  candidateId(): CandidateId {
    this.candidate += 1;
    return `cand_${this.candidate}`;
  }

  memoryId(): MemoryId {
    this.memory += 1;
    return `mem_${this.memory}`;
  }

  eventId(): EventId {
    this.event += 1;
    return `evt_${this.event}`;
  }

  outboxId(): OutboxId {
    this.outbox += 1;
    return `out_${this.outbox}`;
  }

  conflictId(): ConflictId {
    this.conflict += 1;
    return `conf_${this.conflict}`;
  }
}

const scope: MemoryScope = {
  tenantId: "tenant_01",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

function createHarness() {
  const store = new InMemoryCanonicalMemoryStore();
  const ids = new TestIds();
  const clock = new TestClock();
  return {
    store,
    candidates: new MemoryCandidateService(store, ids, clock),
    authority: new CanonicalMemoryAuthority(store, ids, clock),
    verifier: new CanonicalVerifier(store),
  };
}

async function createBoundaryMemory(harness: ReturnType<typeof createHarness>) {
  const candidate = await harness.candidates.ingest({
    scope,
    origin: {
      lifeDid: scope.lifeDid,
      agentId: "nancy",
      runtimeId: "hermes-gb10",
      deviceId: "gb10",
    },
    candidateType: "semantic_assertion",
    sourceType: "conversation",
    sourceId: "conversation:2026-09-01:message:123",
    memoryClass: "semantic_assertion",
    memoryKind: "architecture_boundary",
    proposedContent: {
      text: "OmniHarness does not own Agent orchestration.",
    },
    evidenceRefs: [
      {
        sourceType: "conversation",
        sourceRef: "conversation:2026-09-01:message:123",
      },
    ],
    confidence: 0.96,
    proposedOperation: "create",
  });

  const result = await harness.authority.commit({
    candidateId: candidate.candidateId,
    idempotencyKey: "commit-boundary-v1",
  });

  return { candidate, result };
}

test("Candidate -> canonical create produces provider-independent identity and atomic change/outbox", async () => {
  const harness = createHarness();
  const { candidate, result } = await createBoundaryMemory(harness);

  assert.equal(result.head.memoryId, "mem_1");
  assert.equal(result.revision.revision, 1);
  assert.equal(result.revision.commitSeq, 1);
  assert.equal(result.change.commitSeq, 1);
  assert.equal(result.outbox.commitSeq, 1);
  assert.equal(result.outbox.status, "PENDING");
  assert.equal(
    result.revision.canonicalContent.text,
    "OmniHarness does not own Agent orchestration.",
  );
  assert.match(result.revision.contentHash, /^sha256:/);

  const storedCandidate = await harness.store.getCandidate(candidate.candidateId);
  assert.equal(storedCandidate?.status, "ACCEPTED");

  const verified = await harness.verifier.verify(result.head.memoryId, scope);
  assert.equal(verified.decision, "ALLOW");
  if (verified.decision === "ALLOW") {
    assert.equal(verified.revision.revision, 1);
  }

  const retry = await harness.authority.commit({
    candidateId: candidate.candidateId,
    idempotencyKey: "commit-boundary-v1",
  });
  assert.deepEqual(retry, result);
  assert.equal((await harness.store.listChangesAfter(scope, 0)).length, 1);
});

test("update requires base_revision and stale writers become audited conflicts without consuming commit_seq", async () => {
  const harness = createHarness();
  const { result: created } = await createBoundaryMemory(harness);

  const updateCandidate = await harness.candidates.ingest({
    scope,
    origin: {
      lifeDid: scope.lifeDid,
      agentId: "nancy",
      runtimeId: "hermes-gb10",
      deviceId: "gb10",
    },
    candidateType: "semantic_assertion_correction",
    sourceType: "conversation",
    sourceId: "conversation:2026-09-01:message:124",
    memoryClass: "semantic_assertion",
    memoryKind: "architecture_boundary",
    proposedContent: {
      text: "OmniHarness is provider abstraction only and does not own Agent orchestration.",
    },
    evidenceRefs: [
      {
        sourceType: "conversation",
        sourceRef: "conversation:2026-09-01:message:124",
      },
    ],
    proposedOperation: "update",
    baseMemoryId: created.head.memoryId,
    baseRevision: 1,
  });

  const updated = await harness.authority.commit({
    candidateId: updateCandidate.candidateId,
    idempotencyKey: "boundary-correction-v2",
  });

  assert.equal(updated.head.memoryId, created.head.memoryId);
  assert.equal(updated.revision.revision, 2);
  assert.equal(updated.change.commitSeq, 2);

  const staleCandidate = await harness.candidates.ingest({
    scope,
    origin: {
      lifeDid: scope.lifeDid,
      agentId: "nancy",
      runtimeId: "prime-mac",
      deviceId: "mac",
    },
    candidateType: "semantic_assertion_correction",
    sourceType: "conversation",
    sourceId: "conversation:offline:1",
    memoryClass: "semantic_assertion",
    memoryKind: "architecture_boundary",
    proposedContent: {
      text: "Stale offline edit.",
    },
    evidenceRefs: [
      {
        sourceType: "conversation",
        sourceRef: "conversation:offline:1",
      },
    ],
    proposedOperation: "update",
    baseMemoryId: created.head.memoryId,
    baseRevision: 1,
  });

  await assert.rejects(
    harness.authority.commit({
      candidateId: staleCandidate.candidateId,
      idempotencyKey: "stale-edit",
    }),
    (error: unknown) => {
      assert.ok(error instanceof RevisionConflictError);
      assert.equal(error.expectedRevision, 1);
      assert.equal(error.currentRevision, 2);
      return true;
    },
  );

  const storedStale = await harness.store.getCandidate(staleCandidate.candidateId);
  assert.equal(storedStale?.status, "CONFLICT");
  const conflicts = await harness.store.listConflicts(scope);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.currentRevision, 2);

  const changes = await harness.store.listChangesAfter(scope, 0);
  assert.deepEqual(
    changes.map((change) => change.commitSeq),
    [1, 2],
  );

  const anotherCreate = await harness.candidates.ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, runtimeId: "hermes-gb10" },
    candidateType: "episode",
    sourceType: "task_result",
    sourceId: "task:001",
    memoryClass: "episode",
    memoryKind: "task_completion",
    proposedContent: { text: "DLFM conflict test completed." },
    evidenceRefs: [{ sourceType: "task_result", sourceRef: "task:001" }],
    proposedOperation: "create",
  });
  const next = await harness.authority.commit({
    candidateId: anotherCreate.candidateId,
    idempotencyKey: "post-conflict-create",
  });
  assert.equal(next.change.commitSeq, 3);
});

test("tombstone preserves canonical content but verifier suppresses provider retrieval", async () => {
  const harness = createHarness();
  const { result: created } = await createBoundaryMemory(harness);

  const tombstoneCandidate = await harness.candidates.ingest({
    scope,
    origin: {
      lifeDid: scope.lifeDid,
      agentId: "nancy",
      runtimeId: "hermes-gb10",
      deviceId: "gb10",
    },
    candidateType: "deletion_request",
    sourceType: "user_explicit_statement",
    sourceId: "conversation:2026-09-01:delete:1",
    memoryClass: "semantic_assertion",
    memoryKind: "architecture_boundary",
    proposedContent: { text: "User requested canonical tombstone." },
    evidenceRefs: [
      {
        sourceType: "user_explicit_statement",
        sourceRef: "conversation:2026-09-01:delete:1",
      },
    ],
    proposedOperation: "tombstone",
    baseMemoryId: created.head.memoryId,
    baseRevision: 1,
  });

  const tombstoned = await harness.authority.commit({
    candidateId: tombstoneCandidate.candidateId,
    idempotencyKey: "tombstone-boundary",
  });

  assert.equal(tombstoned.head.status, "tombstoned");
  assert.equal(tombstoned.revision.revision, 2);
  assert.equal(
    tombstoned.revision.canonicalContent.text,
    created.revision.canonicalContent.text,
  );

  const verification = await harness.verifier.verify(created.head.memoryId, scope);
  assert.deepEqual(verification, {
    decision: "SUPPRESS",
    reason: "TOMBSTONED",
  });
});

test("temporal semantics preserve observed time separately from commit time", async () => {
  const harness = createHarness();
  const candidate = await harness.candidates.ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, runtimeId: "hermes-gb10" },
    candidateType: "historical_episode",
    sourceType: "document",
    sourceId: "document:historical:1",
    memoryClass: "episode",
    memoryKind: "historical_residence",
    proposedContent: { text: "A historical event learned later." },
    evidenceRefs: [{ sourceType: "document", sourceRef: "document:historical:1" }],
    proposedOperation: "create",
    observedAt: "2026-09-01T11:00:00.000Z",
    validFrom: "2025-01-01T00:00:00.000Z",
    validUntil: "2025-06-30T23:59:59.000Z",
  });

  const committed = await harness.authority.commit({
    candidateId: candidate.candidateId,
    idempotencyKey: "historical-episode",
  });

  assert.equal(committed.revision.observedAt, "2026-09-01T11:00:00.000Z");
  assert.equal(committed.revision.validFrom, "2025-01-01T00:00:00.000Z");
  assert.equal(committed.revision.validUntil, "2025-06-30T23:59:59.000Z");
  assert.notEqual(committed.revision.committedAt, committed.revision.validFrom);

  await assert.rejects(
    harness.candidates.ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, runtimeId: "hermes-gb10" },
      candidateType: "invalid_temporal_range",
      sourceType: "document",
      memoryClass: "episode",
      memoryKind: "invalid",
      proposedContent: { text: "Invalid temporal range." },
      evidenceRefs: [{ sourceType: "document", sourceRef: "document:invalid" }],
      proposedOperation: "create",
      validFrom: "2026-02-01T00:00:00.000Z",
      validUntil: "2026-01-01T00:00:00.000Z",
    }),
    /validUntil must not be earlier than validFrom/,
  );
});

test("commit_seq is monotonic inside a namespace and independent across namespaces", async () => {
  const harness = createHarness();
  const { result: first } = await createBoundaryMemory(harness);
  assert.equal(first.change.commitSeq, 1);

  const projectScope: MemoryScope = {
    ...scope,
    memoryNamespace: "project:omniharness",
  };
  const projectCandidate = await harness.candidates.ingest({
    scope: projectScope,
    origin: { lifeDid: projectScope.lifeDid, runtimeId: "hermes-gb10" },
    candidateType: "semantic_assertion",
    sourceType: "document",
    sourceId: "docs:omniharness:canonical",
    memoryClass: "semantic_assertion",
    memoryKind: "project_boundary",
    proposedContent: { text: "OmniHarness is thin and vendor-neutral." },
    evidenceRefs: [{ sourceType: "document", sourceRef: "docs:omniharness:canonical" }],
    proposedOperation: "create",
  });
  const projectCommit = await harness.authority.commit({
    candidateId: projectCandidate.candidateId,
    idempotencyKey: "project-boundary-1",
  });

  assert.equal(projectCommit.change.commitSeq, 1);
  assert.deepEqual(
    (await harness.store.listChangesAfter(scope, 0)).map((change) => change.commitSeq),
    [1],
  );
  assert.deepEqual(
    (await harness.store.listChangesAfter(projectScope, 0)).map(
      (change) => change.commitSeq,
    ),
    [1],
  );
});
