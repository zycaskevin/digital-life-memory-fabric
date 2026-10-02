import assert from "node:assert/strict";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHATGPT_CAPTURE_CONTRACT,
  ChatGptCaptureDirectoryReader,
  ChatGptCaptureIncrementalSyncService,
  ChatGptCaptureSourceAdapter,
  ChatGptSourceAdapter,
  type ChatGptCapturedConversation,
  type ChatGptSourceTransport,
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

function snapshot(
  status: ChatGptCapturedConversation["status"],
  options: { revision?: string; userText?: string; assistantText?: string } = {},
): ChatGptCapturedConversation {
  return {
    contract: CHATGPT_CAPTURE_CONTRACT,
    conversationId: "chatgpt-conversation-001",
    revision: options.revision ?? "r1",
    status,
    startedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:05:00.000Z",
    messages: [
      {
        id: "sys-1",
        role: "system",
        text: "SECRET_SYSTEM_CONTROL",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "u-1",
        role: "user",
        text: options.userText ?? "My long-term preference is unsweetened tea.",
        createdAt: "2026-10-01T00:01:00.000Z",
      },
      {
        id: "tool-1",
        role: "tool",
        text: "SECRET_TOOL_BODY",
        createdAt: "2026-10-01T00:02:00.000Z",
      },
      {
        id: "a-1",
        role: "assistant",
        text: options.assistantText ?? "Acknowledged.",
        createdAt: "2026-10-01T00:03:00.000Z",
      },
    ],
  };
}

