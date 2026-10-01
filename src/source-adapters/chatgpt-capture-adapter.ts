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
import { readContainedSourceFile } from "./contained-source-file.js";

export const CHATGPT_CAPTURE_CONTRACT =
  "dlmf/chatgpt-captured-conversation/v1" as const;

export type ChatGptCapturedConversationStatus =
  | "active"
  | "completed"
  | "archived";

export interface ChatGptCapturedMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  createdAt?: string;
}

export interface ChatGptCapturedConversation {
  contract: typeof CHATGPT_CAPTURE_CONTRACT;
  conversationId: string;
  revision: string;
  status: ChatGptCapturedConversationStatus;
  startedAt?: string;
  updatedAt: string;
  messages: ChatGptCapturedMessage[];
  metadata?: Record<string, unknown>;
}

export interface ChatGptCaptureSummary {
  conversationId: string;
  relativePath: string;
  revision: string;
  status: ChatGptCapturedConversationStatus;
  startedAt?: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface ChatGptCapturePayload {
  summary: ChatGptCaptureSummary;
  snapshot: ChatGptCapturedConversation;
}

export interface ChatGptCaptureReader {
  inspect(): Promise<{ conversationCount: number }>;
  listConversations(request: {
    afterConversationId?: string;
    limit: number;
  }): Promise<ChatGptCaptureSummary[]>;
  readConversation(conversationId: string): Promise<ChatGptCapturePayload>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`ChatGPT capture ${field} is invalid`);
  }
  return value;
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const raw = string(value, field);
  const millis = Date.parse(raw);
  if (!Number.isFinite(millis)) throw new Error(`ChatGPT capture ${field} is invalid`);
  return new Date(millis).toISOString();
}

function requiredTimestamp(value: unknown, field: string): string {
  const raw = string(value, field);
  const millis = Date.parse(raw);
  if (!Number.isFinite(millis)) throw new Error(`ChatGPT capture ${field} is invalid`);
  return new Date(millis).toISOString();
}

function validateSnapshot(value: unknown): ChatGptCapturedConversation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ChatGPT capture snapshot must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.contract !== CHATGPT_CAPTURE_CONTRACT) {
    throw new Error("unsupported ChatGPT capture contract");
  }
  const conversationId = string(raw.conversationId, "conversationId");
  const revision = string(raw.revision, "revision");
  const status = raw.status;
  if (status !== "active" && status !== "completed" && status !== "archived") {
    throw new Error("ChatGPT capture status is invalid");
  }
  const startedAt = optionalTimestamp(raw.startedAt, "startedAt");
  const updatedAt = requiredTimestamp(raw.updatedAt, "updatedAt");
  if (!Array.isArray(raw.messages)) throw new Error("ChatGPT capture messages must be an array");
  const ids = new Set<string>();
  const messages: ChatGptCapturedMessage[] = raw.messages.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`ChatGPT capture message ${index} must be an object`);
    }
    const message = entry as Record<string, unknown>;
    const id = string(message.id, `messages[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate ChatGPT capture message id: ${id}`);
    ids.add(id);
    const role = message.role;
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
      throw new Error(`ChatGPT capture messages[${index}].role is invalid`);
    }
    if (typeof message.text !== "string") {
      throw new Error(`ChatGPT capture messages[${index}].text is invalid`);
    }
    const createdAt = optionalTimestamp(
      message.createdAt,
      `messages[${index}].createdAt`,
    );
    return {
      id,
      role,
      text: message.text,
      ...(createdAt === undefined ? {} : { createdAt }),
    };
  });
  const metadata = raw.metadata;
  if (
    metadata !== undefined
    && (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
  ) {
    throw new Error("ChatGPT capture metadata is invalid");
  }
  return {
    contract: CHATGPT_CAPTURE_CONTRACT,
    conversationId,
    revision,
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    updatedAt,
    messages,
    ...(metadata === undefined ? {} : { metadata: structuredClone(metadata as Record<string, unknown>) }),
  };
}

function exactTimestamp(value: string | undefined, evidence: string): ExperienceTimestamp {
  if (value === undefined) return { certainty: "unknown" };
  return { value, certainty: "exact", evidence };
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

function selectedChatGptMessages(
  snapshot: ChatGptCapturedConversation,
): ChatGptCapturedMessage[] {
  return snapshot.messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant")
      && message.text.trim().length > 0,
  );
}

