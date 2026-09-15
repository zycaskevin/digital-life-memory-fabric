import assert from "node:assert/strict";
import test from "node:test";
import type { DistillationReceipt } from "../src/distillation/types.js";
import type {
  DiscoverRequest,
  ExperienceUnit,
  NormalizedExperience,
  SourceReadResult,
} from "../src/source-adapters/contracts.js";
import {
  HistoricalExperienceMigrationRunner,
  HistoricalMigrationError,
  TextualExperienceMigrationEligibilityPolicy,
} from "../src/source-adapters/historical-migration-runner.js";
import { experienceIdFor, sha256SourceFingerprint } from "../src/source-adapters/identity.js";
import type { MemorySourceAdapter } from "../src/source-adapters/source-adapter.js";
import type {
  HistoricalMigrationEligibilityPolicy,
  SourceMigrationState,
  SourceMigrationStateStore,
} from "../src/source-adapters/source-migration.js";

interface FakePayload { sourceId: string; text?: string; fingerprint: string }

function unit(sourceId: string): ExperienceUnit {
  const source = { sourceSystem: "fake", sourceType: "thread", sourceId };
  return {
    source,
    experienceId: experienceIdFor(source),
    startedAt: { certainty: "unknown" },
    endedAt: { certainty: "unknown" },
    metadata: {},
  };
}

function normalized(payload: FakePayload, discovered: ExperienceUnit): NormalizedExperience {
  const fp = sha256SourceFingerprint(payload.fingerprint);
  return {
    sourceSystem: discovered.source.sourceSystem,
    sourceType: discovered.source.sourceType,
    sourceId: discovered.source.sourceId,
    experienceId: discovered.experienceId,
    startedAt: discovered.startedAt,
    endedAt: discovered.endedAt,
    actors: payload.text === undefined ? [] : [{ actorId: "user", kind: "user" }],
    events: payload.text === undefined ? [] : [{
      eventId: `${payload.sourceId}:1`,
      eventType: "message",
      actorId: "user",
      occurredAt: { certainty: "unknown" },
      content: payload.text,
    }],
    content: [],
    metadata: {},
    provenance: {
      source: structuredClone(discovered.source),
      sourceFingerprint: fp,
      adapterName: "FakeAdapter",
      adapterVersion: "1",
      discoveredAt: "2026-09-13T00:00:00.000Z",
      readAt: "2026-09-13T00:00:01.000Z",
      normalizedAt: "2026-09-13T00:00:02.000Z",
    },
  };
}

class FakeAdapter implements MemorySourceAdapter<FakePayload> {
  readonly name = "FakeAdapter";
  readonly version = "1";
  readonly ids = ["a", "b", "c", "d"];
  readonly reads: string[] = [];
  fingerprintOverride?: string;

  async inspect() {
    return {
      adapterName: this.name,
      adapterVersion: this.version,
      sourceSystem: "fake",
      sourceType: "thread",
      capabilities: {
        historicalImport: "full" as const,
        incrementalSync: "partial" as const,
        stableSourceId: "full" as const,
        timestamps: "partial" as const,
        toolEvents: "none" as const,
        attachments: "none" as const,
        deletionDetection: "unknown" as const,
      },
      metadata: {},
    };
  }

  async discover(request: DiscoverRequest) {
    assert.equal(request.limit, 1);
    const cursor = request.checkpoint?.cursor ?? request.cursor;
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(start) || start < 0) throw new Error("bad fake cursor");
    const id = this.ids[start];
    if (id === undefined) return { units: [] };
    const next = start + 1;
    return {
      units: [unit(id)],
      ...(next >= this.ids.length ? {} : { nextCursor: String(next) }),
    };
  }

  async read(discovered: ExperienceUnit): Promise<SourceReadResult<FakePayload>> {
    this.reads.push(discovered.source.sourceId);
    const text = discovered.source.sourceId === "b" ? undefined : `text-${discovered.source.sourceId}`;
    return {
      unit: discovered,
      payload: {
        sourceId: discovered.source.sourceId,
        ...(text === undefined ? {} : { text }),
        fingerprint: discovered.source.sourceId,
      },
      readAt: "2026-09-13T00:00:01.000Z",
    };
  }

  async normalize(read: SourceReadResult<FakePayload>) {
    return normalized(read.payload, read.unit);
  }

  async fingerprint(discovered: ExperienceUnit) {
    return sha256SourceFingerprint(this.fingerprintOverride ?? discovered.source.sourceId);
  }
}

class MemoryStateStore implements SourceMigrationStateStore {
  state: SourceMigrationState | null = null;
  saves = 0;
  async load() { return this.state === null ? null : structuredClone(this.state); }
  async save(state: SourceMigrationState) { this.saves += 1; this.state = structuredClone(state); }
}