async function writeSnapshot(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dlmf-chatgpt-capture-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sync(
  root: string,
  checkpointStore: MemoryCheckpointStore,
  ingests: string[],
) {
  return new ChatGptCaptureIncrementalSyncService({
    reader: new ChatGptCaptureDirectoryReader(root),
    checkpointStore,
    scope: {
      tenantId: "tenant-arthur",
      lifeDid: "did:arthurverse:nancy",
      memoryNamespace: "life",
    },
    ingestor: {
      async ingest(experience) {
        ingests.push(String(experience.events[0]?.content ?? ""));
        return {
          receiptId: `dist_chatgpt_${ingests.length}`,
          status: "complete" as const,
        };
      },
    },
    clock: () => new Date("2026-10-01T01:00:00.000Z"),
  });
}

test("ChatGPT capture normalizes only user/assistant text and labels cloud publisher gap", async () => {
  await withRoot(async (root) => {
    await writeSnapshot(join(root, "conversation.json"), snapshot("completed"));
    const reader = new ChatGptCaptureDirectoryReader(root);
    const adapter = new ChatGptCaptureSourceAdapter({ reader });
    const inspection = await adapter.inspect();
    assert.equal(inspection.metadata.cloudPublisherConnected, false);
    assert.equal(inspection.metadata.captureContract, CHATGPT_CAPTURE_CONTRACT);

    const page = await adapter.discover({ limit: 10 });
    const normalized = await adapter.normalize(await adapter.read(page.units[0]!));
    const serialized = JSON.stringify(normalized);
    assert.deepEqual(
      normalized.events.map((event) => event.content),
      ["My long-term preference is unsweetened tea.", "Acknowledged."],
    );
    assert.equal(normalized.metadata.userMessageCount, 1);
    assert.equal(normalized.metadata.assistantMessageCount, 1);
    assert.equal(serialized.includes("SECRET_SYSTEM_CONTROL"), false);
    assert.equal(serialized.includes("SECRET_TOOL_BODY"), false);
  });
});

test("ChatGPT transport is provenance only and keeps one logical source identity", async () => {
  await withRoot(async (root) => {
    await writeSnapshot(join(root, "conversation.json"), snapshot("completed"));
    const transports: ChatGptSourceTransport[] = [
      "context_publisher",
      "export",
      "compliance_api",
    ];
    const identities = new Set<string>();

    for (const transport of transports) {
      const adapter = new ChatGptSourceAdapter({
        reader: new ChatGptCaptureDirectoryReader(root),
        transport,
      });
      const inspection = await adapter.inspect();
      assert.equal(inspection.metadata.transport, transport);
      if (transport === "context_publisher") {
        assert.equal(inspection.metadata.cloudPublisherConnected, false);
      } else {
        assert.equal(
          Object.hasOwn(inspection.metadata, "cloudPublisherConnected"),
          false,
        );
      }

      const page = await adapter.discover({ limit: 10 });
      const unit = page.units[0]!;
      const normalized = await adapter.normalize(await adapter.read(unit));
      identities.add(`${unit.source.sourceId}|${unit.experienceId}`);
      assert.equal(normalized.metadata.transport, transport);
      assert.equal(normalized.sourceId, "chatgpt-conversation-001");
      assert.equal(
        normalized.provenance.sourceLocator,
        transport === "context_publisher"
          ? "chatgpt-capture:conversation.json"
          : `chatgpt-${transport}:conversation.json`,
      );
    }

    assert.equal(identities.size, 1);
    assert.equal(
      new ChatGptCaptureSourceAdapter({
        reader: new ChatGptCaptureDirectoryReader(root),
      }).name,
      "ChatGptCaptureSourceAdapter",
    );
  });
});

test("active ChatGPT snapshot defers without checkpoint and identical completed evidence later distills", async () => {
  await withRoot(async (root) => {
    const file = join(root, "conversation.json");
    await writeSnapshot(file, snapshot("active"));
    const checkpointStore = new MemoryCheckpointStore();
    const ingests: string[] = [];

    let result = await sync(root, checkpointStore, ingests).runOnce();
    assert.equal(result.deferred, 1);
    assert.equal(result.ingested, 0);
    assert.equal(
      checkpointStore.value?.fingerprints["chatgpt-conversation-001"],
      undefined,
    );

    const completed = snapshot("completed", { revision: "r2" });
    await writeSnapshot(file, completed);
    result = await sync(root, checkpointStore, ingests).runOnce();
    assert.equal(result.changed, 1);
    assert.equal(result.ingested, 1);
    assert.equal(ingests.length, 1);
    assert.ok(
      checkpointStore.value?.fingerprints["chatgpt-conversation-001"],
    );

    result = await sync(root, checkpointStore, ingests).runOnce();
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1);
    assert.equal(ingests.length, 1);
  });
});

test("mutated completed ChatGPT snapshot re-enters while revision-only drift does not", async () => {
  await withRoot(async (root) => {
    const file = join(root, "conversation.json");
    const checkpointStore = new MemoryCheckpointStore();
    const ingests: string[] = [];

    await writeSnapshot(file, snapshot("completed"));
    let result = await sync(root, checkpointStore, ingests).runOnce();
    assert.equal(result.ingested, 1);

    await writeSnapshot(file, snapshot("completed", { revision: "r2" }));
    result = await sync(root, checkpointStore, ingests).runOnce();
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1);

    await writeSnapshot(
      file,
      snapshot("completed", {
        revision: "r3",
        userText: "My long-term preference is black coffee.",
      }),
    );
    result = await sync(root, checkpointStore, ingests).runOnce();
    assert.equal(result.changed, 1);
    assert.equal(result.ingested, 1);
    assert.equal(ingests.length, 2);
  });
});

test("ChatGPT completed snapshot with no user-authored text is source-only", async () => {
  await withRoot(async (root) => {
    const value = snapshot("completed");
    value.messages = value.messages.filter((message) => message.role !== "user");
    await writeSnapshot(join(root, "conversation.json"), value);
    const checkpointStore = new MemoryCheckpointStore();
    const ingests: string[] = [];

    const result = await sync(root, checkpointStore, ingests).runOnce();
    assert.equal(result.sourceOnly, 1);
    assert.equal(result.ingested, 0);
    assert.equal(ingests.length, 0);
    assert.ok(
      checkpointStore.value?.fingerprints["chatgpt-conversation-001"],
    );
  });
});

