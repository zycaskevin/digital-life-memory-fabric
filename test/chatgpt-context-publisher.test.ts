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
  chatGptContextConversationIdForSession,
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
      publishSnapshot: async (snapshot, expectedRevision) => {
        captured = structuredClone(snapshot);
        return store.put(snapshot, { expectedRevision });
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
    assert.match(captured.messages[0]?.id ?? "", /^ctx-message-[0-9a-f]{32}$/u);
    assert.match(captured.messages[1]?.id ?? "", /^ctx-message-[0-9a-f]{32}$/u);

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
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
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
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
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
      publishSnapshot: async (snapshot, expectedRevision) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        return store.put(snapshot, { expectedRevision });
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
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    const first = await firstPublisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [{ role: "user", text: "Durable pre-restart context." }],
    });
    assert.equal(first.outcome, "created");

    const restartedPublisher = new ChatGptContextPublisher({
      clock: () => new Date("2026-10-02T11:23:59.000Z"),
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
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
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
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



test("context publisher derives stable opaque identity from ChatGPT session metadata", () => {
  const first = chatGptContextConversationIdForSession("session-anonymized-001");
  const replay = chatGptContextConversationIdForSession("session-anonymized-001");
  const other = chatGptContextConversationIdForSession("session-anonymized-002");
  assert.equal(first, replay);
  assert.notEqual(first, other);
  assert.match(first, /^chatgpt-context-[0-9a-f]{64}$/u);
  assert.throws(
    () => chatGptContextConversationIdForSession(undefined),
    /requires valid openai\/session metadata/u,
  );
});

test("context publisher never drops prior evidence when later model context is truncated", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-truncated-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-truncated-test-0001";
    let now = new Date("2026-10-02T11:25:00.000Z");
    const publisher = new ChatGptContextPublisher({
      clock: () => now,
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });

    await publisher.publish({
      conversationId,
      contextCompleteness: "full_visible_context",
      messages: [
        { role: "user", text: "Old visible turn." },
        { role: "assistant", text: "Old visible reply." },
        { role: "user", text: "Current visible turn." },
      ],
    });

    now = new Date("2026-10-02T11:25:01.000Z");
    const second = await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [
        { role: "user", text: "Current visible turn." },
        { role: "assistant", text: "New reply after context truncation." },
      ],
    });
    assert.equal(second.outcome, "updated");
    assert.equal(second.publishedMessageCount, 4);

    const snapshot = await store.currentSnapshot(conversationId);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "Old visible turn." },
      { role: "assistant", text: "Old visible reply." },
      { role: "user", text: "Current visible turn." },
      { role: "assistant", text: "New reply after context truncation." },
    ]);
    assert.equal(snapshot.metadata?.accumulationPolicy, "monotonic_visible_context");
    assert.equal(snapshot.metadata?.latestVisibleMessageCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher rejects contained repeated context when another boundary alignment could add evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-contained-ambiguous-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-contained-ambiguous-0001";
    const publisher = new ChatGptContextPublisher({
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
        { role: "user", text: "A" },
      ],
    });
    await assert.rejects(
      () => publisher.publish({
        conversationId,
        contextCompleteness: "partial_visible_context",
        messages: [
          { role: "user", text: "A" },
          { role: "assistant", text: "B" },
        ],
      }),
      /ambiguous repeated overlap/u,
    );
    const snapshot = await store.currentSnapshot(conversationId);
    assert.deepEqual(
      snapshot?.messages.map(({ role, text }) => ({ role, text })),
      [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
        { role: "user", text: "A" },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher merges a unique noncontiguous overlap without dropping durable evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-noncontiguous-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-noncontiguous-0001";
    const publisher = new ChatGptContextPublisher({
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
        { role: "user", text: "C" },
        { role: "assistant", text: "D" },
      ],
    });
    const result = await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [
        { role: "user", text: "A" },
        { role: "user", text: "C" },
        { role: "assistant", text: "D" },
        { role: "user", text: "E" },
      ],
    });
    assert.equal(result.outcome, "updated");
    const snapshot = await store.currentSnapshot(conversationId);
    assert.deepEqual(
      snapshot?.messages.map(({ role, text }) => ({ role, text })),
      [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
        { role: "user", text: "C" },
        { role: "assistant", text: "D" },
        { role: "user", text: "E" },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher fails closed instead of replacing prior evidence with unrelated partial context", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-disjoint-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-disjoint-test-0001";
    const publisher = new ChatGptContextPublisher({
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [{ role: "user", text: "Known prior evidence." }],
    });
    await assert.rejects(
      () => publisher.publish({
        conversationId,
        contextCompleteness: "partial_visible_context",
        messages: [{ role: "assistant", text: "Disjoint context with no safe overlap." }],
      }),
      /cannot safely merge visible context/u,
    );
    const snapshot = await store.currentSnapshot(conversationId);
    assert.equal(snapshot?.messages.length, 1);
    assert.equal(snapshot?.messages[0]?.text, "Known prior evidence.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher rejects ambiguous repeated overlap instead of guessing order", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-ambiguous-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-ambiguous-test-0001";
    const publisher = new ChatGptContextPublisher({
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
        { role: "user", text: "A" },
      ],
    });
    await assert.rejects(
      () => publisher.publish({
        conversationId,
        contextCompleteness: "partial_visible_context",
        messages: [
          { role: "user", text: "A" },
          { role: "assistant", text: "C" },
          { role: "user", text: "A" },
        ],
      }),
      /ambiguous repeated overlap/u,
    );
    const snapshot = await store.currentSnapshot(conversationId);
    assert.deepEqual(
      snapshot?.messages.map(({ role, text }) => ({ role, text })),
      [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
        { role: "user", text: "A" },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher rejects repeated-pattern boundary containment with multiple legal overlaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-repeat-boundary-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-repeat-boundary-0001";
    const publisher = new ChatGptContextPublisher({
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    const prior = [
      { role: "user" as const, text: "A" },
      { role: "assistant" as const, text: "B" },
      { role: "user" as const, text: "A" },
      { role: "assistant" as const, text: "B" },
    ];
    await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: prior,
    });
    await assert.rejects(
      () => publisher.publish({
        conversationId,
        contextCompleteness: "partial_visible_context",
        messages: [
          ...prior,
          { role: "user", text: "C" },
        ],
      }),
      /ambiguous repeated overlap/u,
    );
    await assert.rejects(
      () => publisher.publish({
        conversationId,
        contextCompleteness: "partial_visible_context",
        messages: [
          { role: "user", text: "C" },
          ...prior,
        ],
      }),
      /ambiguous repeated overlap/u,
    );
    const snapshot = await store.currentSnapshot(conversationId);
    assert.deepEqual(
      snapshot?.messages.map(({ role, text }) => ({ role, text })),
      prior,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher rejects containment that competes with another legal boundary alignment", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-competing-alignment-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-competing-alignment-0001";
    const publisher = new ChatGptContextPublisher({
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
      ],
    });

    await assert.rejects(
      () => publisher.publish({
        conversationId,
        contextCompleteness: "partial_visible_context",
        messages: [
          { role: "assistant", text: "B" },
          { role: "user", text: "C" },
          { role: "user", text: "A" },
          { role: "assistant", text: "B" },
          { role: "assistant", text: "D" },
        ],
      }),
      /ambiguous repeated overlap/u,
    );
    await assert.rejects(
      () => publisher.publish({
        conversationId,
        contextCompleteness: "partial_visible_context",
        messages: [
          { role: "user", text: "C" },
          { role: "user", text: "A" },
          { role: "assistant", text: "B" },
          { role: "assistant", text: "D" },
          { role: "user", text: "A" },
        ],
      }),
      /ambiguous repeated overlap/u,
    );

    const snapshot = await store.currentSnapshot(conversationId);
    assert.deepEqual(
      snapshot?.messages.map(({ role, text }) => ({ role, text })),
      [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher preserves prior message IDs when older visible context is prepended", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-prepend-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-prepend-test-0001";
    const publisher = new ChatGptContextPublisher({
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
      ],
    });
    const before = await store.currentSnapshot(conversationId);
    assert.ok(before);
    const priorIds = before.messages.map((message) => message.id);

    await publisher.publish({
      conversationId,
      contextCompleteness: "full_visible_context",
      messages: [
        { role: "assistant", text: "Earlier" },
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
      ],
    });
    const after = await store.currentSnapshot(conversationId);
    assert.ok(after);
    assert.deepEqual(after.messages.slice(1).map((message) => message.id), priorIds);
    assert.notEqual(after.messages[0]?.id, priorIds[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher CAS prevents concurrent instances from losing accumulated evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-cas-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-cas-test-0001";
    const seed = new ChatGptContextPublisher({
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    await seed.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [{ role: "user", text: "A" }],
    });
    const sharedPrior = await store.currentSnapshot(conversationId);
    assert.ok(sharedPrior);
    let initialReads = 0;
    const readWithForcedRace = async (id: string) => {
      if (initialReads < 2) {
        initialReads += 1;
        return structuredClone(sharedPrior);
      }
      return store.currentSnapshot(id);
    };
    const makePublisher = () => new ChatGptContextPublisher({
      readCurrentSnapshot: readWithForcedRace,
      publishSnapshot: async (snapshot, expectedRevision) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        return store.put(snapshot, { expectedRevision });
      },
    });
    const first = makePublisher();
    const second = makePublisher();
    const results = await Promise.all([
      first.publish({
        conversationId,
        contextCompleteness: "partial_visible_context",
        messages: [
          { role: "user", text: "A" },
          { role: "assistant", text: "B" },
        ],
      }),
      second.publish({
        conversationId,
        contextCompleteness: "full_visible_context",
        messages: [
          { role: "user", text: "A" },
          { role: "assistant", text: "B" },
          { role: "user", text: "C" },
        ],
      }),
    ]);
    assert.equal(results.length, 2);
    const snapshot = await store.currentSnapshot(conversationId);
    assert.ok(snapshot);
    assert.deepEqual(
      snapshot.messages.map(({ role, text }) => ({ role, text })),
      [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
        { role: "user", text: "C" },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher gives truncated visibility metadata its own revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-count-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-count-test-0001";
    const publisher = new ChatGptContextPublisher({
      clock: () => new Date("2026-10-02T11:30:00.000Z"),
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    const first = await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [
        { role: "user", text: "A" },
        { role: "assistant", text: "B" },
        { role: "user", text: "C" },
      ],
    });
    const second = await publisher.publish({
      conversationId,
      contextCompleteness: "partial_visible_context",
      messages: [
        { role: "assistant", text: "B" },
        { role: "user", text: "C" },
      ],
    });
    assert.equal(second.outcome, "updated");
    assert.notEqual(first.captureInbox.revisionHash, second.captureInbox.revisionHash);
    const snapshot = await store.currentSnapshot(conversationId);
    assert.equal(snapshot?.messages.length, 3);
    assert.equal(snapshot?.metadata?.latestVisibleMessageCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context publisher preserves legacy ebd message IDs during format upgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-publisher-legacy-"));
  try {
    const store = new ChatGptCaptureInboxStore(root);
    const conversationId = "chatgpt-context-legacy-test-0001";
    const legacyIds = [
      "ctx-message-0000-aaaaaaaaaaaaaaaaaaaa",
      "ctx-message-0001-bbbbbbbbbbbbbbbbbbbb",
    ];
    await store.put({
      contract: "dlmf/chatgpt-captured-conversation/v1",
      conversationId,
      revision: "context-20261002110000000-legacy0000000000",
      status: "completed",
      updatedAt: "2026-10-02T11:00:00.000Z",
      messages: [
        { id: legacyIds[0], role: "user", text: "Legacy A" },
        { id: legacyIds[1], role: "assistant", text: "Legacy B" },
      ],
      metadata: {
        transport: "context_publisher",
        publisherContract: "dlmf/chatgpt-context-publisher/v1",
        contextCaptureDigest: "a".repeat(64),
        authoritativeTranscript: false,
      },
    });
    const publisher = new ChatGptContextPublisher({
      clock: () => new Date("2026-10-02T11:01:00.000Z"),
      readCurrentSnapshot: (id) => store.currentSnapshot(id),
      publishSnapshot: (snapshot, expectedRevision) =>
        store.put(snapshot, { expectedRevision }),
    });
    const result = await publisher.publish({
      conversationId,
      contextCompleteness: "full_visible_context",
      messages: [
        { role: "user", text: "Legacy A" },
        { role: "assistant", text: "Legacy B" },
      ],
    });
    assert.equal(result.outcome, "updated");
    const upgraded = await store.currentSnapshot(conversationId);
    assert.deepEqual(upgraded?.messages.map((message) => message.id), legacyIds);
    assert.equal(upgraded?.metadata?.publisherFormatVersion, 2);
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
