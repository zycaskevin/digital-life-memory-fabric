import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexIncrementalSyncService,
  CodexJsonlSessionReader,
  CodexSourceAdapter,
  type IncrementalSourceCheckpoint,
  type IncrementalSourceCheckpointStore,
} from "../src/index.js";

class MemoryCheckpointStore implements IncrementalSourceCheckpointStore {
  value?: IncrementalSourceCheckpoint;
  async load() {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }
  async save(value: IncrementalSourceCheckpoint) {
    this.value = structuredClone(value);
  }
}

function sessionRecords(
  sessionId: string,
  userText = "I prefer tea.",
  assistantText = "Acknowledged.",
  journalId = sessionId,
) {
  return [
    {
      ordinal: 0,
      timestamp: "2026-10-01T00:00:00.000Z",
      type: "session_meta",
      payload: {
        session_id: sessionId,
        id: journalId,
        timestamp: "2026-10-01T00:00:00.000Z",
        source: "cli",
        originator: "codex_cli_rs",
        base_instructions: "SECRET_BASE_INSTRUCTIONS",
      },
    },
    {
      ordinal: 1,
      timestamp: "2026-10-01T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "developer-message",
        role: "developer",
        content: [{ type: "input_text", text: "SECRET_DEVELOPER_CONTROL" }],
      },
    },
    {
      ordinal: 2,
      timestamp: "2026-10-01T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "user-message",
        role: "user",
        content: [{ type: "input_text", text: userText }],
      },
    },
    {
      ordinal: 3,
      timestamp: "2026-10-01T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        encrypted_content: "SECRET_ENCRYPTED_REASONING",
      },
    },
    {
      ordinal: 4,
      timestamp: "2026-10-01T00:00:04.000Z",
      type: "event_msg",
      payload: {
        type: "custom_tool_call_output",
        output: "SECRET_TOOL_OUTPUT",
      },
    },
    {
      ordinal: 5,
      timestamp: "2026-10-01T00:00:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "assistant-message",
        role: "assistant",
        content: [{ type: "output_text", text: assistantText }],
      },
    },
  ];
}

async function writeJsonl(path: string, records: unknown[]) {
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dlmf-codex-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Codex adapter normalizes only explicit user/assistant text and excludes control-plane secrets", async () => {
  await withRoot(async (root) => {
    const nested = join(root, "2026", "10", "01");
    await mkdir(nested, { recursive: true });
    await writeJsonl(join(nested, "rollout.jsonl"), sessionRecords("session-a"));

    const reader = new CodexJsonlSessionReader(root);
    const adapter = new CodexSourceAdapter({
      reader,
      clock: () => new Date("2026-10-01T01:00:00.000Z"),
    });
    const inspection = await adapter.inspect();
    assert.equal(inspection.sourceSystem, "codex");
    assert.equal(inspection.capabilities.incrementalSync, "partial");

    const page = await adapter.discover({ limit: 10 });
    assert.equal(page.units.length, 1);
    const read = await adapter.read(page.units[0]!);
    const normalized = await adapter.normalize(read);
    const serialized = JSON.stringify(normalized);

    assert.equal(normalized.sourceId, "session-a");
    assert.deepEqual(
      normalized.events.map((event) => event.content),
      ["I prefer tea.", "Acknowledged."],
    );
    assert.equal(normalized.metadata.userMessageCount, 1);
    assert.equal(normalized.metadata.assistantMessageCount, 1);
    for (const secret of [
      "SECRET_BASE_INSTRUCTIONS",
      "SECRET_DEVELOPER_CONTROL",
      "SECRET_ENCRYPTED_REASONING",
      "SECRET_TOOL_OUTPUT",
    ]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
  });
});