test("ChatGPT capture reader fails closed on malformed contract and duplicate conversation ids", async () => {
  await withRoot(async (root) => {
    await writeSnapshot(join(root, "bad.json"), {
      ...snapshot("completed"),
      contract: "wrong-contract",
    });
    await assert.rejects(
      () => new ChatGptCaptureDirectoryReader(root).inspect(),
      /unsupported ChatGPT capture contract/,
    );
  });

  await withRoot(async (root) => {
    await writeSnapshot(join(root, "a.json"), snapshot("completed"));
    await writeSnapshot(join(root, "b.json"), snapshot("archived"));
    await assert.rejects(
      () => new ChatGptCaptureDirectoryReader(root).inspect(),
      /duplicate ChatGPT conversation identifier/,
    );
  });
});

test("ChatGPT capture reader ignores symlink snapshot files", async () => {
  await withRoot(async (root) => {
    const valid = join(root, "valid.json");
    await writeSnapshot(valid, snapshot("completed"));
    await symlink(valid, join(root, "linked.json"));
    const reader = new ChatGptCaptureDirectoryReader(root);
    assert.equal((await reader.inspect()).conversationCount, 1);
  });
});



test("ChatGPT blank user text does not satisfy the owner-authored gate", async () => {
  await withRoot(async (root) => {
    await writeSnapshot(
      join(root, "conversation.json"),
      snapshot("completed", { userText: "   ", assistantText: "Assistant-only evidence." }),
    );
    const checkpointStore = new MemoryCheckpointStore();
    const ingests: string[] = [];
    const result = await sync(root, checkpointStore, ingests).runOnce();
    assert.equal(result.sourceOnly, 1);
    assert.equal(result.ingested, 0);
    assert.equal(ingests.length, 0);

    const adapter = new ChatGptCaptureSourceAdapter({
      reader: new ChatGptCaptureDirectoryReader(root),
    });
    const page = await adapter.discover({ limit: 10 });
    const normalized = await adapter.normalize(await adapter.read(page.units[0]!));
    assert.equal(normalized.metadata.userMessageCount, 0);
    assert.equal(normalized.metadata.assistantMessageCount, 1);
  });
});

test("ChatGPT blank-message-only mutation does not redistill unchanged normalized evidence", async () => {
  await withRoot(async (root) => {
    const file = join(root, "conversation.json");
    const checkpointStore = new MemoryCheckpointStore();
    const ingests: string[] = [];
    await writeSnapshot(file, snapshot("completed"));
    let result = await sync(root, checkpointStore, ingests).runOnce();
    assert.equal(result.ingested, 1);

    const changed = snapshot("completed", { revision: "r2" });
    changed.messages.push({
      id: "u-blank",
      role: "user",
      text: "   ",
      createdAt: "2026-10-01T00:04:00.000Z",
    });
    await writeSnapshot(file, changed);
    result = await sync(root, checkpointStore, ingests).runOnce();
    assert.equal(result.changed, 0);
    assert.equal(result.unchanged, 1);
    assert.equal(ingests.length, 1);
  });
});

test("ChatGPT pagination uses one strict total conversation-id ordering", async () => {
  await withRoot(async (root) => {
    await writeSnapshot(join(root, "a.json"), {
      ...snapshot("completed"),
      conversationId: "é",
    });
    await writeSnapshot(join(root, "b.json"), {
      ...snapshot("completed"),
      conversationId: "e\u0301",
    });
    const reader = new ChatGptCaptureDirectoryReader(root);
    const first = await reader.listConversations({ limit: 1 });
    assert.equal(first.length, 1);
    const second = await reader.listConversations({
      afterConversationId: first[0]!.conversationId,
      limit: 1,
    });
    assert.equal(second.length, 1);
    assert.notEqual(second[0]!.conversationId, first[0]!.conversationId);
    const third = await reader.listConversations({
      afterConversationId: second[0]!.conversationId,
      limit: 1,
    });
    assert.equal(third.length, 0);
  });
});

