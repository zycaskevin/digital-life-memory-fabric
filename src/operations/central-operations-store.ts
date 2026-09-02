import type {
  CanonicalMemoryHead,
  DeviceCheckpoint,
  MemoryChangeEnvelope,
  MemoryOutboxRecord,
  MemoryScope,
  OutboxId,
  ProviderMaterialization,
} from "../domain/types.js";
import type { CanonicalMemoryStore } from "../store/canonical-memory-store.js";
import type {
  ClaimedOutboxRecord,
  NamespaceOperationsSummary,
  ProviderDeliveryOutcome,
  ProviderMaterializationCursor,
} from "./types.js";

export interface CurrentHeadCursorRecord {
  head: CanonicalMemoryHead;
  commitSeq: number;
}

export interface SettleClaimRequest {
  scope: MemoryScope;
  outboxId: OutboxId;
  workerId: string;
  claimToken: string;
  settledAt: string;
  outcomes: ProviderDeliveryOutcome[];
  lastError?: string;
  nextAttemptAt?: string;
}

export interface SettledClaim {
  record: MemoryOutboxRecord;
  materializations: ProviderMaterialization[];
}

export interface CentralOperationsStore extends CanonicalMemoryStore {
  getChangesByCommitSeqs(
    scope: MemoryScope,
    commitSeqs: readonly number[],
  ): Promise<Array<MemoryChangeEnvelope | undefined>>;
  listCurrentHeadsAfter(
    scope: MemoryScope,
    afterCommitSeq: number,
    limit: number,
  ): Promise<CurrentHeadCursorRecord[]>;
  getScopeHighWatermark(scope: MemoryScope): Promise<number>;
  listDeviceCheckpointsAfter(
    scope: MemoryScope,
    afterDeviceId: string | undefined,
    limit: number,
  ): Promise<DeviceCheckpoint[]>;
  listProviderMaterializationsAfter(
    scope: MemoryScope,
    after: ProviderMaterializationCursor | undefined,
    limit: number,
  ): Promise<ProviderMaterialization[]>;
  getNamespaceOperationsSummary(
    scope: MemoryScope,
  ): Promise<NamespaceOperationsSummary>;
  claimOutboxBatch(
    scope: MemoryScope,
    workerId: string,
    claimToken: string,
    claimedAt: string,
    leaseExpiresAt: string,
    limit: number,
  ): Promise<ClaimedOutboxRecord[]>;
  settleOutboxClaim(request: SettleClaimRequest): Promise<SettledClaim | undefined>;
}
