import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";

import {
  CanonicalMemoryAuthority,
  InsightPromotionOperator,
  MemoryCandidateService,
  PostgresCanonicalMemoryStore,
  PostgresInsightPromotionRecordStore,
  PostgresInsightPromotionStateReader,
  PostgresReflectiveInsightStore,
  ReflectiveInsightPromotionGate,
  sealInsightPromotionApprovalManifest,
  type MemoryScope,
} from "../src/index.js";

const databaseUrl = process.env.DLFM_TEST_DATABASE_URL;
const maybeTest = databaseUrl === undefined ? test.skip : test;

maybeTest("DLMF-SG-010 PostgreSQL operator applies once with exact audit closure", async () => {
  assert.ok(databaseUrl);
  const schema = `dlmf_sg010_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 6,
    options: `-c search_path=${schema}`,
  });
  const canonicalStore = new PostgresCanonicalMemoryStore(pool);
  try {
    for (const migration of [
      "0001_canonical_core.sql",
      "0002_central_operations.sql",
      "0003_memory_distillation.sql",
      "0004_canonical_admission.sql",
      "0005_semantic_governance.sql",
      "0006_semantic_review_queue.sql",
      "0007_insight_promotion_governance.sql",
    ]) {
      await pool.query(await readFile(`migrations/${migration}`, "utf8"));
    }
    const scope: MemoryScope = {
      tenantId: "tenant_sg010_pg",
      lifeDid: "did:life:nancy",
      memoryNamespace: "promotion.canary",
    };
    const candidate = await new MemoryCandidateService(canonicalStore).ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, agentId: "sg010-canary-seeder" },
      candidateType: "reviewed_fact_candidate",
      sourceType: "synthetic_canary",
      sourceId: "sg010-support",
      memoryClass: "semantic_assertion",
      memoryKind: "technical_finding",
      memoryType: "technical_fact",
      speakerProvenance: "tool",
      semanticKey: "technical:sg010:reviewed-support",
      proposedContent: { text: "The isolated SG-010 canary has a reviewed canonical support fact." },
      evidenceRefs: [{ sourceType: "synthetic_review", sourceRef: "sg010-support-1" }],
      epistemicStatus: "system_observed",
      producer: { kind: "system", id: "dlmf-sg010-canary" },
      sourceExperienceRefs: [{ sourceType: "synthetic_canary", sourceId: "sg010-support" }],
      proposedOperation: "create",
    });
    const support = await new CanonicalMemoryAuthority(canonicalStore).commit({
      candidateId: candidate.candidateId,
      idempotencyKey: "sg010-seed-support",
    });
    const insightStore = new PostgresReflectiveInsightStore(pool);
    const promotionStore = new PostgresInsightPromotionRecordStore(pool);
    const baseInsight = {
      insightId: "insight_sg010_postgres_canary" as const,
      scope,
      proposition: "Governed Plan, Dry-run, and Apply controls reduce unreviewed promotion risk.",
      epistemicStatus: "synthesized" as const,
      supportingMemoryIds: [support.head.memoryId],
      supportingEvidenceIds: ["synthetic_review:sg010-support-1"],
      contradictingMemoryIds: [],
      confidence: 0.94,
      derivationProvider: "hindsight",
      derivationModel: "synthetic-canary-model",
      derivationRunId: "sg010-postgres-canary-run",
      status: "pending" as const,
      canonicalWritePerformed: false as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await insightStore.put({
      ...baseInsight,
      promotionEligibility: new ReflectiveInsightPromotionGate().assess(baseInsight),
    });
    const operator = new InsightPromotionOperator({
      canonicalStore,
      insightStore,
      promotionStore,
      stateReader: new PostgresInsightPromotionStateReader(pool),
    });
    const plan = await operator.createPlan({ scope, insightId: baseInsight.insightId });
    const manifest = sealInsightPromotionApprovalManifest({
      formatVersion: "dlmf.insight-promotion-approval.v1",
      planId: plan.planId,
      planChecksum: plan.planChecksum,
      decision: "accept",
      reviewedBy: { lifeDid: scope.lifeDid, agentId: "sg010-owner-authorized-operator" },
      approvalEvidenceIds: ["owner_authorization:sg010-postgres-test"],
      idempotencyKey: "sg010-postgres-operator-v1",
      issuedAt: plan.createdAt,
      expiresAt: plan.expiresAt,
    });
    const dryRun = await operator.dryRun(plan, manifest);
    assert.equal(dryRun.canonicalWritePerformed, false);
    const applied = await operator.apply(plan, manifest);
    const replay = await operator.apply(plan, manifest);

    assert.equal(applied.replay, false);
    assert.equal(applied.stateDelta.promotionEvents, 3);
    assert.deepEqual(applied.eventTypes, ["approved", "candidate_linked", "committed"]);
    assert.equal(replay.replay, true);
    assert.deepEqual(replay.stateDelta, {
      candidates: 0,
      heads: 0,
      revisions: 0,
      changes: 0,
      promotions: 0,
      promotionEvents: 0,
    });
    const storedInsight = await insightStore.get(baseInsight.insightId);
    assert.equal(storedInsight?.status, "accepted");
    assert.equal(storedInsight?.canonicalWritePerformed, false);
    assert.equal(storedInsight?.derivationProvider, "hindsight");
    const ledger = await pool.query(
      "SELECT migration_name FROM dlfm_schema_migrations WHERE migration_name='0007_insight_promotion_governance.sql'",
    );
    assert.equal(ledger.rowCount, 1);
  } finally {
    await canonicalStore.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
