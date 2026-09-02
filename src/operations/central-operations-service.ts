import { randomUUID } from "node:crypto";
import {
  OperationsIntegrityError,
  OutboxClaimConflictError,
  ValidationError,
} from "../domain/errors.js";
import type { MemoryRevisionRef, MemoryScope } from "../domain/types.js";
import { SystemClock, type Clock, sameScope } from "../domain/utils.js";
import type { CentralOperationsStore } from "./central-operations-store.js";
import type {
  ClaimOutboxInput,
  DeviceFleetPage,
  MemoryInventoryPage,
  NamespaceOperationsSummary,
  OutboxSettlement,
  OutboxWorkItem,
  ProviderDeliveryOutcome,
  ProviderMaterializationPage,
  ReadDeviceFleetInput,
  ReadMemoryInventoryInput,
  ReadProviderMaterializationsInput,
  SettleOutboxInput,
} from "./types.js";

export const DEFAULT_OPERATIONS_PAGE_SIZE = 50;
export const MAX_OPERATIONS_PAGE_SIZE = 200;
export const MAX_OUTBOX_CLAIM_SIZE = 100;
export const MIN_OUTBOX_LEASE_MS = 1_000;
export const MAX_OUTBOX_LEASE_MS = 300_000;

export interface ClaimTokenFactory {
  create(): string;
}

