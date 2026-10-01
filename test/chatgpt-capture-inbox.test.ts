import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHATGPT_CAPTURE_CONTRACT,
  ChatGptCaptureConflictError,
  ChatGptCaptureInboxHttp,
  ChatGptCaptureInboxStore,
  ChatGptCaptureUnavailableError,
  type ChatGptCapturedConversation,
} from "../src/index.js";

function snapshot(overrides: Partial<ChatGptCapturedConversation> = {}): ChatGptCapturedConversation {
  return {
    contract: CHATGPT_CAPTURE_CONTRACT,
    conversationId: "conversation-activation-001",
    revision: "r1",
    status: "active",
    startedAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:01:00.000Z",
    messages: [
      {
        id: "u1",
        role: "user",
        text: "Remember durable preference A.",
        createdAt: "2026-10-01T12:00:30.000Z",
      },
      {
        id: "a1",
        role: "assistant",
        text: "Acknowledged.",
        createdAt: "2026-10-01T12:00:40.000Z",
      },
    ],
    ...overrides,
  };
}

async function lockIdentity(pid = process.pid) {
  const bootId = (await readFile(
    "/proc/sys/kernel/random/boot_id",
    "utf8",
  )).trim();
  const statText = await readFile(`/proc/${pid}/stat`, "utf8");
  const closeParen = statText.lastIndexOf(")");
  assert.ok(closeParen >= 0);
  const fields = statText.slice(closeParen + 2).trim().split(/\s+/u);
  const processStartTicks = fields[19];
  assert.ok(processStartTicks);
  return {
    pid,
    bootId,
    processStartTicks,
    createdAt: new Date().toISOString(),
  };
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dlmf-chatgpt-inbox-"));
  await chmod(root, 0o700);
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("ChatGPT capture inbox store is atomic, idempotent and monotonic", async () => {
  await withRoot(async (root) => {
    const store = new ChatGptCaptureInboxStore(root);
    const first = await store.put(snapshot());
    assert.equal(first.outcome, "created");
    assert.equal(first.status, "active");

    const replay = await store.put(snapshot());
    assert.equal(replay.outcome, "idempotent");

    const completed = snapshot({
      revision: "r2",
      status: "completed",
      updatedAt: "2026-10-01T12:02:00.000Z",
    });
    const second = await store.put(completed);
    assert.equal(second.outcome, "updated");
    assert.equal(second.status, "completed");

    await assert.rejects(
      () => store.put(snapshot({
        revision: "r3",
        status: "active",
        updatedAt: "2026-10-01T12:03:00.000Z",
      })),
      (error: unknown) =>
        error instanceof ChatGptCaptureConflictError
        && error.reason === "lifecycle_regression",
    );

    await assert.rejects(
      () => store.put(snapshot({
        revision: "r0",
        updatedAt: "2026-10-01T11:59:00.000Z",
      })),
      (error: unknown) =>
        error instanceof ChatGptCaptureConflictError
        && error.reason === "stale",
    );
  });
});

test("ChatGPT inbox rejects divergent same revision/timestamp and unsafe destination symlink", async () => {
  await withRoot(async (root) => {
    const store = new ChatGptCaptureInboxStore(root);
    await store.put(snapshot());
    await assert.rejects(
      () => store.put(snapshot({
        messages: [{
          id: "u1",
          role: "user",
          text: "Different body.",
          createdAt: "2026-10-01T12:00:30.000Z",
        }],
      })),
      (error: unknown) =>
        error instanceof ChatGptCaptureConflictError
        && error.reason === "revision_conflict",
    );
  });

  await withRoot(async (root) => {
    const outside = join(tmpdir(), `dlmf-chatgpt-outside-${process.pid}.json`);
    await writeFile(outside, "{}\n", "utf8");
    try {
      const idHash = createHash("sha256")
        .update("conversation-activation-001", "utf8")
        .digest("hex");
      await symlink(outside, join(root, `${idHash}.json`));
      const store = new ChatGptCaptureInboxStore(root);
      await assert.rejects(
        () => store.put(snapshot()),
        /regular non-symlink file/,
      );
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("ChatGPT capture HTTP authenticates before parsing private body", async () => {
  await withRoot(async (root) => {
    const token = "x".repeat(48);
    const http = new ChatGptCaptureInboxHttp({
      bearerToken: token,
      store: new ChatGptCaptureInboxStore(root),
      maxBodyBytes: 4096,
    });

    const unauthorized = await http.handle(new Request(
      "http://127.0.0.1/v1/chatgpt-capture",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      },
    ));
    assert.equal(unauthorized.status, 401);

    const wrongType = await http.handle(new Request(
      "http://127.0.0.1/v1/chatgpt-capture",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "text/plain",
        },
        body: "{}",
      },
    ));
    assert.equal(wrongType.status, 415);

    const tooLarge = await http.handle(new Request(
      "http://127.0.0.1/v1/chatgpt-capture",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ padding: "z".repeat(5000) }),
      },
    ));
    assert.equal(tooLarge.status, 413);

    const accepted = await http.handle(new Request(
      "http://127.0.0.1/v1/chatgpt-capture",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(snapshot()),
      },
    ));
    assert.equal(accepted.status, 201);
    const acceptedBody = await accepted.json() as Record<string, unknown>;
    assert.equal(acceptedBody.canonicalMemoryWrites, 0);
    assert.equal("conversationId" in acceptedBody, false);

    const health = await http.handle(new Request("http://127.0.0.1/health"));
    const ready = await http.handle(new Request("http://127.0.0.1/ready"));
    assert.equal(health.status, 200);
    assert.equal(ready.status, 200);
  });
});

