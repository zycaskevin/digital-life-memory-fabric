import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CanonicalMemoryAuthority,
  CanonicalVerifier,
  ConservativeMemoryCurationProvider,
  DeterministicCanonicalAdmissionPolicy,
  DeterministicSemanticMemoryGovernance,
  EvidenceBoundMemoryGovernance,
  FilesystemRawExperienceArchiveProvider,
  InMemoryCanonicalMemoryStore,
  InMemoryDistillationReceiptStore,
  InMemoryMemoryCurationRecordStore,
  MemoryCandidateService,
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
  tenantId: "tenant_semantic_pilot",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

const nancyPreferenceParaphrases = [
  "User dislikes the 'episode + end-of-episode live layer' structure in the 905 novel and requires inline interleaving of story and live Nancy operations.",
  "用戶偏好在故事情節推進中直接穿插 Nancy 的真實操作、吐槽或即時反應，而非將故事與實況分段撰寫。",
  "User prefers a writing style for stories that intersperses live stream commentary, such as Nancy's real-time actions, within the narrative paragraphs.",
  "The user prefers a style where Nancy's operations and commentary are threaded inline through the story, rather than separated story and stream sections.",
  "User clarified that live content must be interleaved within the story rather than separated as an end-of-section layer.",
] as const;

class PilotFixtureProvider implements MemoryDistillationProvider {
  readonly name = "hindsight";
  readonly adapterVersion = "pilot-fixture-v1";
  readonly providerVersion = "fixture";

  constructor(private readonly units: ProviderMemoryUnit[]) {}

  async distill(_request: DistillationRequest): Promise<DistillationResult> {
    return {
      providerName: this.name,
      providerRunId: "hs_pilot_20260828_174230_77857c",
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
      providerRunId: "hs_reflect_fixture",
      adapterVersion: this.adapterVersion,
      providerVersion: this.providerVersion,
      candidates: [],
      warnings: [],
    };
  }
}

function providerUnit(
  providerUnitRef: string,
  text: string,
  candidateType: ProviderMemoryUnit["candidateType"],
  memoryClass: ProviderMemoryUnit["memoryClass"],
  memoryKind: string,
): ProviderMemoryUnit {
  return {
    providerUnitRef,
    candidateType,
    memoryClass,
    memoryKind,
    proposedContent: { text },
    evidenceRefs: [
      { sourceType: "hindsight", sourceRef: providerUnitRef },
      { sourceType: "hermes_session", sourceRef: "20260828_174230_77857c" },
    ],
    epistemicStatus: "user_asserted",
    speakerProvenance: "user",
    producer: {
      kind: "provider",
      id: "hindsight",
      providerName: "hindsight",
      adapterVersion: "pilot-fixture-v1",
      providerVersion: "fixture",
    },
    sourceExperienceRefs: [
      { sourceType: "hermes_session", sourceId: "20260828_174230_77857c" },
    ],
  };
}

function input(sourceId: string): TranscriptDistillationInput {
  return {
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
    sourceType: "hermes_session",
    sourceId,
    content: "Pilot fixture for canonical semantic-governance regression.",
    contentType: "text/plain",
    metadata: { sessionCategory: "preference_change" },
    distillationPolicyVersion: "pilot-distill-v5-semantic-governance",
    canonicalizationPolicyVersion: "pilot-canonicalize-v1",
    retentionPolicyVersion: "pilot-retention-v1",
    admissionPolicyVersion: "pilot-admission-v1",
  };
}