class RandomClaimTokenFactory implements ClaimTokenFactory {
  create(): string {
    return randomUUID();
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} must not be empty`);
  }
}

function validateScope(scope: MemoryScope): void {
  requireNonEmpty(scope.tenantId, "scope.tenantId");
  requireNonEmpty(scope.lifeDid, "scope.lifeDid");
  requireNonEmpty(scope.memoryNamespace, "scope.memoryNamespace");
}

function pageSize(limit: number | undefined, maximum = MAX_OPERATIONS_PAGE_SIZE): number {
  const value = limit ?? DEFAULT_OPERATIONS_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ValidationError(`limit must be a safe integer between 1 and ${maximum}`);
  }
  return value;
}

function requireTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${field} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

function validateOutcomes(outcomes: readonly ProviderDeliveryOutcome[]): void {
  if (outcomes.length === 0) {
    throw new ValidationError("outcomes must contain at least one provider result");
  }
  const providers = new Set<string>();
  for (const outcome of outcomes) {
    requireNonEmpty(outcome.providerName, "outcomes.providerName");
    if (providers.has(outcome.providerName)) {
      throw new ValidationError(`Duplicate provider outcome: ${outcome.providerName}`);
    }
    providers.add(outcome.providerName);
    if (outcome.status !== "CURRENT") {
      requireNonEmpty(outcome.lastError ?? "", "outcomes.lastError");
    }
  }
}

export class CentralOperationsService {
  constructor(
    private readonly store: CentralOperationsStore,
    private readonly clock: Clock = new SystemClock(),
    private readonly claimTokens: ClaimTokenFactory = new RandomClaimTokenFactory(),
  ) {}

  async readMemoryInventory(
    input: ReadMemoryInventoryInput,
  ): Promise<MemoryInventoryPage> {
    validateScope(input.scope);
    if (!Number.isSafeInteger(input.afterCommitSeq) || input.afterCommitSeq < 0) {
      throw new ValidationError("afterCommitSeq must be a non-negative safe integer");
    }
    const limit = pageSize(input.limit);
    const fetched = await this.store.listCurrentHeadsAfter(
      input.scope,
      input.afterCommitSeq,
      limit + 1,
    );
    const hasMore = fetched.length > limit;
    const selected = fetched.slice(0, limit);
    const references: MemoryRevisionRef[] = selected.map(({ head }) => ({
      memoryId: head.memoryId,
      revision: head.currentRevision,
    }));
    const revisions = await this.store.getRevisions(references);
    const entries = selected.map(({ head, commitSeq }, index) => {
      const revision = revisions[index];
      if (
        revision === undefined ||
        revision.revision !== head.currentRevision ||
        revision.commitSeq !== commitSeq ||
        !sameScope(revision.scope, input.scope)
      ) {
        throw new OperationsIntegrityError(
          `Current head ${head.memoryId} at commit_seq ${commitSeq} does not resolve to its scoped immutable revision`,
        );
      }
      return { head, revision };
    });
    return {
      scope: input.scope,
      afterCommitSeq: input.afterCommitSeq,
      nextCommitSeq:
        selected.at(-1)?.commitSeq ?? input.afterCommitSeq,
      entries,
      hasMore,
    };
  }

  async readDeviceFleet(input: ReadDeviceFleetInput): Promise<DeviceFleetPage> {
    validateScope(input.scope);
    if (input.afterDeviceId !== undefined) {
      requireNonEmpty(input.afterDeviceId, "afterDeviceId");
    }
    const limit = pageSize(input.limit);
    const [highWatermark, fetched] = await Promise.all([
      this.store.getScopeHighWatermark(input.scope),
      this.store.listDeviceCheckpointsAfter(
        input.scope,
        input.afterDeviceId,
        limit + 1,
      ),
    ]);
    const hasMore = fetched.length > limit;
    const selected = fetched.slice(0, limit);
    const lastDevice = selected.at(-1);
    return {
      scope: input.scope,
      ...(input.afterDeviceId === undefined
        ? {}
        : { afterDeviceId: input.afterDeviceId }),
      ...(lastDevice === undefined ? {} : { nextDeviceId: lastDevice.deviceId }),
      devices: selected.map((checkpoint) => ({
        checkpoint,
        highWatermark,
        lag: Math.max(0, highWatermark - checkpoint.lastAppliedCommitSeq),
      })),
      hasMore,
    };
  }

  async readProviderMaterializations(
    input: ReadProviderMaterializationsInput,
  ): Promise<ProviderMaterializationPage> {
    validateScope(input.scope);
    if (input.after !== undefined) {
      requireNonEmpty(input.after.providerName, "after.providerName");
      requireNonEmpty(input.after.memoryId, "after.memoryId");
    }
    const limit = pageSize(input.limit);
    const fetched = await this.store.listProviderMaterializationsAfter(
      input.scope,
      input.after,
      limit + 1,
    );
    const hasMore = fetched.length > limit;
    const materializations = fetched.slice(0, limit);
    const last = materializations.at(-1);
    return {
      scope: input.scope,
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(last === undefined
        ? {}
        : { next: { providerName: last.providerName, memoryId: last.memoryId } }),
      materializations,
      hasMore,
    };
  }

  async getNamespaceSummary(scope: MemoryScope): Promise<NamespaceOperationsSummary> {
    validateScope(scope);
    return this.store.getNamespaceOperationsSummary(scope);
  }

  async claimOutbox(input: ClaimOutboxInput): Promise<OutboxWorkItem[]> {
    validateScope(input.scope);
    requireNonEmpty(input.workerId, "workerId");
    if (
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < MIN_OUTBOX_LEASE_MS ||
      input.leaseMs > MAX_OUTBOX_LEASE_MS
    ) {
      throw new ValidationError(
        `leaseMs must be a safe integer between ${MIN_OUTBOX_LEASE_MS} and ${MAX_OUTBOX_LEASE_MS}`,
      );
    }
    const limit = pageSize(input.limit, MAX_OUTBOX_CLAIM_SIZE);
    const claimedAt = this.clock.now();
    const claimedAtMs = requireTimestamp(claimedAt, "clock.now()");
    const leaseExpiresAt = new Date(claimedAtMs + input.leaseMs).toISOString();
    const records = await this.store.claimOutboxBatch(
      input.scope,
      input.workerId,
      this.claimTokens.create(),
      claimedAt,
      leaseExpiresAt,
      limit,
    );
    const revisions = await this.store.getRevisions(
      records.map((record) => ({
        memoryId: record.memoryId,
        revision: record.revision,
      })),
    );
    return records.map((record, index) => {
      const revision = revisions[index];
      if (
        revision === undefined ||
        revision.revision !== record.revision ||
        revision.commitSeq !== record.commitSeq ||
        !sameScope(revision.scope, record.scope)
      ) {
        throw new OperationsIntegrityError(
          `Claimed outbox ${record.outboxId} does not resolve to its canonical revision`,
        );
      }
      return { record, revision };
    });
  }

  async settleOutbox(input: SettleOutboxInput): Promise<OutboxSettlement> {
    validateScope(input.scope);
    requireNonEmpty(input.workerId, "workerId");
    requireNonEmpty(input.claimToken, "claimToken");
    validateOutcomes(input.outcomes);
    const settledAt = this.clock.now();
    const settledAtMs = requireTimestamp(settledAt, "clock.now()");
    const hasFailure = input.outcomes.some((outcome) => outcome.status !== "CURRENT");
    if (hasFailure) {
      if (input.nextAttemptAt === undefined) {
        throw new ValidationError("nextAttemptAt is required for a failed settlement");
      }
      const retryAtMs = requireTimestamp(input.nextAttemptAt, "nextAttemptAt");
      if (retryAtMs <= settledAtMs) {
        throw new ValidationError("nextAttemptAt must be later than the settlement time");
      }
    } else if (input.nextAttemptAt !== undefined) {
      throw new ValidationError("nextAttemptAt is not allowed for a successful settlement");
    }

    const settled = await this.store.settleOutboxClaim({
      scope: input.scope,
      outboxId: input.outboxId,
      workerId: input.workerId,
      claimToken: input.claimToken,
      settledAt,
      outcomes: input.outcomes,
      ...(input.nextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: input.nextAttemptAt }),
    });
    if (settled === undefined) {
      throw new OutboxClaimConflictError(input.outboxId);
    }
    return settled;
  }
}
