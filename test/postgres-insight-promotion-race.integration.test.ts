import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import {
  CanonicalMemoryAuthority,
  MemoryCandidateService,
  PostgresCanonicalMemoryStore,
  PostgresReflectiveInsightStore,
  ReflectiveInsightPromotionGate,
} from "../src/index.js";

const databaseUrl = process.env.DLFM_TEST_DATABASE_URL;
const maybeTest = databaseUrl === undefined ? test.skip : test;

interface WorkerResult {
  type: "result";
  workerId: string;
  status: string;
  promotionId: string;
  candidateId: string;
  canonicalMemoryId: string;
  eventTypes: string[];
}

interface RaceWorker {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<WorkerResult>;
}

function raceWorker(workerId: string, schema: string, insightId: string): RaceWorker {
  const child = fork(
    new URL("./fixtures/postgres-insight-promotion-race-worker.js", import.meta.url),
    [],
    {
      env: {
        ...process.env,
        DLFM_TEST_DATABASE_URL: databaseUrl,
        DLFM_PROMOTION_RACE_SCHEMA: schema,
        DLFM_PROMOTION_RACE_WORKER_ID: workerId,
        DLFM_PROMOTION_RACE_INSIGHT_ID: insightId,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let readyResolve!: () => void;
  let resultResolve!: (value: WorkerResult) => void;
  let resultReject!: (reason: Error) => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  child.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    const typed = message as { type?: string; message?: string };
    if (typed.type === "ready") readyResolve();
    if (typed.type === "result") resultResolve(message as WorkerResult);
    if (typed.type === "error") {
      resultReject(new Error(typed.message ?? "promotion race worker failed"));
    }
  });
  child.on("error", resultReject);
  child.on("exit", (code) => {
    if (code !== 0) {
      resultReject(new Error("promotion race worker " + workerId + " exited " + code + ": " + stderr));
    }
  });
  return { child, ready, result };
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " timed out")), 30_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

maybeTest("DLMF-SG-009 PostgreSQL multiprocess insight promotion has one replayable winner", async () => {
  assert.ok(databaseUrl);
  const schema = "dlfm_promotion_race_" + randomUUID().replaceAll("-", "");
  const adminPool = new Pool({ connectionString: databaseUrl });
  await adminPool.query('CREATE SCHEMA "' + schema + '"');
  const pool = new Pool({
    connectionString: databaseUrl,
    options: "-c search_path=" + schema,
  });
  const workers: RaceWorker[] = [];

  try {
    for (const migration of [
      "migrations/0001_canonical_core.sql",
      "migrations/0002_central_operations.sql",
      "migrations/0003_memory_distillation.sql",
      "migrations/0004_canonical_admission.sql",
      "migrations/0005_semantic_governance.sql",
      "migrations/0006_semantic_review_queue.sql",
      "migrations/0007_insight_promotion_governance.sql",
    ]) {
      await pool.query(await readFile(migration, "utf8"));
    }

    const scope = {
      tenantId: "tenant_promotion_process_race",
      lifeDid: "did:life:nancy",
      memoryNamespace: "life.core",
    };
    const canonicalStore = new PostgresCanonicalMemoryStore(pool);
    const candidate = await new MemoryCandidateService(canonicalStore).ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, agentId: "review-system" },
      candidateType: "fact_candidate",
      sourceType: "reviewed_evidence",
      sourceId: "promotion-process-race-support",
      memoryClass: "semantic_assertion",
      memoryKind: "technical_finding",
      memoryType: "technical_fact",
      speakerProvenance: "tool",
      semanticKey: "technical:promotion-process-race-support",
      proposedContent: { text: "Two-process promotion support was independently verified." },
      evidenceRefs: [
        { sourceType: "review", sourceRef: "promotion-process-race-evidence" },
      ],
      epistemicStatus: "system_observed",
      producer: { kind: "system", id: "dlmf-review" },
      sourceExperienceRefs: [
        { sourceType: "reviewed_evidence", sourceId: "promotion-process-race-support" },
      ],
      proposedOperation: "create",
    });
    const support = await new CanonicalMemoryAuthority(canonicalStore).commit({
      candidateId: candidate.candidateId,
      idempotencyKey: "promotion-process-race-support",
    });

    const insightId = "insight_postgres_process_race" as const;
    const insight = {
      insightId,
      scope,
      proposition: "Concurrent insight promotion requires one governed winner.",
      epistemicStatus: "synthesized" as const,
      supportingMemoryIds: [support.head.memoryId],
      supportingEvidenceIds: ["review:promotion-process-race-evidence"],
      contradictingMemoryIds: [],
      confidence: 0.91,
      derivationProvider: "hindsight",
      derivationModel: "postgres-race-fixture",
      derivationRunId: "hs_promotion_process_race",
      status: "pending" as const,
      canonicalWritePerformed: false as const,
      createdAt: "2026-09-10T02:00:00.000Z",
      updatedAt: "2026-09-10T02:00:00.000Z",
    };
    await new PostgresReflectiveInsightStore(pool).put({
      ...insight,
      promotionEligibility: new ReflectiveInsightPromotionGate().assess(insight),
    });

    workers.push(
      raceWorker("a", schema, insightId),
      raceWorker("b", schema, insightId),
    );
    await withTimeout(Promise.all(workers.map((worker) => worker.ready)), "promotion race barrier");
    for (const worker of workers) worker.child.send("release");
    const results = await withTimeout(
      Promise.all(workers.map((worker) => worker.result)),
      "promotion race results",
    );

    assert.deepEqual(results.map((result) => result.status), ["committed", "committed"]);
    assert.equal(new Set(results.map((result) => result.promotionId)).size, 1);
    assert.equal(new Set(results.map((result) => result.candidateId)).size, 1);
    assert.equal(new Set(results.map((result) => result.canonicalMemoryId)).size, 1);
    assert.ok(results.every((result) =>
      JSON.stringify(result.eventTypes) ===
        JSON.stringify(["approved", "candidate_linked", "committed"])
    ));

    const counts = await pool.query(
      "SELECT " +
        "(SELECT count(*)::int FROM insight_promotion_records) AS promotions, " +
        "(SELECT count(*)::int FROM insight_promotion_events) AS events, " +
        "(SELECT count(*)::int FROM memory_candidates WHERE source_type='reflective_insight_promotion') AS candidates",
    );
    assert.deepEqual(counts.rows[0], { promotions: 1, events: 3, candidates: 1 });
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null) worker.child.kill("SIGTERM");
    }
    await pool.end();
    await adminPool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await adminPool.end();
  }
});
