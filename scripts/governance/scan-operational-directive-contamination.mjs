import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import { isOneShotOperationalDirective } from "../../dist/index.js";

const home = process.env.HOME || homedir();
const configPath = resolve(
  process.env.DLMF_GOVERNANCE_PILOT_CONFIG
    || `${home}/.config/dlmf/production-pilot.env`,
);
const config = existsSync(configPath) ? await readSimpleEnvFile(configPath) : {};
const databaseUrl = firstText(
  process.env.DLMF_GOVERNANCE_DATABASE_URL,
  process.env.DLMF_PILOT_DATABASE_URL,
  config.DLMF_PILOT_DATABASE_URL,
);
if (databaseUrl === undefined) {
  throw new Error("DLMF governance scan PostgreSQL is not configured");
}
const schema = process.env.DLMF_GOVERNANCE_SCHEMA
  || "dlmf_pilot_hermes_adapter_direct1000_shadow_v3";
if (!/^dlmf_pilot_[a-z0-9_]+$/.test(schema)) {
  throw new Error("DLMF_GOVERNANCE_SCHEMA must be an isolated dlmf_pilot_* schema");
}
const outputPath = resolve(
  process.env.DLMF_GOVERNANCE_REPORT
    || `${home}/.local/state/dlmf/memory-governance/operational-directive-remediation-direct3700.json`,
);

const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: 1,
});

try {
  const rows = (await pool.query(`
    SELECT h.memory_id,
           h.current_revision,
           h.memory_class,
           h.memory_kind,
           h.memory_type,
           h.semantic_key,
           r.canonical_text,
           r.speaker_provenance,
           r.commit_seq,
           r.committed_at,
           r.source_experience_refs,
           r.provenance
      FROM memory_heads h
      JOIN memory_revisions r
        ON r.memory_id = h.memory_id
       AND r.revision = h.current_revision
     WHERE h.status = 'active'
     ORDER BY r.commit_seq, h.memory_id
  `)).rows;

  const matches = rows.filter((row) =>
    isOneShotOperationalDirective(String(row.canonical_text)),
  );
  const report = {
    contract: "dlmf/operational-directive-remediation-candidates/v1",
    generatedAt: new Date().toISOString(),
    mode: "dry_run",
    schema,
    rule: {
      semanticPolicyVersion: "dlmf-semantic-v7",
      ruleId: "operational_directive_ephemeral",
      proposedAction: "owner_review_then_governed_tombstone",
      hardDelete: false,
    },
    activeHeadsScanned: rows.length,
    candidateCount: matches.length,
    candidates: matches.map((row) => ({
      memoryId: row.memory_id,
      revision: Number(row.current_revision),
      commitSeq: Number(row.commit_seq),
      memoryClass: row.memory_class,
      memoryKind: row.memory_kind,
      memoryType: row.memory_type,
      semanticKey: row.semantic_key,
      speakerProvenance: row.speaker_provenance,
      committedAt: new Date(row.committed_at).toISOString(),
      canonicalText: row.canonical_text,
      sourceExperienceRefs: row.source_experience_refs,
      provenance: row.provenance,
      proposedDisposition: "governed_tombstone_after_owner_review",
      reasonCode: "operational_directive_ephemeral",
    })),
  };

  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  console.log(JSON.stringify({
    mode: report.mode,
    semanticPolicyVersion: report.rule.semanticPolicyVersion,
    activeHeadsScanned: report.activeHeadsScanned,
    candidateCount: report.candidateCount,
    candidateMemoryIds: report.candidates.map((candidate) => candidate.memoryId),
    report: outputPath,
    actionApplied: false,
  }, null, 2));
} finally {
  await pool.end();
}

async function readSimpleEnvFile(path) {
  const parsed = {};
  for (const rawLine of (await readFile(path, "utf8")).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && value[0] === value[value.length - 1]
      && (value[0] === '"' || value[0] === "'")
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
