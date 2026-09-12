import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DistillationReceipt } from "../distillation/types.js";
import type {
  ExperienceId,
  ExperienceUnit,
  NormalizedExperience,
  SourceAdapterInspection,
  SourceCheckpoint,
  SourceFingerprint,
} from "./contracts.js";
import type { MemorySourceAdapter } from "./source-adapter.js";
import { assertNormalizedExperience } from "./validation.js";

export interface SourceMigrationEligibilityDecision {
  eligible: boolean;
  reasonCode: string;
}

export interface SourceMigrationEligibilityPolicy {
  readonly version: string;
  evaluate(experience: NormalizedExperience): SourceMigrationEligibilityDecision | Promise<SourceMigrationEligibilityDecision>;
}


export class TextualNormalizedExperienceEligibilityPolicy implements SourceMigrationEligibilityPolicy {
  readonly version: string;

  constructor(version = "normalized-textual-evidence-v1") {
    if (!version.trim()) throw new Error("eligibility policy version must not be empty");
    this.version = version;
  }

  evaluate(experience: NormalizedExperience): SourceMigrationEligibilityDecision {
    const eventText = experience.events.some(
      (event) => typeof event.content === "string" && event.content.trim().length > 0,
    );
    const contentText = experience.content.some(
      (content) => typeof content.text === "string" && content.text.trim().length > 0,
    );
    return eventText || contentText
      ? { eligible: true, reasonCode: "textual_evidence" }
      : { eligible: false, reasonCode: "no_textual_evidence" };
  }
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

export interface SourceMigrationRunResult {
  complete: boolean;
  processedThisRun: number;
  ingestedThisRun: number;
  skippedThisRun: number;
  receiptIds: string[];
  state: SourceMigrationState;
}

export interface BoundedSourceMigrationRunnerOptions<TSourcePayload> {
  adapter: MemorySourceAdapter<TSourcePayload>;
  ingestor: NormalizedExperienceIngestor;
  eligibility: SourceMigrationEligibilityPolicy;
  stateStore: SourceMigrationStateStore;
  clock?: () => Date;
}

const ACCEPTED_RECEIPT_STATUSES = new Set(["complete", "awaiting_review"]);

function sameFingerprint(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}


export class BoundedSourceMigrationRunner<TSourcePayload = unknown> {
  readonly #adapter: MemorySourceAdapter<TSourcePayload>;
  readonly #ingestor: NormalizedExperienceIngestor;
  readonly #eligibility: SourceMigrationEligibilityPolicy;
  readonly #stateStore: SourceMigrationStateStore;
  readonly #clock: () => Date;

  constructor(options: BoundedSourceMigrationRunnerOptions<TSourcePayload>) {
    if (!options.eligibility.version.trim()) throw new Error("eligibility policy version must not be empty");
    this.#adapter = options.adapter;
    this.#ingestor = options.ingestor;
    this.#eligibility = options.eligibility;
    this.#stateStore = options.stateStore;
    this.#clock = options.clock ?? (() => new Date());
  }

  async run(options: { maxUnits: number }): Promise<SourceMigrationRunResult> {
    if (!Number.isInteger(options.maxUnits) || options.maxUnits < 1 || options.maxUnits > 1000) {
      throw new Error("maxUnits must be an integer between 1 and 1000");
    }

    const inspection = await this.#adapter.inspect();
    if (inspection.capabilities.historicalImport !== "full"
      && inspection.capabilities.historicalImport !== "partial") {
      throw new Error("source adapter does not declare historical import support");
    }

    let state = await this.#stateStore.load();
    if (state !== null) this.#assertStateCompatible(state, inspection);
    if (state?.complete === true) return this.#result(state, 0, 0, 0, []);

    let processedThisRun = 0;
    let ingestedThisRun = 0;
    let skippedThisRun = 0;
    const receiptIds: string[] = [];

    while (processedThisRun < options.maxUnits) {
      const priorCursor = state?.checkpoint.cursor;
      const page = await this.#adapter.discover({
        limit: 1,
        ...(state === null ? {} : { checkpoint: state.checkpoint }),
      });
      if (page.units.length > 1) {
        throw new Error("source adapter violated bounded migration page size");
      }
      if (page.units.length === 0) {
        state = this.#completedState(inspection, state);
        await this.#stateStore.save(state);
        break;
      }

      const unit = page.units[0]!;
      this.#assertUnitCompatible(unit, inspection);
      if (priorCursor !== undefined && page.nextCursor === priorCursor) {
        throw new Error("source adapter cursor did not advance");
      }

      const read = await this.#adapter.read(unit);
      const normalized = await this.#adapter.normalize(read);
      assertNormalizedExperience(normalized);
      this.#assertNormalizedMatchesUnit(normalized, unit);
      const fingerprint = await this.#adapter.fingerprint(unit);
      if (!sameFingerprint(fingerprint, normalized.provenance.sourceFingerprint)) {
        throw new Error("source changed between normalization and fingerprint verification");
      }

      const eligibility = await this.#eligibility.evaluate(normalized);
      this.#assertEligibility(eligibility);

      if (eligibility.eligible) {
        const receipt = await this.#ingestor.ingest(normalized);
        if (!ACCEPTED_RECEIPT_STATUSES.has(receipt.status)) {
          throw new Error(`DLMF distillation did not reach an accepted terminal state: ${receipt.status}`);
        }
        receiptIds.push(receipt.receiptId);
        ingestedThisRun += 1;
      } else {
        skippedThisRun += 1;
      }

