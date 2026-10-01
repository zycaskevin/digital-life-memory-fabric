import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileIncrementalSourceCheckpointStore,
  GenericIncrementalSourceSyncService,
  INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
  assertNormalizedExperience,
  experienceIdFor,
  sha256SourceFingerprint,
  type ExperienceUnit,
  type IncrementalSourceCheckpoint,
  type IncrementalSourceCheckpointStore,
  type MemorySourceAdapter,
  type NormalizedExperience,
  type SourceReadResult,
} from "../src/index.js";

type FakePayload = { sourceId: string; text?: string };

class MemoryCheckpointStore implements IncrementalSourceCheckpointStore {
  value?: IncrementalSourceCheckpoint;
  saves = 0;
  async load() {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
  async save(value: IncrementalSourceCheckpoint) {
    this.value = structuredClone(value);
    this.saves += 1;
  }
}

class FakeAdapter implements MemorySourceAdapter<FakePayload> {
  readonly name = "FakeIncrementalSourceAdapter";
  readonly version = "1.0.0";
  readonly values = new Map<string, string | undefined>();
  readonly states = new Map<string, string>();
  mutateDuringNormalize = false;
  mutateEligibilityStateDuringNormalize = false;
  eligibilityMutationApplied = false;

  async inspect() {
    return {
      adapterName: this.name,
      adapterVersion: this.version,
      sourceSystem: "fake",
      sourceType: "conversation_session",
      capabilities: {
        historicalImport: "full" as const,
        incrementalSync: "full" as const,
        stableSourceId: "full" as const,
        timestamps: "partial" as const,
        toolEvents: "none" as const,
        attachments: "none" as const,
        deletionDetection: "none" as const,
      },
      metadata: {},
    };
  }

  #unit(sourceId: string): ExperienceUnit {
    const source = {
      sourceSystem: "fake",
      sourceType: "conversation_session",
      sourceId,
    };
    return {
      source,
      experienceId: experienceIdFor(source),
      startedAt: { certainty: "unknown" },
      endedAt: { certainty: "unknown" },
      metadata: { discoveredAt: "2026-10-01T00:00:00.000Z" },
    };
  }

