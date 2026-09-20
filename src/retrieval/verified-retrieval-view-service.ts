import { RetrievalResponseIntegrityError, ValidationError } from "../domain/errors.js";
import type { MemoryRevision, MemoryScope } from "../domain/types.js";
import { sameScope, SystemClock, type Clock } from "../domain/utils.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";
import { CanonicalVerifier } from "../verification/canonical-verifier.js";
import {
  DEFAULT_VERIFIED_RETRIEVAL_TOP_K,
  type RetrievalSuppressionCounts,
  type VerifiedRetrievalInput,
  type VerifiedRetrievalItem,
  type VerifiedRetrievalReader,
  type VerifiedRetrievalResult,
} from "./types.js";

export interface VerifiedRetrievalViewMount {
  readonly mountId: string;
  readonly scope: MemoryScope;
  readonly retrieval: VerifiedRetrievalReader;
  readonly mode: "read_only_historical";
}

export interface VerifiedRetrievalViewOptions {
  readonly viewId: string;
  readonly publicScope: MemoryScope;
  readonly primaryRetrieval: VerifiedRetrievalReader;
  readonly primaryStore: Pick<CanonicalMemoryStore, "findCurrentRevisionBySemanticKey" | "getHeads" | "getRevisions">;
  readonly historicalMounts: readonly VerifiedRetrievalViewMount[];
  readonly clock?: Clock;
}

/**
 * DLMF-owned read federation for one Digital Life.
 *
 * Every mounted source is independently VerifiedRetrievalService-backed before it
 * reaches this layer. The view never rewrites a mounted MemoryScope and never treats
 * Hindsight/provider text as canonical. A writable primary scope may shadow a mounted
 * historical semantic key so preference changes/forgets in the living Digital Life
 * take precedence over immutable historical truth.
 */
export class VerifiedRetrievalViewService implements VerifiedRetrievalReader {
  readonly #viewId: string;
  readonly #publicScope: MemoryScope;
  readonly #primaryRetrieval: VerifiedRetrievalReader;
  readonly #primaryStore: VerifiedRetrievalViewOptions["primaryStore"];
  readonly #primaryVerifier: CanonicalVerifier;
  readonly #mounts: readonly VerifiedRetrievalViewMount[];
  readonly #clock: Clock;

