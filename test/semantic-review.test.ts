import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryMemoryCurationRecordStore,
  InMemorySemanticReviewStore,
  SemanticCanaryGate,
  SemanticReviewConflictError,
  SemanticReviewQueueService,
  type Clock,
  type MemoryCurationRecord,
  type MemoryScope,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "tenant_semantic_review",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

class AdvancingClock implements Clock {
  private tick = 0;

  now(): string {
    const value = new Date(Date.UTC(2026, 8, 9, 1, 0, this.tick));
    this.tick += 1;
    return value.toISOString();
  }
}

function record(
  suffix: string,
  outcome: MemoryCurationRecord["outcome"],
  overrides: Partial<MemoryCurationRecord> = {},
): MemoryCurationRecord {
  return {
    recordId: `cur_${suffix}`,
    receiptId: "dist_semantic_review_fixture",
    scope,
    sourceType: "hermes_session",
    sourceId: "20260828_174230_77857c",
    providerName: "hindsight",
    providerRunId: "hs_semantic_review_fixture",
    providerUnitRef: `unit_${suffix}`,
    providerUnitText: `private provider text ${suffix}`,
    providerUnitFingerprint: `sha256:${suffix.padEnd(64, "0").slice(0, 64)}`,
    providerEpistemicStatus: "user_asserted",
    attributedEpistemicBasis: "dlmf_semantic_policy",
    memoryType: "preference",
    speakerProvenance: "user",
    semanticKey: "preference:user:story_stream_structure:nancy_live_commentary_placement",
    semanticPolicyVersion: "dlmf-semantic-v5",
    semanticRelation: outcome === "pending_review" ? "contradicts" : "equivalent",
    curationProvider: "dlmf-conservative-curation",
    curationProviderVersion: "pilot-curation-v4",
    admissionPolicyVersion: "pilot-admission-v1",
    outcome,
    attributedEpistemicStatus: "user_asserted",
    durability: "durable",
    memoryWorthy: true,
    semanticDisposition: outcome === "pending_review" ? "merge_required" : "duplicate",
    reasonCodes: outcome === "pending_review"
      ? ["semantic:contradiction_requires_review"]
      : ["semantic:reviewed_equivalence"],
    createdAt: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

test("DLMF-SG-007 queues content-minimized pending and canary cases idempotently", async () => {
  const curationStore = new InMemoryMemoryCurationRecordStore();
  const reviewStore = new InMemorySemanticReviewStore();
  const queue = new SemanticReviewQueueService(curationStore, reviewStore, new AdvancingClock());
  const pending = record("pending", "pending_review");
  const sample = record("sample", "canonical_merge", {
    reasonCodes: [
      "semantic:reviewed_equivalence",
      " semantic:reviewed_equivalence ",
      "semantic:reviewed_equivalence",
    ],
  });
  await curationStore.put(pending);
  await curationStore.put(sample);

  const first = await queue.enqueueReceipt({
    receiptId: pending.receiptId,
    canarySampleRecordIds: [sample.recordId],
  });
  const replay = await queue.enqueueReceipt({
    receiptId: pending.receiptId,
    canarySampleRecordIds: [sample.recordId],
  });

  assert.equal(first.length, 2);
  assert.deepEqual(replay.map((item) => item.caseId), first.map((item) => item.caseId));
  assert.equal(first.find((item) => item.curationRecordId === pending.recordId)?.trigger, "pending_review");
  assert.equal(first.find((item) => item.curationRecordId === sample.recordId)?.trigger, "canary_sample");
  assert.ok(first.every((item) => item.canonicalWritePerformed === false));
  assert.doesNotMatch(JSON.stringify(first), /private provider text/);
  assert.equal((await reviewStore.listEvents(scope, first[0]!.caseId)).length, 1);
  assert.equal((await reviewStore.listEvents(scope, first[1]!.caseId)).length, 1);
  assert.deepEqual(
    first.find((item) => item.curationRecordId === sample.recordId)?.triggerReasonCodes,
    ["semantic:reviewed_equivalence"],
  );
  const foreignScope = { ...scope, tenantId: "tenant_foreign" };
  assert.equal(await reviewStore.get(foreignScope, first[0]!.caseId), undefined);
  assert.deepEqual(await reviewStore.listByReceipt(foreignScope, pending.receiptId), []);
  assert.deepEqual(await reviewStore.listEvents(foreignScope, first[0]!.caseId), []);
});

test("DLMF-SG-007 enforces scoped decisions, replay safety, and optimistic versions", async () => {
  const curationStore = new InMemoryMemoryCurationRecordStore();
  const reviewStore = new InMemorySemanticReviewStore();
  const queue = new SemanticReviewQueueService(curationStore, reviewStore, new AdvancingClock());
  const pending = record("decision_pending", "pending_review");
  const sample = record("decision_sample", "canonical_candidate");
  await curationStore.put(pending);
  await curationStore.put(sample);
  const cases = await queue.enqueueReceipt({
    receiptId: pending.receiptId,
    canarySampleRecordIds: [sample.recordId],
  });
  const pendingCase = cases.find((item) => item.curationRecordId === pending.recordId)!;
  const sampleCase = cases.find((item) => item.curationRecordId === sample.recordId)!;
  const reviewer = { lifeDid: scope.lifeDid, agentId: "manual-reviewer" };
  const deferRequest = {
    caseId: pendingCase.caseId,
    scope,
    expectedVersion: 1,
    idempotencyKey: "review-pending-defer-v1",
    disposition: "needs_more_evidence" as const,
    reviewer,
    evidenceIds: ["curation:cur_decision_pending"],
    reasonCodes: ["review:evidence_gap"],
  };

  await assert.rejects(
    queue.resolve({
      ...deferRequest,
      idempotencyKey: "review-missing-actor",
      reviewer: { lifeDid: scope.lifeDid },
    }),
    /identified reviewer actor/,
  );
  await assert.rejects(
    queue.resolve({
      ...deferRequest,
      idempotencyKey: "review-unsupported-reviewer-field",
      reviewer: { ...reviewer, privateText: "must-not-persist" } as typeof reviewer,
    }),
    /unsupported fields/,
  );
  await assert.rejects(
    queue.resolve({
      ...deferRequest,
      idempotencyKey: "review-unbound-evidence",
      evidenceIds: ["curation:other_record"],
    }),
    /bind the governed curation record/,
  );
  const [deferred, replay] = await Promise.all([
    queue.resolve(deferRequest),
    queue.resolve(deferRequest),
  ]);
  assert.equal(deferred.status, "deferred");
  assert.equal(replay.version, 2);
  await assert.rejects(
    queue.resolve({
      ...deferRequest,
      idempotencyKey: "review-pending-stale-v1",
      disposition: "confirmed_contradiction",
      reasonCodes: ["review:contradiction_confirmed"],
    }),
    SemanticReviewConflictError,
  );
  await assert.rejects(
    queue.resolve({
      caseId: sampleCase.caseId,
      scope: { ...scope, tenantId: "tenant_other" },
      expectedVersion: 1,
      idempotencyKey: "review-cross-scope",
      disposition: "approved_as_classified",
      reviewer,
      evidenceIds: ["curation:cur_decision_sample"],
      reasonCodes: ["review:sample_approved"],
    }),
    /was not found/,
  );

  const resolvedPending = await queue.resolve({
    ...deferRequest,
    expectedVersion: 2,
    idempotencyKey: "review-pending-resolve-v2",
    disposition: "confirmed_contradiction",
    reasonCodes: ["review:contradiction_confirmed"],
  });
  const resolvedSample = await queue.resolve({
    caseId: sampleCase.caseId,
    scope,
    expectedVersion: 1,
    idempotencyKey: "review-sample-approve-v1",
    disposition: "approved_as_classified",
    reviewer,
    evidenceIds: ["curation:cur_decision_sample"],
    reasonCodes: ["review:sample_approved"],
  });

  assert.equal(resolvedPending.status, "resolved");
  assert.equal(resolvedPending.version, 3);
  assert.equal(resolvedSample.status, "resolved");
  assert.equal((await reviewStore.listEvents(scope, pendingCase.caseId)).length, 3);
  assert.ok(
    (await reviewStore.list(scope, { status: "resolved" }))
      .every((item) => item.canonicalWritePerformed === false),
  );
});

test("DLMF-SG-007 canary gate is read-only, content-free, and manual-only", async () => {
  const curationStore = new InMemoryMemoryCurationRecordStore();
  const reviewStore = new InMemorySemanticReviewStore();
  const queue = new SemanticReviewQueueService(curationStore, reviewStore, new AdvancingClock());
  const pending = record("gate_pending", "pending_review");
  const sample = record("gate_sample", "canonical_candidate");
  await curationStore.put(pending);
  await curationStore.put(sample);
  const cases = await queue.enqueueReceipt({
    receiptId: pending.receiptId,
    canarySampleRecordIds: [sample.recordId],
  });
  const pendingCase = cases.find((item) => item.curationRecordId === pending.recordId)!;
  const sampleCase = cases.find((item) => item.curationRecordId === sample.recordId)!;
  const approved = await queue.resolve({
    caseId: sampleCase.caseId,
    scope,
    expectedVersion: 1,
    idempotencyKey: "review-gate-sample-v1",
    disposition: "approved_as_classified",
    reviewer: { lifeDid: scope.lifeDid, agentId: "manual-reviewer" },
    evidenceIds: ["curation:cur_gate_sample"],
    reasonCodes: ["review:sample_approved"],
  });
  const gate = new SemanticCanaryGate();
  const blocked = gate.assess({
    receiptId: pending.receiptId,
    records: [pending, sample],
    reviewCases: [pendingCase, approved],
    expectedRecordCount: 2,
    expectedSemanticPolicyVersion: "dlmf-semantic-v5",
  });
  const eligible = gate.assess({
    receiptId: sample.receiptId,
    records: [sample],
    reviewCases: [approved],
    expectedRecordCount: 1,
    expectedSemanticPolicyVersion: "dlmf-semantic-v5",
  });

  assert.equal(blocked.eligibleForExpandedManualCanary, false);
  assert.ok(blocked.reasonCodes.includes("canary:pending_review_outcomes_present"));
  assert.equal(eligible.eligibleForExpandedManualCanary, true);
  assert.deepEqual(eligible.reasonCodes, ["canary:manual_expansion_eligible"]);
  assert.equal(eligible.automaticPruningEnabled, false);
  assert.equal(eligible.automaticPromotionEnabled, false);
  assert.equal(eligible.canonicalWritePerformed, false);
  assert.equal(eligible.telemetry.rawContentIncluded, false);
  assert.equal(eligible.telemetry.providerUnitTextIncluded, false);
  assert.doesNotMatch(JSON.stringify(eligible), /private provider text/);

  const foreignInput = gate.assess({
    receiptId: sample.receiptId,
    records: [sample, record("foreign", "canonical_candidate", { receiptId: "dist_foreign" })],
    reviewCases: [approved],
    expectedRecordCount: 1,
    expectedSemanticPolicyVersion: "dlmf-semantic-v5",
  });
  assert.equal(foreignInput.eligibleForExpandedManualCanary, false);
  assert.ok(foreignInput.reasonCodes.includes("canary:unexpected_receipt_records"));

  const mismatchedInput = gate.assess({
    receiptId: sample.receiptId,
    records: [sample],
    reviewCases: [{ ...approved, semanticKey: "tampered:semantic:key" }],
    expectedRecordCount: 1,
    expectedSemanticPolicyVersion: "dlmf-semantic-v5",
  });
  assert.equal(mismatchedInput.eligibleForExpandedManualCanary, false);
  assert.ok(mismatchedInput.reasonCodes.includes("canary:review_case_source_mismatch"));
});
