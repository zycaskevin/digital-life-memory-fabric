import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CanonicalMemoryAuthority,
  ConservativeMemoryCurationProvider,
  DeterministicCanonicalAdmissionPolicy,
  EvidenceBoundMemoryGovernance,
  FilesystemRawExperienceArchiveProvider,
  HindsightMemoryAdapter,
  InMemoryCanonicalMemoryStore,
  InMemoryDistillationReceiptStore,
  InMemoryMemoryCurationRecordStore,
  MemoryCandidateService,
  PreservationCompleteRetentionPolicy,
  PruneEligibilityService,
  ReflectiveMemoryService,
  TranscriptDistillationService,
  ValidationError,
  type HindsightClientPort,
  type HindsightRecallResponse,
  type HindsightListMemoriesResponse,
  type HindsightReflectResponse,
  type HindsightRetainResponse,
  type MemoryCurationProposal,
  type MemoryCurationProvider,
  type MemoryDistillationProvider,
  type MemoryScope,
  type ReflectResult,
  type TranscriptDistillationInput,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "tenant_md",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

class FakeHindsightClient implements HindsightClientPort {
  readonly retainCalls: Array<{
    bankId: string;
    content: string;
    options: Parameters<HindsightClientPort["retain"]>[2];
  }> = [];
  readonly listMemoriesCalls: Array<{
    bankId: string;
    options: Parameters<HindsightClientPort["listMemories"]>[1];
  }> = [];
  readonly recallCalls: Array<{
    bankId: string;
    query: string;
    options: Parameters<HindsightClientPort["recall"]>[2];
  }> = [];
  readonly reflectCalls: Array<{
    bankId: string;
    query: string;
    options: Parameters<HindsightClientPort["reflect"]>[2];
  }> = [];

  recallResponse: HindsightRecallResponse = { results: [] };
  listMemoriesResponse: HindsightListMemoriesResponse = { items: [], total: 0, limit: 1000, offset: 0 };
  reflectResponse: HindsightReflectResponse = { text: "" };
  retainResponse: HindsightRetainResponse | undefined;
  retainFailure?: Error;

  async retain(
    bankId: string,
    content: string,
    options?: Parameters<HindsightClientPort["retain"]>[2],
  ): Promise<HindsightRetainResponse> {
    this.retainCalls.push({ bankId, content, options });
    if (this.retainFailure !== undefined) throw this.retainFailure;
    return this.retainResponse ?? { success: true, bank_id: bankId, items_count: 1, async: false };
  }

  async listMemories(
    bankId: string,
    options?: Parameters<HindsightClientPort["listMemories"]>[1],
  ) {
    this.listMemoriesCalls.push({ bankId, options });
    const documentId = options?.documentId;
    const all = this.listMemoriesResponse.items.filter((item) =>
      documentId === undefined ? true : item.document_id === documentId,
    );
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;
    return {
      items: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      offset,
    };
  }

  async recall(
    bankId: string,
    query: string,
    options?: Parameters<HindsightClientPort["recall"]>[2],
  ): Promise<HindsightRecallResponse> {
    this.recallCalls.push({ bankId, query, options });
    return structuredClone(this.recallResponse);
  }

  async reflect(
    bankId: string,
    query: string,
    options?: Parameters<HindsightClientPort["reflect"]>[2],
  ): Promise<HindsightReflectResponse> {
    this.reflectCalls.push({ bankId, query, options });
    return structuredClone(this.reflectResponse);
  }
}

function createAdapter(client: FakeHindsightClient): HindsightMemoryAdapter {
  return new HindsightMemoryAdapter({
    client,
    adapterVersion: "hindsight-adapter-v0.1.1",
    providerVersion: "test-provider",
    banks: {
      distillationBankId: () => "nancy:distillation",
      projectionBankId: () => "nancy:canonical-projection",
    },
  });
}

function curationComponents() {
  return {
    curationProvider: new ConservativeMemoryCurationProvider("test-curation-v1"),
    curationStore: new InMemoryMemoryCurationRecordStore(),
    admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-v1"),
  };
}

function customCurator(
  name: string,
  proposalFor: (providerUnitRef: string) => MemoryCurationProposal,
): MemoryCurationProvider {
  return {
    name,
    version: "1",
    async curate(request) {
      return {
        providerName: name,
        providerVersion: "1",
        proposals: request.units.map((unit) => proposalFor(unit.providerUnitRef)),
        warnings: [],
      };
    },
  };
}

function transcriptInput(
  sourceId: string,
  policy = "distill-v1",
): TranscriptDistillationInput {
  return {
    scope,
    origin: {
      lifeDid: scope.lifeDid,
      agentId: "nancy",
      runtimeId: "hermes-gb10",
      deviceId: "gb10",
    },
    sourceType: "hermes_session",
    sourceId,
    content: "User: I prefer small-step technical debugging.\nAssistant: Understood.",
    contentType: "text/plain; profile=hermes-transcript",
    observedAt: "2026-09-03T02:00:00.000Z",
    distillationPolicyVersion: policy,
    canonicalizationPolicyVersion: "canonicalize-v1",
    admissionPolicyVersion: "admission-v1",
    retentionPolicyVersion: "retention-v1",
  };
}

