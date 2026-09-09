import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.DLFM_TEST_DATABASE_URL;
const maybeTest = databaseUrl === undefined ? test.skip : test;

interface WorkerResult {
  type: "result";
  workerId: string;
  curationOutcomes: {
    canonical_candidate: number;
    canonical_merge: number;
  };
  canonicalMemoryIds: string[];
  warnings: string[];
  status: string;
  errors: Array<{ code: string; message: string }>;
}

interface RaceWorker {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<WorkerResult>;
}

function raceWorker(
  workerId: string,
  schema: string,
  archiveRoot: string,
): RaceWorker {
  const child = fork(
    new URL("./fixtures/postgres-semantic-race-worker.js", import.meta.url),
    [],
    {
      env: {
        ...process.env,
        DLFM_TEST_DATABASE_URL: databaseUrl,
        DLFM_RACE_SCHEMA: schema,
        DLFM_RACE_ARCHIVE_ROOT: archiveRoot,
        DLFM_RACE_WORKER_ID: workerId,
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
      resultReject(new Error(typed.message ?? `race worker ${workerId} failed`));
    }
  });
  child.on("error", resultReject);
  child.on("exit", (code) => {
    if (code !== 0) {
      resultReject(
        new Error(`race worker ${workerId} exited ${code}: ${stderr}`),
      );
    }
  });
  return { child, ready, result };
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out`)),
      20_000,
    );
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

maybeTest("DLMF-SG-002 PostgreSQL multiprocess semantic-key loser retries as merge", async () => {
  assert.ok(databaseUrl);
  const schema = `dlfm_race_${randomUUID().replaceAll("-", "")}`;
  const archiveRoot = await mkdtemp(join(tmpdir(), "dlmf-pg-race-"));
  const adminPool = new Pool({ connectionString: databaseUrl });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migrationPool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  const workers: RaceWorker[] = [];

  try {
    for (const migration of [
      "migrations/0001_canonical_core.sql",
      "migrations/0002_central_operations.sql",
      "migrations/0003_memory_distillation.sql",
      "migrations/0004_canonical_admission.sql",
      "migrations/0005_semantic_governance.sql",
    ]) {
      await migrationPool.query(await readFile(migration, "utf8"));
    }

    workers.push(
      raceWorker("a", schema, archiveRoot),
      raceWorker("b", schema, archiveRoot),
    );
    await withTimeout(
      Promise.all(workers.map((worker) => worker.ready)),
      "race barrier",
    );
    for (const worker of workers) worker.child.send("release");
    const results = await withTimeout(
      Promise.all(workers.map((worker) => worker.result)),
      "race results",
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ["complete", "complete"],
      JSON.stringify(results),
    );

    assert.equal(
      results.reduce(
        (sum, result) => sum + result.curationOutcomes.canonical_candidate,
        0,
      ),
      1,
    );
    assert.equal(
      results.reduce(
        (sum, result) => sum + result.curationOutcomes.canonical_merge,
        0,
      ),
      1,
      JSON.stringify(results),
    );
    assert.equal(
      results.some((result) =>
        result.warnings.some((warning) =>
          warning.startsWith("admission:semantic_identity_collision_retry:"),
        ),
      ),
      true,
    );
    assert.equal(
      new Set(results.flatMap((result) => result.canonicalMemoryIds)).size,
      1,
    );

    const heads = await migrationPool.query<{
      memory_id: string;
      current_revision: number;
    }>(
      `SELECT memory_id, current_revision FROM memory_heads
        WHERE tenant_id='tenant_postgres_process_race'
          AND life_did='did:life:nancy'
          AND memory_namespace='life.core'`,
    );
    assert.equal(heads.rowCount, 1);
    assert.equal(heads.rows[0]?.current_revision, 2);
    const statuses = await migrationPool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM memory_candidates
        GROUP BY status ORDER BY status`,
    );
    assert.deepEqual(
      Object.fromEntries(statuses.rows.map((row) => [row.status, Number(row.count)])),
      { ACCEPTED: 2, CONFLICT: 1 },
    );
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null) worker.child.kill("SIGTERM");
    }
    await migrationPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
    await rm(archiveRoot, { recursive: true, force: true });
  }
});
