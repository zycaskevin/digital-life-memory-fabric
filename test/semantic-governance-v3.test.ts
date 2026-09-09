import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CanonicalMemoryAuthority,
  ConservativeMemoryCurationProvider,
  DeterministicCanonicalAdmissionPolicy,
  DeterministicSemanticMemoryGovernance,
  EvidenceBoundMemoryGovernance,
  FilesystemRawExperienceArchiveProvider,
  InMemoryCanonicalMemoryStore,
  InMemoryDistillationReceiptStore,
  InMemoryMemoryCurationRecordStore,
  InMemorySemanticReviewStore,
  MemoryCandidateService,
  SemanticReviewQueueService,
  TranscriptDistillationService,
  ValidationError,
  reviewedSemanticConceptIds,
  type DistillationRequest,
  type DistillationResult,
  type MemoryDistillationProvider,
  type MemoryEvidence,
  type MemoryScope,
  type ProviderMemoryUnit,
  type RecallRequest,
  type ReflectRequest,
  type ReflectResult,
  type SpeakerProvenance,
  type TranscriptDistillationInput,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "tenant_semantic_v3",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

class FixtureProvider implements MemoryDistillationProvider {
  readonly name = "hindsight";
  readonly adapterVersion = "semantic-v3-fixture";
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

function unit(
  providerUnitRef: string,
  text: string,
  speakerProvenance: SpeakerProvenance = "user",
): ProviderMemoryUnit {
  return {
    providerUnitRef,
    candidateType: "preference_candidate",
    memoryClass: "preference",
    memoryKind: "user_preference",
    proposedContent: { text },
    evidenceRefs: [{ sourceType: "hindsight", sourceRef: providerUnitRef }],
    epistemicStatus: "user_asserted",
    speakerProvenance,
    producer: {
      kind: "provider",
      id: "hindsight",
      providerName: "hindsight",
      adapterVersion: "semantic-v3-fixture",
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
    content: `Semantic governance v3 fixture ${sourceId}`,
    contentType: "text/plain",
    metadata: { sessionCategory: "preference_change" },
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
  semanticReviewQueue?: SemanticReviewQueueService,
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
    ...(semanticReviewQueue === undefined ? {} : { semanticReviewQueue }),
  });
}

async function withArchive<T>(
  work: (archive: FilesystemRawExperienceArchiveProvider) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dlmf-semantic-v3-"));
  try {
    return await work(new FilesystemRawExperienceArchiveProvider(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("DLMF-SG-006 exposes only the reviewed DLMF-owned concept allow-list", () => {
  assert.deepEqual(reviewedSemanticConceptIds(), [
    "nancy_live_commentary_placement",
    "generation_routing_8b",
    "dark_mode",
    "notifications",
    "interaction_language_traditional_chinese",
    "narrative_third_person",
    "short_games_first",
  ]);
});

test("DLMF-SG-006 merges reviewed English and Traditional Chinese preference families", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const receipt = await service(archive, store, curationStore, [
      unit("language_en", "User prefers Traditional Chinese for interactions."),
      unit("language_zh", "用戶偏好使用繁體中文進行互動。"),
      unit("viewpoint_en", "User prefers third-person narration for stories."),
      unit("viewpoint_zh", "使用者偏好第三人稱故事敘事。"),
      unit("game_order_en", "User prefers playing short games first."),
      unit("game_order_zh", "使用者偏好短遊戲先行。"),
    ]).run(input("multilingual-reviewed-families"));

    assert.equal(receipt.status, "complete");
    assert.equal(receipt.semanticPolicyVersion, "dlmf-semantic-v5");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 3);
    assert.equal(receipt.curationOutcomes.canonical_merge, 3);
    assert.equal(receipt.curationOutcomes.pending_review, 0);
    assert.equal(new Set(receipt.canonicalMemoryIds).size, 3);

    const records = await curationStore.listByReceipt(receipt.receiptId);
    for (const ref of ["language_zh", "viewpoint_zh", "game_order_zh"]) {
      assert.equal(
        records.find((record) => record.providerUnitRef === ref)?.semanticRelation,
        "equivalent",
      );
    }
  });
});

test("DLMF-SG-006 routes a same-concept opposite preference to contradiction review", async () => {
  const policy = new DeterministicSemanticMemoryGovernance();
  const englishNegative = policy.classify(
    unit(
      "language_negative_en",
      "User does not prefer Traditional Chinese for interactions.",
    ),
  );
  assert.equal(englishNegative.memoryType, "preference");
  assert.equal(englishNegative.semanticPolarity, "negative");
  assert.equal(
    englishNegative.semanticKey,
    "preference:user:interaction_language:traditional_chinese",
  );
  const normativeNegative = policy.classify(
    unit(
      "nancy_negative_normative",
      "Nancy live commentary must not be interleaved within the story.",
    ),
  );
  assert.equal(normativeNegative.semanticPolarity, "negative");
  const preferNoInline = policy.classify(
    unit(
      "nancy_prefer_no_inline",
      "User prefers no inline Nancy commentary within the story.",
    ),
  );
  assert.equal(
    preferNoInline.semanticKey,
    "preference:user:story_stream_structure:nancy_live_commentary_placement",
  );
  assert.equal(preferNoInline.semanticPolarity, "negative");

  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const receipt = await service(archive, store, curationStore, [
      unit("notifications_negative_en", "User does not prefer notifications."),
      unit("notifications_negative_zh", "使用者不喜歡通知。"),
    ]).run(input("multilingual-negative-equivalence"));

    assert.equal(receipt.status, "complete");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.canonical_merge, 1);
    const records = await curationStore.listByReceipt(receipt.receiptId);
    assert.equal(
      records.find((record) => record.providerUnitRef === "notifications_negative_zh")
        ?.semanticRelation,
      "equivalent",
    );
  });

  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const receipt = await service(archive, store, curationStore, [
      unit(
        "nancy_inline_positive",
        "User prefers inline Nancy commentary within the story.",
      ),
      unit(
        "nancy_inline_prefer_no",
        "User prefers no inline Nancy commentary within the story.",
      ),
    ]).run(input("prefer-no-inline-contradiction"));

    assert.equal(receipt.status, "awaiting_review");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.canonical_merge, 0);
    assert.equal(receipt.curationOutcomes.pending_review, 1);
  });

  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const reviewStore = new InMemorySemanticReviewStore();
    const semanticReviewQueue = new SemanticReviewQueueService(curationStore, reviewStore);
    const receipt = await service(archive, store, curationStore, [
      unit("notifications_positive", "User prefers notifications."),
      unit("notifications_negative", "使用者不喜歡通知。"),
    ], semanticReviewQueue).run(input("generalized-contradiction"));

    assert.equal(receipt.status, "awaiting_review");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.pending_review, 1);
    assert.equal(receipt.curationOutcomes.canonical_merge, 0);
    const records = await curationStore.listByReceipt(receipt.receiptId);
    const positive = records.find((record) => record.providerUnitRef === "notifications_positive");
    const negative = records.find((record) => record.providerUnitRef === "notifications_negative");
    assert.equal(negative?.semanticKey, positive?.semanticKey);
    assert.equal(negative?.semanticRelation, "contradicts");
    assert.equal(negative?.outcome, "pending_review");
    const reviewCases = await reviewStore.listByReceipt(receipt.receiptId);
    assert.equal(reviewCases.length, 1);
    assert.equal(reviewCases[0]?.curationRecordId, negative?.recordId);
    assert.equal(reviewCases[0]?.trigger, "pending_review");
    assert.equal(reviewCases[0]?.canonicalWritePerformed, false);
  });
});