function evidenceFingerprint(snapshot: ChatGptCapturedConversation): SourceFingerprint {
  const selected = selectedChatGptMessages(snapshot).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt ?? null,
  }));
  return {
    algorithm: "sha256",
    value: createHash("sha256").update(stableJson(selected), "utf8").digest("hex"),
  };
}

function sourceFor(conversationId: string) {
  return {
    sourceSystem: "chatgpt",
    sourceType: "captured_conversation",
    sourceId: conversationId,
  } as const;
}

function sourceVersion(summary: ChatGptCaptureSummary): SourceVersion {
  return { value: summary.revision, scheme: "revision" };
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
    throw new Error("ChatGPT capture relative path escapes configured root");
  }
  return relativePath.split(sep).join("/");
}

export class ChatGptCaptureDirectoryReader implements ChatGptCaptureReader {
  readonly #rootPath: string;
  #canonicalRoot: string | undefined;
  #index: Array<{ path: string; summary: ChatGptCaptureSummary }> | undefined;
  #indexById = new Map<
    string,
    { path: string; summary: ChatGptCaptureSummary }
  >();
  #freshForNextList = false;

  constructor(rootPath: string) {
    if (!rootPath.trim()) throw new Error("ChatGPT capture root must not be empty");
    this.#rootPath = rootPath;
  }

  async inspect(): Promise<{ conversationCount: number }> {
    const index = await this.#refreshIndex();
    this.#freshForNextList = true;
    return { conversationCount: index.length };
  }

  async listConversations(request: {
    afterConversationId?: string;
    limit: number;
  }): Promise<ChatGptCaptureSummary[]> {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000) {
      throw new Error("ChatGPT listConversations limit must be an integer between 1 and 1000");
    }
    let index: Array<{ path: string; summary: ChatGptCaptureSummary }>;
    if (request.afterConversationId === undefined) {
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
    if (request.afterConversationId !== undefined) {
      let low = 0;
      let high = index.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (
          compareStableIds(
            index[middle]!.summary.conversationId,
            request.afterConversationId,
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

  async readConversation(conversationId: string): Promise<ChatGptCapturePayload> {
    if (this.#index === undefined) await this.#refreshIndex();
    const entry = this.#indexById.get(conversationId);
    if (entry === undefined) throw new Error("ChatGPT captured conversation not found");
    const root = await this.#root();
    const file = await readContainedSourceFile(entry.path, root);
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text) as unknown;
    } catch {
      throw new Error("ChatGPT capture file contains invalid JSON");
    }
    const snapshot = validateSnapshot(parsed);
    if (snapshot.conversationId !== conversationId) {
      throw new Error("ChatGPT capture identity changed between discovery and read");
    }
    return {
      summary: this.#summary(
        snapshot,
        entry.summary.relativePath,
        file.sizeBytes,
      ),
      snapshot,
    };
  }

  async #root(): Promise<string> {
    this.#canonicalRoot ??= await realpath(this.#rootPath);
    return this.#canonicalRoot;
  }

  async #refreshIndex(): Promise<Array<{ path: string; summary: ChatGptCaptureSummary }>> {
    const root = await this.#root();
    const paths: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".json")) paths.push(path);
      }
    };
    await walk(root);

    const found: Array<{ path: string; summary: ChatGptCaptureSummary }> = [];
    const ids = new Set<string>();
    for (const path of paths.sort()) {
      const file = await readContainedSourceFile(path, root);
      let parsed: unknown;
      try {
        parsed = JSON.parse(file.text) as unknown;
      } catch {
        throw new Error("ChatGPT capture file contains invalid JSON");
      }
      const snapshot = validateSnapshot(parsed);
      if (ids.has(snapshot.conversationId)) {
        throw new Error(`duplicate ChatGPT conversation identifier: ${snapshot.conversationId}`);
      }
      ids.add(snapshot.conversationId);
      found.push({
        path,
        summary: this.#summary(snapshot, relative(root, path), file.sizeBytes),
      });
    }
    this.#index = found.sort((left, right) =>
      compareStableIds(
        left.summary.conversationId,
        right.summary.conversationId,
      )
    );
    this.#indexById = new Map(
      this.#index.map((entry) => [entry.summary.conversationId, entry]),
    );
    return this.#index;
  }

  #summary(
    snapshot: ChatGptCapturedConversation,
    relativePath: string,
    sizeBytes: number,
  ): ChatGptCaptureSummary {
    return {
      conversationId: snapshot.conversationId,
      relativePath: safeLocator(relativePath),
      revision: snapshot.revision,
      status: snapshot.status,
      ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
      updatedAt: snapshot.updatedAt,
      sizeBytes,
    };
  }
}

