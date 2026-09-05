import { timingSafeEqual } from "node:crypto";
import { ValidationError } from "../domain/errors.js";
import type { MemoryScope } from "../domain/types.js";
import type { TranscriptDistillationService } from "../distillation/transcript-distillation-service.js";
import type {
  DistillationReceipt,
  DistillationSourceSegment,
  TranscriptDistillationInput,
} from "../distillation/types.js";
import type { VerifiedRetrievalService } from "../retrieval/verified-retrieval-service.js";
import type { VerifiedRetrievalResult } from "../retrieval/types.js";

const DEFAULT_DISTILLATION_BODY_LIMIT = 32_768;
const DEFAULT_RETRIEVAL_BODY_LIMIT = 8_192;
const PRIVATE_TURN_CONTENT_TYPE = "application/vnd.relationship-os.private-turn+json;version=1";

export interface RelationshipOsIngressPolicies {
  distillationPolicyVersion: string;
  canonicalizationPolicyVersion: string;
  admissionPolicyVersion: string;
  retentionPolicyVersion: string;
}

export interface RelationshipOsDlmfIngressOptions {
  bearerToken: string;
  allowedTenantId: string;
  allowedLifeDid: string;
  memoryNamespacePrefix: string;
  agentId: string;
  runtimeId?: string;
  distillation: Pick<TranscriptDistillationService, "run">;
  retrieval: Pick<VerifiedRetrievalService, "retrieve">;
  policies: RelationshipOsIngressPolicies;
  maxDistillationBodyBytes?: number;
  maxRetrievalBodyBytes?: number;
}

/**
 * Narrow authenticated ingress for Relationship OS private turns.
 *
 * The HTTP boundary owns authentication, bounded parsing and caller scope
 * restriction only. Canonical memory mutation still happens exclusively inside
 * TranscriptDistillationService / CanonicalMemoryAuthority. Retrieval returns
 * canonical hydrated content from VerifiedRetrievalService, never provider text.
 */
export class RelationshipOsDlmfIngress {
  readonly #token: string;
  readonly #allowedTenantId: string;
  readonly #allowedLifeDid: string;
  readonly #namespacePrefix: string;
  readonly #agentId: string;
  readonly #runtimeId: string | undefined;
  readonly #distillation: Pick<TranscriptDistillationService, "run">;
  readonly #retrieval: Pick<VerifiedRetrievalService, "retrieve">;
  readonly #policies: RelationshipOsIngressPolicies;
  readonly #maxDistillationBodyBytes: number;
  readonly #maxRetrievalBodyBytes: number;