test("ChatGPT lifecycle regression from completed to active fails closed before ingestion", async () => {
  const completed = snapshot("completed");
  const active = { ...completed, status: "active" as const };
  let reads = 0;
  const reader = {
    async inspect() { return { conversationCount: 1 }; },
    async listConversations() {
      return [{
        conversationId: completed.conversationId,
        relativePath: "race.json",
        revision: completed.revision,
        status: completed.status,
        ...(completed.startedAt === undefined ? {} : { startedAt: completed.startedAt }),
        updatedAt: completed.updatedAt,
        sizeBytes: 1,
      }];
    },
    async readConversation() {
      reads += 1;
      const current = reads >= 5 ? active : completed;
      return {
        summary: {
          conversationId: current.conversationId,
          relativePath: "race.json",
          revision: current.revision,
          status: current.status,
          ...(current.startedAt === undefined ? {} : { startedAt: current.startedAt }),
          updatedAt: current.updatedAt,
          sizeBytes: 1,
        },
        snapshot: structuredClone(current),
      };
    },
  };
  const checkpointStore = new MemoryCheckpointStore();
  let ingests = 0;
  const service = new ChatGptCaptureIncrementalSyncService({
    reader,
    checkpointStore,
    scope: {
      tenantId: "tenant-arthur",
      lifeDid: "did:arthurverse:nancy",
      memoryNamespace: "life",
    },
    ingestor: {
      async ingest() {
        ingests += 1;
        return { receiptId: "dist_should_not_exist", status: "complete" as const };
      },
    },
  });

  await assert.rejects(
    () => service.runOnce(),
    /eligibility state changed before distillation/,
  );
  assert.equal(ingests, 0);
  assert.equal(checkpointStore.value, undefined);
});


test("ChatGPT reader keeps its initially pinned root when the root pathname is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-chatgpt-root-pin-"));
  const moved = root + "-moved";
  const outside = await mkdtemp(join(tmpdir(), "dlmf-chatgpt-root-outside-"));
  try {
    const fileName = "conversation.json";
    await writeSnapshot(join(root, fileName), snapshot("completed"));
    await writeSnapshot(join(outside, fileName), {
      ...snapshot("completed"),
      messages: [{
        id: "u-secret",
        role: "user",
        text: "SECRET_OUTSIDE",
        createdAt: "2026-10-01T00:01:00.000Z",
      }],
    });
    const reader = new ChatGptCaptureDirectoryReader(root);
    assert.equal((await reader.inspect()).conversationCount, 1);

    await rename(root, moved);
    await symlink(outside, root);
    await assert.rejects(
      () => reader.readConversation("chatgpt-conversation-001"),
      /source file escapes configured root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rename(moved, root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ChatGPT cached index rejects a snapshot replaced by an out-of-root symlink before read", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "dlmf-chatgpt-outside-"));
    try {
      const valid = join(root, "valid.json");
      const outsideFile = join(outside, "outside.json");
      await writeSnapshot(valid, snapshot("completed"));
      await writeSnapshot(outsideFile, {
        ...snapshot("completed"),
        messages: [{
          id: "u-secret",
          role: "user",
          text: "SECRET_OUTSIDE",
          createdAt: "2026-10-01T00:01:00.000Z",
        }],
      });
      const reader = new ChatGptCaptureDirectoryReader(root);
      assert.equal((await reader.inspect()).conversationCount, 1);
      await rm(valid);
      await symlink(outsideFile, valid);
      await assert.rejects(
        () => reader.readConversation("chatgpt-conversation-001"),
        /source file escapes configured root|became a symlink/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
