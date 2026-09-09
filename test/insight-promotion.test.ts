import assert from "node:assert/strict";
import test from "node:test";

import {
  CanonicalMemoryAuthority,
  InMemoryCanonicalMemoryStore,
  InMemoryInsightPromotionRecordStore,
  InMemoryReflectiveInsightStore,
  MemoryCandidateService,
  ReflectiveInsightPromotionGate,
  ReflectiveInsightPromotionService,
  type MemoryScope,
  type ReflectiveInsight,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "tenant_insight_promotion",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

const approvalVerifier = { verifyApproval: async () => true };

async function seedSupport(store: InMemoryCanonicalMemoryStore) {
  const candidate = await new MemoryCandidateService(store).ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
    candidateType: "fact_candidate",
    sourceType: "reviewed_evidence",
    sourceId: "phase-leakage-review",
    memoryClass: "semantic_assertion",
    memoryKind: "technical_finding",
    memoryType: "technical_fact",
    speakerProvenance: "tool",
    semanticKey: "technical:phase-leakage:observed-recurrence",
    proposedContent: {
      text: "Phase leakage was observed in three independently reviewed pipeline stages.",
    },
    evidenceRefs: [
      { sourceType: "review", sourceRef: "phase-leakage-evidence-1" },
    ],
    epistemicStatus: "system_observed",
    producer: { kind: "system", id: "dlmf-review" },
    sourceExperienceRefs: [
      { sourceType: "reviewed_evidence", sourceId: "phase-leakage-review" },
    ],
    proposedOperation: "create",
  });
  return new CanonicalMemoryAuthority(store).commit({
    candidateId: candidate.candidateId,
    idempotencyKey: "seed-phase-leakage-support",
  });
}

