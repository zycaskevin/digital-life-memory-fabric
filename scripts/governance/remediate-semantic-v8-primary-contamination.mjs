import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  CanonicalMemoryAuthority,
  DeterministicHindsightPlaneResolver,
  MemoryCandidateService,
  PostgresCanonicalMemoryStore,
} from "../../dist/index.js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const home = process.env.HOME || homedir();
const repoRoot = resolve(dirname(dirname(dirname(import.meta.filename))));
const schema = process.env.DLMF_GOVERNANCE_SCHEMA || "dlmf_dl_nancy_v1";
if (schema !== "dlmf_dl_nancy_v1") throw new Error("semantic-v8 primary remediation is primary-scope only");
const scope = {
  tenantId: "tenant-arthur",
  lifeDid: "did:arthurverse:nancy",
  memoryNamespace: "life",
};
const expected = [
  {
    memoryId: "mem_082fcc563a4440c98117c0e2e08e4fea",
    revision: 1,
    semanticKey: "preference:user:notifications",
    textSha256: "74be8a02565c9c5e5507e15eb23c782ed72a1f09bad224275755a5294d680a30",
    reason: "semantic-v8:operational-smoke-task-not-durable-notification-preference",
  },
  {
    memoryId: "mem_62ffc9d54d30478fb6c3b74e1eae3473",
    revision: 2,
    semanticKey: "preference:user:interaction_language:traditional_chinese",
    textSha256: "01ea544ab99ce252fdc856703c66e42c3b2c48f34f5b546bc37bee83befe6351",
    reason: "semantic-v8:mixed-language-preference-and-one-shot-review-task",
  },
];
const configPath = resolve(process.env.DLMF_GOVERNANCE_PILOT_CONFIG || join(home, ".config", "dlmf", "production-pilot.env"));
const config = existsSync(configPath) ? await readSimpleEnvFile(configPath) : {};
const databaseUrl = firstText(process.env.DLMF_GOVERNANCE_DATABASE_URL, process.env.DLMF_PILOT_DATABASE_URL, config.DLMF_PILOT_DATABASE_URL);
if (!databaseUrl) throw new Error("DLMF governance PostgreSQL is not configured");
const hindsightBaseUrl = process.env.DLMF_GOVERNANCE_HINDSIGHT_URL || "http://127.0.0.1:18888";
const bankPrefix = process.env.DLMF_GOVERNANCE_HINDSIGHT_BANK_PREFIX || "dlmf-dl-nancy-life-v1";
const reportPath = resolve(process.env.DLMF_GOVERNANCE_REMEDIATION_REPORT || join(
  home, ".local", "share", "digital-life", "nancy-resident", "memory-runtime",
  "activation-evidence", "semantic-v8-closure-20260928",
  apply ? "primary-contamination-remediation-apply.json" : "primary-contamination-remediation-dry-run.json",
));

