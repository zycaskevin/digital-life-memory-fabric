import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HermesSqliteReader } from "../src/index.js";

test("HermesSqliteReader preserves embedded NUL text across node:sqlite runtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-hermes-sqlite-"));
  const database = join(root, "state.db");
  const db = new DatabaseSync(database);
  const content = `\0json:${JSON.stringify([{ type: "text", text: "durable preference" }, { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(200_000)}` } }])}`;
  const projectedContent = "durable preference\n";
  const reasoning = "\0reasoning-with-nul";
  const displayMetadata = "\0{\"kind\":\"fixture\"}";
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        profile_name TEXT,
        title TEXT,
        message_count INTEGER NOT NULL,
        tool_call_count INTEGER NOT NULL,
        started_at REAL NOT NULL,
        ended_at REAL,
        last_activity_at REAL,
        end_reason TEXT,
        archived INTEGER NOT NULL,
        expiry_finalized INTEGER NOT NULL,
        hidden INTEGER NOT NULL,
        parent_session_id TEXT,
        chat_id TEXT,
        chat_type TEXT,
        thread_id TEXT,
        user_id TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        timestamp REAL NOT NULL,
        finish_reason TEXT,
        reasoning TEXT,
        platform_message_id TEXT,
        _compressed_summary INTEGER NOT NULL,
        active INTEGER NOT NULL,
        compacted INTEGER NOT NULL,
        display_kind TEXT,
        display_metadata TEXT
      );
    `);
    db.prepare(`
      INSERT INTO sessions (
        id, source, profile_name, title, message_count, tool_call_count, started_at,
        ended_at, last_activity_at, end_reason, archived, expiry_finalized, hidden,
        parent_session_id, chat_id, chat_type, thread_id, user_id
      ) VALUES (?, ?, ?, ?, 1, 0, ?, NULL, ?, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, NULL)
    `).run("session-nul", "cli", "default", "NUL fixture", 1_789_470_000, 1_789_470_001);
    db.prepare(`
      INSERT INTO messages (
        id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp,
        finish_reason, reasoning, platform_message_id, _compressed_summary, active,
        compacted, display_kind, display_metadata
      ) VALUES (1, ?, 'user', CAST(? AS TEXT), NULL, NULL, NULL, ?, 'stop',
                CAST(? AS TEXT), NULL, 0, 1, 0, 'text', CAST(? AS TEXT))
    `).run(
      "session-nul",
      new Uint8Array(Buffer.from(content, "utf8")),
      1_789_470_000,
      new Uint8Array(Buffer.from(reasoning, "utf8")),
      new Uint8Array(Buffer.from(displayMetadata, "utf8")),
    );
  } finally {
    db.close();
  }

  try {
    const reader = new HermesSqliteReader(database);
    const listed = await reader.listSessions({ limit: 10 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "session-nul");
    assert.equal(listed[0]?.title, "NUL fixture");

    const payload = await reader.readSession("session-nul");
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0]?.content, projectedContent);
    assert.equal(payload.messages[0]?.reasoning, reasoning);
    assert.equal(payload.messages[0]?.displayMetadata, displayMetadata);
    assert.ok(!payload.messages[0]?.content?.includes("data:image/png;base64"));
    assert.ok(Buffer.byteLength(content, "utf8") > 200_000);
    assert.equal(Buffer.byteLength(payload.messages[0]?.content ?? "", "utf8"), Buffer.byteLength(projectedContent, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
