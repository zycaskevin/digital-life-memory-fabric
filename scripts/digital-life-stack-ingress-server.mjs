import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { inspectDigitalLifeStackSchema, validatedDlmfSchema } from "./digital-life-stack-schema-lib.mjs";

const host = process.env.DLMF_DLS_HOST || "127.0.0.1";
if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
  throw new Error("DLMF Digital-Life-Stack ingress must bind loopback only");
}
const port = boundedPort(process.env.DLMF_DLS_PORT || "8794");
const databaseUrl = requiredEnv("DLMF_DLS_DATABASE_URL");
const schema = validatedDlmfSchema(process.env.DLMF_DLS_SCHEMA || "dlmf_digital_life_stack");
const archiveRoot = resolve(requiredEnv("DLMF_DLS_ARCHIVE_ROOT"));
const hindsightBaseUrl = serviceUrl(requiredEnv("DLMF_DLS_HINDSIGHT_URL"));
const hindsightApiKey = process.env.DLMF_DLS_HINDSIGHT_API_KEY?.trim() || undefined;
const omniHarnessDir = resolve(process.env.OMNIHARNESS_DIR || resolve("../OmniHarness"));

if (!isLoopbackUrl(hindsightBaseUrl) && !hindsightApiKey) {
  throw new Error("remote Hindsight requires DLMF_DLS_HINDSIGHT_API_KEY");
}

const dlfm = await import(new URL("../dist/index.js", import.meta.url));
const HindsightClient = await loadHindsightClient();
const hindsightClient = new HindsightClient({
  baseUrl: hindsightBaseUrl,
  userAgent: "dlmf-digital-life-stack-ingress/0.1.1",
  ...(hindsightApiKey ? { apiKey: hindsightApiKey } : {}),
});
const version = await hindsightClient.getVersion();
const banks = new dlfm.DeterministicHindsightPlaneResolver(
  process.env.DLMF_DLS_HINDSIGHT_BANK_PREFIX || "dlmf-dls",
);
const distillationProvider = new dlfm.HindsightMemoryAdapter({
  client: hindsightClient,
  banks,
  adapterVersion: process.env.DLMF_DLS_HINDSIGHT_ADAPTER_VERSION || "dls-hindsight-v1",
  providerVersion: String(version.api_version || version.version || "unknown"),
  recallBudget: "mid",
  reflectBudget: "mid",
});
const retrievalPort = new dlfm.HindsightCanonicalProjectionPort({
  client: hindsightClient,
  banks,
  providerId: "hindsight",
  recallBudget: "mid",
});

const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: boundedInt(process.env.DLMF_DLS_PG_POOL_MAX, 4, 1, 16),
  connectionTimeoutMillis: 5_000,
});
const state = await inspectDigitalLifeStackSchema(pool);
if (!state.ready) {
  await pool.end();
  throw new Error(`DLMF Digital-Life-Stack schema not ready: ${state.state}`);
}

const runtime = dlfm.createDigitalLifeStackDlmfRuntime({
  pool,
  archiveRoot,
  bearerToken: requiredEnv("DLMF_DLS_BEARER_TOKEN"),
  agentId: process.env.DLMF_DLS_AGENT_ID || "digital-life-stack",
  runtimeId: "digital-life-stack",
  policies: {
    distillationPolicyVersion: process.env.DLMF_DLS_DISTILLATION_POLICY || "dls-distill-v1",
    canonicalizationPolicyVersion: process.env.DLMF_DLS_CANONICALIZATION_POLICY || "dls-canonical-v1",
    admissionPolicyVersion: process.env.DLMF_DLS_ADMISSION_POLICY || "dls-admission-v1",
    retentionPolicyVersion: process.env.DLMF_DLS_RETENTION_POLICY || "dls-retention-v1",
  },
  distillationProvider,
  retrievalPort,
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
    outgoing.end(JSON.stringify({ error: "dlmf_digital_life_stack_internal_error" }));
  }
});

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolvePromise);
});
console.log(`DLMF_DLS_INGRESS=READY host=${host} port=${port} schema=${schema} canonical_authority=digital-life-memory-fabric`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await runtime.close();
}
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
process.on("SIGINT", () => void close().finally(() => process.exit(0)));

async function loadHindsightClient() {
  const override = process.env.DLMF_DLS_HINDSIGHT_CLIENT_MODULE;
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
function boundedPort(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new Error("DLMF_DLS_PORT invalid");
  }
  return value;
}
function boundedInt(raw, fallback, min, max) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("bounded integer invalid");
  return value;
}
function serviceUrl(value) {
  const url = new URL(value);
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]).has(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new Error("Hindsight URL invalid");
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Hindsight URL must be HTTPS unless loopback");
  }
  return url.toString().replace(/\/$/u, "");
}
function isLoopbackUrl(value) {
  return new Set(["127.0.0.1", "::1", "localhost"]).has(new URL(value).hostname);
}
