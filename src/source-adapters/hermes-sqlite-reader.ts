import type { HermesMessageRow, HermesSchemaInspection, HermesSessionPayload, HermesSessionRow, HermesStateReader } from "./hermes-source-adapter.js";

type DatabaseSyncLike = {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
};

const utf8 = new TextDecoder("utf-8");
const HERMES_STRUCTURED_CONTENT_PREFIX = "\u0000json:";

function text(value: unknown): string {
  if (value instanceof Uint8Array) return utf8.decode(value);
  return String(value);
}
function bool(value: unknown): boolean { return Number(value ?? 0) === 1; }
function opt(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value);
}
function num(value: unknown): number { return Number(value ?? 0); }

function flattenHermesStructuredContent(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (part !== null && typeof part === "object" && !Array.isArray(part)) {
        const candidate = (part as Record<string, unknown>).text;
        return typeof candidate === "string" ? candidate : "";
      }
      return String(part);
    }).join("\n");
  }
  if (typeof value === "object") {
    const candidate = (value as Record<string, unknown>).text;
    return typeof candidate === "string" ? candidate : "";
  }
  return String(value);
}

function messageContent(value: unknown): string | undefined {
  const raw = opt(value);
  if (raw === undefined || !raw.startsWith(HERMES_STRUCTURED_CONTENT_PREFIX)) return raw;
  try {
    return flattenHermesStructuredContent(
      JSON.parse(raw.slice(HERMES_STRUCTURED_CONTENT_PREFIX.length)) as unknown,
    );
  } catch {
    // Fail closed on malformed source encoding: preserve the exact decoded
    // scalar rather than silently inventing or dropping memory evidence.
    return raw;
  }
}

export class HermesSqliteReader implements HermesStateReader {
  readonly #databasePath: string;
  constructor(databasePath: string) { this.#databasePath = databasePath; }

  async #withDb<T>(fn: (db: DatabaseSyncLike) => T): Promise<T> {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(this.#databasePath, { readOnly: true }) as unknown as DatabaseSyncLike;
    try { return fn(db); } finally { db.close(); }
  }

