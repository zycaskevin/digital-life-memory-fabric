#!/usr/bin/env node
import { resolve } from "node:path";

import {
  assertMultiSourceDistillCanary,
  boundedInteger,
  createMultiSourceDlmfRuntime,
  multiSourceCheckpointPath,
  multiSourceExecutionScope,
  multiSourceModeRunsDlmf,
  multiSourceWriteMode,
  requiredEnv,
} from "./multi-source-dlmf-runtime.mjs";
import {
  appendPrivateJournal,
  assertSecureSourceDirectory,
  ensurePrivateParent,
  isBaseline,
  isPreflight,
  scopeFromEnv,
  tryAcquireWorkerLock,
} from "./multi-source-worker-common.mjs";

const dlfm = await import(new URL("../dist/index.js", import.meta.url));
const argv = process.argv.slice(2);
const mode = multiSourceWriteMode(argv);
const sourceRoot = await assertSecureSourceDirectory(
  requiredEnv("DLMF_CODEX_SESSIONS_ROOT"),
);
const checkpointPath = multiSourceCheckpointPath(
  mode,
  resolve(requiredEnv("DLMF_CODEX_INCREMENTAL_CHECKPOINT")),
);
const configuredJournalPath = process.env.DLMF_CODEX_DEVELOPMENT_EXPERIENCE_JOURNAL?.trim()
  ? resolve(process.env.DLMF_CODEX_DEVELOPMENT_EXPERIENCE_JOURNAL.trim())
  : undefined;
const journalPath = configuredJournalPath === undefined
  ? undefined
  : mode === "shadow"
    ? `${configuredJournalPath}.shadow`
    : configuredJournalPath;
const sourceScope = scopeFromEnv("DLMF_CODEX", requiredEnv);
assertMultiSourceDistillCanary(mode, sourceScope);
const scope = multiSourceExecutionScope(mode, sourceScope);
if (mode === "reference_only" && journalPath === undefined) {
  throw new Error(
    "DLMF_CODEX_DEVELOPMENT_EXPERIENCE_JOURNAL is required in reference_only mode",
  );
}
const reader = new dlfm.CodexJsonlSessionReader(sourceRoot);
const inspection = await reader.inspect();

if (isPreflight(argv)) {
  let runtimeResources;
  try {
    if (multiSourceModeRunsDlmf(mode)) {
      runtimeResources = await createMultiSourceDlmfRuntime({
        dlfm,
        runtimeId: "codex-incremental-preflight",
        scope,
      });
    }
    console.log(
      `DLMF_CODEX_PREFLIGHT=PASS mode=${mode} sessions=${inspection.sessionCount} `
      + "checkpointWrites=0 canonicalMemoryWrites=0"
      + (mode === "shadow"
        ? ` shadowNamespace=${scope.memoryNamespace} productionCanonicalMemoryWrites=0`
        : ""),
    );
  } finally {
    await runtimeResources?.close().catch(() => undefined);
  }
  process.exit(0);
}

await ensurePrivateParent(checkpointPath);
if (journalPath !== undefined) await ensurePrivateParent(journalPath);
const workerLock = await tryAcquireWorkerLock(checkpointPath);
if (workerLock === undefined) {
  console.log(
    "DLMF_CODEX_INCREMENTAL=BUSY mode=" + mode
    + " checkpointWrites=0 canonicalMemoryWrites=0",
  );
  process.exit(75);
}

let runtimeResources;
try {
  const syncOptions = {
    reader,
    checkpointStore: new dlfm.FileIncrementalSourceCheckpointStore(checkpointPath),
    scope,
    minimumIdleMs: boundedInteger(
      "DLMF_CODEX_MINIMUM_IDLE_MS",
      5 * 60 * 1000,
      0,
      24 * 60 * 60 * 1000,
    ),
    pageSize: boundedInteger("DLMF_CODEX_PAGE_SIZE", 250, 1, 1000),
    ...(journalPath === undefined
      ? {}
      : {
          beforeCheckpointReference: (reference) =>
            appendPrivateJournal(journalPath, [reference]),
        }),
  };

  if (multiSourceModeRunsDlmf(mode)) {
    runtimeResources = await createMultiSourceDlmfRuntime({
      dlfm,
      runtimeId: "codex-incremental",
      scope,
    });
    syncOptions.ingestor =
      runtimeResources.runtime.createNormalizedExperienceIngestor(scope);
  } else {
    syncOptions.referenceOnly = true;
  }

  const sync = new dlfm.CodexIncrementalSyncService(syncOptions);
  const baseline = isBaseline(argv);
  const result = baseline ? await sync.baselineCurrent() : await sync.runOnce();

  if (mode === "reference_only") {
    if (result.receipts.length !== 0 || result.ingested !== 0) {
      throw new Error("Codex reference-only worker observed a memory-ingestion result");
    }
    if (result.experiences.some((item) => item.disposition !== "REFERENCE_ONLY")) {
      throw new Error("Codex reference-only worker emitted a non-reference-only disposition");
    }
  }

  const failedReceipts = result.receipts.filter(
    (receipt) =>
      receipt.status !== "complete" && receipt.status !== "awaiting_review",
  ).length;
  console.log(
    `DLMF_CODEX_INCREMENTAL=${failedReceipts === 0 ? "PASS" : "FAIL"} `
    + `mode=${mode} run=${baseline ? "baseline" : "incremental"} `
    + `scanned=${result.scanned} changed=${result.changed} ingested=${result.ingested} `
    + `sourceOnly=${result.sourceOnly} deferred=${result.deferred} `
    + `unchanged=${result.unchanged} developmentRefs=${result.experiences.length} `
    + `failedReceipts=${failedReceipts}`
    + (mode === "shadow"
      ? ` shadowNamespace=${scope.memoryNamespace} shadowEvaluated=${result.ingested} productionCanonicalMemoryWrites=0`
      : ""),
  );
  if (failedReceipts > 0) process.exitCode = 1;
} finally {
  await runtimeResources?.close().catch(() => undefined);
  await workerLock.release().catch(() => undefined);
}
