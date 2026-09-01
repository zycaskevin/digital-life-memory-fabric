import type { CanonicalCommitResult } from "../domain/types.js";

export const OMNIHARNESS_MEMORY_MATERIALIZATION_EVENT =
  "memory.materialization.requested" as const;
export const OMNIHARNESS_MEMORY_MATERIALIZATION_EVENT_VERSION = "1" as const;

export interface OmniHarnessMemoryMaterializationEvent {
  readonly event_type: typeof OMNIHARNESS_MEMORY_MATERIALIZATION_EVENT;
  readonly event_version: typeof OMNIHARNESS_MEMORY_MATERIALIZATION_EVENT_VERSION;
  readonly outbox_id: string;
  readonly event_id: string;
  readonly request_id: string;
  readonly trace_id?: string;
  readonly occurred_at: string;
  readonly intent: "UPSERT" | "DELETE";
  readonly tenant_id: string;
  readonly life_did: string;
  readonly memory_namespace: string;
  readonly memory_id: string;
  readonly canonical_revision: number;
  readonly commit_seq: number;
  readonly operation: string;
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

/**
 * Converts an already-successful canonical commit into an integration event.
 * This function never performs provider I/O. Provider delivery happens after
 * canonical commit and cannot roll the commit back.
 */
export function toOmniHarnessMaterializationEvent(
  commit: CanonicalCommitResult,
  options: { readonly traceId?: string; readonly requestId?: string } = {},
): OmniHarnessMemoryMaterializationEvent {
  const { scope } = commit.revision;
  const intent = commit.change.operation === "tombstone" ? "DELETE" : "UPSERT";
  const requestId = options.requestId ?? `ohmat:${commit.outbox.outboxId}`;

  return {
    event_type: OMNIHARNESS_MEMORY_MATERIALIZATION_EVENT,
    event_version: OMNIHARNESS_MEMORY_MATERIALIZATION_EVENT_VERSION,
    outbox_id: commit.outbox.outboxId,
    event_id: commit.change.eventId,
    request_id: requestId,
    ...(options.traceId ? { trace_id: options.traceId } : {}),
    occurred_at: commit.revision.committedAt,
    intent,
    tenant_id: scope.tenantId,
    life_did: scope.lifeDid,
    memory_namespace: scope.memoryNamespace,
    memory_id: commit.revision.memoryId,
    canonical_revision: commit.revision.revision,
    commit_seq: commit.revision.commitSeq,
    operation: commit.change.operation,
    idempotency_key: `memory.materialization:${commit.revision.memoryId}:${commit.revision.revision}`,
    ...(intent === "UPSERT"
      ? {
          canonical_content: {
            text: commit.revision.canonicalContent.text,
            ...(commit.revision.canonicalContent.payload
              ? { payload: commit.revision.canonicalContent.payload }
              : {}),
          },
        }
      : {}),
    metadata: {
      canonical_authority: "digital-life-memory-fabric",
      provider_selection_owned_by: "omniharness",
    },
  };
}