function setSinglePreferenceResult(
  client: FakeHindsightClient,
  sourceId: string,
  providerId = "hs_fact_1",
): void {
  client.listMemoriesResponse = {
    items: [
      {
        id: providerId,
        bank_id: "nancy:distillation",
        text: "Arthur prefers small-step technical debugging.",
        type: "world",
        document_id: `hermes_session:${sourceId}`,
        occurred_start: "2026-09-03T02:00:00.000Z",
        metadata: {
          dlmf_candidate_type: "preference_candidate",
          dlmf_memory_class: "preference",
          dlmf_memory_kind: "debugging_style",
          dlmf_epistemic_status: "user_asserted",
          dlmf_confidence: "0.96",
        },
      },
    ],
    total: 1,
    limit: 1000,
    offset: 0,
  };
}

async function withArchive<T>(
  work: (archive: FilesystemRawExperienceArchiveProvider) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dlfm-memory-distillation-"));
  try {
    return await work(new FilesystemRawExperienceArchiveProvider(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("MD-001/002/003: provider output stays candidate-only and epistemic/provenance are explicit", async () => {
  await withArchive(async (archive) => {
    const client = new FakeHindsightClient();
    const sourceId = "session-contract";
    setSinglePreferenceResult(client, sourceId);
    const adapter = createAdapter(client);
    const archived = await archive.archive({
      scope,
      sourceType: "hermes_session",
      sourceId,
      content: "Arthur: use small-step debugging.",
      contentType: "text/plain",
    });

    const result = await adapter.distill({
      experience: {
        scope,
        sourceType: archived.sourceType,
        sourceId: archived.sourceId,
        content: archived.content,
        contentType: archived.contentType,
        archiveRef: archived.archiveRef,
        checksum: archived.checksum,
      },
      distillationPolicyVersion: "distill-v1",
      requestedAt: "2026-09-03T02:01:00.000Z",
    });

    assert.equal(result.providerName, "hindsight");
    assert.equal(result.providerUnits.length, 1);
    const draft = result.providerUnits[0];
    assert.ok(draft);
    assert.equal(draft.epistemicStatus, "user_asserted");
    assert.equal(draft.producer.providerName, "hindsight");
    assert.equal(draft.sourceExperienceRefs[0]?.archiveRef, archived.archiveRef);
    assert.equal("candidateId" in draft, false);
    assert.equal("memoryId" in draft, false);
    assert.equal(
      (draft.proposedContent.payload as Record<string, unknown> | undefined)?.hindsightSourceId,
      undefined,
    );
    assert.equal(client.retainCalls[0]?.bankId, "nancy:distillation");
  });
});

test("MD-004: Hindsight adapter enforces distinct distillation and canonical projection planes", async () => {
  const client = new FakeHindsightClient();
  const adapter = new HindsightMemoryAdapter({
    client,
    adapterVersion: "test",
    banks: {
      distillationBankId: () => "same-bank",
      projectionBankId: () => "same-bank",
    },
  });

  await assert.rejects(
    adapter.recall({
      scope,
      query: "test",
      requestedAt: "2026-09-03T02:00:00.000Z",
    }),
    ValidationError,
  );
  assert.equal(client.recallCalls.length, 0);
});

test("MD-010 remediation: role-aware user projection preserves direct assertions without trusting mixed transcript synthesis", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-role-aware";
    const documentId = `hermes_session:${sourceId}`;
    const userDocumentId = `${documentId}:source-actor:user`;
    client.listMemoriesResponse = {
      items: [
        {
          id: "hs-mixed-synthesis",
          bank_id: "nancy:distillation",
          text: "The conversation covered interface design and implementation sequencing.",
          type: "world",
          document_id: documentId,
        },
        {
          id: "hs-user-preference",
          bank_id: "nancy:distillation",
          text: "Arthur prefers dark mode.",
          type: "world",
          document_id: userDocumentId,
          metadata: {
            dlmf_projection_kind: "source_actor",
            dlmf_source_actor: "user",
            dlmf_epistemic_status: "user_asserted",
          },
        },
        {
          id: "hs-user-observation",
          bank_id: "nancy:distillation",
          text: "Arthur often asks for incremental debugging steps.",
          type: "observation",
          document_id: userDocumentId,
          metadata: {
            dlmf_projection_kind: "source_actor",
            dlmf_source_actor: "user",
            dlmf_epistemic_status: "user_asserted",
          },
        },
      ],
      total: 3,
      limit: 1000,
      offset: 0,
    };

    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      curationProvider: new ConservativeMemoryCurationProvider("test-curation-role-aware-v2"),
      curationStore,
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-v1"),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });
    const input = transcriptInput(sourceId, "distill-role-aware-v2");
    input.sourceSegments = [
      {
        segmentId: "hermes_message:1",
        actor: "user",
        content: "I prefer dark mode.",
        observedAt: "2026-09-03T02:00:00.000Z",
      },
      {
        segmentId: "hermes_message:2",
        actor: "assistant",
        content: "I can configure that for you.",
        observedAt: "2026-09-03T02:00:01.000Z",
      },
    ];

    const receipt = await service.run(input);
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.admissionComplete, true);
    assert.equal(receipt.providerUnitCount, 3);
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.supporting_evidence_only, 2);
    assert.equal(receipt.curationOutcomes.pending_review, 0);
    assert.equal(receipt.candidateIds.length, 1);
    assert.equal(receipt.canonicalMemoryIds.length, 1);

    assert.equal(client.retainCalls.length, 2);
    assert.equal(client.retainCalls[0]?.options?.documentId, documentId);
    assert.equal(client.retainCalls[1]?.options?.documentId, userDocumentId);
    assert.match(client.retainCalls[1]?.content ?? "", /I prefer dark mode/);
    assert.doesNotMatch(client.retainCalls[1]?.content ?? "", /configure that for you/);
    assert.equal(client.retainCalls[1]?.options?.metadata?.dlmf_source_actor, "user");
    assert.equal(client.retainCalls[1]?.options?.metadata?.dlmf_epistemic_status, "user_asserted");
    assert.equal(client.listMemoriesCalls.length, 2);
    assert.equal(client.recallCalls.length, 0);

    const records = await curationStore.listByReceipt(receipt.receiptId);
    const direct = records.find((record) => record.providerUnitRef === "hs-user-preference");
    const observation = records.find((record) => record.providerUnitRef === "hs-user-observation");
    const mixed = records.find((record) => record.providerUnitRef === "hs-mixed-synthesis");
    assert.equal(direct?.providerEpistemicStatus, "user_asserted");
    assert.equal(direct?.outcome, "canonical_candidate");
    assert.equal(observation?.providerEpistemicStatus, "synthesized");
    assert.equal(observation?.outcome, "supporting_evidence_only");
    assert.equal(mixed?.providerEpistemicStatus, "synthesized");
    assert.equal(mixed?.outcome, "supporting_evidence_only");
  });
});

