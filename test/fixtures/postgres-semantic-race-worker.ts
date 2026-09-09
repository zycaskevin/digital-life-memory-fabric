import {
  ConservativeMemoryCurationProvider,
  DeterministicCanonicalAdmissionPolicy,
  EvidenceBoundMemoryGovernance,
  FilesystemRawExperienceArchiveProvider,
  PostgresCanonicalMemoryStore,
  PostgresDistillationReceiptStore,
  PostgresMemoryCurationRecordStore,
  TranscriptDistillationService,
  type DistillationRequest,
  type DistillationResult,
  type MemoryDistillationProvider,
  type MemoryEvidence,
  type MemoryScope,
  type ProviderMemoryUnit,
  type RecallRequest,
  type ReflectRequest,
  type ReflectResult,
} from "../../src/index.js";
import { Pool } from "pg";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

class RaceProvider implements MemoryDistillationProvider {
  readonly name = "hindsight";
  readonly adapterVersion = "postgres-race-fixture-v1";
  readonly providerVersion = "fixture";

  constructor(private readonly workerId: string) {}

  async distill(_request: DistillationRequest): Promise<DistillationResult> {
    const unit: ProviderMemoryUnit = {
      providerUnitRef: `collision_${this.workerId}`,
      candidateType: "preference_candidate",
      memoryClass: "preference",
      memoryKind: "story_stream_structure",
      proposedContent: {
        text: this.workerId === "a"
          ? "User requires inline Nancy live commentary within the story."
          : "用戶偏好在故事中直接穿插 Nancy 的直播反應。",
      },
      evidenceRefs: [
        { sourceType: "hindsight", sourceRef: `collision_${this.workerId}` },
      ],
      epistemicStatus: "user_asserted",
      speakerProvenance: "user",
      producer: {
        kind: "provider",
        id: "hindsight",
        providerName: "hindsight",
        adapterVersion: this.adapterVersion,
        providerVersion: this.providerVersion,
      },
      sourceExperienceRefs: [
        { sourceType: "hermes_session", sourceId: `semantic-collision-${this.workerId}` },
      ],
    };
    return {
      providerName: this.name,
      providerRunId: `postgres_race_${this.workerId}`,
      adapterVersion: this.adapterVersion,
      providerVersion: this.providerVersion,
      providerUnits: [unit],
      warnings: [],
    };
  }

  async recall(_request: RecallRequest): Promise<MemoryEvidence[]> {
    return [];
  }

  async reflect(_request: ReflectRequest): Promise<ReflectResult> {
    return {
      providerName: this.name,
      providerRunId: `postgres_race_reflect_${this.workerId}`,
      adapterVersion: this.adapterVersion,
      providerVersion: this.providerVersion,
      candidates: [],
      warnings: [],
    };
  }
}

const databaseUrl = required("DLFM_TEST_DATABASE_URL");
const schema = required("DLFM_RACE_SCHEMA");
const archiveRoot = required("DLFM_RACE_ARCHIVE_ROOT");
const workerId = required("DLFM_RACE_WORKER_ID");
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
});
const store = new PostgresCanonicalMemoryStore(pool);
const originalLookup = store.findCurrentRevisionBySemanticKey.bind(store);
let barrierUsed = false;
let release!: () => void;
const releaseGate = new Promise<void>((resolve) => {
  release = resolve;
});

process.on("message", (message) => {
  if (message === "release") release();
});

store.findCurrentRevisionBySemanticKey = async (scope, semanticKey) => {
  const snapshot = await originalLookup(scope, semanticKey);
  if (!barrierUsed && snapshot === undefined) {
    barrierUsed = true;
    process.send?.({ type: "ready", workerId });
    await releaseGate;
  }
  return snapshot;
};

const scope: MemoryScope = {
  tenantId: "tenant_postgres_process_race",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

try {
  const receipt = await new TranscriptDistillationService({
    canonicalStore: store,
    receiptStore: new PostgresDistillationReceiptStore(pool),
    archive: new FilesystemRawExperienceArchiveProvider(archiveRoot),
    provider: new RaceProvider(workerId),
    curationProvider: new ConservativeMemoryCurationProvider("pilot-curation-v4"),
    curationStore: new PostgresMemoryCurationRecordStore(pool),
    admissionPolicy: new DeterministicCanonicalAdmissionPolicy("pilot-admission-v1"),
    governance: new EvidenceBoundMemoryGovernance("pilot-canonicalize-v1"),
  }).run({
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
    sourceType: "hermes_session",
    sourceId: `semantic-collision-${workerId}`,
    content: `PostgreSQL multiprocess semantic collision fixture ${workerId}`,
    contentType: "text/plain",
    distillationPolicyVersion: "pilot-distill-v5-semantic-governance",
    canonicalizationPolicyVersion: "pilot-canonicalize-v1",
    admissionPolicyVersion: "pilot-admission-v1",
    retentionPolicyVersion: "pilot-retention-v1",
  });
  process.send?.({
    type: "result",
    workerId,
    curationOutcomes: receipt.curationOutcomes,
    canonicalMemoryIds: receipt.canonicalMemoryIds,
    warnings: receipt.warnings,
    status: receipt.status,
    errors: receipt.errors,
  });
} catch (error) {
  process.send?.({
    type: "error",
    workerId,
    message: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  await store.close();
}
