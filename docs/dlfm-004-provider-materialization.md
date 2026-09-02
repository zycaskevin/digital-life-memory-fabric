# DLFM-004 Provider Materialization Worker

**Status:** Proposed implementation checkpoint<br>
**Base:** DLFM-003 Central Operations Plane<br>
**Contract evidence:** OmniHarness `main@5530e7a0157577791aaaae188cbe3424cfe3771e`

## Purpose

DLFM-004 connects a committed canonical outbox row to the provider-neutral
OmniHarness `OH-MEM-002` consumer contract. It does not import a Provider SDK,
select a Provider, or move canonical memory authority into OmniHarness.

```text
Canonical commit
  -> immutable change + revision + outbox
  -> fenced outbox claim
  -> memory.materialization.requested / version 1
  -> MemoryMaterializationDeliveryPort
  -> OmniHarness provider resolution and execution
  -> correlated execution receipt
  -> atomic outbox/materialization settlement
```

Provider I/O remains outside the canonical transaction and outside the short
outbox claim/settlement transactions.

## Ownership boundary

Digital Life Memory Fabric owns:

- canonical identity, revision, content, operation, and `commit_seq`
- the outbox lease, claim token, retry schedule, and settlement
- versioned event construction from canonical committed state
- receipt correlation and canonical-authority validation

OmniHarness owns:

- Provider registry, resolution, health, and execution
- the selected `provider_id`
- normalized Provider execution receipts

The delivery port returns `unknown` deliberately. A network or in-process adapter
must pass the same runtime correlation checks before its receipt can change
operational state.

## Event contract

`toMemoryFabricMaterializationEvent()` emits:

- `event_type = memory.materialization.requested`
- `event_version = 1`
- the original canonical `event_id`
- stable `request_id = ohmat:<outbox_id>`
- stable `idempotency_key = memory.materialization:<memory_id>:<revision>`
- exact canonical scope, revision, operation, and `commit_seq`
- `UPSERT` with canonical content for non-tombstone operations
- `DELETE` without canonical content for tombstones

Retries reuse the same event, request, and idempotency identities.

## Worker contract

`MaterializationWorker.runOnce()`:

1. validates that delivery timeout is shorter than the outbox lease;
2. claims a bounded batch through `CentralOperationsService`;
3. bulk-hydrates both immutable revisions and canonical change envelopes;
4. verifies outbox, change, revision, scope, operation, and sequence agreement;
5. executes delivery with an abort signal and bounded timeout;
6. validates receipt correlation and `canonical_commit_affected = false`;
7. settles success as `CURRENT`, using the Provider object ID only as a
   secondary materialization mapping;
8. schedules a delayed retry for transport, receipt-integrity, or Provider
   execution failure.

The default worker claim is one row. Callers may request a larger bounded batch,
but must size the lease for sequential delivery and settlement.

## Provider-neutral failure

A transport failure or `NO_ELIGIBLE_PROVIDER` may occur before OmniHarness has a
selected Provider identity. DLFM-004 records that error only on the outbox row and
schedules retry. It does not create a fake `omniharness`, `unresolved`, or other
provider materialization row.

If a failed receipt identifies the Provider that executed, settlement records the
failure against that Provider. In both cases, canonical memory remains committed
and unchanged.

## Receipt integrity

Settlement fails closed unless the receipt agrees with the claimed event on:

- event type and version
- outbox and request IDs
- memory ID and canonical revision
- `commit_seq`
- optional trace ID
- Provider identity consistency inside the nested Provider receipt
- `canonical_commit_affected = false`

`UPSERT` cannot settle as `NOT_FOUND`. A tombstone `DELETE` may settle as either
`SUCCESS` or `NOT_FOUND`, because both mean the desired provider representation is
absent.

## Verified acceptance

The deterministic and PostgreSQL tests cover:

- exact OH-MEM-002 event mapping from committed canonical state
- canonical change/event hydration in claim order
- successful materialization and Provider object mapping
- tombstone-to-delete mapping
- transport failure without provider-inventory pollution
- delayed retry admission
- receipt correlation failure
- lease loss followed by idempotent `ALREADY_CURRENT` replay
- equivalent in-memory and PostgreSQL settlement behavior

## Non-scope

- a production HTTP, queue, or RPC transport
- Hindsight production adapter migration
- Vault forward integration
- Honcho adoption
- multi-Provider write fan-out or silent write fallback
- rebuild orchestration
- retrieval and canonical hydration
- deployment, production migration, or real-runtime UAT
