import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";

const runId = process.argv[2] || process.env.DLMF_PILOT_RUN_ID;
if (!runId || !/^pilot_\d{14}$/.test(runId)) {
  console.error("Usage: npm run pilot:memory-distillation:inspect-run -- pilot_YYYYMMDDhhmmss");
  process.exit(2);
}

const home = process.env.HOME || homedir();
const envFile = resolve(
  process.env.DLMF_PILOT_ENV_FILE || join(home, ".config", "dlmf", "production-pilot.env"),
);

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const persisted = parseEnvFile(envFile);
const databaseUrl = process.env.DLMF_PILOT_DATABASE_URL || persisted.DLMF_PILOT_DATABASE_URL;
if (!databaseUrl) {
  console.error("DLMF pilot PostgreSQL is not configured.");
  process.exit(2);
}

const stamp = runId.slice("pilot_".length).toLowerCase();
const schema = `dlmf_pilot_v011_${stamp}`;
if (!/^dlmf_pilot_v011_\d{14}$/.test(schema)) throw new Error("Invalid derived pilot schema");

const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: 1,
  connectionTimeoutMillis: 5000,
});

try {
  const schemaCheck = await pool.query(
    "SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists",
    [schema],
  );
  if (!schemaCheck.rows[0]?.exists) {
    console.error(`PILOT_RUN_NOT_FOUND=${runId}`);
    process.exitCode = 2;
  } else {
    const receipts = await pool.query(`
      SELECT source_id, status, canonicalization_outcome,
             cardinality(candidate_ids) AS candidate_count,
             cardinality(canonical_memory_ids) AS canonical_count,
             prune_eligible, retention_state, attempts,
             jsonb_array_length(errors) AS error_count,
             jsonb_array_length(warnings) AS warning_count
        FROM memory_distillation_receipts
       WHERE memory_namespace='pilot.memory-distillation.v0.1.1'
       ORDER BY created_at, source_id
    `);
    const totals = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM memory_candidates) AS candidates,
        (SELECT count(*)::int FROM memory_heads) AS heads,
        (SELECT count(*)::int FROM memory_revisions) AS revisions,
        (SELECT count(*)::int FROM memory_changes) AS changes,
        (SELECT count(*)::int FROM memory_distillation_receipts) AS receipts
    `);
    const pendingReflective = await pool.query(`
      SELECT count(*)::int AS count
        FROM memory_candidates
       WHERE candidate_type='derived_insight_candidate' AND status='pending'
    `);

    console.log(`PILOT_RUN=${runId}`);
    console.log(`SCHEMA=${schema}`);
    for (const row of receipts.rows) {
      console.log(
        `source=${row.source_id} status=${row.status}/${row.canonicalization_outcome} candidates=${row.candidate_count} canonical=${row.canonical_count} pruneEligible=${row.prune_eligible} retention=${row.retention_state} errors=${row.error_count} warnings=${row.warning_count} attempts=${row.attempts}`,
      );
    }
    const t = totals.rows[0] ?? {};
    console.log(
      `TOTALS receipts=${t.receipts ?? 0} candidates=${t.candidates ?? 0} heads=${t.heads ?? 0} revisions=${t.revisions ?? 0} changes=${t.changes ?? 0} reflective_pending=${pendingReflective.rows[0]?.count ?? 0}`,
    );
    console.log("HERMES_PRUNE_EXECUTED=false");
    console.log("PILOT_RUN_INSPECT=PASS");
  }
} finally {
  await pool.end().catch(() => undefined);
}