test("MD-004 regression: long transcript distillation never uses recall query", async () => {
  await withArchive(async (archive) => {
    const client = new FakeHindsightClient();
    const sourceId = "session-long-document";
    const documentId = `hermes_session:${sourceId}`;
    const longTranscript = Array.from({ length: 3000 }, (_, i) => `turn-${i} preference and project detail`).join(" ");
    client.listMemoriesResponse = {
      items: [
        {
          id: "hs-long-1",
          bank_id: "nancy:distillation",
          text: "Arthur prefers bounded document-scoped distillation.",
          type: "world",
          document_id: documentId,
          metadata: { dlmf_epistemic_status: "synthesized" },
        },
      ],
      total: 1,
      limit: 1000,
      offset: 0,
    };
    const archived = await archive.archive({
      scope,
      sourceType: "hermes_session",
      sourceId,
      content: longTranscript,
      contentType: "text/plain",
    });
    const result = await createAdapter(client).distill({
      experience: {
        scope,
        sourceType: archived.sourceType,
        sourceId: archived.sourceId,
        content: archived.content,
        contentType: archived.contentType,
        archiveRef: archived.archiveRef,
        checksum: archived.checksum,
      },
      distillationPolicyVersion: "distill-v1",
      requestedAt: "2026-09-03T02:01:00.000Z",
    });

    assert.equal(result.providerUnits.length, 1);
    assert.equal(client.recallCalls.length, 0, "distillation must never send the transcript to recall");
    assert.equal(client.listMemoriesCalls.length, 1);
    assert.equal(client.listMemoriesCalls[0]?.options?.documentId, documentId);
    assert.equal(client.listMemoriesCalls[0]?.options?.state, "valid");
  });
});

test("MD-004 document enumeration paginates without recall", async () => {
  await withArchive(async (archive) => {
    const client = new FakeHindsightClient();
    const sourceId = "session-pagination";
    const documentId = `hermes_session:${sourceId}`;
    client.listMemoriesResponse = {
      items: Array.from({ length: 1001 }, (_, index) => ({
        id: `hs-page-${index}`,
        bank_id: "nancy:distillation",
        text: `memory unit ${index}`,
        type: "world",
        document_id: documentId,
      })),
      total: 1001,
      limit: 1000,
      offset: 0,
    };
    const archived = await archive.archive({
      scope,
      sourceType: "hermes_session",
      sourceId,
      content: "bounded source",
      contentType: "text/plain",
    });
    const result = await createAdapter(client).distill({
      experience: {
        scope,
        sourceType: archived.sourceType,
        sourceId: archived.sourceId,
        content: archived.content,
        contentType: archived.contentType,
        archiveRef: archived.archiveRef,
        checksum: archived.checksum,
      },
      distillationPolicyVersion: "distill-v1",
      requestedAt: "2026-09-03T02:01:00.000Z",
    });

    assert.equal(result.providerUnits.length, 1001);
    assert.equal(client.listMemoriesCalls.length, 2);
    assert.equal(client.listMemoriesCalls[0]?.options?.offset, 0);
    assert.equal(client.listMemoriesCalls[1]?.options?.offset, 1000);
    assert.equal(client.recallCalls.length, 0);
  });
});

test("MD-004 hardening: asynchronous Hindsight retain cannot produce a completed distillation", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const client = new FakeHindsightClient();
    client.retainResponse = {
      success: true,
      bank_id: "nancy:distillation",
      items_count: 1,
      async: true,
    };
    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      ...curationComponents(),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });

    const receipt = await service.run(transcriptInput("session-async-retain"));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.errors.at(-1)?.stage, "provider");
    assert.equal(receipt.pruneEligible, false);
    assert.equal((await store.listChangesAfter(scope, 0)).length, 0);
  });
});

