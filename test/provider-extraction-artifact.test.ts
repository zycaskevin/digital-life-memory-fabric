import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConservativeMemoryCurationProvider,
  DeterministicCanonicalAdmissionPolicy,
  EvidenceBoundMemoryGovernance,
  FilesystemProviderExtractionArtifactStore,
  FilesystemRawExperienceArchiveProvider,
  InMemoryCanonicalMemoryStore,
  InMemoryDistillationReceiptStore,
  InMemoryMemoryCurationRecordStore,
  InMemoryProviderExtractionArtifactStore,
  TranscriptDistillationService,
  ValidationError,
  providerExtractionArtifactIdentity,
  type DistillationRequest,
  type DistillationResult,
  type MemoryCurationProvider,
  type MemoryCurationRequest,
  type MemoryDistillationProvider,
  type MemoryScope,
  type RecallRequest,
  type ReflectRequest,
  type ReflectResult,
  type TranscriptDistillationInput,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "tenant_artifact",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

class CountingProvider implements MemoryDistillationProvider {
  readonly name = "fixture-intelligence";
  readonly adapterVersion = "fixture-adapter-v1";
  readonly providerVersion = "fixture-provider-v1";
  calls = 0;

  async distill(request: DistillationRequest): Promise<DistillationResult> {
    this.calls += 1;
    return {
      providerName: this.name,
      providerRunId: `fixture_run_${this.calls}`,
      adapterVersion: this.adapterVersion,
      providerVersion: this.providerVersion,
      providerUnits: [{
        providerUnitRef: "fixture_fact_1",
        candidateType: "fact_candidate",
        memoryClass: "semantic_assertion",
        memoryKind: "fixture_fact",
        proposedContent: { text: "A transient fixture fact." },
        evidenceRefs: [{ sourceType: request.experience.sourceType, sourceRef: request.experience.sourceId }],
        epistemicStatus: "uncertain",
        producer: {
          kind: "provider",
          id: this.name,
          providerName: this.name,
          adapterVersion: this.adapterVersion,
          providerVersion: this.providerVersion,
        },
        sourceExperienceRefs: [{
          sourceType: request.experience.sourceType,
          sourceId: request.experience.sourceId,
          archiveRef: request.experience.archiveRef,
          checksum: request.experience.checksum,
        }],
      }],
      warnings: [],
    };
  }

  async recall(_request: RecallRequest) { return []; }
  async reflect(_request: ReflectRequest): Promise<ReflectResult> {
    return {
      providerName: this.name,
      providerRunId: "fixture_reflect",
      adapterVersion: this.adapterVersion,
      providerVersion: this.providerVersion,
      candidates: [],
      warnings: [],
    };
  }
}

class FailOnceCurator implements MemoryCurationProvider {
  readonly name = "fail-once-curator";
  readonly version = "v1";
  calls = 0;
  readonly #delegate = new ConservativeMemoryCurationProvider(this.version);

  async curate(request: MemoryCurationRequest) {
    this.calls += 1;
    if (this.calls === 1) throw new Error("simulated curation failure after provider extraction");
    const result = await this.#delegate.curate(request);
    return { ...result, providerName: this.name };
  }
}

function input(): TranscriptDistillationInput {
  return {
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
    sourceType: "normalized_experience",
    sourceId: "exp_artifact_retry",
    content: "User: artifact replay must not rerun provider extraction.",
    contentType: "text/plain",
    sourceSegments: [{
      segmentId: "event_1",
      actor: "user",
      content: "artifact replay must not rerun provider extraction",
      observedAt: "2026-09-14T00:00:00.000Z",
    }],
    distillationPolicyVersion: "distill-artifact-v1",
    canonicalizationPolicyVersion: "canonical-artifact-v1",
    admissionPolicyVersion: "admission-artifact-v1",
    retentionPolicyVersion: "retention-artifact-v1",
  };
}

async function withRoot<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dlmf-provider-artifact-"));
  try { return await work(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("provider extraction artifact makes downstream retry replay provider output instead of rerunning intelligence", async () => {
  await withRoot(async (root) => {
    const provider = new CountingProvider();
    const curator = new FailOnceCurator();
    const artifacts = new InMemoryProviderExtractionArtifactStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const service = new TranscriptDistillationService({
      canonicalStore: new InMemoryCanonicalMemoryStore(),
      receiptStore: receipts,
      archive: new FilesystemRawExperienceArchiveProvider(join(root, "raw")),
      provider,
      providerExtractionArtifactStore: artifacts,
      curationProvider: curator,
      curationStore: new InMemoryMemoryCurationRecordStore(),
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-artifact-v1"),
      governance: new EvidenceBoundMemoryGovernance("canonical-artifact-v1"),
    });

    const first = await service.run(input());
    assert.equal(first.status, "failed");
    assert.equal(first.errors.at(-1)?.stage, "curation");
    assert.equal(provider.calls, 1);
    assert.ok(first.providerExtractionRef);
    assert.match(first.providerExtractionChecksum ?? "", /^sha256:[0-9a-f]{64}$/);

    const second = await service.run(input());
    assert.equal(second.status, "complete");
    assert.equal(second.canonicalizationOutcome, "no_memory_worthy_content");
    assert.equal(provider.calls, 1);
    assert.equal(curator.calls, 2);
    assert.equal(second.providerExtractionRef, first.providerExtractionRef);
    assert.equal(second.providerExtractionChecksum, first.providerExtractionChecksum);
    assert.equal(second.providerRunId, first.providerRunId);
    assert.equal(await artifacts.verify(
      second.providerExtractionRef!,
      second.providerExtractionChecksum!,
    ), true);
  });
});

test("filesystem provider extraction artifacts are immutable and collision-safe", async () => {
  await withRoot(async (root) => {
    const store = new FilesystemProviderExtractionArtifactStore(root);
    const provider = new CountingProvider();
    const experience = {
      scope,
      sourceType: "normalized_experience",
      sourceId: "exp_filesystem_artifact",
      content: "same archived experience",
      contentType: "text/plain",
      archiveRef: "filesystem://fixture/raw.json",
      checksum: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceSegments: [{ segmentId: "event_1", actor: "user" as const, content: "same archived experience" }],
    };
    const identity = providerExtractionArtifactIdentity(experience, provider, "distill-artifact-v1");
    const result = await provider.distill({
      experience,
      distillationPolicyVersion: "distill-artifact-v1",
      requestedAt: "2026-09-14T00:00:00.000Z",
    });
    const first = await store.put({ identity, result, createdAt: "2026-09-14T00:00:00.000Z" });
    const replay = await store.put({ identity, result, createdAt: "2026-09-14T01:00:00.000Z" });
    assert.equal(replay.artifactRef, first.artifactRef);
    assert.equal(replay.checksum, first.checksum);
    assert.equal(replay.createdAt, first.createdAt);
    assert.deepEqual((await store.get(identity))?.result, result);
    assert.equal(await store.verify(first.artifactRef, first.checksum), true);

    const changed: DistillationResult = {
      ...result,
      providerRunId: "different_run",
    };
    await assert.rejects(
      store.put({ identity, result: changed }),
      (error: unknown) => error instanceof ValidationError
        && /identity collision/.test(error.message),
    );
  });
});