function receipt(experienceId: string, status: DistillationReceipt["status"] = "complete") {
  return {
    receiptId: `dist_${experienceId.slice(4).padEnd(64, "0").slice(0, 64)}`,
    status,
  } as Pick<DistillationReceipt, "receiptId" | "status">;
}

test("textual migration eligibility includes renderable tool metadata", () => {
  const discovered = unit("tool-only");
  const experience = normalized(
    { sourceId: "tool-only", fingerprint: "tool-only" },
    discovered,
  );
  experience.events = [{
    eventId: "tool-only:1",
    eventType: "tool_or_message",
    occurredAt: { certainty: "unknown" },
    metadata: {
      toolName: "bounded-inspect",
      toolCalls: '[{"name":"bounded-inspect"}]',
    },
  }];

  assert.deepEqual(
    new TextualExperienceMigrationEligibilityPolicy().assess(experience),
    { eligible: true, reasonCode: "textual_evidence" },
  );
});

test("historical migration checkpoints each unit and resumes after a normalized-content skip", async () => {
  const adapter = new FakeAdapter();
  const stateStore = new MemoryStateStore();
  const ingested: string[] = [];
  const runner = new HistoricalExperienceMigrationRunner({
    adapter,
    stateStore,
    migrationId: "fake-destination-v1",
    eligibility: new TextualExperienceMigrationEligibilityPolicy(),
    ingestor: {
      async ingest(experience) {
        ingested.push(experience.sourceId);
        return receipt(experience.experienceId);
      },
    },
    clock: () => new Date("2026-09-13T00:05:00.000Z"),
  });

  const first = await runner.run({ maxUnits: 2 });
  assert.equal(first.status, "bounded");
  assert.equal(first.processedThisRun, 2);
  assert.equal(first.ingestedThisRun, 1);
  assert.equal(first.skippedThisRun, 1);
  assert.deepEqual(first.units.map((item) => item.outcome), ["ingested", "skipped"]);
  assert.equal(first.units[1]?.eligibilityReasonCode, "no_textual_evidence");
  assert.equal(first.state.checkpoint.cursor, "2");
  assert.equal(first.state.processedUnits, 2);
  assert.equal(stateStore.saves, 2);
  assert.deepEqual(ingested, ["a"]);

  const second = await runner.run({ maxUnits: 10 });
  assert.equal(second.status, "source_exhausted");
  assert.equal(second.processedThisRun, 2);
  assert.deepEqual(second.units.map((item) => item.outcome), ["ingested", "ingested"]);
  assert.equal(second.state.complete, true);
  assert.equal(second.state.processedUnits, 4);
  assert.deepEqual(ingested, ["a", "c", "d"]);

  const replay = await runner.run({ maxUnits: 10 });
  assert.equal(replay.processedThisRun, 0);
  assert.deepEqual(ingested, ["a", "c", "d"]);
});

test("failed downstream receipt leaves the prior durable checkpoint untouched", async () => {
  const adapter = new FakeAdapter();
  const stateStore = new MemoryStateStore();
  const runner = new HistoricalExperienceMigrationRunner({
    adapter,
    stateStore,
    migrationId: "fake-destination-v1",
    ingestor: {
      async ingest(experience) {
        return receipt(experience.experienceId, experience.sourceId === "c" ? "failed" : "complete");
      },
    },
  });
  await runner.run({ maxUnits: 2 });
  const before = structuredClone(stateStore.state);
  await assert.rejects(
    () => runner.run({ maxUnits: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof HistoricalMigrationError);
      assert.equal(error.failedExperienceId, unit("c").experienceId);
      assert.deepEqual(error.checkpoint, before?.checkpoint);
      return true;
    },
  );
  assert.deepEqual(stateStore.state, before);
});

test("historical migration fails closed without checkpoint advance when source mutates after normalization", async () => {
  const adapter = new FakeAdapter();
  adapter.fingerprintOverride = "mutated";
  const stateStore = new MemoryStateStore();
  const runner = new HistoricalExperienceMigrationRunner({
    adapter,
    stateStore,
    migrationId: "fake-destination-v1",
    ingestor: { async ingest(experience) { return receipt(experience.experienceId); } },
  });
  await assert.rejects(
    () => runner.run({ maxUnits: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof HistoricalMigrationError);
      assert.match(String(error.cause), /source changed/);
      return true;
    },
  );
  assert.equal(stateStore.state, null);
  assert.equal(stateStore.saves, 0);
});