test("MD-005 policy version is bound to the actual canonical governance policy", async () => {
  await withArchive(async (archive) => {
    const client = new FakeHindsightClient();
    const service = new TranscriptDistillationService({
      canonicalStore: new InMemoryCanonicalMemoryStore(),
      receiptStore: new InMemoryDistillationReceiptStore(),
      archive,
      provider: createAdapter(client),
      ...curationComponents(),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v2"),
    });

    await assert.rejects(
      service.run(transcriptInput("session-policy-mismatch")),
      /does not match governance policy/,
    );
    assert.equal(client.retainCalls.length, 0);
  });
});

test("MD-005/006/007: Hermes transcript archives, distills, governs and commits with durable receipt", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-e2e";
    setSinglePreferenceResult(client, sourceId);
    const adapter = createAdapter(client);
    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: adapter,
      ...curationComponents(),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });

    const first = await service.run(transcriptInput(sourceId));
    assert.equal(first.status, "complete");
    assert.equal(first.canonicalizationOutcome, "committed");
    assert.equal(first.candidateIds.length, 1);
    assert.equal(first.canonicalMemoryIds.length, 1);
    assert.equal(first.pruneEligible, false);
    assert.ok(first.rawArchiveRef);
    assert.ok(first.rawArchiveChecksum);
    assert.equal(
      await archive.verify(first.rawArchiveRef, first.rawArchiveChecksum),
      true,
    );

    const memoryId = first.canonicalMemoryIds[0];
    assert.ok(memoryId);
    const head = await store.getHead(memoryId);
    assert.ok(head);
    const revision = await store.getRevision(memoryId, head.currentRevision);
    assert.ok(revision);
    assert.equal(revision.canonicalContent.text, "Arthur prefers small-step technical debugging.");
    assert.equal(revision.epistemicStatus, "user_asserted");
    assert.equal(revision.producer.providerName, "hindsight");
    assert.equal(revision.provenance.candidateFingerprint, revision.semanticFingerprint);
    assert.equal(revision.provenance.canonicalAdmission?.admissionPolicyVersion, "admission-v1");
    assert.equal(revision.provenance.canonicalAdmission?.curationProvider, "dlmf-conservative-curation");
    assert.equal(revision.provenance.canonicalAdmission?.outcome, "canonical_candidate");
    assert.match(revision.provenance.canonicalAdmission?.curationRecordId ?? "", /^cur_/);
    assert.equal(revision.sourceExperienceRefs[0]?.archiveRef, first.rawArchiveRef);
    assert.equal(revision.evidenceRefs.some((ref) => ref.sourceRef === "hs_fact_1"), true);

    const retry = await service.run(transcriptInput(sourceId));
    assert.equal(retry.receiptId, first.receiptId);
    assert.equal(retry.canonicalMemoryIds[0], memoryId);
    assert.equal(client.retainCalls.length, 1, "completed receipt must make retry idempotent");
  });
});

test("MD-005 idempotency: concurrent processing of the same source cannot create duplicate canonical memory", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-concurrent";
    setSinglePreferenceResult(client, sourceId);
    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      ...curationComponents(),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });

    const [left, right] = await Promise.all([
      service.run(transcriptInput(sourceId)),
      service.run(transcriptInput(sourceId)),
    ]);
    assert.equal(left.receiptId, right.receiptId);
    assert.equal((await store.listChangesAfter(scope, 0)).length, 1);
    const persisted = await receipts.getLatestBySource(scope, "hermes_session", sourceId);
    assert.equal(persisted?.status, "complete");
    assert.equal(persisted?.canonicalizationOutcome, "committed");
    assert.equal(persisted?.canonicalMemoryIds.length, 1);
  });
});

test("MD-005/009 + INV-9: zero-memory distillation can complete and become prune-eligible", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const client = new FakeHindsightClient();
    const adapter = createAdapter(client);
    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: adapter,
      ...curationComponents(),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });
    const sourceId = "session-no-memory";
    const receipt = await service.run(transcriptInput(sourceId));

    assert.equal(receipt.status, "complete");
    assert.equal(receipt.canonicalizationOutcome, "no_memory_worthy_content");
    assert.deepEqual(receipt.candidateIds, []);
    assert.deepEqual(receipt.canonicalMemoryIds, []);

    const eligibility = new PruneEligibilityService(
      receipts,
      archive,
      new PreservationCompleteRetentionPolicy("retention-v1", "admission-v1"),
    );
    const decision = await eligibility.refresh(scope, "hermes_session", sourceId);
    assert.equal(decision.eligible, true);
    assert.equal(decision.archiveVerified, true);
    assert.deepEqual(decision.blockingReasons, []);

    const persisted = await receipts.getLatestBySource(scope, "hermes_session", sourceId);
    assert.equal(persisted?.pruneEligible, true);
    assert.equal(persisted?.retentionState, "prune_eligible");
  });
});

test("MD-005/020 failure model: provider failure leaves canonical state unchanged and blocks prune", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const client = new FakeHindsightClient();
    client.retainFailure = new Error("Hindsight unavailable");
    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      ...curationComponents(),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });
    const sourceId = "session-provider-failure";
    const receipt = await service.run(transcriptInput(sourceId));

    assert.equal(receipt.status, "failed");
    assert.equal(receipt.errors.at(-1)?.stage, "provider");
    assert.equal(receipt.candidateIds.length, 0);
    assert.equal(receipt.canonicalMemoryIds.length, 0);
    assert.ok(receipt.rawArchiveRef, "raw experience remains archived before provider call");
    assert.equal((await store.listChangesAfter(scope, 0)).length, 0);

    const decision = await new PruneEligibilityService(
      receipts,
      archive,
      new PreservationCompleteRetentionPolicy("retention-v1", "admission-v1"),
    ).evaluate(scope, "hermes_session", sourceId);
    assert.equal(decision.eligible, false);
    assert.equal(decision.blockingReasons.some((reason) => reason.includes("failed")), true);
  });
});

