import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from "node:http";
import test from "node:test";
import {
  HttpMemoryMaterializationDeliveryPort,
  MaterializationTransportError,
  ValidationError,
  type MemoryFabricMaterializationEvent,
} from "../src/index.js";

const event: MemoryFabricMaterializationEvent = {
  event_type: "memory.materialization.requested",
  event_version: "1",
  outbox_id: "out_http_01",
  event_id: "evt_http_01",
  request_id: "ohmat:out_http_01",
  trace_id: "trace_http_01",
  occurred_at: "2026-09-03T12:00:00.000Z",
  intent: "UPSERT",
  tenant_id: "tenant_http",
  life_did: "did:life:nancy",
  memory_namespace: "life.core",
  memory_id: "mem_http_01",
  canonical_revision: 1,
  commit_seq: 1,
  operation: "create",
  idempotency_key: "memory.materialization:mem_http_01:1",
  canonical_content: { text: "HTTP transport remains provider neutral." },
  metadata: {
    canonical_authority: "digital-life-memory-fabric",
    provider_selection_owned_by: "omniharness",
  },
};

test("HTTP delivery posts the exact OH-MEM-002 event and returns untrusted JSON", async () => {
  let received: unknown;
  let observedHeaders: IncomingMessage["headers"] = {};
  const server = createServer(async (request, response) => {
    observedHeaders = request.headers;
    received = JSON.parse(await readRequest(request)) as unknown;
    response.writeHead(200, { "content-type": "Application/JSON; charset=utf-8" });
    response.end(JSON.stringify(receipt(event)));
  });
  const endpoint = await listen(server);

  try {
    const port = new HttpMemoryMaterializationDeliveryPort({
      endpoint,
    });
    const result = await port.execute(event);
    assert.deepEqual(received, event);
    assert.equal(observedHeaders["content-type"], "application/json");
    assert.equal(observedHeaders.accept, "application/json");
    assert.equal(observedHeaders["idempotency-key"], event.idempotency_key);
    assert.equal(observedHeaders["x-request-id"], event.request_id);
    assert.equal(observedHeaders["x-memory-event-version"], event.event_version);
    assert.equal(observedHeaders["x-trace-id"], event.trace_id);
    assert.deepEqual(result, receipt(event));
  } finally {
    await close(server);
  }
});

test("HTTP delivery fails closed for status, media type, JSON, and response size", async (t) => {
  await t.test("non-success status", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ secretProviderDetail: "not surfaced" }));
      },
      async (endpoint) => {
        const port = new HttpMemoryMaterializationDeliveryPort({ endpoint });
        await assert.rejects(
          port.execute(event),
          (error: unknown) =>
            error instanceof MaterializationTransportError &&
            error.statusCode === 503 &&
            !error.message.includes("secretProviderDetail"),
        );
      },
    );
  });

  await t.test("non-JSON media type", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>not a receipt</html>");
      },
      async (endpoint) => {
        const port = new HttpMemoryMaterializationDeliveryPort({ endpoint });
        await assert.rejects(port.execute(event), MaterializationTransportError);
      },
    );
  });

  await t.test("invalid JSON", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{");
      },
      async (endpoint) => {
        const port = new HttpMemoryMaterializationDeliveryPort({ endpoint });
        await assert.rejects(port.execute(event), MaterializationTransportError);
      },
    );
  });

  await t.test("empty JSON body", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end();
      },
      async (endpoint) => {
        const port = new HttpMemoryMaterializationDeliveryPort({ endpoint });
        await assert.rejects(port.execute(event), MaterializationTransportError);
      },
    );
  });

  await t.test("invalid UTF-8", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(Buffer.from([0xff]));
      },
      async (endpoint) => {
        const port = new HttpMemoryMaterializationDeliveryPort({ endpoint });
        await assert.rejects(
          port.execute(event),
          (error: unknown) =>
            error instanceof MaterializationTransportError &&
            error.message.includes("invalid UTF-8"),
        );
      },
    );
  });

  await t.test("oversized body", async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ payload: "x".repeat(128) }));
      },
      async (endpoint) => {
        const port = new HttpMemoryMaterializationDeliveryPort({
          endpoint,
          maxResponseBytes: 32,
        });
        await assert.rejects(port.execute(event), MaterializationTransportError);
      },
    );
  });
});

