import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Pool } from "pg";

const MIGRATION_NAME = "0007_insight_promotion_governance.sql";
const FORMAT_VERSION = "dlmf.insight-promotion-migration-plan.v1";
const argv = process.argv.slice(2);
const mode = argv[0];
if (!["plan", "apply"].includes(mode)) {
  console.error("Usage: insight-promotion-migration.mjs <plan|apply> [options]");
  process.exit(2);
}
function argument(name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}
function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function sha256(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(stable(value)));
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}
function insideReportRoot(path, root, field) {
  const resolved = resolve(path);
  const rel = relative(resolve(root), resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${field} must stay inside protected report root ${resolve(root)}.`);
  }
  return resolved;
}
async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function backupEvidence(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0) throw new Error("Protected backup must be a non-empty file.");
  if ((metadata.mode & 0o777) !== 0o600) throw new Error("Protected backup must have mode 0600.");
  return { path, sizeBytes: metadata.size, mode: "0600", checksum: sha256(await readFile(path)) };
}
async function schemaState(pool) {
  const readiness = await pool.query(`SELECT
    to_regclass('memory_heads') IS NOT NULL AS canonical,
    to_regclass('reflective_insights') IS NOT NULL AS insights,
    to_regclass('insight_promotion_records') IS NOT NULL AS promotions,
    to_regclass('insight_promotion_events') IS NOT NULL AS events,
    to_regclass('dlfm_schema_migrations') IS NOT NULL AS ledger`);
  const ready = readiness.rows[0];
  if (ready?.canonical !== true || ready?.insights !== true || ready?.promotions !== true || ready?.ledger !== true) {
    throw new Error("Schema is missing the pre-0007 semantic-governance foundation.");
  }
  const counts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM memory_candidates) AS candidates,
    (SELECT count(*)::int FROM memory_heads) AS heads,
    (SELECT count(*)::int FROM memory_revisions) AS revisions,
    (SELECT count(*)::int FROM memory_changes) AS changes,
    (SELECT count(*)::int FROM insight_promotion_records) AS promotions`)).rows[0];
  const insights = (await pool.query(`SELECT insight_id, tenant_id, life_did, memory_namespace,
      epistemic_status, cardinality(supporting_memory_ids)::int AS supporting_memory_count,
      cardinality(supporting_evidence_ids)::int AS supporting_evidence_count,
      cardinality(contradicting_memory_ids)::int AS contradicting_memory_count,
      confidence::text, derivation_provider, status, promotion_eligibility,
      canonical_write_performed
    FROM reflective_insights ORDER BY insight_id`)).rows;
  const ledger = (await pool.query(
    "SELECT migration_name FROM dlfm_schema_migrations ORDER BY migration_name",
  )).rows.map((row) => row.migration_name);
  const state = {
    counts,
    insights,
    ledger,
    eventTablePresent: ready.events === true,
    migrationApplied: ledger.includes(MIGRATION_NAME),
  };
  return { ...state, invariantFingerprint: sha256({ counts, insights }) };
}
function planChecksum(plan) {
  const { planChecksum: _checksum, ...payload } = plan;
  return sha256(payload);
}