test("ChatGPT capture inbox durably creates only its leaf under an existing parent", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dlmf-chatgpt-inbox-parent-"));
  try {
    await chmod(parent, 0o700);
    const root = join(parent, "capture");
    const store = new ChatGptCaptureInboxStore(root);
    const ready = await store.ready();
    assert.equal(ready.ready, true);
    const info = await import("node:fs/promises").then(({ stat }) => stat(root));
    assert.equal(info.isDirectory(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("ChatGPT capture inbox root must stay owner-private", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-chatgpt-inbox-mode-"));
  try {
    await chmod(root, 0o755);
    const store = new ChatGptCaptureInboxStore(root);
    await assert.rejects(
      () => store.ready(),
      /must not grant group\/world permissions/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("legacy crash-left conversation lock files no longer block inbox progress", async () => {
  await withRoot(async (root) => {
    const idHash = createHash("sha256")
      .update("conversation-activation-001", "utf8")
      .digest("hex");
    const legacyLockPath = join(root, `.${idHash}.write.lock`);
    await writeFile(
      legacyLockPath,
      JSON.stringify({
        pid: 2147483647,
        createdAt: "2026-10-01T00:00:00.000Z",
      }) + "\n",
      { mode: 0o600 },
    );

    const result = await new ChatGptCaptureInboxStore(root).put(snapshot());
    assert.equal(result.outcome, "created");
    assert.equal((await readFile(legacyLockPath, "utf8")).length > 0, true);
  });
});

test("multiple inbox store instances serialize one conversation monotonically in-process", async () => {
  await withRoot(async (root) => {
    const seed = new ChatGptCaptureInboxStore(root);
    await seed.put(snapshot());
    const idHash = createHash("sha256")
      .update("conversation-activation-001", "utf8")
      .digest("hex");

    const older = snapshot({
      revision: "r2",
      status: "completed",
      updatedAt: "2026-10-01T12:02:00.000Z",
    });
    const newer = snapshot({
      revision: "r3",
      status: "archived",
      updatedAt: "2026-10-01T12:03:00.000Z",
    });
    const first = new ChatGptCaptureInboxStore(root);
    const second = new ChatGptCaptureInboxStore(root);
    const results = await Promise.allSettled([
      first.put(older),
      second.put(newer),
    ]);
    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    ).length;
    assert.ok(fulfilled >= 1);
    for (const result of results) {
      if (result.status !== "rejected") continue;
      assert.ok(
        result.reason instanceof ChatGptCaptureConflictError
        && (
          result.reason.reason === "stale"
          || result.reason.reason === "concurrent_update"
          || result.reason.reason === "revision_conflict"
        ),
      );
    }

    const stored = JSON.parse(
      await readFile(join(root, `${idHash}.json`), "utf8"),
    ) as ChatGptCapturedConversation;
    assert.equal(stored.revision, "r3");
    assert.equal(stored.status, "archived");
  });
});

test("cross-process write lock rejects active and stale owners fail closed", async () => {
  await withRoot(async (root) => {
    const lockPath = join(root, ".inbox-write.lock");
    await writeFile(
      lockPath,
      JSON.stringify(await lockIdentity()) + "\n",
      { mode: 0o600 },
    );
    const store = new ChatGptCaptureInboxStore(root);
    await assert.rejects(
      () => store.put(snapshot()),
      (error: unknown) =>
        error instanceof ChatGptCaptureConflictError
        && error.reason === "concurrent_update",
    );

    await rm(lockPath, { force: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 2147483647,
        bootId: "definitely-not-current-boot",
        processStartTicks: "1",
        createdAt: "2026-10-01T00:00:00.000Z",
      }) + "\n",
      { mode: 0o600 },
    );
    await assert.rejects(
      () => store.put(snapshot()),
      (error: unknown) =>
        error instanceof ChatGptCaptureUnavailableError
        && /stale write lock requires operator review/.test(error.message),
    );
    await assert.rejects(
      () => store.ready(),
      (error: unknown) =>
        error instanceof ChatGptCaptureUnavailableError
        && /stale write lock requires operator review/.test(error.message),
    );
    const http = new ChatGptCaptureInboxHttp({
      bearerToken: "x".repeat(48),
      store,
    });
    const notReady = await http.handle(new Request("http://127.0.0.1/ready"));
    assert.equal(notReady.status, 503);

    // Operator-reviewed cleanup restores service without any automatic
    // reclamation race inside the request path.
    await rm(lockPath, { force: true });
    const created = await store.put(snapshot());
    assert.equal(created.outcome, "created");
  });
});

test("stale recovery lock makes readiness fail closed", async () => {
  await withRoot(async (root) => {
    const recoveryPath = join(root, ".inbox-write.lock.recovery");
    await writeFile(
      recoveryPath,
      JSON.stringify({
        pid: 2147483647,
        bootId: "definitely-not-current-boot",
        processStartTicks: "1",
        createdAt: "2026-10-01T00:00:00.000Z",
      }) + "\n",
      { mode: 0o600 },
    );
    const store = new ChatGptCaptureInboxStore(root);
    await assert.rejects(
      () => store.ready(),
      (error: unknown) =>
        error instanceof ChatGptCaptureUnavailableError,
    );

    const http = new ChatGptCaptureInboxHttp({
      bearerToken: "x".repeat(48),
      store,
    });
    const ready = await http.handle(new Request("http://127.0.0.1/ready"));
    assert.equal(ready.status, 503);
  });
});

test("ChatGPT capture inbox revalidates root privacy after initialization", async () => {
  await withRoot(async (root) => {
    const store = new ChatGptCaptureInboxStore(root);
    await store.ready();
    await chmod(root, 0o755);
    await assert.rejects(
      () => store.ready(),
      /must not grant group\/world permissions/,
    );
    await chmod(root, 0o700);
    await store.ready();
  });
});

test("concurrent ChatGPT capture updates cannot overwrite a newer lifecycle state", async () => {
  await withRoot(async (root) => {
    const store = new ChatGptCaptureInboxStore(root);
    await store.put(snapshot());
    const completed = snapshot({
      revision: "r2",
      status: "completed",
      updatedAt: "2026-10-01T12:02:00.000Z",
    });
    const archived = snapshot({
      revision: "r3",
      status: "archived",
      updatedAt: "2026-10-01T12:03:00.000Z",
    });

    const attempts = await Promise.allSettled([
      store.put(completed),
      store.put(archived),
    ]);
    assert.ok(attempts.some((result) => result.status === "fulfilled"));

    // A caller that lost the fail-closed lock race can retry. The monotonic
    // comparison then converges to the newer archived state.
    await store.put(archived);
    await assert.rejects(
      () => store.put(completed),
      (error: unknown) =>
        error instanceof ChatGptCaptureConflictError
        && (error.reason === "stale"
          || error.reason === "lifecycle_regression"
          || error.reason === "revision_conflict"),
    );

    const idHash = createHash("sha256")
      .update("conversation-activation-001", "utf8")
      .digest("hex");
    const stored = JSON.parse(
      await readFile(join(root, `${idHash}.json`), "utf8"),
    ) as ChatGptCapturedConversation;
    assert.equal(stored.status, "archived");
    assert.equal(stored.revision, "r3");
  });
});
