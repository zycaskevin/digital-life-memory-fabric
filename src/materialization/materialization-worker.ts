import {
  MaterializationReceiptIntegrityError,
  ValidationError,
} from "../domain/errors.js";
import type { OutboxId } from "../domain/types.js";
import { SystemClock, type Clock } from "../domain/utils.js";
import { CentralOperationsService } from "../operations/central-operations-service.js";
import type {
  OutboxSettlement,
  OutboxWorkItem,
  ProviderDeliveryOutcome,
} from "../operations/types.js";
import {
  MEMORY_FABRIC_MATERIALIZATION_EVENT,
  MEMORY_FABRIC_MATERIALIZATION_EVENT_VERSION,
  type MaterializationWorkerItemResult,
  type MaterializationWorkerRunResult,
  type MemoryFabricExecutionErrorCode,
  type MemoryFabricExecutionReceipt,
  type MemoryFabricMaterializationEvent,
  type MemoryMaterializationDeliveryPort,
  type RunMaterializationWorkerInput,
} from "./types.js";

export const DEFAULT_MATERIALIZATION_RETRY_DELAY_MS = 30_000;
export const MAX_MATERIALIZATION_RETRY_DELAY_MS = 86_400_000;
export const MAX_MATERIALIZATION_ERROR_LENGTH = 1_000;

export function toMemoryFabricMaterializationEvent(
  work: OutboxWorkItem,
): MemoryFabricMaterializationEvent {
  const intent = work.record.operation === "tombstone" ? "DELETE" : "UPSERT";
  return {
    event_type: MEMORY_FABRIC_MATERIALIZATION_EVENT,
    event_version: MEMORY_FABRIC_MATERIALIZATION_EVENT_VERSION,
    outbox_id: work.record.outboxId,
    event_id: work.change.eventId,
    request_id: `ohmat:${work.record.outboxId}`,
    occurred_at: work.change.committedAt,
    intent,
    tenant_id: work.record.scope.tenantId,
    life_did: work.record.scope.lifeDid,
    memory_namespace: work.record.scope.memoryNamespace,
    memory_id: work.record.memoryId,
    canonical_revision: work.record.revision,
    commit_seq: work.record.commitSeq,
    operation: work.record.operation,
    idempotency_key:
      `memory.materialization:${work.record.memoryId}:${work.record.revision}`,
    ...(intent === "DELETE"
      ? {}
      : {
          canonical_content: {
            text: work.revision.canonicalContent.text,
            ...(work.revision.canonicalContent.payload === undefined
              ? {}
              : { payload: work.revision.canonicalContent.payload }),
          },
        }),
    metadata: {
      canonical_authority: "digital-life-memory-fabric",
      provider_selection_owned_by: "omniharness",
    },
  };
}

