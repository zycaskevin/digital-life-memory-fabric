# Digital Life Memory Fabric ↔ OmniHarness Integration v0.1

**Checkpoint:** OH-MEM-002  
**Authority:** Digital Life Memory Fabric remains canonical memory authority.

## Purpose

This contract defines how an already-committed canonical memory revision is projected to replaceable Memory Providers through OmniHarness.

## Write sequence

```text
MemoryCandidate
  ↓
Canonical validation / commit
  ↓
CanonicalCommitResult
  ├─ MemoryRevision
  ├─ MemoryChangeEnvelope
  └─ MemoryOutboxRecord
  ↓
toOmniHarnessMaterializationEvent()
  ↓
memory.materialization.requested / version 1
  ↓
OmniHarness
  ↓
Memory Provider
```

Provider I/O is strictly post-commit. A provider failure cannot roll back or invalidate the canonical commit.

## Event identity

The event carries:

- `outbox_id`
- `event_id`
- `request_id`
- optional `trace_id`
- `tenant_id`
- `life_did`
- `memory_namespace`
- `memory_id`
- `canonical_revision`
- `commit_seq`
- `operation`
- `idempotency_key`

The event does not carry provider IDs. Provider selection belongs to OmniHarness.

## Intent mapping

Canonical operation `tombstone` maps to:

```text
intent = DELETE
```

All other committed revisions map to:

```text
intent = UPSERT
```

`UPSERT` includes canonical content. `DELETE` intentionally does not.

## Idempotency

The stable cross-system logical key is:

```text
memory.materialization:<memory_id>:<canonical_revision>
```

Retrying the same outbox event must be safe. Provider-specific object IDs are secondary and must not replace canonical IDs.

## Failure semantics

OmniHarness may return a retryable operational failure if no eligible provider exists or execution fails. Memory Fabric may retry or rebuild materialization later.

The failure does **not** change:

- `memory_id`
- canonical revision
- `commit_seq`
- canonical content
- canonical tombstone/supersession state

## Retrieval boundary

Provider search results return retrieval candidates only. Memory Fabric remains responsible for canonical lookup, revision validation, tombstone/supersession validation, and hydration before a result is treated as canonical memory.

## Vendor neutrality

This event contains no Hindsight, Vault, Mem0, or other provider-specific schema. Hindsight may become the first production provider, but its SDK and internal graph/temporal representation remain behind the OmniHarness adapter.