  constructor(options: VerifiedRetrievalViewOptions) {
    this.#viewId = requiredId(options.viewId, "viewId");
    this.#publicScope = checkedScope(options.publicScope, "publicScope");
    this.#primaryRetrieval = options.primaryRetrieval;
    this.#primaryStore = options.primaryStore;
    this.#clock = options.clock ?? new SystemClock();
    this.#primaryVerifier = new CanonicalVerifier(
      this.#primaryStore,
      this.#clock,
    );
    const ids = new Set<string>();
    const scopes = new Set<string>();
    this.#mounts = options.historicalMounts.map((mount, index) => {
      const mountId = requiredId(mount.mountId, `historicalMounts[${index}].mountId`);
      if (ids.has(mountId)) throw new ValidationError("memory view mountId must be unique");
      ids.add(mountId);
      const scope = checkedScope(mount.scope, `historicalMounts[${index}].scope`);
      if (scope.lifeDid !== this.#publicScope.lifeDid) {
        throw new ValidationError("memory view mounts must belong to the same lifeDid");
      }
      if (sameScope(scope, this.#publicScope)) {
        throw new ValidationError("historical mount must not duplicate the primary scope");
      }
      const key = scopeKey(scope);
      if (scopes.has(key)) throw new ValidationError("memory view mount scope must be unique");
      scopes.add(key);
      if (mount.mode !== "read_only_historical") {
        throw new ValidationError("memory view historical mounts must be read_only_historical");
      }
      return { ...mount, mountId, scope };
    });
  }

  async retrieve(input: VerifiedRetrievalInput): Promise<VerifiedRetrievalResult> {
    if (!sameScope(input.scope, this.#publicScope)) {
      throw new ValidationError("memory view request scope does not match publicScope");
    }
    const effectiveAt = input.effectiveAt ?? this.#clock.now();
    const topK = input.topK ?? DEFAULT_VERIFIED_RETRIEVAL_TOP_K;
    const primary = await this.#primaryRetrieval.retrieve({
      ...input,
      scope: this.#publicScope,
      effectiveAt,
    });
    assertResultScope(primary, this.#publicScope, "primary");

    const { freshness: _primaryFreshness, ...mountInput } = input;
    const mounted = await Promise.all(this.#mounts.map(async (mount) => {
      const result = await mount.retrieval.retrieve({
        ...mountInput,
        scope: mount.scope,
        effectiveAt,
        // Commit sequences are scope-local; a primary freshness watermark must
        // never be misapplied to an immutable historical mount.
      });
      assertResultScope(result, mount.scope, mount.mountId);
      return { mount, result };
    }));

    const output: VerifiedRetrievalItem[] = [];
    const seenMemoryIds = new Set<string>();
    const suppressionCounts: Record<string, number> = {};
    let receivedCandidates = primary.verification.receivedCandidates;
    let uniqueCandidates = primary.verification.uniqueCandidates;
    let suppressed = primary.verification.suppressed;
    mergeCounts(suppressionCounts, primary.verification.suppressionCounts);

    for (const item of primary.items) {
      assertItemScope(item, this.#publicScope, "primary");
      if (seenMemoryIds.has(item.memoryId)) {
        increment(suppressionCounts, "VIEW_DUPLICATE");
        suppressed += 1;
        continue;
      }
      seenMemoryIds.add(item.memoryId);
      output.push(item);
    }

    const primaryBySemanticKey = new Map<string, MemoryRevision>();
    for (const item of primary.items) {
      primaryBySemanticKey.set(item.revision.semanticKey, item.revision);
    }
    const semanticLookup = new Map<string, MemoryRevision | null>();
    let primaryOverrides = 0;
    let primarySuppressions = 0;
    let mountedAllowed = 0;

    for (const { mount, result } of mounted) {
      receivedCandidates += result.verification.receivedCandidates;
      uniqueCandidates += result.verification.uniqueCandidates;
      suppressed += result.verification.suppressed;
      mergeCounts(suppressionCounts, result.verification.suppressionCounts);

      for (const historical of result.items) {
        assertItemScope(historical, mount.scope, mount.mountId);
        const semanticKey = historical.revision.semanticKey;
        let primaryRevision = primaryBySemanticKey.get(semanticKey);
        if (primaryRevision === undefined) {
          if (!semanticLookup.has(semanticKey)) {
            semanticLookup.set(
              semanticKey,
              (await this.#primaryStore.findCurrentRevisionBySemanticKey(
                this.#publicScope,
                semanticKey,
              )) ?? null,
            );
          }
          primaryRevision = semanticLookup.get(semanticKey) ?? undefined;
        }

        if (primaryRevision !== undefined) {
          const decision = await this.#primaryVerifier.verify(
            primaryRevision.memoryId,
            this.#publicScope,
            {
              expectedRevision: primaryRevision.revision,
              effectiveAt,
            },
          );
          if (decision.decision === "SUPPRESS") {
            increment(suppressionCounts, "VIEW_PRIMARY_SUPPRESSION");
            suppressed += 1;
            primarySuppressions += 1;
            continue;
          }
          primaryOverrides += 1;
          if (seenMemoryIds.has(decision.revision.memoryId)) {
            increment(suppressionCounts, "VIEW_PRIMARY_OVERRIDE");
            suppressed += 1;
            continue;
          }
          seenMemoryIds.add(decision.revision.memoryId);
          output.push({
            memoryId: decision.revision.memoryId,
            canonicalRevision: decision.revision.revision,
            revision: decision.revision,
            retrievalEvidence: {
              providerId: `dlmf-memory-view:${this.#viewId}`,
              claimedCanonicalRevision: decision.revision.revision,
              providerRank: historical.retrievalEvidence.providerRank,
              ...(historical.retrievalEvidence.providerScore === undefined
                ? {}
                : { providerScore: historical.retrievalEvidence.providerScore }),
              providerObjectId: `shadow:${mount.mountId}:${historical.memoryId}`,
            },
          });
          continue;
        }

        if (seenMemoryIds.has(historical.memoryId)) {
          increment(suppressionCounts, "VIEW_DUPLICATE");
          suppressed += 1;
          continue;
        }
        seenMemoryIds.add(historical.memoryId);
        output.push(historical);
        mountedAllowed += 1;
      }
    }

    const items = output.slice(0, topK);
    if (output.length > items.length) {
      const truncated = output.length - items.length;
      increment(suppressionCounts, "VIEW_TOP_K", truncated);
      suppressed += truncated;
    }

    return {
      query: primary.query,
      scope: { ...this.#publicScope },
      providerId: `dlmf-memory-view:${this.#viewId}`,
      effectiveAt,
      items,
      verification: {
        receivedCandidates,
        uniqueCandidates,
        allowed: items.length,
        suppressed,
        suppressionCounts: suppressionCounts as RetrievalSuppressionCounts,
      },
      view: {
        viewId: this.#viewId,
        mountCount: this.#mounts.length,
        primaryOverrides,
        primarySuppressions,
        mountedAllowed,
      },
    };
  }
}

function checkedScope(scope: MemoryScope, label: string): MemoryScope {
  for (const [name, value] of Object.entries(scope)) {
    if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
      throw new ValidationError(`${label}.${name} invalid`);
    }
  }
  return { ...scope };
}

function requiredId(value: string, label: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new ValidationError(`${label} invalid`);
  }
  return value;
}

function assertResultScope(result: VerifiedRetrievalResult, scope: MemoryScope, label: string): void {
  if (!sameScope(result.scope, scope)) {
    throw new RetrievalResponseIntegrityError(`memory view ${label} returned the wrong scope`);
  }
}

function assertItemScope(item: VerifiedRetrievalItem, scope: MemoryScope, label: string): void {
  if (!sameScope(item.revision.scope, scope)) {
    throw new RetrievalResponseIntegrityError(`memory view ${label} item escaped its canonical scope`);
  }
}

function scopeKey(scope: MemoryScope): string {
  return `${scope.tenantId}\u001f${scope.lifeDid}\u001f${scope.memoryNamespace}`;
}

function increment(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

function mergeCounts(
  target: Record<string, number>,
  source: RetrievalSuppressionCounts,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) increment(target, key, value);
  }
}