export class MaterializationWorker {
  constructor(
    private readonly operations: CentralOperationsService,
    private readonly delivery: MemoryMaterializationDeliveryPort,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async runOnce(
    input: RunMaterializationWorkerInput,
  ): Promise<MaterializationWorkerRunResult> {
    const retryDelayMs = input.retryDelayMs ?? DEFAULT_MATERIALIZATION_RETRY_DELAY_MS;
    if (
      !Number.isSafeInteger(retryDelayMs) ||
      retryDelayMs < 1_000 ||
      retryDelayMs > MAX_MATERIALIZATION_RETRY_DELAY_MS
    ) {
      throw new ValidationError(
        `retryDelayMs must be a safe integer between 1000 and ${MAX_MATERIALIZATION_RETRY_DELAY_MS}`,
      );
    }
    const deliveryTimeoutMs =
      input.deliveryTimeoutMs ?? Math.min(30_000, input.leaseMs - 100);
    if (
      !Number.isSafeInteger(deliveryTimeoutMs) ||
      deliveryTimeoutMs < 100 ||
      deliveryTimeoutMs >= input.leaseMs
    ) {
      throw new ValidationError(
        "deliveryTimeoutMs must be a safe integer of at least 100 and shorter than leaseMs",
      );
    }

    const work = await this.operations.claimOutbox({
      scope: input.scope,
      workerId: input.workerId,
      leaseMs: input.leaseMs,
      limit: input.limit ?? 1,
    });
    const items: MaterializationWorkerItemResult[] = [];
    for (const item of work) {
      items.push(
        await this.process(item, deliveryTimeoutMs, retryDelayMs),
      );
    }
    return { claimed: work.length, items };
  }

  private async process(
    work: OutboxWorkItem,
    deliveryTimeoutMs: number,
    retryDelayMs: number,
  ): Promise<MaterializationWorkerItemResult> {
    const event = toMemoryFabricMaterializationEvent(work);
    let receipt: MemoryFabricExecutionReceipt;
    try {
      const rawReceipt = await executeWithTimeout(
        this.delivery,
        event,
        deliveryTimeoutMs,
      );
      receipt = validateExecutionReceipt(rawReceipt, event);
    } catch (error) {
      const deliveryError = boundedError(error);
      const settlement = await this.retryWithoutProvider(
        work,
        deliveryError,
        retryDelayMs,
      );
      return { event, deliveryError, settlement };
    }

    if (receipt.status === "RETRYABLE_FAILURE") {
      const deliveryError = boundedError(
        `${receipt.error?.code ?? "PROVIDER_EXECUTION_FAILED"}: ${receipt.error?.message ?? "Provider execution failed"}`,
      );
      const settlement = await this.retryReceipt(
        work,
        receipt,
        deliveryError,
        retryDelayMs,
      );
      return { event, receipt, deliveryError, settlement };
    }

    const providerName = receipt.provider_id;
    if (providerName === undefined) {
      throw new MaterializationReceiptIntegrityError(
        work.record.outboxId,
        "successful receipt omitted provider_id",
      );
    }
    const providerObjectId = receipt.provider_receipt?.providerObjectId;
    const outcome: ProviderDeliveryOutcome = {
      providerName,
      status: "CURRENT",
      ...(providerObjectId === undefined ? {} : { providerId: providerObjectId }),
    };
    const settlement = await this.settle(work, [outcome]);
    return { event, receipt, settlement };
  }

  private async retryReceipt(
    work: OutboxWorkItem,
    receipt: MemoryFabricExecutionReceipt,
    deliveryError: string,
    retryDelayMs: number,
  ): Promise<OutboxSettlement> {
    if (receipt.provider_id === undefined) {
      return this.retryWithoutProvider(work, deliveryError, retryDelayMs);
    }
    const status =
      receipt.error?.code === "NO_ELIGIBLE_PROVIDER" ? "UNAVAILABLE" : "FAILED";
    return this.settle(
      work,
      [
        {
          providerName: receipt.provider_id,
          status,
          lastError: deliveryError,
        },
      ],
      retryDelayMs,
    );
  }

  private retryWithoutProvider(
    work: OutboxWorkItem,
    deliveryError: string,
    retryDelayMs: number,
  ): Promise<OutboxSettlement> {
    return this.settle(work, [], retryDelayMs, deliveryError);
  }

  private settle(
    work: OutboxWorkItem,
    outcomes: ProviderDeliveryOutcome[],
    retryDelayMs?: number,
    lastError?: string,
  ): Promise<OutboxSettlement> {
    const retryAt =
      retryDelayMs === undefined
        ? undefined
        : new Date(Date.parse(this.clock.now()) + retryDelayMs).toISOString();
    return this.operations.settleOutbox({
      scope: work.record.scope,
      outboxId: work.record.outboxId,
      workerId: work.record.claimedBy,
      claimToken: work.record.claimToken,
      outcomes,
      ...(lastError === undefined ? {} : { lastError }),
      ...(retryAt === undefined ? {} : { nextAttemptAt: retryAt }),
    });
  }
}

async function executeWithTimeout(
  delivery: MemoryMaterializationDeliveryPort,
  event: MemoryFabricMaterializationEvent,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      delivery.execute(event, { signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`OmniHarness delivery timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function validateExecutionReceipt(
  value: unknown,
  event: MemoryFabricMaterializationEvent,
): MemoryFabricExecutionReceipt {
  const receipt = objectValue(value, event.outbox_id, "receipt");
  requireEqual(receipt.event_type, event.event_type, event.outbox_id, "event_type");
  requireEqual(
    receipt.event_version,
    event.event_version,
    event.outbox_id,
    "event_version",
  );
  requireEqual(receipt.outbox_id, event.outbox_id, event.outbox_id, "outbox_id");
  requireEqual(receipt.request_id, event.request_id, event.outbox_id, "request_id");
  requireEqual(receipt.memory_id, event.memory_id, event.outbox_id, "memory_id");
  requireEqual(
    receipt.canonical_revision,
    event.canonical_revision,
    event.outbox_id,
    "canonical_revision",
  );
  requireEqual(receipt.commit_seq, event.commit_seq, event.outbox_id, "commit_seq");
  requireEqual(
    receipt.canonical_commit_affected,
    false,
    event.outbox_id,
    "canonical_commit_affected",
  );
  if (event.trace_id !== undefined) {
    requireEqual(receipt.trace_id, event.trace_id, event.outbox_id, "trace_id");
  }

  const status = receipt.status;
  if (
    status !== "SUCCESS" &&
    status !== "ALREADY_CURRENT" &&
    status !== "NOT_FOUND" &&
    status !== "RETRYABLE_FAILURE"
  ) {
    throw integrity(event.outbox_id, `unsupported status '${String(status)}'`);
  }
  if (status === "RETRYABLE_FAILURE") {
    requireEqual(receipt.retryable, true, event.outbox_id, "retryable");
    const error = objectValue(receipt.error, event.outbox_id, "error");
    if (!isExecutionErrorCode(error.code) || !nonEmptyString(error.message)) {
      throw integrity(event.outbox_id, "retryable failure has an invalid error");
    }
  } else {
    requireEqual(receipt.retryable, false, event.outbox_id, "retryable");
    if (!nonEmptyString(receipt.provider_id)) {
      throw integrity(event.outbox_id, "successful receipt requires provider_id");
    }
    if (event.intent === "UPSERT" && status === "NOT_FOUND") {
      throw integrity(event.outbox_id, "UPSERT cannot settle as NOT_FOUND");
    }
    if (event.intent === "DELETE" && status === "ALREADY_CURRENT") {
      throw integrity(event.outbox_id, "DELETE cannot settle as ALREADY_CURRENT");
    }
  }

  if (receipt.provider_id !== undefined && !nonEmptyString(receipt.provider_id)) {
    throw integrity(event.outbox_id, "provider_id must be non-empty when present");
  }
  if (receipt.provider_receipt !== undefined) {
    const providerReceipt = objectValue(
      receipt.provider_receipt,
      event.outbox_id,
      "provider_receipt",
    );
    if (!nonEmptyString(providerReceipt.providerId)) {
      throw integrity(
        event.outbox_id,
        "provider_receipt.providerId must be non-empty",
      );
    }
    if (!nonEmptyString(providerReceipt.status)) {
      throw integrity(
        event.outbox_id,
        "provider_receipt.status must be non-empty",
      );
    }
    requireEqual(
      providerReceipt.memoryId,
      event.memory_id,
      event.outbox_id,
      "provider_receipt.memoryId",
    );
    if (
      providerReceipt.canonicalRevision !== undefined &&
      providerReceipt.canonicalRevision !== event.canonical_revision
    ) {
      throw integrity(
        event.outbox_id,
        "provider_receipt.canonicalRevision does not match the event",
      );
    }
    if (
      receipt.provider_id !== undefined &&
      providerReceipt.providerId !== receipt.provider_id
    ) {
      throw integrity(
        event.outbox_id,
        "provider_receipt.providerId does not match provider_id",
      );
    }
    if (
      providerReceipt.providerObjectId !== undefined &&
      !nonEmptyString(providerReceipt.providerObjectId)
    ) {
      throw integrity(
        event.outbox_id,
        "provider_receipt.providerObjectId must be non-empty when present",
      );
    }
  }
  return value as MemoryFabricExecutionReceipt;
}

function objectValue(
  value: unknown,
  outboxId: OutboxId,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw integrity(outboxId, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireEqual(
  actual: unknown,
  expected: unknown,
  outboxId: OutboxId,
  field: string,
): void {
  if (actual !== expected) {
    throw integrity(outboxId, `${field} does not match the claimed event`);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isExecutionErrorCode(value: unknown): value is MemoryFabricExecutionErrorCode {
  return (
    value === "INVALID_EVENT" ||
    value === "NO_ELIGIBLE_PROVIDER" ||
    value === "PROVIDER_EXECUTION_FAILED"
  );
}

function integrity(outboxId: OutboxId, message: string): Error {
  return new MaterializationReceiptIntegrityError(outboxId, message);
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim() || "Unknown delivery failure";
  return normalized.slice(0, MAX_MATERIALIZATION_ERROR_LENGTH);
}
