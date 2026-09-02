import {
  RetrievalExecutionError,
  RetrievalResponseIntegrityError,
  ValidationError,
} from "../domain/errors.js";
import type { MemoryClass, MemoryId, MemoryScope } from "../domain/types.js";
import { SystemClock, type Clock } from "../domain/utils.js";
import {
  CanonicalVerifier,
  type VerificationSuppressionReason,
} from "../verification/canonical-verifier.js";
import {
  DEFAULT_VERIFIED_RETRIEVAL_TIMEOUT_MS,
  DEFAULT_VERIFIED_RETRIEVAL_TOP_K,
  MAX_VERIFIED_RETRIEVAL_TIMEOUT_MS,
  MAX_VERIFIED_RETRIEVAL_TOP_K,
  type MemoryFreshnessRequirement,
  type MemoryRetrievalPort,
  type MemorySearchFilters,
  type MemorySearchRequest,
  type ProviderRetrievalEvidence,
  type RetrievalSuppressionCounts,
  type VerifiedRetrievalInput,
  type VerifiedRetrievalItem,
  type VerifiedRetrievalResult,
} from "./types.js";

const MAX_QUERY_LENGTH = 4_096;
const MAX_FILTER_KEYS = 32;
const MEMORY_CLASSES = new Set<MemoryClass>([
  "episode",
  "semantic_assertion",
  "preference",
  "relationship_fact",
]);

interface ProviderCandidate {
  readonly memoryId: MemoryId;
  readonly canonicalRevision: number;
  readonly providerId: string;
  readonly providerRank: number;
  readonly providerScore?: number;
  readonly providerObjectId?: string;
}

interface ProviderSearchResult {
  readonly providerId: string;
  readonly candidates: readonly ProviderCandidate[];
  readonly latestMaterializedCommitSeq?: number;
}

export class VerifiedRetrievalService {
  constructor(
    private readonly verifier: CanonicalVerifier,
    private readonly retrieval: MemoryRetrievalPort,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async retrieve(input: VerifiedRetrievalInput): Promise<VerifiedRetrievalResult> {
    const request = validateInput(input);
    const effectiveAt = input.effectiveAt ?? this.clock.now();
    validateTimestamp(effectiveAt, "effectiveAt");
    const timeoutMs = input.timeoutMs ?? DEFAULT_VERIFIED_RETRIEVAL_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > MAX_VERIFIED_RETRIEVAL_TIMEOUT_MS
    ) {
      throw new ValidationError(
        `timeoutMs must be a safe integer between 100 and ${MAX_VERIFIED_RETRIEVAL_TIMEOUT_MS}`,
      );
    }

    const raw = await searchWithTimeout(
      this.retrieval,
      request,
      input.freshness,
      timeoutMs,
    );
    const providerResult = validateProviderResult(raw, request.topK);
    const { unique, duplicateCount } = deduplicate(providerResult.candidates);
    const decisions = await this.verifier.verifyMany(
      unique.map((candidate) => ({
        memoryId: candidate.memoryId,
        expectedRevision: candidate.canonicalRevision,
      })),
      request.scope,
      { effectiveAt },
    );

    const items: VerifiedRetrievalItem[] = [];
    const suppressionCounts: Record<string, number> = {};
    if (duplicateCount > 0) suppressionCounts.DUPLICATE = duplicateCount;

    for (let index = 0; index < unique.length; index += 1) {
      const candidate = unique[index];
      const decision = decisions[index];
      if (candidate === undefined || decision === undefined) {
        throw new RetrievalResponseIntegrityError(
          "canonical verification did not preserve candidate cardinality",
        );
      }
      if (decision.decision === "SUPPRESS") {
        increment(suppressionCounts, decision.reason);
        continue;
      }
      const evidence: ProviderRetrievalEvidence = {
        providerId: candidate.providerId,
        claimedCanonicalRevision: candidate.canonicalRevision,
        providerRank: candidate.providerRank,
        ...(candidate.providerScore === undefined
          ? {}
          : { providerScore: candidate.providerScore }),
        ...(candidate.providerObjectId === undefined
          ? {}
          : { providerObjectId: candidate.providerObjectId }),
      };
      items.push({
        memoryId: decision.revision.memoryId,
        canonicalRevision: decision.revision.revision,
        revision: decision.revision,
        retrievalEvidence: evidence,
      });
    }

    const suppressed = providerResult.candidates.length - items.length;
    return {
      query: request.query,
      scope: request.scope,
      providerId: providerResult.providerId,
      effectiveAt,
      items,
      ...(providerResult.latestMaterializedCommitSeq === undefined
        ? {}
        : {
            latestMaterializedCommitSeq:
              providerResult.latestMaterializedCommitSeq,
          }),
      verification: {
        receivedCandidates: providerResult.candidates.length,
        uniqueCandidates: unique.length,
        allowed: items.length,
        suppressed,
        suppressionCounts: suppressionCounts as RetrievalSuppressionCounts,
      },
    };
  }
}

