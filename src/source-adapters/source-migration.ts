import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DistillationReceipt } from "../distillation/types.js";
import type {
  NormalizedExperience,
  SourceCheckpoint,
} from "./contracts.js";

export interface HistoricalMigrationEligibilityDecision {
  eligible: boolean;
  reasonCode: string;
}

export interface HistoricalMigrationEligibilityPolicy {
  readonly version: string;
  assess(experience: NormalizedExperience):
    | HistoricalMigrationEligibilityDecision
    | Promise<HistoricalMigrationEligibilityDecision>;
}

export interface NormalizedExperienceIngestor {
  ingest(experience: NormalizedExperience): Promise<Pick<DistillationReceipt, "receiptId" | "status">>;
}

export interface SourceMigrationState {
  schemaVersion: 1;
  adapterName: string;
  adapterVersion: string;
  sourceSystem: string;
  sourceType: string;
  eligibilityPolicyVersion: string;
  migrationId: string;
  checkpoint: SourceCheckpoint;
  processedUnits: number;
  ingestedUnits: number;
  skippedUnits: number;
  complete: boolean;
  updatedAt: string;
}

export interface SourceMigrationStateStore {
  load(): Promise<SourceMigrationState | null>;
  save(state: SourceMigrationState): Promise<void>;
}

export class JsonFileSourceMigrationStateStore implements SourceMigrationStateStore {
  readonly #path: string;

  constructor(path: string) {
    if (!path.trim()) throw new Error("source migration state path must not be empty");
    this.#path = resolve(path);
  }

  async load(): Promise<SourceMigrationState | null> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("source migration state file contains invalid JSON");
    }
    return validateSourceMigrationState(parsed);
  }

  async save(state: SourceMigrationState): Promise<void> {
    const validated = validateSourceMigrationState(structuredClone(state));
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function validateSourceMigrationState(value: unknown): SourceMigrationState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source migration state must be an object");
  }
  const state = value as Partial<SourceMigrationState>;
  if (state.schemaVersion !== 1) throw new Error("unsupported source migration state schemaVersion");
  for (const [field, raw] of [
    ["adapterName", state.adapterName],
    ["adapterVersion", state.adapterVersion],
    ["sourceSystem", state.sourceSystem],
    ["sourceType", state.sourceType],
    ["eligibilityPolicyVersion", state.eligibilityPolicyVersion],
    ["migrationId", state.migrationId],
    ["updatedAt", state.updatedAt],
  ] as const) {
    if (typeof raw !== "string" || !raw.trim()) throw new Error(`source migration state ${field} is invalid`);
  }
  if (state.checkpoint === undefined || state.checkpoint === null || typeof state.checkpoint !== "object") {
    throw new Error("source migration state checkpoint is invalid");
  }
  const checkpoint = state.checkpoint as SourceCheckpoint;
  for (const [field, raw] of [
    ["adapterName", checkpoint.adapterName],
    ["adapterVersion", checkpoint.adapterVersion],
    ["sourceSystem", checkpoint.sourceSystem],
    ["sourceType", checkpoint.sourceType],
    ["updatedAt", checkpoint.updatedAt],
  ] as const) {
    if (typeof raw !== "string" || !raw.trim()) throw new Error(`source migration checkpoint ${field} is invalid`);
  }
  for (const [field, raw] of [
    ["processedUnits", state.processedUnits],
    ["ingestedUnits", state.ingestedUnits],
    ["skippedUnits", state.skippedUnits],
  ] as const) {
    if (!Number.isSafeInteger(raw) || Number(raw) < 0) throw new Error(`source migration state ${field} is invalid`);
  }
  if (typeof state.complete !== "boolean") throw new Error("source migration state complete is invalid");
  if (Number(state.ingestedUnits) + Number(state.skippedUnits) !== Number(state.processedUnits)) {
    throw new Error("source migration state counters are inconsistent");
  }
  return state as SourceMigrationState;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
