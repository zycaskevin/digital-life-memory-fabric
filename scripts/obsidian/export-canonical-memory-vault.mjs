import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import {
  ObsidianMemoryProjection,
  PostgresCanonicalMemoryStore,
} from "../../dist/index.js";

const home = process.env.HOME || homedir();
const repoRoot = resolve(dirname(dirname(dirname(import.meta.filename))));
const configPath = resolve(
  process.env.DLMF_OBSIDIAN_PILOT_CONFIG
    || `${home}/.config/dlmf/production-pilot.env`,
);
const config = existsSync(configPath) ? await readSimpleEnvFile(configPath) : {};
const databaseUrl = firstText(
  process.env.DLMF_OBSIDIAN_DATABASE_URL,
  process.env.DLMF_PILOT_DATABASE_URL,
  config.DLMF_PILOT_DATABASE_URL,
);
if (databaseUrl === undefined) {
  throw new Error("DLMF Obsidian projection PostgreSQL is not configured");
}
const schema = process.env.DLMF_OBSIDIAN_SCHEMA
  || "dlmf_pilot_hermes_adapter_direct1000_shadow_v3";
if (!/^dlmf_pilot_[a-z0-9_]+$/.test(schema)) {
  throw new Error("DLMF_OBSIDIAN_SCHEMA must be an isolated dlmf_pilot_* schema");
}
const vaultRoot = resolve(
  process.env.DLMF_OBSIDIAN_VAULT
    || `${repoRoot}/obsidian-vault`,
);

const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  max: 2,
});
const store = new PostgresCanonicalMemoryStore(pool);

try {
  const scope = await resolveScope(pool);
  const projection = new ObsidianMemoryProjection({
    store,
    scope,
    vaultRoot,
  });
  const result = await projection.export();
  console.log(JSON.stringify({
    contract: result.manifest.contract,
    mode: "read_only_projection",
    schema,
    scope,
    vaultRoot,
    activeMemoryCount: result.manifest.activeMemoryCount,
    excludedCount: result.manifest.excluded.length,
    maxCommitSeq: result.manifest.maxCommitSeq,
    supportingNoteCount: result.manifest.supportingNotes.length,
    writtenCount: result.written.length,
    unchangedCount: result.unchanged.length,
    removedCount: result.removed.length,
  }, null, 2));
} finally {
  await pool.end();
}

async function resolveScope(client) {
  const explicit = {
    tenantId: firstText(process.env.DLMF_OBSIDIAN_TENANT_ID),
    lifeDid: firstText(process.env.DLMF_OBSIDIAN_LIFE_DID),
    memoryNamespace: firstText(process.env.DLMF_OBSIDIAN_MEMORY_NAMESPACE),
  };
  const explicitCount = Object.values(explicit).filter((value) => value !== undefined).length;
  if (explicitCount !== 0 && explicitCount !== 3) {
    throw new Error(
      "DLMF Obsidian scope override requires tenant, life DID, and memory namespace together",
    );
  }
  if (explicitCount === 3) {
    return {
      tenantId: explicit.tenantId,
      lifeDid: explicit.lifeDid,
      memoryNamespace: explicit.memoryNamespace,
    };
  }

  const rows = (await client.query(`
    SELECT DISTINCT tenant_id, life_did, memory_namespace
      FROM memory_heads
     ORDER BY tenant_id, life_did, memory_namespace
  `)).rows;
  if (rows.length !== 1) {
    throw new Error(
      `DLMF Obsidian projection requires one unambiguous scope; found=${rows.length}`,
    );
  }
  return {
    tenantId: String(rows[0].tenant_id),
    lifeDid: String(rows[0].life_did),
    memoryNamespace: String(rows[0].memory_namespace),
  };
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
