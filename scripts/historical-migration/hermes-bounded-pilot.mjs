import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  DeterministicHindsightPlaneResolver,
  HermesHistoricalMigrationEligibilityPolicy,
  HermesSourceAdapter,
  HermesSqliteReader,
  HindsightCanonicalProjectionPort,
  HindsightMemoryAdapter,
  HistoricalExperienceMigrationRunner,
  JsonFileSourceMigrationStateStore,
  createDigitalLifeStackDlmfRuntime,
} from "../../dist/index.js";
import {
  bootstrapDigitalLifeStackSchema,
  inspectDigitalLifeStackSchema,
  validatedDlmfSchema,
} from "../digital-life-stack-schema-lib.mjs";

const args = new Set(process.argv.slice(2));
const preflightOnly = args.has("--preflight");
const apply = args.has("--apply");
if (!preflightOnly && !apply) throw new Error("Use --preflight or --apply explicitly.");
if (preflightOnly && apply) throw new Error("Choose only one mode.");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  throw new Error(`Node >=22 is required for read-only node:sqlite access; current=${process.version}`);
}

const repoRoot = resolve(dirname(dirname(dirname(import.meta.filename))));
const home = process.env.HOME || homedir();
const hermesHome = resolve(process.env.HERMES_HOME || join(home, ".hermes"));
const sourceDb = resolve(
  process.env.DLMF_MIGRATION_HERMES_DB || join(hermesHome, "state.db"),
);
const privatePilotConfig = resolve(
  process.env.DLMF_MIGRATION_PILOT_CONFIG || join(home, ".config", "dlmf", "production-pilot.env"),
);
const persistedPilot = readSimpleEnvFile(privatePilotConfig);
const databaseUrl = firstText(
  process.env.DLMF_MIGRATION_DATABASE_URL,
  process.env.DLMF_PILOT_DATABASE_URL,
  persistedPilot.DLMF_PILOT_DATABASE_URL,
);
if (!databaseUrl) {
  throw new Error(
    "DLMF migration PostgreSQL is not configured; set DLMF_MIGRATION_DATABASE_URL or bootstrap the existing DLMF production-pilot pg0",
  );
}

const schema = validatedDlmfSchema(
  process.env.DLMF_MIGRATION_SCHEMA || "dlmf_pilot_hermes_adapter_v1",
);
if (!schema.startsWith("dlmf_pilot_")) {
  throw new Error("DLMF_MIGRATION_SCHEMA must be an isolated dlmf_pilot_* schema");
}
const namespace = process.env.DLMF_MIGRATION_NAMESPACE || "pilot.hermes-historical-migration.v0.1";
if (!namespace.startsWith("pilot.")) throw new Error("bounded pilot namespace must start with pilot.");
const tenantId = process.env.DLMF_MIGRATION_TENANT_ID || "arthurverse-hermes-migration-pilot";
const lifeDid = process.env.DLMF_MIGRATION_LIFE_DID || "did:arthurverse:nancy";
const agentId = process.env.DLMF_MIGRATION_AGENT_ID || "nancy";
const runtimeId = process.env.DLMF_MIGRATION_RUNTIME_ID || "hermes-gb10";
const maxUnits = boundedInt(process.env.DLMF_MIGRATION_MAX_UNITS, 1, 1, 20);
const maxEvents = boundedInt(process.env.DLMF_MIGRATION_MAX_EVENTS, 80, 1, 500);
const maxChars = boundedInt(process.env.DLMF_MIGRATION_MAX_CHARS, 60_000, 1_000, 500_000);
const hindsightBankPrefix = process.env.DLMF_MIGRATION_HINDSIGHT_BANK_PREFIX
  || "dlmf-hermes-migration-pilot-v1";

const stateRoot = resolve(
  process.env.DLMF_MIGRATION_STATE_ROOT
    || join(home, ".local", "state", "dlmf", "hermes-historical-migration", schema),
);
const archiveRoot = resolve(
  process.env.DLMF_MIGRATION_ARCHIVE_ROOT
    || join(home, ".local", "share", "dlmf", "hermes-historical-migration", schema, "raw"),
);
const statePath = join(stateRoot, "state.json");
const reportPath = join(stateRoot, "latest-report.json");
const scope = { tenantId, lifeDid, memoryNamespace: namespace };

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function boundedInt(raw, fallback, min, max) {
  const value = raw == null || String(raw).trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`integer must be between ${min} and ${max}`);
  }
  return value;
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

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function secretFingerprint(value) {
  return value ? sha256(value).slice(0, 12) : "none";
}