  async inspect(): Promise<HermesSchemaInspection> {
    return this.#withDb((db) => {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{name: unknown}>).map((x) => String(x.name));
      const has = (name: string) => tables.includes(name);
      const columns = Object.fromEntries(
        ["sessions", "messages"]
          .filter(has)
          .map((table) => [
            table,
            (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: unknown }>)
              .map((column) => String(column.name)),
          ]),
      );
      const schema = has("schema_version") ? db.prepare("SELECT version FROM schema_version LIMIT 1").get() as {version?: unknown} | undefined : undefined;
      const sessionCount = has("sessions") ? num((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {n: unknown}).n) : undefined;
      const messageCount = has("messages") ? num((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as {n: unknown}).n) : undefined;
      return { tables, columns, ...(schema?.version === undefined ? {} : { schemaVersion: String(schema.version) }), ...(sessionCount === undefined ? {} : { sessionCount }), ...(messageCount === undefined ? {} : { messageCount }) };
    });
  }

  async listSessions(request: { afterSessionId?: string; limit: number }): Promise<HermesSessionRow[]> {
    return this.#withDb((db) => {
      const rows = db.prepare(`SELECT
        CAST(id AS BLOB) AS id,
        CAST(source AS BLOB) AS source,
        CAST(profile_name AS BLOB) AS profile_name,
        CAST(title AS BLOB) AS title,
        message_count, tool_call_count, started_at, ended_at, last_activity_at,
        CAST(end_reason AS BLOB) AS end_reason,
        archived, expiry_finalized, hidden,
        CAST(parent_session_id AS BLOB) AS parent_session_id,
        CAST(chat_id AS BLOB) AS chat_id,
        CAST(chat_type AS BLOB) AS chat_type,
        CAST(thread_id AS BLOB) AS thread_id,
        CAST(user_id AS BLOB) AS user_id
        FROM sessions WHERE (? IS NULL OR id > ?) ORDER BY id ASC LIMIT ?`).all(request.afterSessionId ?? null, request.afterSessionId ?? null, request.limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: text(r.id), source: text(r.source), profileName: opt(r.profile_name), title: opt(r.title), messageCount: num(r.message_count), toolCallCount: num(r.tool_call_count),
        startedAt: r.started_at as number | string, ...(r.ended_at == null ? {} : { endedAt: r.ended_at as number | string }), ...(r.last_activity_at == null ? {} : { lastActivityAt: r.last_activity_at as number | string }),
        endReason: opt(r.end_reason), archived: bool(r.archived), expiryFinalized: bool(r.expiry_finalized), hidden: bool(r.hidden), parentSessionId: opt(r.parent_session_id), chatId: opt(r.chat_id), chatType: opt(r.chat_type), threadId: opt(r.thread_id), userId: opt(r.user_id),
      }));
    });
  }

  async readSession(sessionId: string): Promise<HermesSessionPayload> {
    return this.#withDb((db) => {
      const r = db.prepare(`SELECT
        CAST(id AS BLOB) AS id,
        CAST(source AS BLOB) AS source,
        CAST(profile_name AS BLOB) AS profile_name,
        CAST(title AS BLOB) AS title,
        message_count, tool_call_count, started_at, ended_at, last_activity_at,
        CAST(end_reason AS BLOB) AS end_reason,
        archived, expiry_finalized, hidden,
        CAST(parent_session_id AS BLOB) AS parent_session_id,
        CAST(chat_id AS BLOB) AS chat_id,
        CAST(chat_type AS BLOB) AS chat_type,
        CAST(thread_id AS BLOB) AS thread_id,
        CAST(user_id AS BLOB) AS user_id
        FROM sessions WHERE id=?`).get(sessionId) as Record<string, unknown> | undefined;
      if (!r) throw new Error(`Hermes session not found: ${sessionId}`);
      const session: HermesSessionRow = {
        id: text(r.id), source: text(r.source), profileName: opt(r.profile_name), title: opt(r.title), messageCount: num(r.message_count), toolCallCount: num(r.tool_call_count), startedAt: r.started_at as number | string,
        ...(r.ended_at == null ? {} : { endedAt: r.ended_at as number | string }), ...(r.last_activity_at == null ? {} : { lastActivityAt: r.last_activity_at as number | string }), endReason: opt(r.end_reason), archived: bool(r.archived), expiryFinalized: bool(r.expiry_finalized), hidden: bool(r.hidden), parentSessionId: opt(r.parent_session_id), chatId: opt(r.chat_id), chatType: opt(r.chat_type), threadId: opt(r.thread_id), userId: opt(r.user_id),
      };
      const rows = db.prepare(`SELECT
        id,
        CAST(session_id AS BLOB) AS session_id,
        CAST(role AS BLOB) AS role,
        CAST(content AS BLOB) AS content,
        CAST(tool_call_id AS BLOB) AS tool_call_id,
        CAST(tool_calls AS BLOB) AS tool_calls,
        CAST(tool_name AS BLOB) AS tool_name,
        timestamp,
        CAST(finish_reason AS BLOB) AS finish_reason,
        CAST(reasoning AS BLOB) AS reasoning,
        CAST(platform_message_id AS BLOB) AS platform_message_id,
        _compressed_summary, active, compacted,
        CAST(display_kind AS BLOB) AS display_kind,
        CAST(display_metadata AS BLOB) AS display_metadata
        FROM messages WHERE session_id=? ORDER BY id ASC`).all(sessionId) as Array<Record<string, unknown>>;
      const messages: HermesMessageRow[] = rows.map((m) => ({
        id: num(m.id), sessionId: text(m.session_id), role: text(m.role), content: messageContent(m.content), toolCallId: opt(m.tool_call_id), toolCalls: opt(m.tool_calls), toolName: opt(m.tool_name), timestamp: m.timestamp as number | string, finishReason: opt(m.finish_reason), reasoning: opt(m.reasoning), platformMessageId: opt(m.platform_message_id), compressedSummary: bool(m._compressed_summary), active: !Object.hasOwn(m,"active") || bool(m.active), compacted: bool(m.compacted), displayKind: opt(m.display_kind), displayMetadata: opt(m.display_metadata),
      }));
      return { session, messages };
    });
  }
}
