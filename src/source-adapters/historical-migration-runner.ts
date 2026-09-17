import type { DistillationReceipt } from "../distillation/types.js";
import type {
  ExperienceId,
  ExperienceUnit,
  NormalizedExperience,
  SourceAdapterInspection,
  SourceFingerprint,
} from "./contracts.js";
import type { MemorySourceAdapter } from "./source-adapter.js";
import type {
  HistoricalMigrationEligibilityPolicy,
  NormalizedExperienceIngestor,
  SourceMigrationState,
  SourceMigrationStateStore,
} from "./source-migration.js";
import { experienceEventEvidence } from "./normalized-experience-distillation.js";
import { assertNormalizedExperience } from "./validation.js";

export class TextualExperienceMigrationEligibilityPolicy
  implements HistoricalMigrationEligibilityPolicy
{
  readonly version = "textual-evidence-v1";

  assess(experience: NormalizedExperience) {
    const eventText = experience.events.some(
      (event) => experienceEventEvidence(event) !== undefined,
    );
    const contentText = experience.content.some(
      (content) => typeof content.text === "string" && content.text.trim().length > 0,
    );
    return eventText || contentText
      ? { eligible: true, reasonCode: "textual_evidence" }
      : { eligible: false, reasonCode: "no_textual_evidence" };
  }
}

export interface HistoricalMigrationUnitResult {
  experienceId: ExperienceId;
  sourceFingerprint: SourceFingerprint;
  outcome: "ingested" | "skipped";
  eligibilityReasonCode: string;
  receiptId?: DistillationReceipt["receiptId"];
  receiptStatus?: DistillationReceipt["status"];
}

export interface HistoricalMigrationRunResult {
  status: "bounded" | "source_exhausted";
  inspection: SourceAdapterInspection;
  processedThisRun: number;
  ingestedThisRun: number;
  skippedThisRun: number;
  units: HistoricalMigrationUnitResult[];
  state: SourceMigrationState;
}

export class HistoricalMigrationError extends Error {
  readonly checkpoint: SourceMigrationState["checkpoint"] | undefined;
  readonly failedExperienceId: ExperienceId | undefined;

