import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalVerifier,
  DeterministicHindsightPlaneResolver,
  HindsightCanonicalProjectionPort,
  InMemoryCanonicalMemoryStore,
  RetrievalResponseIntegrityError,
  VerifiedRetrievalService,
  sha256,
  type CanonicalMemoryHead,
  type HindsightClientPort,
  type MemoryRevision,
  type MemoryScope,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "projection-test",
  lifeDid: "did:arthurverse:nancy",
  memoryNamespace: "isolated-test",
};
const now = "2026-09-26T00:00:00.000Z";
const clock = { now: () => now };

function hit(memoryId: string, revision: number, suffix = "") {
  return {
    id: `${memoryId}-r${revision}${suffix}`,
    text: "UNTRUSTED_PROVIDER_TEXT",
    metadata: { dlmf_memory_id: memoryId, dlmf_revision: String(revision) },
  };
}
function port(results: ReturnType<typeof hit>[]) {
  const client = {
    async recall() { return { results }; },
  } as unknown as HindsightClientPort;
  return new HindsightCanonicalProjectionPort({
    client,
    banks: new DeterministicHindsightPlaneResolver("projection-regression"),
  });
}
async function seed(
  store: InMemoryCanonicalMemoryStore,
  memoryId: `mem_${string}`,
  revisionNumber: number,
  status: "active" | "tombstoned" = "active",
  memoryScope = scope,
) {
  const canonicalContent = { text: `CANONICAL:${memoryId}:r${revisionNumber}` };
  const revision: MemoryRevision = {
    memoryId, revision: revisionNumber, scope: memoryScope,
    memoryClass: "semantic_assertion", memoryKind: "projection_test",
    memoryType: "general_fact", speakerProvenance: "system",
    semanticKey: `general_fact:test:${memoryId}`, status, canonicalContent,
    contentHash: sha256(canonicalContent), author: { lifeDid: memoryScope.lifeDid },
    provenance: {
      sourceType: "test", candidateId: `cand_${memoryId}`,
      candidateFingerprint: `fingerprint:${memoryId}`,
      producer: { kind: "system", id: "projection-test" }, sourceExperienceRefs: [],
    },
    evidenceRefs: [{ sourceType: "test", sourceRef: memoryId }],
    epistemicStatus: "system_observed", producer: { kind: "system", id: "projection-test" },
    sourceExperienceRefs: [], semanticFingerprint: `fingerprint:${memoryId}`,
    committedAt: now, commitSeq: revisionNumber,
  };
  const head: CanonicalMemoryHead = {
    memoryId, scope: memoryScope, memoryClass: revision.memoryClass,
    memoryKind: revision.memoryKind, memoryType: revision.memoryType,
    semanticKey: revision.semanticKey, currentRevision: revisionNumber, status,
    createdAt: now, updatedAt: now,
  };
  await store.transaction(async tx => { await tx.appendRevision(revision); await tx.putHead(head); });
}
function verified(store: InMemoryCanonicalMemoryStore, results: ReturnType<typeof hit>[]) {
  return new VerifiedRetrievalService(new CanonicalVerifier(store, clock), port(results), clock);
}

test("projection collapses versioned documents before topK and keeps identity rank", async () => {
  const output = await port([
    hit("mem_a", 1), hit("mem_a", 1, "-duplicate"), hit("mem_b", 1),
    hit("mem_a", 3), hit("mem_a", 2), hit("mem_c", 1),
  ]).search({ scope, query: "memory", topK: 2 }, { signal: new AbortController().signal }) as {
    candidates: Array<{ memoryId: string; canonicalRevision: number; providerObjectId: string }>;
  };
  assert.deepEqual(output.candidates.map(c => [c.memoryId, c.canonicalRevision]), [["mem_a", 3], ["mem_b", 1]]);
  assert.equal(output.candidates[0]?.providerObjectId, "mem_a-r3");
  assert.equal(JSON.stringify(output).includes("UNTRUSTED_PROVIDER_TEXT"), false);
});

test("versioned provider hits hydrate only the exact current canonical revision", async () => {
  const store = new InMemoryCanonicalMemoryStore(); await seed(store, "mem_current", 3);
  const result = await verified(store, [hit("mem_current", 1), hit("mem_current", 3), hit("mem_current", 2)])
    .retrieve({ scope, query: "memory", topK: 10 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.canonicalRevision, 3);
  assert.equal(result.items[0]?.revision.canonicalContent.text, "CANONICAL:mem_current:r3");
});

test("a forged higher provider revision remains suppressed without fallback", async () => {
  const store = new InMemoryCanonicalMemoryStore(); await seed(store, "mem_current", 3);
  const result = await verified(store, [hit("mem_current", 3), hit("mem_current", 999)])
    .retrieve({ scope, query: "memory", topK: 10 });
  assert.equal(result.items.length, 0);
  assert.equal(result.verification.suppressionCounts.REVISION_MISMATCH, 1);
});

test("stale, tombstoned, foreign and invalid provider references never become canonical", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  await seed(store, "mem_stale", 3); await seed(store, "mem_gone", 2, "tombstoned");
  await seed(store, "mem_foreign", 2, "active", { ...scope, lifeDid: "did:arthurverse:other" });
  const result = await verified(store, [
    hit("mem_stale", 1), hit("mem_stale", 2), hit("mem_gone", 1), hit("mem_gone", 2),
    hit("mem_foreign", 1), hit("mem_foreign", 2), hit("not-a-memory", 1), hit("mem_invalid", -1),
  ]).retrieve({ scope, query: "memory", topK: 10 });
  assert.equal(result.items.length, 0);
  assert.equal(result.verification.suppressionCounts.REVISION_MISMATCH, 1);
  assert.equal(result.verification.suppressionCounts.TOMBSTONED, 1);
  assert.equal(result.verification.suppressed, 3);
});

test("the generic verifier still rejects conflicting revision claims from an unnormalized port", async () => {
  const store = new InMemoryCanonicalMemoryStore(); await seed(store, "mem_current", 3);
  const rawPort = { async search() { return { providerId: "raw", candidates: [
    { memoryId: "mem_current", canonicalRevision: 2, providerId: "raw" },
    { memoryId: "mem_current", canonicalRevision: 3, providerId: "raw" },
  ] }; } };
  await assert.rejects(new VerifiedRetrievalService(new CanonicalVerifier(store, clock), rawPort, clock)
    .retrieve({ scope, query: "memory", topK: 10 }), RetrievalResponseIntegrityError);
});
