import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { MemoryScope } from "../domain/types.js";
import type {
  DiscoverPage,
  DiscoverRequest,
  ExperienceActor,
  ExperienceContent,
  ExperienceEvent,
  ExperienceTimestamp,
  ExperienceUnit,
  NormalizedExperience,
  SourceAdapterInspection,
  SourceFingerprint,
  SourceReadResult,
  SourceVersion,
} from "./contracts.js";
import { experienceIdFor } from "./identity.js";
import {
  GenericIncrementalSourceSyncService,
  type IncrementalSourceCheckpointStore,
  type IncrementalSourceSyncResult,
} from "./incremental-source-sync.js";
import type { MemorySourceAdapter } from "./source-adapter.js";
import type { NormalizedExperienceIngestor } from "./source-migration.js";
import {
  readContainedSourceFile,
  readContainedSourceFirstLine,
} from "./contained-source-file.js";

export interface CodexSessionSummary {
  /** Stable DLMF source-unit identity for one physical Codex journal. */
  sessionId: string;
  /** Codex logical session/thread identity retained only as provenance metadata. */
  logicalSessionId: string;
  relativePath: string;
  startedAt?: string;
  lastModifiedAt: string;
  sizeBytes: number;
  source?: string;
  originator?: string;
}

export interface CodexSessionPayload {
  summary: CodexSessionSummary;
  records: unknown[];
  incompleteTail: boolean;
}

export interface CodexSessionReader {
  inspect(): Promise<{ sessionCount: number }>;
  listSessions(request: {
    afterSessionId?: string;
    limit: number;
  }): Promise<CodexSessionSummary[]>;
  readSession(sessionId: string): Promise<CodexSessionPayload>;
}

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function exactTimestamp(value: unknown, evidence: string): ExperienceTimestamp {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { certainty: "unknown" };
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return { certainty: "unknown" };
  return { value: new Date(millis).toISOString(), certainty: "exact", evidence };
}

function inferredTimestamp(value: string, evidence: string): ExperienceTimestamp {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return { certainty: "unknown" };
  return { value: new Date(millis).toISOString(), certainty: "inferred", evidence };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): SourceFingerprint {
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(stableJson(value), "utf8").digest("hex"),
  };
}

