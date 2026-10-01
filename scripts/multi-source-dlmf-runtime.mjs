import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

import {
  inspectDigitalLifeStackSchema,
  validatedDlmfSchema,
} from "./digital-life-stack-schema-lib.mjs";

export function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return character === "\r" || character === "\n" || code === 0 || code === 127;
  })) {
    throw new Error(`${name} contains control characters`);
  }
  return value;
}

export function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function multiSourceWriteMode(argv = process.argv.slice(2)) {
  if (argv.includes("--reference-only")) return "reference_only";
  const value = process.env.DLMF_MULTI_SOURCE_WRITE_MODE?.trim() || "reference_only";
  if (value !== "reference_only" && value !== "distill") {
    throw new Error("DLMF_MULTI_SOURCE_WRITE_MODE must be reference_only or distill");
  }
  return value;
}

export function assertMultiSourceDistillCanary(mode, scope) {
  if (mode !== "distill") return;
  if (process.env.DLMF_MULTI_SOURCE_DISTILL_CANARY?.trim() !== "1") {
    throw new Error(
      "distill mode requires DLMF_MULTI_SOURCE_DISTILL_CANARY=1",
    );
  }
  const namespace = requiredEnv("DLMF_MULTI_SOURCE_CANARY_NAMESPACE");
  if (namespace === "life" || !namespace.startsWith("canary-")) {
    throw new Error(
      "multi-source distill canary namespace must start with canary- and must not be life",
    );
  }
  if (scope.memoryNamespace !== namespace) {
    throw new Error(
      "multi-source distill scope must match DLMF_MULTI_SOURCE_CANARY_NAMESPACE",
    );
  }
}

export async function createMultiSourceDlmfRuntime({
  dlfm,
  runtimeId,
  scope,
}) {
  const databaseUrl = requiredEnv("DLMF_DLS_DATABASE_URL");
  const schema = validatedDlmfSchema(
    process.env.DLMF_DLS_SCHEMA || "dlmf_digital_life_stack",
  );
  const archiveRoot = resolve(requiredEnv("DLMF_DLS_ARCHIVE_ROOT"));
  const hindsightUrl = serviceUrl(requiredEnv("DLMF_DLS_HINDSIGHT_URL"));
  const hindsightApiKey = resolveHindsightApiKey();
  const omniHarnessDir = resolve(
    process.env.OMNIHARNESS_DIR || resolve("../OmniHarness"),
  );
  const clientModule = process.env.DLMF_DLS_HINDSIGHT_CLIENT_MODULE
    ? resolve(process.env.DLMF_DLS_HINDSIGHT_CLIENT_MODULE)
    : resolve(
        omniHarnessDir,
        "node_modules",
        "@vectorize-io",
        "hindsight-client",
        "dist",
        "index.mjs",
      );
  if (!existsSync(clientModule)) throw new Error("Hindsight client module not found");
  if (!isLoopbackUrl(hindsightUrl) && !hindsightApiKey) {
    throw new Error("remote Hindsight requires DLMF_DLS_HINDSIGHT_API_KEY");
  }

  const { HindsightClient } = await import(pathToFileURL(clientModule).href);
  if (typeof HindsightClient !== "function") {
    throw new Error("HindsightClient export not found");
  }
  const hindsightClient = new HindsightClient({
    baseUrl: hindsightUrl,
    ...(hindsightApiKey ? { apiKey: hindsightApiKey } : {}),
  });
  const version = await hindsightClient.getVersion();
  await assertHindsightAuthentication(hindsightUrl, hindsightApiKey);

  const banks = new dlfm.DeterministicHindsightPlaneResolver(
    process.env.DLMF_DLS_HINDSIGHT_BANK_PREFIX || "dlmf-dls",
  );
  const hindsightPort = {
    retain: hindsightClient.retain.bind(hindsightClient),
    listMemories: hindsightClient.listMemories.bind(hindsightClient),
    recall: hindsightClient.recall.bind(hindsightClient),
    reflect: hindsightClient.reflect.bind(hindsightClient),
    async getOperationStatus(bankId, operationId) {
      const response = await fetch(
        `${hindsightUrl}/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`,
        {
          headers: hindsightApiKey
            ? { Authorization: `Bearer ${hindsightApiKey}` }
            : {},
          signal: AbortSignal.timeout(8_000),
        },
      );
      if (!response.ok) {
        throw new Error(`Hindsight operation status HTTP ${response.status}`);
      }
      return response.json();
    },
  };
  const provider = new dlfm.HindsightMemoryAdapter({
    client: hindsightPort,
    banks,
    adapterVersion:
      process.env.DLMF_DLS_HINDSIGHT_ADAPTER_VERSION || "dls-hindsight-v1",
    providerVersion: String(version.api_version || version.version || "unknown"),
    recallBudget: "mid",
    reflectBudget: "mid",
    distillationProjectionMode:
      process.env.DLMF_DLS_HINDSIGHT_DISTILLATION_PROJECTION_MODE
      || "source_actor_only",
    asyncRetainTimeoutMs: boundedInteger(
      "DLMF_DLS_HINDSIGHT_ASYNC_TIMEOUT_MS",
      1_800_000,
      1_000,
      3_600_000,
    ),
  });
  const retrievalPort = new dlfm.HindsightCanonicalProjectionPort({
    client: hindsightPort,
    banks,
    providerId: "hindsight",
    recallBudget: "mid",
  });

  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: boundedInteger("DLMF_DLS_PG_POOL_MAX", 2, 1, 16),
    connectionTimeoutMillis: 5_000,
  });

  try {
    const state = await inspectDigitalLifeStackSchema(pool);
    if (!state.ready) throw new Error(`DLMF schema not ready: ${state.state}`);
    const runtime = dlfm.createDigitalLifeStackDlmfRuntime({
      pool,
      archiveRoot,
      bearerToken:
        process.env.DLMF_DLS_BEARER_TOKEN
        || "multi-source-worker-internal-token-000000000000",
      agentId: process.env.DLMF_DLS_AGENT_ID || "digital-life-stack",
      runtimeId,
      allowedScope: scope,
      policies: {
        distillationPolicyVersion:
          process.env.DLMF_DLS_DISTILLATION_POLICY || "dls-distill-v1",
        canonicalizationPolicyVersion:
          process.env.DLMF_DLS_CANONICALIZATION_POLICY || "dls-canonical-v1",
        admissionPolicyVersion:
          process.env.DLMF_DLS_ADMISSION_POLICY || "dls-admission-v1",
        retentionPolicyVersion:
          process.env.DLMF_DLS_RETENTION_POLICY || "dls-retention-v1",
      },
      distillationProvider: provider,
      retrievalPort,
    });
    return {
      runtime,
      schema,
      async close() {
        await runtime.close().catch(() => undefined);
        await pool.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

export function resolveHindsightApiKey() {
  return process.env.DLMF_DLS_HINDSIGHT_API_KEY?.trim() || undefined;
}

async function assertHindsightAuthentication(baseUrl, apiKey) {
  const response = await fetch(`${baseUrl}/v1/default/banks?limit=1`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`Hindsight authentication probe failed HTTP ${response.status}`);
  }
}

export function serviceUrl(value) {
  const url = new URL(value);
  const loopback = isLoopbackHostname(url.hostname);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Hindsight URL invalid");
  }
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Hindsight URL must be HTTPS unless loopback");
  }
  return url.toString().replace(/\/$/u, "");
}

export function isLoopbackUrl(value) {
  return isLoopbackHostname(new URL(value).hostname);
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return new Set(["127.0.0.1", "::1", "localhost"]).has(normalized);
}
