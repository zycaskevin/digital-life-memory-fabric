import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConservativeMemoryCurationProvider,
  DeterministicCanonicalAdmissionPolicy,
  DeterministicSemanticMemoryGovernance,
  EvidenceBoundMemoryGovernance,
  FilesystemRawExperienceArchiveProvider,
  InMemoryCanonicalMemoryStore,
  InMemoryDistillationReceiptStore,
  InMemoryMemoryCurationRecordStore,
  TranscriptDistillationService,
  hasExplicitPreferenceAssertion,
  isDurableOperationalPreference,
  isOneShotOperationalDirective,
  type DistillationRequest,
  type DistillationResult,
  type MemoryCurationProposal,
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
  tenantId: "tenant_lifetime_governance",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};

const rejectedOperationalDirectives = [
  "開始",
  "開始吧",
  "使用者要求開始執行任務。",
  "使用者要求繼續執行。",
  "繼續",
  "繼續完成",
  "下一步",
  "目前進度？",
  "continue",
  "proceed",
  "go ahead",
  "keep going",
  "resume",
  "start the task",
  "User asked the agent to continue.",
  "User requested the task to start.",
] as const;

const durableOperationalPreferences = [
  "以後如果沒有阻塞就直接繼續，不用每一步問我。",
  "使用者偏好 Agent 在沒有阻塞時自動繼續執行，不需要每一步詢問。",
  "User prefers autonomous execution unless a blocker requires intervention.",
] as const;

function unit(providerUnitRef: string, text: string): ProviderMemoryUnit {
  return {
    providerUnitRef,
    candidateType: "preference_candidate",
    memoryClass: "preference",
    memoryKind: "execution_preference",
    proposedContent: { text },
    evidenceRefs: [{ sourceType: "hindsight", sourceRef: providerUnitRef }],
    epistemicStatus: "user_asserted",
    speakerProvenance: "user",
    producer: {
      kind: "provider",
      id: "hindsight",
      providerName: "hindsight",
      adapterVersion: "memory-lifetime-fixture",
      providerVersion: "fixture",
    },
    sourceExperienceRefs: [{ sourceType: "hermes_session", sourceId: providerUnitRef }],
  };
}

class FixtureProvider implements MemoryDistillationProvider {
  readonly name = "hindsight";
  readonly adapterVersion = "memory-lifetime-fixture";
  readonly providerVersion = "fixture";

  constructor(private readonly units: ProviderMemoryUnit[]) {}

  async distill(_request: DistillationRequest): Promise<DistillationResult> {
    return {
      providerName: this.name,
      providerRunId: "memory-lifetime-fixture-run",
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
      providerRunId: "memory-lifetime-reflect-unused",
      adapterVersion: this.adapterVersion,
      providerVersion: this.providerVersion,
      candidates: [],
      warnings: [],
    };
  }
}

function input(sourceId: string): TranscriptDistillationInput {
  return {
    scope,
    origin: { lifeDid: scope.lifeDid, agentId: "nancy" },
    sourceType: "hermes_session",
    sourceId,
    content: `Memory lifetime governance fixture ${sourceId}`,
    contentType: "text/plain",
    distillationPolicyVersion: "test-distill-lifetime-v1",
    canonicalizationPolicyVersion: "test-canonical-lifetime-v1",
    admissionPolicyVersion: "test-admission-lifetime-v1",
    retentionPolicyVersion: "test-retention-lifetime-v1",
  };
}