interface CodexSelectedMessage {
  ordinal: number;
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

function looksLikeInjectedCodexUserText(text: string): boolean {
  return /^\s*(?:<environment_context\b|<user_instructions\b|<developer\b|<system\b|<in-app-browser-context\b|#\s*AGENTS\.md\b|#\s*Developer\b|#\s*System\b)/iu.test(text);
}

function userInputParts(payload: JsonRecord): string[] {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts: string[] = [];
  for (const rawPart of content) {
    const part = object(rawPart);
    if (part?.type !== "input_text") continue;
    const text = string(part.text)?.trim();
    if (text) parts.push(text);
  }
  return parts;
}

function selectedMessages(records: unknown[]): CodexSelectedMessage[] {
  const userMessageParts: string[][] = [];
  for (const raw of records) {
    const payload = object(object(raw)?.payload);
    if (payload?.type === "message" && payload.role === "user") {
      userMessageParts.push(userInputParts(payload));
    }
  }

  const selected: CodexSelectedMessage[] = [];
  let userMessageIndex = 0;
  for (const [index, raw] of records.entries()) {
    const record = object(raw);
    const payload = object(record?.payload);
    if (payload?.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;

    let parts: string[] = [];
    if (role === "assistant") {
      const content = Array.isArray(payload.content) ? payload.content : [];
      for (const rawPart of content) {
        const part = object(rawPart);
        if (part?.type !== "output_text") continue;
        const text = string(part.text)?.trim();
        if (text) parts.push(text);
      }
    } else {
      const rawParts = userMessageParts[userMessageIndex] ?? [];
      userMessageIndex += 1;
      const nonInjected = rawParts.filter(
        (text) => !looksLikeInjectedCodexUserText(text),
      );
      // Multi-part user envelopes can mix host-injected and owner-authored
      // material. Repetition frequency is not provenance, so accept a user
      // message only when filtering known host wrappers leaves exactly one
      // unambiguous input part.
      parts = nonInjected.length === 1 ? nonInjected : [];
    }

    if (parts.length === 0) continue;
    const ordinal = Number.isSafeInteger(record?.ordinal)
      ? Number(record!.ordinal)
      : index;
    const timestamp = string(record?.timestamp);
    selected.push({
      ordinal,
      role,
      text: parts.join("\n"),
      ...(timestamp === undefined ? {} : { timestamp }),
    });
  }
  return selected;
}

function selectedEvidenceProjection(records: unknown[]): Array<{
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
}> {
  return selectedMessages(records).map((message) => ({
    role: message.role,
    text: message.text,
    timestamp: message.timestamp ?? null,
  }));
}

function evidenceFingerprint(records: unknown[]): SourceFingerprint {
  return sha256(selectedEvidenceProjection(records));
}

export function codexJournalSourceId(
  logicalSessionId: string,
  relativePath: string,
): string {
  const locator = safeLocator(relativePath);
  const digest = createHash("sha256")
    .update(
      `dlmf/codex-journal-source/v1\0${logicalSessionId}\0${locator}`,
      "utf8",
    )
    .digest("hex");
  return `codex_journal_${digest}`;
}

function sourceVersion(summary: CodexSessionSummary): SourceVersion {
  return {
    value: `${summary.lastModifiedAt}:${summary.sizeBytes}`,
    scheme: "mtime",
  };
}

function sourceFor(sessionId: string) {
  return {
    sourceSystem: "codex",
    sourceType: "conversation_session",
    sourceId: sessionId,
  } as const;
}

function compareStableIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeLocator(relativePath: string): string {
  if (
    !relativePath
    || relativePath.startsWith("..")
    || relativePath.split(sep).includes("..")
  ) {
    throw new Error("Codex session relative path escapes configured root");
  }
  return relativePath.split(sep).join("/");
}

function parseJsonLinesText(text: string): {
  records: unknown[];
  incompleteTail: boolean;
} {
  const records: unknown[] = [];
  const lines = text.split(/\r?\n/u);
  const hasTerminatedTail = text.endsWith("\n");
  for (const [index, rawLine] of lines.entries()) {
    if (!rawLine.trim()) continue;
    try {
      records.push(JSON.parse(rawLine) as unknown);
    } catch {
      if (!hasTerminatedTail && index === lines.length - 1) {
        return { records, incompleteTail: true };
      }
      throw new Error(`Codex session journal contains invalid JSON at line ${index + 1}`);
    }
  }
  return { records, incompleteTail: false };
}

function summaryFromRecords(
  records: unknown[],
  relativePath: string,
  lastModifiedAt: string,
  sizeBytes: number,
): CodexSessionSummary {
  const first = object(records[0]);
  if (first?.type !== "session_meta") {
    throw new Error("Codex session journal must begin with session_meta");
  }
  const payload = object(first.payload);
  // Modern Codex may reuse one logical id across multiple physical rollout
  // journals (including divergent branches). DLMF therefore identifies the
  // Source Experience by the physical journal locator, while retaining the
  // logical Codex id only as provenance metadata. This preserves every branch
  // without letting source-layer collision handling discard evidence.
  const logicalSessionId = string(payload?.id) ?? string(payload?.session_id);
  if (
    logicalSessionId === undefined
    || logicalSessionId.trim() !== logicalSessionId
  ) {
    throw new Error("Codex session_meta is missing a stable logical session identifier");
  }
  const locator = safeLocator(relativePath);
  const startedAt = string(payload?.timestamp) ?? string(first.timestamp);
  return {
    sessionId: codexJournalSourceId(logicalSessionId, locator),
    logicalSessionId,
    relativePath: locator,
    ...(startedAt === undefined ? {} : { startedAt }),
    lastModifiedAt,
    sizeBytes,
    ...(string(payload?.source) === undefined ? {} : { source: string(payload?.source)! }),
    ...(string(payload?.originator) === undefined
      ? {}
      : { originator: string(payload?.originator)! }),
  };
}

/**
 * Read-only reader for Codex local session journals. The root is injected so
 * DLMF core never assumes a user home path. Directory symlinks and file symlinks
 * are ignored rather than followed.
 */
export class CodexJsonlSessionReader implements CodexSessionReader {
  readonly #rootPath: string;
  #canonicalRoot: string | undefined;
  #index: Array<{ path: string; summary: CodexSessionSummary }> | undefined;
  #indexById = new Map<string, { path: string; summary: CodexSessionSummary }>();
  #freshForNextList = false;

  constructor(rootPath: string) {
    if (!rootPath.trim()) throw new Error("Codex session root must not be empty");
    this.#rootPath = rootPath;
  }

  async inspect(): Promise<{ sessionCount: number }> {
    const index = await this.#refreshIndex();
    this.#freshForNextList = true;
    return { sessionCount: index.length };
  }

  async listSessions(request: {
    afterSessionId?: string;
    limit: number;
  }): Promise<CodexSessionSummary[]> {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000) {
      throw new Error("Codex listSessions limit must be an integer between 1 and 1000");
    }
    let index: Array<{ path: string; summary: CodexSessionSummary }>;
    if (request.afterSessionId === undefined) {
      if (this.#freshForNextList && this.#index !== undefined) {
        index = this.#index;
        this.#freshForNextList = false;
      } else {
        index = await this.#refreshIndex();
      }
    } else {
      index = this.#index ?? await this.#refreshIndex();
    }
    let start = 0;
    if (request.afterSessionId !== undefined) {
      let low = 0;
      let high = index.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (
          compareStableIds(
            index[middle]!.summary.sessionId,
            request.afterSessionId,
          ) <= 0
        ) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      start = low;
    }
    return index
      .slice(start, start + request.limit)
      .map((entry) => structuredClone(entry.summary));
  }

  async readSession(sessionId: string): Promise<CodexSessionPayload> {
    if (this.#index === undefined) await this.#refreshIndex();
    const entry = this.#indexById.get(sessionId);
    if (entry === undefined) throw new Error("Codex session not found");
    const root = await this.#root();
    const file = await readContainedSourceFile(entry.path, root);
    const parsed = parseJsonLinesText(file.text);
    const summary = summaryFromRecords(
      parsed.records,
      entry.summary.relativePath,
      file.modifiedAt,
      file.sizeBytes,
    );
    if (summary.sessionId !== sessionId) {
      throw new Error("Codex session identity changed between discovery and read");
    }
    return {
      summary,
      records: parsed.records,
      incompleteTail: parsed.incompleteTail,
    };
  }

  async #root(): Promise<string> {
    this.#canonicalRoot ??= await realpath(this.#rootPath);
    return this.#canonicalRoot;
  }

  async #refreshIndex(): Promise<Array<{ path: string; summary: CodexSessionSummary }>> {
    const root = await this.#root();
    const paths: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          paths.push(path);
        }
      }
    };
    await walk(root);

    const found: Array<{ path: string; summary: CodexSessionSummary }> = [];
    const sourceIds = new Set<string>();
    for (const path of paths.sort()) {
      const file = await readContainedSourceFirstLine(path, root);
      let first: unknown;
      try {
        first = JSON.parse(file.text) as unknown;
      } catch {
        const firstLineBytes = Buffer.byteLength(file.text, "utf8");
        if (firstLineBytes >= file.sizeBytes) {
          // A newly-created Codex journal can be observed before its first
          // session_meta record is fully appended. Without a stable logical id
          // it is not yet an Experience Unit, so isolate it and retry later.
          continue;
        }
        throw new Error("Codex session journal contains invalid JSON at line 1");
      }
      const relativePath = relative(root, path);
      const summary = summaryFromRecords(
        [first],
        relativePath,
        file.modifiedAt,
        file.sizeBytes,
      );
      if (sourceIds.has(summary.sessionId)) {
        throw new Error("duplicate Codex physical journal source identity");
      }
      sourceIds.add(summary.sessionId);
      found.push({ path, summary });
    }

    this.#index = found.sort((left, right) =>
      compareStableIds(left.summary.sessionId, right.summary.sessionId)
    );
    this.#indexById = new Map(
      this.#index.map((entry) => [entry.summary.sessionId, entry]),
    );
    return this.#index;
  }

}

