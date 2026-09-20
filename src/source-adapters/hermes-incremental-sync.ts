import { readFile, rename, writeFile } from "node:fs/promises";
import type { MemoryScope, MemoryAuthor } from "../domain/types.js";
import type { DistillationReceipt } from "../distillation/types.js";
import type { NormalizedExperienceDistillationPolicies } from "./normalized-experience-distillation.js";
import { NormalizedExperienceDistillationBridge } from "./normalized-experience-distillation.js";
import type { NormalizedExperience } from "./contracts.js";
import type { NormalizedExperienceIngestor } from "./source-migration.js";
import type { HermesStateReader } from "./hermes-source-adapter.js";
import { HermesSourceAdapter } from "./hermes-source-adapter.js";
import { isOneShotOperationalDirective } from "../semantic/memory-language-signals.js";
import {
  projectDevelopmentExperienceReference,
  type DlmfDevelopmentExperienceReference,
} from "./development-experience-reference.js";

export interface HermesIncrementalCheckpoint {
  contract: "dlmf/hermes-incremental-checkpoint/v1";
  adapterVersion: string;
  sessions: Record<string, string>;
  updatedAt: string;
}

export interface HermesIncrementalCheckpointStore {
  load(): Promise<HermesIncrementalCheckpoint | undefined>;
  save(checkpoint: HermesIncrementalCheckpoint): Promise<void>;
}

