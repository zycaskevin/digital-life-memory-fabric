import assert from "node:assert/strict";
import test from "node:test";

import {
  CanonicalMemoryAuthority,
  InMemoryCanonicalMemoryStore,
  InMemoryInsightPromotionRecordStore,
  InMemoryReflectiveInsightStore,
  InsightPromotionOperator,
  MemoryCandidateService,
  ReflectiveInsightPromotionGate,
  sealInsightPromotionApprovalManifest,
  type Clock,
  type InsightPromotionApprovalManifest,
  type InsightPromotionPlan,
  type InsightPromotionStateReader,
  type InsightPromotionStateSnapshot,
  type MemoryScope,
  type ReflectiveInsight,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "tenant_promotion_operator",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

class MutableClock implements Clock {
  constructor(private value: string) {}
  now(): string { return this.value; }
  set(value: string): void { this.value = value; }
}

async function seedCanonical(
  store: InMemoryCanonicalMemoryStore,
  options: { sourceId: string; semanticKey: string; text: string; evidence: string },
) {
  const candidate = await new MemoryCandidateService(store).ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "dlmf-test-seeder" },
    candidateType: "reviewed_fact_candidate",
    sourceType: "reviewed_evidence",
    sourceId: options.sourceId,
    memoryClass: "semantic_assertion",
    memoryKind: "technical_finding",
    memoryType: "technical_fact",
    speakerProvenance: "tool",
    semanticKey: options.semanticKey,
    proposedContent: { text: options.text },
    evidenceRefs: [{ sourceType: "review", sourceRef: options.evidence }],
    epistemicStatus: "system_observed",
    producer: { kind: "system", id: "dlmf-test-seeder" },
    sourceExperienceRefs: [{ sourceType: "reviewed_evidence", sourceId: options.sourceId }],
    proposedOperation: "create",
  });
  return new CanonicalMemoryAuthority(store).commit({
    candidateId: candidate.candidateId,
    idempotencyKey: `seed:${options.sourceId}`,
  });
}

class InMemoryPromotionStateReader implements InsightPromotionStateReader {
  constructor(
    private readonly canonicalStore: InMemoryCanonicalMemoryStore,
    private readonly promotionStore: InMemoryInsightPromotionRecordStore,
    private readonly insightId: ReflectiveInsight["insightId"],
  ) {}

  async snapshot(snapshotScope: MemoryScope): Promise<InsightPromotionStateSnapshot> {
    const changes = await this.canonicalStore.listChangesAfter(snapshotScope, 0, 1_000);
    const promotion = await this.promotionStore.getByInsightId(snapshotScope, this.insightId);
    const events = promotion === undefined
      ? []
      : await this.promotionStore.listEvents(snapshotScope, promotion.promotionId);
    return {
      candidates: changes.length,
      heads: new Set(changes.map((change) => change.memoryId)).size,
      revisions: changes.length,
      changes: changes.length,
      promotions: promotion === undefined ? 0 : 1,
      promotionEvents: events.length,
    };
  }
}

async function fixture() {
  const canonicalStore = new InMemoryCanonicalMemoryStore();
  const insightStore = new InMemoryReflectiveInsightStore();
  const promotionStore = new InMemoryInsightPromotionRecordStore();
  const support = await seedCanonical(canonicalStore, {
    sourceId: "operator-support",
    semanticKey: "technical:operator:support",
    text: "Three reviewed runs preserved the DLMF authority boundary.",
    evidence: "operator-support-1",
  });
  const clock = new MutableClock("2026-09-10T04:00:00.000Z");
  const base = {
    insightId: "insight_operator_canary" as const,
    scope,
    proposition: "A governed promotion operator reduces unreviewed canonical write risk.",
    epistemicStatus: "synthesized" as const,
    supportingMemoryIds: [support.head.memoryId],
    supportingEvidenceIds: ["review:operator-support-1"],
    contradictingMemoryIds: [],
    confidence: 0.93,
    derivationProvider: "hindsight",
    derivationModel: "synthetic-canary-model",
    derivationRunId: "synthetic-canary-run",
    status: "pending" as const,
    canonicalWritePerformed: false as const,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  };
  const insight: ReflectiveInsight = {
    ...base,
    promotionEligibility: new ReflectiveInsightPromotionGate().assess(base),
  };
  await insightStore.put(insight);
  const operator = new InsightPromotionOperator({
    canonicalStore,
    insightStore,
    promotionStore,
    stateReader: new InMemoryPromotionStateReader(canonicalStore, promotionStore, insight.insightId),
    clock,
  });
  return { canonicalStore, insightStore, promotionStore, insight, operator, clock };
}

