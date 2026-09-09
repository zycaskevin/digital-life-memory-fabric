import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalMemoryHead,
  MemoryId,
  MemoryRevision,
  MemoryScope,
} from "../src/domain/types.js";
import { DlmfDevelopmentReferenceGateway } from "../src/integration/development-reference-http.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SCOPE: MemoryScope = {
  tenantId: "tenant-arthur",
  lifeDid: "did:arthurverse:nancy",
  memoryNamespace: "life",
};

function head(): CanonicalMemoryHead {
  return {
    memoryId: "mem_gateway_audit_001",
    scope: SCOPE,
    memoryClass: "episode",
    memoryKind: "audit",
    memoryType: "event",
    semanticKey: "event:gateway:audit",
    currentRevision: 1,
    status: "active",
    createdAt: "2026-09-06T03:10:00.000Z",
    updatedAt: "2026-09-06T03:10:00.000Z",
  };
}

function revision(): MemoryRevision {
  return {
    memoryId: "mem_gateway_audit_001",
    revision: 1,
    scope: SCOPE,
    memoryClass: "episode",
    memoryKind: "audit",
    memoryType: "event",
    speakerProvenance: "unknown",
    semanticKey: "event:gateway:audit",
    status: "active",
    canonicalContent: { text: "must not be transported" },
    contentHash: "sha256-gateway-audit-001",
    author: { lifeDid: SCOPE.lifeDid, agentId: "nancy" },
    provenance: {
      sourceType: "audit",
      sourceId: "gateway-audit-001",
      candidateId: "cand_gateway_audit_001",
      candidateFingerprint: "candidate-gateway-audit-001",
      producer: { kind: "runtime", id: "test" },
      sourceExperienceRefs: [],
    },
    evidenceRefs: [],
    epistemicStatus: "observed",
    producer: { kind: "runtime", id: "test" },
    sourceExperienceRefs: [],
    semanticFingerprint: "semantic-gateway-audit-001",
    committedAt: "2026-09-06T03:10:00.000Z",
    commitSeq: 1,
  };
}

function service(counters: { heads: number; revisions: number }) {
  const headValue = head();
  const revisionValue = revision();
  return new DlmfDevelopmentReferenceGateway({
    bearerToken: TOKEN,
    allowedScope: SCOPE,
    store: {
      async getHead(memoryId: MemoryId) {
        counters.heads += 1;
        return memoryId === headValue.memoryId ? headValue : undefined;
      },
      async getRevision(memoryId: MemoryId, revisionNumber: number) {
        counters.revisions += 1;
        return memoryId === revisionValue.memoryId && revisionNumber === 1
          ? revisionValue
          : undefined;
      },
    },
  });
}

function request(query: string): Request {
  return new Request(
    `http://127.0.0.1:8794/v1/development/canonical-references/mem_gateway_audit_001${query}`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
}

test("Development reference gateway rejects unknown query parameters before store lookup", async () => {
  const counters = { heads: 0, revisions: 0 };
  const response = await service(counters).handle(
    request("?revision=1&query=secret"),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "development_reference_query_invalid",
  });
  assert.deepEqual(counters, { heads: 0, revisions: 0 });
});

test("Development reference gateway rejects duplicate revision parameters before store lookup", async () => {
  const counters = { heads: 0, revisions: 0 };
  const response = await service(counters).handle(
    request("?revision=1&revision=current"),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "development_reference_query_invalid",
  });
  assert.deepEqual(counters, { heads: 0, revisions: 0 });
});
