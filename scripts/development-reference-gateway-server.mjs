import { createServer } from "node:http";
import { Readable } from "node:stream";
import { Pool } from "pg";

const host = process.env.DLMF_DEVELOPMENT_REFERENCE_HOST || "127.0.0.1";
if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
  throw new Error(
    "DLMF Development reference gateway must bind loopback only; terminate TLS in a trusted reverse proxy/tunnel",
  );
}

const port = boundedPort(process.env.DLMF_DEVELOPMENT_REFERENCE_PORT || "8794");
const databaseUrl = requiredEnv("DLMF_DEVELOPMENT_REFERENCE_DATABASE_URL");
const schema = validatedSchema(requiredEnv("DLMF_DEVELOPMENT_REFERENCE_SCHEMA"));
const bearerToken = requiredEnv("DLMF_DEVELOPMENT_REFERENCE_BEARER_TOKEN");
const allowedScope = {
  tenantId: requiredEnv("DLMF_DEVELOPMENT_REFERENCE_TENANT_ID"),
  lifeDid: requiredEnv("DLMF_DEVELOPMENT_REFERENCE_LIFE_DID"),
  memoryNamespace: requiredEnv("DLMF_DEVELOPMENT_REFERENCE_MEMORY_NAMESPACE"),
};

const dlfm = await import(new URL("../dist/index.js", import.meta.url));
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: boundedInt(process.env.DLMF_DEVELOPMENT_REFERENCE_PG_POOL_MAX, 4, 1, 16),
  connectionTimeoutMillis: 5_000,
});
await assertSchemaReady(pool);

const store = new dlfm.PostgresCanonicalMemoryStore(pool);
const gateway = new dlfm.DlmfDevelopmentReferenceGateway({
  bearerToken,
  allowedScope,
  store,
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
    const response = await gateway.handle(request);
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers) outgoing.setHeader(name, value);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json; charset=utf-8");
    outgoing.setHeader("cache-control", "no-store");
    outgoing.setHeader("x-content-type-options", "nosniff");
    outgoing.end(JSON.stringify({ error: "dlmf_development_reference_internal_error" }));
  }
});

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolvePromise);
});
console.log(
  `DLMF_DEVELOPMENT_REFERENCE_GATEWAY=READY host=${host} port=${port} schema=${schema}`,
);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await store.close();
}
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));
process.on("SIGINT", () => void close().finally(() => process.exit(0)));

async function assertSchemaReady(targetPool) {
  const result = await targetPool.query(
    `SELECT to_regclass('memory_heads') AS memory_heads,
            to_regclass('memory_revisions') AS memory_revisions,
            to_regclass('memory_evidence') AS memory_evidence`,
  );
  const row = result.rows[0];
  if (
    !row ||
    row.memory_heads == null ||
    row.memory_revisions == null ||
    row.memory_evidence == null
  ) {
    throw new Error("DLMF Development reference schema is not bootstrapped");
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function validatedSchema(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("DLMF_DEVELOPMENT_REFERENCE_SCHEMA invalid");
  }
  return value;
}

function boundedPort(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new Error("DLMF_DEVELOPMENT_REFERENCE_PORT invalid");
  }
  return value;
}

function boundedInt(raw, fallback, min, max) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("bounded integer invalid");
  }
  return value;
}