test("MD-010 authority invariant: provider candidates cannot bypass canonical admission", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  const candidates = new MemoryCandidateService(store);
  const authority = new CanonicalMemoryAuthority(store);

  const unadmitted = await candidates.ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
    candidateType: "preference_candidate",
    sourceType: "provider_test",
    sourceId: "provider-direct-bypass",
    memoryClass: "preference",
    memoryKind: "debugging_style",
    proposedContent: { text: "Arthur prefers small-step debugging." },
    evidenceRefs: [{ sourceType: "provider_test", sourceRef: "evidence-1" }],
    epistemicStatus: "user_asserted",
    producer: { kind: "provider", id: "malicious-provider", providerName: "malicious" },
    sourceExperienceRefs: [{ sourceType: "provider_test", sourceId: "provider-direct-bypass" }],
    proposedOperation: "create",
  });

  await assert.rejects(
    authority.commit({
      candidateId: unadmitted.candidateId,
      idempotencyKey: "provider-direct-bypass-commit",
    }),
    /requires canonical admission proof/,
  );
  assert.equal((await store.getCandidate(unadmitted.candidateId))?.status, "PENDING");
  assert.equal((await store.listChangesAfter(scope, 0)).length, 0);

  const forgedDirect = await candidates.ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
    candidateType: "preference_candidate",
    sourceType: "provider_test",
    sourceId: "provider-forged-direct-proof",
    memoryClass: "preference",
    memoryKind: "debugging_style",
    proposedContent: { text: "Arthur prefers small-step debugging." },
    evidenceRefs: [{ sourceType: "provider_test", sourceRef: "evidence-direct" }],
    epistemicStatus: "user_asserted",
    producer: { kind: "provider", id: "malicious-provider", providerName: "malicious" },
    sourceExperienceRefs: [{ sourceType: "provider_test", sourceId: "provider-forged-direct-proof" }],
    providerRunId: "forged-run",
    canonicalAdmission: {
      admissionPolicyVersion: "admission-v1",
      curationProvider: "forged-curator",
      curationRecordId: "cur_forged_direct",
      outcome: "canonical_candidate",
    },
    proposedOperation: "create",
  });
  const verifiedAuthority = new CanonicalMemoryAuthority(
    store,
    undefined,
    undefined,
    new InMemoryMemoryCurationRecordStore(),
  );
  await assert.rejects(
    verifiedAuthority.commit({
      candidateId: forgedDirect.candidateId,
      idempotencyKey: "provider-forged-direct-proof-commit",
    }),
    /not backed by an admitted curation record/,
  );
  assert.equal((await store.getCandidate(forgedDirect.candidateId))?.status, "PENDING");
  assert.equal((await store.listChangesAfter(scope, 0)).length, 0);

  const forgedDerived = await candidates.ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
    candidateType: "fact_candidate",
    sourceType: "provider_test",
    sourceId: "provider-forged-proof",
    memoryClass: "semantic_assertion",
    memoryKind: "derived_claim",
    proposedContent: { text: "A synthesized claim pretending to be admitted." },
    evidenceRefs: [{ sourceType: "provider_test", sourceRef: "evidence-2" }],
    epistemicStatus: "synthesized",
    producer: { kind: "provider", id: "malicious-provider", providerName: "malicious" },
    sourceExperienceRefs: [{ sourceType: "provider_test", sourceId: "provider-forged-proof" }],
    canonicalAdmission: {
      admissionPolicyVersion: "admission-v1",
      curationProvider: "forged-curator",
      curationRecordId: "cur_forged",
      outcome: "canonical_candidate",
    },
    proposedOperation: "create",
  });

  await assert.rejects(
    authority.commit({
      candidateId: forgedDerived.candidateId,
      idempotencyKey: "provider-forged-proof-commit",
    }),
    /requires explicit review and cannot auto-commit/,
  );
  assert.equal((await store.getCandidate(forgedDerived.candidateId))?.status, "PENDING");
  assert.equal((await store.listChangesAfter(scope, 0)).length, 0);
});

test("MD-010: synthesized provider units terminate as supporting evidence without canonicalizing", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-synthesized-review";
    setSinglePreferenceResult(client, sourceId);
    const unit = client.listMemoriesResponse.items[0];
    assert.ok(unit);
    unit.metadata = {
      ...unit.metadata,
      dlmf_epistemic_status: "synthesized",
    };

    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      curationProvider: new ConservativeMemoryCurationProvider("test-curation-v1"),
      curationStore,
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-v1"),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });

    const receipt = await service.run(transcriptInput(sourceId));
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.canonicalizationOutcome, "no_memory_worthy_content");
    assert.equal(receipt.providerUnitCount, 1);
    assert.equal(receipt.curationDecisionCount, 1);
    assert.equal(receipt.curationCoverageComplete, true);
    assert.equal(receipt.admissionComplete, true);
    assert.equal(receipt.curationOutcomes.supporting_evidence_only, 1);
    assert.equal(receipt.curationOutcomes.pending_review, 0);
    assert.deepEqual(receipt.candidateIds, []);
    assert.deepEqual(receipt.canonicalMemoryIds, []);
    assert.equal((await store.listChangesAfter(scope, 0)).length, 0);

    const records = await curationStore.listByReceipt(receipt.receiptId);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.outcome, "supporting_evidence_only");
    assert.equal(records[0]?.attributedEpistemicStatus, "synthesized");
    assert.equal(records[0]?.memoryWorthy, false);

    const prune = await new PruneEligibilityService(
      receipts,
      archive,
      new PreservationCompleteRetentionPolicy("retention-v1", "admission-v1"),
    ).evaluate(scope, "hermes_session", sourceId);
    assert.equal(prune.eligible, true);
    assert.deepEqual(prune.blockingReasons, []);
  });
});

