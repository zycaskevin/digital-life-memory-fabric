import assert from "node:assert/strict";
import test from "node:test";

import {
  DeterministicHindsightPlaneResolver,
  HindsightCanonicalProjectionPort,
  RelationshipOsDlmfIngress,
  type DistillationReceipt,
  type HindsightClientPort,
  type MemoryRevision,
  type TranscriptDistillationInput,
  type VerifiedRetrievalResult,
} from "../src/index.js";

const scope = {
  tenantId: "relationship-os-production",
  lifeDid: "did:arthurverse:nancy",
  memoryNamespace: "relationship.private.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const privateUserText = "這是不能出現在 error 或 provider candidate output 的私人訊息。";
const privateAssistantText = "我會記得你剛剛提到的事情。";

function receipt(overrides: Partial<DistillationReceipt> = {}): DistillationReceipt {
  const now = "2026-09-05T10:00:00.000Z";
  return {
    receiptId: "dist_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    scope,
    sourceType: "relationship_os_private_turn",
    sourceId: "ros-private-turn:pt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    idempotencyKey: "sha256:test",
    rawArchiveRef: "filesystem://relationship/private-turn.json",
    rawArchiveChecksum: "sha256:archive",
    provider: "hindsight",
    distillationPolicyVersion: "ros-distill-v1",
    canonicalizationPolicyVersion: "ros-canonicalize-v1",
    admissionPolicyVersion: "ros-admission-v1",
    retentionPolicyVersion: "ros-retention-v1",
    adapterVersion: "hindsight-test",
    curationProvider: "conservative",
    providerUnitCount: 1,
    curationDecisionCount: 1,
    curationOutcomes: {
      supporting_evidence_only: 0,
      rejected: 0,
      pending_review: 0,
      canonical_candidate: 1,
    },
    curationCoverageComplete: true,
    admissionComplete: true,
    candidateIds: ["cand_test"],
    canonicalMemoryIds: ["mem_aaaaaaaaaaaaaaaa"],
    status: "complete",
    errors: [],
    warnings: [],
    canonicalizationOutcome: "committed",
    retentionState: "preserved",
    pruneEligible: false,
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function revision(): MemoryRevision {
  return {
    memoryId: "mem_aaaaaaaaaaaaaaaa",
    revision: 2,
    scope,
    memoryClass: "preference",
    memoryKind: "user_preference",
    status: "active",
    canonicalContent: { text: "Arthur prefers a bounded canonical memory context." },
    contentHash: "sha256:content",
    author: { lifeDid: scope.lifeDid, agentId: "nancy" },
    provenance: {
      sourceType: "relationship_os_private_turn",
      sourceId: "ros-private-turn:pt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      candidateId: "cand_test",
      candidateFingerprint: "sha256:fingerprint",
      producer: { kind: "provider", id: "hindsight" },
      sourceExperienceRefs: [],
    },
    evidenceRefs: [{ sourceType: "relationship_os_private_turn", sourceRef: "turn" }],
    epistemicStatus: "user_asserted",
    producer: { kind: "provider", id: "hindsight" },
    sourceExperienceRefs: [],
    semanticFingerprint: "sha256:semantic",
    committedAt: "2026-09-05T09:00:00.000Z",
    commitSeq: 2,
  };
}

function retrievalResult(): VerifiedRetrievalResult {
  const canonical = revision();
  return {
    query: "bounded memory",
    scope,
    providerId: "hindsight",
    effectiveAt: "2026-09-05T10:00:00.000Z",
    items: [{
      memoryId: canonical.memoryId,
      canonicalRevision: canonical.revision,
      revision: canonical,
      retrievalEvidence: {
        providerId: "hindsight",
        claimedCanonicalRevision: canonical.revision,
        providerRank: 1,
        providerObjectId: "provider-object-secret-text",
      },
    }],
    verification: {
      receivedCandidates: 1,
      uniqueCandidates: 1,
      allowed: 1,
      suppressed: 0,
      suppressionCounts: {},
    },
  };
}

function distillationBody(namespace = scope.memoryNamespace): Record<string, unknown> {
  return {
    scope: { ...scope, memoryNamespace: namespace },
    sourceType: "relationship_os_private_turn",
    sourceId: "ros-private-turn:pt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    content: JSON.stringify({ user: privateUserText, assistant: privateAssistantText }),
    contentType: "application/vnd.relationship-os.private-turn+json;version=1",
    createdAt: "2026-09-05T09:59:00.000Z",
    observedAt: "2026-09-05T09:59:00.000Z",
    metadata: { relationship_id: "rel-a", reply_hash: "abc" },
    sourceSegments: [
      {
        segmentId: "turn:user",
        actor: "user",
        content: privateUserText,
        observedAt: "2026-09-05T09:59:00.000Z",
      },
      {
        segmentId: "turn:assistant",
        actor: "assistant",
        content: privateAssistantText,
        observedAt: "2026-09-05T10:00:00.000Z",
      },
    ],
  };
}

function request(path: string, body: unknown, token = "x".repeat(48)): Request {
  return new Request(`https://dlmf.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function ingress(options: {
  onDistill?: (input: TranscriptDistillationInput) => Promise<DistillationReceipt>;
  onRetrieve?: (input: unknown) => Promise<VerifiedRetrievalResult>;
} = {}) {
  return new RelationshipOsDlmfIngress({
    bearerToken: "x".repeat(48),
    allowedTenantId: scope.tenantId,
    allowedLifeDid: scope.lifeDid,
    memoryNamespacePrefix: "relationship.private.",
    agentId: "nancy",
    runtimeId: "relationship-os",
    policies: {
      distillationPolicyVersion: "ros-distill-v1",
      canonicalizationPolicyVersion: "ros-canonicalize-v1",
      admissionPolicyVersion: "ros-admission-v1",
      retentionPolicyVersion: "ros-retention-v1",
    },
    distillation: {
      run: options.onDistill ?? (async () => receipt()),
    },
    retrieval: {
      retrieve: options.onRetrieve ?? (async () => retrievalResult()),
    },
  });
}

test("Relationship OS DLMF ingress authenticates before parsing private content", async () => {
  let calls = 0;
  const service = ingress({
    onDistill: async () => {
      calls += 1;
      return receipt();
    },
  });
  const response = await service.handle(new Request(
    "https://dlmf.test/v1/relationship-os/transcript-distillations",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: "{ definitely not json and contains private material",
    },
  ));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
  assert.equal(calls, 0);
});

test("Relationship OS DLMF distillation injects trusted identity and server policy versions", async () => {
  let observed: TranscriptDistillationInput | undefined;
  const service = ingress({
    onDistill: async (input) => {
      observed = structuredClone(input);
      return receipt();
    },
  });
  const response = await service.handle(request(
    "/v1/relationship-os/transcript-distillations",
    distillationBody(),
  ));
  assert.equal(response.status, 200);
  assert.ok(observed);
  assert.deepEqual(observed?.scope, scope);
  assert.deepEqual(observed?.origin, {
    lifeDid: scope.lifeDid,
    agentId: "nancy",
    runtimeId: "relationship-os",
  });
  assert.equal(observed?.distillationPolicyVersion, "ros-distill-v1");
  assert.equal(observed?.canonicalizationPolicyVersion, "ros-canonicalize-v1");
  assert.equal(observed?.admissionPolicyVersion, "ros-admission-v1");
  assert.equal(observed?.retentionPolicyVersion, "ros-retention-v1");
  assert.equal(observed?.sourceSegments?.[0]?.content, privateUserText);
  assert.equal(observed?.sourceSegments?.[1]?.content, privateAssistantText);

  const body = JSON.stringify(await response.json());
  assert.equal(body.includes(privateUserText), false);
  assert.equal(body.includes(privateAssistantText), false);
  assert.equal(body.includes("provider-object-secret-text"), false);
});

test("Relationship OS DLMF ingress rejects cross-life and cross-namespace scope", async () => {
  const service = ingress();
  const wrongLife = distillationBody();
  (wrongLife.scope as Record<string, unknown>).lifeDid = "did:arthurverse:other";
  const lifeResponse = await service.handle(request(
    "/v1/relationship-os/transcript-distillations",
    wrongLife,
  ));
  assert.equal(lifeResponse.status, 400);
  assert.deepEqual(await lifeResponse.json(), { error: "relationship_os_scope_forbidden" });

  const namespaceResponse = await service.handle(request(
    "/v1/relationship-os/transcript-distillations",
    distillationBody("other.private.namespace"),
  ));
  assert.equal(namespaceResponse.status, 400);
  assert.deepEqual(await namespaceResponse.json(), { error: "relationship_os_scope_forbidden" });

  const malformedRelationshipNamespace = await service.handle(request(
    "/v1/relationship-os/transcript-distillations",
    distillationBody("relationship.private.not-a-32-hex-relationship"),
  ));
  assert.equal(malformedRelationshipNamespace.status, 400);
  assert.deepEqual(await malformedRelationshipNamespace.json(), {
    error: "relationship_os_scope_forbidden",
  });
});

test("Relationship OS DLMF retrieval emits only hydrated canonical content", async () => {
  const service = ingress();
  const response = await service.handle(request(
    "/v1/relationship-os/retrievals",
    { scope, query: "bounded memory", topK: 8 },
  ));
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.match(raw, /Arthur prefers a bounded canonical memory context/u);
  assert.equal(raw.includes("provider-object-secret-text"), false);
  assert.equal(raw.includes("retrievalEvidence"), false);
});

test("Relationship OS DLMF ingress bounds body and redacts provider/private failures", async () => {
  const service = ingress({
    onDistill: async () => {
      throw new Error(`upstream exploded: ${privateUserText} bearer=top-secret`);
    },
  });
  const failed = await service.handle(request(
    "/v1/relationship-os/transcript-distillations",
    distillationBody(),
  ));
  assert.equal(failed.status, 400);
  const failedText = await failed.text();
  assert.equal(failedText.includes(privateUserText), false);
  assert.equal(failedText.includes("top-secret"), false);
  assert.match(failedText, /dlmf_relationship_os_request_failed/u);

  const huge = new Request("https://dlmf.test/v1/relationship-os/transcript-distillations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${"x".repeat(48)}`,
      "content-type": "application/json",
      "content-length": "999999",
    },
    body: JSON.stringify(distillationBody()),
  });
  const tooLarge = await ingress().handle(huge);
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { error: "request_body_too_large" });
});