async function withArchive<T>(
  work: (archive: FilesystemRawExperienceArchiveProvider) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dlmf-semantic-governance-"));
  try {
    return await work(new FilesystemRawExperienceArchiveProvider(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    provider: new PilotFixtureProvider(units),
    curationProvider: new ConservativeMemoryCurationProvider("pilot-curation-v4"),
    curationStore,
    admissionPolicy: new DeterministicCanonicalAdmissionPolicy("pilot-admission-v1"),
    governance: new EvidenceBoundMemoryGovernance("pilot-canonicalize-v1"),
  });
}

test("DLMF-SG-001 pilot fixture merges five Nancy preference paraphrases into one canonical identity", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const units = nancyPreferenceParaphrases.map((text, index) =>
      providerUnit(
        `hs_nancy_inline_${index + 1}`,
        text,
        "preference_candidate",
        "preference",
        "story_stream_structure",
      ),
    );

    const receipt = await service(archive, store, curationStore, units).run(
      input("20260828_174230_77857c"),
    );

    assert.equal(receipt.status, "complete");
    assert.equal(receipt.canonicalizationOutcome, "committed");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.canonical_merge, 4);
    assert.equal(receipt.canonicalMemoryIds.length, 1);
    assert.equal(new Set(receipt.canonicalMemoryIds).size, 1);
    assert.equal(receipt.semanticPolicyVersion, "dlmf-semantic-v2");

    const memoryId = receipt.canonicalMemoryIds[0];
    assert.ok(memoryId);
    const head = await store.getHead(memoryId);
    assert.ok(head);
    assert.equal(head.currentRevision, 5);
    assert.equal(
      head.semanticKey,
      "preference:user:story_stream_structure:nancy_live_commentary_placement",
    );
    const revision = await store.getRevision(memoryId, head.currentRevision);
    assert.ok(revision);
    assert.equal(revision.canonicalContent.text, nancyPreferenceParaphrases[0]);
    assert.equal((await new CanonicalVerifier(store).verify(memoryId, scope)).decision, "ALLOW");
    assert.deepEqual(
      revision.evidenceRefs
        .filter((ref) => ref.sourceType === "hindsight")
        .map((ref) => ref.sourceRef)
        .sort(),
      units.map((unit) => unit.providerUnitRef).sort(),
    );

    const records = await curationStore.listByReceipt(receipt.receiptId);
    assert.equal(records.filter((record) => record.outcome === "canonical_merge").length, 4);
    assert.equal(new Set(records.map((record) => record.semanticKey)).size, 1);
    assert.equal(
      records.every((record) => record.semanticPolicyVersion === "dlmf-semantic-v2"),
      true,
    );
  });
});

test("DLMF-SG-001 classifies each memory independently and separates speaker from epistemic status", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const units = [
      providerUnit(
        "hs_type_preference",
        nancyPreferenceParaphrases[1],
        "preference_candidate",
        "preference",
        "story_stream_structure",
      ),
      providerUnit(
        "hs_type_technical",
        "Floating-point errors cause misclassification in the scoring service.",
        "fact_candidate",
        "semantic_assertion",
        "diagnostic_finding",
      ),
      providerUnit(
        "hs_type_transient",
        "The current game score is 12 and the run is in progress.",
        "event_candidate",
        "episode",
        "game_progress",
      ),
      providerUnit(
        "hs_type_project",
        "Due to download failures, 9z was replaced with verified Zork II.",
        "project_state_candidate",
        "semantic_assertion",
        "content_selection_state",
      ),
    ];

    const receipt = await service(archive, store, curationStore, units).run(
      input("20260828_174230_77857c-memory-types"),
    );
    assert.equal(receipt.status, "complete");

    const records = new Map(
      (await curationStore.listByReceipt(receipt.receiptId)).map((record) => [
        record.providerUnitRef,
        record,
      ]),
    );
    assert.equal(records.get("hs_type_preference")?.memoryType, "preference");
    assert.equal(records.get("hs_type_technical")?.memoryType, "technical_fact");
    assert.equal(records.get("hs_type_transient")?.memoryType, "transient_state");
    assert.equal(records.get("hs_type_project")?.memoryType, "project_state");
    assert.equal(records.get("hs_type_technical")?.speakerProvenance, "user");
    assert.equal(records.get("hs_type_technical")?.providerEpistemicStatus, "user_asserted");
    assert.equal(records.get("hs_type_technical")?.attributedEpistemicStatus, "uncertain");
    assert.equal(records.get("hs_type_technical")?.attributedEpistemicBasis, "dlmf_semantic_policy");
    assert.notEqual(records.get("hs_type_project")?.memoryType, "preference");
  });
});

