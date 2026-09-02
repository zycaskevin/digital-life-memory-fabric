import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalVerifier,
  InMemoryCanonicalMemoryStore,
  RetrievalExecutionError,
  RetrievalResponseIntegrityError,
  ValidationError,
  VerifiedRetrievalService,
  sha256,
  type CanonicalMemoryHead,
  type Clock,
  type MemoryFreshnessRequirement,
  type MemoryId,
  type MemoryRetrievalPort,
  type MemoryRetrievalPortOptions,
  type MemoryRevision,
  type MemoryScope,
  type MemorySearchRequest,
} from "../src/index.js";

const scope: MemoryScope = {
  tenantId: "tenant_01",
  lifeDid: "did:life:nancy",
  memoryNamespace: "life.core",
};
const otherScope: MemoryScope = {
  tenantId: "tenant_02",
  lifeDid: "did:life:other",
  memoryNamespace: "life.core",
};
const now = "2026-09-03T06:00:00.000Z";

class FixedClock implements Clock {
  now(): string {
    return now;
  }
}

class StubRetrievalPort implements MemoryRetrievalPort {
  requests: MemorySearchRequest[] = [];
  options: MemoryRetrievalPortOptions[] = [];

  constructor(private readonly result: unknown) {}

  async search(
    request: MemorySearchRequest,
    options: MemoryRetrievalPortOptions,
  ): Promise<unknown> {
    this.requests.push(request);
    this.options.push(options);
    return this.result;
  }
}

interface SeedOptions {
  memoryId: MemoryId;
  memoryScope?: MemoryScope;
  revision?: number;
  status?: "active" | "tombstoned" | "superseded";
  text?: string;
  validFrom?: string;
  validUntil?: string;
  corruptHash?: boolean;
}

async function seed(
  store: InMemoryCanonicalMemoryStore,
  options: SeedOptions,
): Promise<void> {
  const memoryScope = options.memoryScope ?? scope;
  const revisionNumber = options.revision ?? 1;
  const status = options.status ?? "active";
  const canonicalContent = { text: options.text ?? options.memoryId };
  const revision: MemoryRevision = {
    memoryId: options.memoryId,
    revision: revisionNumber,
    scope: memoryScope,
    memoryClass: "semantic_assertion",
    memoryKind: "test_fact",
    status,
    canonicalContent,
    contentHash: options.corruptHash ? "sha256:corrupt" : sha256(canonicalContent),
    author: { lifeDid: memoryScope.lifeDid, agentId: "nancy" },
    provenance: {
      sourceType: "test",
      candidateId: `cand_${options.memoryId}`,
    },
    evidenceRefs: [{ sourceType: "test", sourceRef: options.memoryId }],
    committedAt: "2026-09-01T00:00:00.000Z",
    commitSeq: revisionNumber,
    ...(options.validFrom === undefined ? {} : { validFrom: options.validFrom }),
    ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }),
  };
  const head: CanonicalMemoryHead = {
    memoryId: options.memoryId,
    scope: memoryScope,
    memoryClass: revision.memoryClass,
    memoryKind: revision.memoryKind,
    currentRevision: revisionNumber,
    status,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  await store.transaction(async (tx) => {
    await tx.appendRevision(revision);
    await tx.putHead(head);
  });
}

function candidate(
  memoryId: MemoryId,
  canonicalRevision = 1,
  providerScore?: number,
) {
  return {
    memoryId,
    canonicalRevision,
    providerId: "hindsight-local",
    ...(providerScore === undefined ? {} : { providerScore }),
    providerObjectId: `document:${memoryId}`,
    metadata: { text: "provider text must not become canonical content" },
  };
}

function service(
  store: InMemoryCanonicalMemoryStore,
  port: MemoryRetrievalPort,
): VerifiedRetrievalService {
  return new VerifiedRetrievalService(
    new CanonicalVerifier(store, new FixedClock()),
    port,
    new FixedClock(),
  );
}

test("verified retrieval hydrates canonical content and preserves provider evidence only", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  await seed(store, {
    memoryId: "mem_boundary",
    text: "OmniHarness is provider execution, not canonical truth.",
  });
  const port = new StubRetrievalPort({
    providerId: "hindsight-local",
    candidates: [candidate("mem_boundary", 1, 0.91)],
    latestMaterializedCommitSeq: 42,
    metadata: { ignored: true },
  });
  const freshness: MemoryFreshnessRequirement = {
    requiredCommitSeq: 42,
    maxCommitLag: 0,
  };

  const result = await service(store, port).retrieve({
    query: "  architecture boundary  ",
    scope,
    topK: 5,
    filters: { memoryClass: ["semantic_assertion"] },
    freshness,
  });

  assert.equal(port.requests[0]?.query, "architecture boundary");
  assert.equal(port.requests[0]?.topK, 5);
  assert.deepEqual(port.options[0]?.freshness, freshness);
  assert.equal(result.items.length, 1);
  assert.equal(
    result.items[0]?.revision.canonicalContent.text,
    "OmniHarness is provider execution, not canonical truth.",
  );
  assert.deepEqual(result.items[0]?.retrievalEvidence, {
    providerId: "hindsight-local",
    claimedCanonicalRevision: 1,
    providerRank: 1,
    providerScore: 0.91,
    providerObjectId: "document:mem_boundary",
  });
  assert.equal(result.latestMaterializedCommitSeq, 42);
  assert.deepEqual(result.verification, {
    receivedCandidates: 1,
    uniqueCandidates: 1,
    allowed: 1,
    suppressed: 0,
    suppressionCounts: {},
  });
});