test("eligibility policy version drift fails closed before resume", async () => {
  const stateStore = new MemoryStateStore();
  const adapter = new FakeAdapter();
  const base = new HistoricalExperienceMigrationRunner({
    adapter,
    stateStore,
    migrationId: "fake-destination-v1",
    ingestor: { async ingest(experience) { return receipt(experience.experienceId); } },
  });
  await base.run({ maxUnits: 1 });
  const changedPolicy: HistoricalMigrationEligibilityPolicy = {
    version: "textual-evidence-v2",
    assess: () => ({ eligible: true, reasonCode: "eligible" }),
  };
  const changed = new HistoricalExperienceMigrationRunner({
    adapter,
    stateStore,
    migrationId: "fake-destination-v1",
    eligibility: changedPolicy,
    ingestor: { async ingest(experience) { return receipt(experience.experienceId); } },
  });
  await assert.rejects(() => changed.run({ maxUnits: 1 }), /eligibility policy version changed/);
});

test("migration destination drift fails closed before resume", async () => {
  const stateStore = new MemoryStateStore();
  const adapter = new FakeAdapter();
  const first = new HistoricalExperienceMigrationRunner({
    adapter,
    stateStore,
    migrationId: "destination-a",
    ingestor: { async ingest(experience) { return receipt(experience.experienceId); } },
  });
  await first.run({ maxUnits: 1 });
  const before = structuredClone(stateStore.state);

  const changed = new HistoricalExperienceMigrationRunner({
    adapter,
    stateStore,
    migrationId: "destination-b",
    ingestor: { async ingest(experience) { return receipt(experience.experienceId); } },
  });
  await assert.rejects(
    () => changed.run({ maxUnits: 1 }),
    /destination identity changed/,
  );
  assert.deepEqual(stateStore.state, before);
});

test("historical migration accepts bounded scheduling lookahead through 128 and rejects larger windows", async () => {
  const adapter = new FakeAdapter();
  const stateStore = new MemoryStateStore();
  const runner = new HistoricalExperienceMigrationRunner({
    adapter,
    stateStore,
    migrationId: "fake-concurrency-bound-v1",
    ingestor: { async ingest(experience) { return receipt(experience.experienceId); } },
  });

  const result = await runner.run({ maxUnits: 1, concurrency: 128 });
  assert.equal(result.processedThisRun, 1);
  await assert.rejects(
    () => runner.run({ maxUnits: 1, concurrency: 129 }),
    /concurrency must be an integer between 1 and 128/,
  );
});

test("bounded concurrency uses parallel ingestion but advances only the contiguous source prefix", async () => {
  const adapter = new FakeAdapter();
  const stateStore = new MemoryStateStore();
  let active = 0;
  let maxActive = 0;
  const ingested: string[] = [];
  const runner = new HistoricalExperienceMigrationRunner({
    adapter,
    stateStore,
    migrationId: "fake-concurrent-destination-v1",
    eligibility: new TextualExperienceMigrationEligibilityPolicy(),
    ingestor: {
      async ingest(experience) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        ingested.push(experience.sourceId);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return receipt(experience.experienceId);
      },
    },
  });

  const result = await runner.run({ maxUnits: 4, concurrency: 3 });
  assert.equal(result.status, "source_exhausted");
  assert.equal(result.processedThisRun, 4);
  assert.equal(result.ingestedThisRun, 3);
  assert.equal(result.skippedThisRun, 1);
  assert.ok(maxActive >= 2);
  assert.equal(result.state.processedUnits, 4);
  assert.equal(result.state.complete, true);
  assert.deepEqual(result.units.map((item) => item.experienceId), adapter.ids.map((id) => unit(id).experienceId));
});

test("bounded concurrency never checkpoints past the first failed unit", async () => {
  const adapter = new FakeAdapter();
  const stateStore = new MemoryStateStore();
  let failC = true;
  const calls: string[] = [];
  const runner = new HistoricalExperienceMigrationRunner({
    adapter,
    stateStore,
    migrationId: "fake-concurrent-failure-v1",
    eligibility: new TextualExperienceMigrationEligibilityPolicy(),
    ingestor: {
      async ingest(experience) {
        calls.push(experience.sourceId);
        await new Promise((resolve) => setTimeout(resolve, experience.sourceId === "d" ? 1 : 5));
        return receipt(experience.experienceId, failC && experience.sourceId === "c" ? "failed" : "complete");
      },
    },
  });

  await assert.rejects(
    () => runner.run({ maxUnits: 4, concurrency: 4 }),
    (error: unknown) => {
      assert.ok(error instanceof HistoricalMigrationError);
      assert.equal(error.failedExperienceId, unit("c").experienceId);
      return true;
    },
  );
  assert.equal(stateStore.state?.processedUnits, 2);
  assert.equal(stateStore.state?.checkpoint.cursor, "2");
  assert.ok(calls.includes("d"));

  failC = false;
  const resumed = await runner.run({ maxUnits: 4, concurrency: 4 });
  assert.equal(resumed.status, "source_exhausted");
  assert.equal(resumed.processedThisRun, 2);
  assert.equal(resumed.state.processedUnits, 4);
  assert.equal(resumed.state.complete, true);
});
