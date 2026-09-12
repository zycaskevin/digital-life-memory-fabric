import type { HermesMessageRow, HermesSchemaInspection, HermesSessionPayload, HermesSessionRow, HermesStateReader } from "./hermes-source-adapter.js";

type DatabaseSyncLike = {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
};

function bool(value: unknown): boolean { return Number(value ?? 0) === 1; }
function opt(value: unknown): string | undefined { return value === null || value === undefined ? undefined : String(value); }
function num(value: unknown): number { return Number(value ?? 0); }

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
      const schema = has("schema_version") ? db.prepare("SELECT version FROM schema_version LIMIT 1").get() as {version?: unknown} | undefined : undefined;
      const sessionCount = has("sessions") ? num((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {n: unknown}).n) : undefined;
      const messageCount = has("messages") ? num((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as {n: unknown}).n) : undefined;
      return { tables, ...(schema?.version === undefined ? {} : { schemaVersion: String(schema.version) }), ...(sessionCount === undefined ? {} : { sessionCount }), ...(messageCount === undefined ? {} : { messageCount }) };
    });
  }

  async listSessions(request: { afterSessionId?: string; limit: number }): Promise<HermesSessionRow[]> {
    return this.#withDb((db) => {
      const rows = db.prepare(`SELECT id, source, profile_name, title, message_count, tool_call_count, started_at, ended_at,
        last_activity_at, end_reason, archived, expiry_finalized, hidden, parent_session_id, chat_id, chat_type, thread_id, user_id
        FROM sessions WHERE (? IS NULL OR id > ?) ORDER BY id ASC LIMIT ?`).all(request.afterSessionId ?? null, request.afterSessionId ?? null, request.limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id), source: String(r.source), profileName: opt(r.profile_name), title: opt(r.title), messageCount: num(r.message_count), toolCallCount: num(r.tool_call_count),
        startedAt: r.started_at as number | string, ...(r.ended_at == null ? {} : { endedAt: r.ended_at as number | string }), ...(r.last_activity_at == null ? {} : { lastActivityAt: r.last_activity_at as number | string }),
        endReason: opt(r.end_reason), archived: bool(r.archived), expiryFinalized: bool(r.expiry_finalized), hidden: bool(r.hidden), parentSessionId: opt(r.parent_session_id), chatId: opt(r.chat_id), chatType: opt(r.chat_type), threadId: opt(r.thread_id), userId: opt(r.user_id),
      }));
    });
  }

  async readSession(sessionId: string): Promise<HermesSessionPayload> {
    return this.#withDb((db) => {
      const r = db.prepare(`SELECT id, source, profile_name, title, message_count, tool_call_count, started_at, ended_at,
        last_activity_at, end_reason, archived, expiry_finalized, hidden, parent_session_id, chat_id, chat_type, thread_id, user_id FROM sessions WHERE id=?`).get(sessionId) as Record<string, unknown> | undefined;
      if (!r) throw new Error(`Hermes session not found: ${sessionId}`);
      const session: HermesSessionRow = {
        id: String(r.id), source: String(r.source), profileName: opt(r.profile_name), title: opt(r.title), messageCount: num(r.message_count), toolCallCount: num(r.tool_call_count), startedAt: r.started_at as number | string,
        ...(r.ended_at == null ? {} : { endedAt: r.ended_at as number | string }), ...(r.last_activity_at == null ? {} : { lastActivityAt: r.last_activity_at as number | string }), endReason: opt(r.end_reason), archived: bool(r.archived), expiryFinalized: bool(r.expiry_finalized), hidden: bool(r.hidden), parentSessionId: opt(r.parent_session_id), chatId: opt(r.chat_id), chatType: opt(r.chat_type), threadId: opt(r.thread_id), userId: opt(r.user_id),
      };
      const rows = db.prepare(`SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason,
        reasoning, platform_message_id, _compressed_summary, active, compacted, display_kind, display_metadata FROM messages WHERE session_id=? ORDER BY id ASC`).all(sessionId) as Array<Record<string, unknown>>;
      const messages: HermesMessageRow[] = rows.map((m) => ({
        id: num(m.id), sessionId: String(m.session_id), role: String(m.role), content: opt(m.content), toolCallId: opt(m.tool_call_id), toolCalls: opt(m.tool_calls), toolName: opt(m.tool_name), timestamp: m.timestamp as number | string, finishReason: opt(m.finish_reason), reasoning: opt(m.reasoning), platformMessageId: opt(m.platform_message_id), compressedSummary: bool(m._compressed_summary), active: !Object.hasOwn(m,"active") || bool(m.active), compacted: bool(m.compacted), displayKind: opt(m.display_kind), displayMetadata: opt(m.display_metadata),
      }));
      return { session, messages };
    });
  }
}
