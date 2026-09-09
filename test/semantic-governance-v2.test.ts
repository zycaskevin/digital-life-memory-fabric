import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CanonicalVerifier,
  ConservativeMemoryCurationProvider,
  DeterministicCanonicalAdmissionPolicy,
  EvidenceBoundMemoryGovernance,
  FilesystemRawExperienceArchiveProvider,
  InMemoryCanonicalMemoryStore,
  InMemoryDistillationReceiptStore,
  InMemoryMemoryCurationRecordStore,
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
  type TranscriptDistillationInput,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "tenant_semantic_v2",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

class FixtureProvider implements MemoryDistillationProvider {
  readonly name = "hindsight";
  readonly adapterVersion = "semantic-v2-fixture";
  readonly providerVersion = "fixture";

  constructor(private readonly units: ProviderMemoryUnit[]) {}

  async distill(_request: DistillationRequest): Promise<DistillationResult> {
    return {
      providerName: this.name,
      providerRunId: `run_${this.units.map((unit) => unit.providerUnitRef).join("_")}`,
      adapterVersion: this.adapterVersion,
      providerVersion: this.providerVersion,
      providerUnits: structuredClone(this.units),
      warnings: [],
    };
  }

  async recall(_request: RecallRequest): Promise<MemoryEvidence[]> {
    return [];
  }

  async reflect(_request: ReflectRequest): Promise<ReflectResult> {
    return {
      providerName: this.name,
      providerRunId: "reflect_unused",
      adapterVersion: this.adapterVersion,
      providerVersion: this.providerVersion,
      candidates: [],
      warnings: [],
    };
  }
}

function unit(providerUnitRef: string, text: string): ProviderMemoryUnit {
  return {
    providerUnitRef,
    candidateType: "preference_candidate",
    memoryClass: "preference",
    memoryKind: text.includes("mode") || text.includes("模式")
      ? "display_mode"
      : "story_stream_structure",
    proposedContent: { text },
    evidenceRefs: [{ sourceType: "hindsight", sourceRef: providerUnitRef }],
    epistemicStatus: "user_asserted",
    speakerProvenance: "user",
    producer: {
      kind: "provider",
      id: "hindsight",
      providerName: "hindsight",
      adapterVersion: "semantic-v2-fixture",
      providerVersion: "fixture",
    },
    sourceExperienceRefs: [{ sourceType: "hermes_session", sourceId: providerUnitRef }],
  };
}

function input(sourceId: string): TranscriptDistillationInput {
  return {
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
    sourceType: "hermes_session",
    sourceId,
    content: `Semantic governance fixture ${sourceId}`,
    contentType: "text/plain",
    distillationPolicyVersion: "pilot-distill-v5-semantic-governance",
    canonicalizationPolicyVersion: "pilot-canonicalize-v1",
    admissionPolicyVersion: "pilot-admission-v1",
    retentionPolicyVersion: "pilot-retention-v1",
  };
}

function service(
  archive: FilesystemRawExperienceArchiveProvider,
  store: InMemoryCanonicalMemoryStore,
  curationStore: InMemoryMemoryCurationRecordStore,
  units: ProviderMemoryUnit[],
): TranscriptDistillationService {
  return new TranscriptDistillationService({
    canonicalStore: store,
    receiptStore: new InMemoryDistillationReceiptStore(),
    archive,
    provider: new FixtureProvider(units),
    curationProvider: new ConservativeMemoryCurationProvider("pilot-curation-v4"),
    curationStore,
    admissionPolicy: new DeterministicCanonicalAdmissionPolicy("pilot-admission-v1"),
    governance: new EvidenceBoundMemoryGovernance("pilot-canonicalize-v1"),
  });
}

async function withArchive<T>(
  work: (archive: FilesystemRawExperienceArchiveProvider) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dlmf-semantic-v2-"));
  try {
    return await work(new FilesystemRawExperienceArchiveProvider(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("DLMF-SG-002 routes an opposite Nancy preference to contradiction review", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const receipt = await service(archive, store, curationStore, [
      unit(
        "inline_positive",
        "User requires inline interleaving of Nancy live commentary within the story.",
      ),
      unit(
        "inline_negative",
        "User dislikes inline Nancy live commentary within stories and requires a separate stream section.",
      ),
    ]).run(input("semantic-contradiction"));

    assert.equal(receipt.status, "awaiting_review");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.canonical_merge, 0);
    assert.equal(receipt.curationOutcomes.pending_review, 1);
    assert.equal(receipt.canonicalMemoryIds.length, 1);
    const memoryId = receipt.canonicalMemoryIds[0];
    assert.ok(memoryId);
    assert.equal((await store.getHead(memoryId))?.currentRevision, 1);

    const records = await curationStore.listByReceipt(receipt.receiptId);
    const contradiction = records.find((record) => record.providerUnitRef === "inline_negative");
    assert.equal(contradiction?.semanticRelation, "contradicts");
    assert.equal(contradiction?.outcome, "pending_review");
    assert.equal(contradiction?.candidateId, undefined);
  });
});