test("verified retrieval suppresses stale, deleted, cross-scope and time-invalid candidates", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  await seed(store, { memoryId: "mem_current" });
  await seed(store, { memoryId: "mem_stale", revision: 2 });
  await seed(store, { memoryId: "mem_tombstone", status: "tombstoned" });
  await seed(store, { memoryId: "mem_superseded", status: "superseded" });
  await seed(store, {
    memoryId: "mem_future",
    validFrom: "2026-09-04T00:00:00.000Z",
  });
  await seed(store, {
    memoryId: "mem_expired",
    validUntil: "2026-09-02T23:59:59.000Z",
  });
  await seed(store, { memoryId: "mem_other", memoryScope: otherScope });
  await seed(store, { memoryId: "mem_corrupt", corruptHash: true });
  const port = new StubRetrievalPort({
    providerId: "hindsight-local",
    candidates: [
      candidate("mem_current"),
      candidate("mem_stale"),
      candidate("mem_tombstone"),
      candidate("mem_superseded"),
      candidate("mem_future"),
      candidate("mem_expired"),
      candidate("mem_other"),
      candidate("mem_missing"),
      candidate("mem_corrupt"),
      candidate("mem_current"),
    ],
  });

  const result = await service(store, port).retrieve({
    query: "facts",
    scope,
    topK: 10,
  });

  assert.deepEqual(result.items.map((item) => item.memoryId), ["mem_current"]);
  assert.deepEqual(result.verification, {
    receivedCandidates: 10,
    uniqueCandidates: 9,
    allowed: 1,
    suppressed: 9,
    suppressionCounts: {
      DUPLICATE: 1,
      REVISION_MISMATCH: 1,
      TOMBSTONED: 1,
      SUPERSEDED: 1,
      NOT_YET_VALID: 1,
      NO_LONGER_VALID: 1,
      SCOPE_MISMATCH: 1,
      NOT_FOUND: 1,
      REVISION_INTEGRITY: 1,
    },
  });
});

test("provider response integrity fails closed before canonical hydration", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  await seed(store, { memoryId: "mem_one" });
  const invalidResults: unknown[] = [
    { providerId: "hindsight-local", candidates: "not-an-array" },
    {
      providerId: "hindsight-local",
      candidates: [{ ...candidate("mem_one"), providerId: "another-provider" }],
    },
    {
      providerId: "hindsight-local",
      candidates: [candidate("mem_one"), candidate("mem_one", 2)],
    },
  ];

  for (const result of invalidResults) {
    await assert.rejects(
      service(store, new StubRetrievalPort(result)).retrieve({
        query: "fact",
        scope,
        topK: 2,
      }),
      RetrievalResponseIntegrityError,
    );
  }
});

test("retrieval input and transport timeout are bounded", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  const never: MemoryRetrievalPort = {
    search: async (_request, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  await assert.rejects(
    service(store, never).retrieve({
      query: "fact",
      scope,
      timeoutMs: 100,
    }),
    RetrievalExecutionError,
  );
  await assert.rejects(
    service(store, new StubRetrievalPort({})).retrieve({ query: " ", scope }),
    ValidationError,
  );
  await assert.rejects(
    service(store, new StubRetrievalPort({})).retrieve({
      query: "fact",
      scope,
      topK: 101,
    }),
    ValidationError,
  );
  await assert.rejects(
    service(store, new StubRetrievalPort({})).retrieve({
      query: "fact",
      scope,
      filters: { metadata: { invalid: { nested: true } } },
    } as never),
    ValidationError,
  );
  await assert.rejects(
    service(store, new StubRetrievalPort({})).retrieve({
      query: "fact",
      scope,
      freshness: {
        requiredCommitSeq: 1,
        maxCommitLag: 0,
        allowRebuilding: "yes",
      },
    } as never),
    ValidationError,
  );

  const failing: MemoryRetrievalPort = {
    search: async () => {
      throw new Error("secret endpoint and provider details");
    },
  };
  await assert.rejects(
    service(store, failing).retrieve({ query: "fact", scope }),
    (error: unknown) => {
      assert.ok(error instanceof RetrievalExecutionError);
      assert.equal(error.message, "Provider retrieval failed");
      return true;
    },
  );
});

test("canonical head movement during hydration suppresses the candidate", async () => {
  class RacingStore extends InMemoryCanonicalMemoryStore {
    reads = 0;

    override async getHeads(memoryIds: readonly MemoryId[]) {
      const heads = await super.getHeads(memoryIds);
      this.reads += 1;
      if (this.reads < 2 || heads[0] === undefined) return heads;
      return [{ ...heads[0], currentRevision: heads[0].currentRevision + 1 }];
    }
  }

  const store = new RacingStore();
  await seed(store, { memoryId: "mem_racing" });
  const result = await service(
    store,
    new StubRetrievalPort({
      providerId: "hindsight-local",
      candidates: [candidate("mem_racing")],
    }),
  ).retrieve({ query: "race", scope });

  assert.equal(result.items.length, 0);
  assert.deepEqual(result.verification.suppressionCounts, { HEAD_CHANGED: 1 });
});
