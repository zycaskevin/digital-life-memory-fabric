import {
  MaterializationTransportError,
  ValidationError,
} from "../domain/errors.js";
import type {
  MaterializationDeliveryOptions,
  MemoryFabricMaterializationEvent,
  MemoryMaterializationDeliveryPort,
} from "./types.js";

export const DEFAULT_MATERIALIZATION_RESPONSE_LIMIT_BYTES = 1_048_576;
export const MAX_MATERIALIZATION_RESPONSE_LIMIT_BYTES = 16_777_216;
export const DEFAULT_MATERIALIZATION_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_MATERIALIZATION_REQUEST_TIMEOUT_MS = 300_000;

export interface HttpMemoryMaterializationDeliveryPortOptions {
  readonly endpoint: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

/**
 * Provider-neutral HTTP transport for the OH-MEM-002 execution boundary.
 *
 * Retry, fencing, receipt validation, and canonical settlement remain owned by
 * MaterializationWorker. This port performs one bounded POST and returns the
 * decoded, still-untrusted JSON response.
 */
export class HttpMemoryMaterializationDeliveryPort
  implements MemoryMaterializationDeliveryPort
{
  readonly #endpoint: URL;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #maxResponseBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpMemoryMaterializationDeliveryPortOptions) {
    this.#endpoint = validateEndpoint(options.endpoint);
    this.#headers = Object.freeze({ ...(options.headers ?? {}) });
    if (
      this.#endpoint.protocol === "http:" &&
      Object.keys(this.#headers).length > 0
    ) {
      throw new ValidationError(
        "custom materialization HTTP headers require an https endpoint",
      );
    }
    this.#maxResponseBytes = validateResponseLimit(options.maxResponseBytes);
    this.#requestTimeoutMs = validateRequestTimeout(options.requestTimeoutMs);
    this.#fetch = options.fetchImplementation ?? globalThis.fetch;
  }

  async execute(
    event: MemoryFabricMaterializationEvent,
    options?: MaterializationDeliveryOptions,
  ): Promise<unknown> {
    const deadline = new AbortController();
    const timeout = setTimeout(
      () => deadline.abort(),
      this.#requestTimeoutMs,
    );
    const signal =
      options?.signal === undefined
        ? deadline.signal
        : AbortSignal.any([options.signal, deadline.signal]);
    try {
      return await this.#executeRequest(event, signal);
    } catch (error) {
      if (error instanceof MaterializationTransportError) throw error;
      const reason = options?.signal?.aborted
        ? "request was aborted"
        : deadline.signal.aborted
          ? `request timed out after ${this.#requestTimeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      throw new MaterializationTransportError(
        `OmniHarness HTTP delivery failed: ${reason}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async #executeRequest(
    event: MemoryFabricMaterializationEvent,
    signal: AbortSignal,
  ): Promise<unknown> {
    const headers = new Headers(this.#headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set("idempotency-key", event.idempotency_key);
    headers.set("x-request-id", event.request_id);
    headers.set("x-memory-event-version", event.event_version);
    if (event.trace_id !== undefined) headers.set("x-trace-id", event.trace_id);

    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
      signal,
      redirect: "error",
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new MaterializationTransportError(
        `OmniHarness HTTP delivery returned HTTP ${response.status}`,
        response.status,
      );
    }

    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      await response.body?.cancel();
      throw new MaterializationTransportError(
        "OmniHarness HTTP delivery returned a non-JSON response",
        response.status,
      );
    }

    const body = await readBoundedBody(response, this.#maxResponseBytes);
    if (body.length === 0) {
      throw new MaterializationTransportError(
        "OmniHarness HTTP delivery returned an empty response",
        response.status,
      );
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new MaterializationTransportError(
        "OmniHarness HTTP delivery returned invalid JSON",
        response.status,
      );
    }
  }
}

function validateEndpoint(value: string | URL): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ValidationError("materialization HTTP endpoint must be an absolute URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new ValidationError("materialization HTTP endpoint must use http or https");
  }
  if (endpoint.username || endpoint.password) {
    throw new ValidationError("materialization HTTP endpoint must not contain credentials");
  }
  if (endpoint.hash) {
    throw new ValidationError("materialization HTTP endpoint must not contain a fragment");
  }
  return endpoint;
}

function validateResponseLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MATERIALIZATION_RESPONSE_LIMIT_BYTES;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_MATERIALIZATION_RESPONSE_LIMIT_BYTES
  ) {
    throw new ValidationError(
      `maxResponseBytes must be a safe integer between 1 and ${MAX_MATERIALIZATION_RESPONSE_LIMIT_BYTES}`,
    );
  }
  return limit;
}

function validateRequestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_MATERIALIZATION_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_MATERIALIZATION_REQUEST_TIMEOUT_MS
  ) {
    throw new ValidationError(
      `requestTimeoutMs must be a safe integer between 1 and ${MAX_MATERIALIZATION_REQUEST_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    const bytes = Number(advertised);
    if (Number.isFinite(bytes) && bytes > limit) {
      await response.body?.cancel();
      throw new MaterializationTransportError(
        `OmniHarness HTTP response exceeded ${limit} bytes`,
        response.status,
      );
    }
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new MaterializationTransportError(
          `OmniHarness HTTP response exceeded ${limit} bytes`,
          response.status,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new MaterializationTransportError(
      "OmniHarness HTTP delivery returned invalid UTF-8",
      response.status,
    );
  }
}
