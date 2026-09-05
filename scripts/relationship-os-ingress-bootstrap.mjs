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
       to_regclass('memory_outbox') AS outbox`,
  );
  const row = state.rows[0] ?? {};
  const empty = row.memory_heads == null && row.receipts == null && row.curation == null && row.outbox == null;
  const complete = row.memory_heads != null && row.receipts != null && row.curation != null && row.outbox != null;
  if (!empty && !complete) {
    throw new Error("DLMF Relationship OS schema is partially initialized; refusing automatic repair");
  }
  if (empty) {
    for (const migration of [
      "migrations/0001_canonical_core.sql",
      "migrations/0002_central_operations.sql",
      "migrations/0003_memory_distillation.sql",
      "migrations/0004_canonical_admission.sql",
    ]) {
      await pool.query(await readFile(resolve(migration), "utf8"));
    }
  }
  await pool.query("SELECT 1 FROM memory_heads LIMIT 1");
  await pool.query("SELECT 1 FROM memory_distillation_receipts LIMIT 1");
  await pool.query("SELECT 1 FROM memory_curation_records LIMIT 1");
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