  async discover(request: { cursor?: string; limit: number }) {
    const ids = [...this.values.keys()].sort();
    const filtered = ids.filter((id) => request.cursor === undefined || id > request.cursor);
    const selected = filtered.slice(0, request.limit);
    return {
      units: selected.map((id) => this.#unit(id)),
      ...(filtered.length > selected.length && selected.length > 0
        ? { nextCursor: selected.at(-1)! }
        : {}),
    };
  }

  async read(unit: ExperienceUnit): Promise<SourceReadResult<FakePayload>> {
    const text = this.values.get(unit.source.sourceId);
    return {
      unit,
      payload: {
        sourceId: unit.source.sourceId,
        ...(text === undefined ? {} : { text }),
      },
      readAt: "2026-10-01T00:00:01.000Z",
    };
  }

  async normalize(read: SourceReadResult<FakePayload>): Promise<NormalizedExperience> {
    const source = read.unit.source;
    const fingerprint = sha256SourceFingerprint(read.payload.text ?? "");
    const experience: NormalizedExperience = {
      sourceSystem: source.sourceSystem,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      experienceId: read.unit.experienceId,
      startedAt: { certainty: "unknown" },
      endedAt: { certainty: "unknown" },
      actors: [{ actorId: "fake:user", kind: "user" }],
      events: read.payload.text === undefined
        ? []
        : [{
            eventId: `${source.sourceId}:message:1`,
            eventType: "message",
            actorId: "fake:user",
            occurredAt: { certainty: "unknown" },
            content: read.payload.text,
          }],
      content: read.payload.text === undefined
        ? []
        : [{ mediaType: "text/plain", text: read.payload.text }],
      metadata: {
        eligibilityState: this.states.get(source.sourceId) ?? "stable",
      },
      provenance: {
        source,
        sourceFingerprint: fingerprint,
        adapterName: this.name,
        adapterVersion: this.version,
        discoveredAt: "2026-10-01T00:00:00.000Z",
        readAt: read.readAt,
        normalizedAt: "2026-10-01T00:00:02.000Z",
      },
    };
    assertNormalizedExperience(experience);
    if (this.mutateDuringNormalize) {
      this.values.set(source.sourceId, `${read.payload.text ?? ""}-mutated`);
    }
    if (
      this.mutateEligibilityStateDuringNormalize
      && !this.eligibilityMutationApplied
    ) {
      this.eligibilityMutationApplied = true;
      this.states.set(source.sourceId, "changed");
    }
    return experience;
  }

  async fingerprint(unit: ExperienceUnit) {
    return sha256SourceFingerprint(this.values.get(unit.source.sourceId) ?? "");
  }
}

function scope() {
  return {
    tenantId: "tenant-arthur",
    lifeDid: "did:arthurverse:nancy",
    memoryNamespace: "life",
  };
}

function receipt(index: number, status: "complete" | "awaiting_review" | "failed" = "complete") {
  return { receiptId: `dist_generic_${index}`, status } as const;
}

test("generic incremental baseline fingerprints current sources without ingestion", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "historical");
  adapter.values.set("b", "historical-two");
  const checkpointStore = new MemoryCheckpointStore();
  let ingests = 0;
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: { async ingest() { ingests += 1; return receipt(ingests); } },
    pageSize: 1,
  });

  const baseline = await service.baselineCurrent();
  assert.equal(baseline.scanned, 2);
  assert.equal(baseline.ingested, 0);
  assert.equal(ingests, 0);
  assert.equal(Object.keys(checkpointStore.value?.fingerprints ?? {}).length, 2);

  const replay = await service.runOnce();
  assert.equal(replay.changed, 0);
  assert.equal(replay.unchanged, 2);
  assert.equal(ingests, 0);
});

test("generic incremental sync ingests new and mutated sources and replays idempotently", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "first durable text");
  const checkpointStore = new MemoryCheckpointStore();
  const seen: string[] = [];
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: {
      async ingest(experience) {
        seen.push(String(experience.events[0]?.content));
        return receipt(seen.length);
      },
    },
  });

  let result = await service.runOnce();
  assert.equal(result.changed, 1);
  assert.equal(result.ingested, 1);
  assert.deepEqual(seen, ["first durable text"]);

  result = await service.runOnce();
  assert.equal(result.changed, 0);
  assert.equal(result.unchanged, 1);

  adapter.values.set("a", "changed durable text");
  result = await service.runOnce();
  assert.equal(result.changed, 1);
  assert.equal(result.ingested, 1);
  assert.deepEqual(seen, ["first durable text", "changed durable text"]);
});

test("baseline leaves deferred active sources pending so the same evidence can distill later", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("active", "durable content already complete in bytes");
  adapter.states.set("active", "active");
  const checkpointStore = new MemoryCheckpointStore();
  let ingests = 0;
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: { async ingest() { ingests += 1; return receipt(ingests); } },
    eligibilityStateKey: (experience) =>
      String(experience.metadata.eligibilityState ?? ""),
    decide: (experience) =>
      experience.metadata.eligibilityState === "active"
        ? { action: "defer", reasonCode: "session_active" }
        : { action: "distill" },
  });

  const baseline = await service.baselineCurrent();
  assert.equal(baseline.deferred, 1);
  assert.equal(baseline.unchanged, 0);
  assert.equal(checkpointStore.value?.fingerprints.active, undefined);
  assert.equal(ingests, 0);

  adapter.states.set("active", "completed");
  const result = await service.runOnce();
  assert.equal(result.ingested, 1);
  assert.equal(ingests, 1);
  assert.ok(checkpointStore.value?.fingerprints.active);
});