test("Codex evidence fingerprint ignores operational-only journal drift", async () => {
  await withRoot(async (root) => {
    const file = join(root, "rollout.jsonl");
    const records: unknown[] = sessionRecords("session-a");
    await writeJsonl(file, records);
    const adapter = new CodexSourceAdapter({ reader: new CodexJsonlSessionReader(root) });
    let page = await adapter.discover({ limit: 10 });
    const before = await adapter.fingerprint(page.units[0]!);

    records.push({
      ordinal: 6,
      timestamp: "2026-10-01T00:00:06.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: "SECRET_TELEMETRY" },
    });
    await writeJsonl(file, records);
    page = await adapter.discover({ limit: 10 });
    const after = await adapter.fingerprint(page.units[0]!);
    assert.deepEqual(after, before);
  });
});

test("Codex idle gate defers active bytes without checkpoint then distills same fingerprint later", async () => {
  await withRoot(async (root) => {
    const file = join(root, "rollout.jsonl");
    await writeJsonl(file, sessionRecords("session-idle"));
    const mtime = new Date("2026-10-01T00:00:00.000Z");
    await utimes(file, mtime, mtime);

    const checkpointStore = new MemoryCheckpointStore();
    let now = new Date("2026-10-01T00:01:00.000Z");
    let ingests = 0;
    const make = () => new CodexIncrementalSyncService({
      reader: new CodexJsonlSessionReader(root),
      checkpointStore,
      scope: {
        tenantId: "tenant-arthur",
        lifeDid: "did:arthurverse:nancy",
        memoryNamespace: "life",
      },
      ingestor: {
        async ingest() {
          ingests += 1;
          return { receiptId: `dist_codex_${ingests}`, status: "complete" as const };
        },
      },
      minimumIdleMs: 5 * 60 * 1000,
      clock: () => now,
    });

    let result = await make().runOnce();
    assert.equal(result.deferred, 1);
    assert.equal(result.ingested, 0);
    assert.equal(checkpointStore.value?.fingerprints["session-idle"], undefined);

    now = new Date("2026-10-01T00:10:00.000Z");
    result = await make().runOnce();
    assert.equal(result.ingested, 1);
    assert.equal(ingests, 1);
    assert.ok(checkpointStore.value?.fingerprints["session-idle"]);

    result = await make().runOnce();
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1);
    assert.equal(ingests, 1);
  });
});


test("torn Codex tail defers only that journal and does not block later sessions", async () => {
  await withRoot(async (root) => {
    const tornFile = join(root, "a.jsonl");
    const fullFile = join(root, "b.jsonl");
    const tornRecords = sessionRecords(
      "shared-session-a",
      "Owner-authored torn-tail preference.",
      "Acknowledged.",
      "journal-a",
    );
    await writeFile(
      tornFile,
      tornRecords.map((record) => JSON.stringify(record)).join("\n")
        + "\n{\"ordinal\":99,\"type\":",
      "utf8",
    );
    await writeJsonl(
      fullFile,
      sessionRecords(
        "shared-session-b",
        "Owner-authored complete preference.",
        "Acknowledged.",
        "journal-b",
      ),
    );
    const old = new Date("2026-09-30T23:00:00.000Z");
    await utimes(tornFile, old, old);
    await utimes(fullFile, old, old);

    const checkpointStore = new MemoryCheckpointStore();
    const ingested: string[] = [];
    const sync = new CodexIncrementalSyncService({
      reader: new CodexJsonlSessionReader(root),
      checkpointStore,
      scope: {
        tenantId: "tenant-arthur",
        lifeDid: "did:arthurverse:nancy",
        memoryNamespace: "life",
      },
      ingestor: {
        async ingest(experience) {
          ingested.push(experience.sourceId);
          return {
            receiptId: `dist_torn_${ingested.length}`,
            status: "complete" as const,
          };
        },
      },
      minimumIdleMs: 0,
      clock: () => new Date("2026-10-01T01:00:00.000Z"),
    });

    const result = await sync.runOnce();
    assert.equal(result.deferred, 1);
    assert.equal(result.ingested, 1);
    assert.deepEqual(ingested, ["journal-b"]);
    assert.equal(checkpointStore.value?.fingerprints["journal-a"], undefined);
    assert.ok(checkpointStore.value?.fingerprints["journal-b"]);
  });
});