test("DLMF-SG-002 maps opposite Nancy preferences to one concept key for contradiction review", () => {
  const policy = new DeterministicSemanticMemoryGovernance();
  const inline = policy.classify(providerUnit(
    "hs_inline_positive",
    nancyPreferenceParaphrases[2],
    "preference_candidate",
    "preference",
    "story_stream_structure",
  ));
  const separated = policy.classify(providerUnit(
    "hs_inline_negative",
    "User dislikes inline Nancy live commentary within stories and requires a separate end-of-section stream.",
    "preference_candidate",
    "preference",
    "story_stream_structure",
  ));

  assert.equal(
    inline.semanticKey,
    "preference:user:story_stream_structure:nancy_live_commentary_placement",
  );
  assert.equal(separated.semanticKey, inline.semanticKey);
});

test("DLMF-SG-001 rejects an unbacked provider semantic-merge proof", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  const candidates = new MemoryCandidateService(store);
  const seed = await candidates.ingest({
    scope,
    origin: { lifeDid: scope.lifeDid },
    candidateType: "preference_candidate",
    sourceType: "test",
    sourceId: "seed",
    memoryClass: "preference",
    memoryKind: "story_stream_structure",
    memoryType: "preference",
    speakerProvenance: "user",
    semanticKey: "preference:user:story_stream_structure:nancy_live_commentary_placement",
    proposedContent: { text: nancyPreferenceParaphrases[0] },
    evidenceRefs: [{ sourceType: "test", sourceRef: "seed" }],
    epistemicStatus: "user_asserted",
    producer: { kind: "user", id: "owner" },
    sourceExperienceRefs: [{ sourceType: "test", sourceId: "seed" }],
    proposedOperation: "create",
  });
  const authority = new CanonicalMemoryAuthority(store);
  const seeded = await authority.commit({
    candidateId: seed.candidateId,
    idempotencyKey: "semantic-seed",
  });

  const forged = await candidates.ingest({
    scope,
    origin: { lifeDid: scope.lifeDid },
    candidateType: "preference_candidate",
    sourceType: "hermes_session",
    sourceId: "forged-merge",
    memoryClass: seeded.head.memoryClass,
    memoryKind: seeded.head.memoryKind,
    memoryType: seeded.head.memoryType,
    speakerProvenance: "user",
    semanticKey: seeded.head.semanticKey,
    proposedContent: seeded.revision.canonicalContent,
    evidenceRefs: [{ sourceType: "hindsight", sourceRef: "forged-unit" }],
    epistemicStatus: "user_asserted",
    producer: { kind: "provider", id: "hindsight", providerName: "hindsight" },
    sourceExperienceRefs: [{ sourceType: "hermes_session", sourceId: "forged-merge" }],
    providerRunId: "forged-run",
    canonicalAdmission: {
      admissionPolicyVersion: "pilot-admission-v1",
      curationProvider: "forged-curator",
      curationRecordId: "cur_forged",
      outcome: "canonical_merge",
      semanticPolicyVersion: "dlmf-semantic-v2",
      semanticRelation: "equivalent",
      targetMemoryId: seeded.head.memoryId,
    },
    proposedOperation: "merge",
    baseMemoryId: seeded.head.memoryId,
    baseRevision: seeded.head.currentRevision,
  });

  await assert.rejects(
    authority.commit({ candidateId: forged.candidateId, idempotencyKey: "forged-merge" }),
    /requires configured canonical admission verifier/,
  );
  assert.equal((await store.getHead(seeded.head.memoryId))?.currentRevision, 1);
});
