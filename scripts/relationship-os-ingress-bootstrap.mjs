import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

const databaseUrl = requiredEnv("DLMF_RELATIONSHIP_OS_DATABASE_URL");
const schema = validatedSchema(process.env.DLMF_RELATIONSHIP_OS_SCHEMA || "dlmf_relationship_os");
const archiveRoot = resolve(requiredEnv("DLMF_RELATIONSHIP_OS_ARCHIVE_ROOT"));

const admin = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
} finally {
  await admin.end();
}

const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: 1,
});
try {
  const state = await pool.query(
    `SELECT
       to_regclass('memory_heads') AS memory_heads,
       to_regclass('memory_distillation_receipts') AS receipts,
       to_regclass('memory_curation_records') AS curation,
       to_regclass('memory_outbox') AS outbox,
       to_regclass('semantic_review_cases') AS review_cases,
       to_regclass('semantic_review_events') AS review_events,
       to_regclass('dlfm_schema_migrations') AS schema_migrations`,
  );
  const row = state.rows[0] ?? {};
  const coreEmpty =
    row.memory_heads == null && row.receipts == null && row.curation == null && row.outbox == null;
  const coreComplete =
    row.memory_heads != null && row.receipts != null && row.curation != null && row.outbox != null;
  const reviewEmpty = row.review_cases == null && row.review_events == null;
  const reviewComplete = row.review_cases != null && row.review_events != null;
  if ((!coreEmpty && !coreComplete) || (coreEmpty && (!reviewEmpty || row.schema_migrations != null))) {
    throw new Error("DLMF Relationship OS schema is partially initialized; refusing automatic repair");
  }
  if (coreEmpty) {
    for (const migration of [
      "migrations/0001_canonical_core.sql",
      "migrations/0002_central_operations.sql",
      "migrations/0003_memory_distillation.sql",
      "migrations/0004_canonical_admission.sql",
      "migrations/0005_semantic_governance.sql",
      "migrations/0006_semantic_review_queue.sql",
    ]) {
      await pool.query(await readFile(resolve(migration), "utf8"));
    }
  } else {
    if (!reviewEmpty && !reviewComplete) {
      throw new Error("DLMF Relationship OS semantic review schema is partial; refusing automatic repair");
    }
    const migrationTracked = row.schema_migrations == null
      ? false
      : (await pool.query(
          `SELECT EXISTS(
             SELECT 1 FROM dlfm_schema_migrations WHERE migration_name=$1
           ) AS applied`,
          ["0006_semantic_review_queue.sql"],
        )).rows[0]?.applied === true;
    if (migrationTracked && !reviewComplete) {
      throw new Error("DLMF migration 0006 is tracked but semantic review tables are missing");
    }
    if (!migrationTracked) {
      if (!reviewEmpty) {
        throw new Error("DLMF semantic review tables exist without a tracked migration; refusing adoption");
      }
      await pool.query(await readFile(resolve("migrations/0006_semantic_review_queue.sql"), "utf8"));
    }
  }
  await pool.query("SELECT 1 FROM memory_heads LIMIT 1");
  await pool.query("SELECT 1 FROM memory_distillation_receipts LIMIT 1");
  await pool.query("SELECT 1 FROM memory_curation_records LIMIT 1");
  await pool.query("SELECT 1 FROM semantic_review_cases LIMIT 1");
  await pool.query("SELECT 1 FROM semantic_review_events LIMIT 1");
  const migration = await pool.query(
    `SELECT count(*)::int AS count
       FROM dlfm_schema_migrations WHERE migration_name=$1`,
    ["0006_semantic_review_queue.sql"],
  );
  if (migration.rows[0]?.count !== 1) {
    throw new Error("DLMF migration 0006 is not tracked exactly once");
  }
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  await import("node:fs/promises").then(({ chmod }) => chmod(archiveRoot, 0o700));
  console.log(`DLMF_RELATIONSHIP_OS_BOOTSTRAP=PASS schema=${schema}`);
  console.log(`archive_root=${archiveRoot}`);
} finally {
  await pool.end();
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function validatedSchema(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("DLMF_RELATIONSHIP_OS_SCHEMA invalid");
  return value;
}
