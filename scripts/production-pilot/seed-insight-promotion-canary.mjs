import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Pool } from "pg";
import {
  CanonicalMemoryAuthority,
  MemoryCandidateService,
  PostgresCanonicalMemoryStore,
  PostgresReflectiveInsightStore,
  ReflectiveInsightPromotionGate,
} from "../../dist/index.js";

const argv = process.argv.slice(2);
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
function privateOutput(path, root) {
  const resolved = resolve(path);
  const rel = relative(resolve(root), resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Output must stay inside protected report root ${resolve(root)}.`);
  }
  return resolved;
}
async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

const home = process.env.HOME || homedir();
const envFile = resolve(process.env.DLMF_PILOT_ENV_FILE || join(home, ".config", "dlmf", "production-pilot.env"));
const config = parseEnvFile(envFile);
const databaseUrl = process.env.DLMF_PILOT_DATABASE_URL || config.DLMF_PILOT_DATABASE_URL;
if (!databaseUrl) throw new Error("DLMF pilot PostgreSQL is not configured.");
const schema = required("--schema");
if (!/^dlmf_promotion_canary_[0-9]{14}$/.test(schema)) {
  throw new Error("Canary schema must match dlmf_promotion_canary_YYYYMMDDhhmmss.");
}
if (process.env.DLMF_CANARY_APPLY_SCHEMA !== schema) {
  throw new Error("Canary creation is fail-closed unless DLMF_CANARY_APPLY_SCHEMA exactly matches --schema.");
}
const reportRoot = resolve(process.env.DLMF_PILOT_REPORT_ROOT || join(home, ".local", "state", "dlmf", "production-pilot"));
const output = privateOutput(required("--output"), reportRoot);
const admin = new Pool({ connectionString: databaseUrl });
const existing = await admin.query(
  "SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists",
  [schema],
);
if (existing.rows[0]?.exists === true) {
  await admin.end();
  throw new Error(`Canary schema ${schema} already exists; refusing to reuse it.`);
}
await admin.query(`CREATE SCHEMA "${schema}"`);
const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
const canonicalStore = new PostgresCanonicalMemoryStore(pool);
try {
  for (const migration of [
    "0001_canonical_core.sql",
    "0002_central_operations.sql",
    "0003_memory_distillation.sql",
    "0004_canonical_admission.sql",
    "0005_semantic_governance.sql",
    "0006_semantic_review_queue.sql",
    "0007_insight_promotion_governance.sql",
  ]) {
    await pool.query(await readFile(resolve("migrations", migration), "utf8"));
  }
  const scope = {
    tenantId: "tenant_sg010_canary",
    lifeDid: "did:life:nancy",
    memoryNamespace: "governance.promotion-canary",
  };
  const candidate = await new MemoryCandidateService(canonicalStore).ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "sg010-canary-seeder" },
    candidateType: "reviewed_fact_candidate",
    sourceType: "synthetic_canary",
    sourceId: "sg010-support",
    memoryClass: "semantic_assertion",
    memoryKind: "technical_finding",
    memoryType: "technical_fact",
    speakerProvenance: "tool",
    semanticKey: "technical:sg010:reviewed-support",
    proposedContent: { text: "The isolated SG-010 canary has a reviewed canonical support fact." },
    evidenceRefs: [{ sourceType: "synthetic_review", sourceRef: "sg010-support-1" }],
    epistemicStatus: "system_observed",
    producer: { kind: "system", id: "dlmf-sg010-canary" },
    sourceExperienceRefs: [{ sourceType: "synthetic_canary", sourceId: "sg010-support" }],
    proposedOperation: "create",
  });
  const support = await new CanonicalMemoryAuthority(canonicalStore).commit({
    candidateId: candidate.candidateId,
    idempotencyKey: "sg010-seed-support",
  });
  const now = new Date().toISOString();
  const insight = {
    insightId: "insight_sg010_production_canary",
    scope,
    proposition: "Governed Plan, Dry-run, and Apply controls reduce unreviewed promotion risk.",
    epistemicStatus: "synthesized",
    supportingMemoryIds: [support.head.memoryId],
    supportingEvidenceIds: ["synthetic_review:sg010-support-1"],
    contradictingMemoryIds: [],
    confidence: 0.94,
    derivationProvider: "hindsight",
    derivationModel: "synthetic-canary-model",
    derivationRunId: `sg010-production-canary-${schema.slice(-14)}`,
    status: "pending",
    canonicalWritePerformed: false,
    createdAt: now,
    updatedAt: now,
  };
  await new PostgresReflectiveInsightStore(pool).put({
    ...insight,
    promotionEligibility: new ReflectiveInsightPromotionGate().assess(insight),
  });
  const counts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM memory_candidates) AS candidates,
    (SELECT count(*)::int FROM memory_heads) AS heads,
    (SELECT count(*)::int FROM memory_revisions) AS revisions,
    (SELECT count(*)::int FROM memory_changes) AS changes,
    (SELECT count(*)::int FROM reflective_insights) AS insights,
    (SELECT count(*)::int FROM insight_promotion_records) AS promotions,
    (SELECT count(*)::int FROM insight_promotion_events) AS promotion_events`)).rows[0];
  const expected = { candidates: 1, heads: 1, revisions: 1, changes: 1, insights: 1, promotions: 0, promotion_events: 0 };
  if (JSON.stringify(counts) !== JSON.stringify(expected)) {
    throw new Error(`Synthetic canary seed counts are unexpected: ${JSON.stringify(counts)}`);
  }
  const report = {
    mode: "seed",
    schema,
    seededAt: new Date().toISOString(),
    scope,
    supportMemoryId: support.head.memoryId,
    insightId: insight.insightId,
    insightStatus: insight.status,
    insightEvidenceClosure: true,
    insightCanonicalWritePerformed: false,
    counts,
    migrationRange: "0001-0007",
    rawContentIncluded: false,
    automaticPromotionEnabled: false,
    automaticPruningEnabled: false,
  };
  await writePrivateJson(output, report);
  console.log(JSON.stringify({ schema, outputPath: output, insightId: insight.insightId, status: insight.status }));
} finally {
  await canonicalStore.close();
  await admin.end();
}
