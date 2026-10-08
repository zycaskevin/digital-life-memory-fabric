import assert from "node:assert/strict";
import test from "node:test";
import {
  DIGITAL_LIFE_STACK_DLMF_AUTHORITY,
  DIGITAL_LIFE_STACK_DLMF_CONTRACT,
  DigitalLifeStackDlmfIngress,
} from "../src/integration/digital-life-stack-http.js";
import type {
  DistillationReceipt,
  TranscriptDistillationInput,
} from "../src/distillation/types.js";
import type { VerifiedRetrievalResult } from "../src/retrieval/types.js";

const TOKEN = "dls-test-token-that-is-longer-than-thirty-two-bytes";
const SCOPE = {
  tenantId: "tenant-test",
  lifeDid: "did:life:test",
  memoryNamespace: "life.core",
};

function fixture(options: { ready?: boolean; schemaState?: string; allowedScope?: typeof SCOPE; withMemorySummary?: boolean; summaryScope?: typeof SCOPE; summaryInvalid?: boolean; summaryFails?: boolean } = {}) {
  let distillationCalls = 0;
  let retrievalCalls = 0;
  let summaryCalls = 0;
  let capturedInput: TranscriptDistillationInput | undefined;
  const ingress = new DigitalLifeStackDlmfIngress({
    bearerToken: TOKEN,
    agentId: "dlstack-integration",
    runtimeId: "digital-life-stack",
    ...(options.allowedScope === undefined ? {} : { allowedScope: options.allowedScope }),
    readiness: {
      async ready() {
        return {
          ready: options.ready ?? true,
          schemaState: options.schemaState ?? "current-0009",
        };
      },
    },
    policies: {
      distillationPolicyVersion: "dls-distill-v1",
      canonicalizationPolicyVersion: "dls-canonical-v1",
      admissionPolicyVersion: "dls-admission-v1",
      retentionPolicyVersion: "dls-retention-v1",
    },
    ...(options.withMemorySummary ? { namespaceSummary: {
      async getNamespaceOperationsSummary(scope: typeof SCOPE) {
        summaryCalls += 1;
        if (options.summaryFails) throw new Error("private provider message");
        return {
          scope: options.summaryScope ?? scope,
          highWatermark: 42,
          memories: { total: options.summaryInvalid ? -1 : 3, active: 2, tombstoned: 1, superseded: 0 },
          outbox: { pending: 0, processing: 0, done: 0, failed: 0 },
          devices: { total: 0, maxLag: 0 },
          materializations: { current: 0, lagging: 0, failed: 0, unavailable: 0, rebuilding: 0 },
        };
      },
    }} : {}),
    distillation: {
      async run(input) {
        distillationCalls += 1;
        capturedInput = input;
        return receipt(input);
      },
    },
    retrieval: {
      async retrieve(input) {
        retrievalCalls += 1;
        return retrieval(input.scope);
      },
    },
  });
  return {
    ingress,
    calls: () => ({ distillationCalls, retrievalCalls }),
    summaryCalls: () => summaryCalls,
    input: () => capturedInput,
  };
}

test("Digital-Life-Stack health advertises DLMF authority and exact contract", async () => {
  const { ingress } = fixture();
  const response = await ingress.handle(new Request("http://dlmf.local/health"));
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.contract, DIGITAL_LIFE_STACK_DLMF_CONTRACT);
  assert.equal(body.canonicalAuthority, DIGITAL_LIFE_STACK_DLMF_AUTHORITY);
  assert.equal(body.scopeBound, false);
  assert.equal("scope" in body, false);
});

test("life-bound ingress advertises and enforces its exact Memory scope", async () => {
  const { ingress, calls } = fixture({ allowedScope: SCOPE });
  const healthResponse = await ingress.handle(new Request("http://dlmf.local/health"));
  const health = await healthResponse.json() as { scopeBound: boolean; scope: typeof SCOPE };
  assert.equal(health.scopeBound, true);
  assert.deepEqual(health.scope, SCOPE);

  const wrong = { ...SCOPE, lifeDid: "did:life:other" };
  const experience = await ingress.handle(jsonRequest(
    "/v1/digital-life-stack/experiences",
    { ...experienceBody(), scope: wrong },
  ));
  const retrievalResponse = await ingress.handle(jsonRequest(
    "/v1/digital-life-stack/retrievals",
    { scope: wrong, query: "canonical", topK: 3 },
  ));
  assert.equal(experience.status, 400);
  assert.equal(retrievalResponse.status, 400);
  assert.deepEqual(calls(), { distillationCalls: 0, retrievalCalls: 0 });
  const error = await experience.json() as { error: string };
  assert.equal(error.error, "digital_life_stack_scope_not_allowed");
});