test("deferred source version is not checkpointed and later same fingerprint can distill", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("active", "durable content already complete in bytes");
  const checkpointStore = new MemoryCheckpointStore();
  let active = true;
  let ingests = 0;
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: { async ingest() { ingests += 1; return receipt(ingests); } },
    decide: () => active
      ? { action: "defer", reasonCode: "session_active" }
      : { action: "distill" },
  });

  let result = await service.runOnce();
  assert.equal(result.deferred, 1);
  assert.equal(ingests, 0);
  assert.equal(checkpointStore.value?.fingerprints.active, undefined);

  active = false;
  result = await service.runOnce();
  assert.equal(result.changed, 1);
  assert.equal(result.ingested, 1);
  assert.equal(ingests, 1);
  assert.ok(checkpointStore.value?.fingerprints.active);
});

test("nonterminal downstream receipt never advances the source fingerprint", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "retry me");
  const checkpointStore = new MemoryCheckpointStore();
  let attempts = 0;
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: {
      async ingest() {
        attempts += 1;
        return receipt(attempts, attempts === 1 ? "failed" : "complete");
      },
    },
  });

  let result = await service.runOnce();
  assert.equal(result.ingested, 0);
  assert.equal(result.receipts[0]?.status, "failed");
  assert.equal(checkpointStore.value?.fingerprints.a, undefined);

  result = await service.runOnce();
  assert.equal(result.ingested, 1);
  assert.equal(attempts, 2);
  assert.ok(checkpointStore.value?.fingerprints.a);
});

test("source mutation during read/normalize verification fails closed without checkpoint", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("race", "before");
  adapter.mutateDuringNormalize = true;
  const checkpointStore = new MemoryCheckpointStore();
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: { async ingest() { return receipt(1); } },
  });

  await assert.rejects(
    () => service.runOnce(),
    /source changed between normalization and fingerprint verification/,
  );
  assert.equal(checkpointStore.value, undefined);
});

test("reference-only sync emits content-free reference and never requires an ingestor", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "private durable source content");
  const checkpointStore = new MemoryCheckpointStore();
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    referenceOnly: true,
  });

  const result = await service.runOnce();
  assert.equal(result.sourceOnly, 1);
  assert.equal(result.ingested, 0);
  assert.equal(result.experiences[0]?.disposition, "REFERENCE_ONLY");
  assert.equal(JSON.stringify(result.experiences).includes("private durable source content"), false);
  assert.ok(checkpointStore.value?.fingerprints.a);
});

test("source-only and no-text paths checkpoint without distillation", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("source-only", "operational");
  adapter.values.set("empty", undefined);
  const checkpointStore = new MemoryCheckpointStore();
  let ingests = 0;
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: { async ingest() { ingests += 1; return receipt(ingests); } },
    decide: (experience) => experience.sourceId === "source-only"
      ? { action: "source_only", reasonCode: "no_user_authored_content" }
      : { action: "distill" },
  });

  const result = await service.runOnce();
  assert.equal(result.sourceOnly, 1);
  assert.equal(result.noTextualEvidence, 1);
  assert.equal(ingests, 0);
  assert.ok(checkpointStore.value?.fingerprints["source-only"]);
  assert.ok(checkpointStore.value?.fingerprints.empty);
});

test("foreign or incompatible checkpoint fails closed before source ingestion", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "durable");
  const checkpointStore = new MemoryCheckpointStore();
  checkpointStore.value = {
    contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
    adapterName: "OtherAdapter",
    adapterVersion: "1.0.0",
    sourceSystem: "fake",
    sourceType: "conversation_session",
    scope: scope(),
    processingMode: "distillation",
    policyId: "default",
    fingerprints: {},
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  let ingests = 0;
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: { async ingest() { ingests += 1; return receipt(ingests); } },
  });

  await assert.rejects(
    () => service.runOnce(),
    /does not belong to configured adapter\/source/,
  );
  assert.equal(ingests, 0);
});

