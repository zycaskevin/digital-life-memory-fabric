import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { experienceIdFor } from "../src/source-adapters/identity.js";
import {
  JsonFileSourceMigrationStateStore,
  type SourceMigrationState,
  validateSourceMigrationState,
} from "../src/source-adapters/source-migration.js";

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
    migrationId: "fake-destination-v1",
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
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, "utf8"), /"cursor": "17"/);
});

test("JSON migration state store fails closed on corrupt state", async () => {
  const root = join(tmpdir(), `dlmf-source-migration-corrupt-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const path = join(root, "state.json");
  const store = new JsonFileSourceMigrationStateStore(path);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "{broken", "utf8"));
  await assert.rejects(() => store.load(), /invalid JSON/);
});

test("source migration state rejects invalid optional checkpoint fields", () => {
  const state: SourceMigrationState = {
    schemaVersion: 1,
    adapterName: "FakeSourceAdapter",
    adapterVersion: "1.0.0",
    sourceSystem: "fake",
    sourceType: "thread",
    eligibilityPolicyVersion: "fake-policy-v1",
    migrationId: "fake-destination-v1",
    checkpoint: {
      adapterName: "FakeSourceAdapter",
      adapterVersion: "1.0.0",
      sourceSystem: "fake",
      sourceType: "thread",
      cursor: "17",
      lastSourceFingerprint: {
        algorithm: "sha256",
        value: "a".repeat(64),
      },
      updatedAt: "2026-09-12T12:00:00.000Z",
    },
    processedUnits: 17,
    ingestedUnits: 16,
    skippedUnits: 1,
    complete: false,
    updatedAt: "2026-09-12T12:00:00.000Z",
  };

  assert.throws(
    () => validateSourceMigrationState({
      ...state,
      checkpoint: { ...state.checkpoint, cursor: " " },
    }),
    /checkpoint cursor is invalid/,
  );
  assert.throws(
    () => validateSourceMigrationState({
      ...state,
      checkpoint: {
        ...state.checkpoint,
        lastSourceFingerprint: { algorithm: "sha256", value: "not-a-sha256" },
      },
    }),
    /checkpoint lastSourceFingerprint is invalid/,
  );
});
