import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConservativeMemoryCurationProvider,
  DeterministicCanonicalAdmissionPolicy,
  EvidenceBoundMemoryGovernance,
  FilesystemRawExperienceArchiveProvider,
  InMemoryCanonicalMemoryStore,
  InMemoryDistillationReceiptStore,
  InMemoryMemoryCurationRecordStore,
  SyntheticExplorationEvidenceAdapter,
  TranscriptDistillationService,
  type MemoryScope,
  type TranscriptDistillationInput,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "tenant-ardo-ae",
  lifeDid: "did:arthurverse:ardo-ae-test",
  memoryNamespace: "life.ardo-ae",
};

function input(origin = "SYNTHETIC"): TranscriptDistillationInput {
  return {
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "agent-factory", runtimeId: "hermes" },
    sourceType: "autonomous_exploration",
    sourceId: "ardo-ae:test",
    content: "A bounded agent-generated research synthesis with explicit provenance.",
    contentType: "text/plain; profile=autonomous-exploration",
    createdAt: "2026-09-17T00:00:00.000Z",
    observedAt: "2026-09-17T00:00:00.000Z",
    metadata: { origin },
    distillationPolicyVersion: "test-distill-v1",
    canonicalizationPolicyVersion: "test-canonical-v1",
    admissionPolicyVersion: "test-admission-v1",
    retentionPolicyVersion: "test-retention-v1",
  };
}

test("synthetic exploration extraction remains supporting evidence, not canonical memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-synthetic-exploration-"));
  try {
    const service = new TranscriptDistillationService({
      canonicalStore: new InMemoryCanonicalMemoryStore(),
      receiptStore: new InMemoryDistillationReceiptStore(),
      archive: new FilesystemRawExperienceArchiveProvider(root),
      provider: new SyntheticExplorationEvidenceAdapter(),
      curationProvider: new ConservativeMemoryCurationProvider("test-curation-v1"),
      curationStore: new InMemoryMemoryCurationRecordStore(),
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("test-admission-v1"),
      governance: new EvidenceBoundMemoryGovernance("test-canonical-v1"),
    });
    const receipt = await service.run(input());
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.providerUnitCount, 1);
    assert.equal(receipt.curationOutcomes.supporting_evidence_only, 1);
    assert.equal(receipt.admissionComplete, true);
    assert.equal(receipt.canonicalizationOutcome, "no_memory_worthy_content");
    assert.deepEqual(receipt.canonicalMemoryIds, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic exploration adapter rejects non-synthetic or unrelated sources", async () => {
  const adapter = new SyntheticExplorationEvidenceAdapter();
  const archived = {
    ...input("REAL"),
    archiveRef: "filesystem://fixture.json",
    checksum: "sha256:fixture",
  };
  await assert.rejects(
    adapter.distill({ experience: archived, distillationPolicyVersion: "test-distill-v1", requestedAt: "2026-09-17T00:00:00.000Z" }),
    /requires SYNTHETIC provenance/u,
  );
  await assert.rejects(
    adapter.distill({
      experience: { ...archived, sourceType: "hermes_session", metadata: { origin: "SYNTHETIC" } },
      distillationPolicyVersion: "test-distill-v1",
      requestedAt: "2026-09-17T00:00:00.000Z",
    }),
    /accepts autonomous_exploration only/u,
  );
});