test("partially-created Codex journal without a complete session_meta is isolated until later", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "a.jsonl"), "{\"type\":\"session_", "utf8");
    await writeJsonl(
      join(root, "b.jsonl"),
      sessionRecords("session-b", "complete", "ack", "journal-b"),
    );
    const reader = new CodexJsonlSessionReader(root);
    const inspection = await reader.inspect();
    assert.equal(inspection.sessionCount, 1);
    const listed = await reader.listSessions({ limit: 10 });
    assert.deepEqual(listed.map((item) => item.sessionId), ["journal-b"]);
  });
});

test("Codex session without user-authored text is source-only", async () => {
  await withRoot(async (root) => {
    const records = sessionRecords("session-no-user").filter((record) => {
      const payload = (record as { payload?: { role?: string } }).payload;
      return payload?.role !== "user";
    });
    const file = join(root, "rollout.jsonl");
    await writeJsonl(file, records);
    const old = new Date("2026-09-30T23:00:00.000Z");
    await utimes(file, old, old);
    const checkpointStore = new MemoryCheckpointStore();
    let ingests = 0;
    const sync = new CodexIncrementalSyncService({
      reader: new CodexJsonlSessionReader(root),
      checkpointStore,
      scope: {
        tenantId: "tenant-arthur",
        lifeDid: "did:arthurverse:nancy",
        memoryNamespace: "life",
      },
      ingestor: {
        async ingest() {
          ingests += 1;
          return { receiptId: "dist_never", status: "complete" as const };
        },
      },
      clock: () => new Date("2026-10-01T01:00:00.000Z"),
    });
    const result = await sync.runOnce();
    assert.equal(result.sourceOnly, 1);
    assert.equal(result.ingested, 0);
    assert.equal(ingests, 0);
    assert.ok(checkpointStore.value?.fingerprints["session-no-user"]);
  });
});

test("Codex reader distinguishes journal ids that share a higher-level session_id", async () => {
  await withRoot(async (root) => {
    await writeJsonl(
      join(root, "a.jsonl"),
      sessionRecords("shared-session", "first", "ack", "journal-a"),
    );
    await writeJsonl(
      join(root, "b.jsonl"),
      sessionRecords("shared-session", "second", "ack", "journal-b"),
    );
    const reader = new CodexJsonlSessionReader(root);
    assert.equal((await reader.inspect()).sessionCount, 2);
    const listed = await reader.listSessions({ limit: 10 });
    assert.deepEqual(listed.map((item) => item.sessionId), ["journal-a", "journal-b"]);
  });
});

test("Codex reader collapses same-id rollout continuations when evidence is a strict prefix chain", async () => {
  await withRoot(async (root) => {
    const base: unknown[] = sessionRecords(
      "shared-session",
      "first",
      "ack",
      "same-journal",
    );
    const extended: unknown[] = structuredClone(base);
    extended.push(
      {
        ordinal: 6,
        timestamp: "2026-10-01T00:00:06.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "second" }],
        },
      },
      {
        ordinal: 7,
        timestamp: "2026-10-01T00:00:07.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ack-two" }],
        },
      },
    );
    await writeJsonl(join(root, "a.jsonl"), base);
    await writeJsonl(join(root, "b.jsonl"), extended);

    const reader = new CodexJsonlSessionReader(root);
    assert.equal((await reader.inspect()).sessionCount, 1);
    const listed = await reader.listSessions({ limit: 10 });
    assert.deepEqual(listed.map((item) => item.sessionId), ["same-journal"]);

    const adapter = new CodexSourceAdapter({ reader });
    const page = await adapter.discover({ limit: 10 });
    const normalized = await adapter.normalize(await adapter.read(page.units[0]!));
    assert.deepEqual(
      normalized.events.map((event) => event.content),
      ["first", "ack", "second", "ack-two"],
    );
  });
});

