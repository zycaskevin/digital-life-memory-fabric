import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function checkRelationshipOsIngressConfig(
  text,
  { rootDir = process.cwd(), exists = existsSync } = {},
) {
  const values = parseEnv(text);
  const errors = [];

  const required = (name) => {
    const value = values.get(name)?.trim();
    if (!value || isPlaceholder(value)) {
      errors.push(`dlmf_relationship_os_env_unresolved:${name}`);
      return "";
    }
    return value;
  };

  const host = required("DLMF_RELATIONSHIP_OS_HOST");
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
    errors.push("dlmf_relationship_os_non_loopback_bind");
  }
  const port = integer(required("DLMF_RELATIONSHIP_OS_PORT"));
  if (port === undefined || port < 1024 || port > 65535) {
    errors.push("dlmf_relationship_os_port_invalid");
  }
  const schema = required("DLMF_RELATIONSHIP_OS_SCHEMA");
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema)) {
    errors.push("dlmf_relationship_os_schema_invalid");
  }
  if (required("DLMF_RELATIONSHIP_OS_NAMESPACE_PREFIX") !== "relationship.private.") {
    errors.push("dlmf_relationship_os_namespace_prefix_invalid");
  }
  if (required("DLMF_RELATIONSHIP_OS_AGENT_ID") !== "nancy") {
    errors.push("dlmf_relationship_os_agent_id_invalid");
  }

  const databaseUrl = required("DLMF_RELATIONSHIP_OS_DATABASE_URL");
  if (!validPostgresUrl(databaseUrl)) errors.push("dlmf_relationship_os_database_url_invalid");

  const archiveRoot = required("DLMF_RELATIONSHIP_OS_ARCHIVE_ROOT");
  if (!isAbsolute(archiveRoot) || !resolve(archiveRoot).startsWith("/var/lib/dlmf/")) {
    errors.push("dlmf_relationship_os_archive_root_invalid");
  }

  const bearer = required("DLMF_RELATIONSHIP_OS_BEARER_TOKEN");
  if (bearer.length < 32 || bearer.length > 512 || /[\r\n\u0000]/u.test(bearer)) {
    errors.push("dlmf_relationship_os_bearer_invalid");
  }
  const tenant = required("DLMF_RELATIONSHIP_OS_TENANT_ID");
  if (tenant.length > 256) errors.push("dlmf_relationship_os_tenant_invalid");
  const lifeDid = required("DLMF_RELATIONSHIP_OS_LIFE_DID");
  if (!lifeDid.startsWith("did:") || lifeDid.length > 256) {
    errors.push("dlmf_relationship_os_life_did_invalid");
  }
  const bankPrefix = required("DLMF_RELATIONSHIP_OS_HINDSIGHT_BANK_PREFIX");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(bankPrefix)) {
    errors.push("dlmf_relationship_os_hindsight_bank_prefix_invalid");
  }

  const hindsightUrl = required("DLMF_RELATIONSHIP_OS_HINDSIGHT_URL");
  if (!validServiceUrl(hindsightUrl)) errors.push("dlmf_relationship_os_hindsight_url_invalid");
  const hindsightKey = required("DLMF_RELATIONSHIP_OS_HINDSIGHT_API_KEY");
  if (hindsightKey.length < 8 || hindsightKey.length > 1024 || /[\r\n\u0000]/u.test(hindsightKey)) {
    errors.push("dlmf_relationship_os_hindsight_key_invalid");
  }

  const omniHarnessDir = required("OMNIHARNESS_DIR");
  if (!isAbsolute(omniHarnessDir)) {
    errors.push("dlmf_relationship_os_omniharness_path_invalid");
  } else {
    const clientModule = resolve(
      omniHarnessDir,
      "node_modules",
      "@vectorize-io",
      "hindsight-client",
      "dist",
      "index.mjs",
    );
    if (!exists(clientModule)) errors.push("dlmf_relationship_os_hindsight_client_missing");
  }

  for (const path of [
    "migrations/0001_canonical_core.sql",
    "migrations/0002_central_operations.sql",
    "migrations/0003_memory_distillation.sql",
    "migrations/0004_canonical_admission.sql",
    "scripts/relationship-os-ingress-bootstrap.mjs",
    "scripts/relationship-os-ingress-server.mjs",
  ]) {
    if (!exists(resolve(rootDir, path))) {
      errors.push(`dlmf_relationship_os_runtime_file_missing:${path}`);
    }
  }

  const uniqueErrors = [...new Set(errors)].sort();
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    publicSummary: uniqueErrors.length === 0
      ? [
          "DLMF_RELATIONSHIP_OS_CONFIG_PREFLIGHT=PASS",
          `host=${host} port=${port} schema=${schema} namespace_prefix=relationship.private.`,
          "database=postgresql archive=protected-path hindsight=authenticated canonical_authority=dlmf",
        ]
      : [],
  };
}

function parseEnv(text) {
  const result = new Map();
  for (const raw of text.split(/\r?\n/u)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ["'", '"'].includes(value[0])) {
      value = value.slice(1, -1);
    }
    result.set(key, value);
  }
  return result;
}

function integer(value) {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isPlaceholder(value) {
  return /^(?:REPLACE_WITH_|CHANGE_ME|CHANGEME)/iu.test(value);
}

function validPostgresUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:")
      && url.hostname !== ""
      && url.pathname !== "";
  } catch {
    return false;
  }
}

function validServiceUrl(value) {
  try {
    const url = new URL(value);
    const loopback = new Set(["127.0.0.1", "::1", "localhost"]).has(url.hostname);
    return url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && (url.protocol === "https:" || (loopback && url.protocol === "http:"));
  } catch {
    return false;
  }
}
