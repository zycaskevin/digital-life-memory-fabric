import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Pool } from "pg";
import {
  PostgresMemoryCurationRecordStore,
  PostgresSemanticReviewStore,
  SemanticReviewQueueService,
} from "../../dist/index.js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const home = process.env.HOME || homedir();
const evidenceRoot = resolve(
  process.env.DLMF_SEMANTIC_V8_EVIDENCE_ROOT ||
  join(home, ".local", "share", "digital-life", "nancy-resident", "memory-runtime",
    "activation-evidence", "semantic-v8-closure-20260928"),
);
const reevaluationPath = resolve(
  process.env.DLMF_SEMANTIC_V8_REEVALUATION ||
  join(evidenceRoot, "review-reeval-v8-r3.json"),
);
if (!existsSync(reevaluationPath)) throw new Error("semantic-v8 reevaluation report is missing");
const reevaluationBytes = await readFile(reevaluationPath);
const reevaluation = JSON.parse(reevaluationBytes.toString("utf8"));
if (reevaluation.policyVersion !== "dlmf-semantic-v8" || !Array.isArray(reevaluation.cases)) {
  throw new Error("semantic-v8 reevaluation report contract mismatch");
}
const reevaluationSha256 = createHash("sha256").update(reevaluationBytes).digest("hex");
const closureReceiptId = `semv8reeval_${reevaluationSha256.slice(0, 24)}`;
const reportPath = resolve(
  process.env.DLMF_SEMANTIC_V8_CLOSURE_REPORT ||
  join(evidenceRoot, apply ? "semantic-review-closure-apply.json" : "semantic-review-closure-dry-run.json"),
);
const configPath = resolve(
  process.env.DLMF_GOVERNANCE_PILOT_CONFIG ||
  join(home, ".config", "dlmf", "production-pilot.env"),
);
const config = existsSync(configPath) ? await readSimpleEnvFile(configPath) : {};
const databaseUrl = firstText(
  process.env.DLMF_GOVERNANCE_DATABASE_URL,
  process.env.DLMF_PILOT_DATABASE_URL,
  config.DLMF_PILOT_DATABASE_URL,
);
if (!databaseUrl) throw new Error("DLMF governance PostgreSQL is not configured");

