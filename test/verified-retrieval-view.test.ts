import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalMemoryHead,
  MemoryId,
  MemoryRevision,
  MemoryScope,
} from "../src/domain/types.js";
import { sha256, type Clock } from "../src/domain/utils.js";
import { ValidationError, RetrievalResponseIntegrityError } from "../src/domain/errors.js";
import { VerifiedRetrievalViewService } from "../src/retrieval/verified-retrieval-view-service.js";
import {
  VERIFIED_RETRIEVAL_VIEW_CONFIG_SCHEMA,
  validateVerifiedRetrievalViewConfig,
} from "../src/retrieval/verified-retrieval-view-config.js";
import type {
  VerifiedRetrievalInput,
  VerifiedRetrievalReader,
  VerifiedRetrievalItem,
  VerifiedRetrievalResult,
} from "../src/retrieval/types.js";
import { InMemoryCanonicalMemoryStore } from "../src/store/in-memory-canonical-memory-store.js";

const PUBLIC: MemoryScope = {
  tenantId: "tenant-arthur",
  lifeDid: "did:arthurverse:nancy",
  memoryNamespace: "life",
};
const HISTORY: MemoryScope = {
  tenantId: "arthurverse-hermes-migration-pilot",
  lifeDid: "did:arthurverse:nancy",
  memoryNamespace: "pilot.hermes-historical-migration.direct1000-v1",
};
const NOW = "2026-09-20T12:00:00.000Z";

class FixedClock implements Clock {
  now(): string {
    return NOW;
  }
}

class StubReader implements VerifiedRetrievalReader {
  readonly calls: VerifiedRetrievalInput[] = [];

  constructor(
    private readonly items: readonly VerifiedRetrievalItem[],
    private readonly forcedScope?: MemoryScope,
  ) {}

  async retrieve(input: VerifiedRetrievalInput): Promise<VerifiedRetrievalResult> {
    this.calls.push(input);
    return {
      query: input.query.trim(),
      scope: this.forcedScope ?? input.scope,
      providerId: "hindsight",
      effectiveAt: input.effectiveAt ?? NOW,
      items: this.items,
      verification: {
        receivedCandidates: this.items.length,
        uniqueCandidates: this.items.length,
        allowed: this.items.length,
        suppressed: 0,
        suppressionCounts: {},
      },
    };
  }
}

function revision(
  scope: MemoryScope,
  memoryId: MemoryId,
  semanticKey: string,
  text: string,
  status: "active" | "tombstoned" | "superseded" = "active",
  revisionNumber = 1,
): MemoryRevision {
  const canonicalContent = { text };
  return {
    memoryId,
    revision: revisionNumber,
    scope,
    memoryClass: "preference",
    memoryKind: "user_preference",
    memoryType: "preference",
    speakerProvenance: "user",
    semanticKey,
    status,
    canonicalContent,
    contentHash: sha256(canonicalContent),
    author: { lifeDid: scope.lifeDid, agentId: "nancy" },
    provenance: {
      sourceType: "test",
      sourceId: `source:${memoryId}`,
      candidateId: `cand_${memoryId}`,
      candidateFingerprint: `semantic:${memoryId}`,
      producer: { kind: "system", id: "view-test" },
      sourceExperienceRefs: [],
    },
    evidenceRefs: [{ sourceType: "test", sourceRef: memoryId }],
    epistemicStatus: "user_asserted",
    producer: { kind: "system", id: "view-test" },
    sourceExperienceRefs: [],
    semanticFingerprint: `semantic:${memoryId}`,
    observedAt: "2026-09-19T00:00:00.000Z",
    committedAt: "2026-09-19T00:00:01.000Z",
    commitSeq: revisionNumber,
  };
}

async function seed(
  store: InMemoryCanonicalMemoryStore,
  value: MemoryRevision,
): Promise<void> {
  const head: CanonicalMemoryHead = {
    memoryId: value.memoryId,
    scope: value.scope,
    memoryClass: value.memoryClass,
    memoryKind: value.memoryKind,
    memoryType: value.memoryType,
    semanticKey: value.semanticKey,
    currentRevision: value.revision,
    status: value.status,
    createdAt: value.committedAt,
    updatedAt: value.committedAt,
  };
  await store.transaction(async (tx) => {
    await tx.appendRevision(value);
    await tx.putHead(head);
  });
}

