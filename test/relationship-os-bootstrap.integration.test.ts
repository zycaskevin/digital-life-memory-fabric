import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Pool } from "pg";

const databaseUrl = process.env.DLFM_TEST_DATABASE_URL;
const maybeTest = databaseUrl === undefined ? test.skip : test;
const execFileAsync = promisify(execFile);

maybeTest("DLMF-SG-007 Relationship OS bootstrap upgrades pre-0006 schemas exactly once", async () => {
  assert.ok(databaseUrl);
  const schema = `dlmf_relationship_test_${randomUUID().replaceAll("-", "")}`;
  const archiveRoot = await mkdtemp(join(tmpdir(), "dlmf-sg007-archive-"));
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });

  try {
    for (const migration of [
      "migrations/0001_canonical_core.sql",
      "migrations/0002_central_operations.sql",
      "migrations/0003_memory_distillation.sql",
      "migrations/0004_canonical_admission.sql",
      "migrations/0005_semantic_governance.sql",
    ]) {
      await pool.query(await readFile(migration, "utf8"));
    }

    const env = {
      ...process.env,
      DLMF_RELATIONSHIP_OS_DATABASE_URL: databaseUrl,
      DLMF_RELATIONSHIP_OS_SCHEMA: schema,
      DLMF_RELATIONSHIP_OS_ARCHIVE_ROOT: archiveRoot,
    };
    const first = await execFileAsync(
      process.execPath,
      ["scripts/relationship-os-ingress-bootstrap.mjs"],
      { env, maxBuffer: 1_000_000 },
    );
    const replay = await execFileAsync(
      process.execPath,
      ["scripts/relationship-os-ingress-bootstrap.mjs"],
      { env, maxBuffer: 1_000_000 },
    );
    assert.match(first.stdout, /DLMF_RELATIONSHIP_OS_BOOTSTRAP=PASS/);
    assert.match(replay.stdout, /DLMF_RELATIONSHIP_OS_BOOTSTRAP=PASS/);

    const state = await pool.query(
      `SELECT to_regclass('semantic_review_cases') AS cases,
              to_regclass('semantic_review_events') AS events,
              (SELECT count(*)::int FROM dlfm_schema_migrations
                WHERE migration_name='0006_semantic_review_queue.sql') AS migration_count`,
    );
    assert.ok(state.rows[0]?.cases);
    assert.ok(state.rows[0]?.events);
    assert.equal(state.rows[0]?.migration_count, 1);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    await rm(archiveRoot, { recursive: true, force: true });
  }
});