function safeDatabaseIdentity(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}:${url.port || "default"}${url.pathname}`;
}

function validateServiceUrl(value) {
  const url = new URL(value);
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]).has(url.hostname);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Hindsight URL must not contain credentials, query, or fragment");
  }
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Hindsight URL must use HTTPS unless loopback");
  }
  return url.toString().replace(/\/$/u, "");
}

function endpointShape(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

async function readHermesHindsightConfig() {
  const path = join(hermesHome, "hindsight", "config.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return parsed && typeof parsed === "object" ? parsed : {};
}

function dedupeAuthCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const identity = candidate.apiKey ?? "<none>";
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

async function resolveHindsightConnection() {
  const explicitUrl = firstText(
    process.env.DLMF_MIGRATION_HINDSIGHT_URL,
    process.env.DLMF_PILOT_HINDSIGHT_URL,
  );
  const config = explicitUrl ? {} : await readHermesHindsightConfig();
  const hermesEnv = explicitUrl ? {} : readSimpleEnvFile(join(hermesHome, ".env"));
  const mode = explicitUrl ? "explicit" : String(config.mode || "cloud");
  const defaultUrl = new Set(["local", "local_embedded", "local_external"]).has(mode)
    ? "http://127.0.0.1:8888"
    : "https://api.hindsight.vectorize.io";
  const baseUrl = validateServiceUrl(
    String(explicitUrl || config.api_url || config.apiUrl || defaultUrl),
  );
  const candidates = dedupeAuthCandidates([
    ...(firstText(process.env.DLMF_MIGRATION_HINDSIGHT_API_KEY)
      ? [{ source: "migration_override", apiKey: process.env.DLMF_MIGRATION_HINDSIGHT_API_KEY.trim() }]
      : []),
    ...(firstText(process.env.DLMF_PILOT_HINDSIGHT_API_KEY)
      ? [{ source: "pilot_override", apiKey: process.env.DLMF_PILOT_HINDSIGHT_API_KEY.trim() }]
      : []),
    ...(firstText(hermesEnv.HINDSIGHT_API_KEY)
      ? [{ source: "hermes_env", apiKey: hermesEnv.HINDSIGHT_API_KEY.trim() }]
      : []),
    ...(firstText(config.api_key, config.apiKey)
      ? [{ source: "hindsight_config", apiKey: firstText(config.api_key, config.apiKey) }]
      : []),
    { source: "no_auth", apiKey: undefined },
  ]);

  const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!health.ok) throw new Error(`Hindsight health HTTP ${health.status}`);

  for (const candidate of candidates) {
    const response = await fetch(`${baseUrl}/v1/default/banks?limit=1`, {
      headers: candidate.apiKey ? { Authorization: `Bearer ${candidate.apiKey}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.text();
    if (response.ok) {
      return {
        baseUrl,
        apiKey: candidate.apiKey,
        authSource: candidate.source,
        authFingerprint: secretFingerprint(candidate.apiKey),
        mode,
      };
    }
    const lower = body.toLowerCase();
    const authFailure = response.status === 401 || response.status === 403
      || lower.includes("authentication failed")
      || lower.includes("invalid api key")
      || lower.includes("missing authorization");
    if (!authFailure) throw new Error(`Hindsight bank probe HTTP ${response.status}`);
  }
  throw new Error("Hindsight authentication could not be validated");
}

async function loadHindsightClientConstructor() {
  const override = firstText(process.env.DLMF_MIGRATION_HINDSIGHT_CLIENT_MODULE);
  const omniHarnessDir = resolve(
    process.env.OMNIHARNESS_DIR || join(repoRoot, "..", "OmniHarness"),
  );
  const candidate = override || join(
    omniHarnessDir,
    "node_modules",
    "@vectorize-io",
    "hindsight-client",
    "dist",
    "index.mjs",
  );
  if (!existsSync(candidate)) throw new Error("Hindsight client module not found");
  const module = await import(pathToFileURL(candidate).href);
  if (typeof module.HindsightClient !== "function") throw new Error("HindsightClient export missing");
  return module.HindsightClient;
}

function createHindsightPort(client, connection) {
  return {
    retain: client.retain.bind(client),
    listMemories: client.listMemories.bind(client),
    recall: client.recall.bind(client),
    reflect: client.reflect.bind(client),
    async getOperationStatus(bankId, operationId) {
      const response = await fetch(
        `${connection.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`,
        {
          headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!response.ok) throw new Error(`Hindsight operation status HTTP ${response.status}`);
      const value = await response.json();
      if (!value || typeof value !== "object") throw new Error("Hindsight operation status malformed");
      return value;
    },
  };
}

async function probePostgres() {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    await pool.query("SELECT 1");
  } finally {
    await pool.end();
  }
}

async function inspectPilotSchema() {
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const exists = (await admin.query(
      "SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists",
      [schema],
    )).rows[0]?.exists === true;
    if (!exists) return { exists: false, state: "absent", ready: false };
  } finally {
    await admin.end();
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  try {
    const state = await inspectDigitalLifeStackSchema(pool);
    return { exists: true, state: state.state, ready: state.ready };
  } finally {
    await pool.end();
  }
}