test("padded scope is rejected before any source or ingestion side effect", () => {
  const adapter = new FakeAdapter();
  const checkpointStore = new MemoryCheckpointStore();
  assert.throws(
    () => new GenericIncrementalSourceSyncService({
      adapter,
      checkpointStore,
      scope: { ...scope(), tenantId: "tenant-arthur " },
      ingestor: { async ingest() { return receipt(1); } },
    }),
    /scope\.tenantId must not be empty or padded/,
  );
  assert.equal(checkpointStore.value, undefined);
});

test("checkpoint scope, processing mode and policy identity are fail-closed", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "durable");
  const checkpointStore = new MemoryCheckpointStore();

  await new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    referenceOnly: true,
    policyId: "policy-v1",
  }).runOnce();

  await assert.rejects(
    () => new GenericIncrementalSourceSyncService({
      adapter,
      checkpointStore,
      scope: scope(),
      ingestor: { async ingest() { return receipt(1); } },
      policyId: "policy-v1",
    }).runOnce(),
    /does not belong to configured adapter\/source/,
  );

  const otherLife = {
    ...scope(),
    lifeDid: "did:arthurverse:lily-001",
  };
  await assert.rejects(
    () => new GenericIncrementalSourceSyncService({
      adapter,
      checkpointStore,
      scope: otherLife,
      referenceOnly: true,
      policyId: "policy-v1",
    }).runOnce(),
    /does not belong to configured adapter\/source/,
  );

  await assert.rejects(
    () => new GenericIncrementalSourceSyncService({
      adapter,
      checkpointStore,
      scope: scope(),
      referenceOnly: true,
      policyId: "policy-v2",
    }).runOnce(),
    /does not belong to configured adapter\/source/,
  );
});

test("checkpoint safely stores prototype-like external source ids", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("__proto__", "durable-a");
  adapter.values.set("constructor", "durable-b");
  const checkpointStore = new MemoryCheckpointStore();
  let ingests = 0;
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: {
      async ingest() {
        ingests += 1;
        return receipt(ingests);
      },
    },
  });

  let result = await service.runOnce();
  assert.equal(result.ingested, 2);
  assert.equal(ingests, 2);
  assert.equal(Object.hasOwn(checkpointStore.value!.fingerprints, "__proto__"), true);
  assert.equal(Object.hasOwn(checkpointStore.value!.fingerprints, "constructor"), true);

  result = await service.runOnce();
  assert.equal(result.changed, 0);
  assert.equal(result.unchanged, 2);
  assert.equal(ingests, 2);
});

test("file checkpoint store persists validated private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-incremental-cp-"));
  try {
    const path = join(root, "checkpoint.json");
    const store = new FileIncrementalSourceCheckpointStore(path);
    const value: IncrementalSourceCheckpoint = {
      contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
      adapterName: "FakeIncrementalSourceAdapter",
      adapterVersion: "1.0.0",
      sourceSystem: "fake",
      sourceType: "conversation_session",
      scope: scope(),
      processingMode: "distillation",
      policyId: "default",
      fingerprints: { a: sha256SourceFingerprint("a").value },
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    await store.save(value);
    assert.deepEqual(await store.load(), value);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const serialized = await readFile(path, "utf8");
    assert.doesNotThrow(() => JSON.parse(serialized));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("invalid incremental decision action fails closed before ingestion", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "durable");
  const checkpointStore = new MemoryCheckpointStore();
  let ingests = 0;
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: { async ingest() { ingests += 1; return receipt(ingests); } },
    decide: () => ({ action: "deferred", reasonCode: "busy" } as any),
  });

  await assert.rejects(
    () => service.runOnce(),
    /decision action is invalid/,
  );
  assert.equal(ingests, 0);
  assert.equal(checkpointStore.value, undefined);
});

