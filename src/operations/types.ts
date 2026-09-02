import type {
  CanonicalMemoryHead,
  DeviceCheckpoint,
  MemoryOutboxRecord,
  MemoryRevision,
  MemoryScope,
  OutboxId,
  ProviderMaterialization,
} from "../domain/types.js";

export interface MemoryInventoryEntry {
  head: CanonicalMemoryHead;
  revision: MemoryRevision;
}

export interface MemoryInventoryPage {
  scope: MemoryScope;
  afterCommitSeq: number;
  nextCommitSeq: number;
  entries: MemoryInventoryEntry[];
  hasMore: boolean;
}

export interface DeviceOperationalState {
  checkpoint: DeviceCheckpoint;
  highWatermark: number;
  lag: number;
}

export interface DeviceFleetPage {
  scope: MemoryScope;
  afterDeviceId?: string;
  nextDeviceId?: string;
  devices: DeviceOperationalState[];
  hasMore: boolean;
}

export interface ProviderMaterializationCursor {
  providerName: string;
  memoryId: string;
}

export interface ProviderMaterializationPage {
  scope: MemoryScope;
  after?: ProviderMaterializationCursor;
  next?: ProviderMaterializationCursor;
  materializations: ProviderMaterialization[];
  hasMore: boolean;
}

export interface OperationsStatusCounts {
  pending: number;
  processing: number;
  done: number;
  failed: number;
}

export interface MaterializationStatusCounts {
  current: number;
  lagging: number;
  failed: number;
  unavailable: number;
  rebuilding: number;
}

export interface NamespaceOperationsSummary {
  scope: MemoryScope;
  highWatermark: number;
  memories: {
    total: number;
    active: number;
    tombstoned: number;
    superseded: number;
  };
  outbox: OperationsStatusCounts;
  devices: {
    total: number;
    maxLag: number;
  };
  materializations: MaterializationStatusCounts;
}

export interface ClaimedOutboxRecord extends MemoryOutboxRecord {
  status: "PROCESSING";
  claimedBy: string;
  claimToken: string;
  leaseExpiresAt: string;
  updatedAt: string;
}

export interface OutboxWorkItem {
  record: ClaimedOutboxRecord;
  revision: MemoryRevision;
}

export interface ProviderDeliveryOutcome {
  providerName: string;
  status: "CURRENT" | "FAILED" | "UNAVAILABLE";
  providerId?: string;
  lastError?: string;
}

export interface ReadMemoryInventoryInput {
  scope: MemoryScope;
  afterCommitSeq: number;
  limit?: number;
}

export interface ReadDeviceFleetInput {
  scope: MemoryScope;
  afterDeviceId?: string;
  limit?: number;
}

export interface ReadProviderMaterializationsInput {
  scope: MemoryScope;
  after?: ProviderMaterializationCursor;
  limit?: number;
}

export interface ClaimOutboxInput {
  scope: MemoryScope;
  workerId: string;
  leaseMs: number;
  limit?: number;
}

export interface SettleOutboxInput {
  scope: MemoryScope;
  outboxId: OutboxId;
  workerId: string;
  claimToken: string;
  outcomes: ProviderDeliveryOutcome[];
  nextAttemptAt?: string;
}

export interface OutboxSettlement {
  record: MemoryOutboxRecord;
  materializations: ProviderMaterialization[];
}