const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2, connectionTimeoutMillis: 5_000 });
const store = new PostgresCanonicalMemoryStore(pool);
try {
  const targets = [];
  for (const item of expected) {
    const head = await store.getHead(item.memoryId);
    if (!head) throw new Error(`missing governed target ${item.memoryId}`);
    const revision = await store.getRevision(head.memoryId, head.currentRevision);
    if (!revision) throw new Error(`missing governed revision ${item.memoryId}`);
    const digest = createHash("sha256").update(revision.canonicalContent.text, "utf8").digest("hex");
    if (head.scope.tenantId !== scope.tenantId || head.scope.lifeDid !== scope.lifeDid || head.scope.memoryNamespace !== scope.memoryNamespace) {
      throw new Error(`scope mismatch for ${item.memoryId}`);
    }
    if (head.semanticKey !== item.semanticKey || digest !== item.textSha256) {
      throw new Error(`governed target drifted: ${item.memoryId}`);
    }
    if (head.status === "active" && head.currentRevision !== item.revision) {
      throw new Error(`active governed target revision drifted: ${item.memoryId}`);
    }
    if (!["active", "tombstoned"].includes(head.status)) throw new Error(`unsupported target status ${head.status}`);
    targets.push({ item, head, revision });
  }

  const before = await canonicalCounts(pool);
  const expectedNewRevisions = targets.filter(({ head }) => head.status === "active").length;
  const report = {
    contract: "dlmf/semantic-v8-primary-contamination-remediation/v1",
    mode: apply ? "apply" : "dry_run",
    schema,
    scope,
    semanticPolicyVersion: "dlmf-semantic-v8",
    hardDelete: false,
    targets: targets.map(({ item, head }) => ({
      memoryId: head.memoryId,
      currentRevision: head.currentRevision,
      status: head.status,
      semanticKey: head.semanticKey,
      reason: item.reason,
    })),
    before,
    mutations: [],
    projectionBank: null,
    projectionDeletedDocuments: [],
    after: null,
  };

  if (apply) {
    const candidates = new MemoryCandidateService(store);
    const authority = new CanonicalMemoryAuthority(store);
    for (const { item } of targets) {
      let head = await store.getHead(item.memoryId);
      if (!head) throw new Error(`missing target at apply ${item.memoryId}`);
      if (head.status === "active") {
        const revision = await store.getRevision(head.memoryId, head.currentRevision);
        if (!revision) throw new Error(`missing target revision at apply ${item.memoryId}`);
        const candidate = await candidates.ingest({
          scope: head.scope,
          origin: { lifeDid: head.scope.lifeDid, agentId: "dlmf-semantic-v8-governance" },
          candidateType: "governance_tombstone",
          sourceType: "dlmf_semantic_v8_governance",
          sourceId: `semantic-v8-primary-contamination:${head.memoryId}:r${head.currentRevision}`,
          memoryClass: head.memoryClass,
          memoryKind: head.memoryKind,
          memoryType: head.memoryType,
          speakerProvenance: revision.speakerProvenance,
          semanticKey: head.semanticKey,
          proposedContent: revision.canonicalContent,
          evidenceRefs: [
            ...revision.evidenceRefs,
            { sourceType: "semantic_review_governance", sourceRef: item.reason },
          ],
          epistemicStatus: revision.epistemicStatus,
          producer: { kind: "system", id: "dlmf-semantic-v8-governance" },
          sourceExperienceRefs: revision.sourceExperienceRefs,
          proposedOperation: "tombstone",
          baseMemoryId: head.memoryId,
          baseRevision: head.currentRevision,
          ...(revision.observedAt === undefined ? {} : { observedAt: revision.observedAt }),
        });
        const committed = await authority.commit({
          candidateId: candidate.candidateId,
          idempotencyKey: `dlmf-semantic-v8:tombstone:${head.memoryId}:r${head.currentRevision}`,
        });
        report.mutations.push({
          memoryId: head.memoryId,
          fromRevision: head.currentRevision,
          toRevision: committed.revision.revision,
          status: committed.head.status,
          candidateId: candidate.candidateId,
        });
      } else {
        report.mutations.push({
          memoryId: head.memoryId,
          fromRevision: head.currentRevision,
          toRevision: head.currentRevision,
          status: "already_tombstoned",
        });
      }
    }

    const HindsightClient = await loadHindsightClientConstructor();
    const hindsight = new HindsightClient({ baseUrl: hindsightBaseUrl, userAgent: "dlmf-semantic-v8-governance/0.1.1" });
    const health = await fetch(`${hindsightBaseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) throw new Error(`Hindsight health HTTP ${health.status}`);
    const resolver = new DeterministicHindsightPlaneResolver(bankPrefix);
    const bank = resolver.projectionBankId(scope);
    report.projectionBank = bank;
    for (const item of expected) {
      const head = await store.getHead(item.memoryId);
      if (!head || head.status !== "tombstoned") throw new Error(`tombstone verification failed ${item.memoryId}`);
      for (let revision = 1; revision <= head.currentRevision; revision += 1) {
        const documentId = `dlmf-canonical:${head.memoryId}:r${revision}`;
        const listed = await hindsight.listMemories(bank, { limit: 10, offset: 0, documentId });
        const units = Number(listed.total || 0);
        if (units > 0) await hindsight.deleteDocument(bank, documentId);
        report.projectionDeletedDocuments.push({ memoryId: head.memoryId, documentId, unitsBefore: units });
      }
    }
    report.after = await canonicalCounts(pool);
    if (
      report.after.heads !== before.heads ||
      report.after.revisions !== before.revisions + expectedNewRevisions
    ) {
      throw new Error("semantic-v8 remediation changed unexpected canonical row counts");
    }
    for (const item of expected) {
      const head = await store.getHead(item.memoryId);
      if (head?.status !== "tombstoned") throw new Error(`target remained active: ${item.memoryId}`);
    }
  }

  await writePrivateJson(reportPath, report);
  console.log(JSON.stringify({
    contract: report.contract,
    mode: report.mode,
    targets: report.targets.map(({ memoryId, currentRevision, status, reason }) => ({ memoryId, currentRevision, status, reason })),
    mutations: report.mutations,
    hardDelete: false,
    report: reportPath,
  }, null, 2));
} finally {
  await pool.end();
}

async function canonicalCounts(pool) {
  const row = (await pool.query(`SELECT
    (SELECT count(*)::int FROM memory_heads) heads,
    (SELECT count(*)::int FROM memory_revisions) revisions,
    (SELECT count(*)::int FROM memory_candidates) candidates,
    (SELECT count(*)::int FROM memory_changes) changes`)).rows[0];
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}
async function loadHindsightClientConstructor() {
  const candidate = process.env.DLMF_GOVERNANCE_HINDSIGHT_CLIENT_MODULE || join(repoRoot, "..", "OmniHarness", "node_modules", "@vectorize-io", "hindsight-client", "dist", "index.mjs");
  if (!existsSync(candidate)) throw new Error("Hindsight client module not found");
  const module = await import(pathToFileURL(candidate).href);
  if (typeof module.HindsightClient !== "function") throw new Error("HindsightClient export missing");
  return module.HindsightClient;
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