export class CodexSourceAdapter implements MemorySourceAdapter<CodexSessionPayload> {
  readonly name = "CodexSourceAdapter";
  readonly version: string;
  readonly #reader: CodexSessionReader;
  readonly #clock: () => Date;

  constructor(options: {
    reader: CodexSessionReader;
    version?: string;
    clock?: () => Date;
  }) {
    this.#reader = options.reader;
    this.version = options.version ?? "0.2.0";
    this.#clock = options.clock ?? (() => new Date());
  }

  async inspect(): Promise<SourceAdapterInspection> {
    const source = await this.#reader.inspect();
    return {
      adapterName: this.name,
      adapterVersion: this.version,
      sourceSystem: "codex",
      sourceType: "conversation_session",
      capabilities: {
        historicalImport: "full",
        incrementalSync: "partial",
        stableSourceId: "full",
        timestamps: "partial",
        toolEvents: "none",
        attachments: "none",
        deletionDetection: "none",
      },
      metadata: {
        sessionCount: source.sessionCount,
        evidencePolicy: "explicit_user_assistant_text_only",
      },
    };
  }

  async discover(request: DiscoverRequest): Promise<DiscoverPage> {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000) {
      throw new Error("discover limit must be an integer between 1 and 1000");
    }
    if (request.checkpoint !== undefined) {
      throw new Error("CodexSourceAdapter incremental discovery does not accept historical checkpoints");
    }
    const summaries = await this.#reader.listSessions({
      ...(request.cursor === undefined ? {} : { afterSessionId: request.cursor }),
      limit: request.limit,
    });
    const units = summaries.map((summary) => this.#unit(summary));
    const nextCursor = summaries.length === request.limit
      ? summaries.at(-1)?.sessionId
      : undefined;
    return { units, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  async read(unit: ExperienceUnit): Promise<SourceReadResult<CodexSessionPayload>> {
    this.#assertUnit(unit);
    const payload = await this.#reader.readSession(unit.source.sourceId);
    if (payload.summary.sessionId !== unit.source.sourceId) {
      throw new Error("Codex reader returned mismatched session identity");
    }
    return {
      unit: this.#unit(payload.summary),
      payload,
      readAt: this.#clock().toISOString(),
    };
  }

  async normalize(
    result: SourceReadResult<CodexSessionPayload>,
  ): Promise<NormalizedExperience> {
    this.#assertUnit(result.unit);
    const payload = result.payload;
    const source = sourceFor(payload.summary.sessionId);
    const selected = selectedMessages(payload.records);
    const actors = new Map<string, ExperienceActor>();
    const events: ExperienceEvent[] = [];
    const contents: ExperienceContent[] = [];
    let userMessageCount = 0;
    let assistantMessageCount = 0;

    for (const message of selected) {
      const actorId = `codex:${message.role}`;
      actors.set(actorId, { actorId, kind: message.role });
      if (message.role === "user") userMessageCount += 1;
      else assistantMessageCount += 1;
      const occurredAt = exactTimestamp(
        message.timestamp,
        `codex journal ordinal=${message.ordinal}.timestamp`,
      );
      events.push({
        eventId: `codex-message:${message.ordinal}`,
        eventType: "message",
        actorId,
        occurredAt,
        content: message.text,
        metadata: { role: message.role },
      });
      contents.push({ mediaType: "text/plain", text: message.text });
    }

    const fingerprint = evidenceFingerprint(payload.records);
    const version = sourceVersion(payload.summary);
    const lastMessageTimestamp = selected.at(-1)?.timestamp;
    const startedAt = exactTimestamp(
      payload.summary.startedAt,
      "codex session_meta.timestamp",
    );
    const endedAt = lastMessageTimestamp === undefined
      ? inferredTimestamp(payload.summary.lastModifiedAt, "Codex journal filesystem mtime")
      : exactTimestamp(lastMessageTimestamp, "last selected Codex message timestamp");
    const now = this.#clock().toISOString();
    return {
      sourceSystem: source.sourceSystem,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceVersion: version,
      experienceId: experienceIdFor(source),
      startedAt,
      endedAt,
      actors: [...actors.values()],
      events,
      content: contents,
      metadata: {
        lastModifiedAt: payload.summary.lastModifiedAt,
        selectedMessageCount: selected.length,
        userMessageCount,
        assistantMessageCount,
        excludedRecordCount: Math.max(0, payload.records.length - selected.length),
        incompleteTail: payload.incompleteTail,
        logicalSessionId: payload.summary.logicalSessionId,
        source: payload.summary.source ?? null,
        originator: payload.summary.originator ?? null,
        evidencePolicy: "explicit_user_assistant_text_only",
      },
      provenance: {
        source,
        sourceVersion: version,
        sourceFingerprint: fingerprint,
        adapterName: this.name,
        adapterVersion: this.version,
        discoveredAt: typeof result.unit.metadata.discoveredAt === "string"
          ? result.unit.metadata.discoveredAt
          : result.readAt,
        readAt: result.readAt,
        normalizedAt: now,
        sourceLocator: `codex-journal:${payload.summary.relativePath}`,
      },
    };
  }

  async fingerprint(unit: ExperienceUnit): Promise<SourceFingerprint> {
    this.#assertUnit(unit);
    return evidenceFingerprint(
      (await this.#reader.readSession(unit.source.sourceId)).records,
    );
  }

  #unit(summary: CodexSessionSummary): ExperienceUnit {
    const source = sourceFor(summary.sessionId);
    return {
      source,
      sourceVersion: sourceVersion(summary),
      experienceId: experienceIdFor(source),
      startedAt: exactTimestamp(summary.startedAt, "codex session_meta.timestamp"),
      endedAt: inferredTimestamp(summary.lastModifiedAt, "Codex journal filesystem mtime"),
      metadata: {
        discoveredAt: this.#clock().toISOString(),
        relativePath: summary.relativePath,
        logicalSessionId: summary.logicalSessionId,
        lastModifiedAt: summary.lastModifiedAt,
        sizeBytes: summary.sizeBytes,
      },
    };
  }

  #assertUnit(unit: ExperienceUnit): void {
    if (
      unit.source.sourceSystem !== "codex"
      || unit.source.sourceType !== "conversation_session"
      || unit.experienceId !== experienceIdFor(unit.source)
    ) {
      throw new Error("ExperienceUnit does not belong to CodexSourceAdapter");
    }
  }
}