const scopes = {
  dlmf_dl_nancy_v1: {
    tenantId: "tenant-arthur",
    lifeDid: "did:arthurverse:nancy",
    memoryNamespace: "life",
  },
  dlmf_pilot_hermes_adapter_direct1000_shadow_v3: {
    tenantId: "arthurverse-hermes-migration-pilot",
    lifeDid: "did:arthurverse:nancy",
    memoryNamespace: "pilot.hermes-historical-migration.direct1000-v1",
  },
};
const governedPrimaryTargets = new Set([
  "mem_082fcc563a4440c98117c0e2e08e4fea",
  "mem_62ffc9d54d30478fb6c3b74e1eae3473",
]);
const pools = new Map();
const plans = [];
const canonicalBefore = {};
try {
  for (const [schema, scope] of Object.entries(scopes)) {
    const pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    pools.set(schema, pool);
    canonicalBefore[schema] = await canonicalCounts(pool);
    const reviewStore = new PostgresSemanticReviewStore(pool);
    const curationStore = new PostgresMemoryCurationRecordStore(pool);

    for (const reevaluated of reevaluation.cases.filter((item) => item.schema === schema)) {
      const reviewCase = await reviewStore.get(scope, reevaluated.caseId);
      if (!reviewCase) throw new Error(`review case missing: ${reevaluated.caseId}`);
      if (
        reviewCase.curationRecordId !== reevaluated.curationRecordId ||
        reviewCase.receiptId !== reevaluated.receiptId ||
        reviewCase.semanticKey !== reevaluated.oldSemanticKey ||
        reviewCase.semanticRelation !== reevaluated.oldRelation
      ) {
        throw new Error(`review case drifted: ${reevaluated.caseId}`);
      }
      const record = (await curationStore.listByReceipt(reviewCase.receiptId))
        .find((item) => item.recordId === reviewCase.curationRecordId);
      if (!record) throw new Error(`curation record missing: ${reviewCase.curationRecordId}`);

      const policyChanged =
        reevaluated.newSemanticKey !== reevaluated.oldSemanticKey ||
        reevaluated.newMemoryType !== reviewCase.memoryType ||
        ["equivalent", "existing_subsumes_candidate", "candidate_subsumes_existing"]
          .includes(reevaluated.successorRelation);
      const governedPrimary =
        schema === "dlmf_dl_nancy_v1" &&
        governedPrimaryTargets.has(reevaluated.targetMemoryId);
      let disposition;
      if (policyChanged || governedPrimary) {
        disposition = "policy_superseded";
      } else if (
        schema === "dlmf_pilot_hermes_adapter_direct1000_shadow_v3" &&
        reevaluated.oldSemanticKey === "preference:user:notifications" &&
        reevaluated.newSemanticKey === reevaluated.oldSemanticKey &&
        reevaluated.newMemoryType === reviewCase.memoryType &&
        reevaluated.successorRelation === "unrelated"
      ) {
        disposition = "confirmed_unrelated";
      } else {
        throw new Error(
          `unclassified semantic-v8 review case ${reviewCase.caseId}: ` +
          `${reevaluated.oldSemanticKey}/${reevaluated.successorRelation}`,
        );
      }

      const expectedVersion = reviewCase.version;
      const idempotencyKey =
        `semantic-v8-closure:${reviewCase.caseId}:v${expectedVersion}:${disposition}`;
      const evidenceIds = [
        `curation:${reviewCase.curationRecordId}`,
        `policy:${reviewCase.semanticPolicyVersion}->dlmf-semantic-v8`,
        `receipt:${closureReceiptId}`,
        `reevaluation:sha256:${reevaluationSha256}`,
        "owner_instruction:2026-09-28:continue_to_completion",
        ...(governedPrimary
          ? [`governance:semantic-v8-primary-tombstone:${reevaluated.targetMemoryId}`]
          : []),
      ];
      const reasonCodes = disposition === "policy_superseded"
        ? [
            "review:policy_superseded_by_dlmf_semantic_v8",
            `review:successor_relation:${reevaluated.successorRelation}`,
          ]
        : [
            "review:dlmf_semantic_v8_confirmed_unrelated",
            "review:owner_delegated_closure",
          ];
      plans.push({
        schema,
        scope,
        reviewCase,
        record,
        reevaluated,
        disposition,
        expectedVersion,
        idempotencyKey,
        evidenceIds,
        reasonCodes,
      });
    }
  }

  const counts = plans.reduce((out, plan) => {
    out[plan.disposition] = (out[plan.disposition] ?? 0) + 1;
    return out;
  }, {});
  if (plans.length !== 108 || counts.policy_superseded !== 86 || counts.confirmed_unrelated !== 22) {
    throw new Error(
      `semantic-v8 closure plan mismatch total=${plans.length} counts=${JSON.stringify(counts)}`,
    );
  }
  for (const plan of plans) {
    if (!["pending", "resolved"].includes(plan.reviewCase.status)) {
      throw new Error(`semantic review case is not closable: ${plan.reviewCase.caseId}`);
    }
    if (
      plan.reviewCase.status === "resolved" &&
      plan.reviewCase.latestDecision?.disposition !== plan.disposition
    ) {
      throw new Error(`resolved review disposition mismatch: ${plan.reviewCase.caseId}`);
    }
  }

  const report = {
    contract: "dlmf/semantic-v8-review-closure/v1",
    mode: apply ? "apply" : "dry_run",
    semanticPolicyVersion: "dlmf-semantic-v8",
    reevaluationSha256: `sha256:${reevaluationSha256}`,
    closureReceiptId,
    expectedCases: 108,
    dispositionCounts: counts,
    hardDelete: false,
    canonicalBefore,
    decisions: plans.map((plan) => ({
      schema: plan.schema,
      caseId: plan.reviewCase.caseId,
      curationRecordId: plan.reviewCase.curationRecordId,
      sourceReceiptId: plan.reviewCase.receiptId,
      expectedVersion: plan.expectedVersion,
      disposition: plan.disposition,
      oldSemanticKey: plan.reevaluated.oldSemanticKey,
      newSemanticKey: plan.reevaluated.newSemanticKey,
      newMemoryType: plan.reevaluated.newMemoryType,
      successorRelation: plan.reevaluated.successorRelation,
      targetMemoryId: plan.reevaluated.targetMemoryId,
      statusBefore: plan.reviewCase.status,
    })),
    applied: [],
    canonicalAfter: null,
    openAfter: null,
  };

  if (apply) {
    for (const plan of plans) {
      const pool = pools.get(plan.schema);
      const curationStore = new PostgresMemoryCurationRecordStore(pool);
      const reviewStore = new PostgresSemanticReviewStore(pool);
      const queue = new SemanticReviewQueueService(curationStore, reviewStore);
      let current = await reviewStore.get(plan.scope, plan.reviewCase.caseId);
      if (!current) throw new Error(`review case disappeared: ${plan.reviewCase.caseId}`);
      if (current.status === "resolved") {
        if (current.latestDecision?.disposition !== plan.disposition) {
          throw new Error(`resolved review drifted: ${plan.reviewCase.caseId}`);
        }
        report.applied.push({
          schema: plan.schema,
          caseId: current.caseId,
          status: "already_resolved",
          disposition: current.latestDecision.disposition,
          version: current.version,
        });
        continue;
      }
      current = await queue.resolve({
        caseId: current.caseId,
        scope: current.scope,
        expectedVersion: current.version,
        idempotencyKey: plan.idempotencyKey,
        disposition: plan.disposition,
        reviewer: {
          lifeDid: current.scope.lifeDid,
          agentId: "dlmf-semantic-v8-review-operator",
        },
        evidenceIds: plan.evidenceIds,
        reasonCodes: plan.reasonCodes,
      });
      report.applied.push({
        schema: plan.schema,
        caseId: current.caseId,
        status: current.status,
        disposition: current.latestDecision?.disposition,
        version: current.version,
      });
    }

    report.canonicalAfter = {};
    report.openAfter = {};
    for (const [schema, scope] of Object.entries(scopes)) {
      const pool = pools.get(schema);
      report.canonicalAfter[schema] = await canonicalCounts(pool);
      if (JSON.stringify(report.canonicalAfter[schema]) !== JSON.stringify(canonicalBefore[schema])) {
        throw new Error(`semantic review closure crossed canonical boundary in ${schema}`);
      }
      const reviewStore = new PostgresSemanticReviewStore(pool);
      const open = await reviewStore.list(scope, { status: "pending", limit: 1000 });
      const deferred = await reviewStore.list(scope, { status: "deferred", limit: 1000 });
      report.openAfter[schema] = { pending: open.length, deferred: deferred.length };
      if (open.length !== 0 || deferred.length !== 0) {
        throw new Error(`semantic review closure incomplete in ${schema}`);
      }
    }
  }

  await writePrivateJson(reportPath, report);
  console.log(JSON.stringify({
    contract: report.contract,
    mode: report.mode,
    closureReceiptId,
    expectedCases: report.expectedCases,
    dispositionCounts: report.dispositionCounts,
    appliedCount: report.applied.length,
    openAfter: report.openAfter,
    canonicalUnchanged: report.canonicalAfter === null
      ? null
      : Object.keys(scopes).every((schema) =>
          JSON.stringify(report.canonicalAfter[schema]) === JSON.stringify(report.canonicalBefore[schema])),
    hardDelete: false,
    report: reportPath,
  }, null, 2));
} finally {
  for (const pool of pools.values()) await pool.end();
}

async function canonicalCounts(pool) {
  const row = (await pool.query(`SELECT
    (SELECT count(*)::int FROM memory_heads) heads,
    (SELECT count(*)::int FROM memory_revisions) revisions,
    (SELECT count(*)::int FROM memory_candidates) candidates,
    (SELECT count(*)::int FROM memory_changes) changes`)).rows[0];
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}
async function writePrivateJson(target, value) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
}
async function readSimpleEnvFile(target) {
  const parsed = {};
  for (const raw of (await readFile(target, "utf8")).split(/\r?\n/u)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7);
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) value = value.slice(1, -1);
    parsed[key] = value;
  }
  return parsed;
}
function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}
