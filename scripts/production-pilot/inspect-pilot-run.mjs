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

function sanitizeMessage(message) {
  let text = String(message ?? "");
  text = text.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, "$1<redacted>@");
  text = text.replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1<redacted>@");
  text = text.replace(/(api[_-]?key|token|password|authorization)(["'=:\s]+)[^\s,;}\"]+/gi, "$1$2<redacted>");
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

function classifyProviderError(message) {
  const text = String(message ?? "").toLowerCase();
  if (text.includes("query too long") && text.includes("maximum of 500")) {
    return "HINDSIGHT_RECALL_QUERY_LIMIT";
  }
  if (text.includes("authentication failed") || text.includes("invalid api key")) {
    return "HINDSIGHT_AUTH_INVALID";
  }
  if (
    text.includes("context length") ||
    text.includes("context window") ||
    text.includes("too many tokens") ||
    text.includes("maximum context")
  ) {
    return "HINDSIGHT_CONTEXT_LIMIT";
  }
  if (text.includes("request entity too large") || text.includes("payload too large") || text.includes("413")) {
    return "HINDSIGHT_PAYLOAD_TOO_LARGE";
  }
  if (text.includes("timed out") || text.includes("timeout")) return "HINDSIGHT_PROVIDER_TIMEOUT";
  if (text.includes("batch api is enabled") && text.includes("async=false")) {
    return "HINDSIGHT_REQUIRES_ASYNC_RETAIN";
  }
  if (text.includes("tool-calling model") || text.includes("no usable tool call")) {
    return "HINDSIGHT_REFLECT_TOOL_CALL_UNSUPPORTED";
  }
  return "UNCLASSIFIED_PROVIDER_FAILURE";
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
    const receiptColumns = new Set(
      (await pool.query(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema=$1 AND table_name='memory_distillation_receipts'
      `, [schema])).rows.map((row) => row.column_name),
    );
    const md010 = receiptColumns.has("provider_unit_count");
    const receipts = await pool.query(
      md010
        ? `SELECT source_id, status, canonicalization_outcome,
                  provider_unit_count,
                  curation_decision_count,
                  curation_outcomes,
                  curation_coverage_complete,
                  admission_complete,
                  cardinality(candidate_ids) AS candidate_count,
                  cardinality(canonical_memory_ids) AS canonical_count,
                  prune_eligible, retention_state, attempts, errors, warnings,
                  jsonb_array_length(errors) AS error_count,
                  jsonb_array_length(warnings) AS warning_count
             FROM memory_distillation_receipts
            WHERE memory_namespace='pilot.memory-distillation.v0.1.1'
            ORDER BY created_at, source_id`
        : `SELECT source_id, status, canonicalization_outcome,
                  cardinality(candidate_ids) AS provider_unit_count,
                  NULL::integer AS curation_decision_count,
                  NULL::jsonb AS curation_outcomes,
                  NULL::boolean AS curation_coverage_complete,
                  NULL::boolean AS admission_complete,
                  cardinality(candidate_ids) AS candidate_count,
                  cardinality(canonical_memory_ids) AS canonical_count,
                  prune_eligible, retention_state, attempts, errors, warnings,
                  jsonb_array_length(errors) AS error_count,
                  jsonb_array_length(warnings) AS warning_count
             FROM memory_distillation_receipts
            WHERE memory_namespace='pilot.memory-distillation.v0.1.1'
            ORDER BY created_at, source_id`,
    );
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
       WHERE candidate_type='derived_insight_candidate' AND status='PENDING'
    `);
    const curationTotals = md010
      ? await pool.query(`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE outcome='supporting_evidence_only')::int AS supporting_evidence_only,
                 count(*) FILTER (WHERE outcome='rejected')::int AS rejected,
                 count(*) FILTER (WHERE outcome='pending_review')::int AS pending_review,
                 count(*) FILTER (WHERE outcome='canonical_candidate')::int AS canonical_candidate
            FROM memory_curation_records
        `)
      : { rows: [{ total: 0, supporting_evidence_only: 0, rejected: 0, pending_review: 0, canonical_candidate: 0 }] };

    console.log(`PILOT_RUN=${runId}`);
    console.log(`SCHEMA=${schema}`);
    console.log(`MD010_ADMISSION_SCHEMA=${md010 ? "yes" : "legacy"}`);
    for (const row of receipts.rows) {
      const pendingReview = row.curation_outcomes?.pending_review ?? "legacy";
      console.log(
        `source=${row.source_id} status=${row.status}/${row.canonicalization_outcome} providerUnits=${row.provider_unit_count} curatedCandidates=${row.candidate_count} canonical=${row.canonical_count} pendingReview=${pendingReview} admissionComplete=${row.admission_complete ?? "legacy"} curationCoverage=${row.curation_coverage_complete ?? "legacy"} pruneEligible=${row.prune_eligible} retention=${row.retention_state} errors=${row.error_count} warnings=${row.warning_count} attempts=${row.attempts}`,
      );
      for (const error of row.errors ?? []) {
        console.log(
          `  stage=${error.stage ?? "unknown"} code=${error.code ?? "unknown"} class=${classifyProviderError(error.message)}`,
        );
        console.log(`  message=${sanitizeMessage(error.message)}`);
      }
    }
    const t = totals.rows[0] ?? {};
    const c = curationTotals.rows[0] ?? {};
    const providerUnits = receipts.rows.reduce(
      (sum, row) => sum + Number(row.provider_unit_count ?? 0),
      0,
    );
    console.log(
      `TOTALS receipts=${t.receipts ?? 0} providerUnits=${providerUnits} curatedCandidates=${t.candidates ?? 0} canonical=${t.heads ?? 0} revisions=${t.revisions ?? 0} changes=${t.changes ?? 0} reflective_pending=${pendingReflective.rows[0]?.count ?? 0}`,
    );
    if (md010) {
      console.log(
        `CURATION total=${c.total ?? 0} supportingEvidenceOnly=${c.supporting_evidence_only ?? 0} rejected=${c.rejected ?? 0} pendingReview=${c.pending_review ?? 0} canonicalCandidate=${c.canonical_candidate ?? 0}`,
      );
    }
    console.log("AUTO_HERMES_PRUNE=FROZEN");
    console.log("HERMES_PRUNE_EXECUTED=false");
    console.log("PILOT_RUN_INSPECT=PASS");
  }
} finally {
  await pool.end().catch(() => undefined);
}
