import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { validatedDlmfSchema } from "../digital-life-stack-schema-lib.mjs";

const home = process.env.HOME || homedir();
const privatePilotConfig = resolve(
  process.env.DLMF_MIGRATION_PILOT_CONFIG || join(home, ".config", "dlmf", "production-pilot.env"),
);
const persistedPilot = readSimpleEnvFile(privatePilotConfig);
const databaseUrl = firstText(
  process.env.DLMF_MIGRATION_DATABASE_URL,
  process.env.DLMF_PILOT_DATABASE_URL,
  persistedPilot.DLMF_PILOT_DATABASE_URL,
);
if (!databaseUrl) throw new Error("DLMF migration PostgreSQL is not configured");

const schema = validatedDlmfSchema(
  process.env.DLMF_MIGRATION_SCHEMA || "dlmf_pilot_hermes_canonical_canary_v1",
);
if (!schema.startsWith("dlmf_pilot_")) throw new Error("inspection is restricted to dlmf_pilot_* schemas");

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function readSimpleEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/u)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 16);
}

const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: 1,
  connectionTimeoutMillis: 5_000,
});

try {
  const table = await pool.query("SELECT to_regclass('memory_distillation_receipts') AS receipts");
  if (table.rows[0]?.receipts == null) throw new Error("pilot schema has no memory_distillation_receipts table");

  const rows = (await pool.query(`SELECT
      receipt_id, status, provider, provider_unit_count, curation_decision_count,
      curation_coverage_complete, admission_complete, canonicalization_outcome,
      attempts, errors, warnings,
      cardinality(candidate_ids) AS candidate_count,
      cardinality(canonical_memory_ids) AS canonical_count,
      updated_at
    FROM memory_distillation_receipts
    WHERE source_type='normalized_experience'
    ORDER BY updated_at DESC
    LIMIT 5`)).rows;

  console.log("DLMF Hermes Migration Failure Inspector");
  console.log(`schema=${schema}`);
  console.log(`receipts=${rows.length}`);
  for (const [index, row] of rows.entries()) {
    const errors = Array.isArray(row.errors) ? row.errors : [];
    const latest = errors.at(-1) || {};
    console.log(
      [
        `receipt[${index}]=${hash(row.receipt_id)}`,
        `status=${String(row.status)}`,
        `outcome=${String(row.canonicalization_outcome)}`,
        `attempts=${Number(row.attempts ?? 0)}`,
        `providerUnits=${Number(row.provider_unit_count ?? 0)}`,
        `curation=${Number(row.curation_decision_count ?? 0)}`,
        `coverage=${row.curation_coverage_complete === true}`,
        `admission=${row.admission_complete === true}`,
        `candidates=${Number(row.candidate_count ?? 0)}`,
        `canonical=${Number(row.canonical_count ?? 0)}`,
        `errorStage=${latest.stage ?? "none"}`,
        `errorCode=${latest.code ?? "none"}`,
        `errorFingerprint=${latest.message ? hash(latest.message) : "none"}`,
      ].join(" "),
    );
  }
  console.log("HERMES_MIGRATION_FAILURE_INSPECT=PASS");
} finally {
  await pool.end();
}