function pendingInsight(
  memoryId: ReflectiveInsight["supportingMemoryIds"][number],
  overrides: Partial<ReflectiveInsight> = {},
): ReflectiveInsight {
  const gate = new ReflectiveInsightPromotionGate();
  const timestamp = "2026-09-09T00:00:00.000Z";
  const base = {
    insightId: "insight_phase_leakage_governed" as const,
    scope,
    proposition:
      "Phase leakage is a systemic recurrence risk and should be tracked across pipeline boundaries.",
    epistemicStatus: "synthesized" as const,
    supportingMemoryIds: [memoryId],
    supportingEvidenceIds: ["review:phase-leakage-evidence-1"],
    contradictingMemoryIds: [],
    confidence: 0.92,
    derivationProvider: "hindsight",
    derivationModel: "fixture-reflection-model",
    derivationRunId: "hs_phase_leakage_run",
    status: "pending" as const,
    canonicalWritePerformed: false as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const insight = { ...base, ...overrides };
  return {
    ...insight,
    promotionEligibility: gate.assess(insight),
  };
}

test("DLMF-SG-002 explicitly accepted evidence-closed insight promotes through DLMF authority and is idempotent", async () => {
  const canonicalStore = new InMemoryCanonicalMemoryStore();
  const support = await seedSupport(canonicalStore);
  const insightStore = new InMemoryReflectiveInsightStore();
  const promotionStore = new InMemoryInsightPromotionRecordStore();
  const insight = pendingInsight(support.head.memoryId);
  await insightStore.put(insight);

  const service = new ReflectiveInsightPromotionService({
    canonicalStore,
    insightStore,
    promotionStore,
    approvalVerifier,
  });
  const request = {
    insightId: insight.insightId,
    scope,
    approvedBy: { lifeDid: scope.lifeDid, agentId: "human-reviewer" },
    idempotencyKey: "accept-phase-leakage-v1",
  } as const;

  const first = await service.promote(request);
  const replay = await service.promote(request);

  assert.equal(first.record.status, "committed");
  assert.equal(replay.record.promotionId, first.record.promotionId);
  assert.equal(replay.canonicalMemoryId, first.canonicalMemoryId);
  assert.equal(first.insight.status, "accepted");
  assert.equal(first.insight.canonicalWritePerformed, false);
  assert.equal(first.insight.derivationProvider, "hindsight");

  const head = await canonicalStore.getHead(first.canonicalMemoryId);
  assert.ok(head);
  assert.equal(head.currentRevision, 1);
  const revision = await canonicalStore.getRevision(head.memoryId, head.currentRevision);
  assert.ok(revision);
  assert.equal(revision.epistemicStatus, "synthesized");
  assert.deepEqual(revision.producer, {
    kind: "runtime",
    id: "dlmf-insight-promotion",
  });
  assert.equal(revision.provenance.sourceId, insight.insightId);
  assert.equal(
    (await canonicalStore.getCandidate(first.record.candidateId!))?.status,
    "ACCEPTED",
  );
});

test("DLMF-SG-002 reflective insight stores allow governed status changes but reject immutable drift", async () => {
  const store = new InMemoryReflectiveInsightStore();
  const insight = pendingInsight("mem_store_contract");
  await store.put(insight);

  const accepted = {
    ...insight,
    status: "accepted" as const,
    promotionEligibility: new ReflectiveInsightPromotionGate().assess({
      ...insight,
      status: "accepted",
    }),
    updatedAt: "2026-09-09T00:01:00.000Z",
  };
  await store.put(accepted);
  assert.equal((await store.get(insight.insightId))?.status, "accepted");

  await assert.rejects(
    store.put({ ...accepted, proposition: "A changed proposition must use a new insight id." }),
    /reflective insight write changed immutable fields/,
  );
  assert.equal((await store.get(insight.insightId))?.proposition, insight.proposition);
});

test("DLMF-SG-002 rejects an insight when canonical evidence closure cannot be revalidated", async () => {
  const canonicalStore = new InMemoryCanonicalMemoryStore();
  const support = await seedSupport(canonicalStore);
  const insightStore = new InMemoryReflectiveInsightStore();
  const promotionStore = new InMemoryInsightPromotionRecordStore();
  const insight = pendingInsight(support.head.memoryId, {
    insightId: "insight_missing_evidence_closure",
    supportingEvidenceIds: ["review:not-present-in-canonical-support"],
  });
  await insightStore.put(insight);

  await assert.rejects(
    new ReflectiveInsightPromotionService({
      canonicalStore,
      insightStore,
      promotionStore,
      approvalVerifier,
    }).promote({
      insightId: insight.insightId,
      scope,
      approvedBy: { lifeDid: scope.lifeDid, agentId: "human-reviewer" },
      idempotencyKey: "reject-missing-evidence",
    }),
    /supporting evidence closure is missing/,
  );
  assert.equal(
    await promotionStore.getByIdempotencyKey(scope, "reject-missing-evidence"),
    undefined,
  );
});

test("DLMF-SG-002 keeps an explicitly reviewed insight rejected when contradictions remain", async () => {
  const canonicalStore = new InMemoryCanonicalMemoryStore();
  const support = await seedSupport(canonicalStore);
  const insightStore = new InMemoryReflectiveInsightStore();
  const promotionStore = new InMemoryInsightPromotionRecordStore();
  const insight = pendingInsight(support.head.memoryId, {
    insightId: "insight_unresolved_contradiction",
    contradictingMemoryIds: [support.head.memoryId],
  });
  await insightStore.put(insight);

  const service = new ReflectiveInsightPromotionService({
    canonicalStore,
    insightStore,
    promotionStore,
    approvalVerifier,
  });
  await assert.rejects(
    service.promote({
      insightId: insight.insightId,
      scope,
      approvedBy: { lifeDid: scope.lifeDid, agentId: "human-reviewer" },
      idempotencyKey: "reject-contradicted-insight",
    }),
    /promotion:unresolved_contradictions/,
  );
  const record = await promotionStore.getByIdempotencyKey(
    scope,
    "reject-contradicted-insight",
  );
  assert.equal(record?.status, "rejected");
  assert.equal(record?.candidateId, undefined);
  assert.equal((await insightStore.get(insight.insightId))?.status, "pending");
});

test("DLMF-SG-002 refuses promotion when the approval verifier cannot authenticate acceptance", async () => {
  const canonicalStore = new InMemoryCanonicalMemoryStore();
  const support = await seedSupport(canonicalStore);
  const insightStore = new InMemoryReflectiveInsightStore();
  const promotionStore = new InMemoryInsightPromotionRecordStore();
  const insight = pendingInsight(support.head.memoryId, {
    insightId: "insight_unverified_approval",
  });
  await insightStore.put(insight);

  await assert.rejects(
    new ReflectiveInsightPromotionService({
      canonicalStore,
      insightStore,
      promotionStore,
      approvalVerifier: { verifyApproval: async () => false },
    }).promote({
      insightId: insight.insightId,
      scope,
      approvedBy: { lifeDid: scope.lifeDid, agentId: "unverified-reviewer" },
      idempotencyKey: "reject-unverified-approval",
    }),
    /approval could not be verified/,
  );
  assert.equal(
    await promotionStore.getByIdempotencyKey(scope, "reject-unverified-approval"),
    undefined,
  );
});

test("DLMF-SG-002 persists a terminal rejection when confidence is below policy threshold", async () => {
  const canonicalStore = new InMemoryCanonicalMemoryStore();
  const support = await seedSupport(canonicalStore);
  const insightStore = new InMemoryReflectiveInsightStore();
  const promotionStore = new InMemoryInsightPromotionRecordStore();
  const insight = pendingInsight(support.head.memoryId, {
    insightId: "insight_low_confidence",
    confidence: 0.74,
  });
  await insightStore.put(insight);

  await assert.rejects(
    new ReflectiveInsightPromotionService({
      canonicalStore,
      insightStore,
      promotionStore,
      approvalVerifier,
    }).promote({
      insightId: insight.insightId,
      scope,
      approvedBy: { lifeDid: scope.lifeDid, agentId: "human-reviewer" },
      idempotencyKey: "reject-low-confidence",
    }),
    /promotion:confidence_below_threshold/,
  );
  const record = await promotionStore.getByIdempotencyKey(
    scope,
    "reject-low-confidence",
  );
  assert.equal(record?.status, "rejected");
  assert.equal(record?.eligibility.evidenceClosure, false);
});