export interface CodexIncrementalSyncOptions {
  reader: CodexSessionReader;
  checkpointStore: IncrementalSourceCheckpointStore;
  scope: MemoryScope;
  ingestor?: NormalizedExperienceIngestor;
  referenceOnly?: boolean;
  adapterVersion?: string;
  minimumIdleMs?: number;
  beforeCheckpointReference?: (
    reference: import("./development-experience-reference.js").DlmfDevelopmentExperienceReference,
  ) => Promise<void>;
  pageSize?: number;
  clock?: () => Date;
}

export class CodexIncrementalSyncService {
  readonly #service: GenericIncrementalSourceSyncService<CodexSessionPayload>;

  constructor(options: CodexIncrementalSyncOptions) {
    const clock = options.clock ?? (() => new Date());
    const minimumIdleMs = options.minimumIdleMs ?? 5 * 60 * 1000;
    if (
      !Number.isFinite(minimumIdleMs)
      || minimumIdleMs < 0
      || minimumIdleMs > 24 * 60 * 60 * 1000
    ) {
      throw new Error("Codex minimumIdleMs must be between 0 and 86400000");
    }
    const adapter = new CodexSourceAdapter({
      reader: options.reader,
      version: options.adapterVersion ?? "0.2.0",
      clock,
    });
    this.#service = new GenericIncrementalSourceSyncService({
      adapter,
      checkpointStore: options.checkpointStore,
      scope: options.scope,
      ...(options.ingestor === undefined ? {} : { ingestor: options.ingestor }),
      ...(options.referenceOnly === undefined ? {} : { referenceOnly: options.referenceOnly }),
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      ...(options.beforeCheckpointReference === undefined
        ? {}
        : { beforeCheckpointReference: options.beforeCheckpointReference }),
      clock,
      policyId: "codex-idle-v2-owner-evidence",
      eligibilityStateKey: (experience) => {
        const version = experience.sourceVersion?.value ?? "";
        const modifiedAt = typeof experience.metadata.lastModifiedAt === "string"
          ? experience.metadata.lastModifiedAt
          : "";
        return `${version}|${modifiedAt}`;
      },
      decide: (experience) => {
        if (experience.metadata.incompleteTail === true) {
          return { action: "defer", reasonCode: "journal_tail_incomplete" };
        }
        const userMessages = Number(experience.metadata.userMessageCount ?? 0);
        if (userMessages < 1) {
          return { action: "source_only", reasonCode: "no_user_authored_text" };
        }
        const modifiedAt = experience.metadata.lastModifiedAt;
        if (typeof modifiedAt !== "string") {
          return { action: "defer", reasonCode: "missing_last_modified_time" };
        }
        const modifiedMillis = Date.parse(modifiedAt);
        if (!Number.isFinite(modifiedMillis)) {
          return { action: "defer", reasonCode: "invalid_last_modified_time" };
        }
        if (clock().getTime() - modifiedMillis < minimumIdleMs) {
          return { action: "defer", reasonCode: "session_not_idle" };
        }
        return { action: "distill" };
      },
    });
  }

  baselineCurrent(): Promise<IncrementalSourceSyncResult> {
    return this.#service.baselineCurrent();
  }

  runOnce(): Promise<IncrementalSourceSyncResult> {
    return this.#service.runOnce();
  }
}
