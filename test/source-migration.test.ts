import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DistillationReceipt } from "../src/distillation/types.js";
import type {
  DiscoverRequest,
  ExperienceUnit,
  NormalizedExperience,
  SourceAdapterInspection,
  SourceReadResult,
} from "../src/source-adapters/contracts.js";
import { experienceIdFor } from "../src/source-adapters/identity.js";
import {
  BoundedSourceMigrationRunner,
  JsonFileSourceMigrationStateStore,
  type SourceMigrationEligibilityPolicy,
  type SourceMigrationState,
  type SourceMigrationStateStore,
} from "../src/source-adapters/source-migration.js";
import type { MemorySourceAdapter } from "../src/source-adapters/source-adapter.js";

interface FakePayload { unit: ExperienceUnit; text: string }

const fixedClock = (() => {
  let tick = 0;
  return () => new Date(Date.parse("2026-09-12T12:00:00.000Z") + tick++ * 1000);
})();

function unit(id: string, metadata: Record<string, unknown> = {}): ExperienceUnit {
  const source = { sourceSystem: "fake", sourceType: "thread", sourceId: id };
  return {
    source,
    experienceId: experienceIdFor(source),
    startedAt: { certainty: "unknown" },
    endedAt: { certainty: "unknown" },
    metadata,
  };
}

class FakeAdapter implements MemorySourceAdapter<FakePayload> {
  readonly name = "FakeSourceAdapter";
  readonly version = "1.0.0";
  readonly units = [unit("a"), unit("b", { skip: true }), unit("c")];
  failReadFor: string | undefined;
  fingerprintOverrideFor: string | undefined;

  async inspect(): Promise<SourceAdapterInspection> {
    return {
      adapterName: this.name,
      adapterVersion: this.version,
      sourceSystem: "fake",
      sourceType: "thread",
      capabilities: {
        historicalImport: "full",
        incrementalSync: "partial",
        stableSourceId: "full",
        timestamps: "unknown",
        toolEvents: "none",
        attachments: "none",
        deletionDetection: "unknown",
      },
      metadata: {},
    };
  }

  async discover(request: DiscoverRequest) {
    assert.equal(request.limit, 1);
    const cursor = request.cursor ?? request.checkpoint?.cursor;
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(start) || start < 0) throw new Error("bad fake cursor");
    const found = this.units[start];
    if (found === undefined) return { units: [] };
    const next = start + 1;
    return {
      units: [found],
      ...(next >= this.units.length ? {} : { nextCursor: String(next) }),
    };
  }

  async read(found: ExperienceUnit): Promise<SourceReadResult<FakePayload>> {
    if (this.failReadFor === found.source.sourceId) throw new Error("simulated source read failure");
    return {
      unit: found,
      payload: { unit: found, text: `text-${found.source.sourceId}` },
      readAt: "2026-09-12T12:30:00.000Z",
    };
  }

  async normalize(result: SourceReadResult<FakePayload>): Promise<NormalizedExperience> {
    const found = result.unit;
    return {
      sourceSystem: found.source.sourceSystem,
      sourceType: found.source.sourceType,
      sourceId: found.source.sourceId,
      experienceId: found.experienceId,
      startedAt: found.startedAt,
      endedAt: found.endedAt,
      actors: [{ actorId: "user", kind: "user" }],
      events: [{
        eventId: `evt-${found.source.sourceId}`,
        eventType: "message",
        actorId: "user",
        occurredAt: { certainty: "unknown" },
        content: result.payload.text,
      }],
      content: [{ mediaType: "text/plain", text: result.payload.text }],
      metadata: structuredClone(found.metadata),
      provenance: {
        source: found.source,
        sourceFingerprint: { algorithm: "sha256", value: found.source.sourceId.padEnd(64, "0").slice(0, 64) },
        adapterName: this.name,
        adapterVersion: this.version,
        discoveredAt: "2026-09-12T12:00:00.000Z",
        readAt: result.readAt,
        normalizedAt: "2026-09-12T12:30:01.000Z",
      },
    };
  }

  async fingerprint(found: ExperienceUnit) {
    const value = this.fingerprintOverrideFor === found.source.sourceId
      ? `changed-${found.source.sourceId}`
      : found.source.sourceId;
    return { algorithm: "sha256" as const, value: value.padEnd(64, "0").slice(0, 64) };
  }
}

class MemoryStateStore implements SourceMigrationStateStore {
  state: SourceMigrationState | null = null;
  saves = 0;
  async load() { return this.state === null ? null : structuredClone(this.state); }
  async save(state: SourceMigrationState) { this.saves += 1; this.state = structuredClone(state); }
}

const eligibility: SourceMigrationEligibilityPolicy = {
  version: "fake-policy-v1",
  evaluate(experience) {
    return experience.metadata.skip === true
      ? { eligible: false, reasonCode: "fixture_skip" }
      : { eligible: true, reasonCode: "eligible" };
  },
};

function completeReceipt(id: number): DistillationReceipt {
  return { receiptId: `dist_${String(id).padStart(64, "0")}`, status: "complete" } as DistillationReceipt;
}