test("MD-010: direct epistemic status still requires memory-worthiness and durability", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-transient-event";
    client.listMemoriesResponse = {
      items: [
        {
          id: "hs-transient-event",
          bank_id: "nancy:distillation",
          text: "The user opened the settings screen during this session.",
          type: "experience",
          document_id: `hermes_session:${sourceId}`,
          metadata: {
            dlmf_candidate_type: "event_candidate",
            dlmf_memory_class: "episode",
            dlmf_memory_kind: "session_ui_event",
            dlmf_epistemic_status: "system_observed",
          },
        },
      ],
      total: 1,
      limit: 1000,
      offset: 0,
    };

    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      curationProvider: new ConservativeMemoryCurationProvider("test-curation-v1"),
      curationStore,
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-v1"),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });

    const receipt = await service.run(transcriptInput(sourceId));
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.admissionComplete, true);
    assert.equal(receipt.curationOutcomes.supporting_evidence_only, 1);
    assert.deepEqual(receipt.candidateIds, []);
    assert.deepEqual(receipt.canonicalMemoryIds, []);
    assert.equal((await store.listChangesAfter(scope, 0)).length, 0);
    assert.equal((await curationStore.listByReceipt(receipt.receiptId))[0]?.durability, "transient");
  });
});

test("MD-010: curation provider cannot upgrade synthesized evidence into user-asserted truth", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-malicious-curator";
    setSinglePreferenceResult(client, sourceId);
    const unit = client.listMemoriesResponse.items[0];
    assert.ok(unit);
    unit.metadata = {
      ...unit.metadata,
      dlmf_epistemic_status: "synthesized",
    };

    const maliciousCurator: MemoryCurationProvider = {
      name: "malicious-curator",
      version: "1",
      async curate(request) {
        return {
          providerName: "malicious-curator",
          providerVersion: "1",
          proposals: request.units.map((providerUnit) => ({
            providerUnitRef: providerUnit.providerUnitRef,
            outcome: "canonical_candidate" as const,
            epistemicAttribution: {
              status: "user_asserted" as const,
              basis: "direct_source_quote" as const,
              evidenceQuote: "I prefer small-step technical debugging.",
            },
            memoryWorthy: true,
            durability: "durable" as const,
            semanticDisposition: "novel" as const,
            reasonCodes: ["malicious_upgrade_attempt"],
          })),
          warnings: [],
        };
      },
    };
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      curationProvider: maliciousCurator,
      curationStore,
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-v1"),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });

    const receipt = await service.run(transcriptInput(sourceId));
    assert.equal(receipt.status, "awaiting_review");
    assert.equal(receipt.admissionComplete, false);
    assert.deepEqual(receipt.canonicalMemoryIds, []);
    assert.equal((await store.listChangesAfter(scope, 0)).length, 0);
    const record = (await curationStore.listByReceipt(receipt.receiptId))[0];
    assert.equal(record?.outcome, "pending_review");
    assert.equal(record?.attributedEpistemicStatus, "uncertain");
    assert.equal(
      record?.reasonCodes.includes("admission:epistemic_attribution_not_grounded"),
      true,
    );
  });
});

test("MD-010: curator rewrites cannot silently become canonical truth", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-curator-rewrite";
    setSinglePreferenceResult(client, sourceId);

    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      curationProvider: customCurator("rewrite-curator", (providerUnitRef) => ({
        providerUnitRef,
        outcome: "canonical_candidate",
        epistemicAttribution: {
          status: "user_asserted",
          basis: "provider_declared",
        },
        memoryWorthy: true,
        durability: "durable",
        semanticDisposition: "novel",
        reasonCodes: ["rewrite_attempt"],
        curatedCandidate: {
          candidateType: "preference_candidate",
          memoryClass: "preference",
          memoryKind: "debugging_style",
          proposedContent: {
            text: "Arthur always requires one-step-at-a-time debugging.",
          },
        },
      })),
      curationStore,
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-v1"),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });

    const receipt = await service.run(transcriptInput(sourceId));
    assert.equal(receipt.status, "awaiting_review");
    assert.equal(receipt.curationOutcomes.pending_review, 1);
    assert.deepEqual(receipt.candidateIds, []);
    assert.deepEqual(receipt.canonicalMemoryIds, []);
    assert.equal((await store.listChangesAfter(scope, 0)).length, 0);
    const record = (await curationStore.listByReceipt(receipt.receiptId))[0];
    assert.equal(record?.outcome, "pending_review");
    assert.equal(record?.reasonCodes.includes("admission:curated_rewrite_requires_review"), true);
  });
});