function validateInput(input: VerifiedRetrievalInput): MemorySearchRequest {
  const query = input.query.trim();
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) {
    throw new ValidationError(
      `query must contain between 1 and ${MAX_QUERY_LENGTH} characters`,
    );
  }
  validateScope(input.scope);
  const topK = input.topK ?? DEFAULT_VERIFIED_RETRIEVAL_TOP_K;
  if (
    !Number.isSafeInteger(topK) ||
    topK < 0 ||
    topK > MAX_VERIFIED_RETRIEVAL_TOP_K
  ) {
    throw new ValidationError(
      `topK must be a safe integer between 0 and ${MAX_VERIFIED_RETRIEVAL_TOP_K}`,
    );
  }
  validateFilters(input.filters);
  validateFreshness(input.freshness);
  return {
    query,
    scope: { ...input.scope },
    topK,
    ...(input.filters === undefined ? {} : { filters: input.filters }),
  };
}

function validateScope(scope: MemoryScope): void {
  for (const [field, value] of [
    ["scope.tenantId", scope.tenantId],
    ["scope.lifeDid", scope.lifeDid],
    ["scope.memoryNamespace", scope.memoryNamespace],
  ] as const) {
    if (value.trim().length === 0) {
      throw new ValidationError(`${field} must not be empty`);
    }
  }
}

function validateFilters(filters: MemorySearchFilters | undefined): void {
  if (filters !== undefined && !isPlainObject(filters)) {
    throw new ValidationError("filters must be an object when present");
  }
  if (filters?.memoryClass !== undefined) {
    if (!Array.isArray(filters.memoryClass)) {
      throw new ValidationError("filters.memoryClass must be an array");
    }
    const seen = new Set<MemoryClass>();
    for (const memoryClass of filters.memoryClass) {
      if (!MEMORY_CLASSES.has(memoryClass) || seen.has(memoryClass)) {
        throw new ValidationError(
          "filters.memoryClass must contain unique supported memory classes",
        );
      }
      seen.add(memoryClass);
    }
  }
  if (filters?.metadata !== undefined) {
    if (!isPlainObject(filters.metadata)) {
      throw new ValidationError("filters.metadata must be an object");
    }
    const entries = Object.entries(filters.metadata);
    if (entries.length > MAX_FILTER_KEYS) {
      throw new ValidationError(
        `filters.metadata must contain at most ${MAX_FILTER_KEYS} keys`,
      );
    }
    for (const [key, value] of entries) {
      if (key.trim().length === 0) {
        throw new ValidationError("filters.metadata keys must not be empty");
      }
      if (
        (typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean") ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        throw new ValidationError(
          "filters.metadata values must be strings, finite numbers, or booleans",
        );
      }
    }
  }
}

function validateFreshness(
  freshness: MemoryFreshnessRequirement | undefined,
): void {
  if (freshness === undefined) return;
  if (!isPlainObject(freshness)) {
    throw new ValidationError("freshness must be an object when present");
  }
  if (
    !Number.isSafeInteger(freshness.requiredCommitSeq) ||
    freshness.requiredCommitSeq < 0
  ) {
    throw new ValidationError(
      "freshness.requiredCommitSeq must be a non-negative safe integer",
    );
  }
  if (
    freshness.allowRebuilding !== undefined &&
    typeof freshness.allowRebuilding !== "boolean"
  ) {
    throw new ValidationError(
      "freshness.allowRebuilding must be boolean when present",
    );
  }
  if (
    !Number.isSafeInteger(freshness.maxCommitLag) ||
    freshness.maxCommitLag < 0
  ) {
    throw new ValidationError(
      "freshness.maxCommitLag must be a non-negative safe integer",
    );
  }
}