async function openBootstrappedPilotSchema() {
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const exists = (await admin.query(
      "SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists",
      [schema],
    )).rows[0]?.exists === true;
    if (!exists) await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 4,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await bootstrapDigitalLifeStackSchema(pool, { rootDir: repoRoot, allowUpgrade: false });
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function canonicalCounts(pool) {
  const row = (await pool.query(`SELECT
    (SELECT count(*)::int FROM memory_distillation_receipts) AS receipts,
    (SELECT count(*)::int FROM memory_candidates) AS candidates,
    (SELECT count(*)::int FROM memory_heads) AS heads,
    (SELECT count(*)::int FROM memory_revisions) AS revisions`)).rows[0];
  return {
    receipts: Number(row?.receipts ?? 0),
    candidates: Number(row?.candidates ?? 0),
    heads: Number(row?.heads ?? 0),
    revisions: Number(row?.revisions ?? 0),
  };
}

function migrationEligibility() {
  const base = new HermesHistoricalMigrationEligibilityPolicy();
  const version = `${base.version}:bounded:maxEvents=${maxEvents}:maxChars=${maxChars}`;
  return {
    version,
    assess(experience) {
      const baseDecision = base.assess(experience);
      if (!baseDecision.eligible) return baseDecision;
      const textEvents = experience.events.filter(
        (event) => typeof event.content === "string" && event.content.trim().length > 0,
      );
      const fallback = experience.content.filter(
        (content) => typeof content.text === "string" && content.text.trim().length > 0,
      );
      const chars = textEvents.reduce((sum, event) => sum + event.content.length, 0)
        + fallback.reduce((sum, content) => sum + content.text.length, 0);
      if (experience.events.length > maxEvents) {
        return { eligible: false, reasonCode: "bounded_pilot_event_limit" };
      }
      if (chars > maxChars) {
        return { eligible: false, reasonCode: "bounded_pilot_char_limit" };
      }
      return { eligible: true, reasonCode: "bounded_pilot_eligible" };
    },
  };
}

function migrationId(connection, eligibilityVersion) {
  const identity = JSON.stringify({
    database: safeDatabaseIdentity(databaseUrl),
    schema,
    scope,
    agentId,
    runtimeId,
    hindsight: endpointShape(connection.baseUrl),
    hindsightBankPrefix,
    eligibilityVersion,
  });
  return `hermes-migration:${sha256(identity)}`;
}

async function privateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function contentFreeCheckpoint(state) {
  const checkpoint = state.checkpoint;
  return {
    lastExperienceId: checkpoint.lastExperienceId ?? null,
    lastSourceFingerprint: checkpoint.lastSourceFingerprint?.value ?? null,
    updatedAt: checkpoint.updatedAt,
  };
}

const reader = new HermesSqliteReader(sourceDb);
const sourceAdapter = new HermesSourceAdapter({ reader, version: "0.1.0" });
const inspection = await sourceAdapter.inspect();
await probePostgres();
const existingSchema = await inspectPilotSchema();
if (existingSchema.exists && !existingSchema.ready) {
  throw new Error(`existing pilot schema is not current/ready: ${existingSchema.state}`);
}
const hindsightConnection = await resolveHindsightConnection();
const HindsightClient = await loadHindsightClientConstructor();
const hindsightClient = new HindsightClient({
  baseUrl: hindsightConnection.baseUrl,
  userAgent: "dlmf-hermes-migration-pilot/0.2",
  ...(hindsightConnection.apiKey ? { apiKey: hindsightConnection.apiKey } : {}),
});
const hindsightVersion = await hindsightClient.getVersion();

console.log("DLMF Hermes Historical Migration — Bounded Pilot");
console.log(`mode=${preflightOnly ? "preflight" : "apply"}`);
console.log(`node=${process.version}`);
console.log(`sourceDb=read-only schemaVersion=${inspection.metadata.schemaVersion} sessions=${inspection.metadata.sessionCount} messages=${inspection.metadata.messageCount}`);
console.log(`postgres=healthy targetFingerprint=${sha256(safeDatabaseIdentity(databaseUrl)).slice(0, 12)} schema=${schema} schemaState=${existingSchema.state}`);
console.log(`hindsight=${endpointShape(hindsightConnection.baseUrl)} auth=${hindsightConnection.authSource}:${hindsightConnection.authFingerprint} version=${hindsightVersion.api_version || hindsightVersion.version || "unknown"}`);
console.log(`bounds=maxUnits:${maxUnits},maxEvents:${maxEvents},maxChars:${maxChars}`);

if (preflightOnly) {
  console.log("HERMES_BOUNDED_MIGRATION_PREFLIGHT=PASS");
  process.exit(0);
}

await mkdir(stateRoot, { recursive: true, mode: 0o700 });
await chmod(stateRoot, 0o700);
await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
await chmod(archiveRoot, 0o700);

const eligibility = migrationEligibility();
const destinationId = migrationId(hindsightConnection, eligibility.version);
const pool = await openBootstrappedPilotSchema();
let runtime;
try {
  const clientPort = createHindsightPort(hindsightClient, hindsightConnection);
  const banks = new DeterministicHindsightPlaneResolver(hindsightBankPrefix);
  const distillationProvider = new HindsightMemoryAdapter({
    client: clientPort,
    banks,
    adapterVersion: "hindsight-hermes-migration-pilot-v2",
    providerVersion: String(hindsightVersion.api_version || hindsightVersion.version || "unknown"),
    recallBudget: "mid",
    reflectBudget: "mid",
  });
  const retrievalPort = new HindsightCanonicalProjectionPort({
    client: clientPort,
    banks,
    providerId: "hindsight",
    recallBudget: "mid",
  });
  runtime = createDigitalLifeStackDlmfRuntime({
    pool,
    archiveRoot,
    bearerToken: randomBytes(32).toString("hex"),
    agentId,
    runtimeId,
    policies: {
      distillationPolicyVersion: "hermes-migration-pilot-distill-v2",
      canonicalizationPolicyVersion: "hermes-migration-pilot-canonical-v2",
      admissionPolicyVersion: "hermes-migration-pilot-admission-v2",
      retentionPolicyVersion: "hermes-migration-pilot-retention-v2",
    },
    distillationProvider,
    retrievalPort,
    curationProviderVersion: "hermes-migration-pilot-curation-v2",
  });
  const ingestor = runtime.createNormalizedExperienceIngestor(scope);
  const stateStore = new JsonFileSourceMigrationStateStore(statePath);
  const runner = new HistoricalExperienceMigrationRunner({
    adapter: sourceAdapter,
    ingestor,
    eligibility,
    stateStore,
    migrationId: destinationId,
  });

  const before = await canonicalCounts(pool);
  const result = await runner.run({ maxUnits });
  const after = await canonicalCounts(pool);
  const receiptIds = result.units.flatMap((unit) => unit.receiptId ? [unit.receiptId] : []);
  const report = {
    contract: "dlmf/hermes-bounded-historical-migration/v1",
    status: "PASS",
    observedAt: new Date().toISOString(),
    source: {
      adapterName: inspection.adapterName,
      adapterVersion: inspection.adapterVersion,
      sourceSystem: inspection.sourceSystem,
      sourceType: inspection.sourceType,
      schemaVersion: inspection.metadata.schemaVersion ?? null,
      sessionCount: inspection.metadata.sessionCount ?? null,
      messageCount: inspection.metadata.messageCount ?? null,
      databaseBytes: inspection.metadata.databaseBytes ?? null,
    },
    destination: {
      migrationId: destinationId,
      schema,
      tenantId,
      lifeDid,
      memoryNamespace: namespace,
      canonicalAuthority: "digital-life-memory-fabric",
    },
    bounds: { maxUnits, maxEvents, maxChars },
    run: {
      status: result.status,
      processedThisRun: result.processedThisRun,
      ingestedThisRun: result.ingestedThisRun,
      skippedThisRun: result.skippedThisRun,
      receiptIds,
      cumulativeProcessed: result.state.processedUnits,
      cumulativeIngested: result.state.ingestedUnits,
      cumulativeSkipped: result.state.skippedUnits,
      complete: result.state.complete,
      checkpoint: contentFreeCheckpoint(result.state),
    },
    canonicalCounts: { before, after },
    privacy: {
      sourceOpenedReadOnly: true,
      rawCursorReported: false,
      messageBodiesReported: false,
      titlesReported: false,
      sourceIdsReported: false,
      secretsReported: false,
    },
  };
  await privateJson(reportPath, report);
  console.log(`processed=${result.processedThisRun} ingested=${result.ingestedThisRun} skipped=${result.skippedThisRun} complete=${result.state.complete}`);
  console.log(`receipts=${before.receipts}->${after.receipts} candidates=${before.candidates}->${after.candidates} heads=${before.heads}->${after.heads} revisions=${before.revisions}->${after.revisions}`);
  console.log(`receiptIds=${receiptIds.join(",") || "none"}`);
  console.log(`checkpointExperience=${result.state.checkpoint.lastExperienceId ?? "none"}`);
  console.log(`state=${statePath}`);
  console.log(`report=${reportPath}`);
  console.log("HERMES_BOUNDED_MIGRATION=PASS");
} finally {
  if (runtime !== undefined) await runtime.close();
  else await pool.end();
}