test("Codex reader fails closed when same-id rollout evidence diverges", async () => {
  await withRoot(async (root) => {
    await writeJsonl(
      join(root, "a.jsonl"),
      sessionRecords("session-a", "first", "ack", "same-journal"),
    );
    await writeJsonl(
      join(root, "b.jsonl"),
      sessionRecords("session-b", "second", "ack", "same-journal"),
    );
    const reader = new CodexJsonlSessionReader(root);
    await assert.rejects(
      () => reader.inspect(),
      /duplicate Codex session identifier has divergent evidence/,
    );
  });
});

test("Codex reader fails closed on malformed journal and does not follow symlink files", async () => {
  await withRoot(async (root) => {
    const valid = join(root, "valid.jsonl");
    await writeJsonl(valid, sessionRecords("valid-id"));
    await symlink(valid, join(root, "linked.jsonl"));
    const reader = new CodexJsonlSessionReader(root);
    assert.equal((await reader.inspect()).sessionCount, 1);

    await writeFile(join(root, "broken.jsonl"), "{bad-json}\n", "utf8");
    await assert.rejects(() => reader.inspect(), /invalid JSON/);
  });
});



test("Codex user-role host context is excluded while one provable user part is retained", async () => {
  await withRoot(async (root) => {
    const records: unknown[] = sessionRecords("session-context");
    const user = records.find((record) => {
      const payload = (record as { payload?: { role?: string } }).payload;
      return payload?.role === "user";
    }) as { payload: { content: Array<{ type: string; text: string }> } };
    user.payload.content = [
      { type: "input_text", text: "# AGENTS.md instructions\nSECRET_AGENT_CONTEXT" },
      { type: "input_text", text: "My durable preference is oolong tea." },
    ];
    await writeJsonl(join(root, "rollout.jsonl"), records);

    const adapter = new CodexSourceAdapter({
      reader: new CodexJsonlSessionReader(root),
    });
    const page = await adapter.discover({ limit: 10 });
    const normalized = await adapter.normalize(await adapter.read(page.units[0]!));
    const serialized = JSON.stringify(normalized);
    assert.equal(normalized.metadata.userMessageCount, 1);
    assert.equal(serialized.includes("SECRET_AGENT_CONTEXT"), false);
    assert.equal(serialized.includes("My durable preference is oolong tea."), true);
  });
});

test("Codex ambiguous multipart user envelope is not promoted as owner-authored evidence", async () => {
  await withRoot(async (root) => {
    const records: unknown[] = sessionRecords("session-ambiguous");
    const user = records.find((record) => {
      const payload = (record as { payload?: { role?: string } }).payload;
      return payload?.role === "user";
    }) as { payload: { content: Array<{ type: string; text: string }> } };
    user.payload.content = [
      { type: "input_text", text: "UNPROVEN_CONTEXT_A" },
      { type: "input_text", text: "UNPROVEN_CONTEXT_B" },
    ];
    const file = join(root, "rollout.jsonl");
    await writeJsonl(file, records);
    const old = new Date("2026-09-30T23:00:00.000Z");
    await utimes(file, old, old);

    const checkpointStore = new MemoryCheckpointStore();
    let ingests = 0;
    const sync = new CodexIncrementalSyncService({
      reader: new CodexJsonlSessionReader(root),
      checkpointStore,
      scope: {
        tenantId: "tenant-arthur",
        lifeDid: "did:arthurverse:nancy",
        memoryNamespace: "life",
      },
      ingestor: {
        async ingest() {
          ingests += 1;
          return { receiptId: "dist_never", status: "complete" as const };
        },
      },
      clock: () => new Date("2026-10-01T01:00:00.000Z"),
    });

    const result = await sync.runOnce();
    assert.equal(result.sourceOnly, 1);
    assert.equal(result.ingested, 0);
    assert.equal(ingests, 0);
  });
});

