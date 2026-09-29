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
  isOneShotOperationalDirective,
} from "../../dist/index.js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const home = process.env.HOME || homedir();
const repoRoot = resolve(dirname(dirname(dirname(import.meta.filename))));
const configPath = resolve(
  process.env.DLMF_GOVERNANCE_PILOT_CONFIG
    || join(home, ".config", "dlmf", "production-pilot.env"),
);
const config = existsSync(configPath) ? await readSimpleEnvFile(configPath) : {};
const databaseUrl = firstText(
  process.env.DLMF_GOVERNANCE_DATABASE_URL,
  process.env.DLMF_PILOT_DATABASE_URL,
  config.DLMF_PILOT_DATABASE_URL,
);
if (databaseUrl === undefined) throw new Error("DLMF governance PostgreSQL is not configured");

const schema = process.env.DLMF_GOVERNANCE_SCHEMA
  || "dlmf_pilot_hermes_adapter_direct1000_shadow_v3";
if (!/^dlmf_pilot_[a-z0-9_]+$/.test(schema)) {
  throw new Error("DLMF_GOVERNANCE_SCHEMA must be an isolated dlmf_pilot_* schema");
}

const expectedMemoryIds = [
  "mem_aa7dc7d58f4f4e05bed0821e4900b472",
  "mem_cb44e8fcedd8487493180eb3d5185e02",
].sort();

const hindsightBaseUrl = process.env.DLMF_GOVERNANCE_HINDSIGHT_URL || "http://127.0.0.1:18889";
const hindsightBankPrefix =
  process.env.DLMF_GOVERNANCE_HINDSIGHT_BANK_PREFIX || "dlmf-hermes-adapter-direct-phase2-v2";
const reportPath = resolve(
  process.env.DLMF_GOVERNANCE_REMEDIATION_REPORT
    || join(home, ".local", "state", "dlmf", "memory-governance",
      "operational-directive-remediation-apply.json"),
);

const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: 2,
  connectionTimeoutMillis: 5_000,
});
const store = new PostgresCanonicalMemoryStore(pool);