test("DLMF-SG-006 applies reviewed qualifier subsumption and rejects incomparable qualifiers", async () => {
  const policy = new DeterministicSemanticMemoryGovernance();
  assert.equal(
    policy.classify(
      unit(
        "dark_exception",
        "User prefers dark mode on all devices except mobile.",
      ),
    ).semanticPolarity,
    "unknown",
  );

  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const receipt = await service(archive, store, curationStore, [
      unit("dark_mobile", "User prefers dark mode on mobile devices."),
      unit("dark_all", "用戶偏好所有裝置使用深色模式。"),
    ]).run(input("qualifier-subsumption"));

    assert.equal(receipt.status, "complete");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.canonical_merge, 1);
    const records = await curationStore.listByReceipt(receipt.receiptId);
    assert.equal(
      records.find((record) => record.providerUnitRef === "dark_all")?.semanticRelation,
      "candidate_subsumes_existing",
    );
  });

  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const receipt = await service(archive, store, curationStore, [
      unit("dark_mobile_only", "User prefers dark mode on mobile devices."),
      unit("dark_night_only", "User prefers dark mode at night."),
    ]).run(input("qualifier-incomparable"));

    assert.equal(receipt.status, "awaiting_review");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.pending_review, 1);
    const records = await curationStore.listByReceipt(receipt.receiptId);
    assert.equal(
      records.find((record) => record.providerUnitRef === "dark_night_only")?.semanticRelation,
      "unrelated",
    );
  });
});