  constructor(
    message: string,
    options: {
      checkpoint?: SourceMigrationState["checkpoint"];
      failedExperienceId?: ExperienceId;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HistoricalMigrationError";
    this.checkpoint = options.checkpoint;
    this.failedExperienceId = options.failedExperienceId;
  }
}

export interface HistoricalMigrationRunnerOptions<TSourcePayload> {
  adapter: MemorySourceAdapter<TSourcePayload>;
  ingestor: NormalizedExperienceIngestor;
  stateStore: SourceMigrationStateStore;
  eligibility?: HistoricalMigrationEligibilityPolicy;
  migrationId: string;
  clock?: () => Date;
}

function sameFingerprint(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function terminalReceipt(receipt: Pick<DistillationReceipt, "status">): boolean {
  return receipt.status === "complete" || receipt.status === "awaiting_review";
}

/**
 * Source-neutral, durable historical migration.
 *
 * Discovery remains source-ordered and one unit at a time. Processing may use a
 * bounded concurrency window, but durable checkpoint advancement is always the
 * contiguous successful source prefix. Work that completes beyond a failed unit
 * is intentionally replayed from the prior checkpoint and must rely on downstream
 * idempotency; it can never move the source checkpoint past the failure.
 */
export class HistoricalExperienceMigrationRunner<TSourcePayload> {
  readonly #adapter: MemorySourceAdapter<TSourcePayload>;
  readonly #ingestor: NormalizedExperienceIngestor;
  readonly #stateStore: SourceMigrationStateStore;
  readonly #eligibility: HistoricalMigrationEligibilityPolicy;
  readonly #migrationId: string;
  readonly #clock: () => Date;

  constructor(options: HistoricalMigrationRunnerOptions<TSourcePayload>) {
    this.#adapter = options.adapter;
    this.#ingestor = options.ingestor;
    this.#stateStore = options.stateStore;
    this.#eligibility = options.eligibility ?? new TextualExperienceMigrationEligibilityPolicy();
    if (!this.#eligibility.version.trim()) throw new Error("eligibility policy version must not be empty");
    if (!options.migrationId.trim() || options.migrationId.length > 256) {
      throw new Error("migrationId must contain 1..256 characters");
    }
    this.#migrationId = options.migrationId;
    this.#clock = options.clock ?? (() => new Date());
  }

  async run(request: { maxUnits: number; concurrency?: number }): Promise<HistoricalMigrationRunResult> {
    if (!Number.isInteger(request.maxUnits) || request.maxUnits < 1 || request.maxUnits > 1000) {
      throw new Error("maxUnits must be an integer between 1 and 1000");
    }
    const concurrency = request.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) {
      throw new Error("concurrency must be an integer between 1 and 128");
    }

    const inspection = await this.#adapter.inspect();
    if (inspection.capabilities.historicalImport !== "full"
      && inspection.capabilities.historicalImport !== "partial") {
      throw new Error("source adapter does not declare historical import support");
    }

    let state = await this.#stateStore.load();
    if (state !== null) this.#assertStateCompatible(state, inspection);
    if (state?.complete === true) return this.#result("source_exhausted", inspection, state, [], 0, 0, 0);

    let processedThisRun = 0;
    let ingestedThisRun = 0;
    let skippedThisRun = 0;
    const units: HistoricalMigrationUnitResult[] = [];

    while (processedThisRun < request.maxUnits) {
      const capacity = Math.min(concurrency, request.maxUnits - processedThisRun);
      const window: Array<{ unit: ExperienceUnit; nextCursor?: string }> = [];
      let discoveryCursor = state?.checkpoint.cursor;
      let sourceExhausted = false;

      for (let index = 0; index < capacity; index += 1) {
        const page = await this.#adapter.discover({
          limit: 1,
          ...(index === 0 && state !== null
            ? { checkpoint: state.checkpoint }
            : discoveryCursor === undefined
              ? {}
              : { cursor: discoveryCursor }),
        });
        if (page.units.length > 1) {
          throw new HistoricalMigrationError(
            "source adapter returned more than one unit for a per-unit migration request",
            state?.checkpoint === undefined ? {} : { checkpoint: state.checkpoint },
          );
        }
        if (page.units.length === 0) {
          sourceExhausted = true;
          break;
        }
        if (discoveryCursor !== undefined && page.nextCursor === discoveryCursor) {
          throw new HistoricalMigrationError(
            "source adapter cursor did not advance",
            state?.checkpoint === undefined ? {} : { checkpoint: state.checkpoint },
          );
        }
        const unit = page.units[0]!;
        this.#assertUnitCompatible(unit, inspection);
        window.push({ unit, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
        discoveryCursor = page.nextCursor;
        if (page.nextCursor === undefined) {
          sourceExhausted = true;
          break;
        }
      }

      if (window.length === 0) {
        state = this.#completedState(inspection, state);
        await this.#stateStore.save(state);
        return this.#result("source_exhausted", inspection, state, units, processedThisRun, ingestedThisRun, skippedThisRun);
      }

      const settled = await Promise.allSettled(
        window.map(({ unit }) => this.#processUnit(unit, inspection)),
      );
      const failureIndex = settled.findIndex((item) => item.status === "rejected");
      const commitCount = failureIndex < 0 ? settled.length : failureIndex;

      for (let index = 0; index < commitCount; index += 1) {
        const settledItem = settled[index]!;
        if (settledItem.status !== "fulfilled") throw new Error("unreachable migration settlement state");
        const result = settledItem.value;
        const discovered = window[index]!;
        processedThisRun += 1;
        if (result.outcome === "ingested") ingestedThisRun += 1;
        else skippedThisRun += 1;
        units.push(result);
        state = this.#advancedState(
          inspection,
          state,
          result.experienceId,
          result.sourceFingerprint,
          discovered.nextCursor,
          result.outcome === "ingested",
        );
        await this.#stateStore.save(state);
      }

      if (failureIndex >= 0) {
        const failed = settled[failureIndex]!;
        const failedUnit = window[failureIndex]!.unit;
        throw new HistoricalMigrationError(
          `historical migration failed for ${failedUnit.experienceId}`,
          {
            ...(state?.checkpoint === undefined ? {} : { checkpoint: state.checkpoint }),
            failedExperienceId: failedUnit.experienceId,
            cause: failed.status === "rejected" ? failed.reason : new Error("unreachable fulfilled failure"),
          },
        );
      }

      if (sourceExhausted) {
        if (state === null) throw new Error("historical migration produced no durable state");
        if (!state.complete) {
          state = this.#completedState(inspection, state);
          await this.#stateStore.save(state);
        }
        return this.#result("source_exhausted", inspection, state, units, processedThisRun, ingestedThisRun, skippedThisRun);
      }
    }

    if (state === null) throw new Error("historical migration produced no durable state");
    return this.#result("bounded", inspection, state, units, processedThisRun, ingestedThisRun, skippedThisRun);
  }

  async #processUnit(
    unit: ExperienceUnit,
    inspection: SourceAdapterInspection,
  ): Promise<HistoricalMigrationUnitResult> {
    const read = await this.#adapter.read(unit);
    const normalized = await this.#adapter.normalize(read);
    assertNormalizedExperience(normalized);
    this.#assertNormalizedMatchesUnit(normalized, unit.experienceId, inspection);

    const currentFingerprint = await this.#adapter.fingerprint(unit);
    if (!sameFingerprint(currentFingerprint, normalized.provenance.sourceFingerprint)) {
      throw new Error("source changed between read/normalize and fingerprint verification");
    }

    const eligibility = await this.#eligibility.assess(normalized);
    this.#assertEligibility(eligibility.reasonCode);
    if (!eligibility.eligible) {
      return {
        experienceId: normalized.experienceId,
        sourceFingerprint: currentFingerprint,
        outcome: "skipped",
        eligibilityReasonCode: eligibility.reasonCode,
      };
    }

    const receipt = await this.#ingestor.ingest(normalized);
    if (!terminalReceipt(receipt)) {
      throw new Error(`DLMF distillation did not reach an accepted terminal state: ${receipt.status}`);
    }
    return {
      experienceId: normalized.experienceId,
      sourceFingerprint: currentFingerprint,
      outcome: "ingested",
      eligibilityReasonCode: eligibility.reasonCode,
      receiptId: receipt.receiptId,
      receiptStatus: receipt.status,
    };
  }

  #advancedState(
    inspection: SourceAdapterInspection,
    prior: SourceMigrationState | null,
    experienceId: ExperienceId,
    fingerprint: SourceFingerprint,
    nextCursor: string | undefined,
    ingested: boolean,
  ): SourceMigrationState {
    const updatedAt = this.#clock().toISOString();
    return {
      schemaVersion: 1,
      adapterName: inspection.adapterName,
      adapterVersion: inspection.adapterVersion,
      sourceSystem: inspection.sourceSystem,
      sourceType: inspection.sourceType,
      eligibilityPolicyVersion: this.#eligibility.version,
      migrationId: this.#migrationId,
      checkpoint: {
        adapterName: inspection.adapterName,
        adapterVersion: inspection.adapterVersion,
        sourceSystem: inspection.sourceSystem,
        sourceType: inspection.sourceType,
        ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
        lastExperienceId: experienceId,
        lastSourceFingerprint: fingerprint,
        updatedAt,
      },
      processedUnits: (prior?.processedUnits ?? 0) + 1,
      ingestedUnits: (prior?.ingestedUnits ?? 0) + (ingested ? 1 : 0),
      skippedUnits: (prior?.skippedUnits ?? 0) + (ingested ? 0 : 1),
      complete: nextCursor === undefined,
      updatedAt,
    };
  }

