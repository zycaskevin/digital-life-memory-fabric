#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";

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

const server = createServer(async (incoming, outgoing) => {
  try {
    const origin = `http://${host === "::1" ? "[::1]" : host}:${port}`;
    const request = new Request(new URL(incoming.url || "/", origin), {
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