function manifestFor(plan: InsightPromotionPlan): InsightPromotionApprovalManifest {
  return sealInsightPromotionApprovalManifest({
    formatVersion: "dlmf.insight-promotion-approval.v1",
    planId: plan.planId,
    planChecksum: plan.planChecksum,
    decision: "accept",
    reviewedBy: { lifeDid: scope.lifeDid, agentId: "owner-authorized-operator" },
    approvalEvidenceIds: ["owner_authorization:sg010-explicit-continue"],
    idempotencyKey: "sg010-operator-canary-v1",
    issuedAt: "2026-09-10T04:00:00.000Z",
    expiresAt: "2026-09-10T04:10:00.000Z",
  });
}

test("DLMF-SG-010 Plan and Dry-run revalidate closure without writes", async () => {
  const { operator, promotionStore, insight } = await fixture();
  const plan = await operator.createPlan({ scope, insightId: insight.insightId });
  const manifest = manifestFor(plan);
  const report = await operator.dryRun(plan, manifest);

  assert.equal(plan.currentStatus, "pending");
  assert.equal(plan.eligibility.eligible, true);
  assert.equal(plan.eligibility.evidenceClosure, true);
  assert.equal(report.canonicalWritePerformed, false);
  assert.equal(report.automaticPromotionEnabled, false);
  assert.equal(await promotionStore.getByInsightId(scope, insight.insightId), undefined);
});

test("DLMF-SG-010 Apply is manifest-bound, audited, and idempotent", async () => {
  const { operator, promotionStore, insightStore, insight } = await fixture();
  const plan = await operator.createPlan({ scope, insightId: insight.insightId });
  const manifest = manifestFor(plan);
  const first = await operator.apply(plan, manifest);
  const replay = await operator.apply(plan, manifest);

  assert.equal(first.replay, false);
  assert.deepEqual(first.stateDelta, {
    candidates: 1,
    heads: 1,
    revisions: 1,
    changes: 1,
    promotions: 1,
    promotionEvents: 3,
  });
  assert.deepEqual(first.eventTypes, ["approved", "candidate_linked", "committed"]);
  assert.equal(first.promotionCanonicalCommitPerformed, true);
  assert.equal(first.reflectiveInsightCanonicalWritePerformed, false);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.stateDelta, {
    candidates: 0,
    heads: 0,
    revisions: 0,
    changes: 0,
    promotions: 0,
    promotionEvents: 0,
  });
  const record = await promotionStore.getByInsightId(scope, insight.insightId);
  assert.ok(record?.approvalEvidenceIds.includes(`approval_manifest:${manifest.manifestChecksum}`));
  assert.equal((await insightStore.get(insight.insightId))?.canonicalWritePerformed, false);
  assert.equal((await insightStore.get(insight.insightId))?.derivationProvider, "hindsight");
});

test("DLMF-SG-010 refuses tampered, stale, and expired operator documents", async () => {
  const tamperFixture = await fixture();
  const plan = await tamperFixture.operator.createPlan({ scope, insightId: tamperFixture.insight.insightId });
  const manifest = manifestFor(plan);
  await assert.rejects(
    tamperFixture.operator.dryRun({ ...plan, semanticKey: "tampered:key" }, manifest),
    /plan checksum mismatch/,
  );
  const { manifestChecksum: _manifestChecksum, ...manifestPayload } = manifest;
  const malformedEvidenceManifest = sealInsightPromotionApprovalManifest({
    ...manifestPayload,
    approvalEvidenceIds: ["approval: invalid-leading-space"],
  });
  await assert.rejects(
    tamperFixture.operator.dryRun(plan, malformedEvidenceManifest),
    /must be sourceType:sourceRef/,
  );

  const staleFixture = await fixture();
  const stalePlan = await staleFixture.operator.createPlan({ scope, insightId: staleFixture.insight.insightId });
  await seedCanonical(staleFixture.canonicalStore, {
    sourceId: "post-plan-change",
    semanticKey: "technical:operator:post-plan-change",
    text: "A canonical change after planning invalidates the bounded state snapshot.",
    evidence: "post-plan-change-1",
  });
  await assert.rejects(
    staleFixture.operator.dryRun(stalePlan, manifestFor(stalePlan)),
    /plan is stale because governed state changed/,
  );

  const expiredFixture = await fixture();
  const expiredPlan = await expiredFixture.operator.createPlan({
    scope,
    insightId: expiredFixture.insight.insightId,
    expiresInMs: 60_000,
  });
  const sealedExpiredManifest = manifestFor(expiredPlan);
  const { manifestChecksum: _checksum, ...unsealedExpiredManifest } = sealedExpiredManifest;
  const expiredManifest = sealInsightPromotionApprovalManifest({
    ...unsealedExpiredManifest,
    expiresAt: "2026-09-10T04:01:00.000Z",
  });
  expiredFixture.clock.set("2026-09-10T04:02:00.000Z");
  await assert.rejects(
    expiredFixture.operator.dryRun(expiredPlan, expiredManifest),
    /plan is expired/,
  );
});
