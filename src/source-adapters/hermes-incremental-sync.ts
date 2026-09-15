import { readFile, rename, writeFile } from "node:fs/promises";
import type { MemoryScope, MemoryAuthor } from "../domain/types.js";
import type { DistillationReceipt } from "../distillation/types.js";
import type { NormalizedExperienceDistillationPolicies } from "./normalized-experience-distillation.js";
import { NormalizedExperienceDistillationBridge } from "./normalized-experience-distillation.js";
import type { NormalizedExperienceIngestor } from "./source-migration.js";
import type { HermesStateReader } from "./hermes-source-adapter.js";
import { HermesSourceAdapter } from "./hermes-source-adapter.js";

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
  unchanged: number;
  receipts: Array<Pick<DistillationReceipt, "receiptId" | "status">>;
}

/** Polling incremental sync for mutable Hermes sessions. Stable session identity is
 * combined with a full payload fingerprint, so both newly-created sessions and
 * mutations to an existing session are discovered without a historical snapshot. */
export class HermesIncrementalSyncService {
  readonly #adapter: HermesSourceAdapter;
  readonly #checkpointStore: HermesIncrementalCheckpointStore;
  readonly #ingestor: NormalizedExperienceIngestor;
  readonly #pageSize: number;
  readonly #clock: () => Date;

  constructor(options: HermesIncrementalSyncOptions) {
    this.#adapter = new HermesSourceAdapter({ reader: options.reader, version: options.adapterVersion ?? "0.2.0", ...(options.clock === undefined ? {} : { clock: options.clock }) });
    this.#checkpointStore = options.checkpointStore;
    if (options.ingestor !== undefined) this.#ingestor = options.ingestor;
    else {
      if (options.distillation === undefined) throw new Error("Hermes incremental sync requires ingestor or distillation");
      this.#ingestor = new NormalizedExperienceDistillationBridge({ distillation: options.distillation, scope: options.scope, origin: options.origin, policies: options.policies });
    }
    this.#pageSize = options.pageSize ?? 250;
    this.#clock = options.clock ?? (() => new Date());
  }

  async runOnce(): Promise<HermesIncrementalSyncResult> {
    const prior = await this.#checkpointStore.load();
    if (prior !== undefined && (prior.contract !== "dlmf/hermes-incremental-checkpoint/v1" || prior.adapterVersion !== this.#adapter.version)) {
      throw new Error("Hermes incremental checkpoint is incompatible with adapter version");
    }
    const next: HermesIncrementalCheckpoint = { contract: "dlmf/hermes-incremental-checkpoint/v1", adapterVersion: this.#adapter.version, sessions: { ...(prior?.sessions ?? {}) }, updatedAt: this.#clock().toISOString() };
    const result: HermesIncrementalSyncResult = { scanned: 0, changed: 0, ingested: 0, unchanged: 0, receipts: [] };
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
        const hasTextualEvidence = normalized.events.some((event) => typeof event.content === "string" && event.content.trim().length > 0)
          || normalized.content.some((content) => typeof content.text === "string" && content.text.trim().length > 0);
        if (hasTextualEvidence) {
          const receipt = await this.#ingestor.ingest(normalized);
          result.receipts.push(receipt);
          if (receipt.status !== "complete" && receipt.status !== "awaiting_review") continue;
          result.ingested += 1;
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
