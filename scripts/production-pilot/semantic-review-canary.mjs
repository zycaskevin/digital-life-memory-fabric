import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Pool } from "pg";
import {
  PostgresMemoryCurationRecordStore,
  PostgresSemanticReviewStore,
  SemanticCanaryGate,
  SemanticReviewQueueService,
} from "../../dist/index.js";

const argv = process.argv.slice(2);
const runId = argv.find((arg) => /^pilot_\d{14}$/.test(arg));
const decisionFlag = argv.indexOf("--apply-decisions");
const decisionPath = decisionFlag < 0 ? undefined : argv[decisionFlag + 1];
if (runId === undefined || (decisionFlag >= 0 && decisionPath === undefined)) {
  console.error(
    "Usage: node semantic-review-canary.mjs pilot_YYYYMMDDhhmmss [--apply-decisions /private/decisions.json]",
  );
  process.exit(2);
}

const home = process.env.HOME || homedir();
const envFile = resolve(
  process.env.DLMF_PILOT_ENV_FILE || join(home, ".config", "dlmf", "production-pilot.env"),
);
const reportRoot = resolve(
  process.env.DLMF_PILOT_REPORT_ROOT ||
    join(home, ".local", "state", "dlmf", "production-pilot"),
);
const schema = process.env.DLMF_PILOT_SCHEMA ||
  `dlmf_pilot_v011_${runId.slice("pilot_".length).toLowerCase()}`;
