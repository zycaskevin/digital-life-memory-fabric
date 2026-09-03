import type {
  MemoryClass,
  MemoryId,
  MemoryRevision,
  MemoryScope,
} from "../domain/types.js";
import type { VerificationSuppressionReason } from "../verification/canonical-verifier.js";

export const DEFAULT_VERIFIED_RETRIEVAL_TOP_K = 20;
export const MAX_VERIFIED_RETRIEVAL_TOP_K = 100;
export const DEFAULT_VERIFIED_RETRIEVAL_TIMEOUT_MS = 10_000;
export const MAX_VERIFIED_RETRIEVAL_TIMEOUT_MS = 60_000;

export interface MemorySearchFilters {
  readonly memoryClass?: readonly MemoryClass[];
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface MemorySearchRequest {
  readonly query: string;
  readonly scope: MemoryScope;
  readonly topK: number;
  readonly filters?: MemorySearchFilters;
}

export interface MemoryFreshnessRequirement {
  readonly requiredCommitSeq: number;
  readonly maxCommitLag: number;
  readonly allowRebuilding?: boolean;
}

export interface MemoryRetrievalPortOptions {
  readonly signal: AbortSignal;
  readonly freshness?: MemoryFreshnessRequirement;
}

/**
 * Provider execution boundary. The returned value is intentionally unknown:
 * provider output is evidence and must be validated before canonical lookup.
 */
export interface MemoryRetrievalPort {
  search(
    request: MemorySearchRequest,
    options: MemoryRetrievalPortOptions,
  ): Promise<unknown>;
}

export interface VerifiedRetrievalInput {
  readonly query: string;
  readonly scope: MemoryScope;
  readonly topK?: number;
  readonly filters?: MemorySearchFilters;
  readonly freshness?: MemoryFreshnessRequirement;
  readonly effectiveAt?: string;
  readonly timeoutMs?: number;
}

export interface ProviderRetrievalEvidence {
  readonly providerId: string;
  readonly claimedCanonicalRevision: number;
  readonly providerRank: number;
  readonly providerScore?: number;
  readonly providerObjectId?: string;
}

export interface VerifiedRetrievalItem {
  readonly memoryId: MemoryId;
  readonly canonicalRevision: number;
  readonly revision: MemoryRevision;
  readonly retrievalEvidence: ProviderRetrievalEvidence;
}

export type RetrievalSuppressionCounts = Partial<
  Readonly<Record<VerificationSuppressionReason | "DUPLICATE", number>>
>;

export interface VerifiedRetrievalResult {
  readonly query: string;
  readonly scope: MemoryScope;
  readonly providerId: string;
  readonly effectiveAt: string;
  readonly items: readonly VerifiedRetrievalItem[];
  readonly latestMaterializedCommitSeq?: number;
  readonly verification: {
    readonly receivedCandidates: number;
    readonly uniqueCandidates: number;
    readonly allowed: number;
    readonly suppressed: number;
    readonly suppressionCounts: RetrievalSuppressionCounts;
  };
}
