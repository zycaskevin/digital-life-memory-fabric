import { timingSafeEqual } from "node:crypto";
import type { MemoryId, MemoryScope } from "../domain/types.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";
import {
  createDevelopmentReferenceEnvelope,
  DLMF_DEVELOPMENT_REFERENCE_SCHEMA,
} from "./development-reference.js";

const DEFAULT_REFERENCE_PATH_PREFIX =
  "/v1/development/canonical-references/";

export interface DlmfDevelopmentReferenceGatewayOptions {
  readonly bearerToken: string;
  readonly allowedScope: MemoryScope;
  readonly store: Pick<CanonicalMemoryStore, "getHead" | "getRevision">;
  readonly pathPrefix?: string;
}

/**
 * Narrow authenticated read-only gateway for Digital-Life-Development.
 *
 * The gateway exposes one canonical revision reference at a time. It is not a
 * retrieval/search API and never serializes MemoryRevision.canonicalContent.
 */
export class DlmfDevelopmentReferenceGateway {
  readonly #token: string;
  readonly #allowedScope: MemoryScope;
  readonly #store: Pick<CanonicalMemoryStore, "getHead" | "getRevision">;
  readonly #pathPrefix: string;

  constructor(options: DlmfDevelopmentReferenceGatewayOptions) {
    this.#token = requiredSecret(options.bearerToken);
    this.#allowedScope = validateScope(options.allowedScope);
    this.#store = options.store;
    this.#pathPrefix = validatePathPrefix(
      options.pathPrefix ?? DEFAULT_REFERENCE_PATH_PREFIX,
    );
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "dlmf-development-reference-gateway",
        schema: DLMF_DEVELOPMENT_REFERENCE_SCHEMA,
      });
    }

    if (
      request.method !== "GET" ||
      !url.pathname.startsWith(this.#pathPrefix)
    ) {
      return json({ error: "not_found" }, 404);
    }
    if (!constantTimeBearer(request.headers.get("authorization"), this.#token)) {
      return json({ error: "unauthorized" }, 401);
    }

    const queryError = validateQuery(url.searchParams);
    if (queryError !== undefined) {
      return json({ error: queryError }, 400);
    }

    const rawMemoryId = url.pathname.slice(this.#pathPrefix.length);
    if (rawMemoryId.length === 0 || rawMemoryId.includes("/")) {
      return json({ error: "development_reference_memory_id_invalid" }, 400);
    }

    let memoryId: MemoryId;
    try {
      memoryId = validateMemoryId(decodeURIComponent(rawMemoryId));
    } catch {
      return json({ error: "development_reference_memory_id_invalid" }, 400);
    }

    const revisionQuery = url.searchParams.get("revision");
    const revisionSelection = parseRevisionSelection(revisionQuery);
    if (revisionSelection === undefined) {
      return json({ error: "development_reference_revision_invalid" }, 400);
    }

    try {
      const head = await this.#store.getHead(memoryId);
      if (head === undefined || !sameScope(head.scope, this.#allowedScope)) {
        return json({ error: "not_found" }, 404);
      }

      const revisionNumber =
        revisionSelection === "current"
          ? head.currentRevision
          : revisionSelection;
      const revision = await this.#store.getRevision(memoryId, revisionNumber);
      if (revision === undefined) {
        if (revisionSelection === "current") {
          return json({ error: "canonical_state_incomplete" }, 500);
        }
        return json({ error: "not_found" }, 404);
      }
      if (!sameScope(revision.scope, this.#allowedScope)) {
        return json({ error: "not_found" }, 404);
      }

      return json({
        ok: true,
        envelope: createDevelopmentReferenceEnvelope(revision),
      });
    } catch {
      return json({ error: "development_reference_gateway_failed" }, 500);
    }
  }
}

function validateQuery(searchParams: URLSearchParams): string | undefined {
  for (const key of searchParams.keys()) {
    if (key !== "revision") {
      return "development_reference_query_invalid";
    }
  }
  if (searchParams.getAll("revision").length > 1) {
    return "development_reference_query_invalid";
  }
  return undefined;
}

function parseRevisionSelection(
  raw: string | null,
): "current" | number | undefined {
  if (raw === null || raw === "" || raw === "current") return "current";
  if (!/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

function validateMemoryId(value: string): MemoryId {
  if (!/^mem_[A-Za-z0-9._:-]{1,240}$/u.test(value)) {
    throw new Error("invalid memory id");
  }
  return value as MemoryId;
}

function validateScope(scope: MemoryScope): MemoryScope {
  return {
    tenantId: requiredIdentifier(scope.tenantId, "tenantId"),
    lifeDid: requiredIdentifier(scope.lifeDid, "lifeDid"),
    memoryNamespace: requiredIdentifier(
      scope.memoryNamespace,
      "memoryNamespace",
    ),
  };
}

function validatePathPrefix(value: string): string {
  if (
    !value.startsWith("/") ||
    !value.endsWith("/") ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f?#]/u.test(value)
  ) {
    throw new Error("development reference pathPrefix invalid");
  }
  return value;
}

function requiredSecret(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 32 ||
    /[\r\n\u0000]/u.test(value)
  ) {
    throw new Error("development reference bearer token invalid");
  }
  return value;
}

function requiredIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`${field} invalid`);
  }
  return normalized;
}

function constantTimeBearer(header: string | null, token: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.lifeDid === right.lifeDid &&
    left.memoryNamespace === right.memoryNamespace
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
