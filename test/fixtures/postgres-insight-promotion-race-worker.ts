import { Pool } from "pg";
import {
  PostgresCanonicalMemoryStore,
  PostgresInsightPromotionRecordStore,
  PostgresReflectiveInsightStore,
  ReflectiveInsightPromotionService,
  type MemoryScope,
  type ReflectiveInsightId,
} from "../../src/index.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(name + " is required");
  }
  return value;
}

const databaseUrl = required("DLFM_TEST_DATABASE_URL");
const schema = required("DLFM_PROMOTION_RACE_SCHEMA");
const workerId = required("DLFM_PROMOTION_RACE_WORKER_ID");
const insightId = required("DLFM_PROMOTION_RACE_INSIGHT_ID") as ReflectiveInsightId;
const pool = new Pool({
  connectionString: databaseUrl,
  options: "-c search_path=" + schema,
});
const canonicalStore = new PostgresCanonicalMemoryStore(pool);
const promotionStore = new PostgresInsightPromotionRecordStore(pool);
const insightStore = new PostgresReflectiveInsightStore(pool);
const scope: MemoryScope = {
  tenantId: "tenant_promotion_process_race",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

let release!: () => void;
const releaseGate = new Promise<void>((resolve) => {
  release = resolve;
});
process.on("message", (message) => {
  if (message === "release") release();
});

try {
  process.send?.({ type: "ready", workerId });
  await releaseGate;
  const result = await new ReflectiveInsightPromotionService({
    canonicalStore,
    insightStore,
    promotionStore,
    approvalVerifier: { verifyApproval: async () => true },
    clock: { now: () => "2026-09-10T02:00:01.000Z" },
  }).promote({
    insightId,
    scope,
    approvedBy: { lifeDid: scope.lifeDid, agentId: "human-race-reviewer" },
    approvalEvidenceIds: ["approval:postgres-process-race"],
    idempotencyKey: "postgres-process-race-v1",
  });
  process.send?.({
    type: "result",
    workerId,
    status: result.record.status,
    promotionId: result.record.promotionId,
    candidateId: result.record.candidateId,
    canonicalMemoryId: result.canonicalMemoryId,
    eventTypes: (await promotionStore.listEvents(scope, result.record.promotionId))
      .map((event) => event.eventType),
  });
} catch (error) {
  process.send?.({
    type: "error",
    workerId,
    message: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  await canonicalStore.close();
}