test("HTTP delivery validates endpoint and bounded-response configuration", () => {
  assert.throws(
    () => new HttpMemoryMaterializationDeliveryPort({ endpoint: "relative/path" }),
    ValidationError,
  );
  assert.throws(
    () =>
      new HttpMemoryMaterializationDeliveryPort({
        endpoint: "http://127.0.0.1/materialize",
        headers: { authorization: "Bearer local-test" },
      }),
    ValidationError,
  );
  assert.doesNotThrow(
    () =>
      new HttpMemoryMaterializationDeliveryPort({
        endpoint: "https://example.invalid/materialize",
        headers: { authorization: "Bearer local-test" },
      }),
  );
  assert.throws(
    () =>
      new HttpMemoryMaterializationDeliveryPort({
        endpoint: "ftp://127.0.0.1/materialize",
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      new HttpMemoryMaterializationDeliveryPort({
        endpoint: "https://user:secret@example.invalid/materialize",
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      new HttpMemoryMaterializationDeliveryPort({
        endpoint: "http://127.0.0.1/materialize",
        maxResponseBytes: 0,
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      new HttpMemoryMaterializationDeliveryPort({
        endpoint: "http://127.0.0.1/materialize",
        requestTimeoutMs: 0,
      }),
    ValidationError,
  );
});

test("HTTP delivery enforces its deadline and preserves caller cancellation", async (t) => {
  await t.test("standalone deadline", async () => {
    const port = new HttpMemoryMaterializationDeliveryPort({
      endpoint: "http://127.0.0.1/materialize",
      requestTimeoutMs: 10,
      fetchImplementation: abortableFetch,
    });
    await assert.rejects(
      port.execute(event),
      (error: unknown) =>
        error instanceof MaterializationTransportError &&
        error.message.includes("timed out after 10ms"),
    );
  });

  await t.test("caller cancellation", async () => {
    const controller = new AbortController();
    const port = new HttpMemoryMaterializationDeliveryPort({
      endpoint: "http://127.0.0.1/materialize",
      requestTimeoutMs: 1_000,
      fetchImplementation: abortableFetch,
    });
    const execution = port.execute(event, { signal: controller.signal });
    controller.abort();
    await assert.rejects(
      execution,
      (error: unknown) =>
        error instanceof MaterializationTransportError &&
        error.message.includes("request was aborted"),
    );
  });

  await t.test("stalled response body", async () => {
    const port = new HttpMemoryMaterializationDeliveryPort({
      endpoint: "http://127.0.0.1/materialize",
      requestTimeoutMs: 10,
      fetchImplementation: responseWithStalledBody,
    });
    await assert.rejects(
      port.execute(event),
      (error: unknown) =>
        error instanceof MaterializationTransportError &&
        error.message.includes("timed out after 10ms"),
    );
  });
});

test("HTTP delivery rejects redirects without retargeting the canonical event", async () => {
  let redirectedRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/target") {
      redirectedRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(receipt(event)));
      return;
    }
    response.writeHead(307, { location: "/target" });
    response.end();
  });
  const endpoint = await listen(server);

  try {
    const port = new HttpMemoryMaterializationDeliveryPort({ endpoint });
    await assert.rejects(port.execute(event), MaterializationTransportError);
    assert.equal(redirectedRequests, 0);
  } finally {
    await close(server);
  }
});

function receipt(source: MemoryFabricMaterializationEvent) {
  return {
    event_type: source.event_type,
    event_version: source.event_version,
    outbox_id: source.outbox_id,
    request_id: source.request_id,
    trace_id: source.trace_id,
    memory_id: source.memory_id,
    canonical_revision: source.canonical_revision,
    commit_seq: source.commit_seq,
    provider_id: "memory-reference",
    status: "SUCCESS",
    retryable: false,
    canonical_commit_affected: false,
    provider_receipt: {
      providerId: "memory-reference",
      memoryId: source.memory_id,
      canonicalRevision: source.canonical_revision,
      status: "SUCCESS",
      providerObjectId: `reference:${source.memory_id}:r${source.canonical_revision}`,
    },
  };
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1/memory/materializations`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withServer(
  handler: RequestListener,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  const endpoint = await listen(server);
  try {
    await run(endpoint);
  } finally {
    await close(server);
  }
}

const abortableFetch: typeof fetch = async (_input, init) => {
  const signal = init?.signal;
  assert.ok(signal);
  return new Promise<Response>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
};

const responseWithStalledBody: typeof fetch = async (_input, init) => {
  const signal = init?.signal;
  assert.ok(signal);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => controller.error(signal.reason),
        { once: true },
      );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
