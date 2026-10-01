#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  CodexIncrementalSyncService,
  CodexJsonlSessionReader,
  CodexSourceAdapter,
} from "../dist/index.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const root = option("--root");
if (!root) throw new Error("usage: node scripts/codex-source-reference-uat.mjs --root <codex-session-root>");

class MemoryCheckpointStore {
  value;
  async load() {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
  async save(value) {
    this.value = structuredClone(value);
  }
}

const reader = new CodexJsonlSessionReader(root);
const inspection = await reader.inspect();
const evidenceAdapter = new CodexSourceAdapter({ reader });
const evidence = [];
let evidenceCursor;
do {
  const page = await evidenceAdapter.discover({
    limit: 100,
    ...(evidenceCursor === undefined ? {} : { cursor: evidenceCursor }),
  });
  for (const unit of page.units) {
    const normalized = await evidenceAdapter.normalize(
      await evidenceAdapter.read(unit),
    );
    evidence.push({
      sourceIdHash: createHash("sha256")
        .update(normalized.sourceId, "utf8")
        .digest("hex")
        .slice(0, 16),
      userMessageCount: Number(normalized.metadata.userMessageCount ?? 0),
      assistantMessageCount: Number(normalized.metadata.assistantMessageCount ?? 0),
      selectedMessageCount: Number(normalized.metadata.selectedMessageCount ?? 0),
      excludedRecordCount: Number(normalized.metadata.excludedRecordCount ?? 0),
    });
  }
  evidenceCursor = page.nextCursor;
} while (evidenceCursor !== undefined);

const checkpointStore = new MemoryCheckpointStore();
const service = new CodexIncrementalSyncService({
  reader,
  checkpointStore,
  referenceOnly: true,
  scope: {
    tenantId: "uat",
    lifeDid: "did:arthurverse:nancy",
    memoryNamespace: "codex-reference-only-uat",
  },
  minimumIdleMs: 0,
  pageSize: 100,
});

const result = await service.runOnce();
const shortHash = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);

const references = result.experiences.map((reference) => ({
  schema: reference.schema,
  authority: reference.authority,
  sourceSystem: reference.source.sourceSystem,
  sourceType: reference.source.sourceType,
  sourceIdHash: shortHash(reference.source.sourceId),
  disposition: reference.disposition,
  containsContentSurface:
    Object.hasOwn(reference, "content")
    || Object.hasOwn(reference, "events")
    || Object.hasOwn(reference, "transcript"),
}));

console.log(JSON.stringify({
  uat: "REAL_CODEX_LOCAL_REFERENCE_ONLY",
  discoveredSessions: inspection.sessionCount,
  scanned: result.scanned,
  changed: result.changed,
  ingested: result.ingested,
  sourceOnly: result.sourceOnly,
  deferred: result.deferred,
  checkpointedSources: Object.keys(checkpointStore.value?.fingerprints ?? {}).length,
  evidence,
  references,
}, null, 2));
