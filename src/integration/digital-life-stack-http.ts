import { timingSafeEqual } from "node:crypto";
import { ValidationError } from "../domain/errors.js";
import type { MemoryScope } from "../domain/types.js";
import type { TranscriptDistillationService } from "../distillation/transcript-distillation-service.js";
import type { DistillationReceipt, TranscriptDistillationInput } from "../distillation/types.js";
import type { VerifiedRetrievalService } from "../retrieval/verified-retrieval-service.js";
import type { VerifiedRetrievalResult } from "../retrieval/types.js";

export const DIGITAL_LIFE_STACK_DLMF_CONTRACT = "dlmf/digital-life-stack/v1";
export const DIGITAL_LIFE_STACK_DLMF_AUTHORITY = "digital-life-memory-fabric";
const MAX_EXPERIENCE_BODY_BYTES = 262_144;
const MAX_RETRIEVAL_BODY_BYTES = 16_384;

export interface DigitalLifeStackDlmfPolicies {
  distillationPolicyVersion: string;
  canonicalizationPolicyVersion: string;
  admissionPolicyVersion: string;
  retentionPolicyVersion: string;
}

export interface DigitalLifeStackDlmfReadiness {
  ready(): Promise<{ ready: boolean; schemaState: string }>;
}

export interface DigitalLifeStackDlmfIngressOptions {
  bearerToken: string;
  agentId: string;
  runtimeId: string;
  distillation: Pick<TranscriptDistillationService, "run">;
  retrieval: Pick<VerifiedRetrievalService, "retrieve">;
  readiness: DigitalLifeStackDlmfReadiness;
  policies: DigitalLifeStackDlmfPolicies;
}

/**
 * Authenticated consumer boundary for Digital-Life-Stack.
 *
 * This boundary intentionally exposes no canonical commit, promotion, identity,
 * or provider-selection operation. Experience ingestion delegates to the DLMF
 * distillation/admission pipeline; retrieval delegates to canonical verification.
 */
export class DigitalLifeStackDlmfIngress {
  readonly #token: string;
  readonly #agentId: string;
  readonly #runtimeId: string;
  readonly #distillation: Pick<TranscriptDistillationService, "run">;
  readonly #retrieval: Pick<VerifiedRetrievalService, "retrieve">;
  readonly #readiness: DigitalLifeStackDlmfReadiness;
  readonly #policies: DigitalLifeStackDlmfPolicies;

  constructor(options: DigitalLifeStackDlmfIngressOptions) {
    this.#token = requiredSecret(options.bearerToken);
    this.#agentId = requiredIdentifier(options.agentId, "agentId");
    this.#runtimeId = requiredIdentifier(options.runtimeId, "runtimeId");
    this.#distillation = options.distillation;
    this.#retrieval = options.retrieval;
    this.#readiness = options.readiness;
    this.#policies = validatePolicies(options.policies);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "dlmf-digital-life-stack-ingress",
        contract: DIGITAL_LIFE_STACK_DLMF_CONTRACT,
        canonicalAuthority: DIGITAL_LIFE_STACK_DLMF_AUTHORITY,
      });
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      try {
        const readiness = await this.#readiness.ready();
        return json({
          ok: readiness.ready,
          service: "dlmf-digital-life-stack-ingress",
          contract: DIGITAL_LIFE_STACK_DLMF_CONTRACT,
          canonicalAuthority: DIGITAL_LIFE_STACK_DLMF_AUTHORITY,
          schemaState: readiness.schemaState,
        }, readiness.ready ? 200 : 503);
      } catch {
        return json({
          ok: false,
          service: "dlmf-digital-life-stack-ingress",
          contract: DIGITAL_LIFE_STACK_DLMF_CONTRACT,
          canonicalAuthority: DIGITAL_LIFE_STACK_DLMF_AUTHORITY,
          schemaState: "unavailable",
        }, 503);
      }
    }

    if (
      request.method !== "POST"
      || (url.pathname !== "/v1/digital-life-stack/experiences"
        && url.pathname !== "/v1/digital-life-stack/retrievals")
    ) {
      return json({ error: "not_found" }, 404);
    }
    if (!constantTimeBearer(request.headers.get("authorization"), this.#token)) {
      return json({ error: "unauthorized" }, 401);
    }

    const readiness = await this.#safeReadiness();
    if (!readiness.ready) {
      return json({ error: "dlmf_not_ready", schemaState: readiness.schemaState }, 503);
    }

    try {
      if (url.pathname === "/v1/digital-life-stack/experiences") {
        const body = plainObject(
          await readBoundedJson(request, MAX_EXPERIENCE_BODY_BYTES),
          "digital_life_stack_experience_invalid",
        );
        requireOnlyKeys(body, [
          "scope", "sourceType", "sourceId", "content", "contentType",
          "createdAt", "observedAt", "metadata",
        ]);
        const scope = validateScope(body.scope);
        const input: TranscriptDistillationInput = {
          scope,
          origin: { lifeDid: scope.lifeDid, agentId: this.#agentId, runtimeId: this.#runtimeId },
          sourceType: requiredString(body.sourceType, 128, "sourceType"),
          sourceId: requiredString(body.sourceId, 512, "sourceId"),
          content: requiredString(body.content, 200_000, "content", false),
          contentType: requiredString(body.contentType, 256, "contentType"),
          ...(body.createdAt === undefined ? {} : { createdAt: isoString(body.createdAt, "createdAt") }),
          ...(body.observedAt === undefined ? {} : { observedAt: isoString(body.observedAt, "observedAt") }),
          ...(body.metadata === undefined ? {} : { metadata: scalarMetadata(body.metadata) }),
          ...this.#policies,
        };
        const receipt = await this.#distillation.run(input);
        return json({ ok: true, receipt: publicReceipt(receipt) });
      }

      const body = plainObject(
        await readBoundedJson(request, MAX_RETRIEVAL_BODY_BYTES),
        "digital_life_stack_retrieval_invalid",
      );
      requireOnlyKeys(body, ["scope", "query", "topK"]);
      const result = await this.#retrieval.retrieve({
        scope: validateScope(body.scope),
        query: requiredString(body.query, 4_096, "query"),
        ...(body.topK === undefined ? {} : { topK: boundedInteger(body.topK, 1, 100, "topK") }),
        timeoutMs: 10_000,
      });
      return json({ ok: true, retrieval: publicRetrieval(result) });
    } catch (error) {
      const code = publicError(error);
      return json({ error: code }, code === "request_body_too_large" ? 413 : 400);
    }
  }

  async #safeReadiness(): Promise<{ ready: boolean; schemaState: string }> {
    try {
      return await this.#readiness.ready();
    } catch {
      return { ready: false, schemaState: "unavailable" };
    }
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
    admissionComplete: receipt.admissionComplete,
    curationCoverageComplete: receipt.curationCoverageComplete,
    pruneEligible: receipt.pruneEligible,
  };
}