test("readiness fails closed on stale schema", async () => {
  const { ingress } = fixture({ ready: false, schemaState: "stale-0006" });
  const response = await ingress.handle(new Request("http://dlmf.local/ready"));
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.schemaState, "stale-0006");
});

test("authentication happens before malformed request parsing", async () => {
  const { ingress, calls } = fixture();
  const response = await ingress.handle(new Request(
    "http://dlmf.local/v1/digital-life-stack/experiences",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{not-json" },
  ));
  assert.equal(response.status, 401);
  assert.deepEqual(calls(), { distillationCalls: 0, retrievalCalls: 0 });
});

test("stale schema blocks writes before DLMF services execute", async () => {
  const { ingress, calls } = fixture({ ready: false, schemaState: "stale-0005" });
  const response = await ingress.handle(jsonRequest(
    "/v1/digital-life-stack/experiences",
    experienceBody(),
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(calls(), { distillationCalls: 0, retrievalCalls: 0 });
});

test("caller cannot inject canonical identity, promotion, or provider controls", async () => {
  const forbidden = ["canonicalMemoryId", "promotionId", "provider", "canonicalAuthority"];
  for (const field of forbidden) {
    const { ingress, calls } = fixture();
    const response = await ingress.handle(jsonRequest(
      "/v1/digital-life-stack/experiences",
      { ...experienceBody(), [field]: "attacker-controlled" },
    ));
    assert.equal(response.status, 400, field);
    assert.equal(calls().distillationCalls, 0, field);
  }
});

test("no direct canonical commit or promotion endpoint exists", async () => {
  const { ingress, calls } = fixture();
  for (const path of ["/v1/canonical/commit", "/v1/insights/promote"] ) {
    const response = await ingress.handle(jsonRequest(path, { memoryId: "mem_fake" }));
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(calls(), { distillationCalls: 0, retrievalCalls: 0 });
});

test("scoped owner memory summary exposes only canonical DLMF counts and real high-watermark", async () => {
  const { ingress, calls, summaryCalls } = fixture({ allowedScope: SCOPE, withMemorySummary: true });
  const response = await ingress.handle(new Request(
    "http://dlmf.local/v1/digital-life-stack/memories/summary",
    { headers: { authorization: `Bearer ${TOKEN}` } },
  ));
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, any>;
  assert.equal(body.schema, "dlmf.digital-life-stack-memory-summary.v1");
  assert.equal(body.canonicalAuthority, DIGITAL_LIFE_STACK_DLMF_AUTHORITY);
  assert.deepEqual(body.scope, SCOPE);
  assert.deepEqual(body.memories, { total: 3, active: 2, tombstoned: 1, superseded: 0 });
  assert.equal(body.highWatermark, 42);
  assert.equal(body.writeControl, "FROZEN");
  assert.equal(body.rawMemoryContentIncluded, false);
  assert.ok(!JSON.stringify(body).includes("private provider message"));
  assert.deepEqual(calls(), { distillationCalls: 0, retrievalCalls: 0 });
  assert.equal(summaryCalls(), 1);
});

test("owner memory summary fails closed for absent auth, unbound life, missing backend, query and stale schema", async () => {
  for (const opts of [
    { allowedScope: SCOPE, withMemorySummary: true },
    { withMemorySummary: true },
    { allowedScope: SCOPE },
    { allowedScope: SCOPE, withMemorySummary: true, ready: false },
  ]) {
    const { ingress, summaryCalls } = fixture(opts);
    const path = "http://dlmf.local/v1/digital-life-stack/memories/summary";
    const unauth = await ingress.handle(new Request(path));
    assert.equal(unauth.status, 401);
    const unknown = await ingress.handle(new Request(path, { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.equal(unknown.status, opts.allowedScope && opts.withMemorySummary && opts.ready !== false ? 200 : 503);
    if (opts.ready === false) assert.equal(summaryCalls(), 0);
    const extra = await ingress.handle(new Request(path + "?lifeDid=did:life:other", { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.equal(extra.status, 400);
  }
});

test("owner memory summary refuses cross-life responses, impossible counts and backend failures", async () => {
  for (const opts of [
    { allowedScope: SCOPE, withMemorySummary: true, summaryScope: { ...SCOPE, lifeDid: "did:life:other" } },
    { allowedScope: SCOPE, withMemorySummary: true, summaryInvalid: true },
    { allowedScope: SCOPE, withMemorySummary: true, summaryFails: true },
  ]) {
    const { ingress } = fixture(opts);
    const response = await ingress.handle(new Request("http://dlmf.local/v1/digital-life-stack/memories/summary", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    assert.equal(response.status, 503);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(typeof body.error, "string");
    assert.ok(!JSON.stringify(body).includes("private provider message"));
  }
});

test("experience ingress injects DLMF policy and returns content-free Development reference", async () => {
  const { ingress, input } = fixture();
  const response = await ingress.handle(jsonRequest(
    "/v1/digital-life-stack/experiences",
    experienceBody(),
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(input()?.origin, {
    lifeDid: SCOPE.lifeDid,
    agentId: "dlstack-integration",
    runtimeId: "digital-life-stack",
  });
  assert.equal(input()?.canonicalizationPolicyVersion, "dls-canonical-v1");
  assert.equal(input()?.admissionPolicyVersion, "dls-admission-v1");
  const body = await response.json() as {
    developmentExperienceRef: Record<string, unknown>;
    receipt: Record<string, unknown>;
  };
  assert.equal(body.developmentExperienceRef.schema, "dlmf.normalized-experience.reference.v1");
  assert.equal(body.developmentExperienceRef.authority, "digital-life-memory-fabric");
  assert.deepEqual(body.developmentExperienceRef.scope, SCOPE);
  assert.equal(body.developmentExperienceRef.disposition, "DISTILLATION_SUBMITTED");
  assert.equal((body.developmentExperienceRef.distillation as Record<string, unknown>).receiptId, "dist_test");
  assert.equal("content" in body.developmentExperienceRef, false);
  assert.equal("events" in body.developmentExperienceRef, false);
  assert.equal(body.receipt.canonicalizationOutcome, "committed");
});

test("retrieval returns only DLMF-verified canonical hydration", async () => {
  const { ingress } = fixture();
  const response = await ingress.handle(jsonRequest(
    "/v1/digital-life-stack/retrievals",
    { scope: SCOPE, query: "canonical", topK: 3 },
  ));
  assert.equal(response.status, 200);
  const body = await response.json() as { retrieval: { items: Array<Record<string, unknown>> } };
  assert.equal(body.retrieval.items[0]?.text, "canonical text");
  assert.equal(body.retrieval.items[0]?.memoryId, "mem_test");
});

function experienceBody() {
  return {
    scope: SCOPE,
    sourceType: "digital_life_experience",
    sourceId: "event:test:1",
    content: "A bounded Digital Life experience.",
    contentType: "text/plain",
  };
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://dlmf.local${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function receipt(input: TranscriptDistillationInput): DistillationReceipt {
  return {
    receiptId: "dist_test",
    scope: input.scope,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    idempotencyKey: "sha256:test",
    provider: "hindsight",
    distillationPolicyVersion: input.distillationPolicyVersion,
    semanticPolicyVersion: "semantic-v1",
    canonicalizationPolicyVersion: input.canonicalizationPolicyVersion,
    admissionPolicyVersion: input.admissionPolicyVersion,
    retentionPolicyVersion: input.retentionPolicyVersion,
    adapterVersion: "hindsight-dls-v1",
    curationProvider: "conservative",
    providerUnitCount: 1,
    curationDecisionCount: 1,
    curationOutcomes: {
      supporting_evidence_only: 0,
      rejected: 0,
      pending_review: 0,
      canonical_candidate: 1,
      canonical_merge: 0,
    },
    curationCoverageComplete: true,
    admissionComplete: true,
    candidateIds: ["cand_test"],
    canonicalMemoryIds: ["mem_test"],
    status: "complete",
    errors: [],
    warnings: [],
    canonicalizationOutcome: "committed",
    retentionState: "preserved",
    pruneEligible: false,
    attempts: 1,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

function retrieval(scope: typeof SCOPE): VerifiedRetrievalResult {
  return {
    query: "canonical",
    scope,
    providerId: "hindsight",
    effectiveAt: "2026-09-10T00:00:00.000Z",
    items: [{
      memoryId: "mem_test",
      canonicalRevision: 1,
      revision: {
        memoryId: "mem_test",
        revision: 1,
        scope,
        memoryClass: "semantic_assertion",
        memoryKind: "test",
        memoryType: "technical_fact",
        speakerProvenance: "system",
        semanticKey: "test:key",
        status: "active",
        canonicalContent: { text: "canonical text" },
        contentHash: "sha256:test",
        author: { lifeDid: scope.lifeDid, runtimeId: "dlmf" },
        provenance: {
          candidateId: "cand_test",
          sourceType: "test",
          sourceId: "test:1",
          candidateFingerprint: "sha256:test",
          producer: { kind: "system", id: "dlmf" },
          sourceExperienceRefs: [{ sourceType: "test", sourceId: "test:1" }],
        },
        evidenceRefs: [{ sourceType: "test", sourceRef: "test:1" }],
        epistemicStatus: "system_observed",
        producer: { kind: "system", id: "dlmf" },
        sourceExperienceRefs: [{ sourceType: "test", sourceId: "test:1" }],
        semanticFingerprint: "sha256:test",
        committedAt: "2026-09-10T00:00:00.000Z",
        commitSeq: 1,
      },
      retrievalEvidence: {
        providerId: "hindsight",
        claimedCanonicalRevision: 1,
        providerRank: 0,
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