const home = process.env.HOME || homedir();
const envFile = resolve(process.env.DLMF_PILOT_ENV_FILE || join(home, ".config", "dlmf", "production-pilot.env"));
const config = parseEnvFile(envFile);
const databaseUrl = process.env.DLMF_PILOT_DATABASE_URL || config.DLMF_PILOT_DATABASE_URL;
if (!databaseUrl) throw new Error("DLMF pilot PostgreSQL is not configured.");
const schema = argument("--schema") || process.env.DLMF_PILOT_SCHEMA;
if (!schema || !/^dlmf_pilot_[a-z0-9_]+$/.test(schema)) {
  throw new Error("--schema must name an isolated dlmf_pilot_* schema.");
}
const reportRoot = resolve(process.env.DLMF_PILOT_REPORT_ROOT || join(home, ".local", "state", "dlmf", "production-pilot"));
const output = insideReportRoot(required("--output"), reportRoot, "Output");
const migrationPath = resolve("migrations", MIGRATION_NAME);
const migrationBytes = await readFile(migrationPath);
const migrationChecksum = sha256(migrationBytes);
const readOnly = mode === "plan";
const pool = new Pool({
  connectionString: databaseUrl,
  max: 3,
  options: `-c search_path=${schema}${readOnly ? " -c default_transaction_read_only=on" : ""}`,
});
try {
  if (mode === "plan") {
    const backup = await backupEvidence(insideReportRoot(required("--backup"), reportRoot, "Backup"));
    const preState = await schemaState(pool);
    if (preState.migrationApplied || preState.eventTablePresent) {
      throw new Error("Migration 0007 is already applied or partially present; no new plan was emitted.");
    }
    if (!preState.ledger.includes("0006_semantic_review_queue.sql")) {
      throw new Error("Migration 0006 ledger evidence is required before 0007.");
    }
    const createdAt = new Date().toISOString();
    const base = {
      formatVersion: FORMAT_VERSION,
      schema,
      migrationName: MIGRATION_NAME,
      migrationChecksum,
      backup,
      preState,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 30 * 60 * 1000).toISOString(),
      canonicalMutationExpected: false,
      reflectiveInsightMutationExpected: false,
      automaticPromotionEnabled: false,
      automaticPruningEnabled: false,
    };
    const planId = `migplan_${sha256(base).slice("sha256:".length, "sha256:".length + 32)}`;
    const unsealed = { ...base, planId, planChecksum: "" };
    const plan = { ...unsealed, planChecksum: planChecksum(unsealed) };
    await writePrivateJson(output, plan);
    console.log(JSON.stringify({ mode, schema, outputPath: output, planId, planChecksum: plan.planChecksum }));
  } else {
    if (process.env.DLMF_MIGRATION_APPLY_SCHEMA !== schema) {
      throw new Error("Apply is fail-closed unless DLMF_MIGRATION_APPLY_SCHEMA exactly matches --schema.");
    }
    const plan = JSON.parse(await readFile(resolve(required("--plan")), "utf8"));
    if (plan.formatVersion !== FORMAT_VERSION || plan.schema !== schema ||
        plan.migrationName !== MIGRATION_NAME || plan.migrationChecksum !== migrationChecksum ||
        plan.planChecksum !== planChecksum(plan)) {
      throw new Error("Migration plan identity or checksum validation failed.");
    }
    const now = Date.now();
    if (now < Date.parse(plan.createdAt) || now > Date.parse(plan.expiresAt)) {
      throw new Error("Migration plan is not currently valid.");
    }
    const backup = await backupEvidence(insideReportRoot(plan.backup.path, reportRoot, "Backup"));
    if (JSON.stringify(backup) !== JSON.stringify(plan.backup)) {
      throw new Error("Protected backup evidence no longer matches the migration plan.");
    }
    const before = await schemaState(pool);
    if (JSON.stringify(before) !== JSON.stringify(plan.preState)) {
      throw new Error("Migration plan is stale because schema state changed.");
    }
    const client = await pool.connect();
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1, 0))",
        [`dlmf-schema-migration:${schema}`],
      );
      try {
        await client.query(migrationBytes.toString("utf8"));
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [`dlmf-schema-migration:${schema}`],
        );
      } finally {
        client.release();
      }
    }
    const after = await schemaState(pool);
    if (!after.migrationApplied || !after.eventTablePresent) {
      throw new Error("Migration 0007 completion evidence is missing.");
    }
    if (before.invariantFingerprint !== after.invariantFingerprint) {
      throw new Error("Migration changed canonical or reflective-insight invariant state.");
    }
    const report = {
      mode: "apply",
      schema,
      planId: plan.planId,
      planChecksum: plan.planChecksum,
      migrationName: MIGRATION_NAME,
      migrationChecksum,
      backup,
      appliedAt: new Date().toISOString(),
      before,
      after,
      migrationApplied: true,
      canonicalStateUnchanged: true,
      reflectiveInsightStateUnchanged: true,
      automaticPromotionEnabled: false,
      automaticPruningEnabled: false,
      canonicalWritePerformed: false,
      rawContentIncluded: false,
    };
    await writePrivateJson(output, report);
    console.log(JSON.stringify({ mode, schema, outputPath: output, migrationApplied: true, canonicalWritePerformed: false }));
  }
} finally {
  await pool.end();
}