export class ChatGptCaptureSourceAdapter
implements MemorySourceAdapter<ChatGptCapturePayload> {
  readonly name = "ChatGptCaptureSourceAdapter";
  readonly version: string;
  readonly #reader: ChatGptCaptureReader;
  readonly #clock: () => Date;

  constructor(options: {
    reader: ChatGptCaptureReader;
    version?: string;
    clock?: () => Date;
  }) {
    this.#reader = options.reader;
    this.version = options.version ?? "0.1.0";
    this.#clock = options.clock ?? (() => new Date());
  }

  async inspect(): Promise<SourceAdapterInspection> {
    const source = await this.#reader.inspect();
    return {
      adapterName: this.name,
      adapterVersion: this.version,
      sourceSystem: "chatgpt",
      sourceType: "captured_conversation",
      capabilities: {
        historicalImport: "full",
        incrementalSync: "full",
        stableSourceId: "full",
        timestamps: "partial",
        toolEvents: "none",
        attachments: "none",
        deletionDetection: "none",
      },
      metadata: {
        conversationCount: source.conversationCount,
        captureContract: CHATGPT_CAPTURE_CONTRACT,
        cloudPublisherConnected: false,
        evidencePolicy: "explicit_user_assistant_text_only",
      },
    };
  }

  async discover(request: DiscoverRequest): Promise<DiscoverPage> {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000) {
      throw new Error("discover limit must be an integer between 1 and 1000");
    }
    if (request.checkpoint !== undefined) {
      throw new Error("ChatGPT capture incremental discovery does not accept historical checkpoints");
    }
    const summaries = await this.#reader.listConversations({
      ...(request.cursor === undefined ? {} : { afterConversationId: request.cursor }),
      limit: request.limit,
    });
    const units = summaries.map((summary) => this.#unit(summary));
    const nextCursor = summaries.length === request.limit
      ? summaries.at(-1)?.conversationId
      : undefined;
    return { units, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  async read(unit: ExperienceUnit): Promise<SourceReadResult<ChatGptCapturePayload>> {
    this.#assertUnit(unit);
    const payload = await this.#reader.readConversation(unit.source.sourceId);
    return {
      unit: this.#unit(payload.summary),
      payload,
      readAt: this.#clock().toISOString(),
    };
  }

  async normalize(
    result: SourceReadResult<ChatGptCapturePayload>,
  ): Promise<NormalizedExperience> {
    this.#assertUnit(result.unit);
    const { snapshot, summary } = result.payload;
    const source = sourceFor(snapshot.conversationId);
    const actors = new Map<string, ExperienceActor>();
    const events: ExperienceEvent[] = [];
    const content: ExperienceContent[] = [];
    let userMessageCount = 0;
    let assistantMessageCount = 0;

    for (const message of selectedChatGptMessages(snapshot)) {
      const actorId = `chatgpt:${message.role}`;
      actors.set(actorId, { actorId, kind: message.role });
      if (message.role === "user") userMessageCount += 1;
      else assistantMessageCount += 1;
      const occurredAt = exactTimestamp(
        message.createdAt,
        `captured message ${message.id}.createdAt`,
      );
      events.push({
        eventId: `chatgpt-message:${message.id}`,
        eventType: "message",
        actorId,
        occurredAt,
        content: message.text,
        metadata: { role: message.role },
      });
      content.push({ mediaType: "text/plain", text: message.text });
    }

    const version = sourceVersion(summary);
    return {
      sourceSystem: source.sourceSystem,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceVersion: version,
      experienceId: experienceIdFor(source),
      startedAt: exactTimestamp(snapshot.startedAt, "captured conversation startedAt"),
      endedAt: exactTimestamp(snapshot.updatedAt, "captured conversation updatedAt"),
      actors: [...actors.values()],
      events,
      content,
      metadata: {
        status: snapshot.status,
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        userMessageCount,
        assistantMessageCount,
        selectedMessageCount: userMessageCount + assistantMessageCount,
        excludedMessageCount:
          snapshot.messages.length - userMessageCount - assistantMessageCount,
        evidencePolicy: "explicit_user_assistant_text_only",
        cloudPublisherConnected: false,
      },
      provenance: {
        source,
        sourceVersion: version,
        sourceFingerprint: evidenceFingerprint(snapshot),
        adapterName: this.name,
        adapterVersion: this.version,
        discoveredAt: typeof result.unit.metadata.discoveredAt === "string"
          ? result.unit.metadata.discoveredAt
          : result.readAt,
        readAt: result.readAt,
        normalizedAt: this.#clock().toISOString(),
        sourceLocator: `chatgpt-capture:${summary.relativePath}`,
      },
    };
  }

  async fingerprint(unit: ExperienceUnit): Promise<SourceFingerprint> {
    this.#assertUnit(unit);
    return evidenceFingerprint(
      (await this.#reader.readConversation(unit.source.sourceId)).snapshot,
    );
  }

  #unit(summary: ChatGptCaptureSummary): ExperienceUnit {
    const source = sourceFor(summary.conversationId);
    return {
      source,
      sourceVersion: sourceVersion(summary),
      experienceId: experienceIdFor(source),
      startedAt: exactTimestamp(summary.startedAt, "captured conversation startedAt"),
      endedAt: exactTimestamp(summary.updatedAt, "captured conversation updatedAt"),
      metadata: {
        discoveredAt: this.#clock().toISOString(),
        relativePath: summary.relativePath,
        status: summary.status,
        revision: summary.revision,
      },
    };
  }

  #assertUnit(unit: ExperienceUnit): void {
    if (
      unit.source.sourceSystem !== "chatgpt"
      || unit.source.sourceType !== "captured_conversation"
      || unit.experienceId !== experienceIdFor(unit.source)
    ) {
      throw new Error("ExperienceUnit does not belong to ChatGptCaptureSourceAdapter");
    }
  }
}