  constructor(options: RelationshipOsDlmfIngressOptions) {
    this.#token = requiredSecret(options.bearerToken, "relationship_os_dlmf_bearer_token_invalid");
    this.#allowedTenantId = requiredIdentifier(options.allowedTenantId, "allowedTenantId");
    this.#allowedLifeDid = requiredIdentifier(options.allowedLifeDid, "allowedLifeDid");
    this.#namespacePrefix = requiredIdentifier(options.memoryNamespacePrefix, "memoryNamespacePrefix");
    this.#agentId = requiredIdentifier(options.agentId, "agentId");
    this.#runtimeId = options.runtimeId === undefined
      ? undefined
      : requiredIdentifier(options.runtimeId, "runtimeId");
    this.#distillation = options.distillation;
    this.#retrieval = options.retrieval;
    this.#policies = validatePolicies(options.policies);
    this.#maxDistillationBodyBytes = boundedInteger(
      options.maxDistillationBodyBytes ?? DEFAULT_DISTILLATION_BODY_LIMIT,
      4_096,
      262_144,
      "maxDistillationBodyBytes",
    );
    this.#maxRetrievalBodyBytes = boundedInteger(
      options.maxRetrievalBodyBytes ?? DEFAULT_RETRIEVAL_BODY_LIMIT,
      1_024,
      65_536,
      "maxRetrievalBodyBytes",
    );
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "dlmf-relationship-os-ingress" });
    }

    if (
      request.method !== "POST"
      || (
        url.pathname !== "/v1/relationship-os/transcript-distillations"
        && url.pathname !== "/v1/relationship-os/retrievals"
      )
    ) {
      return json({ error: "not_found" }, 404);
    }
    if (!constantTimeBearer(request.headers.get("authorization"), this.#token)) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      if (url.pathname === "/v1/relationship-os/transcript-distillations") {
        const body = await readBoundedJson(request, this.#maxDistillationBodyBytes);
        const input = this.#distillationInput(body);
        const receipt = await this.#distillation.run(input);
        return json({ ok: true, receipt: publicReceipt(receipt) }, 200);
      }

      const body = await readBoundedJson(request, this.#maxRetrievalBodyBytes);
      const input = this.#retrievalInput(body);
      const result = await this.#retrieval.retrieve(input);
      return json({ ok: true, retrieval: publicRetrieval(result) }, 200);
    } catch (error) {
      const code = publicErrorCode(error);
      return json({ error: code }, code === "request_body_too_large" ? 413 : 400);
    }
  }

  #distillationInput(value: unknown): TranscriptDistillationInput {
    const object = plainObject(value, "relationship_os_distillation_request_invalid");
    const scope = this.#scope(object.scope);
    const sourceType = requiredExactString(
      object.sourceType,
      "relationship_os_private_turn",
      "relationship_os_source_type_invalid",
    );
    const sourceId = requiredString(object.sourceId, 256, "relationship_os_source_id_invalid");
    if (!/^ros-private-turn:pt_[0-9a-f]{32}$/u.test(sourceId)) {
      throw new ValidationError("relationship_os_source_id_invalid");
    }
    const content = requiredString(object.content, 16_384, "relationship_os_content_invalid", false);
    const contentType = requiredExactString(
      object.contentType,
      PRIVATE_TURN_CONTENT_TYPE,
      "relationship_os_content_type_invalid",
    );
    const sourceSegments = validateSourceSegments(object.sourceSegments);
    const createdAt = optionalIso(object.createdAt, "relationship_os_created_at_invalid");
    const observedAt = optionalIso(object.observedAt, "relationship_os_observed_at_invalid");
    const metadata = validateMetadata(object.metadata);

    return {
      scope,
      origin: {
        lifeDid: scope.lifeDid,
        agentId: this.#agentId,
        ...(this.#runtimeId === undefined ? {} : { runtimeId: this.#runtimeId }),
      },
      sourceType,
      sourceId,
      content,
      contentType,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(observedAt === undefined ? {} : { observedAt }),
      ...(metadata === undefined ? {} : { metadata }),
      sourceSegments,
      ...this.#policies,
    };
  }

  #retrievalInput(value: unknown) {
    const object = plainObject(value, "relationship_os_retrieval_request_invalid");
    const scope = this.#scope(object.scope);
    const query = requiredString(object.query, 4_096, "relationship_os_retrieval_query_invalid");
    const topK = object.topK === undefined
      ? 8
      : boundedInteger(object.topK, 1, 20, "relationship_os_retrieval_top_k_invalid");
    return { scope, query, topK, timeoutMs: 10_000 };
  }

  #scope(value: unknown): MemoryScope {
    const object = plainObject(value, "relationship_os_scope_invalid");
    const tenantId = requiredString(object.tenantId, 256, "relationship_os_scope_invalid");
    const lifeDid = requiredString(object.lifeDid, 256, "relationship_os_scope_invalid");
    const memoryNamespace = requiredString(
      object.memoryNamespace,
      512,
      "relationship_os_scope_invalid",
    );
    const namespaceSuffix = memoryNamespace.startsWith(this.#namespacePrefix)
      ? memoryNamespace.slice(this.#namespacePrefix.length)
      : "";
    if (
      tenantId !== this.#allowedTenantId
      || lifeDid !== this.#allowedLifeDid
      || !/^[0-9a-f]{32}$/u.test(namespaceSuffix)
    ) {
      throw new ValidationError("relationship_os_scope_forbidden");
    }
    return { tenantId, lifeDid, memoryNamespace };
  }
}

function publicReceipt(receipt: DistillationReceipt) {
  return {
    receiptId: receipt.receiptId,
    scope: receipt.scope,
    sourceType: receipt.sourceType,
    sourceId: receipt.sourceId,
    status: receipt.status,
    canonicalMemoryIds: receipt.canonicalMemoryIds,
    canonicalizationOutcome: receipt.canonicalizationOutcome,
    retentionState: receipt.retentionState,
    curationCoverageComplete: receipt.curationCoverageComplete,
    admissionComplete: receipt.admissionComplete,
    pruneEligible: receipt.pruneEligible,
    ...(receipt.rawArchiveRef === undefined ? {} : { rawArchiveRef: receipt.rawArchiveRef }),
    ...(receipt.rawArchiveChecksum === undefined
      ? {}
      : { rawArchiveChecksum: receipt.rawArchiveChecksum }),
  };
}

