import { createHash } from "node:crypto";
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
import type { MemorySourceAdapter } from "./source-adapter.js";

export interface HermesSessionRow {
  id: string;
  source: string;
  profileName?: string | undefined;
  title?: string | undefined;
  messageCount: number;
  toolCallCount: number;
  startedAt: number | string;
  endedAt?: number | string | undefined;
  lastActivityAt?: number | string | undefined;
  endReason?: string | undefined;
  archived: boolean;
  expiryFinalized: boolean;
  hidden: boolean;
  parentSessionId?: string | undefined;
  chatId?: string | undefined;
  chatType?: string | undefined;
  threadId?: string | undefined;
  userId?: string | undefined;
}

export interface HermesMessageRow {
  id: number;
  sessionId: string;
  role: string;
  content?: string | undefined;
  toolCallId?: string | undefined;
  toolCalls?: string | undefined;
  toolName?: string | undefined;
  timestamp: number | string;
  finishReason?: string | undefined;
  reasoning?: string | undefined;
  platformMessageId?: string | undefined;
  compressedSummary: boolean;
  active: boolean;
  compacted: boolean;
  displayKind?: string | undefined;
  displayMetadata?: string | undefined;
}

export interface HermesSessionPayload {
  session: HermesSessionRow;
  messages: HermesMessageRow[];
}

export interface HermesSchemaInspection {
  schemaVersion?: string;
  tables: string[];
  sessionCount?: number;
  messageCount?: number;
}

export interface HermesStateReader {
  inspect(): Promise<HermesSchemaInspection>;
  listSessions(request: { afterSessionId?: string; limit: number }): Promise<HermesSessionRow[]>;
  readSession(sessionId: string): Promise<HermesSessionPayload>;
}