test("eligibility lifecycle drift with identical evidence fails closed before ingestion", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "durable");
  adapter.states.set("a", "completed");
  adapter.mutateEligibilityStateDuringNormalize = true;
  const checkpointStore = new MemoryCheckpointStore();
  let ingests = 0;
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: { async ingest() { ingests += 1; return receipt(ingests); } },
    eligibilityStateKey: (experience) =>
      String(experience.metadata.eligibilityState ?? ""),
    decide: (experience) =>
      experience.metadata.eligibilityState === "completed"
        ? { action: "distill" }
        : { action: "defer", reasonCode: "not_completed" },
  });

  await assert.rejects(
    () => service.runOnce(),
    /eligibility state changed before distillation/,
  );
  assert.equal(ingests, 0);
  assert.equal(checkpointStore.value, undefined);
});

test("overlapping generic runs serialize and submit one source once", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "durable");
  const checkpointStore = new MemoryCheckpointStore();
  let active = 0;
  let maxActive = 0;
  let ingests = 0;
  const make = () => new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: {
      async ingest() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        ingests += 1;
        active -= 1;
        return receipt(ingests);
      },
    },
  });

  const [first, second] = await Promise.all([make().runOnce(), make().runOnce()]);
  assert.equal(ingests, 1);
  assert.equal(maxActive, 1);
  assert.equal(first.ingested + second.ingested, 1);
  assert.equal(first.unchanged + second.unchanged, 1);
  assert.ok(checkpointStore.value?.fingerprints.a);
});



test("eligibility state is revalidated again after an async policy decision", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "durable");
  adapter.states.set("a", "completed");
  const checkpointStore = new MemoryCheckpointStore();
  let ingests = 0;
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: { async ingest() { ingests += 1; return receipt(ingests); } },
    eligibilityStateKey: (experience) =>
      String(experience.metadata.eligibilityState ?? ""),
    decide: async () => {
      adapter.states.set("a", "active");
      await Promise.resolve();
      return { action: "distill" };
    },
  });

  await assert.rejects(
    () => service.runOnce(),
    /eligibility state changed before distillation/,
  );
  assert.equal(ingests, 0);
  assert.equal(checkpointStore.value, undefined);
});