function publicRetrieval(result: VerifiedRetrievalResult) {
  return {
    scope: result.scope,
    effectiveAt: result.effectiveAt,
    items: result.items.map((item) => ({
      memoryId: item.memoryId,
      revision: item.canonicalRevision,
      memoryClass: item.revision.memoryClass,
      memoryKind: item.revision.memoryKind,
      text: item.revision.canonicalContent.text,
      epistemicStatus: item.revision.epistemicStatus,
      committedAt: item.revision.committedAt,
    })),
    verification: result.verification,
  };
}

async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new ValidationError("content_type_invalid");
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared) || Number(declared) > limit) {
      throw new ValidationError("request_body_too_large");
    }
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader !== undefined) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > limit) {
          try { await reader.cancel("request_body_too_large"); } catch {}
          throw new ValidationError("request_body_too_large");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError("request_utf8_invalid");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("request_json_invalid");
  }
}

function validateSourceSegments(value: unknown): DistillationSourceSegment[] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ValidationError("relationship_os_source_segments_invalid");
  }
  const segments = value.map((entry) => {
    const object = plainObject(entry, "relationship_os_source_segments_invalid");
    const segmentId = requiredString(object.segmentId, 256, "relationship_os_source_segments_invalid");
    const actor = object.actor;
    if (actor !== "user" && actor !== "assistant") {
      throw new ValidationError("relationship_os_source_segments_invalid");
    }
    const content = requiredString(object.content, 4_096, "relationship_os_source_segments_invalid", false);
    const observedAt = optionalIso(object.observedAt, "relationship_os_source_segments_invalid");
    return {
      segmentId,
      actor,
      content,
      ...(observedAt === undefined ? {} : { observedAt }),
    } satisfies DistillationSourceSegment;
  });
  if (segments[0]?.actor !== "user" || segments[1]?.actor !== "assistant") {
    throw new ValidationError("relationship_os_source_segments_invalid");
  }
  if (segments[0]?.segmentId === segments[1]?.segmentId) {
    throw new ValidationError("relationship_os_source_segments_invalid");
  }
  return segments;
}

function validateMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const object = plainObject(value, "relationship_os_metadata_invalid");
  const entries = Object.entries(object);
  if (entries.length > 32) throw new ValidationError("relationship_os_metadata_invalid");
  const result: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    if (!/^[a-z0-9_.:-]{1,64}$/iu.test(key)) throw new ValidationError("relationship_os_metadata_invalid");
    if (
      typeof raw !== "string"
      && typeof raw !== "number"
      && typeof raw !== "boolean"
      && raw !== null
    ) {
      throw new ValidationError("relationship_os_metadata_invalid");
    }
    if (typeof raw === "string" && raw.length > 512) throw new ValidationError("relationship_os_metadata_invalid");
    if (typeof raw === "number" && !Number.isFinite(raw)) throw new ValidationError("relationship_os_metadata_invalid");
    result[key] = raw;
  }
  return result;
}

function validatePolicies(input: RelationshipOsIngressPolicies): RelationshipOsIngressPolicies {
  return {
    distillationPolicyVersion: requiredIdentifier(input.distillationPolicyVersion, "distillationPolicyVersion"),
    canonicalizationPolicyVersion: requiredIdentifier(input.canonicalizationPolicyVersion, "canonicalizationPolicyVersion"),
    admissionPolicyVersion: requiredIdentifier(input.admissionPolicyVersion, "admissionPolicyVersion"),
    retentionPolicyVersion: requiredIdentifier(input.retentionPolicyVersion, "retentionPolicyVersion"),
  };
}

function constantTimeBearer(header: string | null, token: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requiredSecret(value: string, code: string): string {
  if (typeof value !== "string" || value.trim().length < 32 || /[\r\n\u0000]/u.test(value)) {
    throw new ValidationError(code);
  }
  return value;
}

function requiredIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ValidationError(`${field} invalid`);
  }
  return normalized;
}

function requiredExactString(value: unknown, expected: string, code: string): string {
  if (value !== expected) throw new ValidationError(code);
  return expected;
}

function requiredString(
  value: unknown,
  max: number,
  code: string,
  trim = true,
): string {
  if (typeof value !== "string" || value.includes("\u0000")) throw new ValidationError(code);
  const normalized = trim ? value.trim() : value;
  if (normalized.trim().length === 0 || [...normalized].length > max) throw new ValidationError(code);
  return normalized;
}

function optionalIso(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ValidationError(code);
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} invalid`);
  }
  return value;
}

function plainObject(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(code);
  }
  return value as Record<string, unknown>;
}

function publicErrorCode(error: unknown): string {
  if (error instanceof ValidationError) {
    const message = error.message;
    if (/^[a-z0-9_.:-]{1,128}$/iu.test(message)) return message;
  }
  return "dlmf_relationship_os_request_failed";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