function publicRetrieval(result: VerifiedRetrievalResult) {
  return {
    scope: result.scope,
    providerId: result.providerId,
    effectiveAt: result.effectiveAt,
    items: result.items.map((item) => ({
      memoryId: item.memoryId,
      revision: item.canonicalRevision,
      text: item.revision.canonicalContent.text,
      memoryType: item.revision.memoryType,
      epistemicStatus: item.revision.epistemicStatus,
      committedAt: item.revision.committedAt,
    })),
    verification: result.verification,
  };
}

function validateScope(value: unknown): MemoryScope {
  const object = plainObject(value, "scope invalid");
  requireOnlyKeys(object, ["tenantId", "lifeDid", "memoryNamespace"]);
  return {
    tenantId: requiredString(object.tenantId, 256, "scope.tenantId"),
    lifeDid: requiredString(object.lifeDid, 256, "scope.lifeDid"),
    memoryNamespace: requiredString(object.memoryNamespace, 512, "scope.memoryNamespace"),
  };
}

function validatePolicies(input: DigitalLifeStackDlmfPolicies): DigitalLifeStackDlmfPolicies {
  return {
    distillationPolicyVersion: requiredIdentifier(input.distillationPolicyVersion, "distillationPolicyVersion"),
    canonicalizationPolicyVersion: requiredIdentifier(input.canonicalizationPolicyVersion, "canonicalizationPolicyVersion"),
    admissionPolicyVersion: requiredIdentifier(input.admissionPolicyVersion, "admissionPolicyVersion"),
    retentionPolicyVersion: requiredIdentifier(input.retentionPolicyVersion, "retentionPolicyVersion"),
  };
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new ValidationError(`unsupported field: ${key}`);
  }
}

function plainObject(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(code);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, max: number, field: string, trim = true): string {
  if (typeof value !== "string") throw new ValidationError(`${field} invalid`);
  const normalized = trim ? value.trim() : value;
  if (normalized.length === 0 || normalized.length > max || /\u0000/u.test(normalized)) {
    throw new ValidationError(`${field} invalid`);
  }
  return normalized;
}

function requiredIdentifier(value: string, field: string): string {
  return requiredString(value, 512, field);
}

function requiredSecret(value: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 512 || /[\r\n\u0000]/u.test(value)) {
    throw new ValidationError("digital_life_stack_dlmf_bearer_invalid");
  }
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ValidationError(`${field} invalid`);
  }
  return value as number;
}

function isoString(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ValidationError(`${field} invalid`);
  }
  return new Date(value).toISOString();
}

function scalarMetadata(value: unknown): Record<string, unknown> {
  const object = plainObject(value, "metadata invalid");
  if (Object.keys(object).length > 32) throw new ValidationError("metadata invalid");
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (!/^[a-z0-9_.:-]{1,64}$/iu.test(key)) throw new ValidationError("metadata invalid");
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new ValidationError("metadata invalid");
    }
    if (typeof item === "number" && !Number.isFinite(item)) throw new ValidationError("metadata invalid");
    if (typeof item === "string" && item.length > 2_048) throw new ValidationError("metadata invalid");
    result[key] = item;
  }
  return result;
}

async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ValidationError("content_type_invalid");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw new ValidationError("request_body_too_large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) throw new ValidationError("request_body_too_large");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ValidationError("request_json_invalid");
  }
}

function constantTimeBearer(header: string | null, token: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function publicError(error: unknown): string {
  if (error instanceof ValidationError) {
    const message = error.message;
    if (message === "request_body_too_large") return message;
    return message.replace(/[^a-zA-Z0-9_.:-]+/gu, "_").slice(0, 120);
  }
  return "digital_life_stack_request_failed";
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