test("file checkpoint delta journal recovers per-source progress and compacts at run end", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-incremental-journal-"));
  try {
    const path = join(root, "checkpoint.json");
    const store = new FileIncrementalSourceCheckpointStore(path);
    const checkpoint: IncrementalSourceCheckpoint = {
      contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
      adapterName: "FakeIncrementalSourceAdapter",
      adapterVersion: "1.0.0",
      sourceSystem: "fake",
      sourceType: "conversation_session",
      scope: scope(),
      processingMode: "distillation",
      policyId: "default",
      fingerprints: {},
      updatedAt: "2026-10-01T00:00:00.000Z",
    };

    Object.defineProperty(checkpoint.fingerprints, "a", {
      value: sha256SourceFingerprint("a").value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    checkpoint.updatedAt = "2026-10-01T00:00:01.000Z";
    await store.appendFingerprint!(checkpoint, "a");

    let recovered = await store.load();
    assert.equal(
      recovered?.fingerprints.a,
      sha256SourceFingerprint("a").value,
    );
    assert.equal(
      (await readFile(`${path}.journal`, "utf8")).trim().split(/\r?\n/u).length,
      1,
    );

    Object.defineProperty(checkpoint.fingerprints, "b", {
      value: sha256SourceFingerprint("b").value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    checkpoint.updatedAt = "2026-10-01T00:00:02.000Z";
    await store.appendFingerprint!(checkpoint, "b");

    recovered = await store.load();
    assert.equal(
      recovered?.fingerprints.b,
      sha256SourceFingerprint("b").value,
    );
    assert.equal(
      (await readFile(`${path}.journal`, "utf8")).trim().split(/\r?\n/u).length,
      2,
    );

    await store.save(checkpoint);
    await assert.rejects(
      () => readFile(`${path}.journal`, "utf8"),
      (error: unknown) =>
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    assert.deepEqual(await store.load(), checkpoint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("sync results project downstream receipts to id and status only", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "durable");
  const checkpointStore = new MemoryCheckpointStore();
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: {
      async ingest() {
        return {
          receiptId: "dist_projected",
          status: "complete" as const,
          privateEvidence: "SECRET_RECEIPT_FIELD",
        };
      },
    },
  });

  const result = await service.runOnce();
  assert.deepEqual(result.receipts, [{
    receiptId: "dist_projected",
    status: "complete",
  }]);
  assert.equal(
    JSON.stringify(result.receipts).includes("SECRET_RECEIPT_FIELD"),
    false,
  );
});

test("file checkpoint load recovers complete journal records and truncates a torn tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-incremental-torn-journal-"));
  try {
    const path = join(root, "checkpoint.json");
    const store = new FileIncrementalSourceCheckpointStore(path);
    const checkpoint: IncrementalSourceCheckpoint = {
      contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
      adapterName: "FakeIncrementalSourceAdapter",
      adapterVersion: "1.0.0",
      sourceSystem: "fake",
      sourceType: "conversation_session",
      scope: scope(),
      processingMode: "distillation",
      policyId: "default",
      fingerprints: {},
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    Object.defineProperty(checkpoint.fingerprints, "a", {
      value: sha256SourceFingerprint("a").value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    checkpoint.updatedAt = "2026-10-01T00:00:01.000Z";
    await store.appendFingerprint!(checkpoint, "a");
    await appendFile(path + ".journal", '{"contract":"torn', "utf8");

    const recovered = await new FileIncrementalSourceCheckpointStore(path).load();
    assert.equal(
      recovered?.fingerprints.a,
      sha256SourceFingerprint("a").value,
    );
    const journal = await readFile(path + ".journal", "utf8");
    assert.equal(journal.endsWith("\n"), true);
    assert.equal(journal.includes('"contract":"torn'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file checkpoint store rejects checkpoint-file symlink aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-incremental-checkpoint-symlink-"));
  try {
    const target = join(root, "target.json");
    const alias = join(root, "alias.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, alias);
    const store = new FileIncrementalSourceCheckpointStore(alias);
    await assert.rejects(
      () => store.runExclusive!(async () => undefined),
      /checkpoint path must not be a symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file checkpoint journal rejects symlinks before writing private delta data", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-incremental-journal-symlink-"));
  try {
    const path = join(root, "checkpoint.json");
    const outside = join(root, "outside.txt");
    const store = new FileIncrementalSourceCheckpointStore(path);
    const checkpoint: IncrementalSourceCheckpoint = {
      contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
      adapterName: "FakeIncrementalSourceAdapter",
      adapterVersion: "1.0.0",
      sourceSystem: "fake",
      sourceType: "conversation_session",
      scope: scope(),
      processingMode: "distillation",
      policyId: "default",
      fingerprints: {},
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    await store.save(checkpoint);
    await writeFile(outside, "SENTINEL", "utf8");
    await symlink(outside, path + ".journal");
    Object.defineProperty(checkpoint.fingerprints, "private-source-id", {
      value: sha256SourceFingerprint("private").value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    checkpoint.updatedAt = "2026-10-01T00:00:01.000Z";

    await assert.rejects(
      () => store.appendFingerprint!(checkpoint, "private-source-id"),
      /journal must not be a symlink/,
    );
    assert.equal(await readFile(outside, "utf8"), "SENTINEL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file checkpoint store rejects a second active writer for the same path", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-incremental-lock-"));
  try {
    const path = join(root, "checkpoint.json");
    const first = new FileIncrementalSourceCheckpointStore(path);
    const second = new FileIncrementalSourceCheckpointStore(path);
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });

    const firstRun = first.runExclusive!(async () => {
      started();
      await hold;
    });
    await startedPromise;

    await assert.rejects(
      () => second.runExclusive!(async () => undefined),
      /already has an active writer/,
    );
    release();
    await firstRun;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone checkpoint load cannot recover a journal while another writer owns the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-incremental-load-lock-"));
  try {
    const path = join(root, "checkpoint.json");
    const first = new FileIncrementalSourceCheckpointStore(path);
    const second = new FileIncrementalSourceCheckpointStore(path);
    const initial: IncrementalSourceCheckpoint = {
      contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
      adapterName: "FakeIncrementalSourceAdapter",
      adapterVersion: "1.0.0",
      sourceSystem: "fake",
      sourceType: "conversation_session",
      scope: scope(),
      processingMode: "distillation",
      policyId: "default",
      fingerprints: {},
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    await first.save(initial);

    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const firstRun = first.runExclusive!(async () => {
      started();
      await hold;
    });
    await startedPromise;

    await assert.rejects(
      () => second.load(),
      /already has an active writer/,
    );
    release();
    await firstRun;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same checkpoint-store instance cannot bypass its active writer lock via load", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-incremental-same-instance-lock-"));
  try {
    const path = join(root, "checkpoint.json");
    const store = new FileIncrementalSourceCheckpointStore(path);
    const initial: IncrementalSourceCheckpoint = {
      contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
      adapterName: "FakeIncrementalSourceAdapter",
      adapterVersion: "1.0.0",
      sourceSystem: "fake",
      sourceType: "conversation_session",
      scope: scope(),
      processingMode: "distillation",
      policyId: "default",
      fingerprints: {},
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    await store.save(initial);

    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const active = store.runExclusive!(async () => {
      started();
      await hold;
    });
    await startedPromise;

    await assert.rejects(
      () => store.load(),
      /already has an active writer/,
    );
    release();
    await active;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "checkpoint journal FIFO is rejected without blocking append or recovery",
  { skip: process.platform !== "linux", timeout: 2000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dlmf-incremental-journal-fifo-"));
    try {
      const path = join(root, "checkpoint.json");
      const store = new FileIncrementalSourceCheckpointStore(path);
      const checkpoint: IncrementalSourceCheckpoint = {
        contract: INCREMENTAL_SOURCE_CHECKPOINT_CONTRACT,
        adapterName: "FakeIncrementalSourceAdapter",
        adapterVersion: "1.0.0",
        sourceSystem: "fake",
        sourceType: "conversation_session",
        scope: scope(),
        processingMode: "distillation",
        policyId: "default",
        fingerprints: {},
        updatedAt: "2026-10-01T00:00:00.000Z",
      };
      await store.save(checkpoint);
      execFileSync("mkfifo", [`${path}.journal`]);

      Object.defineProperty(checkpoint.fingerprints, "a", {
        value: sha256SourceFingerprint("a").value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      checkpoint.updatedAt = "2026-10-01T00:00:01.000Z";

      await assert.rejects(
        () => store.runExclusive!(
          async () => store.appendFingerprint!(checkpoint, "a"),
        ),
        /journal must be a regular file/,
      );
      await assert.rejects(
        () => store.load(),
        /journal must be a regular file/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("baseline revalidates eligibility after an async policy decision before checkpointing", async () => {
  const adapter = new FakeAdapter();
  adapter.values.set("a", "durable");
  adapter.states.set("a", "completed");
  const checkpointStore = new MemoryCheckpointStore();
  const service = new GenericIncrementalSourceSyncService({
    adapter,
    checkpointStore,
    scope: scope(),
    ingestor: { async ingest() { return receipt(1); } },
    eligibilityStateKey: (experience) =>
      String(experience.metadata.eligibilityState ?? ""),
    decide: async () => {
      adapter.states.set("a", "active");
      await Promise.resolve();
      return { action: "distill" };
    },
  });

  await assert.rejects(
    () => service.baselineCurrent(),
    /eligibility state changed before distillation/,
  );
  assert.equal(checkpointStore.value, undefined);
});
