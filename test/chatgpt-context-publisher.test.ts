import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHATGPT_CONTEXT_PUBLISHER_CONTRACT,
  ChatGptCaptureDirectoryReader,
  ChatGptCaptureInboxStore,
  ChatGptContextPublisher,
  ChatGptSourceAdapter,
  type ChatGptCapturedConversation,
} from "../src/index.js";

test("context publisher produces a bounded context-derived capture with stable publisher identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    let captured: ChatGptCapturedConversation | undefined;
    const publisher = new ChatGptContextPublisher({
      clock: () => new Date("2026-10-02T11:20:00.000Z"),
      conversationIdFactory: () => "chatgpt-context-fixed-test-0001",
      publishSnapshot: async (snapshot) => {
        captured = structuredClone(snapshot);
        return store.put(snapshot);
      },
    });

    const first = await publisher.publish({
      contextCompleteness: "full_visible_context",
      title: "DLMF publisher test",
      messages: [
        { role: "user", text: "Please remember my durable preference." },
        { role: "assistant", text: "I can sync this visible context." },
      ],
    });

    assert.equal(first.contract, CHATGPT_CONTEXT_PUBLISHER_CONTRACT);
    assert.equal(first.transport, "context_publisher");
    assert.equal(first.conversationId, "chatgpt-context-fixed-test-0001");
    assert.equal(first.outcome, "created");
    assert.equal(first.authoritativeTranscript, false);
    assert.equal(first.canonicalMemoryWrites, 0);
    assert.equal(first.publishedMessageCount, 2);
    assert.ok(captured);
    assert.equal(captured.status, "completed");
    assert.equal(captured.metadata?.transport, "context_publisher");
    assert.equal(captured.metadata?.captureKind, "model_visible_context");
    assert.equal(captured.metadata?.captureBoundary, "user_requested_snapshot");
    assert.equal(captured.metadata?.threadLifecycle, "unknown");
    assert.equal(captured.metadata?.authoritativeTranscript, false);
    assert.equal(captured.metadata?.contextCompleteness, "full_visible_context");
    assert.deepEqual(
      captured.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(captured.messages[0]?.createdAt, undefined);
    assert.match(captured.messages[0]?.id ?? "", /^ctx-message-0000-/u);
    assert.match(captured.messages[1]?.id ?? "", /^ctx-message-0001-/u);

    const reader = new ChatGptCaptureDirectoryReader(root);
    const adapter = new ChatGptSourceAdapter({
      reader,
      transport: "context_publisher",
      clock: () => new Date("2026-10-02T11:20:05.000Z"),
    });
    const page = await adapter.discover({ limit: 10 });
    const normalized = await adapter.normalize(await adapter.read(page.units[0]!));
    assert.equal(normalized.endedAt.certainty, "unknown");
    assert.equal(normalized.metadata.transport, "context_publisher");
    assert.equal(normalized.metadata.authoritativeTranscript, false);
    assert.equal(normalized.metadata.threadLifecycle, "unknown");
    assert.equal(normalized.metadata.statusSemantics, "capture_snapshot_complete");
    assert.equal(normalized.metadata.contextCompleteness, "full_visible_context");
    assert.equal(normalized.metadata.captureBoundary, "user_requested_snapshot");
    assert.equal(normalized.metadata.captureKind, "model_visible_context");

    const replay = await publisher.publish({
      conversationId: first.conversationId,
      contextCompleteness: "full_visible_context",
      title: "DLMF publisher test",
      messages: [
        { role: "user", text: "Please remember my durable preference." },
        { role: "assistant", text: "I can sync this visible context." },
      ],
    });
    assert.equal(replay.outcome, "idempotent");
    assert.equal(replay.conversationId, first.conversationId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher updates the same logical conversation when visible context grows", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-update-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    let now = new Date("2026-10-02T11:21:00.000Z");
    const publisher = new ChatGptContextPublisher({
      clock: () => now,
      publishSnapshot: (snapshot) => store.put(snapshot),
    });

    const first = await publisher.publish({
      conversationId: "chatgpt-context-update-test-0001",
      contextCompleteness: "partial_visible_context",
      messages: [{ role: "user", text: "First visible turn." }],
    });
    assert.equal(first.outcome, "created");

    now = new Date("2026-10-02T11:21:01.000Z");
    const second = await publisher.publish({
      conversationId: first.conversationId,
      contextCompleteness: "full_visible_context",
      messages: [
        { role: "user", text: "First visible turn." },
        { role: "assistant", text: "Second visible turn." },
      ],
    });
    assert.equal(second.outcome, "updated");
    assert.equal(second.conversationId, first.conversationId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher admits metadata-only corrections with a new monotonic revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-metadata-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const publisher = new ChatGptContextPublisher({
      clock: () => new Date("2026-10-02T11:22:00.000Z"),
      publishSnapshot: (snapshot) => store.put(snapshot),
    });

    const first = await publisher.publish({
      conversationId: "chatgpt-context-metadata-test-0001",
      contextCompleteness: "unknown",
      title: "Draft title",
      messages: [{ role: "user", text: "Same visible evidence." }],
    });
    const second = await publisher.publish({
      conversationId: first.conversationId,
      contextCompleteness: "full_visible_context",
      title: "Corrected title",
      messages: [{ role: "user", text: "Same visible evidence." }],
    });

    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "updated");
    assert.notEqual(
      first.captureInbox.revisionHash,
      second.captureInbox.revisionHash,
    );
    assert.ok(
      Date.parse(second.captureInbox.updatedAt)
      > Date.parse(first.captureInbox.updatedAt),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher serializes concurrent updates for one publisher conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-race-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const publisher = new ChatGptContextPublisher({
      clock: () => new Date("2026-10-02T11:23:00.000Z"),
      publishSnapshot: async (snapshot) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        return store.put(snapshot);
      },
    });

    const [first, second] = await Promise.all([
      publisher.publish({
        conversationId: "chatgpt-context-race-test-0001",
        contextCompleteness: "partial_visible_context",
        messages: [{ role: "user", text: "First concurrent update." }],
      }),
      publisher.publish({
        conversationId: "chatgpt-context-race-test-0001",
        contextCompleteness: "full_visible_context",
        messages: [
          { role: "user", text: "First concurrent update." },
          { role: "assistant", text: "Second concurrent update." },
        ],
      }),
    ]);

    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "updated");
    assert.ok(
      Date.parse(second.captureInbox.updatedAt)
      > Date.parse(first.captureInbox.updatedAt),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher resumes monotonic allocation from durable Inbox state after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-restart-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-restart-test-0001";
    const firstPublisher = new ChatGptContextPublisher({
      clock: () => new Date("2026-10-02T11:24:00.500Z"),
      readCurrentVersion: (id) => store.currentVersion(id),
      publishSnapshot: (snapshot) => store.put(snapshot),
    });
    const first = await firstPublisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [{ role: "user", text: "Durable pre-restart context." }],
    });
    assert.equal(first.outcome, "created");

    const restartedPublisher = new ChatGptContextPublisher({
      clock: () => new Date("2026-10-02T11:23:59.000Z"),
      readCurrentVersion: (id) => store.currentVersion(id),
      publishSnapshot: (snapshot) => store.put(snapshot),
    });
    const second = await restartedPublisher.publish({
      conversationId,
      contextCompleteness: "full_visible_context",
      messages: [
        { role: "user", text: "Durable pre-restart context." },
        { role: "assistant", text: "New context after restart." },
      ],
    });
    assert.equal(second.outcome, "updated");
    assert.ok(
      Date.parse(second.captureInbox.updatedAt)
      > Date.parse(first.captureInbox.updatedAt),
    );

    const retryAfterAnotherRestart = new ChatGptContextPublisher({
      clock: () => new Date("2026-10-02T11:23:58.000Z"),
      readCurrentVersion: (id) => store.currentVersion(id),
      publishSnapshot: (snapshot) => store.put(snapshot),
    });
    const replay = await retryAfterAnotherRestart.publish({
      conversationId,
      contextCompleteness: "full_visible_context",
      messages: [
        { role: "user", text: "Durable pre-restart context." },
        { role: "assistant", text: "New context after restart." },
      ],
    });
    assert.equal(replay.outcome, "idempotent");
    assert.equal(replay.captureInbox.updatedAt, second.captureInbox.updatedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher fails closed on invalid identity and non-visible/empty evidence shapes", async () => {
  let publishes = 0;
  const publisher = new ChatGptContextPublisher({
    publishSnapshot: async () => {
      publishes += 1;
      throw new Error("must not publish");
    },
  });

  await assert.rejects(
    () => publisher.publish({
      conversationId: "openai-internal-thread-id",
      contextCompleteness: "unknown",
      messages: [{ role: "user", text: "Visible." }],
    }),
    /conversationId must start with chatgpt-context-/u,
  );

  await assert.rejects(
    () => publisher.publish({
      contextCompleteness: "unknown",
      messages: [{ role: "assistant", text: "   " }],
    }),
    /must contain visible text/u,
  );

  await assert.rejects(
    () => publisher.publish({
      contextCompleteness: "unknown",
      messages: [],
    }),
    /at least one visible message/u,
  );

  assert.equal(publishes, 0);
});