function timestamp(value: number | string | undefined, evidence: string): ExperienceTimestamp {
  if (value === undefined || value === null || value === "") return { certainty: "unknown" };
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  let millis: number;
  if (Number.isFinite(numeric)) millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  else millis = Date.parse(String(value));
  if (!Number.isFinite(millis)) return { certainty: "unknown" };
  return { value: new Date(millis).toISOString(), certainty: "exact", evidence };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sourceVersion(payload: HermesSessionPayload): SourceVersion {
  const last = payload.messages.at(-1);
  const value = `${payload.session.messageCount}:${payload.session.toolCallCount}:${String(payload.session.lastActivityAt ?? payload.session.endedAt ?? payload.session.startedAt)}:${last?.id ?? 0}`;
  return { value, scheme: "synthetic" };
}

function fingerprintPayload(payload: HermesSessionPayload): SourceFingerprint {
  const canonical = stableJson(payload);
  return { algorithm: "sha256", value: createHash("sha256").update(canonical, "utf8").digest("hex") };
}

function actorKind(role: string): ExperienceActor["kind"] {
  switch (role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "system": return "system";
    case "tool": return "tool";
    default: return "unknown";
  }
}

function actorId(role: string): string {
  return `hermes:${role || "unknown"}`;
}

export class HermesSourceAdapter implements MemorySourceAdapter<HermesSessionPayload> {
  readonly name = "HermesSourceAdapter";
  readonly version: string;
  readonly #reader: HermesStateReader;
  readonly #clock: () => Date;

  constructor(options: { reader: HermesStateReader; version?: string; clock?: () => Date }) {
    this.#reader = options.reader;
    this.version = options.version ?? "0.1.0";
    this.#clock = options.clock ?? (() => new Date());
  }

  async inspect(): Promise<SourceAdapterInspection> {
    const source = await this.#reader.inspect();
    const tables = new Set(source.tables);
    if (!tables.has("sessions") || !tables.has("messages")) {
      throw new Error("Hermes state source must expose sessions and messages tables");
    }
    return {
      adapterName: this.name,
      adapterVersion: this.version,
      sourceSystem: "hermes",
      sourceType: "conversation_session",
      capabilities: {
        historicalImport: "full",
        incrementalSync: "full",
        stableSourceId: "full",
        timestamps: "full",
        toolEvents: "full",
        attachments: "unknown",
        deletionDetection: "unknown",
      },
      metadata: {
        schemaVersion: source.schemaVersion ?? null,
        sessionCount: source.sessionCount ?? null,
        messageCount: source.messageCount ?? null,
        tables: source.tables,
      },
    };
  }

  async discover(request: DiscoverRequest): Promise<DiscoverPage> {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 1000) {
      throw new Error("discover limit must be an integer between 1 and 1000");
    }
    const rows = await this.#reader.listSessions({
      ...(request.cursor === undefined ? {} : { afterSessionId: request.cursor }),
      limit: request.limit,
    });
    const units = rows.map((row) => this.#unit(row));
    const nextCursor = rows.length === request.limit ? rows.at(-1)?.id : undefined;
    return { units, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  async read(unit: ExperienceUnit): Promise<SourceReadResult<HermesSessionPayload>> {
    this.#assertHermesUnit(unit);
    const payload = await this.#reader.readSession(unit.source.sourceId);
    if (payload.session.id !== unit.source.sourceId) throw new Error("Hermes reader returned mismatched session identity");
    return { unit: this.#unit(payload.session, sourceVersion(payload)), payload, readAt: this.#clock().toISOString() };
  }

  async fingerprint(unit: ExperienceUnit): Promise<SourceFingerprint> {
    this.#assertHermesUnit(unit);
    return fingerprintPayload(await this.#reader.readSession(unit.source.sourceId));
  }

  async normalize(result: SourceReadResult<HermesSessionPayload>): Promise<NormalizedExperience> {
    this.#assertHermesUnit(result.unit);
    const payload = result.payload;
    const source = result.unit.source;
    const actorsById = new Map<string, ExperienceActor>();
    const events: ExperienceEvent[] = [];
    const contents: ExperienceContent[] = [];

    for (const message of payload.messages) {
      const id = actorId(message.role);
      actorsById.set(id, { actorId: id, kind: actorKind(message.role) });
      const occurredAt = timestamp(message.timestamp, `messages.id=${message.id}.timestamp`);
      events.push({
        eventId: `hermes-message:${message.id}`,
        eventType: message.toolName || message.toolCalls ? "tool_or_message" : "message",
        actorId: id,
        occurredAt,
        ...(message.content === undefined ? {} : { content: message.content }),
        metadata: {
          role: message.role,
          toolCallId: message.toolCallId ?? null,
          toolCalls: message.toolCalls ?? null,
          toolName: message.toolName ?? null,
          finishReason: message.finishReason ?? null,
          compressedSummary: message.compressedSummary,
          active: message.active,
          compacted: message.compacted,
          platformMessageId: message.platformMessageId ?? null,
        },
      });
      if (message.content !== undefined && message.content.length > 0) {
        contents.push({ mediaType: "text/plain", text: message.content });
      }
    }

    const now = this.#clock().toISOString();
    const fp = fingerprintPayload(payload);
    const version = sourceVersion(payload);
    const unit = this.#unit(payload.session, version);
    return {
      sourceSystem: source.sourceSystem,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceVersion: version,
      experienceId: unit.experienceId,
      startedAt: unit.startedAt,
      endedAt: unit.endedAt,
      actors: [...actorsById.values()],
      events,
      content: contents,
      metadata: {
        title: payload.session.title ?? null,
        source: payload.session.source,
        profileName: payload.session.profileName ?? null,
        messageCount: payload.session.messageCount,
        toolCallCount: payload.session.toolCallCount,
        archived: payload.session.archived,
        expiryFinalized: payload.session.expiryFinalized,
        hidden: payload.session.hidden,
        endReason: payload.session.endReason ?? null,
        parentSessionId: payload.session.parentSessionId ?? null,
      },
      provenance: {
        source,
        sourceVersion: version,
        sourceFingerprint: fp,
        adapterName: this.name,
        adapterVersion: this.version,
        discoveredAt: result.unit.metadata.discoveredAt as string ?? result.readAt,
        readAt: result.readAt,
        normalizedAt: now,
        sourceLocator: `hermes:session:${source.sourceId}`,
      },
    };
  }

  #unit(row: HermesSessionRow, version?: SourceVersion): ExperienceUnit {
    const source = { sourceSystem: "hermes", sourceType: "conversation_session", sourceId: row.id } as const;
    const discoveredAt = this.#clock().toISOString();
    return {
      source,
      ...(version === undefined ? {} : { sourceVersion: version }),
      experienceId: experienceIdFor(source),
      startedAt: timestamp(row.startedAt, "sessions.started_at"),
      endedAt: timestamp(row.endedAt ?? row.lastActivityAt, row.endedAt === undefined ? "sessions.last_activity_at" : "sessions.ended_at"),
      metadata: {
        discoveredAt,
        source: row.source,
        profileName: row.profileName ?? null,
        messageCount: row.messageCount,
        toolCallCount: row.toolCallCount,
        hidden: row.hidden,
      },
    };
  }

  #assertHermesUnit(unit: ExperienceUnit): void {
    if (unit.source.sourceSystem !== "hermes" || unit.source.sourceType !== "conversation_session") {
      throw new Error("ExperienceUnit does not belong to HermesSourceAdapter");
    }
    if (unit.experienceId !== experienceIdFor(unit.source)) throw new Error("Hermes ExperienceUnit has invalid stable identity");
  }
}