test("DLMF-SG-002 merges English and Traditional Chinese concepts and records subsumption", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const receipt = await service(archive, store, curationStore, [
      unit("dark_en", "User prefers dark mode."),
      unit("dark_zh", "用戶偏好深色模式。"),
      unit("dark_detail", "User prefers dark mode on all devices."),
    ]).run(input("multilingual-dark-mode"));

    assert.equal(receipt.status, "complete");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.canonical_merge, 2);
    assert.equal(receipt.canonicalMemoryIds.length, 1);
    const memoryId = receipt.canonicalMemoryIds[0];
    assert.ok(memoryId);
    assert.equal((await store.getHead(memoryId))?.currentRevision, 3);
    const verified = await new CanonicalVerifier(store).verify(memoryId, scope);
    assert.equal(verified.decision, "ALLOW");
    if (verified.decision === "ALLOW") {
      assert.deepEqual(
        verified.revision.provenance.sourceExperienceRefs,
        verified.revision.sourceExperienceRefs,
      );
    }

    const records = await curationStore.listByReceipt(receipt.receiptId);
    assert.equal(
      records.find((record) => record.providerUnitRef === "dark_zh")?.semanticRelation,
      "equivalent",
    );
    assert.equal(
      records.find((record) => record.providerUnitRef === "dark_detail")?.semanticRelation,
      "candidate_subsumes_existing",
    );
  });
});

test("DLMF-SG-002 retries a create collision across independent service instances", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const originalLookup = store.findCurrentRevisionBySemanticKey.bind(store);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.findCurrentRevisionBySemanticKey = async (lookupScope, semanticKey) => {
      const snapshot = await originalLookup(lookupScope, semanticKey);
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
      return snapshot;
    };

    const first = service(archive, store, curationStore, [
      unit("collision_a", "User requires inline Nancy live commentary within the story."),
    ]);
    const second = service(archive, store, curationStore, [
      unit("collision_b", "用戶偏好在故事中直接穿插 Nancy 的直播反應。"),
    ]);
    const receipts = await Promise.all([
      first.run(input("semantic-collision-a")),
      second.run(input("semantic-collision-b")),
    ]);

    assert.equal(
      receipts.reduce((sum, receipt) => sum + receipt.curationOutcomes.canonical_candidate, 0),
      1,
    );
    assert.equal(
      receipts.reduce((sum, receipt) => sum + receipt.curationOutcomes.canonical_merge, 0),
      1,
    );
    const memoryIds = new Set(receipts.flatMap((receipt) => receipt.canonicalMemoryIds));
    assert.equal(memoryIds.size, 1);
    const memoryId = [...memoryIds][0];
    assert.ok(memoryId);
    assert.equal((await store.getHead(memoryId))?.currentRevision, 2);
    assert.equal(
      receipts.some((receipt) =>
        receipt.warnings.some((warning) =>
          warning.startsWith("admission:semantic_identity_collision_retry:"),
        ),
      ),
      true,
    );

    const candidates = await Promise.all(
      receipts.flatMap((receipt) => receipt.candidateIds).map((id) => store.getCandidate(id)),
    );
    assert.equal(candidates.filter((candidate) => candidate?.status === "CONFLICT").length, 1);
    assert.equal(candidates.filter((candidate) => candidate?.status === "ACCEPTED").length, 2);
  });
});

test("DLMF-SG-002 retries concurrent merges and terminates the superseded candidate", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const seed = await service(archive, store, curationStore, [
      unit("merge_seed", "User prefers dark mode."),
    ]).run(input("semantic-merge-seed"));
    const memoryId = seed.canonicalMemoryIds[0];
    assert.ok(memoryId);

    const originalLookup = store.findCurrentRevisionBySemanticKey.bind(store);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.findCurrentRevisionBySemanticKey = async (lookupScope, semanticKey) => {
      const snapshot = await originalLookup(lookupScope, semanticKey);
      if (arrivals < 2) {
        arrivals += 1;
        if (arrivals === 2) release();
        await gate;
      }
      return snapshot;
    };

    const receipts = await Promise.all([
      service(archive, store, curationStore, [
        unit("merge_mobile", "User prefers dark mode on mobile devices."),
      ]).run(input("semantic-merge-race-a")),
      service(archive, store, curationStore, [
        unit("merge_desktop", "User prefers dark mode on desktop devices."),
      ]).run(input("semantic-merge-race-b")),
    ]);

    assert.equal((await store.getHead(memoryId))?.currentRevision, 3);
    assert.equal(
      receipts.some((receipt) => receipt.warnings.some((warning) =>
        warning.startsWith("admission:semantic_revision_collision_retry:"),
      )),
      true,
    );
    const candidates = await Promise.all(
      receipts.flatMap((receipt) => receipt.candidateIds).map((id) => store.getCandidate(id)),
    );
    assert.equal(candidates.filter((candidate) => candidate?.status === "CONFLICT").length, 1);
    assert.equal(candidates.filter((candidate) => candidate?.status === "ACCEPTED").length, 2);
  });
});