try {
  const activeRows = (await pool.query(`
    SELECT h.memory_id, h.current_revision, h.memory_class, h.memory_kind,
           h.memory_type, h.semantic_key, h.status,
           r.canonical_text, r.speaker_provenance, r.epistemic_status,
           r.source_experience_refs, r.observed_at
      FROM memory_heads h
      JOIN memory_revisions r
        ON r.memory_id=h.memory_id AND r.revision=h.current_revision
     WHERE h.status='active'
     ORDER BY h.memory_id
  `)).rows;
  const activeMatches = activeRows
    .filter((row) => isOneShotOperationalDirective(String(row.canonical_text)))
    .map((row) => String(row.memory_id))
    .sort();
  const unknownMatches = activeMatches.filter((id) => !expectedMemoryIds.includes(id));
  if (unknownMatches.length > 0) {
    throw new Error(`Unexpected operational-directive candidates: ${unknownMatches.join(",")}`);
  }

  const targetRows = (await pool.query(`
    SELECT h.memory_id, h.current_revision, h.memory_class, h.memory_kind,
           h.memory_type, h.semantic_key, h.status,
           r.canonical_text, r.speaker_provenance, r.epistemic_status,
           r.source_experience_refs, r.observed_at,
           h.tenant_id, h.life_did, h.memory_namespace
      FROM memory_heads h
      JOIN memory_revisions r
        ON r.memory_id=h.memory_id AND r.revision=h.current_revision
     WHERE h.memory_id=ANY($1::text[])
     ORDER BY h.memory_id
  `, [expectedMemoryIds])).rows;
  if (targetRows.length !== expectedMemoryIds.length) {
    throw new Error(`Expected ${expectedMemoryIds.length} governed targets; found=${targetRows.length}`);
  }

  const scopes = new Set(targetRows.map((row) =>
    [row.tenant_id, row.life_did, row.memory_namespace].join("\u001f")));
  if (scopes.size !== 1) throw new Error("Governed targets do not share one memory scope");
  const first = targetRows[0];
  const scope = {
    tenantId: String(first.tenant_id),
    lifeDid: String(first.life_did),
    memoryNamespace: String(first.memory_namespace),
  };

  for (const row of targetRows) {
    if (!["active", "tombstoned"].includes(String(row.status))) {
      throw new Error(`Target ${row.memory_id} has unsupported status=${row.status}`);
    }
    if (row.status === "active" && !isOneShotOperationalDirective(String(row.canonical_text))) {
      throw new Error(`Active target ${row.memory_id} no longer matches the bounded lifetime rule`);
    }
  }

  const HindsightClient = await loadHindsightClientConstructor();
  const hindsight = new HindsightClient({
    baseUrl: hindsightBaseUrl,
    userAgent: "dlmf-memory-governance/0.1.1",
  });
  const health = await fetch(`${hindsightBaseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new Error(`Hindsight health HTTP ${health.status}`);
  const resolver = new DeterministicHindsightPlaneResolver(hindsightBankPrefix);
  const projectionBank = resolver.projectionBankId(scope);

  const projectionBefore = [];
  for (const row of targetRows) {
    const docs = [];
    for (let revision = 1; revision <= Number(row.current_revision); revision += 1) {
      const documentId = `dlmf-canonical:${row.memory_id}:r${revision}`;
      const listed = await hindsight.listMemories(projectionBank, {
        limit: 10,
        offset: 0,
        documentId,
      });
      docs.push({ documentId, units: Number(listed.total || 0) });
    }
    projectionBefore.push({ memoryId: row.memory_id, docs });
  }

  const result = {
    contract: "dlmf/operational-directive-remediation/v1",
    mode: apply ? "apply" : "dry_run",
    schema,
    scope,
    rule: "operational_directive_ephemeral",
    expectedTargets: expectedMemoryIds,
    activeMatches,
    unknownMatches,
    projectionBank,
    projectionBefore,
    mutations: [],
    projectionAfter: [],
    hardDelete: false,
  };

  if (apply) {
    const candidates = new MemoryCandidateService(store);
    const authority = new CanonicalMemoryAuthority(store);

    for (const original of targetRows) {
      let head = await store.getHead(original.memory_id);
      if (head === undefined) throw new Error(`Missing target head ${original.memory_id}`);
      if (head.status === "active") {
        const revision = await store.getRevision(head.memoryId, head.currentRevision);
        if (revision === undefined) throw new Error(`Missing revision for ${head.memoryId}`);
        if (!isOneShotOperationalDirective(revision.canonicalContent.text)) {
          throw new Error(`Target ${head.memoryId} changed before apply`);
        }
        const sourceId = `operational-directive-remediation:${head.memoryId}:r${head.currentRevision}`;
        const prior = await pool.query(`
          SELECT candidate_id, status
            FROM memory_candidates
           WHERE source_type='dlmf_memory_governance'
             AND source_id=$1
             AND proposed_operation='tombstone'
             AND base_memory_id=$2
             AND base_revision=$3
           ORDER BY created_at DESC
           LIMIT 1
        `, [sourceId, head.memoryId, head.currentRevision]);
        let candidateId;
        if (prior.rows[0]?.status === "PENDING") {
          candidateId = String(prior.rows[0].candidate_id);
        } else {
          const candidate = await candidates.ingest({
            scope: head.scope,
            origin: { lifeDid: head.scope.lifeDid, agentId: "dlmf-memory-governance" },
            candidateType: "governance_tombstone",
            sourceType: "dlmf_memory_governance",
            sourceId,
            memoryClass: head.memoryClass,
            memoryKind: head.memoryKind,
            memoryType: head.memoryType,
            speakerProvenance: revision.speakerProvenance,
            semanticKey: head.semanticKey,
            proposedContent: revision.canonicalContent,
            evidenceRefs: revision.evidenceRefs,
            epistemicStatus: revision.epistemicStatus,
            producer: { kind: "system", id: "dlmf-memory-governance" },
            sourceExperienceRefs: revision.sourceExperienceRefs,
            proposedOperation: "tombstone",
            baseMemoryId: head.memoryId,
            baseRevision: head.currentRevision,
            observedAt: revision.observedAt,
          });
          candidateId = candidate.candidateId;
        }
        const committed = await authority.commit({
          candidateId,
          idempotencyKey: `dlmf-mem-gov-001:tombstone:${head.memoryId}:r${head.currentRevision}`,
        });
        result.mutations.push({
          memoryId: head.memoryId,
          fromRevision: head.currentRevision,
          toRevision: committed.revision.revision,
          status: committed.head.status,
        });
      } else {
        result.mutations.push({
          memoryId: head.memoryId,
          fromRevision: head.currentRevision,
          toRevision: head.currentRevision,
          status: "already_tombstoned",
        });
      }

      head = await store.getHead(original.memory_id);
      if (head?.status !== "tombstoned") {
        throw new Error(`Tombstone verification failed for ${original.memory_id}`);
      }

      for (let revision = 1; revision <= head.currentRevision; revision += 1) {
        const documentId = `dlmf-canonical:${head.memoryId}:r${revision}`;
        const listed = await hindsight.listMemories(projectionBank, {
          limit: 10,
          offset: 0,
          documentId,
        });
        if (Number(listed.total || 0) > 0) {
          await hindsight.deleteDocument(projectionBank, documentId);
        }
      }

      const afterDocs = [];
      for (let revision = 1; revision <= head.currentRevision; revision += 1) {
        const documentId = `dlmf-canonical:${head.memoryId}:r${revision}`;
        const listed = await hindsight.listMemories(projectionBank, {
          limit: 10,
          offset: 0,
          documentId,
        });
        afterDocs.push({ documentId, units: Number(listed.total || 0) });
      }
      result.projectionAfter.push({ memoryId: head.memoryId, docs: afterDocs });
    }

    const remaining = (await pool.query(`
      SELECT h.memory_id, r.canonical_text
        FROM memory_heads h
        JOIN memory_revisions r
          ON r.memory_id=h.memory_id AND r.revision=h.current_revision
       WHERE h.status='active'
    `)).rows.filter((row) => isOneShotOperationalDirective(String(row.canonical_text)));
    if (remaining.length !== 0) {
      throw new Error(`Operational-directive remediation incomplete; remaining=${remaining.length}`);
    }
  }

  await writePrivateJson(reportPath, result);
  console.log(JSON.stringify({
    contract: result.contract,
    mode: result.mode,
    expectedTargets: result.expectedTargets,
    activeMatches: result.activeMatches,
    unknownMatches: result.unknownMatches,
    projectionUnitsBefore: result.projectionBefore.reduce(
      (sum, item) => sum + item.docs.reduce((inner, doc) => inner + doc.units, 0), 0),
    mutations: result.mutations,
    projectionUnitsAfter: result.projectionAfter.reduce(
      (sum, item) => sum + item.docs.reduce((inner, doc) => inner + doc.units, 0), 0),
    hardDelete: false,
    report: reportPath,
  }, null, 2));
} finally {
  await pool.end();
}

async function loadHindsightClientConstructor() {
  const candidate = process.env.DLMF_GOVERNANCE_HINDSIGHT_CLIENT_MODULE
    || join(repoRoot, "..", "OmniHarness", "node_modules", "@vectorize-io",
      "hindsight-client", "dist", "index.mjs");
  if (!existsSync(candidate)) throw new Error("Hindsight client module not found");
  const module = await import(pathToFileURL(candidate).href);
  if (typeof module.HindsightClient !== "function") throw new Error("HindsightClient export missing");
  return module.HindsightClient;
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readSimpleEnvFile(path) {
  const parsed = {};
  for (const rawLine of (await readFile(path, "utf8")).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}
