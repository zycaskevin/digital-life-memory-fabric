import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";

import {
  CanonicalMemoryAuthority,
  InMemoryCanonicalMemoryStore,
  InMemoryInsightPromotionRecordStore,
  InMemoryReflectiveInsightStore,
  MemoryCandidateService,
  PostgresInsightPromotionRecordStore,
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
const approvalEvidenceIds = ["approval:governed-review-receipt"];

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
    approvalEvidenceIds,
    idempotencyKey: "accept-phase-leakage-v1",
  } as const;

  const first = await service.promote(request);
  const replay = await service.promote(request);

  assert.equal(first.record.status, "committed");
  assert.equal(replay.record.promotionId, first.record.promotionId);
  assert.equal(replay.canonicalMemoryId, first.canonicalMemoryId);
  const events = await promotionStore.listEvents(scope, first.record.promotionId);
  assert.deepEqual(events.map((event) => event.eventType), [
    "approved",
    "candidate_linked",
    "committed",
  ]);
  assert.deepEqual(events[0]?.approvalEvidenceIds, approvalEvidenceIds);
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

test("DLMF-SG-009 concurrent replay yields one governed promotion and one canonical result", async () => {
  const canonicalStore = new InMemoryCanonicalMemoryStore();
  const support = await seedSupport(canonicalStore);
  const insightStore = new InMemoryReflectiveInsightStore();
  const promotionStore = new InMemoryInsightPromotionRecordStore();
  const insight = pendingInsight(support.head.memoryId, {
    insightId: "insight_concurrent_promotion_replay",
  });
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
    approvalEvidenceIds,
    idempotencyKey: "concurrent-promotion-replay-v1",
  };

  const [first, second] = await Promise.all([
    service.promote(request),
    service.promote(request),
  ]);

  assert.equal(first.record.promotionId, second.record.promotionId);
  assert.equal(first.canonicalMemoryId, second.canonicalMemoryId);
  assert.equal((await promotionStore.listEvents(scope, first.record.promotionId)).length, 3);
});

test("DLMF-SG-009 one reflective insight cannot be promoted under a second key", async () => {
  const canonicalStore = new InMemoryCanonicalMemoryStore();
  const support = await seedSupport(canonicalStore);
  const insightStore = new InMemoryReflectiveInsightStore();
  const promotionStore = new InMemoryInsightPromotionRecordStore();
  const insight = pendingInsight(support.head.memoryId, {
    insightId: "insight_single_promotion_record",
  });
  await insightStore.put(insight);
  const service = new ReflectiveInsightPromotionService({
    canonicalStore,
    insightStore,
    promotionStore,
    approvalVerifier,
  });
  await service.promote({
    insightId: insight.insightId,
    scope,
    approvedBy: { lifeDid: scope.lifeDid, agentId: "human-reviewer" },
    approvalEvidenceIds,
    idempotencyKey: "single-promotion-first",
  });

  await assert.rejects(
    service.promote({
      insightId: insight.insightId,
      scope,
      approvedBy: { lifeDid: scope.lifeDid, agentId: "human-reviewer" },
      approvalEvidenceIds,
      idempotencyKey: "single-promotion-second",
    }),
    /already has governed promotion/,
  );
  assert.equal(await promotionStore.getByIdempotencyKey(scope, "single-promotion-second"), undefined);
});

test("DLMF-SG-009 refuses an approval without durable evidence identity", async () => {
  const canonicalStore = new InMemoryCanonicalMemoryStore();
  const support = await seedSupport(canonicalStore);
  const insightStore = new InMemoryReflectiveInsightStore();
  const promotionStore = new InMemoryInsightPromotionRecordStore();
  const insight = pendingInsight(support.head.memoryId, {
    insightId: "insight_approval_without_evidence",
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
      approvalEvidenceIds: [],
      idempotencyKey: "missing-approval-evidence",
    }),
    /approval evidence is required/,
  );
});

test("DLMF-SG-009 refuses anonymous approval and duplicate approval evidence", async () => {
  const service = new ReflectiveInsightPromotionService({
    canonicalStore: new InMemoryCanonicalMemoryStore(),
    insightStore: new InMemoryReflectiveInsightStore(),
    promotionStore: new InMemoryInsightPromotionRecordStore(),
    approvalVerifier,
  });
  const request = {
    insightId: "insight_invalid_approval_identity" as ReflectiveInsight["insightId"],
    scope,
    approvedBy: { lifeDid: scope.lifeDid },
    approvalEvidenceIds,
    idempotencyKey: "invalid-approval-identity",
  };

  await assert.rejects(
    service.promote(request),
    /requires an identified agent, runtime, or device/,
  );
  await assert.rejects(
    service.promote({
      ...request,
      approvedBy: { lifeDid: scope.lifeDid, agentId: "human-reviewer" },
      approvalEvidenceIds: [
        "approval:governed-review-receipt",
        "approval:governed-review-receipt",
      ],
      idempotencyKey: "duplicate-approval-evidence",
    }),
    /approval evidence must be unique/,
  );
  await assert.rejects(
    service.promote({
      ...request,
      approvedBy: { lifeDid: scope.lifeDid, agentId: "human-reviewer" },
      approvalEvidenceIds: ["approval: "],
      idempotencyKey: "malformed-approval-evidence",
    }),
    /approvalEvidenceId .* must be sourceType:sourceRef/,
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
      approvalEvidenceIds,
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
      approvalEvidenceIds,
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
      approvalEvidenceIds,
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
      approvalEvidenceIds,
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

test("DLMF-SG-009 PostgreSQL promotion lock fails fast with a single-connection pool", async () => {
  const pool = new Pool({ max: 1 });
  try {
    await assert.rejects(
      new PostgresInsightPromotionRecordStore(pool).withInsightLock(
        scope,
        "insight_single_connection_pool" as ReflectiveInsight["insightId"],
        async () => undefined,
      ),
      /at least two connections/,
    );
  } finally {
    await pool.end();
  }
});