function item(value: MemoryRevision, rank = 1): VerifiedRetrievalItem {
  return {
    memoryId: value.memoryId,
    canonicalRevision: value.revision,
    revision: value,
    retrievalEvidence: {
      providerId: "hindsight",
      claimedCanonicalRevision: value.revision,
      providerRank: rank,
      providerObjectId: `provider:${value.memoryId}`,
    },
  };
}

function view(
  primaryStore: InMemoryCanonicalMemoryStore,
  primary: VerifiedRetrievalReader,
  historical: VerifiedRetrievalReader,
): VerifiedRetrievalViewService {
  return new VerifiedRetrievalViewService({
    viewId: "nancy-life",
    publicScope: PUBLIC,
    primaryRetrieval: primary,
    primaryStore,
    historicalMounts: [{
      mountId: "hermes-history-20260920",
      scope: HISTORY,
      retrieval: historical,
      mode: "read_only_historical",
    }],
    clock: new FixedClock(),
  });
}

test("memory view exposes one public scope while preserving mounted canonical scope", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  const primary = new StubReader([]);
  const historicalRevision = revision(
    HISTORY,
    "mem_history",
    "preference:user:language",
    "Use Traditional Chinese.",
  );
  const historical = new StubReader([item(historicalRevision)]);
  const service = view(store, primary, historical);
  const freshness = { requiredCommitSeq: 8, maxCommitLag: 0 };

  const result = await service.retrieve({
    query: "language",
    scope: PUBLIC,
    topK: 5,
    freshness,
  });

  assert.deepEqual(result.scope, PUBLIC);
  assert.equal(result.providerId, "dlmf-memory-view:nancy-life");
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0]?.revision.scope, HISTORY);
  assert.equal(result.items[0]?.revision.canonicalContent.text, "Use Traditional Chinese.");
  assert.deepEqual(primary.calls[0]?.freshness, freshness);
  assert.equal(historical.calls[0]?.freshness, undefined);
  assert.deepEqual(historical.calls[0]?.scope, HISTORY);
  assert.deepEqual(result.view, {
    viewId: "nancy-life",
    mountCount: 1,
    primaryOverrides: 0,
    primarySuppressions: 0,
    mountedAllowed: 1,
  });
});

test("primary current semantic revision replaces a historical hit even when primary search missed it", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  const current = revision(
    PUBLIC,
    "mem_live",
    "preference:user:language",
    "Use concise Traditional Chinese.",
    "active",
    2,
  );
  await seed(store, current);
  const historicalRevision = revision(
    HISTORY,
    "mem_history",
    current.semanticKey,
    "Use Traditional Chinese.",
  );
  const result = await view(
    store,
    new StubReader([]),
    new StubReader([item(historicalRevision, 3)]),
  ).retrieve({
    query: "language",
    scope: PUBLIC,
    topK: 5,
  });

  assert.deepEqual(result.items.map((entry) => entry.memoryId), ["mem_live"]);
  assert.deepEqual(result.items[0]?.revision.scope, PUBLIC);
  assert.equal(result.items[0]?.revision.canonicalContent.text, "Use concise Traditional Chinese.");
  assert.equal(result.items[0]?.retrievalEvidence.providerId, "dlmf-memory-view:nancy-life");
  assert.equal(result.view?.primaryOverrides, 1);
  assert.equal(result.verification.suppressed, 0);
});