function validateTimestamp(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a valid ISO-8601 timestamp`);
  }
}

async function searchWithTimeout(
  port: MemoryRetrievalPort,
  request: MemorySearchRequest,
  freshness: MemoryFreshnessRequirement | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      port.search(request, {
        signal: controller.signal,
        ...(freshness === undefined ? {} : { freshness }),
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(
            new RetrievalExecutionError(
              `Provider retrieval timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      throw new RetrievalExecutionError(
        `Provider retrieval timed out after ${timeoutMs}ms`,
      );
    }
    throw new RetrievalExecutionError("Provider retrieval failed");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function validateProviderResult(value: unknown, topK: number): ProviderSearchResult {
  const result = objectValue(value, "search result");
  const providerId = nonEmptyString(result.providerId, "providerId");
  if (!Array.isArray(result.candidates)) {
    throw new RetrievalResponseIntegrityError("candidates must be an array");
  }
  if (
    result.candidates.length > topK ||
    result.candidates.length > MAX_VERIFIED_RETRIEVAL_TOP_K
  ) {
    throw new RetrievalResponseIntegrityError(
      "candidate count exceeds the requested topK boundary",
    );
  }
  const candidates = result.candidates.map((candidate, index) =>
    validateCandidate(candidate, providerId, index),
  );
  const latest = result.latestMaterializedCommitSeq;
  if (
    latest !== undefined &&
    (!Number.isSafeInteger(latest) || (latest as number) < 0)
  ) {
    throw new RetrievalResponseIntegrityError(
      "latestMaterializedCommitSeq must be a non-negative safe integer",
    );
  }
  return {
    providerId,
    candidates,
    ...(latest === undefined
      ? {}
      : { latestMaterializedCommitSeq: latest as number }),
  };
}

function validateCandidate(
  value: unknown,
  providerId: string,
  index: number,
): ProviderCandidate {
  const candidate = objectValue(value, `candidates[${index}]`);
  const memoryId = nonEmptyString(
    candidate.memoryId,
    `candidates[${index}].memoryId`,
  );
  if (!/^mem_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(memoryId) || memoryId.length > 132) {
    throw new RetrievalResponseIntegrityError(
      `candidates[${index}].memoryId is not a canonical memory ID`,
    );
  }
  if (
    !Number.isSafeInteger(candidate.canonicalRevision) ||
    (candidate.canonicalRevision as number) < 1
  ) {
    throw new RetrievalResponseIntegrityError(
      `candidates[${index}].canonicalRevision must be a positive safe integer`,
    );
  }
  const candidateProviderId = nonEmptyString(
    candidate.providerId,
    `candidates[${index}].providerId`,
  );
  if (candidateProviderId !== providerId) {
    throw new RetrievalResponseIntegrityError(
      `candidates[${index}].providerId does not match the search result`,
    );
  }
  const providerScore = candidate.providerScore;
  if (providerScore !== undefined && !isFiniteNumber(providerScore)) {
    throw new RetrievalResponseIntegrityError(
      `candidates[${index}].providerScore must be finite when present`,
    );
  }
  const providerObjectId = candidate.providerObjectId;
  const normalizedProviderObjectId =
    providerObjectId === undefined
      ? undefined
      : nonEmptyString(
          providerObjectId,
          `candidates[${index}].providerObjectId`,
        );
  return {
    memoryId: memoryId as MemoryId,
    canonicalRevision: candidate.canonicalRevision as number,
    providerId: candidateProviderId,
    providerRank: index + 1,
    ...(providerScore === undefined
      ? {}
      : { providerScore: providerScore as number }),
    ...(normalizedProviderObjectId === undefined
      ? {}
      : { providerObjectId: normalizedProviderObjectId }),
  };
}

function deduplicate(candidates: readonly ProviderCandidate[]): {
  unique: ProviderCandidate[];
  duplicateCount: number;
} {
  const byMemoryId = new Map<MemoryId, ProviderCandidate>();
  let duplicateCount = 0;
  for (const candidate of candidates) {
    const existing = byMemoryId.get(candidate.memoryId);
    if (existing === undefined) {
      byMemoryId.set(candidate.memoryId, candidate);
      continue;
    }
    if (existing.canonicalRevision !== candidate.canonicalRevision) {
      throw new RetrievalResponseIntegrityError(
        `duplicate ${candidate.memoryId} candidates disagree on canonical revision`,
      );
    }
    duplicateCount += 1;
  }
  return { unique: [...byMemoryId.values()], duplicateCount };
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RetrievalResponseIntegrityError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > 512
  ) {
    throw new RetrievalResponseIntegrityError(
      `${field} must be a trimmed non-empty string of at most 512 characters`,
    );
  }
  return value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function increment(
  counts: Record<string, number>,
  reason: VerificationSuppressionReason,
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}
