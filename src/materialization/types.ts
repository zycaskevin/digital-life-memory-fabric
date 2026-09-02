import type {
  EventId,
  MemoryId,
  MemoryOperation,
  OutboxId,
} from "../domain/types.js";
import type {
  ClaimOutboxInput,
  OutboxSettlement,
} from "../operations/types.js";

export const MEMORY_FABRIC_MATERIALIZATION_EVENT =
  "memory.materialization.requested" as const;
export const MEMORY_FABRIC_MATERIALIZATION_EVENT_VERSION = "1" as const;

export type MaterializationIntent = "UPSERT" | "DELETE";

export interface MemoryFabricMaterializationEvent {
  readonly event_type: typeof MEMORY_FABRIC_MATERIALIZATION_EVENT;
  readonly event_version: typeof MEMORY_FABRIC_MATERIALIZATION_EVENT_VERSION;
  readonly outbox_id: OutboxId;
  readonly event_id: EventId;
  readonly request_id: string;
  readonly trace_id?: string;
  readonly occurred_at: string;
  readonly intent: MaterializationIntent;
  readonly tenant_id: string;
  readonly life_did: string;
  readonly memory_namespace: string;
  readonly memory_id: MemoryId;
  readonly canonical_revision: number;
  readonly commit_seq: number;
  readonly operation: MemoryOperation;
  readonly idempotency_key: string;
  readonly canonical_content?: {
    readonly text: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  };
  readonly metadata: {
    readonly canonical_authority: "digital-life-memory-fabric";
    readonly provider_selection_owned_by: "omniharness";
  };
}

export type MemoryFabricExecutionErrorCode =
  | "INVALID_EVENT"
  | "NO_ELIGIBLE_PROVIDER"
  | "PROVIDER_EXECUTION_FAILED";

export interface MemoryFabricProviderReceipt {
  readonly providerId: string;
  readonly memoryId: string;
  readonly canonicalRevision?: number;
  readonly status: string;
  readonly providerObjectId?: string;
  readonly executionId?: string;
  readonly traceId?: string;
}

export interface MemoryFabricExecutionReceipt {
  readonly event_type: typeof MEMORY_FABRIC_MATERIALIZATION_EVENT;
  readonly event_version: typeof MEMORY_FABRIC_MATERIALIZATION_EVENT_VERSION;
  readonly outbox_id: OutboxId;
  readonly request_id: string;
  readonly trace_id?: string;
  readonly memory_id: MemoryId;
  readonly canonical_revision: number;
  readonly commit_seq: number;
  readonly provider_id?: string;
  readonly status:
    | "SUCCESS"
    | "ALREADY_CURRENT"
    | "NOT_FOUND"
    | "RETRYABLE_FAILURE";
  readonly retryable: boolean;
  readonly canonical_commit_affected: false;
  readonly provider_receipt?: MemoryFabricProviderReceipt;
  readonly error?: {
    readonly code: MemoryFabricExecutionErrorCode;
    readonly message: string;
  };
}

export interface MaterializationDeliveryOptions {
  readonly signal: AbortSignal;
}

export interface MemoryMaterializationDeliveryPort {
  execute(
    event: MemoryFabricMaterializationEvent,
    options?: MaterializationDeliveryOptions,
  ): Promise<unknown>;
}

export interface RunMaterializationWorkerInput extends ClaimOutboxInput {
  retryDelayMs?: number;
  deliveryTimeoutMs?: number;
}

export interface MaterializationWorkerItemResult {
  event: MemoryFabricMaterializationEvent;
  receipt?: MemoryFabricExecutionReceipt;
  deliveryError?: string;
  settlement: OutboxSettlement;
}

export interface MaterializationWorkerRunResult {
  claimed: number;
  items: MaterializationWorkerItemResult[];
}