test("DLMF-SG-006 keeps ambiguous and unknown concepts on normalized exact identity", async () => {
  const policy = new DeterministicSemanticMemoryGovernance();
  const ambiguous = policy.classify(
    unit("ambiguous", "User prefers dark mode and notifications."),
  );
  assert.match(
    ambiguous.reasonCodes.join("\n"),
    /semantic:concept_ambiguous:dark_mode,notifications/,
  );
  assert.match(ambiguous.semanticKey, /^semantic:[0-9a-f]{64}$/);

  const unregistered = policy.classify(unit("unregistered", "User prefers Vim keybindings."));
  assert.match(unregistered.semanticKey, /^semantic:[0-9a-f]{64}$/);

  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const receipt = await service(archive, store, curationStore, [
      unit("ambiguous_a", "User prefers dark mode and notifications."),
      unit("ambiguous_exact", "User prefers dark mode and notifications!"),
      unit("ambiguous_reordered", "User prefers notifications and dark mode."),
    ]).run(input("ambiguous-exact-only"));

    assert.equal(receipt.status, "complete");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 2);
    assert.equal(receipt.curationOutcomes.canonical_merge, 1);
    assert.equal(new Set(receipt.canonicalMemoryIds).size, 2);
  });
});

test("DLMF-SG-006 never grants a provider or non-user speaker a reviewed user concept", () => {
  const policy = new DeterministicSemanticMemoryGovernance();
  const classified = policy.classify(
    unit("assistant_claim", "User prefers Traditional Chinese for interactions.", "assistant"),
  );
  assert.equal(classified.memoryType, "preference");
  assert.equal(classified.speakerProvenance, "assistant");
  assert.equal(classified.epistemicStatus, "uncertain");
  assert.match(classified.semanticKey, /^semantic:[0-9a-f]{64}$/);
  assert.equal(
    classified.reasonCodes.some((reason) => reason.startsWith("semantic:concept:")),
    false,
  );

  const nounOnly = policy.classify(
    unit("ui_stored_preference", "The UI stores a dark mode preference."),
  );
  assert.equal(nounOnly.memoryType, "general_fact");
  assert.equal(nounOnly.epistemicStatus, "uncertain");
  assert.match(nounOnly.semanticKey, /^semantic:[0-9a-f]{64}$/);
  assert.equal(
    nounOnly.reasonCodes.some((reason) => reason === "semantic:concept:dark_mode"),
    false,
  );
});

test("DLMF-SG-006 ignores a fingerprint hit whose DLMF semantic key does not match", async () => {
  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const candidates = new MemoryCandidateService(store);
    const poison = await candidates.ingest({
      scope,
      origin: { lifeDid: scope.lifeDid, agentId: "review-fixture" },
      candidateType: "fact_candidate",
      sourceType: "review_fixture",
      sourceId: "fingerprint-poison",
      memoryClass: "semantic_assertion",
      memoryKind: "review_fixture",
      memoryType: "general_fact",
      speakerProvenance: "system",
      semanticKey: "review:unrelated-semantic-key",
      proposedContent: { text: "Unrelated reviewed fixture." },
      evidenceRefs: [{ sourceType: "review", sourceRef: "fingerprint-poison" }],
      epistemicStatus: "system_observed",
      producer: { kind: "system", id: "review-fixture" },
      sourceExperienceRefs: [{ sourceType: "review_fixture", sourceId: "fingerprint-poison" }],
      proposedOperation: "create",
    });
    const poisonedRevision = (await new CanonicalMemoryAuthority(store).commit({
      candidateId: poison.candidateId,
      idempotencyKey: "fingerprint-poison",
    })).revision;
    store.findCurrentRevisionBySemanticFingerprint = async () =>
      structuredClone(poisonedRevision);

    const receipt = await service(
      archive,
      store,
      new InMemoryMemoryCurationRecordStore(),
      [unit("safe_dark_mode", "User prefers dark mode.")],
    ).run(input("fingerprint-key-mismatch"));

    assert.equal(receipt.status, "complete");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.pending_review, 0);
    assert.equal(receipt.canonicalMemoryIds.length, 1);
    assert.notEqual(receipt.canonicalMemoryIds[0], poisonedRevision.memoryId);
  });

  const policy = new DeterministicSemanticMemoryGovernance();
  const classified = policy.classify(unit("mismatch", "User prefers dark mode."));
  assert.throws(
    () => policy.relate(
      { ...unit("mismatch", "User prefers dark mode."), semanticKey: classified.semanticKey },
      {
        memoryId: "mem_mismatch",
        revision: 1,
        scope,
        memoryClass: "preference",
        memoryKind: "user_preference",
        memoryType: "preference",
        speakerProvenance: "user",
        semanticKey: "preference:user:other",
        status: "active",
        canonicalContent: { text: "User prefers dark mode." },
        contentHash: "sha256:test",
        author: { lifeDid: scope.lifeDid },
        provenance: {
          sourceType: "test",
          candidateId: "cand_test",
          candidateFingerprint: "sha256:test",
          producer: { kind: "user", id: "test" },
          sourceExperienceRefs: [],
        },
        evidenceRefs: [{ sourceType: "test", sourceRef: "test" }],
        epistemicStatus: "user_asserted",
        producer: { kind: "user", id: "test" },
        sourceExperienceRefs: [],
        semanticFingerprint: "sha256:test",
        committedAt: "2026-09-09T00:00:00.000Z",
        commitSeq: 1,
      },
    ),
    ValidationError,
  );
});