test("bounded source migration advances one unit at a time and resumes after skip", async () => {
  const adapter = new FakeAdapter();
  const store = new MemoryStateStore();
  let receipt = 0;
  const ingested: string[] = [];
  const runner = new BoundedSourceMigrationRunner({
    adapter,
    eligibility,
    stateStore: store,
    clock: fixedClock,
    ingestor: {
      async ingest(experience) {
        ingested.push(experience.sourceId);
        return completeReceipt(++receipt);
      },
    },
  });

  const first = await runner.run({ maxUnits: 2 });
  assert.equal(first.complete, false);
  assert.equal(first.processedThisRun, 2);
  assert.equal(first.ingestedThisRun, 1);
  assert.equal(first.skippedThisRun, 1);
  assert.deepEqual(ingested, ["a"]);
  assert.equal(first.state.processedUnits, 2);
  assert.equal(first.state.ingestedUnits, 1);
  assert.equal(first.state.skippedUnits, 1);
  assert.equal(first.state.checkpoint.cursor, "2");
  assert.equal(first.state.checkpoint.lastExperienceId, adapter.units[1]!.experienceId);
  assert.deepEqual(first.state.checkpoint.lastSourceFingerprint, { algorithm: "sha256", value: "b".padEnd(64, "0") });

  const second = await runner.run({ maxUnits: 10 });
  assert.equal(second.complete, true);
  assert.equal(second.processedThisRun, 1);
  assert.equal(second.ingestedThisRun, 1);
  assert.deepEqual(ingested, ["a", "c"]);
  assert.equal(second.state.processedUnits, 3);
  assert.equal(second.state.ingestedUnits, 2);
  assert.equal(second.state.skippedUnits, 1);
  assert.equal(second.state.checkpoint.lastExperienceId, adapter.units[2]!.experienceId);
  assert.equal(second.state.checkpoint.cursor, undefined);

  const replay = await runner.run({ maxUnits: 10 });
  assert.equal(replay.processedThisRun, 0);
  assert.equal(replay.complete, true);
  assert.deepEqual(ingested, ["a", "c"]);
});

test("failed DLMF receipt does not advance migration checkpoint", async () => {
  const store = new MemoryStateStore();
  const runner = new BoundedSourceMigrationRunner({
    adapter: new FakeAdapter(),
    eligibility,
    stateStore: store,
    ingestor: {
      async ingest() {
        return { receiptId: `dist_${"f".repeat(64)}`, status: "failed" } as Pick<DistillationReceipt, "receiptId" | "status">;
      },
    },
  });
  await assert.rejects(
    () => runner.run({ maxUnits: 1 }),
    /did not reach an accepted terminal state: failed/,
  );
  assert.equal(store.state, null);
  assert.equal(store.saves, 0);
});

test("source read failure after a committed unit preserves the last durable checkpoint", async () => {
  const adapter = new FakeAdapter();
  adapter.failReadFor = "c";
  const store = new MemoryStateStore();
  const runner = new BoundedSourceMigrationRunner({
    adapter,
    eligibility,
    stateStore: store,
    ingestor: { async ingest() { return completeReceipt(1); } },
  });
  await runner.run({ maxUnits: 2 });
  const before = structuredClone(store.state);
  await assert.rejects(() => runner.run({ maxUnits: 1 }), /simulated source read failure/);
  assert.deepEqual(store.state, before);
});

test("eligibility policy version drift fails closed before discovery resumes", async () => {
  const store = new MemoryStateStore();
  const base = new BoundedSourceMigrationRunner({
    adapter: new FakeAdapter(),
    eligibility,
    stateStore: store,
    ingestor: { async ingest() { return completeReceipt(1); } },
  });
  await base.run({ maxUnits: 1 });
  const changed = new BoundedSourceMigrationRunner({
    adapter: new FakeAdapter(),
    eligibility: { ...eligibility, version: "fake-policy-v2" },
    stateStore: store,
    ingestor: { async ingest() { return completeReceipt(2); } },
  });
  await assert.rejects(
    () => changed.run({ maxUnits: 1 }),
    /eligibility policy version changed/,
  );
});

test("JSON migration state store persists private atomic resumable state", async () => {
  const root = join(tmpdir(), `dlmf-source-migration-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const path = join(root, "state.json");
  const store = new JsonFileSourceMigrationStateStore(path);
  assert.equal(await store.load(), null);
  const state: SourceMigrationState = {
    schemaVersion: 1,
    adapterName: "FakeSourceAdapter",
    adapterVersion: "1.0.0",
    sourceSystem: "fake",
    sourceType: "thread",
    eligibilityPolicyVersion: "fake-policy-v1",
    checkpoint: {
      adapterName: "FakeSourceAdapter",
      adapterVersion: "1.0.0",
      sourceSystem: "fake",
      sourceType: "thread",
      cursor: "17",
      lastExperienceId: experienceIdFor({ sourceSystem: "fake", sourceType: "thread", sourceId: "17" }),
      updatedAt: "2026-09-12T12:00:00.000Z",
    },
    processedUnits: 17,
    ingestedUnits: 16,
    skippedUnits: 1,
    complete: false,
    updatedAt: "2026-09-12T12:00:00.000Z",
  };
  await store.save(state);
  assert.deepEqual(await store.load(), state);
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.match(await readFile(path, "utf8"), /"cursor": "17"/);
});


test("source fingerprint drift fails closed without advancing durable checkpoint", async () => {
  const adapter = new FakeAdapter();
  adapter.fingerprintOverrideFor = "a";
  const store = new MemoryStateStore();
  const runner = new BoundedSourceMigrationRunner({
    adapter,
    eligibility,
    stateStore: store,
    ingestor: { async ingest() { return completeReceipt(1); } },
  });
  await assert.rejects(
    () => runner.run({ maxUnits: 1 }),
    /source changed between normalization and fingerprint verification/,
  );
  assert.equal(store.state, null);
  assert.equal(store.saves, 0);
});
