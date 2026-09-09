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

const productionPilotNancyTaskDescriptions = [
  "The `SOUL.md` narrator rules contain strict anti-spoiler and anti-fabricated-co-play rules, but need revision from '實況層' to inline interleaving. | Involving: user | To align with new narrative style requirements",
  "A task was initiated to rewrite the 'Sorcerer' novel by processing raw logs into a complete interleaved live-stream serialization. | Involving: user",
  "針對 905 小說品質的批評，已修正「假共玩」與「前置破梗」問題，但尚未實作使用者提出的「正文穿插實況」新格式，風格調整尚未結案。 | Involving: user",
  "執行 novel-rewriter 任務，改寫 Sorcerer 驗證連載第 2 集。 | Involving: assistant | 基於 walkthrough 協助進行交錯式直播小說改寫，不使用章末實況欄",
  "User initiated a task to rewrite the novel 'sorcerer' using the novel-rewriter role, following the specified interleaved commentary style. | Involving: user",
  "執行 novel-rewriter 任務，改寫 Sorcerer 驗證連載第 3 集。 | Involving: assistant | 基於 walkthrough 協助進行交錯式直播小說改寫，不使用章末實況欄",
] as const;

const productionPilotNancyPreference =
  "The novel format must integrate Nancy's actual gameplay, failures, complaints, and reactions directly into the story text, rather than as a separate post-story log. | Involving: Nancy | To follow the user's latest definition of the storytelling style.";

const productionPilotCrossCategoryCases = [
  {
    text: "執行 deleg_f5196abf 任務，第二輪 review 指出 root authority 分裂與 journal hardlink/phase 清理疑慮，要求再次修補。 | Involving: user",
    memoryType: "project_state",
  },
  {
    text: "更新設計文件 `specs/daily-dual-strategy/requirements.md`，加入 R-4 歷史資料新條件與 R-13 布林/欄位完整性要求。 | Involving: assistant",
    memoryType: "project_state",
  },
  {
    text: "實施 blocker 修補措施：`deviation()` 改用 8 位四捨五入，`validate_state` 要求 `positions_confirmed` 為必填 JSON boolean，並加入 schema guard。 | Involving: assistant",
    memoryType: "project_state",
  },
  {
    text: "策略輸出規範：若資料不完整，僅顯示指標與等待訊息；嚴禁輸出任何憑證、金鑰、API token、密碼或連線字串。 | Involving: user",
    memoryType: "technical_fact",
  },
  {
    text: "使用者指定 `agent_id: laptop-codex` 並要求將 SSH key 相關內容交付給 Arthur。 | Involving: user",
    memoryType: "general_fact",
  },
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
    assert.equal(receipt.semanticPolicyVersion, "dlmf-semantic-v4");

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
      records.every((record) => record.semanticPolicyVersion === "dlmf-semantic-v4"),
      true,
    );
  });
});

test("DLMF-SG-004 keeps Nancy task lifecycle statements outside the preference family", async () => {
  const policy = new DeterministicSemanticMemoryGovernance();
  for (const [index, text] of productionPilotNancyTaskDescriptions.entries()) {
    const classified = policy.classify(providerUnit(
      `hs_nancy_task_${index + 1}`,
      text,
      "preference_candidate",
      "preference",
      "story_stream_structure",
    ));
    assert.equal(classified.memoryType, "project_state");
    assert.equal(classified.epistemicStatus, "uncertain");
    assert.notEqual(
      classified.semanticKey,
      "preference:user:story_stream_structure:nancy_live_commentary_placement",
    );
  }

  for (const [index, fixture] of productionPilotCrossCategoryCases.entries()) {
    const classified = policy.classify(providerUnit(
      `hs_cross_category_${index + 1}`,
      fixture.text,
      "preference_candidate",
      "preference",
      "provider_declared_preference",
    ));
    assert.equal(classified.memoryType, fixture.memoryType);
    assert.equal(classified.speakerProvenance, "user");
    assert.equal(classified.epistemicStatus, "uncertain");
  }

  const actualPreference = policy.classify(providerUnit(
    "hs_nancy_format_rule",
    productionPilotNancyPreference,
    "preference_candidate",
    "preference",
    "story_stream_structure",
  ));
  assert.equal(actualPreference.memoryType, "preference");
  assert.equal(actualPreference.epistemicStatus, "user_asserted");
  assert.equal(actualPreference.semanticPolarity, "affirmative");
  assert.equal(
    actualPreference.semanticKey,
    "preference:user:story_stream_structure:nancy_live_commentary_placement",
  );

  await withArchive(async (archive) => {
    const store = new InMemoryCanonicalMemoryStore();
    const curationStore = new InMemoryMemoryCurationRecordStore();
    const units = [
      ...nancyPreferenceParaphrases.map((text, index) =>
        providerUnit(
          `hs_nancy_inline_sg4_${index + 1}`,
          text,
          "preference_candidate",
          "preference",
          "story_stream_structure",
        )),
      ...productionPilotNancyTaskDescriptions.map((text, index) =>
        providerUnit(
          `hs_nancy_task_sg4_${index + 1}`,
          text,
          "preference_candidate",
          "preference",
          "story_stream_structure",
        )),
      providerUnit(
        "hs_nancy_format_rule_sg4",
        productionPilotNancyPreference,
        "preference_candidate",
        "preference",
        "story_stream_structure",
      ),
    ];

    const receipt = await service(archive, store, curationStore, units).run(
      input("20260828_174230_77857c-sg-004"),
    );
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.canonicalizationOutcome, "committed");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.curationOutcomes.canonical_merge, 5);
    assert.equal(receipt.curationOutcomes.supporting_evidence_only, 6);
    assert.equal(receipt.curationOutcomes.pending_review, 0);
    assert.equal(receipt.canonicalMemoryIds.length, 1);

    const records = await curationStore.listByReceipt(receipt.receiptId);
    for (let index = 0; index < productionPilotNancyTaskDescriptions.length; index += 1) {
      const record = records.find(
        (item) => item.providerUnitRef === `hs_nancy_task_sg4_${index + 1}`,
      );
      assert.equal(record?.memoryType, "project_state");
      assert.equal(record?.attributedEpistemicStatus, "uncertain");
      assert.equal(record?.outcome, "supporting_evidence_only");
    }
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
      semanticPolicyVersion: "dlmf-semantic-v4",
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
