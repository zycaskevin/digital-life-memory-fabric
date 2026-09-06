import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { Pool } from "pg";

const host = process.env.DLMF_RELATIONSHIP_OS_HOST || "127.0.0.1";
if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
  throw new Error("DLMF Relationship OS ingress must bind loopback only; terminate TLS in a trusted reverse proxy/tunnel");
}
const port = boundedPort(process.env.DLMF_RELATIONSHIP_OS_PORT || "8793");
const databaseUrl = requiredEnv("DLMF_RELATIONSHIP_OS_DATABASE_URL");
const schema = validatedSchema(process.env.DLMF_RELATIONSHIP_OS_SCHEMA || "dlmf_relationship_os");
const archiveRoot = resolve(requiredEnv("DLMF_RELATIONSHIP_OS_ARCHIVE_ROOT"));
const hindsightBaseUrl = requiredEnv("DLMF_RELATIONSHIP_OS_HINDSIGHT_URL").replace(/\/$/, "");
const hindsightApiKey = process.env.DLMF_RELATIONSHIP_OS_HINDSIGHT_API_KEY?.trim() || undefined;
const omniHarnessDir = resolve(process.env.OMNIHARNESS_DIR || resolve("../OmniHarness"));

const dlfm = await import(new URL("../dist/index.js", import.meta.url));
const HindsightClient = await loadHindsightClient();
const hindsightClient = new HindsightClient({
  baseUrl: hindsightBaseUrl,
  userAgent: "dlmf-relationship-os-ingress/0.1.1",
  ...(hindsightApiKey ? { apiKey: hindsightApiKey } : {}),
});
const version = await hindsightClient.getVersion();
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: boundedInt(process.env.DLMF_RELATIONSHIP_OS_PG_POOL_MAX, 4, 1, 16),
  connectionTimeoutMillis: 5_000,
});
await assertSchemaReady(pool);

const runtime = dlfm.createRelationshipOsDlmfRuntime({
  pool,
  archiveRoot,
  hindsightClient,
  hindsightAdapterVersion: process.env.DLMF_RELATIONSHIP_OS_HINDSIGHT_ADAPTER_VERSION || "ros-private-turn-hindsight-v1",
  hindsightProviderVersion: String(version.api_version || version.version || "unknown"),
  hindsightBankPrefix: process.env.DLMF_RELATIONSHIP_OS_HINDSIGHT_BANK_PREFIX || "dlmf-ros-nancy",
  bearerToken: requiredEnv("DLMF_RELATIONSHIP_OS_BEARER_TOKEN"),
  allowedTenantId: requiredEnv("DLMF_RELATIONSHIP_OS_TENANT_ID"),
  allowedLifeDid: requiredEnv("DLMF_RELATIONSHIP_OS_LIFE_DID"),
  memoryNamespacePrefix: process.env.DLMF_RELATIONSHIP_OS_NAMESPACE_PREFIX || "relationship.private.",
  agentId: process.env.DLMF_RELATIONSHIP_OS_AGENT_ID || "nancy",
  runtimeId: "relationship-os",
  policies: {
    distillationPolicyVersion: process.env.DLMF_RELATIONSHIP_OS_DISTILLATION_POLICY || "ros-private-turn-distill-v1",
    canonicalizationPolicyVersion: process.env.DLMF_RELATIONSHIP_OS_CANONICALIZATION_POLICY || "ros-private-turn-canonicalize-v1",
    admissionPolicyVersion: process.env.DLMF_RELATIONSHIP_OS_ADMISSION_POLICY || "ros-private-turn-admission-v1",
    retentionPolicyVersion: process.env.DLMF_RELATIONSHIP_OS_RETENTION_POLICY || "ros-private-turn-retention-v1",
  },
});

const server = createServer(async (incoming, outgoing) => {
  try {
    const origin = `http://${host === "::1" ? "[::1]" : host}:${port}`;
    const request = new Request(new URL(incoming.url || "/", origin), {
      method: incoming.method,
      headers: incoming.headers,
      ...(incoming.method === "GET" || incoming.method === "HEAD"
        ? {}
        : { body: Readable.toWeb(incoming), duplex: "half" }),
    });
    const response = await runtime.ingress.handle(request);
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers) outgoing.setHeader(name, value);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json; charset=utf-8");
    outgoing.setHeader("cache-control", "no-store");
    outgoing.end(JSON.stringify({ error: "dlmf_relationship_os_internal_error" }));
  }
});

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolvePromise);
});
console.log(`DLMF_RELATIONSHIP_OS_INGRESS=READY host=${host} port=${port} schema=${schema}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await runtime.close();
}
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
process.on("SIGINT", () => void close().finally(() => process.exit(0)));

async function assertSchemaReady(targetPool) {
  const result = await targetPool.query(
    `SELECT to_regclass('memory_heads') AS memory_heads,
            to_regclass('memory_distillation_receipts') AS receipts,
            to_regclass('memory_curation_records') AS curation`,
  );
  const row = result.rows[0];
  if (!row || row.memory_heads == null || row.receipts == null || row.curation == null) {
    throw new Error("DLMF Relationship OS schema is not bootstrapped");
  }
}

async function loadHindsightClient() {
  const override = process.env.DLMF_RELATIONSHIP_OS_HINDSIGHT_CLIENT_MODULE;
  const candidate = override
    ? resolve(override)
    : resolve(omniHarnessDir, "node_modules", "@vectorize-io", "hindsight-client", "dist", "index.mjs");
  if (!existsSync(candidate)) throw new Error("Hindsight client module not found");
  const module = await import(pathToFileURL(candidate).href);
  if (typeof module.HindsightClient !== "function") throw new Error("HindsightClient export not found");
  return module.HindsightClient;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function validatedSchema(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("DLMF_RELATIONSHIP_OS_SCHEMA invalid");
  return value;
}
function boundedPort(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) throw new Error("DLMF_RELATIONSHIP_OS_PORT invalid");
  return value;
}
function boundedInt(raw, fallback, min, max) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("bounded integer invalid");
  return value;
}