async function withArchive<T>(
  work: (archive: FilesystemRawExperienceArchiveProvider) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "dlmf-memory-lifetime-"));
  try {
    return await work(new FilesystemRawExperienceArchiveProvider(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function service(
  archive: FilesystemRawExperienceArchiveProvider,
  units: ProviderMemoryUnit[],
  store = new InMemoryCanonicalMemoryStore(),
  curationStore = new InMemoryMemoryCurationRecordStore(),
): {
  service: TranscriptDistillationService;
  store: InMemoryCanonicalMemoryStore;
  curationStore: InMemoryMemoryCurationRecordStore;
} {
  return {
    store,
    curationStore,
    service: new TranscriptDistillationService({
      canonicalStore: store,
      receiptStore: new InMemoryDistillationReceiptStore(),
      archive,
      provider: new FixtureProvider(units),
      curationProvider: new ConservativeMemoryCurationProvider(
        "test-curation-lifetime-v1",
      ),
      curationStore,
      admissionPolicy: new DeterministicCanonicalAdmissionPolicy(
        "test-admission-lifetime-v1",
      ),
      governance: new EvidenceBoundMemoryGovernance("test-canonical-lifetime-v1"),
    }),
  };
}

test("DLMF-MEM-GOV-001 detects bounded one-shot operational directives", () => {
  const semantic = new DeterministicSemanticMemoryGovernance();
  assert.equal(semantic.policyVersion, "dlmf-semantic-v7");

  for (const [index, text] of rejectedOperationalDirectives.entries()) {
    assert.equal(isOneShotOperationalDirective(text), true, text);
    assert.equal(hasExplicitPreferenceAssertion(text), false, text);
    const classification = semantic.classify(unit(`ephemeral_${index}`, text));
    assert.equal(classification.memoryType, "transient_state", text);
    assert.ok(
      classification.reasonCodes.includes(
        "semantic:lifetime:operational_directive_ephemeral",
      ),
      text,
    );
  }
});

test("DLMF-MEM-GOV-001 preserves cross-session autonomous execution preferences", () => {
  const semantic = new DeterministicSemanticMemoryGovernance();

  for (const [index, text] of durableOperationalPreferences.entries()) {
    assert.equal(isDurableOperationalPreference(text), true, text);
    assert.equal(isOneShotOperationalDirective(text), false, text);
    assert.equal(hasExplicitPreferenceAssertion(text), true, text);
    const classification = semantic.classify(unit(`durable_${index}`, text));
    assert.equal(classification.memoryType, "preference", text);
    assert.equal(
      classification.reasonCodes.includes(
        "semantic:lifetime:operational_directive_ephemeral",
      ),
      false,
      text,
    );
  }
});

test("DLMF-MEM-GOV-001 end-to-end keeps one-shot controls as supporting evidence only", async () => {
  await withArchive(async (archive) => {
    const units = rejectedOperationalDirectives.slice(0, 8).map((text, index) =>
      unit(`reject_${index}`, text),
    );
    const runtime = service(archive, units);
    const receipt = await runtime.service.run(input("operational-directives-rejected"));

    assert.equal(receipt.status, "complete");
    assert.equal(receipt.canonicalizationOutcome, "no_memory_worthy_content");
    assert.equal(receipt.semanticPolicyVersion, "dlmf-semantic-v7");
    assert.equal(receipt.curationOutcomes.supporting_evidence_only, units.length);
    assert.equal(receipt.curationOutcomes.canonical_candidate, 0);
    assert.equal(receipt.candidateIds.length, 0);
    assert.equal(receipt.canonicalMemoryIds.length, 0);

    const records = await runtime.curationStore.listByReceipt(receipt.receiptId);
    assert.equal(records.length, units.length);
    for (const record of records) {
      assert.equal(record.memoryType, "transient_state");
      assert.equal(record.durability, "transient");
      assert.equal(record.memoryWorthy, false);
      assert.equal(record.outcome, "supporting_evidence_only");
      assert.ok(
        record.reasonCodes.includes("curation:lifetime:operational_directive_ephemeral"),
      );
      assert.ok(
        record.reasonCodes.includes("admission:operational_directive_not_canonical"),
      );
    }
  });
});

test("DLMF-MEM-GOV-001 admission fails closed against an over-permissive curator", () => {
  const policy = new DeterministicCanonicalAdmissionPolicy("test-admission-lifetime-v1");
  const source = unit("malicious_curator", "User asked the agent to continue.");
  const proposal: MemoryCurationProposal = {
    providerUnitRef: source.providerUnitRef,
    outcome: "canonical_candidate",
    epistemicAttribution: {
      status: "user_asserted",
      basis: "provider_declared",
    },
    memoryWorthy: true,
    durability: "identity_long_term",
    semanticDisposition: "novel",
    reasonCodes: ["external_curator:claims_durable"],
  };

  const decision = policy.evaluate({
    unit: source,
    proposal,
    rawContent: source.proposedContent.text,
  });
  assert.equal(decision.outcome, "supporting_evidence_only");
  assert.equal(decision.durability, "transient");
  assert.equal(decision.memoryWorthy, false);
  assert.ok(decision.reasonCodes.includes("admission:operational_directive_not_canonical"));
});

test("DLMF-MEM-GOV-001 still admits a durable execution preference", async () => {
  await withArchive(async (archive) => {
    const durable = unit(
      "durable_autonomy",
      "以後如果沒有阻塞就直接繼續，不用每一步問我。",
    );
    const runtime = service(archive, [durable]);
    const receipt = await runtime.service.run(input("durable-autonomous-execution"));

    assert.equal(receipt.status, "complete");
    assert.equal(receipt.canonicalizationOutcome, "committed");
    assert.equal(receipt.curationOutcomes.canonical_candidate, 1);
    assert.equal(receipt.canonicalMemoryIds.length, 1);
    const records = await runtime.curationStore.listByReceipt(receipt.receiptId);
    assert.equal(records[0]?.memoryType, "preference");
    assert.equal(records[0]?.durability, "durable");
    assert.equal(records[0]?.outcome, "canonical_candidate");
  });
});