export class FileHermesIncrementalCheckpointStore implements HermesIncrementalCheckpointStore {
  constructor(private readonly path: string) {}
  async load(): Promise<HermesIncrementalCheckpoint | undefined> {
    try { return JSON.parse(await readFile(this.path, "utf8")) as HermesIncrementalCheckpoint; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async save(checkpoint: HermesIncrementalCheckpoint): Promise<void> {
    const temporary = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export interface HermesIncrementalSyncOptions {
  reader: HermesStateReader;
  checkpointStore: HermesIncrementalCheckpointStore;
  distillation?: { run(input: any): Promise<DistillationReceipt> };
  ingestor?: NormalizedExperienceIngestor;
  /**
   * Development-observation mode. Changed session versions emit only
   * content-free DLMF references and never invoke distillation/ingestion.
   */
  referenceOnly?: boolean;
  scope: MemoryScope;
  origin: MemoryAuthor;
  policies: NormalizedExperienceDistillationPolicies;
  adapterVersion?: string;
  pageSize?: number;
  clock?: () => Date;
}

export interface HermesIncrementalSyncResult {
  scanned: number;
  changed: number;
  ingested: number;
  skipped: number;
  unchanged: number;
  receipts: Array<Pick<DistillationReceipt, "receiptId" | "status">>;
  /** Content-free observed experience versions available to Development. */
  experiences: DlmfDevelopmentExperienceReference[];
}

const EPHEMERAL_USER_INTERACTION_PATTERN = /^(?:你好|您好|嗨|哈囉|哈啰|早安|午安|晚安|謝謝|谢谢|感謝|感谢|多謝|多谢|好|好的|好啊|可以|可以啊|嗯|嗯嗯|收到|知道了|了解|明白|\/start|hi|hello|hey|thanks|thank\s+you|ok|okay|got\s+it|understood)\s*[。.!！?？~～]*$/iu;

function isFirstContactGreeting(text: string): boolean {
  // A bounded social opening is interaction evidence, not durable memory content.
  // Keep this semantic and identity-agnostic: no Digital Life name or owner name
  // participates in the rule. The full string must match the opening shape so a
  // durable fact appended before/after the greeting still enters normal DLMF.
  if (text.length > 160) return false;
  const chinese = /^(?:你好|您好|嗨|哈囉|哈啰)[，,\s]*(?:(?:我是|我叫)[^。.!！?？]{1,32}[。.!！?？]\s*)?(?:(?:今天是)?(?:我們|我们)?(?:的)?第一次(?:聊天|對話|对话)|初次(?:見面|见面))[，,。.!！?？\s]*(?:很高興|很高兴|很開心|很开心)(?:認識|认识|見到|见到)你[。.!！?？~～]*$/iu;
  const english = /^(?:hi|hello|hey)[,!\.\s]*(?:(?:i\s+am|i'm|my\s+name\s+is)\s+[^.!?]{1,32}[.!?]\s*)?(?:(?:this\s+is\s+)?(?:our\s+)?first\s+(?:chat|conversation|time\s+(?:chatting|talking)))[,!\.\s]*nice\s+to\s+meet\s+you[.!?~]*$/iu;
  return chinese.test(text) || english.test(text);
}

/**
 * Fast fail-safe for live Hermes sync only. A session is source-level transient
 * when every user-authored textual contribution is an exact greeting,
 * acknowledgement, thanks, or an already-reviewed one-shot operational command,
 * and no tool execution is present. Assistant/system text never makes a trivial
 * user turn memory-worthy by itself.
 *
 * The full session fingerprint is still checkpointed. If the same session later
 * gains durable user content, its fingerprint changes and the complete DLMF
 * distillation/admission path runs normally.
 */
export function isTransientUserOnlyHermesExperience(experience: NormalizedExperience): boolean {
  const actorKinds = new Map(experience.actors.map((actor) => [actor.actorId, actor.kind]));
  const userTexts: string[] = [];
  for (const event of experience.events) {
    const metadata = event.metadata ?? {};
    if (
      (typeof metadata.toolName === "string" && metadata.toolName.trim().length > 0)
      || (typeof metadata.toolCalls === "string" && metadata.toolCalls.trim().length > 0)
    ) {
      return false;
    }
    if (actorKinds.get(event.actorId ?? "") !== "user") continue;
    if (typeof event.content !== "string" || event.content.trim().length === 0) continue;
    userTexts.push(event.content.normalize("NFKC").trim());
  }
  return userTexts.length > 0 && userTexts.every((text) =>
    isOneShotOperationalDirective(text)
      || EPHEMERAL_USER_INTERACTION_PATTERN.test(text)
      || isFirstContactGreeting(text)
  );
}

/** Polling incremental sync for mutable Hermes sessions. Stable session identity is
 * combined with a full payload fingerprint, so both newly-created sessions and
 * mutations to an existing session are discovered without a historical snapshot. */
export class HermesIncrementalSyncService {
  readonly #adapter: HermesSourceAdapter;
  readonly #checkpointStore: HermesIncrementalCheckpointStore;
  readonly #ingestor: NormalizedExperienceIngestor | undefined;
  readonly #referenceOnly: boolean;
  readonly #scope: MemoryScope;
  readonly #pageSize: number;
  readonly #clock: () => Date;

  constructor(options: HermesIncrementalSyncOptions) {
    this.#adapter = new HermesSourceAdapter({ reader: options.reader, version: options.adapterVersion ?? "0.2.0", ...(options.clock === undefined ? {} : { clock: options.clock }) });
    this.#checkpointStore = options.checkpointStore;
    this.#scope = { ...options.scope };
    this.#referenceOnly = options.referenceOnly === true;
    if (this.#referenceOnly) {
      if (options.ingestor !== undefined || options.distillation !== undefined) {
        throw new Error("reference-only Hermes sync must not receive an ingestor or distillation provider");
      }
      this.#ingestor = undefined;
    } else if (options.ingestor !== undefined) this.#ingestor = options.ingestor;
    else {
      if (options.distillation === undefined) throw new Error("Hermes incremental sync requires ingestor or distillation");
      this.#ingestor = new NormalizedExperienceDistillationBridge({ distillation: options.distillation, scope: options.scope, origin: options.origin, policies: options.policies });
    }
    this.#pageSize = options.pageSize ?? 250;
    this.#clock = options.clock ?? (() => new Date());
  }

  /** Establish a current-state watermark without distilling historical sessions. */
  async baselineCurrent(): Promise<HermesIncrementalSyncResult> {
    const prior = await this.#checkpointStore.load();
    if (prior !== undefined) throw new Error("Hermes incremental baseline requires an empty checkpoint store");
    const next: HermesIncrementalCheckpoint = { contract: "dlmf/hermes-incremental-checkpoint/v1", adapterVersion: this.#adapter.version, sessions: {}, updatedAt: this.#clock().toISOString() };
    const result: HermesIncrementalSyncResult = { scanned: 0, changed: 0, ingested: 0, skipped: 0, unchanged: 0, receipts: [], experiences: [] };
    let cursor: string | undefined;
    do {
      const page = await this.#adapter.discover({ limit: this.#pageSize, ...(cursor === undefined ? {} : { cursor }) });
      for (const unit of page.units) {
        result.scanned += 1;
        next.sessions[unit.source.sourceId] = (await this.#adapter.fingerprint(unit)).value;
        result.unchanged += 1;
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    next.updatedAt = this.#clock().toISOString();
    await this.#checkpointStore.save(next);
    return result;
  }

  async runOnce(): Promise<HermesIncrementalSyncResult> {
    const prior = await this.#checkpointStore.load();
    if (prior !== undefined && (prior.contract !== "dlmf/hermes-incremental-checkpoint/v1" || prior.adapterVersion !== this.#adapter.version)) {
      throw new Error("Hermes incremental checkpoint is incompatible with adapter version");
    }
    const next: HermesIncrementalCheckpoint = { contract: "dlmf/hermes-incremental-checkpoint/v1", adapterVersion: this.#adapter.version, sessions: { ...(prior?.sessions ?? {}) }, updatedAt: this.#clock().toISOString() };
    const result: HermesIncrementalSyncResult = { scanned: 0, changed: 0, ingested: 0, skipped: 0, unchanged: 0, receipts: [], experiences: [] };
    let cursor: string | undefined;
    do {
      const page = await this.#adapter.discover({ limit: this.#pageSize, ...(cursor === undefined ? {} : { cursor }) });
      for (const unit of page.units) {
        result.scanned += 1;
        const fingerprint = await this.#adapter.fingerprint(unit);
        if (next.sessions[unit.source.sourceId] === fingerprint.value) { result.unchanged += 1; continue; }
        result.changed += 1;
        const read = await this.#adapter.read(unit);
        const normalized = await this.#adapter.normalize(read);
        if (this.#referenceOnly) {
          result.experiences.push(
            projectDevelopmentExperienceReference(
              normalized,
              this.#scope,
              "REFERENCE_ONLY",
            ),
          );
          next.sessions[unit.source.sourceId] = normalized.provenance.sourceFingerprint.value;
          next.updatedAt = this.#clock().toISOString();
          await this.#checkpointStore.save(next);
          continue;
        }
        if (isTransientUserOnlyHermesExperience(normalized)) {
          result.skipped += 1;
          result.experiences.push(
            projectDevelopmentExperienceReference(
              normalized,
              this.#scope,
              "TRANSIENT_SOURCE_ONLY",
            ),
          );
          next.sessions[unit.source.sourceId] = normalized.provenance.sourceFingerprint.value;
          next.updatedAt = this.#clock().toISOString();
          await this.#checkpointStore.save(next);
          continue;
        }
        const hasTextualEvidence = normalized.events.some((event) => typeof event.content === "string" && event.content.trim().length > 0)
          || normalized.content.some((content) => typeof content.text === "string" && content.text.trim().length > 0);
        if (hasTextualEvidence) {
          if (this.#ingestor === undefined) {
            throw new Error("Hermes incremental ingestor is unavailable outside reference-only mode");
          }
          const receipt = await this.#ingestor.ingest(normalized);
          result.receipts.push(receipt);
          result.experiences.push(
            projectDevelopmentExperienceReference(
              normalized,
              this.#scope,
              "DISTILLATION_SUBMITTED",
              receipt,
            ),
          );
          if (receipt.status !== "complete" && receipt.status !== "awaiting_review") continue;
          result.ingested += 1;
        } else {
          result.experiences.push(
            projectDevelopmentExperienceReference(
              normalized,
              this.#scope,
              "NO_TEXTUAL_EVIDENCE",
            ),
          );
        }
        next.sessions[unit.source.sourceId] = normalized.provenance.sourceFingerprint.value;
        next.updatedAt = this.#clock().toISOString();
        await this.#checkpointStore.save(next);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    await this.#checkpointStore.save(next);
    return result;
  }
}