if (!/^dlmf_pilot_[a-z0-9_]+$/.test(schema)) {
  throw new Error(`DLMF_PILOT_SCHEMA must be an isolated dlmf_pilot_* schema: ${schema}`);
}
const reportPath = resolve(
  process.env.DLMF_PILOT_SEMANTIC_REVIEW_REPORT ||
    join(reportRoot, `${runId}-semantic-review.json`),
);

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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Semantic review decision manifest must be an object.");
  }
  if (value.runId !== runId || value.schema !== schema) {
    throw new Error("Semantic review decision manifest runId/schema mismatch.");
  }
  if (
    !value.reviewer || typeof value.reviewer !== "object" ||
    !nonEmptyString(value.reviewer.lifeDid) || !nonEmptyString(value.reviewer.agentId)
  ) {
    throw new Error("Semantic review decision manifest requires an explicit reviewer.");
  }
  if (!Array.isArray(value.decisions) || value.decisions.length === 0) {
    throw new Error("Semantic review decision manifest requires at least one decision.");
  }
  const caseIds = new Set();
  for (const [index, decision] of value.decisions.entries()) {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      throw new Error(`Decision ${index} must be an object.`);
    }
    if (
      !nonEmptyString(decision.caseId) || !Number.isInteger(decision.expectedVersion) ||
      decision.expectedVersion < 1 || !nonEmptyString(decision.idempotencyKey) ||
      !nonEmptyString(decision.disposition) || !Array.isArray(decision.evidenceIds) ||
      decision.evidenceIds.length === 0 || !Array.isArray(decision.reasonCodes) ||
      decision.reasonCodes.length === 0
    ) {
      throw new Error(`Decision ${index} is incomplete.`);
    }
    if (caseIds.has(decision.caseId)) throw new Error(`Duplicate decision case ${decision.caseId}.`);
    caseIds.add(decision.caseId);
  }
  return value;
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function canonicalCounts(pool) {
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM memory_candidates) AS candidates,
      (SELECT count(*)::int FROM memory_heads) AS heads,
      (SELECT count(*)::int FROM memory_revisions) AS revisions,
      (SELECT count(*)::int FROM memory_changes) AS changes
  `);
  return result.rows[0];
}

async function main() {
  const config = parseEnvFile(envFile);
  const databaseUrl = process.env.DLMF_PILOT_DATABASE_URL || config.DLMF_PILOT_DATABASE_URL;
  if (!nonEmptyString(databaseUrl)) throw new Error("DLMF pilot PostgreSQL is not configured.");
  const pool = new Pool({
    connectionString: databaseUrl,
    options: decisionPath === undefined
      ? `-c search_path=${schema} -c default_transaction_read_only=on`
      : `-c search_path=${schema}`,
  });
  try {
    const schemaResult = await pool.query(
      "SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists",
      [schema],
    );
    if (schemaResult.rows[0]?.exists !== true) throw new Error(`Pilot schema ${schema} was not found.`);

    const curationStore = new PostgresMemoryCurationRecordStore(pool);
    const reviewStore = new PostgresSemanticReviewStore(pool);
    const queue = new SemanticReviewQueueService(curationStore, reviewStore);
    const beforeCanonical = await canonicalCounts(pool);
    const receiptsResult = await pool.query(`
      SELECT receipt_id, tenant_id, life_did, memory_namespace,
             provider_unit_count, semantic_policy_version
        FROM memory_distillation_receipts
       ORDER BY receipt_id
    `);
    if (receiptsResult.rows.length === 0) throw new Error("Pilot schema contains no receipts.");

    let appliedDecisions = 0;
    if (decisionPath !== undefined) {
      const manifest = validateManifest(JSON.parse(await readFile(resolve(decisionPath), "utf8")));
      const knownCases = new Map();
      for (const receipt of receiptsResult.rows) {
        for (const reviewCase of await reviewStore.listByReceipt(receipt.receipt_id)) {
          knownCases.set(reviewCase.caseId, reviewCase);
        }
      }
      for (const decision of manifest.decisions) {
        const reviewCase = knownCases.get(decision.caseId);
        if (reviewCase === undefined) throw new Error(`Decision case ${decision.caseId} was not found.`);
        if (reviewCase.scope.lifeDid !== manifest.reviewer.lifeDid) {
          throw new Error(`Reviewer does not own the life scope for ${decision.caseId}.`);
        }
        await queue.resolve({
          caseId: reviewCase.caseId,
          scope: reviewCase.scope,
          expectedVersion: decision.expectedVersion,
          idempotencyKey: decision.idempotencyKey,
          disposition: decision.disposition,
          reviewer: manifest.reviewer,
          evidenceIds: decision.evidenceIds,
          reasonCodes: decision.reasonCodes,
        });
        appliedDecisions += 1;
      }
    }

    const gate = new SemanticCanaryGate();
    const receiptAssessments = [];
    for (const receipt of receiptsResult.rows) {
      const records = await curationStore.listByReceipt(receipt.receipt_id);
      const cases = await reviewStore.listByReceipt(receipt.receipt_id);
      const assessment = gate.assess({
        receiptId: receipt.receipt_id,
        records,
        reviewCases: cases,
        expectedRecordCount: receipt.provider_unit_count,
        expectedSemanticPolicyVersion: receipt.semantic_policy_version,
      });
      receiptAssessments.push({
        receiptId: receipt.receipt_id,
        scope: {
          tenantId: receipt.tenant_id,
          lifeDid: receipt.life_did,
          memoryNamespace: receipt.memory_namespace,
        },
        cases: cases.map((reviewCase) => ({
          caseId: reviewCase.caseId,
          curationRecordId: reviewCase.curationRecordId,
          trigger: reviewCase.trigger,
          semanticKey: reviewCase.semanticKey,
          memoryType: reviewCase.memoryType,
          semanticRelation: reviewCase.semanticRelation,
          status: reviewCase.status,
          version: reviewCase.version,
          latestDisposition: reviewCase.latestDecision?.disposition,
          canonicalWritePerformed: reviewCase.canonicalWritePerformed,
        })),
        assessment,
      });
    }
    const afterCanonical = await canonicalCounts(pool);
    const canonicalStateUnchanged = JSON.stringify(beforeCanonical) === JSON.stringify(afterCanonical);
    if (!canonicalStateUnchanged) {
      throw new Error("Semantic review workflow changed canonical state.");
    }
    const eligibleForExpandedManualCanary = receiptAssessments.every(
      (entry) => entry.assessment.eligibleForExpandedManualCanary,
    );
    const report = {
      runId,
      schema,
      evaluatedAt: new Date().toISOString(),
      mode: decisionPath === undefined ? "read_only" : "apply_decisions",
      appliedDecisions,
      eligibleForExpandedManualCanary,
      receiptAssessments,
      canonicalStateUnchanged,
      rawContentIncluded: false,
      providerUnitTextIncluded: false,
      automaticPruningEnabled: false,
      automaticPromotionEnabled: false,
      canonicalWritePerformed: false,
    };
    await writePrivateJson(reportPath, report);

    console.log(`PILOT_RUN=${runId}`);
    console.log(`SCHEMA=${schema}`);
    console.log(`MODE=${report.mode}`);
    console.log(`APPLIED_DECISIONS=${appliedDecisions}`);
    console.log(`REVIEW_CASES=${receiptAssessments.reduce((sum, item) => sum + item.cases.length, 0)}`);
    console.log(`CANONICAL_STATE_UNCHANGED=${canonicalStateUnchanged}`);
    console.log("RAW_CONTENT_INCLUDED=false");
    console.log("AUTO_HERMES_PRUNE=FROZEN");
    console.log("AUTOMATIC_INSIGHT_PROMOTION=false");
    console.log(`SEMANTIC_REVIEW_REPORT=${reportPath}`);
    console.log(
      eligibleForExpandedManualCanary
        ? "EXPANDED_MANUAL_CANARY=ELIGIBLE"
        : "EXPANDED_MANUAL_CANARY=BLOCKED",
    );
    if (!eligibleForExpandedManualCanary) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`SEMANTIC_REVIEW_CANARY=FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
