import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const repo = resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error("failed to allocate test port");
  return port;
}

function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !key.startsWith("DLMF_DLS_")
      && key !== "DLMF_MULTI_SOURCE_WRITE_MODE"
      && key !== "DLMF_MULTI_SOURCE_DISTILL_CANARY"
      && key !== "DLMF_MULTI_SOURCE_CANARY_NAMESPACE"
      && key !== "DLMF_MULTI_SOURCE_SHADOW_NAMESPACE"
    ),
  );
}

async function requestWithHost(port, hostHeader) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        Host: hostHeader,
        "Content-Type": "application/json",
        "Content-Length": "2",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode));
    });
    request.once("error", reject);
    request.end("{}");
  });
}

async function waitReady(url, child) {
  const deadline = Date.now() + 8_000;
  let last;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`publisher process exited early: ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
      last = new Error(`ready HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw last ?? new Error("publisher readiness timed out");
}

test("context publisher MCP writes through the live Capture Inbox contract and remains reference-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "dlmf-context-mcp-"));
  await chmod(root, 0o700);
  const capture = join(root, "capture");
  const state = join(root, "state");
  await mkdir(capture, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const tokenFile = join(root, "capture-token");
  await writeFile(tokenFile, "t".repeat(64) + "\n", { mode: 0o600 });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...cleanEnv(),
    DLMF_CHATGPT_CAPTURE_HOST: "127.0.0.1",
    DLMF_CHATGPT_CAPTURE_PORT: String(port),
    DLMF_CHATGPT_CAPTURE_ROOT: capture,
    DLMF_CHATGPT_CAPTURE_BEARER_TOKEN_FILE: tokenFile,
    DLMF_CHATGPT_CAPTURE_MAX_BODY_BYTES: String(1024 * 1024),
  };

  const child = spawn(node, [resolve(repo, "scripts/chatgpt-capture-inbox-server.mjs")], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitReady(baseUrl, child);

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).canonicalMemoryWrites, 0);

    const hostileClient = new Client(
      { name: "dlmf-hostile-origin-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const hostileTransport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      { requestInit: { headers: { Origin: "https://evil.example" } } },
    );
    await assert.rejects(
      () => hostileClient.connect(hostileTransport),
      /403|Invalid Origin header/u,
    );
    await hostileClient.close().catch(() => undefined);
    assert.equal(
      (await readdir(capture)).filter((name) => name.endsWith(".json")).length,
      0,
    );

    assert.equal(await requestWithHost(port, "evil.example"), 403);

    const client = new Client(
      { name: "dlmf-context-publisher-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((item) => item.name === "publish_current_conversation");
      assert.ok(tool);
      assert.match(tool.description ?? "", /visible user\/assistant messages/u);

      const first = await client.callTool({
        name: "publish_current_conversation",
        arguments: {
          contextCompleteness: "full_visible_context",
          messages: [
            { role: "user", text: "Synthetic context publisher UAT preference." },
            { role: "assistant", text: "Acknowledged for context-derived capture." },
          ],
        },
      });
      assert.equal(first.isError, undefined);
      const firstStructured = first.structuredContent;
      assert.equal(firstStructured.transport, "context_publisher");
      assert.equal(firstStructured.canonicalMemoryWrites, 0);
      assert.equal(firstStructured.authoritativeTranscript, false);
      assert.equal(firstStructured.outcome, "created");
      assert.match(firstStructured.conversationId, /^chatgpt-context-/u);

      const second = await client.callTool({
        name: "publish_current_conversation",
        arguments: {
          conversationId: firstStructured.conversationId,
          contextCompleteness: "full_visible_context",
          messages: [
            { role: "user", text: "Synthetic context publisher UAT preference." },
            { role: "assistant", text: "Acknowledged for context-derived capture." },
            { role: "user", text: "A later visible turn in the same conversation." },
          ],
        },
      });
      assert.equal(second.isError, undefined);
      assert.equal(second.structuredContent.conversationId, firstStructured.conversationId);
      assert.equal(second.structuredContent.outcome, "updated");

      const invalid = await client.callTool({
        name: "publish_current_conversation",
        arguments: {
          contextCompleteness: "unknown",
          messages: [{ role: "system", text: "MUST_NOT_PUBLISH" }],
        },
      });
      assert.equal(invalid.isError, true);
    } finally {
      await client.close();
    }

    const files = (await readdir(capture)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1);
    const snapshot = JSON.parse(await readFile(join(capture, files[0]), "utf8"));
    assert.equal(snapshot.contract, "dlmf/chatgpt-captured-conversation/v1");
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.metadata.transport, "context_publisher");
    assert.equal(snapshot.metadata.authoritativeTranscript, false);
    assert.equal(snapshot.metadata.captureBoundary, "user_requested_snapshot");
    assert.deepEqual(snapshot.messages.map((message) => message.role), [
      "user",
      "assistant",
      "user",
    ]);
    assert.equal(JSON.stringify(snapshot).includes("MUST_NOT_PUBLISH"), false);

    const syncEnv = {
      ...cleanEnv(),
      DLMF_CHATGPT_CAPTURE_ROOT: capture,
      DLMF_CHATGPT_INCREMENTAL_CHECKPOINT: join(state, "checkpoint.json"),
      DLMF_CHATGPT_DEVELOPMENT_EXPERIENCE_JOURNAL: join(state, "references.jsonl"),
      DLMF_CHATGPT_TENANT_ID: "tenant-arthur",
      DLMF_CHATGPT_LIFE_DID: "did:arthurverse:nancy",
      DLMF_CHATGPT_MEMORY_NAMESPACE: "life",
      DLMF_CHATGPT_PAGE_SIZE: "10",
      DLMF_MULTI_SOURCE_WRITE_MODE: "reference_only",
    };
    const sync = spawnSync(
      node,
      [resolve(repo, "scripts/chatgpt-capture-sync-worker.mjs"), "--reference-only"],
      { cwd: repo, env: syncEnv, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(sync.status, 0, sync.stderr);
    assert.match(sync.stdout, /DLMF_CHATGPT_INCREMENTAL=PASS/u);
    assert.match(sync.stdout, /mode=reference_only/u);
    assert.match(sync.stdout, /ingested=0/u);
    assert.match(sync.stdout, /sourceOnly=1/u);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise();
      child.once("exit", resolvePromise);
      setTimeout(resolvePromise, 2_000).unref();
    });
    await rm(root, { recursive: true, force: true });
  }

  assert.match(stdout, /DLMF_CHATGPT_CAPTURE_INBOX=READY/u);
  assert.equal(stderr, "");
});