      processedThisRun += 1;
      state = this.#advancedState(
        inspection,
        state,
        unit.experienceId,
        page.nextCursor,
        fingerprint,
        eligibility.eligible,
      );
      await this.#stateStore.save(state);
      if (state.complete) break;
    }

    if (state === null) {
      throw new Error("source migration produced no state");
    }
    return this.#result(
      state,
      processedThisRun,
      ingestedThisRun,
      skippedThisRun,
      receiptIds,
    );
  }

  #advancedState(
    inspection: SourceAdapterInspection,
    prior: SourceMigrationState | null,
    experienceId: ExperienceId,
    nextCursor: string | undefined,
    fingerprint: SourceFingerprint | undefined,
    ingested: boolean,
  ): SourceMigrationState {
    const now = this.#clock().toISOString();
    return {
      schemaVersion: 1,
      adapterName: inspection.adapterName,
      adapterVersion: inspection.adapterVersion,
      sourceSystem: inspection.sourceSystem,
      sourceType: inspection.sourceType,
      eligibilityPolicyVersion: this.#eligibility.version,
      checkpoint: {
        adapterName: inspection.adapterName,
        adapterVersion: inspection.adapterVersion,
        sourceSystem: inspection.sourceSystem,
        sourceType: inspection.sourceType,
        ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
        lastExperienceId: experienceId,
        ...(fingerprint === undefined ? {} : { lastSourceFingerprint: fingerprint }),
        updatedAt: now,
      },
      processedUnits: (prior?.processedUnits ?? 0) + 1,
      ingestedUnits: (prior?.ingestedUnits ?? 0) + (ingested ? 1 : 0),
      skippedUnits: (prior?.skippedUnits ?? 0) + (ingested ? 0 : 1),
      complete: nextCursor === undefined,
      updatedAt: now,
    };
  }

  #completedState(
    inspection: SourceAdapterInspection,
    prior: SourceMigrationState | null,
  ): SourceMigrationState {
    const now = this.#clock().toISOString();
    return {
      schemaVersion: 1,
      adapterName: inspection.adapterName,
      adapterVersion: inspection.adapterVersion,
      sourceSystem: inspection.sourceSystem,
      sourceType: inspection.sourceType,
      eligibilityPolicyVersion: this.#eligibility.version,
      checkpoint: prior?.checkpoint ?? {
        adapterName: inspection.adapterName,
        adapterVersion: inspection.adapterVersion,
        sourceSystem: inspection.sourceSystem,
        sourceType: inspection.sourceType,
        updatedAt: now,
      },
      processedUnits: prior?.processedUnits ?? 0,
      ingestedUnits: prior?.ingestedUnits ?? 0,
      skippedUnits: prior?.skippedUnits ?? 0,
      complete: true,
      updatedAt: now,
    };
  }

  #assertStateCompatible(state: SourceMigrationState, inspection: SourceAdapterInspection): void {
    if (state.schemaVersion !== 1) throw new Error("unsupported source migration state schemaVersion");
    if (
      state.adapterName !== inspection.adapterName
      || state.adapterVersion !== inspection.adapterVersion
      || state.sourceSystem !== inspection.sourceSystem
      || state.sourceType !== inspection.sourceType
    ) {
      throw new Error("source migration state does not belong to the configured adapter/source");
    }
    if (state.eligibilityPolicyVersion !== this.#eligibility.version) {
      throw new Error("source migration eligibility policy version changed; explicit migration-state review is required");
    }
    if (
      state.checkpoint.adapterName !== state.adapterName
      || state.checkpoint.adapterVersion !== state.adapterVersion
      || state.checkpoint.sourceSystem !== state.sourceSystem
      || state.checkpoint.sourceType !== state.sourceType
    ) {
      throw new Error("source migration checkpoint identity is inconsistent with migration state");
    }
  }

  #assertUnitCompatible(unit: ExperienceUnit, inspection: SourceAdapterInspection): void {
    if (
      unit.source.sourceSystem !== inspection.sourceSystem
      || unit.source.sourceType !== inspection.sourceType
    ) {
      throw new Error("source adapter discovered a unit outside its inspected source identity");
    }
  }

  #assertNormalizedMatchesUnit(experience: NormalizedExperience, unit: ExperienceUnit): void {
    if (
      experience.experienceId !== unit.experienceId
      || experience.sourceSystem !== unit.source.sourceSystem
      || experience.sourceType !== unit.source.sourceType
      || experience.sourceId !== unit.source.sourceId
    ) {
      throw new Error("normalized experience identity does not match discovered unit");
    }
  }

  #assertEligibility(decision: SourceMigrationEligibilityDecision): void {
    if (!decision.reasonCode.trim() || decision.reasonCode.length > 128) {
      throw new Error("eligibility decision reasonCode must contain 1..128 characters");
    }
  }

  #result(
    state: SourceMigrationState,
    processedThisRun: number,
    ingestedThisRun: number,
    skippedThisRun: number,
    receiptIds: string[],
  ): SourceMigrationRunResult {
    return {
      complete: state.complete,
      processedThisRun,
      ingestedThisRun,
      skippedThisRun,
      receiptIds,
      state: structuredClone(state),
    };
  }
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
    return validateState(parsed);
  }

  async save(state: SourceMigrationState): Promise<void> {
    const validated = validateState(structuredClone(state));
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

function validateState(value: unknown): SourceMigrationState {
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
    ["updatedAt", state.updatedAt],
  ] as const) {
    if (typeof raw !== "string" || !raw.trim()) throw new Error(`source migration state ${field} is invalid`);
  }
  if (state.checkpoint === undefined || state.checkpoint === null || typeof state.checkpoint !== "object") {
    throw new Error("source migration state checkpoint is invalid");
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