class FakeHindsightClient implements HindsightClientPort {
  retained: Array<{ bankId: string; content: string; options: NonNullable<Parameters<HindsightClientPort["retain"]>[2]> }> = [];
  recalledBank = "";

  async retain(
    bankId: string,
    content: string,
    options: Parameters<HindsightClientPort["retain"]>[2],
  ) {
    this.retained.push({ bankId, content, options: options ?? {} });
    return { success: true, bank_id: bankId, items_count: 1, async: false };
  }

  async listMemories() {
    return { items: [], total: 0, limit: 100, offset: 0 };
  }

  async recall(bankId: string) {
    this.recalledBank = bankId;
    return {
      results: [
        {
          id: "hs-good",
          text: "MALICIOUS provider text must never become canonical output",
          metadata: {
            dlmf_memory_id: "mem_aaaaaaaaaaaaaaaa",
            dlmf_revision: "2",
          },
        },
        {
          id: "hs-invalid",
          text: "invalid metadata",
          metadata: { dlmf_memory_id: "not-a-memory-id", dlmf_revision: "x" },
        },
      ],
    };
  }

  async reflect() {
    return { text: "", based_on: [] };
  }
}

test("Hindsight canonical projection uses isolated banks and returns identifier candidates only", async () => {
  const client = new FakeHindsightClient();
  const banks = new DeterministicHindsightPlaneResolver("ros-nancy");
  const port = new HindsightCanonicalProjectionPort({ client, banks });
  const canonical = revision();

  await port.project(canonical);
  assert.equal(client.retained.length, 1);
  assert.equal(client.retained[0]?.content, canonical.canonicalContent.text);
  assert.equal(client.retained[0]?.options.metadata?.dlmf_memory_id, canonical.memoryId);
  assert.equal(client.retained[0]?.options.metadata?.dlmf_revision, "2");
  assert.notEqual(banks.distillationBankId(scope), banks.projectionBankId(scope));
  assert.notEqual(
    banks.projectionBankId(scope),
    banks.projectionBankId({ ...scope, memoryNamespace: "relationship.private.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
  );

  const raw = await port.search(
    { query: "bounded", scope, topK: 8 },
    { signal: new AbortController().signal },
  ) as { providerId: string; candidates: Array<Record<string, unknown>> };
  assert.equal(client.recalledBank, banks.projectionBankId(scope));
  assert.deepEqual(raw, {
    providerId: "hindsight",
    candidates: [{
      memoryId: "mem_aaaaaaaaaaaaaaaa",
      canonicalRevision: 2,
      providerId: "hindsight",
      providerObjectId: "hs-good",
    }],
  });
  assert.equal(JSON.stringify(raw).includes("MALICIOUS"), false);
});
