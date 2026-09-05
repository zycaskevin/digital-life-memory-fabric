import { createHash } from "node:crypto";
import { ValidationError } from "../domain/errors.js";
import type { MemoryRevision, MemoryScope } from "../domain/types.js";
import { sameScope } from "../domain/utils.js";
import type {
  HindsightBudget,
  HindsightClientPort,
  HindsightPlaneResolver,
} from "../distillation/hindsight-memory-adapter.js";
import type {
  MemoryRetrievalPort,
  MemoryRetrievalPortOptions,
  MemorySearchRequest,
} from "./types.js";

export interface HindsightCanonicalProjectionOptions {
  client: HindsightClientPort;
  banks: HindsightPlaneResolver;
  providerId?: string;
  recallBudget?: HindsightBudget;
}

/**
 * Provider projection boundary for canonical DLMF memory.
 *
 * Hindsight is only a search accelerator here. Projection records contain the
 * provider-independent memory ID + canonical revision in metadata. Search
 * discards provider text entirely and returns only candidate identifiers for
 * VerifiedRetrievalService to hydrate from Canonical Memory.
 */
export class HindsightCanonicalProjectionPort implements MemoryRetrievalPort {
  readonly #providerId: string;
  readonly #client: HindsightClientPort;
  readonly #banks: HindsightPlaneResolver;
  readonly #recallBudget: HindsightBudget;

  constructor(options: HindsightCanonicalProjectionOptions) {
    this.#providerId = requiredText(options.providerId ?? "hindsight", "providerId");
    this.#client = options.client;
    this.#banks = options.banks;
    this.#recallBudget = options.recallBudget ?? "mid";
  }

  async project(revision: Readonly<MemoryRevision>): Promise<void> {
    const bank = projectionBank(this.#banks, revision.scope);
    const response = await this.#client.retain(
      bank,
      revision.canonicalContent.text,
      {
        timestamp: revision.observedAt ?? revision.committedAt,
        context: "DLMF canonical memory projection; canonical content remains authoritative in DLMF",
        documentId: `dlmf-canonical:${revision.memoryId}:r${revision.revision}`,
        tags: ["dlmf", "canonical_projection"],
        async: false,
        metadata: {
          dlmf_plane: "canonical_projection",
          dlmf_memory_id: revision.memoryId,
          dlmf_revision: String(revision.revision),
          dlmf_commit_seq: String(revision.commitSeq),
          dlmf_memory_class: revision.memoryClass,
          dlmf_memory_kind: revision.memoryKind,
          dlmf_epistemic_status: revision.epistemicStatus,
        },
      },
    );
    if (
      response.success !== true
      || response.async !== false
      || response.bank_id !== bank
      || !Number.isSafeInteger(response.items_count)
      || response.items_count < 1
    ) {
      throw new Error("hindsight_canonical_projection_not_materialized");
    }
  }

  async search(
    request: MemorySearchRequest,
    options: MemoryRetrievalPortOptions,
  ): Promise<unknown> {
    if (options.signal.aborted) throw new Error("hindsight_canonical_projection_aborted");
    const bank = projectionBank(this.#banks, request.scope);
    const response = await this.#client.recall(bank, request.query, {
      budget: this.#recallBudget,
      trace: false,
      queryTimestamp: new Date().toISOString(),
    });
    if (options.signal.aborted) throw new Error("hindsight_canonical_projection_aborted");

    const candidates = response.results.flatMap((result) => {
      const metadata = result.metadata;
      const memoryId = metadata?.dlmf_memory_id;
      const revisionRaw = metadata?.dlmf_revision;
      if (memoryId === undefined || revisionRaw === undefined) return [];
      if (!/^mem_[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(memoryId) || memoryId.length > 132) {
        return [];
      }
      const canonicalRevision = Number(revisionRaw);
      if (!Number.isSafeInteger(canonicalRevision) || canonicalRevision < 1) return [];
      return [{
        memoryId,
        canonicalRevision,
        providerId: this.#providerId,
        providerObjectId: result.id,
      }];
    }).slice(0, request.topK);

    return {
      providerId: this.#providerId,
      candidates,
    };
  }
}

export class DeterministicHindsightPlaneResolver implements HindsightPlaneResolver {
  constructor(private readonly prefix = "dlmf") {
    requiredText(prefix, "prefix");
  }

  distillationBankId(scope: MemoryScope): string {
    return `${this.prefix}-distill-${scopeDigest(scope)}`;
  }

  projectionBankId(scope: MemoryScope): string {
    return `${this.prefix}-canonical-${scopeDigest(scope)}`;
  }
}

export function assertSameProjectionScope(
  expected: MemoryScope,
  revision: MemoryRevision,
): void {
  if (!sameScope(expected, revision.scope)) {
    throw new ValidationError("canonical projection scope mismatch");
  }
}

function projectionBank(resolver: HindsightPlaneResolver, scope: MemoryScope): string {
  validateScope(scope);
  const distillation = requiredText(resolver.distillationBankId(scope), "distillationBankId");
  const projection = requiredText(resolver.projectionBankId(scope), "projectionBankId");
  if (distillation === projection) {
    throw new ValidationError("Hindsight distillation and projection banks must differ");
  }
  return projection;
}

function validateScope(scope: MemoryScope): void {
  requiredText(scope.tenantId, "scope.tenantId");
  requiredText(scope.lifeDid, "scope.lifeDid");
  requiredText(scope.memoryNamespace, "scope.memoryNamespace");
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) {
    throw new ValidationError(`${field} must be a non-empty string of at most 512 characters`);
  }
  return normalized;
}

function scopeDigest(scope: MemoryScope): string {
  validateScope(scope);
  const input = `${scope.tenantId}\u001f${scope.lifeDid}\u001f${scope.memoryNamespace}`;
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}
