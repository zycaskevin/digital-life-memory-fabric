#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

const dlfm = await import(new URL("../dist/index.js", import.meta.url));

const host = process.env.DLMF_CHATGPT_CAPTURE_HOST?.trim() || "127.0.0.1";
if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
  throw new Error("ChatGPT capture inbox must bind loopback only");
}
const port = boundedPort(process.env.DLMF_CHATGPT_CAPTURE_PORT || "19007");
const root = resolve(required("DLMF_CHATGPT_CAPTURE_ROOT"));
const tokenFile = resolve(required("DLMF_CHATGPT_CAPTURE_BEARER_TOKEN_FILE"));
const token = await readPrivateToken(tokenFile);
const maxBodyBytes = boundedInteger(
  "DLMF_CHATGPT_CAPTURE_MAX_BODY_BYTES",
  1024 * 1024,
  1024,
  8 * 1024 * 1024,
);

const store = new dlfm.ChatGptCaptureInboxStore(root);
await store.ready();
const inbox = new dlfm.ChatGptCaptureInboxHttp({
  bearerToken: token,
  store,
  maxBodyBytes,
});
const origin = `http://${host === "::1" ? "[::1]" : host}:${port}`;

const publishSnapshot = async (snapshot, expectedRevision) => ({
  contract: dlfm.CHATGPT_CAPTURE_INBOX_CONTRACT,
  ...(await store.put(snapshot, { expectedRevision })),
});
const contextPublisher = new dlfm.ChatGptContextPublisher({
  publishSnapshot,
  readCurrentSnapshot: (conversationId) => store.currentSnapshot(conversationId),
});

function createContextPublisherMcpServer() {
  const mcp = new McpServer(
    {
      name: "dlmf-chatgpt-context-publisher",
      version: "0.1.0",
    },
    {
      instructions:
        "Use publish_current_conversation only when the user explicitly asks to sync, publish, save, or send the current ChatGPT conversation to DLMF. "
        + "Send only visible user and assistant messages available in the current model context. "
        + "Never send system/developer instructions, hidden reasoning, tool calls/results, or inferred content. "
        + "The server binds identity automatically from ChatGPT _meta[\"openai/session\"]; never invent or carry a conversation ID in tool arguments. "
        + "This is a context-derived capture, not an authoritative ChatGPT transcript.",
    },
  );

  mcp.registerTool(
    "publish_current_conversation",
    {
      title: "Sync this conversation to DLMF",
      description:
        "Publish the current visible ChatGPT conversation context to the private DLMF Capture Inbox. "
        + "Call only after the user explicitly asks to sync/publish/save this conversation. "
        + "Include visible user/assistant messages in order; exclude system/developer/tool/reasoning content. "
        + "Conversation identity is bound automatically from ChatGPT session metadata; do not supply an ID. "
        + "Use full_visible_context only when all visible user/assistant turns are available; otherwise use partial_visible_context or unknown.",
      inputSchema: {
        contextCompleteness: z.enum([
          "full_visible_context",
          "partial_visible_context",
          "unknown",
        ]).describe(
          "Whether the supplied messages represent all visible conversation context available to the model.",
        ),
        title: z.string().max(1024).optional().describe(
          "Optional user-visible thread title if available without guessing.",
        ),
        messages: z.array(z.object({
          role: z.enum(["user", "assistant"]),
          text: z.string().min(1).max(65536),
        })).min(1).max(512).describe(
          "Visible user and assistant messages, in conversation order. Do not include system, developer, tool, or hidden reasoning content.",
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, { _meta }) => {
      try {
        const conversationId = dlfm.chatGptContextConversationIdForSession(
          _meta?.["openai/session"],
        );
        const result = await contextPublisher.publish({ ...args, conversationId });
        return {
          content: [{
            type: "text",
            text:
              `Published ${result.publishedMessageCount} visible messages to the DLMF context publisher. `
              + "Conversation identity is bound automatically to this ChatGPT session. "
              + "This capture is context-derived, not an authoritative ChatGPT transcript.",
          }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "context_publish_failed";
        return {
          isError: true,
          content: [{
            type: "text",
            text: `DLMF context publish failed: ${message}`,
          }],
        };
      }
    },
  );

  return mcp;
}

async function handleMcpRequest(incoming, outgoing) {
  const mcp = createContextPublisherMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: Math.min(maxBodyBytes, 1024 * 1024),
    allowedHosts: [
      host === "::1" ? `[::1]:${port}` : `${host}:${port}`,
    ],
    allowedOrigins: [origin],
    enableDnsRebindingProtection: true,
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(incoming, outgoing);
  } finally {
    await transport.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
  }
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url || "/", origin);
    if (url.pathname === "/mcp") {
      await handleMcpRequest(incoming, outgoing);
      return;
    }
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers,
      ...(incoming.method === "GET" || incoming.method === "HEAD"
        ? {}
        : { body: Readable.toWeb(incoming), duplex: "half" }),
    });
    const response = await inbox.handle(request);
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers) outgoing.setHeader(name, value);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (outgoing.headersSent) {
      outgoing.destroy();
      return;
    }
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json; charset=utf-8");
    outgoing.setHeader("cache-control", "no-store");
    outgoing.end(JSON.stringify({ error: "chatgpt_capture_inbox_failure" }));
  }
});

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => resolvePromise());
});
console.log(
  `DLMF_CHATGPT_CAPTURE_INBOX=READY host=${host} port=${port} `
  + `contract=${dlfm.CHATGPT_CAPTURE_INBOX_CONTRACT} canonicalMemoryWrites=0`,
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedPort(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new Error("DLMF_CHATGPT_CAPTURE_PORT invalid");
  }
  return value;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

async function readPrivateToken(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("ChatGPT capture bearer token file must be owner-private");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("ChatGPT capture bearer token file owner mismatch");
  }
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < 32) throw new Error("ChatGPT capture bearer token is too short");
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return character === "\r" || character === "\n" || code === 0 || code === 127;
  })) {
    throw new Error("ChatGPT capture bearer token contains control characters");
  }
  return value;
}