export interface ChatGptCaptureIncrementalSyncOptions {
  reader: ChatGptCaptureReader;
  checkpointStore: IncrementalSourceCheckpointStore;
  scope: MemoryScope;
  ingestor?: NormalizedExperienceIngestor;
  referenceOnly?: boolean;
  adapterVersion?: string;
  pageSize?: number;
  clock?: () => Date;
}

export class ChatGptCaptureIncrementalSyncService {
  readonly #service: GenericIncrementalSourceSyncService<ChatGptCapturePayload>;

  constructor(options: ChatGptCaptureIncrementalSyncOptions) {
    const adapter = new ChatGptCaptureSourceAdapter({
      reader: options.reader,
      version: options.adapterVersion ?? "0.1.0",
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    this.#service = new GenericIncrementalSourceSyncService({
      adapter,
      checkpointStore: options.checkpointStore,
      scope: options.scope,
      ...(options.ingestor === undefined ? {} : { ingestor: options.ingestor }),
      ...(options.referenceOnly === undefined ? {} : { referenceOnly: options.referenceOnly }),
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      policyId: "chatgpt-capture-status-v2",
      eligibilityStateKey: (experience) => {
        const status = typeof experience.metadata.status === "string"
          ? experience.metadata.status
          : "";
        const revision = typeof experience.metadata.revision === "string"
          ? experience.metadata.revision
          : "";
        const updatedAt = typeof experience.metadata.updatedAt === "string"
          ? experience.metadata.updatedAt
          : "";
        return `${status}|${revision}|${updatedAt}`;
      },
      decide: (experience) => {
        if (experience.metadata.status === "active") {
          return { action: "defer", reasonCode: "conversation_active" };
        }
        const userMessages = Number(experience.metadata.userMessageCount ?? 0);
        if (userMessages < 1) {
          return { action: "source_only", reasonCode: "no_user_authored_text" };
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
