#!/usr/bin/env node
/**
 * Content-free Hermes -> Development reference worker.
 *
 * This worker deliberately has no PostgreSQL, Hindsight, distillation or
 * canonical-memory configuration. It only observes Hermes session versions,
 * advances a private checkpoint, and appends DLMF-owned content-free references.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const dlfm = await import(new URL("../dist/index.js", import.meta.url));

const dbPath = resolve(required("DLMF_HERMES_STATE_DB"));
const checkpointPath = resolve(required("DLMF_HERMES_INCREMENTAL_CHECKPOINT"));
const journalPath = resolve(required("DLMF_HERMES_DEVELOPMENT_EXPERIENCE_JOURNAL"));
const scope = {
  tenantId: required("DLMF_HERMES_TENANT_ID"),
  lifeDid: required("DLMF_HERMES_LIFE_DID"),
  memoryNamespace: required("DLMF_HERMES_MEMORY_NAMESPACE"),
};

await ensurePrivateParent(checkpointPath);
await ensurePrivateParent(journalPath);
await assertRegularSource(dbPath);

const sync = new dlfm.HermesIncrementalSyncService({
  reader: new dlfm.HermesSqliteReader(dbPath),
  checkpointStore: new dlfm.FileHermesIncrementalCheckpointStore(checkpointPath),
  referenceOnly: true,
  scope,
  origin: {
    lifeDid: scope.lifeDid,
    agentId: process.env.DLMF_DLS_AGENT_ID || "digital-life-stack",
    runtimeId: "hermes-development-reference",
  },
  // Required structurally by the shared service; unused in referenceOnly mode.
  policies: {
    distillationPolicyVersion: "reference-only/not-applicable",
    canonicalizationPolicyVersion: "reference-only/not-applicable",
    admissionPolicyVersion: "reference-only/not-applicable",
    retentionPolicyVersion: "reference-only/not-applicable",
  },
  pageSize: boundedInteger("DLMF_HERMES_INCREMENTAL_PAGE_SIZE", 250, 1, 1000),
});

const baseline = process.argv.includes("--baseline-current");
const result = baseline ? await sync.baselineCurrent() : await sync.runOnce();
if (result.receipts.length !== 0 || result.ingested !== 0) {
  throw new Error("reference-only worker observed a memory-ingestion result");
}
if (result.experiences.some((item) => item.disposition !== "REFERENCE_ONLY")) {
  throw new Error("reference-only worker emitted a non-reference-only disposition");
}
if (result.experiences.length > 0) {
  await appendPrivateJournal(
    journalPath,
    result.experiences.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
}
console.log(
  `DLMF_HERMES_REFERENCE_ONLY=PASS mode=${baseline ? "baseline" : "incremental"} `
  + `scanned=${result.scanned} changed=${result.changed} unchanged=${result.unchanged} `
  + `developmentRefs=${result.experiences.length} canonicalMemoryWrites=0`,
);

function required(name) {
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

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

async function ensurePrivateParent(path) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("reference-only state parent must be a private directory");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("reference-only state parent owner mismatch");
  }
}

async function assertRegularSource(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) {
    throw new Error("Hermes source DB must be a stable non-writable-by-others file");
  }
}

async function appendPrivateJournal(path, text) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error("Development reference journal must be owner-private");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Development reference journal owner mismatch");
    }
    await handle.write(text, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