test("MD-010: semantic merge proposals require review instead of automatic merge", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-merge-review";
    setSinglePreferenceResult(client, sourceId);

    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      curationProvider: customCurator("merge-curator", (providerUnitRef) => ({
        providerUnitRef,
        outcome: "canonical_candidate",
        epistemicAttribution: {
          status: "user_asserted",
          basis: "provider_declared",
        },
        memoryWorthy: true,
        durability: "durable",
        semanticDisposition: "merge_required",
        reasonCodes: ["semantic_similarity_requires_merge"],
      })),
      curationStore,
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-v1"),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });

    const receipt = await service.run(transcriptInput(sourceId));
    assert.equal(receipt.status, "awaiting_review");
    assert.equal(receipt.curationOutcomes.pending_review, 1);
    assert.deepEqual(receipt.canonicalMemoryIds, []);
    assert.equal((await store.listChangesAfter(scope, 0)).length, 0);
    const record = (await curationStore.listByReceipt(receipt.receiptId))[0];
    assert.equal(record?.semanticDisposition, "merge_required");
    assert.equal(record?.reasonCodes.includes("admission:semantic_merge_requires_review"), true);
  });
});

test("MD-010: incomplete curation coverage fails closed before candidate creation", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-curation-coverage-failure";
    setSinglePreferenceResult(client, sourceId);
    const incompleteCurator: MemoryCurationProvider = {
      name: "incomplete-curator",
      version: "1",
      async curate() {
        return {
          providerName: "incomplete-curator",
          providerVersion: "1",
          proposals: [],
          warnings: [],
        };
      },
    };
    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      curationProvider: incompleteCurator,
      curationStore: new InMemoryMemoryCurationRecordStore(),
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-v1"),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });

    const receipt = await service.run(transcriptInput(sourceId));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.errors.at(-1)?.stage, "curation");
    assert.equal(receipt.admissionComplete, false);
    assert.deepEqual(receipt.candidateIds, []);
    assert.deepEqual(receipt.canonicalMemoryIds, []);
    assert.equal((await store.listChangesAfter(scope, 0)).length, 0);
  });
});

test("MD-010: curation audit failure blocks canonical commit", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-audit-store-failure";
    setSinglePreferenceResult(client, sourceId);
    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: createAdapter(client),
      curationProvider: new ConservativeMemoryCurationProvider("test-curation-v1"),
      curationStore: {
        async put() {
          throw new Error("curation audit unavailable");
        },
        async listByReceipt() {
          return [];
        },
        async verifyCanonicalAdmission() {
          return false;
        },
      },
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-v1"),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
    });

    const receipt = await service.run(transcriptInput(sourceId));
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.errors.at(-1)?.stage, "admission");
    assert.equal(receipt.admissionComplete, false);
    assert.deepEqual(receipt.candidateIds, []);
    assert.deepEqual(receipt.canonicalMemoryIds, []);
    assert.equal((await store.listChangesAfter(scope, 0)).length, 0);
  });
});

test("MD-008: reflect produces a derived PENDING candidate and cannot directly commit canonical memory", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  const candidates = new MemoryCandidateService(store);
  const authority = new CanonicalMemoryAuthority(store);
  const seedCandidate = await candidates.ingest({
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
    candidateType: "fact_candidate",
    sourceType: "hermes_session",
    sourceId: "reflection-seed",
    memoryClass: "semantic_assertion",
    memoryKind: "architecture_boundary",
    proposedContent: { text: "Hermes state.db is an operational transcript store." },
    evidenceRefs: [{ sourceType: "hermes_session", sourceRef: "reflection-seed" }],
    epistemicStatus: "user_asserted",
    producer: { kind: "user", id: "arthur" },
    sourceExperienceRefs: [{ sourceType: "hermes_session", sourceId: "reflection-seed" }],
    proposedOperation: "create",
  });
  const seeded = await authority.commit({
    candidateId: seedCandidate.candidateId,
    idempotencyKey: "reflection-seed-commit",
  });

  const client = new FakeHindsightClient();
  client.reflectResponse = {
    text: "Operational transcript history should be distilled before long-term pruning.",
    based_on: [
      {
        id: "hs_projection_fact_1",
        text: seeded.revision.canonicalContent.text,
        type: "world",
      },
    ],
  };
  const reflective = new ReflectiveMemoryService(store, createAdapter(client));
  const derived = await reflective.reflect({
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy", runtimeId: "hermes-gb10" },
    context: "What architectural pattern follows from the current memory boundary?",
    evidence: [
      {
        evidenceRef: { sourceType: "canonical_memory", sourceRef: seeded.head.memoryId },
        text: seeded.revision.canonicalContent.text,
        sourceExperienceRefs: seeded.revision.sourceExperienceRefs,
      },
    ],
    canonicalMemories: [seeded.revision],
    distillationPolicyVersion: "reflect-v1",
  });

  assert.equal(derived.length, 1);
  const candidate = derived[0];
  assert.ok(candidate);
  assert.equal(candidate.candidateType, "derived_insight_candidate");
  assert.equal(candidate.epistemicStatus, "synthesized");
  assert.notEqual(candidate.epistemicStatus, "observed");
  assert.equal(candidate.status, "PENDING");
  assert.equal(client.reflectCalls[0]?.bankId, "nancy:canonical-projection");
  assert.equal((await store.listChangesAfter(scope, 0)).length, 1, "reflect must not add a canonical commit");
  assert.equal((await store.getCandidate(candidate.candidateId))?.status, "PENDING");
});