test("Codex repeated owner-like text cannot make unrelated multipart context look owner-authored", async () => {
  await withRoot(async (root) => {
    const records: unknown[] = sessionRecords("session-repeated-ambiguity");
    const firstUserIndex = records.findIndex((record) => {
      const payload = (record as { payload?: { role?: string } }).payload;
      return payload?.role === "user";
    });
    const firstUser = records[firstUserIndex] as {
      payload: { content: Array<{ type: string; text: string }> };
    };
    firstUser.payload.content = [
      { type: "input_text", text: "UNPROVEN_CONTEXT_A" },
      { type: "input_text", text: "Continue" },
    ];
    records.splice(firstUserIndex + 1, 0, {
      ordinal: 2.5,
      timestamp: "2026-10-01T00:00:02.500Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "user-message-2",
        role: "user",
        content: [
          { type: "input_text", text: "UNPROVEN_CONTEXT_B" },
          { type: "input_text", text: "Continue" },
        ],
      },
    });
    const file = join(root, "rollout.jsonl");
    await writeJsonl(file, records);
    const old = new Date("2026-09-30T23:00:00.000Z");
    await utimes(file, old, old);

    const checkpointStore = new MemoryCheckpointStore();
    let ingests = 0;
    const sync = new CodexIncrementalSyncService({
      reader: new CodexJsonlSessionReader(root),
      checkpointStore,
      scope: {
        tenantId: "tenant-arthur",
        lifeDid: "did:arthurverse:nancy",
        memoryNamespace: "life",
      },
      ingestor: {
        async ingest() {
          ingests += 1;
          return { receiptId: "dist_never", status: "complete" as const };
        },
      },
      clock: () => new Date("2026-10-01T01:00:00.000Z"),
    });

    const result = await sync.runOnce();
    assert.equal(result.sourceOnly, 1);
    assert.equal(result.ingested, 0);
    assert.equal(ingests, 0);
  });
});

test("Codex pagination uses one strict total identifier ordering", async () => {
  await withRoot(async (root) => {
    await writeJsonl(
      join(root, "a.jsonl"),
      sessionRecords("s1", "first", "ack", "é"),
    );
    await writeJsonl(
      join(root, "b.jsonl"),
      sessionRecords("s2", "second", "ack", "e\u0301"),
    );
    const reader = new CodexJsonlSessionReader(root);
    const first = await reader.listSessions({ limit: 1 });
    assert.equal(first.length, 1);
    const second = await reader.listSessions({
      afterSessionId: first[0]!.sessionId,
      limit: 1,
    });
    assert.equal(second.length, 1);
    assert.notEqual(second[0]!.sessionId, first[0]!.sessionId);
    const third = await reader.listSessions({
      afterSessionId: second[0]!.sessionId,
      limit: 1,
    });
    assert.equal(third.length, 0);
  });
});


test("Codex reader keeps its initially pinned root when the root pathname is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-codex-root-pin-"));
  const moved = root + "-moved";
  const outside = await mkdtemp(join(tmpdir(), "dlmf-codex-root-outside-"));
  try {
    const fileName = "rollout.jsonl";
    await writeJsonl(join(root, fileName), sessionRecords("journal-root-pin"));
    await writeJsonl(
      join(outside, fileName),
      sessionRecords("external", "SECRET_OUTSIDE", "ack", "journal-root-pin"),
    );
    const reader = new CodexJsonlSessionReader(root);
    assert.equal((await reader.inspect()).sessionCount, 1);

    await rename(root, moved);
    await symlink(outside, root);
    await assert.rejects(
      () => reader.readSession("journal-root-pin"),
      /source file escapes configured root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rename(moved, root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Codex cached index still rejects a file replaced by an out-of-root symlink before read", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "dlmf-codex-outside-"));
    try {
      const valid = join(root, "valid.jsonl");
      const outsideFile = join(outside, "outside.jsonl");
      await writeJsonl(valid, sessionRecords("journal-race"));
      await writeJsonl(
        outsideFile,
        sessionRecords("external-session", "SECRET_OUTSIDE", "ack", "journal-race"),
      );
      const reader = new CodexJsonlSessionReader(root);
      assert.equal((await reader.inspect()).sessionCount, 1);
      await rm(valid);
      await symlink(outsideFile, valid);
      await assert.rejects(
        () => reader.readSession("journal-race"),
        /source file escapes configured root|became a symlink/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