test("primary tombstone suppresses the matching historical semantic key", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  const forgotten = revision(
    PUBLIC,
    "mem_forgotten",
    "preference:user:notifications",
    "Send daily notifications.",
    "tombstoned",
    2,
  );
  await seed(store, forgotten);
  const historicalRevision = revision(
    HISTORY,
    "mem_history_notice",
    forgotten.semanticKey,
    "Send daily notifications.",
  );
  const result = await view(
    store,
    new StubReader([]),
    new StubReader([item(historicalRevision)]),
  ).retrieve({
    query: "notifications",
    scope: PUBLIC,
    topK: 5,
  });

  assert.equal(result.items.length, 0);
  assert.equal(result.view?.primarySuppressions, 1);
  assert.equal(result.verification.suppressionCounts.VIEW_PRIMARY_SUPPRESSION, 1);
  assert.equal(result.verification.suppressed, 1);
});

test("primary search result wins over the same semantic key from history without duplication", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  const current = revision(
    PUBLIC,
    "mem_live",
    "preference:user:language",
    "Use concise Traditional Chinese.",
  );
  await seed(store, current);
  const historicalRevision = revision(
    HISTORY,
    "mem_history",
    current.semanticKey,
    "Use Traditional Chinese.",
  );
  const result = await view(
    store,
    new StubReader([item(current)]),
    new StubReader([item(historicalRevision)]),
  ).retrieve({
    query: "language",
    scope: PUBLIC,
    topK: 5,
  });

  assert.deepEqual(result.items.map((entry) => entry.memoryId), ["mem_live"]);
  assert.equal(result.verification.suppressionCounts.VIEW_PRIMARY_OVERRIDE, 1);
  assert.equal(result.verification.suppressed, 1);
});

test("memory view fails closed on foreign life, wrong public scope, or escaped mount scope", async () => {
  const store = new InMemoryCanonicalMemoryStore();
  const primary = new StubReader([]);
  assert.throws(
    () => new VerifiedRetrievalViewService({
      viewId: "nancy-life",
      publicScope: PUBLIC,
      primaryRetrieval: primary,
      primaryStore: store,
      historicalMounts: [{
        mountId: "foreign",
        scope: { ...HISTORY, lifeDid: "did:arthurverse:luna" },
        retrieval: new StubReader([]),
        mode: "read_only_historical",
      }],
    }),
    ValidationError,
  );

  const service = view(store, primary, new StubReader([]));
  await assert.rejects(
    service.retrieve({
      query: "memory",
      scope: { ...PUBLIC, memoryNamespace: "wrong" },
    }),
    ValidationError,
  );

  const escaped = view(
    store,
    primary,
    new StubReader([], { ...HISTORY, memoryNamespace: "other-history" }),
  );
  await assert.rejects(
    escaped.retrieve({ query: "memory", scope: PUBLIC }),
    RetrievalResponseIntegrityError,
  );
});

test("memory view config accepts only same-life read-only mounts bound to the public scope", () => {
  const valid = {
    schema: VERIFIED_RETRIEVAL_VIEW_CONFIG_SCHEMA,
    viewId: "nancy-life",
    publicScope: PUBLIC,
    mounts: [{
      mountId: "hermes-history-20260920",
      schema: "dlmf_pilot_hermes_adapter_direct1000_shadow_v3",
      scope: HISTORY,
      hindsightBankPrefix: "dlmf-hermes-adapter-direct-phase2-v2",
      mode: "read_only_historical",
    }],
  };
  assert.deepEqual(
    validateVerifiedRetrievalViewConfig(valid, PUBLIC),
    valid,
  );

  assert.throws(
    () => validateVerifiedRetrievalViewConfig({
      ...valid,
      publicScope: { ...PUBLIC, memoryNamespace: "wrong" },
    }, PUBLIC),
    ValidationError,
  );
  assert.throws(
    () => validateVerifiedRetrievalViewConfig({
      ...valid,
      mounts: [{
        ...valid.mounts[0],
        scope: { ...HISTORY, lifeDid: "did:arthurverse:luna" },
      }],
    }, PUBLIC),
    ValidationError,
  );
  assert.throws(
    () => validateVerifiedRetrievalViewConfig({
      ...valid,
      mounts: [{ ...valid.mounts[0], mode: "read_write" }],
    }, PUBLIC),
    ValidationError,
  );
  assert.throws(
    () => validateVerifiedRetrievalViewConfig({
      ...valid,
      unexpected: true,
    }, PUBLIC),
    ValidationError,
  );
});