test("MD-008 rejects a malicious reflective provider that tries to label inference as observed", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  const malicious: MemoryDistillationProvider = {
    name: "malicious",
    adapterVersion: "1",
    providerVersion: undefined,
    async distill() {
      return {
        providerName: "malicious",
        providerRunId: "noop",
        adapterVersion: "1",
        providerUnits: [],
        warnings: [],
      };
    },
    async recall() {
      return [];
    },
    async reflect() {
      return {
        providerName: "malicious",
        providerRunId: "reflect-bad",
        adapterVersion: "1",
        candidates: [
          {
            candidateType: "derived_insight_candidate",
            memoryClass: "semantic_assertion",
            memoryKind: "bad",
            proposedContent: { text: "This inference pretends to be observed." },
            evidenceRefs: [{ sourceType: "test", sourceRef: "e1" }],
            epistemicStatus: "observed",
            producer: { kind: "provider", id: "malicious" },
            sourceExperienceRefs: [{ sourceType: "test", sourceId: "s1" }],
          },
        ],
        warnings: [],
      } as unknown as ReflectResult;
    },
  };

  const service = new ReflectiveMemoryService(store, malicious);
  await assert.rejects(
    service.reflect({
      scope,
      origin: { lifeDid: scope.lifeDid },
      context: "bad",
      evidence: [],
      canonicalMemories: [],
      distillationPolicyVersion: "reflect-v1",
    }),
    /cannot claim observed epistemic status/,
  );
  assert.equal((await store.listChangesAfter(scope, 0)).length, 0);
});

test("MD-009: no receipt and failed receipt return explainable prune denials", async () => {
  await withArchive(async (archive) => {
    const receipts = new InMemoryDistillationReceiptStore();
    const eligibility = new PruneEligibilityService(
      receipts,
      archive,
      new PreservationCompleteRetentionPolicy("retention-v1", "admission-v1"),
    );
    const noReceipt = await eligibility.evaluate(scope, "hermes_session", "missing");
    assert.equal(noReceipt.eligible, false);
    assert.deepEqual(noReceipt.blockingReasons, ["no_distillation_receipt"]);
  });
});

test("MD-009 forgetting guard: tombstoned canonical semantics cannot be resurrected by re-distillation", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const receipts = new InMemoryDistillationReceiptStore();
    const client = new FakeHindsightClient();
    const sourceId = "session-forget-guard";
    setSinglePreferenceResult(client, sourceId, "hs_fact_original");
    const adapter = createAdapter(client);
    const candidates = new MemoryCandidateService(store);
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const authority = new CanonicalMemoryAuthority(
      store,
      undefined,
      undefined,
      curationStore,
    );
    const service = new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: receipts,
      archive,
      provider: adapter,
      curationProvider: new ConservativeMemoryCurationProvider("test-curation-v1"),
      curationStore,
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy("admission-v1"),
      governance: new EvidenceBoundMemoryGovernance("canonicalize-v1"),
      candidateService: candidates,
      canonicalAuthority: authority,
    });

    const first = await service.run(transcriptInput(sourceId, "distill-v1"));
    const memoryId = first.canonicalMemoryIds[0];
    assert.ok(memoryId);
    const head = await store.getHead(memoryId);
    assert.ok(head);
    const beforeForget = await store.getRevision(memoryId, head.currentRevision);
    assert.ok(beforeForget);

    const forgetCandidate = await candidates.ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
      candidateType: "forget_request",
      sourceType: "governance",
      sourceId: "forget-1",
      memoryClass: head.memoryClass,
      memoryKind: head.memoryKind,
      proposedContent: beforeForget.canonicalContent,
      evidenceRefs: [{ sourceType: "governance", sourceRef: "forget-1" }],
      epistemicStatus: "system_observed",
      producer: { kind: "system", id: "dlmf-forgetting-governance" },
      sourceExperienceRefs: [{ sourceType: "governance", sourceId: "forget-1" }],
      proposedOperation: "tombstone",
      baseMemoryId: memoryId,
      baseRevision: head.currentRevision,
    });
    const forgotten = await authority.commit({
      candidateId: forgetCandidate.candidateId,
      idempotencyKey: "forget-commit-1",
    });
    assert.equal(forgotten.head.status, "tombstoned");
    assert.equal(forgotten.revision.semanticFingerprint, beforeForget.semanticFingerprint);

    // A new provider run can use a new provider-specific ID. Semantic fingerprint
    // is provider-independent and still matches the governed tombstone.
    setSinglePreferenceResult(client, sourceId, "hs_fact_after_forget");
    const redistilled = await service.run(transcriptInput(sourceId, "distill-v2"));
    assert.equal(redistilled.status, "complete");
    assert.equal(redistilled.canonicalizationOutcome, "superseded");
    assert.equal(redistilled.canonicalMemoryIds.length, 0);
    assert.equal(
      redistilled.warnings.some((warning) => warning.startsWith("suppressed_by_governed_forget:")),
      true,
    );
    assert.equal((await store.listChangesAfter(scope, 0)).length, 2, "no resurrection commit may be emitted");
    assert.equal((await store.getHead(memoryId))?.status, "tombstoned");
  });
});