  #completedState(
    inspection: SourceAdapterInspection,
    prior: SourceMigrationState | null,
  ): SourceMigrationState {
    const updatedAt = this.#clock().toISOString();
    return {
      schemaVersion: 1,
      adapterName: inspection.adapterName,
      adapterVersion: inspection.adapterVersion,
      sourceSystem: inspection.sourceSystem,
      sourceType: inspection.sourceType,
      eligibilityPolicyVersion: this.#eligibility.version,
      migrationId: this.#migrationId,
      checkpoint: prior?.checkpoint ?? {
        adapterName: inspection.adapterName,
        adapterVersion: inspection.adapterVersion,
        sourceSystem: inspection.sourceSystem,
        sourceType: inspection.sourceType,
        updatedAt,
      },
      processedUnits: prior?.processedUnits ?? 0,
      ingestedUnits: prior?.ingestedUnits ?? 0,
      skippedUnits: prior?.skippedUnits ?? 0,
      complete: true,
      updatedAt,
    };
  }

  #assertStateCompatible(state: SourceMigrationState, inspection: SourceAdapterInspection): void {
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
    if (state.migrationId !== this.#migrationId) {
      throw new Error("source migration destination identity changed; explicit migration-state review is required");
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

  #assertUnitCompatible(unit: { source: { sourceSystem: string; sourceType: string } }, inspection: SourceAdapterInspection): void {
    if (unit.source.sourceSystem !== inspection.sourceSystem || unit.source.sourceType !== inspection.sourceType) {
      throw new Error("source adapter discovered a unit outside its inspected source identity");
    }
  }

  #assertNormalizedMatchesUnit(
    experience: NormalizedExperience,
    experienceId: ExperienceId,
    inspection: SourceAdapterInspection,
  ): void {
    if (
      experience.experienceId !== experienceId
      || experience.sourceSystem !== inspection.sourceSystem
      || experience.sourceType !== inspection.sourceType
    ) {
      throw new Error("normalized experience identity does not match discovered unit");
    }
  }

  #assertEligibility(reasonCode: string): void {
    if (!reasonCode.trim() || reasonCode.length > 128) {
      throw new Error("eligibility decision reasonCode must contain 1..128 characters");
    }
  }

  #result(
    status: HistoricalMigrationRunResult["status"],
    inspection: SourceAdapterInspection,
    state: SourceMigrationState,
    units: HistoricalMigrationUnitResult[],
    processedThisRun: number,
    ingestedThisRun: number,
    skippedThisRun: number,
  ): HistoricalMigrationRunResult {
    return {
      status,
      inspection,
      processedThisRun,
      ingestedThisRun,
      skippedThisRun,
      units: structuredClone(units),
      state: structuredClone(state),
    };
  }
}
