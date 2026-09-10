import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { Pool } from "pg";

const databaseUrl = process.env.DLFM_TEST_DATABASE_URL;
const maybeTest = databaseUrl === undefined ? test.skip : test;
const execFileAsync = promisify(execFile);
const MIGRATIONS = [
  "migrations/0001_canonical_core.sql",
  "migrations/0002_central_operations.sql",
  "migrations/0003_memory_distillation.sql",
  "migrations/0004_canonical_admission.sql",
  "migrations/0005_semantic_governance.sql",
  "migrations/0006_semantic_review_queue.sql",
  "migrations/0007_insight_promotion_governance.sql",
];

maybeTest("Digital-Life-Stack bootstrap is replay-safe and restart-ready on PostgreSQL", async () => {
  assert.ok(databaseUrl);
  const schema = disposableSchema("dlmf_dls_fresh");
  const admin = new Pool({ connectionString: databaseUrl });
  try {
    const first = await runScript("scripts/digital-life-stack-bootstrap.mjs", {
      DLMF_DLS_DATABASE_URL: databaseUrl,
      DLMF_DLS_SCHEMA: schema,
    });
    assert.match(first.stdout, /DLMF_DLS_BOOTSTRAP=PASS/);
    assert.match(first.stdout, /state=current-0007/);
    assert.match(first.stdout, /applied=7/);

    const replay = await runScript("scripts/digital-life-stack-bootstrap.mjs", {
      DLMF_DLS_DATABASE_URL: databaseUrl,
      DLMF_DLS_SCHEMA: schema,
    });
    assert.match(replay.stdout, /applied=0/);

    const firstHealth = await runScript("scripts/digital-life-stack-health.mjs", {
      DLMF_DLS_DATABASE_URL: databaseUrl,
      DLMF_DLS_SCHEMA: schema,
    });
    const restartedHealth = await runScript("scripts/digital-life-stack-health.mjs", {
      DLMF_DLS_DATABASE_URL: databaseUrl,
      DLMF_DLS_SCHEMA: schema,
    });
    assert.match(firstHealth.stdout, /DLMF_DLS_READINESS=PASS/);
    assert.match(restartedHealth.stdout, /DLMF_DLS_READINESS=PASS/);

    const pool = scopedPool(databaseUrl, schema);
    try {
      const ledger = await pool.query(
        "SELECT migration_name, count(*)::int AS count FROM dlfm_schema_migrations GROUP BY migration_name ORDER BY migration_name",
      );
      assert.deepEqual(ledger.rows, [
        { migration_name: "0006_semantic_review_queue.sql", count: 1 },
        { migration_name: "0007_insight_promotion_governance.sql", count: 1 },
      ]);
    } finally {
      await pool.end();
    }
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

maybeTest("stale PostgreSQL schema fails closed until explicit upgrade", async () => {
  assert.ok(databaseUrl);
  const schema = disposableSchema("dlmf_dls_stale");
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = scopedPool(databaseUrl, schema);
  try {
    for (const migration of MIGRATIONS.slice(0, 6)) {
      await pool.query(await readFile(migration, "utf8"));
    }

    await assert.rejects(
      runScript("scripts/digital-life-stack-health.mjs", {
        DLMF_DLS_DATABASE_URL: databaseUrl,
        DLMF_DLS_SCHEMA: schema,
      }),
      /DLMF_DLS_READINESS=FAIL|Command failed/,
    );
    await assert.rejects(
      runScript("scripts/digital-life-stack-bootstrap.mjs", {
        DLMF_DLS_DATABASE_URL: databaseUrl,
        DLMF_DLS_SCHEMA: schema,
      }),
      /explicit DLMF_DLS_ALLOW_UPGRADE=1 is required|Command failed/,
    );

    const upgraded = await runScript("scripts/digital-life-stack-bootstrap.mjs", {
      DLMF_DLS_DATABASE_URL: databaseUrl,
      DLMF_DLS_SCHEMA: schema,
      DLMF_DLS_ALLOW_UPGRADE: "1",
    });
    assert.match(upgraded.stdout, /state=current-0007/);
    assert.match(upgraded.stdout, /applied=1/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

maybeTest("partially initialized PostgreSQL schema is never auto-repaired", async () => {
  assert.ok(databaseUrl);
  const schema = disposableSchema("dlmf_dls_partial");
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = scopedPool(databaseUrl, schema);
  try {
    await pool.query("CREATE TABLE memory_heads(memory_id text PRIMARY KEY)");
    await assert.rejects(
      runScript("scripts/digital-life-stack-bootstrap.mjs", {
        DLMF_DLS_DATABASE_URL: databaseUrl,
        DLMF_DLS_SCHEMA: schema,
        DLMF_DLS_ALLOW_UPGRADE: "1",
      }),
      /partial, corrupted, or newer|Command failed/,
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

function disposableSchema(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`.slice(0, 63);
}

function scopedPool(url: string, schema: string): Pool {
  return new Pool({ connectionString: url, options: `-c search_path=${schema}` });
}

async function runScript(path: string, extraEnv: Record<string, string>) {
  return execFileAsync(process.execPath, [path], {
    env: { ...process.env, ...extraEnv },
    maxBuffer: 1_000_000,
  });
}
